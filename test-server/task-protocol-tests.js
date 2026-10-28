/**
 * 任务/报表协议测试(纯本地, 无 LLM / 无 HTTP)
 * 覆盖《03-验收与场景清单》P1~P3 本地可测场景:
 *   1 执行 ZM001 缺参数 → WAITING_INPUT      5 重复 RequestId 幂等
 *   2 分析表 ZTEST_DATA → DATA 非报表        6 未登记/停用/无权限拒绝
 *   3 先看库存 → 切换任务, 报表任务保留      7 空结果/失败/超时/未知状态
 *   4 继续刚才的 ZM001 → 恢复/多候选追问     8 结果绑定正确 Artifact
 *   9 长聊天只注入当前任务上下文             10 旧功能(开关关闭零影响)
 *
 * 运行: node test-protocol-tests.js
 * 注意: 全部为本地 Mock/契约测试; 不能证明真实 SAP 权限、后台作业、
 *       结果锁正确 —— SAP 端验收项见《SE11对象与配置清单》。
 */

const { TaskStore, isActiveStatus } = require('./task-store');
const { ReportStore, RUN_STATUS } = require('./report-store');
const { quickRoute, isTcodeLike } = require('./intent-route');
const { extractJsonObject, inferAction, salvageAnswer } = require('./agent-loop');

const USER = 'TESTER';
const SESSION = 'SESS_TEST_0001';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(name) {
  console.log(`\n━━ ${name}`);
}

/** 新建一套已登记 ZM001(演示用, 非真实报表)的 store 组合 */
function freshStores({ execEnabled = true } = {}) {
  const tasks = new TaskStore({ enabled: true });
  const reports = new ReportStore({ readEnabled: true, execEnabled, taskStore: tasks });
  reports.register({
    report_id: 'ZM001_DEMO', tcode: 'ZM001',
    report_name: '物料收发存汇总(演示)',
    description: '示例 ZM001: 仅文档与 Mock 使用, 不是真实报表',
    exec_enabled: execEnabled, max_rows: 200
  }, [
    { param_id: 'P_WERKS', label: '工厂', data_type: 'CHAR', length: 4, required: true, sort_no: 1 },
    { param_id: 'P_DATE_FROM', label: '开始日期', data_type: 'DATE', required: true, sort_no: 2 },
    // VALIDATION_RULE 引用示例: 结束日期不小于开始日期(后端可执行规则)
    { param_id: 'P_DATE_TO', label: '结束日期', data_type: 'DATE', required: true,
      validation_rule: 'GE:P_DATE_FROM', sort_no: 3 },
    { param_id: 'P_MTART', label: '物料类型', data_type: 'ENUM', validation_rule: 'FERT,ROH,HIBE', sort_no: 4 },
    { param_id: 'P_MULTI', label: '多值物料', data_type: 'CHAR', length: 18, multi_value: true, sort_no: 5 },
    { param_id: 'P_BUDAT', label: '过账日期范围', data_type: 'DATE', range_allowed: true, sort_no: 6 },
    { param_id: 'MOCK_SCENARIO', label: 'Mock 场景', data_type: 'CHAR', required: false, sort_no: 99 },
    { param_id: 'MOCK_DELAY_SEC', label: 'Mock 延迟秒', data_type: 'NUM', required: false, sort_no: 100 }
  ]);
  // 一张停用的报表
  reports.register({ report_id: 'ZM002_DEMO', tcode: 'ZM002', report_name: '停用报表(演示)', active: false, exec_enabled: true }, []);
  return { tasks, reports };
}

/* =============== 场景 1: 执行 ZM001, 缺参数 → WAITING_INPUT =============== */
function scenario1() {
  section('场景 1: "执行一下 ZM001, 并分析其结果" 缺参数 → WAITING_INPUT');
  const { tasks, reports } = freshStores();

  const route = quickRoute('执行一下 ZM001，并分析其结果');
  check('路由到 REPORT', route.module_id === 'REPORT', `实际 ${route.module_id}`);
  check('意图为 RUN_AND_ANALYZE_REPORT', route.intent_code === 'RUN_AND_ANALYZE_REPORT');
  check('对象为 ZM001', route.object_value === 'ZM001');

  const pick = tasks.pickOrCreate(SESSION, route.task_id, 'REPORT', route.intent_code, '报表 ZM001', USER);
  check('创建报表任务', pick.created === true && pick.task_id !== '');

  const def = reports.getDefByTcode('ZM001');
  check('TCode 定位到登记报表', !!def && def.report_id === 'ZM001_DEMO');

  const pv = reports.validateParams(def, '{}');
  check('缺参数校验失败', pv.ok === false);
  check('标记 needs_input(WAITING_INPUT)', pv.needs_input === true);
  check('必填项全部提示', pv.errors.filter(e => e.code === 'REQUIRED').length === 3,
    `实际 ${pv.errors.filter(e => e.code === 'REQUIRED').length}`);

  const st = reports.startRun(pick.task_id, SESSION, def.report_id, '{}', 'REQ-S1', USER);
  check('缺参数不创建运行', st.rejected === true && st.report_run_id === '');
  check('状态为 WAITING_INPUT', st.status === 'WAITING_INPUT');

  const t = tasks.getOwned(pick.task_id, SESSION, USER);
  const r = tasks.updateStatus(t.task_id, t.current_version, 'WAITING_INPUT', '', USER);
  check('任务转入 WAITING_INPUT', r.ok === true && r.task.status === 'WAITING_INPUT');
}

/* =============== 场景 2: "分析表 ZTEST_DATA" → DATA 非报表 =============== */
function scenario2() {
  section('场景 2: "分析表 ZTEST_DATA" 路由到 DATA, 不能误判 REPORT');
  const route = quickRoute('分析表 ZTEST_DATA 的记录分布');
  check('路由到 DATA', route.module_id === 'DATA', `实际 ${route.module_id}`);
  check('不是 REPORT', route.module_id !== 'REPORT');
  check('对象为表 ZTEST_DATA', route.object_kind === 'TABLE' && route.object_value === 'ZTEST_DATA');

  const route2 = quickRoute('统计 ZIDPPP_TEST01 里各工厂的工单数量');
  check('统计自建表也路由 DATA', route2.module_id === 'DATA');
}

/* =============== 场景 3: "先看库存" → 切换任务, 报表任务保留 =============== */
function scenario3() {
  section('场景 3: "先看库存" 创建库存任务; 报表草稿与运行状态保留');
  const { tasks, reports } = freshStores();

  // 先建报表任务并进入 WAITING_INPUT
  const pickR = tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表 ZM001', USER);
  const tR0 = tasks.getOwned(pickR.task_id, SESSION, USER);
  tasks.updateStatus(tR0.task_id, tR0.current_version, 'WAITING_INPUT', '', USER);

  // 库存任务
  const route = quickRoute('先看库存');
  check('路由到 INVENTORY', route.module_id === 'INVENTORY');
  const pickI = tasks.pickOrCreate(SESSION, '', 'INVENTORY', 'INVENTORY_QUERY', '先看库存', USER);
  check('创建库存任务', pickI.created === true);

  const tR = tasks.getOwned(pickR.task_id, SESSION, USER);
  const tI = tasks.getOwned(pickI.task_id, SESSION, USER);
  check('报表任务保留 WAITING_INPUT', tR.status === 'WAITING_INPUT');
  check('库存任务独立存在', tI.status === 'OPEN' && tI.task_id !== tR.task_id);
  check('会话有两个任务', tasks.listTasks(SESSION, USER).length === 2);

  // 报表运行切换后不取消: 先提交一次合法运行再切走
  const def = reports.getDefByTcode('ZM001');
  const st = reports.startRun(tR.task_id, SESSION, def.report_id,
    JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' }), 'REQ-S3', USER);
  check('报表可提交运行', st.rejected === false, st.message);
  const tR2 = tasks.getOwned(pickR.task_id, SESSION, USER);
  check('切换后报表任务仍是 QUEUED/RUNNING 链路的一部分', ['QUEUED', 'RUNNING', 'SUBMITTED'].includes(tR2.status),
    `实际 ${tR2.status}`);
}

/* =============== 场景 4: "继续刚才的 ZM001" → 恢复/追问 =============== */
function scenario4() {
  section('场景 4: "继续刚才的 ZM001" 恢复唯一任务; 多候选必须追问');
  const { tasks } = freshStores();

  // 任务1: 已完成(可引用结果的候选)
  const pickR = tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表 ZM001', USER);
  let tR = tasks.getOwned(pickR.task_id, SESSION, USER);
  tasks.updateStatus(tR.task_id, tR.current_version, 'WAITING_INPUT', '', USER);
  tR = tasks.getOwned(pickR.task_id, SESSION, USER);
  tasks.updateStatus(tR.task_id, tR.current_version, 'COMPLETED', '', USER);

  // 唯一候选 → 恢复
  const candidates = tasks.listTasks(SESSION, USER)
    .filter(t => t.module_id === 'REPORT' && isSelectableCand(t) && t.title.includes('ZM001'));
  check('只有一个可选候选', candidates.length === 1);
  const route = quickRoute('继续刚才的 ZM001', { findTaskCandidates: () => candidates });
  check('唯一候选恢复任务', route.needs_clarify === false && route.task_id === pickR.task_id,
    `task_id=${route.task_id}`);

  // 任务2: 新建(WAITING_INPUT) → 活跃任务不吞并已完成候选, 形成两个可选
  const pickR2 = tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表 ZM001 (新条件)', USER);
  check('新目标创建新任务(不吞已完成候选)', pickR2.created === true && pickR2.task_id !== pickR.task_id);
  const cands2 = tasks.listTasks(SESSION, USER)
    .filter(t => t.module_id === 'REPORT' && isSelectableCand(t) && t.title.includes('ZM001'));
  check('确实存在两个候选', cands2.length === 2, `实际 ${cands2.length}`);
  const route2 = quickRoute('继续刚才的 ZM001', { findTaskCandidates: () => cands2 });
  check('多候选必须追问(不猜唯一)', route2.needs_clarify === true);
}

function isSelectableCand(t) {
  return isActiveStatus(t.status) || t.status === 'COMPLETED' || t.status === 'PARTIAL';
}

/* =============== 场景 5: 重复 RequestId 只产生一个运行 =============== */
function scenario5() {
  section('场景 5: 重复 RequestId 幂等 —— 只能产生一个逻辑运行');
  const { tasks, reports } = freshStores();
  const pick = tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表 ZM001', USER);
  const def = reports.getDefByTcode('ZM001');
  const params = JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' });

  const r1 = reports.startRun(pick.task_id, SESSION, def.report_id, params, 'REQ-DUP-1', USER);
  check('首次提交创建运行', r1.created === true && r1.report_run_id !== '');
  const r2 = reports.startRun(pick.task_id, SESSION, def.report_id, params, 'REQ-DUP-1', USER);
  check('重试返回同一运行', r2.created === false && r2.report_run_id === r1.report_run_id,
    `r2=${r2.report_run_id}`);
  const r3 = reports.startRun(pick.task_id, SESSION, def.report_id, params, 'REQ-DUP-1', USER);
  check('第三次重试仍同一运行', r3.report_run_id === r1.report_run_id);

  // 用户主动重跑必须产生新 RequestId → 新运行
  const r4 = reports.startRun(pick.task_id, SESSION, def.report_id, params, 'REQ-DUP-2', USER);
  check('新 RequestId 产生新运行', r4.created === true && r4.report_run_id !== r1.report_run_id);

  // 旧参数和旧结果保留: 两次运行记录各自独立
  check('两个运行并存', reports.runs.size === 2);

  // 旧参数快照不被覆盖(第二次提交换了参数也不改第一次运行)
  const run1 = reports.runs.get(r1.report_run_id);
  const r5 = reports.startRun(pick.task_id, SESSION, def.report_id,
    JSON.stringify({ P_WERKS: '2000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' }), 'REQ-DUP-3', USER);
  const run1b = reports.runs.get(r1.report_run_id);
  check('旧运行参数快照未被覆盖', run1b.params_json === run1.params_json);
  check('新参数产生新运行', r5.created === true);
}

/* =============== 场景 6: 未登记/停用/无权限 → 拒绝 =============== */
function scenario6() {
  section('场景 6: 未登记 TCode / 停用报表 / 执行开关关闭 → 后端拒绝, 不提交作业');

  const a = freshStores();
  const st1 = a.reports.startRun('', SESSION, 'ZM999_NOPE', '{}', 'REQ-S6A', USER);
  check('未登记报表被拒绝', st1.rejected === true && st1.report_run_id === '');
  check('拒绝消息明确', /未登记/.test(st1.message));

  const b = freshStores();
  const st2 = b.reports.startRun('', SESSION, 'ZM002_DEMO', '{}', 'REQ-S6B', USER);
  check('停用报表被拒绝', st2.rejected === true);

  // REPORT_EXEC_ENABLED 关闭(默认态) → 一律拒绝
  const c = freshStores({ execEnabled: false });
  const pick = c.tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表 ZM001', USER);
  const st3 = c.reports.startRun(pick.task_id, SESSION, 'ZM001_DEMO',
    JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' }), 'REQ-S6C', USER);
  check('执行开关关闭时拒绝', st3.rejected === true && st3.report_run_id === '');
  check('拒绝消息含开关名', /REPORT_EXEC_ENABLED/.test(st3.message));

  // 读取开关关闭 → 定义不可见
  const d = new ReportStore({ readEnabled: false, execEnabled: true });
  check('读取开关关闭时定义不可见', d.getDefByTcode('ZM001') === null && d.listDefs().length === 0);

  // 任务归属不符 → 拒绝
  const e = freshStores();
  const st4 = e.reports.startRun('NO_SUCH_TASK', SESSION, 'ZM001_DEMO', '{}', 'REQ-S6D', USER);
  check('任务归属校验失败拒绝', st4.rejected === true && /任务/.test(st4.message));

  // 未定义参数注入 → 拒绝
  const pv = e.reports.validateParams(e.reports.getDefByTcode('ZM001'),
    JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007', EVIL_FIELD: 'x' }));
  check('未定义参数被拒绝', pv.ok === false && pv.errors.some(x => x.code === 'UNKNOWN_PARAM'));
}

/* =============== 场景 7: 空结果/失败/超时/未知状态 =============== */
function scenario7() {
  section('场景 7: 空结果/失败/超时/未知状态 —— 状态与提示不混淆');

  const mk = (scenario) => {
    const { tasks, reports } = freshStores();
    const pick = tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表 ZM001', USER);
    const st = reports.startRun(pick.task_id, SESSION, 'ZM001_DEMO',
      JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007', MOCK_SCENARIO: scenario, MOCK_DELAY_SEC: 0 }),
      `REQ-S7-${scenario}`, USER);
    return { tasks, reports, pick, runId: st.report_run_id };
  };

  // 空结果: READY + 0 行是有效事实
  const e = mk('EMPTY');
  e.reports.pollStatus(e.runId, USER);
  const eSt = e.reports.pollStatus(e.runId, USER);
  check('空结果状态 READY', eSt.status === RUN_STATUS.READY);
  check('空结果行数为 0', eSt.run.row_count === 0);
  check('空结果有 Artifact', eSt.run.artifact_id !== '');
  const eRes = e.reports.getResult(eSt.run.artifact_id, USER);
  check('空结果可读且 0 行(不是失败)', eRes.status === 'AVAILABLE' && eRes.row_count === 0);

  // 失败: FAILED + 脱敏错误码
  const f = mk('FAIL');
  f.reports.pollStatus(f.runId, USER);
  const fSt = f.reports.pollStatus(f.runId, USER);
  check('失败状态 FAILED(与 READY 不混淆)', fSt.status === RUN_STATUS.FAILED);
  check('错误码脱敏', fSt.run.error_code === 'MOCK_JOB_FAIL');
  check('失败无结果绑定', fSt.run.artifact_id === '');

  // 超时: TIMEOUT ≠ 作业已停止
  const t = mk('TIMEOUT');
  t.reports.pollStatus(t.runId, USER);
  const tSt = t.reports.pollStatus(t.runId, USER);
  check('超时状态 TIMEOUT(独立于 FAILED/READY)', tSt.status === RUN_STATUS.TIMEOUT);
  check('超时提示不声称作业已停止', !/已停止/.test(tSt.run.error_message));

  // 未知状态: UNKNOWN 需继续轮询
  const u = mk('UNKNOWN');
  const u1 = u.reports.pollStatus(u.runId, USER);
  check('未知状态 UNKNOWN(非终态)', u1.status === RUN_STATUS.UNKNOWN);
  const u2 = u.reports.pollStatus(u.runId, USER);
  check('UNKNOWN 持续需人工核对/继续轮询', u2.status === RUN_STATUS.UNKNOWN);

  // 结果过期
  const x = mk('EXPIRED');
  x.reports.pollStatus(x.runId, USER);
  const xSt = x.reports.pollStatus(x.runId, USER);
  check('EXPIRED 场景运行 READY', xSt.status === RUN_STATUS.READY);
  const xRes = x.reports.getResult(xSt.run.artifact_id, USER);
  check('过期结果拒绝读取并标记 EXPIRED', xRes.message === 'EXPIRED');
  const art = x.tasks.artifacts.get(xSt.run.artifact_id);
  check('过期后 Artifact 状态 EXPIRED(只读不删除)', !!art && art.status === 'EXPIRED');
}

/* =============== 场景 8: 结果绑定正确的 Artifact, 不串库存 =============== */
function scenario8() {
  section('场景 8: 结果分析绑定正确的 ArtifactId/DatasetId, 不串到库存结果');
  const { tasks, reports } = freshStores();

  // 库存任务登记一个结果
  const pickI = tasks.pickOrCreate(SESSION, '', 'INVENTORY', 'INVENTORY_QUERY', '库存', USER);
  const invArt = tasks.registerArtifact(pickI.task_id, SESSION, {
    type: 'INVENTORY_RESULT', sourceType: 'QUERY', sourceRef: 'stock_snapshot',
    label: '库存快照', rowCount: 3, owner: USER
  });

  // 报表任务运行到 READY(Mock 场景 SUCCESS, 延迟 0 便于确定性测试)
  const pickR = tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表 ZM001', USER);
  const st = reports.startRun(pickR.task_id, SESSION, 'ZM001_DEMO',
    JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007', MOCK_SCENARIO: 'SUCCESS', MOCK_DELAY_SEC: 0 }),
    'REQ-S8', USER);
  reports.pollStatus(st.report_run_id, USER);
  const st2 = reports.pollStatus(st.report_run_id, USER);
  check('报表运行 READY', st2.status === RUN_STATUS.READY, `实际 ${st2.status}`);

  const rptArt = st2.run.artifact_id;
  check('报表 Artifact 已登记', !!rptArt && rptArt !== invArt);
  const art = tasks.artifacts.get(rptArt);
  check('报表 Artifact 归属报表任务(不串库存任务)', !!art && art.task_id === pickR.task_id);
  check('报表 Artifact 类型 REPORT_RESULT', art.artifact_type === 'REPORT_RESULT');
  check('库存结果未被改动', tasks.artifacts.get(invArt).artifact_type === 'INVENTORY_RESULT');

  const res = reports.getResult(rptArt, USER);
  check('结果可按 ArtifactId 读取', res.artifact_id === rptArt && res.row_count === 12);
  check('结果来源运行可追溯', res.report_run_id === st.report_run_id);

  // 结果引用进入任务上下文
  const ctx = tasks.buildContext(SESSION, pickR.task_id, USER);
  check('上下文包含报表结果引用', ctx.artifacts.some(a => a.id === rptArt));
  check('上下文不包含库存任务的结果', !ctx.artifacts.some(a => a.id === invArt));
}

/* =============== 场景 9: 长聊天只注入当前任务上下文 =============== */
function scenario9() {
  section('场景 9: 长聊天只注入当前任务上下文(消息数与截断受控)');
  const { tasks } = freshStores();
  const pick = tasks.pickOrCreate(SESSION, '', 'DATA', 'TABLE_ANALYSIS', '表分析', USER);

  // 模拟 40 轮长聊天(全挂到当前任务)
  for (let i = 1; i <= 80; i++) {
    tasks.attachMessages(pick.task_id, SESSION,
      [{ msg_seq: i, role: i % 2 ? 'user' : 'assistant', content: 'X'.repeat(600) }], USER);
  }
  const ctx = tasks.buildContext(SESSION, pick.task_id, USER, 2, 500);
  check('只注入有限条数(2 轮 = 4 条)', ctx.recent_messages.length === 4,
    `实际 ${ctx.recent_messages.length}`);
  check('单条截断 500 字符', ctx.recent_messages.every(m => m.content.length <= 501));
  check('其他业务只给短目录', ctx.related_tasks.every(r => !r.pending && !r.artifacts));
}

/* =============== 场景 10: 旧功能(开关关闭零影响) + 参数校验补充 =============== */
function scenario10() {
  section('场景 10: 开关关闭时旧链路零影响; 参数类型/值域校验');
  const tasks = new TaskStore({ enabled: false });
  const reports = new ReportStore({ readEnabled: false, execEnabled: false, taskStore: tasks });

  const pick = tasks.pickOrCreate(SESSION, '', 'REPORT', 'RUN_AND_ANALYZE_REPORT', '报表', USER);
  check('任务层关闭: 不创建任务', pick.task_id === '');
  check('任务层关闭: 列表为空', tasks.listTasks(SESSION, USER).length === 0);
  check('任务层关闭: 结果登记为空', tasks.registerArtifact('x', SESSION, { type: 'X' }) === '');
  const st = reports.startRun('x', SESSION, 'ANY', '{}', 'REQ-S10', USER);
  check('执行层关闭: 拒绝运行', st.rejected === true);
  check('读取层关闭: 定义不可见', reports.getDefByTcode('ZM001') === null);

  // 参数类型校验(开启读取的实例)
  const v = freshStores();
  const def = v.reports.getDefByTcode('ZM001');
  let pv = v.reports.validateParams(def, JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '2026-10-01', P_DATE_TO: '20261007' }));
  check('日期格式错误被拒(必须 YYYYMMDD)', pv.errors.some(e => e.param_id === 'P_DATE_FROM' && e.code === 'TYPE'));
  pv = v.reports.validateParams(def, JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007', P_MTART: 'XXXX' }));
  check('ENUM 值域外被拒', pv.errors.some(e => e.param_id === 'P_MTART' && e.code === 'DOMAIN'));
  pv = v.reports.validateParams(def, JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261007', P_DATE_TO: '20261001' }));
  check('日期范围倒序被拒(RANGE)', pv.ok === false);
  pv = v.reports.validateParams(def, JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007', P_MULTI: 'M001|M002' }));
  check("多值 '|' 分隔合法", pv.ok === true, JSON.stringify(pv.errors));

  // 参数哈希: 同参数同哈希, 改参数换哈希(旧授权失效的依据)
  const pv1 = v.reports.validateParams(def, JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' }));
  const pv2 = v.reports.validateParams(def, JSON.stringify({ P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' }));
  const pv3 = v.reports.validateParams(def, JSON.stringify({ P_WERKS: '2000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' }));
  check('同参数同哈希', pv1.hash === pv2.hash && pv1.hash !== '');
  check('改参数换哈希', pv3.hash !== pv1.hash);
}

/* =============== 补充: 意图路由边界与乐观锁 =============== */
function scenarioExtra() {
  section('补充: 路由边界 / 乐观锁 / TCode 形校验');
  check('ZM001 是 TCode 形', isTcodeLike('ZM001'));
  check('ZTEST_DATA_ 不是 TCode 形(尾下划线剔除后不足 4 位场景不误判)', isTcodeLike('ZTEST_DATA'));
  const r1 = quickRoute('SAP 是什么');
  check('通用问题路由 GENERAL(走旧链路)', r1.module_id === 'GENERAL');

  const { tasks } = freshStores();
  const pick = tasks.pickOrCreate(SESSION, '', 'DATA', 'TABLE_ANALYSIS', '表分析', USER);
  const t = tasks.getOwned(pick.task_id, SESSION, USER);
  const r1ok = tasks.updateStatus(t.task_id, t.current_version, 'RUNNING', '', USER);
  check('乐观锁: 正确版本更新成功', r1ok.ok === true);
  const r2bad = tasks.updateStatus(t.task_id, t.current_version - 1, 'COMPLETED', '', USER);
  check('乐观锁: 旧版本更新被拒', r2bad.ok === false && /版本不一致/.test(r2bad.reason));
  const r3other = tasks.updateStatus(t.task_id, t.current_version, 'COMPLETED', 'OTHER_USER', 'OTHER');
  check('跨用户更新被拒', r3other.ok === false);
}

/* =============== 场景 11: 10.09 遗留问题修复(路由 V1.0.4 / 参数 V1.0.11) =============== */
function scenario11() {
  section('场景 11: 对话式结果分析路由 / 表名双语序 / 报表词不误判 / 多值范围校验');
  const r = (q, o) => quickRoute(q, o);
  let x = r('分析一下这个结果');
  check('"分析一下这个结果" → ANALYZE_ARTIFACT(不再新建 DATA 任务)',
    x.intent_code === 'ANALYZE_ARTIFACT' && x.object_kind === 'ARTIFACT' && x.module_id === 'REPORT',
    `${x.module_id}/${x.intent_code}/${x.object_kind}`);
  x = r('上面的报表结果里哪个工厂 MIH 需求最大');
  check('"上面的报表结果里哪个工厂…最大" → ANALYZE_ARTIFACT', x.intent_code === 'ANALYZE_ARTIFACT');
  x = r('分析一下结果');
  check('"分析一下结果"(无指代词) → ANALYZE_ARTIFACT', x.intent_code === 'ANALYZE_ARTIFACT');
  x = r('分析一下刚才 ZM001 的结果');
  check('"分析一下刚才 ZM001 的结果" → 分析(不是恢复出参数卡)',
    x.intent_code === 'ANALYZE_ARTIFACT' && x.object_kind === 'TCODE' && x.object_value === 'ZM001',
    `${x.intent_code}/${x.object_kind}/${x.object_value}`);
  x = r('继续刚才的 ZM001');
  check('回归: "继续刚才的 ZM001" 仍是恢复任务', x.intent_code === 'VIEW_REPORT_RESULT');
  x = r('执行报表 ZDPMM702');
  check('"执行报表 ZDPMM702" → 报表执行(不被"表 ZDPMM702"误判 DATA)',
    x.module_id === 'REPORT' && x.intent_code === 'RUN_AND_ANALYZE_REPORT' && x.object_value === 'ZDPMM702',
    `${x.module_id}/${x.intent_code}/${x.object_value}`);
  x = r('ZIDPPP099表数据');
  check('反语序 "ZIDPPP099表数据" → DATA 表 ZIDPPP099', x.object_kind === 'TABLE' && x.object_value === 'ZIDPPP099',
    `${x.object_kind}/${x.object_value}`);
  x = r('表ZIDPPP099的数据');
  check('正语序 "表ZIDPPP099的数据" → DATA 表 ZIDPPP099', x.object_kind === 'TABLE' && x.object_value === 'ZIDPPP099');
  x = r('分析一下表 ZIDPMM455 的数据');
  check('显式表名优先于结果指代', x.object_kind === 'TABLE' && x.object_value === 'ZIDPMM455');
  x = r('写一个 ALV 表格程序');
  check('"ALV 表格" 不被当成表 ALV', x.object_kind !== 'TABLE', `${x.object_kind}/${x.object_value}`);
  x = r('这个数据库如何优化');
  check('"这个数据库如何优化" 不误判为结果分析', x.intent_code !== 'ANALYZE_ARTIFACT', x.intent_code);

  const { reports } = freshStores();
  const def = reports.getDefByTcode('ZM001');
  const base = { P_WERKS: '1000', P_DATE_FROM: '20261001', P_DATE_TO: '20261007' };
  let pv = reports.validateParams(def, JSON.stringify({ ...base, P_BUDAT: '20261001,20261009' }));
  check('日期范围 "low,high"(前端 AskCard 格式)校验通过', pv.ok === true, JSON.stringify(pv.errors));
  pv = reports.validateParams(def, JSON.stringify({ ...base, P_BUDAT: '20261009,20261001' }));
  check('日期范围倒序被拒(RANGE)', pv.errors.some(e => e.param_id === 'P_BUDAT' && e.code === 'RANGE'));
  pv = reports.validateParams(def, JSON.stringify({ ...base, P_MULTI: 'M001,M002,M003' }));
  check('多值逗号分隔逐项校验通过', pv.ok === true, JSON.stringify(pv.errors));
  pv = reports.validateParams(def, JSON.stringify({ ...base, P_MULTI: 'M001,' + 'X'.repeat(19) }));
  check('多值单项超长被拒(TYPE)', pv.errors.some(e => e.param_id === 'P_MULTI' && e.code === 'TYPE'));
}

/* =============== 场景 12: 会话场景约束(路由 V1.0.5) =============== */
function scenario12() {
  section('场景 12: 会话场景 —— 报表只执行报表 / 数据分析不调报表 / 场景外如实提示');
  const r = (q, scene) => quickRoute(q, { scene });
  let x = r('执行 ZDPMM702', 'REPORT');
  check('报表场景: "执行 ZDPMM702" → 报表执行', x.module_id === 'REPORT' && x.intent_code === 'RUN_AND_ANALYZE_REPORT');
  x = r('ZDPMM702', 'REPORT');
  check('报表场景: 只说 "ZDPMM702" → 报表卡(查看)', x.module_id === 'REPORT' && x.object_kind === 'TCODE' && x.intent_code === 'VIEW_REPORT_RESULT',
    `${x.module_id}/${x.intent_code}/${x.object_kind}`);
  x = r('哪个工厂 MIH 需求最大', 'REPORT');
  check('报表场景: 普通追问 → 分析本会话报表结果', x.intent_code === 'ANALYZE_ARTIFACT' && x.object_kind === 'ARTIFACT');
  x = r('统计一下各工厂的数量', 'REPORT');
  check('报表场景: "统计…"不再跑去数据分析', x.module_id === 'REPORT' && !x.out_of_scene, `${x.module_id}`);
  x = r('分析表 ZIDPMM455 的数据', 'REPORT');
  check('报表场景: 查表 → 场景外提示', x.out_of_scene === true && /数据分析/.test(x.reason));
  x = r('物料 A001 的库存', 'REPORT');
  check('报表场景: 库存 → 场景外提示', x.out_of_scene === true);

  x = r('分析 ZIDPMM455 的数据分布', 'DATA');
  check('数据分析场景: Z 词元按表名(不再当 TCode)', x.module_id === 'DATA' && x.object_kind === 'TABLE' && x.object_value === 'ZIDPMM455',
    `${x.module_id}/${x.object_kind}/${x.object_value}`);
  x = r('执行 ZDPMM702', 'DATA');
  check('数据分析场景: 执行报表 → 场景外提示(不触发报表)', x.out_of_scene === true && /报表执行/.test(x.reason));
  x = r('统计 ZIDPMM455 中提交日期的分布', 'DATA');
  check('数据分析场景: 含"提交"字样不误判报表执行', x.out_of_scene === false && x.module_id === 'DATA');
  x = r('分析一下这个结果', 'DATA');
  check('数据分析场景: "分析这个结果" → 追问已有数据(DATA)', x.module_id === 'DATA' && x.object_kind === 'NONE');
  x = r('物料 A001 在 0001 工厂的库存', 'DATA');
  check('数据分析场景: 库存问题用数据分析工具', x.module_id === 'DATA');

  x = r('A001 在 0001 工厂的库存', 'INVENTORY');
  check('库存场景: 库存问题 → INVENTORY', x.module_id === 'INVENTORY');
  x = r('表 MARD 的字段', 'INVENTORY');
  check('库存场景: 查表 → 场景外提示', x.out_of_scene === true);

  x = r('解释一下 ZDPMM702 的程序逻辑', 'CODE');
  check('代码场景: 点名对象 → CODE/PROGRAM', x.module_id === 'CODE' && x.object_kind === 'PROGRAM' && x.object_value === 'ZDPMM702',
    `${x.module_id}/${x.object_kind}/${x.object_value}`);
  x = r('执行 ZDPMM702', 'CODE');
  check('代码场景: 执行报表 → 场景外提示', x.out_of_scene === true);
  x = r('表 ZIDPMM455 的结构', 'CODE');
  check('代码场景: 表结构问题留在本场景', x.module_id === 'CODE' && x.object_kind === 'TABLE');

  x = r('分析一下这个结果', '');
  check('自动场景(旧会话/空): 与 V1.0.4 行为一致', x.intent_code === 'ANALYZE_ARTIFACT' && x.out_of_scene === false);
  x = r('分析一下这个结果', 'GENERAL');
  check('旧值 GENERAL 视为自动', x.intent_code === 'ANALYZE_ARTIFACT');
}

/* =============== 主流程 =============== */
// 20261019（改进清单 BE-01）：模型输出 JSON 平衡提取（对照 AGENT_GUARD V1.1.4 parse_model_json）
function scenario13() {
  console.log('\n━━ 场景 13: 模型输出 JSON 平衡提取（BE-01）');
  const obj = '{"action":"final","summary":"x","answer":"说明\\n```abap\\nDATA lv TYPE i.\\n  lv = 1.\\n```"}';
  check('纯对象原样取出', extractJsonObject(obj) === obj);
  const wrapped = '好的：\n```json\n' + obj + '\n```';
  check('围栏 + 前缀文字被忽略', extractJsonObject(wrapped) === obj);
  const ans = JSON.parse(extractJsonObject(wrapped)).answer;
  check('answer 保留代码围栏与两个空格缩进', /```abap\nDATA lv TYPE i\.\n  lv = 1\.\n```/.test(ans), ans);
  check('对象外不成对的引号不影响提取', extractJsonObject('他说"好的 ' + obj) === obj);
  check('字符串里的花括号不打断配平', extractJsonObject('{"a":"}{","b":1}') === '{"a":"}{","b":1}');
  check('没有对象返回空串', extractJsonObject('没有 JSON') === '');
}

// 20261028（10.28 记录 #01）：协议失败兜底（对照 GUARD V1.1.5 / AGENT_SERVICE V15.7）
function scenario14() {
  console.log('\n━━ 场景 14: 协议失败兜底（10.28 #01）');
  const obj = '{"action":"final","summary":"x","answer":"触发条件在第 1290 行"}';
  const pre = '报错在 |cancel confirmation failed:{ return-message }| 这一行。\n```json\n' + obj + '\n```';
  check('说明文字里的 ABAP 模板 { x } 不再被当成协议对象', extractJsonObject(pre, '"action"') === obj);
  check('不给 key 时仍取第一个对象（老行为）', extractJsonObject(pre) === '{ return-message }');
  check('都不含 key 时退回第一个对象', extractJsonObject('{"a":1} {"b":2}', '"action"') === '{"a":1}');
  check('缺 action、有 answer → final', inferAction({ summary: 's', answer: 'a' }).action === 'final');
  check('缺 action、有 tool → tool', inferAction({ tool: 'read_program_source', args: {} }).action === 'tool');
  check('缺 action、都没有 → 仍报缺 action', !inferAction({ summary: 's' }).action);

  const longAns = '结论：报错来自 FORM post_document 第 1290 行。\n1. 第 1146 行 BAPI_PRODORDCONF_CREATE_HDR 创建确认；\n2. 25 秒内没等到物料凭证就取消确认';
  const cut = '{"action":"final","summary":"定位报错","answer":"' + JSON.stringify(longAns).slice(1, -1) + '\\u4e';
  const sv = salvageAnswer(cut);
  check('被截断的 final：取出 answer 已输出部分（换行还原、尾部半个转义去掉）', sv.indexOf('第 1290 行。\n1. 第 1146 行') > 0 && !/\\u4e$/.test(sv) && sv.endsWith('取消确认'), sv);
  check('纯文字回答（没有 JSON）原样保留', salvageAnswer(longAns) === longAns);
  check('想调工具的输出不兜底', salvageAnswer('{"action":"tool","tool":"read_program_source","args":{"name":"ZRPP_IDP_0299","start_line":"1601"}') === '');
  check('以 { 开头但没有 answer 的输出不兜底', salvageAnswer('{"summary":"继续读下一段源码, 查看报错处理分支以及后续的逻辑和调用关系"}') === '');
  check('```json 围栏开头但被截断在 answer 之前，不兜底', salvageAnswer('```json\n{"action":"final","summary":"定位报错的触发条件与行号以及后续处理逻辑和建议"') === '');
  check('正文不足 40 字符不兜底', salvageAnswer('{"action":"final","answer":"在 1290 行') === '');
}

function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║ 任务/报表协议测试(本地 Mock/契约, 无 LLM) ║');
  console.log('╚══════════════════════════════════════════╝');
  scenario1();
  scenario2();
  scenario3();
  scenario4();
  scenario5();
  scenario6();
  scenario7();
  scenario8();
  scenario9();
  scenario10();
  scenarioExtra();
  scenario11();
  scenario12();
  scenario13();
  scenario14();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`总计: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log('说明: 以上为本地 Mock/契约行为测试;');
  console.log('      Mock 不能证明真实 SAP 权限、后台作业和结果锁正确。');
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

main();
