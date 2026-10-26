/**
 * 改进清单 DATA-01：刷新 / 重新打开会话后恢复结果表、图表、续跟运行与参数卡。
 * 真实控制器 + mixin（ResultRestore / RunTracker / FioriPanel / SessionMessages）+ UI5 垫片；
 * ChatService 对后端的调用（Tasks / TaskContext 的键名与过滤）用真实 ChatService + 假 fetch。不访问 SAP 或模型。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEBAPP = path.join(__dirname, '../webapp');

function memStore() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }, _m: m
  };
}
const storage = memStore();
const timers = [];
const fakeWindow = {
  localStorage: storage, sessionStorage: memStore(),
  setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, clearInterval() {}
};

class Control {
  constructor(o = {}) { this.o = o; this.events = {}; this.items = o.items || []; this.d = {}; }
  addStyleClass() { return this; }
  toggleStyleClass() { return this; }
  addItem(o) { this.items.push(o); return this; }
  destroyItems() { this.items = []; }
  setVisible(v) { this.o.visible = v; return this; }
  getDomRef() { return null; }
  isDestroyed() { return false; }
  data(k, v) { if (v === undefined) { return this.d[k]; } this.d[k] = v; return this; }
}
function Storage() {}
Storage.Type = { local: 'local' };
const service = {};
const registry = {
  'zai/chat/control/LingXiMark': Control,
  'sap/ui/core/mvc/Controller': { extend: (_, methods) => methods },
  'sap/ui/util/Storage': Storage,
  'sap/m/MessageToast': { show() {} },
  'zai/chat/service/ChatService': service
};
for (const name of ['SceneModels', 'SettingsPanel', 'EvalPanel', 'AuthPanel', 'AuthApprove', 'CatalogPanel']) {
  registry['zai/chat/controller/mixin/' + name] = {};
}
for (const name of ['TraceService', 'ChartBuilder']) { registry['zai/chat/' + (name === 'TraceService' ? 'service/' : 'utils/') + name] = {}; }

function sandboxFor(file, onDefine, reg) {
  return {
    sap: { ui: { define: (deps, fn) => { onDefine(fn(...deps.map((d) => loadWith(reg, d)))); } } },
    console, Object, Array, JSON, Date, Promise, setTimeout: fakeWindow.setTimeout,
    window: fakeWindow, jQuery: { extend: Object.assign }, Math
  };
}
function loadWith(reg, name) {
  if (reg[name]) { return reg[name]; }
  if (name.startsWith('sap/')) { return Control; }
  let out;
  const file = path.join(WEBAPP, name.replace('zai/chat/', '') + '.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandboxFor(file, (o) => { out = o; }, reg), { filename: file });
  return (reg[name] = out);
}
const App = loadWith(registry, 'zai/chat/controller/App.controller');

class Model {
  constructor(data) { this.data = data; }
  getProperty(p) { return p.split('/').filter(Boolean).reduce((o, k) => o && o[k], this.data); }
  setProperty(p, v) {
    const keys = p.split('/').filter(Boolean), last = keys.pop();
    const o = keys.reduce((o, k) => o[k] || (o[k] = {}), this.data);
    o[last] = v;
  }
}
let uidSeq = 0;
function controller() {
  const models = {
    chat: new Model({ messages: [], currentSession: {}, currentTask: null, workspaceMode: 'AGENT' }),
    settings: new Model({}), session: new Model({})
  };
  return Object.assign(Object.create(App), {
    getView: () => ({ getModel: (k) => models[k] }), models, _mModeSession: {},
    _newSessionId: () => String(++uidSeq).padStart(32, '0').split('').reverse().join(''),
    _rb: () => ({ getText: (k, args) => k + (args ? ':' + args.join(',') : '') }),
    _modelUserKey: () => 'U1',
    _persistSettings() {}, _applySessionModel() {}, _setSendBtnBusy() {}, _isNearBottom: () => true,
    _scrollToBottom() {}, _highlightCodeBlocks() {}, _renderAsk() {},
    _setViewLayout(v) { models.chat.setProperty('/listVisible', v); }
  });
}
function activate(c, id, mode = 'AGENT') { c._setSessionContext({ id, mode }); c.models.session.setProperty('/currentId', id); }
function add(c, text, role = 'assistant') {
  const e = c._buildEntry(role, text, '', '');
  c.models.chat.getProperty('/messages').push(e);
  c._refreshMessages();
  return e;
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async (n = 4) => { for (let i = 0; i < n; i++) { await new Promise((r) => setImmediate(r)); } };
const stored = () => JSON.parse(storage.getItem('zaiChat.extras.v1.U1') || '{"s":{}}');
const result = { schemaJson: '{"columns":[{"name":"M","label":"物料"},{"name":"Q","label":"数量","numeric":true}]}', rowsJson: '[["A",12],["B",34]]', rowCount: 2 };
const hist = (rows) => () => Promise.resolve(rows.map(([Role, Content, CreatedAt]) => ({ Role, Content, CreatedAt })));
const msgs = (c) => c.models.chat.getProperty('/messages');
function reset() {
  Object.keys(service).forEach((k) => { delete service[k]; });
  service.getReportCatalog = () => Promise.resolve({ defs: [] });
  service.getSessionResults = () => Promise.resolve({ tasks: [], artifacts: [] });
}

let passed = 0;
async function test(name, fn) { reset(); await fn(); passed++; console.log('  ✅ ' + name); }

(async () => {
  console.log('\n━━ 刷新后恢复（控制器）');

  await test('报表 / Fiori 结果按登记时间插回原位，带 ArtifactId，聚焦最新一份；Fiori 已分析的闸门保持「已发出」', async () => {
    const c = controller(); activate(c, 'S1');
    service.getHistory = hist([
      ['user', '执行 ZDPSD012', '20261025100000'], ['assistant', '请确认参数', '20261025100005'],
      ['user', '分析一下这个结果', '20261025101000'], ['assistant', '分析如下', '20261025101010']]);
    service.getSessionResults = (sid) => { assert.equal(sid, 'S1'); return Promise.resolve({ tasks: [], artifacts: [
      { artifactId: 'ART-R', type: 'REPORT_RESULT', runId: 'RUN12345678ABC', label: 'ZDPSD012 运行结果', rowCount: 2, createdAt: '20261025100500' },
      { artifactId: 'ART-F', type: 'FIORI_RESULT', runId: 'FR1', label: 'shipment', rowCount: 2, createdAt: '20261025102000' }] }); };
    const asked = [];
    service.getReportResult = (id) => { asked.push(id); return Promise.resolve({ ...result, label: 'ZDPSD012 运行结果' }); };
    service.getFioriReportResult = (id) => { asked.push(id); return Promise.resolve({ ...result, artifactId: id, runId: 'FR1', label: 'shipment', analyzeEnabled: 'X', analyzed: 'X' }); };
    await c._loadHistoryFor('S1', true);
    const m = msgs(c);
    assert.equal(JSON.stringify(m.map((e) => e.artifactId || e.raw)), JSON.stringify(['执行 ZDPSD012', '请确认参数', 'ART-R', '分析一下这个结果', '分析如下', 'ART-F']));
    assert.equal(asked.sort().join(), 'ART-F,ART-R');
    assert.equal(m[2].analysis.datasets[0].rows[1][1], 34);
    assert.ok(m[2].extraHtml.includes('data-act='), '恢复的结果表带工具条（复制 / 导出 / 生成图表）');
    assert.equal(m[2].time, '10-25 10:05');
    assert.ok(m[2].raw.includes('RUN12345'));
    assert.ok(m[5].runHtml.includes('fgSent'), '已交给模型分析过的 Fiori 结果不再显示「交给模型分析」按钮');
    assert.equal(c._mFocusArt.S1, 'ART-F');
    assert.ok(m[2].localResult && m[2].restored);
  });

  await test('普通对话会话不查任务接口；任务接口失败时历史照常显示、什么都不补', async () => {
    const c = controller(); activate(c, 'C1', 'CHAT');
    service.getHistory = hist([['user', '你好', '20261025090000'], ['assistant', '你好！', '20261025090001']]);
    service.getSessionResults = () => { throw new Error('普通对话不该查结果索引'); };
    await c._loadHistoryFor('C1', false);
    assert.equal(msgs(c).length, 2);
    const c2 = controller(); activate(c2, 'A1');
    service.getHistory = hist([['assistant', '回答', '20261025090001']]);
    service.getSessionResults = () => Promise.reject(new Error('Tasks 404'));
    await c2._loadHistoryFor('A1', true);
    assert.equal(msgs(c2).length, 1);
  });

  await test('单份结果取明细失败（过期 / 无权）只跳过那一份', async () => {
    const c = controller(); activate(c, 'S1b');
    service.getHistory = hist([['assistant', '回答', '20261025090001']]);
    service.getSessionResults = () => Promise.resolve({ tasks: [], artifacts: [
      { artifactId: 'GONE', type: 'REPORT_RESULT', createdAt: '20261025090002' },
      { artifactId: 'OK', type: 'REPORT_RESULT', createdAt: '20261025090003' }] });
    service.getReportResult = (id) => Promise.resolve(id === 'GONE' ? { message: '结果已过期' } : { ...result });
    await c._loadHistoryFor('S1b', true);
    assert.equal(JSON.stringify(msgs(c).map((e) => e.artifactId || e.raw)), '["回答","OK"]');
  });

  await test('图表只记配置不记数据；刷新后套回恢复的结果表与正文表格；数据分析数据集上的图不记', async () => {
    const c = controller(); activate(c, 'S2');
    const r = c._pushReportResult({ ...result, artifactId: 'ART-C' }, 'RUN-C');
    r.userCharts = [{ id: 'c1', src: 'ds:0', cfg: { type: 'bar', x: 0, y: [1], title: '数量' }, ds: r.analysis.datasets[0] }];
    c._rrSaveCharts(r);
    const sql = add(c, 'SQL 分析结论');
    sql.analysis = { datasets: [{ name: 'q', columns: [], rows: [] }] };
    sql.userCharts = [{ id: 'c2', src: 'ds:0', cfg: { type: 'bar' }, ds: {} }];
    c._rrSaveCharts(sql);
    const md = add(c, '| 物料 | 数量 |\n|---|---|\n| A | 1 |');
    md.userCharts = [{ id: 'c3', src: 'md:0', cfg: { type: 'line', x: 0, y: [1] }, ds: {} }];
    c._rrSaveCharts(md);
    const s = stored().s.S2;
    assert.deepEqual(Object.keys(s.charts).length, 2);
    assert.equal(s.charts['a:ART-C'][0].cfg.title, '数量');
    assert.equal(s.charts['a:ART-C'][0].ds, undefined, '不存数据');
    const sMdKey = Object.keys(s.charts).find((k) => k.startsWith('h:'));
    assert.ok(/:0$/.test(sMdKey));

    // —— 刷新 ——
    const c2 = controller(); activate(c2, 'S2');
    service.getHistory = hist([['assistant', 'SQL 分析结论', '20261025110000'], ['assistant', md.raw, '20261025110100']]);
    service.getSessionResults = () => Promise.resolve({ tasks: [], artifacts: [{ artifactId: 'ART-C', type: 'REPORT_RESULT', runId: 'RUN-C', createdAt: '20261025105900' }] });
    service.getReportResult = () => Promise.resolve({ ...result });
    const mdDs = { name: 'md', columns: [{ name: 'c0', label: '物料' }, { name: 'c1', label: '数量', numeric: true }], rows: [['A', 1]] };
    c2._rrMdDataset = (e, n) => (n === 0 ? mdDs : null);
    await c2._loadHistoryFor('S2', true);
    const m = msgs(c2);
    assert.equal(m[0].artifactId, 'ART-C');
    assert.equal(m[0].userCharts[0].ds, m[0].analysis.datasets[0]);
    assert.ok(m[0].extraHtml.includes('chartCard'));
    assert.equal(m[1].userCharts, undefined, 'SQL 数据集上的图不恢复');
    assert.equal(m[2].userCharts[0].ds, mdDs);
    assert.ok(c2._bodyHtml(m[2]).includes('chartCard'), '正文表格下方画出恢复的图表');

    // 删掉最后一张图 → 记录也删掉
    c2._sMessagesSession = 'S2';
    m[0].userCharts = [];
    c2._rrSaveCharts(m[0]);
    assert.equal(stored().s.S2.charts['a:ART-C'], undefined);
  });

  await test('同样正文的两条回复各自记各自的图（按同文第几条区分）', async () => {
    const c = controller(); activate(c, 'S2b');
    const a = add(c, '同样的表'), b = add(c, '同样的表');
    b.userCharts = [{ id: 'cb', src: 'md:0', cfg: { type: 'pie' } }];
    c._rrSaveCharts(b);
    const keys = Object.keys(stored().s.S2b.charts);
    assert.equal(keys.length, 1); assert.ok(/:1$/.test(keys[0]));
    assert.notEqual(c._rrAnchor(a, msgs(c)), c._rrAnchor(b, msgs(c)));
  });

  await test('刷新前还在跑的报表：刷新后追加「继续跟踪」并按原提交时间续轮询，就绪后插入结果并不再续跟', async () => {
    const c = controller(); activate(c, 'S3'); const a = add(c, '参数');
    service.getReportRunStatus = () => new Promise(() => {});
    c._trackRun(a.uid, 'RUN-X', 'S3', 'abcd1234');
    const iStart = stored().s.S3.runs['RUN-X'].start;
    assert.ok(iStart > 0);

    const c2 = controller(); activate(c2, 'S3');
    service.getHistory = hist([['assistant', '参数', '20261025120000']]);
    const poll = deferred();
    service.getReportRunStatus = () => poll.promise;
    service.getReportResult = (id) => Promise.resolve({ ...result, artifactId: id });
    await c2._loadHistoryFor('S3', true);
    let m = msgs(c2);
    assert.equal(m.length, 2);
    assert.equal(m[1].raw, 'runResumedText:abcd1234');
    assert.equal(c2._mRuns['RUN-X'].start, iStart);
    assert.ok(m[1].runHtml.includes('run-active'));
    poll.resolve({ status: 'READY', artifactId: 'ART-X' }); await flush();
    m = msgs(c2);
    assert.equal(m.length, 3); assert.equal(m[2].artifactId, 'ART-X');
    assert.equal(stored().s.S3.runs['RUN-X'], undefined);
  });

  await test('续跟的运行就绪时结果已按索引恢复过：不重复插入', async () => {
    const c = controller(); activate(c, 'S3b');
    const r = c._pushReportResult({ ...result, artifactId: 'ART-D' }, 'RUN-D', { noAppend: true });
    c._appendSessionEntry('S3b', r);
    const again = c._pushReportResult({ ...result, artifactId: 'ART-D' }, 'RUN-D');
    assert.equal(again, r); assert.equal(msgs(c).length, 1);
  });

  await test('超过 24 小时的运行号不再续跟；用户点「停止跟踪」后也不续跟', async () => {
    const o = stored(); o.s.S3c = { t: Date.now(), runs: { OLD: { shortId: 'old', start: Date.now() - 25 * 3600 * 1000 } } };
    storage.setItem('zaiChat.extras.v1.U1', JSON.stringify(o));
    const c = controller(); activate(c, 'S3c');
    service.getHistory = hist([['assistant', 'x', '20261025120000']]);
    await c._loadHistoryFor('S3c', true);
    assert.equal(msgs(c).length, 1);
    const c2 = controller(); activate(c2, 'S3d'); const a = add(c2, 'p');
    service.getReportRunStatus = () => new Promise(() => {});
    c2._trackRun(a.uid, 'RUN-S', 'S3d', 's');
    c2._stopRun('stopped', c2._mRuns['RUN-S']);
    assert.ok(stored().s.S3d.runs['RUN-S'], '离开 / 清缓存时的 stopped 不算用户停止');
    c2._rrForgetRun(c2._mRuns['RUN-S']);
    assert.equal(stored().s.S3d.runs['RUN-S'], undefined);
  });

  await test('WAITING_INPUT 任务的参数卡挂回对应回复，顶栏任务恢复；取消过的不恢复', async () => {
    const tasks = [
      { task_id: 'T0', module_id: 'REPORT', status: 'COMPLETED', changed_at: '20261025095000', pending_json: '' },
      { task_id: 'T1', module_id: 'REPORT', status: 'WAITING_INPUT', changed_at: '20261025100004',
        pending_json: JSON.stringify({ report_id: 'R1', tcode: 'ZDPSD012', params: [{ param_id: 'WERKS', label: '工厂', required: true }] }) }];
    const rows = [['user', '执行 ZDPSD012', '20261025100000'], ['assistant', '请补充参数', '20261025100003'],
      ['user', '先问别的', '20261025100100'], ['assistant', '别的回答', '20261025100105']];
    const c = controller(); activate(c, 'S4');
    service.getHistory = hist(rows);
    service.getSessionResults = () => Promise.resolve({ tasks, artifacts: [] });
    await c._loadHistoryFor('S4', true);
    const m = msgs(c);
    assert.equal(m[1].ask.kind, 'params'); assert.equal(m[1].ask.taskId, 'T1');
    assert.equal(m[1].ask.reportId, 'R1'); assert.equal(m[1].ask.autoFocus, false);
    assert.ok(!m[3].ask, '卡片不挂到之后的其他回复上');
    assert.equal(c.models.chat.getProperty('/currentTask/taskId'), 'T1');
    assert.ok(c.models.chat.getProperty('/taskBadge'));

    const c2 = controller(); activate(c2, 'S5');
    c2._rrDismissAsk('S5', 'T1');
    await c2._loadHistoryFor('S5', true);
    assert.ok(!msgs(c2).some((e) => e.ask));
  });

  await test('Fiori 的待填参数恢复成「取数」卡（带预填值）', async () => {
    const c = controller(); activate(c, 'S6');
    service.getHistory = hist([['assistant', '确认参数后取数', '20261025130000']]);
    service.getSessionResults = () => Promise.resolve({ artifacts: [], tasks: [{ task_id: 'TF', module_id: 'FIORI', status: 'WAITING_INPUT', changed_at: '20261025130001',
      pending_json: JSON.stringify({ kind: 'FIORI', report_id: 'SHIPMENT', report_name: 'shipment報表', values: { DIM: 'SHMODE' }, params: [{ param_id: 'DIM' }] }) }] });
    await c._loadHistoryFor('S6', true);
    const ask = msgs(c)[0].ask;
    assert.equal(ask.fiori, true); assert.equal(ask.values.DIM, 'SHMODE'); assert.equal(ask.subtitle, 'shipment報表');
  });

  await test('最后一条是带编号选项的追问：选项卡挂回去；不是最后一条就不挂', async () => {
    const q = '请选择统计口径？\n1. 按月\n2. 按周';
    const c = controller(); activate(c, 'S7', 'CHAT');
    service.getHistory = hist([['user', '统计', '20261025140000'], ['assistant', q, '20261025140001']]);
    await c._loadHistoryFor('S7', false);
    assert.equal(msgs(c)[1].ask.kind, 'choice'); assert.equal(msgs(c)[1].ask.options.length, 2);
    const c2 = controller(); activate(c2, 'S8', 'CHAT');
    service.getHistory = hist([['assistant', q, '20261025140001'], ['user', '按月', '20261025140100'], ['assistant', '好的', '20261025140105']]);
    await c2._loadHistoryFor('S8', false);
    assert.ok(!msgs(c2).some((e) => e.ask));
  });

  await test('回复正在输出时不整表重建：等结束后再插入恢复的结果', async () => {
    const c = controller(); activate(c, 'S9');
    service.getHistory = hist([['assistant', '旧回答', '20261025150000']]);
    const got = deferred();
    service.getSessionResults = () => got.promise;
    service.getReportResult = () => Promise.resolve({ ...result });
    const p = c._loadHistoryFor('S9', true);
    await flush();
    c.models.chat.setProperty('/busy', true);
    const live = add(c, '新问题', 'user');
    got.resolve({ tasks: [], artifacts: [{ artifactId: 'ART-B', type: 'REPORT_RESULT', createdAt: '20261025150100' }] });
    await p;
    assert.equal(msgs(c).length, 2, '输出中不插入');
    c.models.chat.setProperty('/busy', false);
    timers.splice(0).forEach((fn) => fn());
    const m = msgs(c);
    assert.equal(JSON.stringify(m.map((e) => e.artifactId || e.raw)), '["旧回答","ART-B","新问题"]');
    assert.equal(m[2], live);
  });

  await test('只恢复一次；之后回读被中断的回复时恢复的结果卡留在原位', async () => {
    const c = controller(); activate(c, 'S10');
    service.getHistory = hist([['user', 'q', '20261025160000'], ['assistant', 'a', '20261025160001'], ['user', 'q2', '20261025160200']]);
    let n = 0;
    service.getSessionResults = () => { n++; return Promise.resolve({ tasks: [], artifacts: [{ artifactId: 'ART-K', type: 'REPORT_RESULT', createdAt: '20261025160100' }] }); };
    service.getReportResult = () => Promise.resolve({ ...result });
    await c._loadHistoryFor('S10', true);
    const w = add(c, ''); w.waiting = w.streaming = true;
    activate(c, 'OTHER', 'CHAT'); activate(c, 'S10');
    service.getHistory = hist([['user', 'q', '20261025160000'], ['assistant', 'a', '20261025160001'], ['user', 'q2', '20261025160200'], ['assistant', 'a2', '20261025160300']]);
    await c._loadHistoryFor('S10', true);
    assert.equal(n, 1);
    assert.equal(JSON.stringify(msgs(c).map((e) => e.artifactId || e.raw)), '["q","a","ART-K","q2","a2"]');
  });

  await test('删除会话：本机记录一起清掉；会话删了之后迟到的恢复结果不写回', async () => {
    const c = controller(); activate(c, 'S11'); const a = add(c, 'p');
    service.getReportRunStatus = () => new Promise(() => {});
    c._trackRun(a.uid, 'RUN-Z', 'S11', 'z');
    assert.ok(stored().s.S11);
    activate(c, 'S11b', 'CHAT');   // 删的是非当前会话（删当前会话会新建会话，需要场景模块，垫片里没有）
    c._forgetSession('S11');
    assert.equal(stored().s.S11, undefined);
    const c2 = controller(); activate(c2, 'S12');
    service.getHistory = hist([['assistant', 'a', '20261025170000']]);
    const got = deferred(); service.getSessionResults = () => got.promise;
    service.getReportResult = () => Promise.resolve({ ...result });
    const p = c2._loadHistoryFor('S12', true); await flush();
    activate(c2, 'S13', 'CHAT'); c2._forgetSession('S12');
    got.resolve({ tasks: [], artifacts: [{ artifactId: 'LATE', type: 'REPORT_RESULT', createdAt: '20261025170001' }] });
    await p;
    assert.equal(c2._sessionMessageState('S12'), undefined);
    assert.ok(!msgs(c2).some((e) => e.artifactId === 'LATE'));
  });

  /* ---------------- ChatService：Tasks / TaskContext 的调用与解析 ---------------- */
  console.log('\n━━ ChatService · 会话结果索引');
  const svcReg = {
    'sap/base/Log': { error() {}, warning() {}, info() {}, debug() {} },
    'sap/ui/model/odata/v2/ODataModel': function () {}, 'sap/ui/model/Filter': function () {},
    'sap/ui/model/FilterOperator': {}, 'sap/ui/model/Sorter': function () {}
  };
  let fetchLog = [], fetchQueue = [];
  fakeWindow.fetch = (url, init) => {
    fetchLog.push({ url, init: init || {} });
    const r = fetchQueue.shift();
    if (!r) { return Promise.reject(new Error('fetch 队列为空: ' + url)); }
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null },
      json: () => Promise.resolve(r.json), text: () => Promise.resolve(r.text || JSON.stringify(r.json || {})) });
  };
  const fi = (name, success, result, message) => ({ status: 200, json: { d: { [name]: { Success: success ? 'X' : '', Message: message || '', ResultJson: result === undefined ? '' : JSON.stringify(result) } } } });
  const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  function extend(...args) {
    const deep = args[0] === true;
    if (typeof args[0] === 'boolean') { args.shift(); }
    const target = args.shift() || {};
    args.forEach((src) => Object.keys(src || {}).forEach((k) => {
      const v = src[k];
      if (deep && isPlain(v)) { target[k] = extend(true, isPlain(target[k]) ? target[k] : {}, v); }
      else if (deep && Array.isArray(v)) { target[k] = extend(true, [], v); }
      else if (v !== undefined) { target[k] = v; }
    }));
    return target;
  }
  function loadSvc(name) {
    if (svcReg[name]) { return svcReg[name]; }
    let out;
    const file = path.join(WEBAPP, name.replace('zai/chat/', '') + '.js');
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      sap: { ui: { define: (deps, fn) => { out = fn(...deps.map(loadSvc)); } } },
      console, Promise, Date, RegExp, Math, JSON, Object, Array, String, Number, Error, Uint8Array,
      setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, unescape, escape, URLSearchParams,
      parseInt, isNaN, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      jQuery: { extend }, window: fakeWindow, fetch: (u, i) => fakeWindow.fetch(u, i)
    }, { filename: file });
    return (svcReg[name] = out);
  }
  const svc = loadSvc('zai/chat/service/ChatService');
  svc.setConfig({ mode: 'backend', host: '', path: '/p/' });
  svc._sCsrfToken = 'T0';

  const ctx = (arts) => ({ current_task: { id: 'x' }, artifacts: arts, recent_messages: [] });
  await test('Tasks 大写键补小写；TaskContext 的结果只留报表 / Fiori、可用、去重、按登记时间排序', async () => {
    fetchLog = []; fetchQueue = [
      fi('Tasks', true, [{ TASK_ID: 'T2', MODULE_ID: 'FIORI', STATUS: 'COMPLETED', CHANGED_AT: '20261025120000' }, { TASK_ID: 'T1', MODULE_ID: 'REPORT', STATUS: 'COMPLETED' }]),
      fi('TaskContext', true, ctx([
        { ARTIFACT_ID: 'F1', ARTIFACT_TYPE: 'FIORI_RESULT', STATUS: 'AVAILABLE', DISPLAY_LABEL: 'shipment', ROW_COUNT: 3, CREATED_AT: '20261025113000', SOURCE_REF: 'FRUN1' },
        { ARTIFACT_ID: 'D1', ARTIFACT_TYPE: 'TABLE_DATA', STATUS: 'AVAILABLE', CREATED_AT: '20261025113100' }])),
      fi('TaskContext', true, ctx([
        { ARTIFACT_ID: 'R1', ARTIFACT_TYPE: 'REPORT_RESULT', STATUS: 'AVAILABLE', CREATED_AT: '20261025110000', REPORT_RUN_ID: 'RUN1', DATASET_ID: 'RUN1' },
        { ARTIFACT_ID: 'R0', ARTIFACT_TYPE: 'REPORT_RESULT', STATUS: 'EXPIRED', CREATED_AT: '20261025100000' },
        { ARTIFACT_ID: 'F1', ARTIFACT_TYPE: 'FIORI_RESULT', STATUS: 'AVAILABLE', CREATED_AT: '20261025113000' }]))];
    const r = await svc.getSessionResults('S1');
    assert.ok(/\/p\/Tasks\?SessionId='S1'$/.test(fetchLog[0].url), fetchLog[0].url);
    assert.ok(/\/p\/TaskContext\?SessionId='S1'&TaskId='T2'$/.test(fetchLog[1].url), fetchLog[1].url);
    assert.ok(fetchLog.every((f) => f.init.method === 'GET'));
    assert.equal(r.tasks[0].task_id, 'T2'); assert.equal(r.tasks[0].TASK_ID, 'T2');
    assert.equal(JSON.stringify(r.artifacts.map((a) => a.artifactId)), '["R1","F1"]');
    assert.equal(r.artifacts[0].runId, 'RUN1'); assert.equal(r.artifacts[1].runId, 'FRUN1');
    assert.equal(r.artifacts[1].label, 'shipment'); assert.equal(r.artifacts[1].rowCount, 3);
  });

  await test('任务层未开启 / TaskContext 失败：返回空结果，不抛错', async () => {
    fetchLog = []; fetchQueue = [fi('Tasks', false, undefined, '任务上下文能力未开启')];
    let r = await svc.getSessionResults('S1');
    assert.equal(r.artifacts.length, 0); assert.equal(fetchLog.length, 1);
    fetchLog = []; fetchQueue = [fi('Tasks', true, [{ TASK_ID: 'T1' }]), { status: 500, text: 'boom' }];
    r = await svc.getSessionResults('S1');
    assert.equal(r.artifacts.length, 0); assert.equal(r.tasks.length, 1);
  });

  await test('最多看最近 RESTORE_MAX_TASKS 个任务', async () => {
    const aT = Array.from({ length: 15 }, (_, i) => ({ TASK_ID: 'T' + i }));
    fetchLog = []; fetchQueue = [fi('Tasks', true, aT)].concat(Array.from({ length: 12 }, () => fi('TaskContext', true, ctx([]))));
    await svc.getSessionResults('S1');
    assert.equal(fetchLog.length, 1 + svc.RESTORE_MAX_TASKS);
  });

  await test('演示模式：Fiori 取数结果存本机，「刷新」（重新加载服务）后还能按会话列出并重读', async () => {
    svc.setConfig({ mode: 'mock' });
    storage.removeItem('zaiChat.mockFiori.v1');
    svc._oFioriMock = null;
    const oRes = svc._mockFioriRun({ SessionId: 'MS1', ReportId: 'SHIPMENT', ParamsJson: '{"DIM":"SHMODE","DATE":"20261001,20261025"}', ClientRequestId: 'CR1' });
    assert.ok(oRes.artifactId);
    svc._oFioriMock = null;   // 模拟刷新：内存状态丢了，只剩 localStorage
    const a = svc._mockFioriArtifacts('MS1');
    assert.equal(a.length, 1); assert.equal(a[0].artifactId, oRes.artifactId); assert.equal(a[0].type, 'FIORI_RESULT');
    assert.ok(/^\d{14}$/.test(a[0].createdAt));
    const again = await svc.getFioriReportResult(oRes.artifactId);
    assert.equal(again.rowsJson, oRes.rowsJson);
    assert.equal(svc._mockFioriRun({ SessionId: 'MS1', ReportId: 'SHIPMENT', ParamsJson: '{}', ClientRequestId: 'CR1' }).artifactId, oRes.artifactId, '幂等仍成立');
    assert.equal(svc._mockFioriArtifacts('OTHER').length, 0);
    const r = await svc.getSessionResults('MS1');
    assert.equal(r.artifacts.length, 1);
  });

  console.log(`\n━━ 结果：${passed} 通过，0 失败`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
