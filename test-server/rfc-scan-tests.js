/**
 * RFC 函数执行：登记规则测试（功能计划书/RFC函数执行/01 §3）
 * 运行: node rfc-scan-tests.js   （或 npm run test:rfcscan）
 *
 * 跑本地参考实现 rfc-scan-ref.js，锁住 ABAP 版要遵守的规则：
 *   ZCL_AI_RFC_EXEC=>name_danger / scan_source（写入类检查）、
 *   ZCL_AI_RPT_SCANNER=>scan_function（接口 → 参数草稿）、ZCL_AI_RFC_EXEC=>default_result。
 * 源码样本：仓库里的 Z_AI_ODATA_GET（只读函数）、10.28 记录附件 ZRPP_IDP_0299（带 BAPI 提交），其余手写。
 */
const fs = require('fs');
const path = require('path');
const ref = require('./rfc-scan-ref');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const codes = (hits, level) => hits.filter((h) => !level || h.level === level).map((h) => h.code);
const TRANSP = new Set(['ZAI_RPT_RUN', 'ZTSD_LOG', 'MARA', 'EKKO']);

console.log('\n━━ 函数名');
check('写入类词命中（CREATE / POST / UPDATE …）', ref.nameDanger('BAPI_PO_CREATE1') === 'CREATE' &&
  ref.nameDanger('BAPI_GOODSMVT_CREATE') === 'CREATE' && ref.nameDanger('Z_GET_LAST_UPDATE') === 'UPDATE');
check('只读名不误判（GETLIST / GETDETAIL / Z_AI_ODATA_GET）', !ref.nameDanger('BAPI_PO_GETDETAIL') &&
  !ref.nameDanger('BAPI_MATERIAL_GETLIST') && !ref.nameDanger('Z_AI_ODATA_GET'));

console.log('\n━━ 源码：提交 / 异步写入');
{
  const r = ref.checkWrites('Z_X', [
    'FUNCTION z_x.',
    '  SELECT * FROM mara INTO TABLE @DATA(lt) UP TO 10 ROWS.',
    '  CALL FUNCTION \'BAPI_TRANSACTION_COMMIT\' EXPORTING wait = \'X\'.',
    '  CALL FUNCTION \'Z_LOG\' IN UPDATE TASK EXPORTING iv = 1.',
    '  CALL FUNCTION \'Z_ASYNC\' STARTING NEW TASK \'T1\'.',
    '  CALL FUNCTION \'Z_TRFC\' IN BACKGROUND TASK.',
    '  COMMIT',
    '    WORK AND WAIT.',
    'ENDFUNCTION.'
  ], TRANSP);
  check('BAPI_TRANSACTION_COMMIT / UPDATE TASK / NEW TASK / BACKGROUND TASK / COMMIT WORK 全部 BLOCK',
    ['BAPICOMMIT', 'UPDTASK', 'NEWTASK', 'BGTASK', 'COMMIT'].every((c) => codes(r, 'BLOCK').indexOf(c) >= 0), JSON.stringify(codes(r)));
  const cw = r.filter((h) => h.code === 'COMMIT')[0] || {};
  check('跨行语句记在开始那一行（COMMIT 在第 7 行）', cw.line === 7, JSON.stringify(cw));
}

console.log('\n━━ 源码：注释和字面量不算');
{
  const r = ref.checkWrites('Z_X', [
    '* COMMIT WORK.  整行注释',
    '  lv_txt = \'COMMIT WORK\'. " 字面量里的不算',
    '  WRITE / `IN UPDATE TASK`.',
    '  lv_a = 1. " COMMIT WORK 行内注释',
    '  lv_q = \'他说"好"\'.  " 字面量里的双引号不是注释开头'
  ], TRANSP);
  check('注释、字面量里的关键字都不命中', codes(r, 'BLOCK').length === 0, JSON.stringify(r));
  const sc = ref.stripComment('  lv_q = \'他说"好"\'.  " 注释');
  check('字面量里的 " 不当注释开头；清空版只剩引号', sc.code.trim() === 'lv_q = \'他说"好"\'.' && sc.nolit.trim() === "lv_q = ''.", JSON.stringify(sc));
}

console.log('\n━━ 源码：写库只认透明表');
{
  const r = ref.checkWrites('Z_X', [
    '  UPDATE ztsd_log SET status = \'X\' WHERE id = @lv_id.',
    '  INSERT INTO ekko VALUES @ls_ekko.',
    '  MODIFY mara FROM @ls_mara.',
    '  DELETE FROM zai_rpt_run WHERE report_run_id = @lv_id.',
    '  INSERT ls_row INTO TABLE lt_rows.',
    '  MODIFY lt_rows FROM ls_row INDEX 1.',
    '  DELETE lt_rows WHERE matnr IS INITIAL.',
    '  DELETE ADJACENT DUPLICATES FROM lt_rows.',
    '  INSERT LINES OF lt_a INTO TABLE lt_b.',
    '  MODIFY TABLE lt_rows FROM ls_row.',
    '  UPDATE (lv_tab) SET x = 1.',
    '  ls_mara-matnr = \'1\'.'
  ], TRANSP);
  const db = r.filter((h) => h.code === 'DBWRITE').map((h) => h.text);
  check('UPDATE / INSERT INTO / MODIFY / DELETE FROM 透明表 → 4 条 BLOCK', db.length === 4 &&
    ['ZTSD_LOG', 'EKKO', 'MARA', 'ZAI_RPT_RUN'].every((t) => db.some((x) => x.indexOf(t) >= 0)), JSON.stringify(db));
  check('内表操作（INTO TABLE / MODIFY lt / DELETE lt / ADJACENT / LINES OF / MODIFY TABLE）不命中',
    !r.some((h) => /LT_|LS_/.test(h.text)));
  check('动态表名写库 → BLOCK DYNWRITE', codes(r, 'BLOCK').indexOf('DYNWRITE') >= 0);
}

console.log('\n━━ 源码：链式与跳出类');
{
  const r = ref.checkWrites('Z_X', [
    '  UPDATE: ztsd_log FROM ls_a, mara FROM ls_b.',
    '  SUBMIT zreport AND RETURN.',
    '  CALL TRANSACTION \'VA03\'.',
    '  CALL FUNCTION \'POPUP_TO_CONFIRM\'.'
  ], TRANSP);
  check('链式 UPDATE: 取第一个目标', r.some((h) => h.code === 'DBWRITE' && h.text.indexOf('ZTSD_LOG') >= 0));
  check('SUBMIT / CALL TRANSACTION / POPUP_ 只是 WARN', ['SUBMIT', 'CALLUI', 'POPUP'].every((c) => codes(r, 'WARN').indexOf(c) >= 0) &&
    codes(r, 'BLOCK').indexOf('SUBMIT') < 0);
}

console.log('\n━━ 真实源码');
{
  const fodata = path.join(__dirname, '../backend-abap/Z_AI_ODATA_GET.abap');
  const src = fs.readFileSync(fodata, 'utf8').split(/\r?\n/);
  const r = ref.checkWrites('Z_AI_ODATA_GET', src, TRANSP);
  check('Z_AI_ODATA_GET（只读函数）没有 BLOCK、名字不疑似', codes(r, 'BLOCK').length === 0 && codes(r, 'NAME').length === 0, JSON.stringify(r));
  const f0299 = path.join(__dirname, '../功能计划书/项目进度/10.28进度/交付_20261028_记录汇总/原始附件/源码_ZRPP_IDP_0299.txt');
  if (fs.existsSync(f0299)) {
    const r2 = ref.checkWrites('Z_X', fs.readFileSync(f0299, 'utf8').split(/\r?\n/), TRANSP);
    check('ZRPP_IDP_0299（调 BAPI 并提交）→ BAPICOMMIT', codes(r2, 'BLOCK').indexOf('BAPICOMMIT') >= 0);
  } else {
    console.log('  (跳过 ZRPP_IDP_0299：附件不在)');
  }
}

console.log('\n━━ 接口 → 参数草稿');
{
  const P = (o) => Object.assign({ optional: false, defval: '', text: '', label: '', data_type: 'CHAR', type_length: 10 }, o);
  const params = [
    P({ name: 'IV_WERKS', kind: 'I', shape: 'SCALAR', type_length: 4, text: '工厂', label: '工厂' }),
    P({ name: 'IV_DATE', kind: 'I', shape: 'SCALAR', data_type: 'DATE', type_length: 8, optional: true, defval: 'SY-DATUM', label: '日期' }),
    P({ name: 'IV_MAX', kind: 'I', shape: 'SCALAR', data_type: 'NUM', optional: true, defval: '100', label: 'IV_MAX' }),
    P({ name: 'IV_OPEN', kind: 'I', shape: 'FLAG', optional: true, defval: "'X'", label: '只看未清' }),
    P({ name: 'IS_HEAD', kind: 'I', shape: 'STRUCT', optional: true }),
    P({ name: 'IT_MATNR', kind: 'T', shape: 'RANGE', optional: true, label: '物料' }),
    P({ name: 'IT_BUDAT', kind: 'I', shape: 'RANGE', data_type: 'DATE', optional: true, label: '过账日期' }),
    P({ name: 'ET_DATA', kind: 'T', shape: 'TABLE', optional: true }),
    P({ name: 'RETURN', kind: 'T', shape: 'TABLE', optional: true }),
    P({ name: 'EV_COUNT', kind: 'E', shape: 'SCALAR' }),
    P({ name: 'NOT_FOUND', kind: 'X', shape: 'EXC' })
  ];
  const d = ref.draftParams(params);
  const row = (id) => d.rows.filter((r) => r.param_id === id)[0] || {};
  check('单值 → P；必填按 OPTIONAL；标签来源 FUNCT', row('IV_WERKS').sel_kind === 'P' && row('IV_WERKS').required && row('IV_WERKS').label_src === 'FUNCT');
  check('默认 SY-DATUM → TODAY；数字 → STATIC', row('IV_DATE').default_type === 'TODAY' && !row('IV_DATE').required &&
    row('IV_MAX').default_type === 'STATIC' && row('IV_MAX').default_value === '100');
  check("标记 → C 复选框，默认 'X' → allowed_ops X", row('IV_OPEN').sel_kind === 'C' && row('IV_OPEN').data_type === 'BOOL' && row('IV_OPEN').allowed_ops === 'X');
  check('范围表 → S：日期 = 范围，其余 = 多值；TABLES 范围也认', row('IT_MATNR').sel_kind === 'S' && row('IT_MATNR').multi_value &&
    row('IT_BUDAT').range_allowed && !row('IT_BUDAT').multi_value);
  check('选填结构不登记并写原因；输出表 / RETURN / EXPORTING / 例外不进参数卡', row('IS_HEAD').include === false && row('IS_HEAD').note &&
    !d.rows.some((r) => ['ET_DATA', 'RETURN', 'EV_COUNT', 'NOT_FOUND'].indexOf(r.param_id) >= 0));
  check('没有错误；排序号按登记行递增', d.error === '' && row('IV_WERKS').sort_no === 10 && row('IT_BUDAT').sort_no === 60, JSON.stringify(d.rows.map((r) => [r.param_id, r.sort_no])));
  check('主结果默认取第一个非 RETURN 的表', ref.defaultResult(params) === 'ET_DATA');

  const d2 = ref.draftParams([P({ name: 'IS_KEY', kind: 'I', shape: 'STRUCT' })]);
  check('必填结构 → 不能登记', d2.error.indexOf('IS_KEY') >= 0);
  const d3 = ref.draftParams([P({ name: 'ET_DATA', kind: 'T', shape: 'TABLE', optional: true })]);
  check('没有输入参数 → 一期不能登记（参数卡至少要一项）', d3.error.indexOf('没有可填的输入参数') >= 0);
  check('SY-DATUM - 1 → TODAY -1；空字面量不认', ref.parseFmDefault('SY-DATUM - 1').value === '-1' && ref.parseFmDefault("''") === null &&
    ref.parseFmDefault('SY-DATUM').value === '0');
  check('只有 RETURN 一张表 → 没有默认主结果', ref.defaultResult([P({ name: 'RETURN', kind: 'T', shape: 'TABLE' })]) === '');
}

console.log('\n━━ 表参数登记 / 解析（05 方案，对照 RFC_EXEC V1.2 / SCANNER V1.3 / REPORT_SERVICE V1.0.17）');
{
  const P = (o) => Object.assign({ optional: false, defval: '', text: '', label: '', data_type: 'CHAR', type_length: 10, cols: 0 }, o);
  const params = [
    P({ name: 'IV_WERKS', kind: 'I', shape: 'SCALAR' }),
    P({ name: 'IT_MATS', kind: 'I', shape: 'TABLE', cols: 3, label: '物料清单' }),
    P({ name: 'IS_OPT', kind: 'I', shape: 'STRUCT', cols: 2, optional: true }),
    P({ name: 'IS_DEEP', kind: 'I', shape: 'STRUCT', cols: 0, optional: true }),
    P({ name: 'T_INPUT', kind: 'T', shape: 'TABLE', cols: 2, optional: true }),
    P({ name: 'MATERIALS', kind: 'T', shape: 'TABLE', cols: 2, optional: true }),
    P({ name: 'ET_STOCK', kind: 'T', shape: 'TABLE', cols: 5, optional: true })
  ];
  const d = ref.draftParams(params);
  const row = (id) => d.rows.filter((r) => r.param_id === id)[0] || {};
  check('IMPORTING 表 → T / TABLE / 多行，必填照接口', row('IT_MATS').sel_kind === 'T' && row('IT_MATS').data_type === 'TABLE' &&
    row('IT_MATS').multi_value === true && row('IT_MATS').required === true);
  check('扁平结构 → T，只收一行（multi_value = false）', row('IS_OPT').sel_kind === 'T' && row('IS_OPT').multi_value === false && !row('IS_OPT').required);
  check('有嵌套的结构（cols = 0）仍不登记并写原因', row('IS_DEEP').include === false && /复杂字段/.test(row('IS_DEEP').note));
  check('TABLES：T_IN… 名字规则当输入；其余（MATERIALS / ET_STOCK）仍当输出', row('T_INPUT').sel_kind === 'T' &&
    !d.rows.some((r) => r.param_id === 'MATERIALS' || r.param_id === 'ET_STOCK'));
  const d2 = ref.draftParams(params, ['materials']);
  check('点名的 TABLES 表当输入（不分大小写）', d2.rows.some((r) => r.param_id === 'MATERIALS' && r.sel_kind === 'T'));
  check('默认主结果跳过当输入的 TABLES 表', ref.defaultResult([P({ name: 'IT_KEYS', kind: 'T', shape: 'TABLE', cols: 1 }),
    P({ name: 'ET_STOCK', kind: 'T', shape: 'TABLE', cols: 5 })]) === 'ET_STOCK');
  const d3 = ref.draftParams([P({ name: 'IS_KEY', kind: 'I', shape: 'STRUCT', cols: 2 })]);
  check('必填扁平结构现在能登记（原来挡住整个函数）', d3.error === '' && d3.rows[0].sel_kind === 'T' && d3.rows[0].required);
  check('名字规则：IT_ / I_ / IN_ / INPUT_ / T_IN 是输入，ET_ / RETURN 不是', ['IT_A', 'I_B', 'IN_C', 'INPUT_D', 'T_INPUT'].every((n) => ref.tableInputName(n)) &&
    !['ET_A', 'RETURN', 'T_OUT', 'ITAB'].some((n) => ref.tableInputName(n)));

  // 参数快照解析：长值（粘贴的表）不丢、转义正确
  const rowsJson = JSON.stringify([['MATNR', 'WERKS']].concat(Array.from({ length: 1000 }, (x, i) => ['M' + i + '"q', '1000'])));
  const flat = JSON.stringify({ it_mats: rowsJson, iv_werks: '1000' }).replace('}', ',"n":12,"b":true,"bad-key":"x"}');
  const kv = ref.parseFlatKv(flat);
  const g = (k) => (kv.filter((x) => x.name === k)[0] || {}).value;
  check('parse_flat_kv：几万字的值完整取回（原正则会整串丢失）', flat.length > 20000 && g('it_mats') === rowsJson && g('iv_werks') === '1000', String(flat.length));
  check('parse_flat_kv：数字 / true 原样；非法键丢掉', g('n') === '12' && g('b') === 'true' && !kv.some((x) => x.name === 'bad-key'));
  check('parse_flat_kv：不是对象 → 空', ref.parseFlatKv('[1,2]').length === 0 && ref.parseFlatKv('').length === 0);
  const pr = ref.parseRows(rowsJson);
  check('parse_rows：1000 行数据 + 表头，引号还原', !pr.error && pr.rows.length === 1001 && pr.rows[1][0] === 'M0"q');
  check('parse_rows：超过 1000 行 → 报错', /超过 1000 行/.test(ref.parseRows(JSON.stringify(Array.from({ length: 1003 }, () => ['x']))).error));
  check('parse_rows：\\n / \\t 变空格、\\u 还原、null → 空、数字原样', JSON.stringify(ref.parseRows('[["A","B","C"],["x\\ny\\tz","\\u4e2d",null],[1, 2.5 ,true]]').rows) ===
    JSON.stringify([['A', 'B', 'C'], ['x y z', '中', ''], ['1', '2.5', 'true']]));
  check('parse_rows：格式错误给出原因', /不是数组/.test(ref.parseRows('[["A"],"x"]').error) && /没闭合/.test(ref.parseRows('[["A').error) &&
    /格式不对/.test(ref.parseRows('{"a":1}').error));
}

console.log('\n━━ 数据分析调用函数（03 方案，本地 mock 对照 ZCL_AI_RFC_EXEC V1.1）');
(async () => {
  const mt = require('./mock-tools');
  const desc = mt.functionToolDescription();
  check('工具说明：只列 EXEC_MODE 不是 JOB 的函数；参数格式 = 编号 标签*(类型)', desc.indexOf('Z_AI_DEMO_PO_OPEN 未清采购订单: IV_WERKS 工厂*(CHAR4)、IT_LIFNR 供应商(CHAR 多值逗号分隔)、IT_BEDAT 凭证日期(DATE 范围 low,high)、IV_OPEN 只看未清(X/空); ') >= 0 &&
    desc.indexOf('Z_AI_DEMO_SLOW') < 0, desc);
  check('没有可用函数 → 说明为空（不注册工具）；超过上限写「还有 N 个」', mt.functionToolDescription([{ tcode: 'ZX', name: 'x', exec_mode: 'JOB', params: [] }]) === '' &&
    /还有 2 个未列出/.test(mt.functionToolDescription([1, 2, 3].map((i) => ({ tcode: 'ZF' + i, name: 'f', exec_mode: 'SYNC', params: [] })), 1)));
  const tools = mt.getToolsForDomain('DATA').map((t) => t.id);
  check('DATA 领域工具带 call_function；其他领域不带', tools.indexOf('call_function') >= 0 && mt.getToolsForDomain('INVENTORY').every((t) => t.id !== 'call_function'));
  const ok = await mt.execute('call_function', { function: 'z_ai_demo_po_open', purpose: '1000 未清', params: { iv_werks: '1000', it_bedat: '20261001,20261031' } });
  check('正常调用：返回数据集（只看未清默认 X）', ok.status === 'OK' && ok.data.dataset.name === '1000 未清' && ok.data.dataset.total_rows === 3, JSON.stringify(ok.summary));
  const miss = await mt.execute('call_function', { function: 'Z_AI_DEMO_PO_OPEN', params: {} });
  check('缺必填 → 回具体参数，让模型改了再调', miss.status === 'ERROR' && /IV_WERKS: 必填/.test(miss.data.error));
  const job = await mt.execute('call_function', { function: 'Z_AI_DEMO_SLOW', params: { IV_GJAHR: '2026' } });
  check('EXEC_MODE = JOB 的函数在数据分析里调不了', job.status === 'ERROR' && /只能走报表执行/.test(job.data.error));
  console.log(`\n━━ 结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();

