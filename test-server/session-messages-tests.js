/** 会话切换回归：真实控制器/卡片逻辑 + UI5 控件垫片，不访问 SAP 或模型。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Control {
  constructor(o = {}) { this.o = o; this.events = {}; this.items = o.items || []; this.d = {}; }
  addStyleClass() { return this; }
  toggleStyleClass() { return this; }
  addItem(o) { this.items.push(o); return this; }
  destroyItems() { this.items = []; }
  setVisible(v) { this.o.visible = v; return this; }
  setValueState(v) { this.o.valueState = v; return this; }
  setText(v) { this.o.text = v; return this; }
  setIcon(v) { this.o.icon = v; return this; }
  setPressed(v) { this.o.pressed = v; return this; }
  getPressed() { return this.o.pressed; }
  getValue() { return this.o.value || ''; }
  attachChange(fn) { this.events.change = fn; return this; }
  attachLiveChange(fn) { this.events.liveChange = fn; return this; }
  attachBrowserEvent(k, fn) { this.events[k] = fn; return this; }
  addEventDelegate() { return this; }
  getDomRef() { return null; }
  isDestroyed() { return false; }
  data(k, v) { if (v === undefined) { return this.d[k]; } this.d[k] = v; return this; }
  fire(k, v) {
    if (k === 'press') { this.o.pressed = v; }
    // Input.liveChange 默认不更新 value 属性，测试必须使用事件值。
    if (k === 'change') { this.o.value = v; }
    const fn = this.events[k] || this.o[k];
    fn({ getParameter: (n) => n === 'pressed' ? this.o.pressed : v, getSource: () => this, target: { value: v } });
  }
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
function load(name) {
  if (registry[name]) { return registry[name]; }
  if (name.startsWith('sap/')) { return Control; }
  let out;
  const file = path.join(__dirname, '../webapp', name.replace('zai/chat/', '') + '.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    sap: { ui: { define: (deps, fn) => { out = fn(...deps.map(load)); } } },
    console, Object, Array, JSON, Date, Promise, setTimeout: () => 1,
    window: { setTimeout: () => 1, clearTimeout() {}, clearInterval() {} },
    jQuery: { extend: Object.assign }
  }, { filename: file });
  return (registry[name] = out);
}
const App = load('zai/chat/controller/App.controller');
const AskCard = load('zai/chat/utils/AskCard');
class Model {
  constructor(data) { this.data = data; }
  getProperty(p) { return p.split('/').filter(Boolean).reduce((o, k) => o && o[k], this.data); }
  setProperty(p, v) {
    const keys = p.split('/').filter(Boolean), last = keys.pop();
    const o = keys.reduce((o, k) => o[k] || (o[k] = {}), this.data);
    o[last] = v;
  }
}
function controller() {
  const models = {
    chat: new Model({ messages: [], currentSession: {}, currentTask: null, workspaceMode: 'AGENT' }),
    settings: new Model({}), session: new Model({})
  };
  let next = 0;
  return Object.assign(Object.create(App), {
    getView: () => ({ getModel: (k) => models[k] }), models, _mModeSession: {},
    _newSessionId: () => String(++next).padStart(32, '0').split('').reverse().join(''),
    _rb: () => ({ getText: (k, args) => k + (args ? ':' + args.join(',') : '') }),
    _persistSettings() {}, _applySessionModel() {}, _setSendBtnBusy() {},
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
const flush = () => new Promise((r) => setImmediate(r));
function allControls(host) { return [host, ...host.items.flatMap(allControls)]; }
function render(ask) { const host = new Control(); AskCard.render(host, ask, () => {}); return allControls(host); }
const result = { schemaJson: '{"columns":[{"name":"Q","label":"数量"}]}', rowsJson: '[[12],[34]]', rowCount: 2 };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✅ ' + name); }

(async () => {
  await test('首页问候在同一页面同步时不变；换模式或新建会话时抽下一组', () => {
    const c = controller();
    activate(c, 'HOME1', 'CHAT');
    c.models.chat.setProperty('/workspaceMode', 'CHAT');
    c._syncHeroGreeting();
    const first = c._oHeroGreeting;
    c._syncHeroGreeting();
    assert.equal(c._oHeroGreeting, first);
    c.models.chat.setProperty('/workspaceMode', 'AGENT');
    c._syncHeroGreeting();
    assert.notEqual(c._oHeroGreeting.key, first.key);
    const second = c._oHeroGreeting;
    activate(c, 'HOME2');
    c._syncHeroGreeting();
    assert.notEqual(c._oHeroGreeting.key, second.key);
  });

  await test('Fiori / 报表参数先到时，消息重建仍等正文结束才显示，也不抢焦点或滚动', () => {
    for (const fiori of [true, false]) {
      const c = controller(); activate(c, 'A');
      c.models.i18n = { getResourceBundle: c._rb };
      const e = add(c, '正在说明取数范围');
      e.copyable = false;
      e.streaming = true;
      e.ask = c._paramAsk({ taskId: 'T', reportId: 'R', module: fiori ? 'FIORI' : 'REPORT' },
        fiori ? { kind: 'FIORI', report_id: 'R', values: { P: '1000' } } : {}, [{ param_id: 'P', label: '工厂' }], 'A');
      e.ask.autoFocus = true; // 旧会话或其他入口留下的自动聚焦也必须被统一关掉。
      c.msgItemFactory('timing', { getObject: () => e });
      const host = c._mAskHosts[e.uid];
      assert.equal(host.o.visible, false);
      assert.equal(host.items.length, 0);
      e.streaming = false;
      for (const flag of ['waiting', 'requestPending']) {
        e[flag] = true;
        App._renderAsk.call(c, e.uid);
        assert.equal(host.o.visible, false);
        e[flag] = false;
      }
      let scrolls = 0;
      c._isNearBottom = () => true; c._scrollToBottom = () => { scrolls++; };
      App._renderAsk.call(c, e.uid);
      assert.equal(host.o.visible, true);
      assert.ok(host.items.length > 0);
      assert.equal(e.ask.autoFocus, false);
      assert.equal(scrolls, 0);
      if (fiori) { assert.equal(e.ask.values.P, '1000'); }
    }
  });
  await test('参数定义异步补齐不会抢在正文前出现，完成后默认值仍然保留', async () => {
    const c = controller(); activate(c, 'A');
    const e = add(c, '说明还没写完'); e.streaming = true;
    e.ask = c._paramAsk({ taskId: 'T', reportId: 'R', module: 'REPORT' }, {}, [{ param_id: 'RB', data_type: 'ENUM' }], 'A');
    const host = new Control({ visible: false }); c._mAskHosts = { [e.uid]: host }; c._renderAsk = App._renderAsk;
    const catalog = deferred(); service.getReportCatalog = () => catalog.promise;
    c._enrichReportAsk(e);
    catalog.resolve({ defs: [{ REPORT_ID: 'R', PARAMS: [{ PARAM_ID: 'RB', SEL_KIND: 'R', DEFAULT_VALUE: 'A', ENUM_JSON: '[{"key":"A"},{"key":"B"}]' }] }] });
    await flush();
    assert.equal(e.ask.values.RB, 'A');
    assert.equal(host.o.visible, false);
    assert.equal(host.items.length, 0);
    e.streaming = false; c._renderAsk(e.uid);
    assert.equal(host.o.visible, true);
    assert.ok(allControls(host).some(o => o.d.key === 'A' && o.o.pressed));
  });
  await test('停止生成后，迟到的参数补齐不会弹卡；历史参数卡无需额外等待', async () => {
    const c = controller(); activate(c, 'A');
    const e = add(c, '已停止'); e.streaming = true;
    e.ask = c._paramAsk({ taskId: 'T', reportId: 'R', module: 'REPORT' }, {}, [{ param_id: 'P' }], 'A');
    const host = new Control({ visible: false }); c._mAskHosts = { [e.uid]: host }; c._renderAsk = App._renderAsk;
    const catalog = deferred(); service.getReportCatalog = () => catalog.promise;
    c._enrichReportAsk(e); e.streaming = false; e.avatarStopped = true;
    catalog.resolve({ defs: [{ REPORT_ID: 'R', PARAMS: [{ PARAM_ID: 'P', DEFAULT_VALUE: '1000' }] }] });
    await flush();
    assert.equal(host.o.visible, false);
    const restored = add(c, '先确认下面的条件');
    restored.ask = { kind: 'params', state: 'open', params: [{ param_id: 'P' }], values: { P: '2000' }, options: [] };
    const restoredHost = new Control();
    assert.equal(c._renderEntryAsk(restoredHost, restored), true);
    assert.equal(restoredHost.o.visible, true);
    assert.equal(restored.ask.values.P, '2000');
  });
  await test('参数未提交、未失焦时重建卡片，文本/多值/范围/日期/枚举/自由输入都保留', () => {
    const ask = { kind: 'params', state: 'open', options: [], values: {}, params: [
      { param_id: 'TXT' }, { param_id: 'MULTI', multi_value: true },
      { param_id: 'RANGE', range_allowed: true }, { param_id: 'DATE', data_type: 'DATE' },
      { param_id: 'ENUM', data_type: 'ENUM', enum_json: [{ key: 'A' }, { key: 'B' }], multi_value: true }
    ] };
    let controls = render(ask);
    const inputs = controls.filter((o) => o.events.liveChange && !o.o.placeholder?.includes('Agent'));
    inputs[0].fire('liveChange', '草稿'); inputs[1].fire('liveChange', 'A，B C');
    inputs[3].fire('liveChange', '2000'); // 只填范围“至”
    controls.find((o) => o.events.input).fire('input', '2026-10-');
    controls.filter((o) => o.d.key).forEach((o) => o.fire('press', true));
    controls.find((o) => o.o.placeholder?.includes('Agent')).fire('liveChange', '稍后按月份看');
    assert.deepEqual(ask.values, { TXT: '草稿', MULTI: 'A，B C', RANGE: ',2000', DATE: '2026-10-', ENUM: 'A,B' });
    controls = render(ask);
    assert.ok(controls.some((o) => o.o.value === '草稿'));
    assert.ok(controls.some((o) => o.o.placeholder === '从' && o.o.value === ''));
    assert.ok(controls.some((o) => o.o.placeholder === '至' && o.o.value === '2000'));
    assert.ok(controls.some((o) => o.o.value === '2026-10-'));
    assert.equal(controls.filter((o) => o.d.key && o.o.pressed).length, 2);
    assert.ok(controls.some((o) => o.o.value === '稍后按月份看'));
    controls.find((o) => o.events.input).fire('change', '20261023');
    assert.equal(ask.values.DATE, '20261023');
  });
  await test('单选枚举重选后只保留新选项，清空输入也会保存', () => {
    const ask = { kind: 'params', values: { T: '旧值', E: 'A' }, params: [{ param_id: 'T' },
      { param_id: 'E', data_type: 'ENUM', enum_json: [{ key: 'A' }, { key: 'B' }] }] };
    const controls = render(ask);
    controls.find((o) => o.events.liveChange && o.o.value === '旧值').fire('liveChange', '');
    controls.find((o) => o.d.key === 'B').fire('press', true);
    assert.deepEqual(ask.values, { T: '', E: 'B' });
  });
  await test('20261024：复选框是开关胶囊（X / 空），单选组有默认时点不掉，选填多时折叠且可展开', () => {
    const ask = { kind: 'params', state: 'open', options: [], values: { RB: 'A' }, params: [
      { param_id: 'W', label: '工厂', required: true },
      { param_id: 'RB', label: '状态', data_type: 'ENUM', keep_one: true, enum_json: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] },
      { param_id: 'C1', label: '含取消', data_type: 'BOOL' },
      ...Array.from({ length: 6 }, (_, i) => ({ param_id: 'O' + i, label: '选填' + i }))
    ] };
    const controls = render(ask);
    const chip = controls.find((o) => o.o.text === '含取消' && o.o.icon === 'sap-icon://accept');
    chip.fire('press', true); assert.equal(ask.values.C1, 'X');
    chip.fire('press', false); assert.equal(ask.values.C1, '');
    const a = controls.find((o) => o.d.key === 'A');
    a.fire('press', false);                       // 点掉唯一选中的 → 恢复选中、值不变
    assert.equal(a.o.pressed, true); assert.equal(ask.values.RB, 'A');
    controls.find((o) => o.d.key === 'B').fire('press', true);
    assert.equal(ask.values.RB, 'B');
    const more = controls.find((o) => /^更多筛选条件（4）/.test(o.o.text || ''));
    assert.ok(more, '应有「更多筛选条件（4）」');   // 必填 1 + 补 2 个选填平铺，剩 4 个折叠
    assert.equal(ask.moreOpen, false);
    more.fire('press'); assert.equal(ask.moreOpen, true); assert.equal(more.o.text, '收起筛选条件');
  });
  await test('20261024：选填项有预填值时折叠区自动展开', () => {
    const ask = { kind: 'params', state: 'open', options: [], values: { O5: '1000' },
      params: Array.from({ length: 6 }, (_, i) => ({ param_id: 'O' + i, label: '选填' + i })) };
    render(ask);
    assert.equal(ask.moreOpen, true);
  });
  await test('20261024：折叠区里只有预填的默认值时不自动展开，用户改过才展开', () => {
    const mk = (vals) => ({ kind: 'params', state: 'open', options: [], values: vals,
      params: Array.from({ length: 6 }, (_, i) => ({ param_id: 'O' + i, label: '选填' + i, default_shown: i === 5 ? '7' : undefined })) });
    const a = mk({ O5: '7' }); render(a); assert.equal(a.moreOpen, false);
    const b = mk({ O5: '9' }); render(b); assert.equal(b.moreOpen, true);
  });
  await test('20261024：TCode 报表参数卡按 ReportDefinitions 补齐选项 / 默认值，固定值不显示，已填的不覆盖', async () => {
    const c = controller(); activate(c, 'A');
    service.getReportCatalog = () => Promise.resolve({ defs: [{ REPORT_ID: 'R1', TCODE: 'ZT1', PARAMS: [
      { PARAM_ID: 'RB', SEL_KIND: 'R', DEFAULT_VALUE: 'P2', ENUM_JSON: '[{"key":"P1","text":"已出货"},{"key":"P2","text":"全部"}]' },
      { PARAM_ID: 'CB', SEL_KIND: 'C', DEFAULT_VALUE: 'X' }, { PARAM_ID: 'HID', SEL_KIND: 'F' }] }] });
    const e = add(c, '参数');
    e.ask = { kind: 'params', state: 'open', reportId: 'R1', tcode: 'ZT1', values: { W: '1000' }, params: [
      { param_id: 'W', label: '工厂', required: true }, { param_id: 'RB', label: '状态', data_type: 'ENUM' },
      { param_id: 'CB', label: '含取消', data_type: 'BOOL' }, { param_id: 'HID', label: '输出' }] };
    c._enrichReportAsk(e); await flush();
    assert.equal(JSON.stringify(e.ask.params.map((p) => p.param_id)), '["W","RB","CB"]');   // 沙箱里的数组跨 realm，用 JSON 比
    assert.equal(JSON.stringify(e.ask.values), '{"W":"1000","RB":"P2","CB":"X"}');
    assert.equal(AskCard.enumOptions(e.ask.params[1]).length, 2);
    // 卡片已提交 / 目录里没有这张报表 → 不动
    const e2 = add(c, '参数2'); e2.ask = { kind: 'params', state: 'done', reportId: 'R1', values: {}, params: [{ param_id: 'RB', data_type: 'ENUM' }] };
    c._enrichReportAsk(e2); await flush();
    assert.equal(e2.ask.params[0].enum_json, undefined);
    const e3 = add(c, '参数3'); e3.ask = { kind: 'params', state: 'open', reportId: 'NOPE', values: {}, params: [{ param_id: 'RB', data_type: 'ENUM' }] };
    c._enrichReportAsk(e3); await flush();
    assert.equal(e3.ask.params[0].enum_json, undefined);
  });
  await test('A→B→A 保留原 uid、输入卡、数据表、图表、步骤条，恢复时不重读覆盖', async () => {
    const c = controller(); activate(c, 'A');
    const e = add(c, '填参数');
    Object.assign(e, { ask: { values: { P: '1000' } }, analysis: { datasets: [result] }, userCharts: [{ id: 'c1' }], extraHtml: '<table/>', runHtml: '步骤条' });
    c.models.chat.setProperty('/currentTask', { taskId: 'T' });
    activate(c, 'B', 'CHAT'); const b = add(c, '其他对话');
    activate(c, 'A');
    service.getHistory = () => { throw new Error('缓存会话不应该回读'); };
    await c._loadHistoryFor('A', true);
    assert.equal(c.models.chat.getProperty('/messages/0'), e);
    assert.equal(c.models.chat.getProperty('/currentTask/taskId'), 'T');
    assert.equal(e.ask.values.P, '1000'); assert.equal(e.runHtml, '步骤条');
    assert.equal(e.userCharts[0].id, 'c1'); assert.equal(e.extraHtml, '<table/>');
    activate(c, 'B', 'CHAT'); assert.equal(c.models.chat.getProperty('/messages/0'), b);
  });
  await test('两个会话同时执行报表，后台完成只写原会话，切回来有步骤条和可操作数据表', async () => {
    const c = controller(), statuses = { RA: deferred(), RB: deferred() }, artifact = deferred();
    service.getReportRunStatus = (id) => statuses[id].promise;
    service.getReportResult = () => artifact.promise;
    activate(c, 'A'); const a = add(c, '执行A'); c._trackRun(a.uid, 'RA', 'A');
    assert.equal(a.runPhase, 'active');
    activate(c, 'B'); const b = add(c, '执行B'); c._trackRun(b.uid, 'RB', 'B');
    statuses.RA.resolve({ status: 'READY', artifactId: 'ART-A' }); await flush();
    assert.ok(a.runHtml.includes('run-ready'));
    assert.equal(a.runPhase, 'ready');
    assert.equal(c.models.chat.getProperty('/messages/0/runPhase'), 'active');
    assert.ok(c._mRuns.RB.timer); // B 不会中断 A，A 完成也不会停止 B
    artifact.resolve(result); await flush();
    assert.equal(c.models.chat.getProperty('/messages').length, 1);
    assert.equal(c.models.chat.getProperty('/messages/0'), b);
    assert.equal(c._mFocusArt.A, 'ART-A');
    activate(c, 'A');
    const messages = c.models.chat.getProperty('/messages');
    assert.equal(messages.length, 2);
    assert.equal(messages[1].analysis.datasets[0].rows[1][0], 34);
    assert.ok(messages[1].extraHtml.includes('data-act='));
    await c._loadRunResult(c._mRuns.RA); assert.equal(messages.length, 2);
    statuses.RB.resolve({ status: 'FAILED' }); await flush();
    assert.ok(b.runHtml.includes('run-failed'));
    assert.equal(b.runPhase, 'failed');
  });
  await test('提交请求返回前切走，仍会启动原会话的后台跟踪', async () => {
    const c = controller(), submission = deferred(), status = deferred();
    activate(c, 'A'); const a = add(c, '参数');
    const ask = a.ask = { sessionId: 'A', module: 'REPORT', state: 'open', params: [] };
    service.startReportRun = () => submission.promise;
    service.getReportRunStatus = () => status.promise;
    c._submitReportFromCard(a.uid, ask, { values: {} });
    activate(c, 'B'); add(c, 'B'); submission.resolve({ reportRunId: 'RA' }); await flush();
    assert.equal(ask.state, 'done'); assert.equal(c._mRuns.RA.sessionId, 'A');
    status.resolve({ status: 'FAILED' }); await flush();
  });
  await test('回读被中断的聊天，已有卡片/本地报表结果保留，占位消息换成后端回复', async () => {
    const c = controller(); activate(c, 'A');
    const old = add(c, '已回复'); old.ask = { values: { P: '1000' } };
    const local = c._pushReportResult(result, 'RA');
    add(c, '继续', 'user'); const waiting = add(c, ''); waiting.waiting = waiting.streaming = true;
    activate(c, 'B'); add(c, 'B'); activate(c, 'A');
    service.getHistory = () => Promise.resolve([
      { Role: 'assistant', Content: '已回复' }, { Role: 'user', Content: '继续' }, { Role: 'assistant', Content: '新回复' }
    ]);
    await c._loadHistoryFor('A', true);
    const messages = c.models.chat.getProperty('/messages');
    assert.equal(messages.length, 4); assert.equal(messages[0], old); assert.equal(messages[1], local);
    assert.equal(messages[3].raw, '新回复'); assert.ok(!messages.includes(waiting));
  });
  await test('历史迟到不串会话，读历史期间发送新消息也不会被覆盖', async () => {
    const c = controller(), history = deferred(); activate(c, 'A');
    service.getHistory = () => history.promise;
    const read = c._loadHistoryFor('A', true);
    activate(c, 'B'); const b = add(c, 'B'); history.resolve([{ Role: 'assistant', Content: 'A历史' }]);
    await read; assert.equal(c.models.chat.getProperty('/messages/0'), b);
    activate(c, 'C'); const late = deferred(); service.getHistory = () => late.promise;
    const read2 = c._loadHistoryFor('C', true); const sent = add(c, '刚发送', 'user');
    late.resolve([]); await read2; assert.equal(c.models.chat.getProperty('/messages/0'), sent);
  });
  await test('Fiori 取数时切走，结果和任务完成状态保留在原会话', async () => {
    const c = controller(), response = deferred(); activate(c, 'A');
    const e = add(c, '参数'), ask = e.ask = { sessionId: 'A', taskId: 'T', params: [] };
    c.models.chat.setProperty('/currentTask', { taskId: 'T', module: 'FIORI' });
    service.runFioriReport = () => response.promise;
    c._fioriSubmit(e.uid, ask, { values: {} }); activate(c, 'B'); const b = add(c, 'B');
    response.resolve({ ...result, artifactId: 'F-ART', runId: 'FR', analyzeEnabled: true }); await flush();
    assert.equal(c.models.chat.getProperty('/messages/0'), b);
    activate(c, 'A'); assert.equal(c.models.chat.getProperty('/messages').length, 2);
    assert.equal(c.models.chat.getProperty('/currentTask/status'), 'COMPLETED');
    assert.ok(c.models.chat.getProperty('/messages/1/runHtml').includes('fiori-analyze'));
  });
  await test('删除会话后，迟到的结果不会复活会话或写进当前会话', async () => {
    const c = controller(), artifact = deferred(); activate(c, 'A'); add(c, 'A');
    const run = { sessionId: 'A', runId: 'RA', artifactId: 'ART' };
    service.getReportResult = () => artifact.promise;
    const read = c._loadRunResult(run); activate(c, 'B'); const b = add(c, 'B');
    c._forgetSession('A'); artifact.resolve(result); await read;
    assert.equal(c._sessionMessageState('A'), undefined);
    assert.equal(c.models.chat.getProperty('/messages/0'), b); assert.equal(c._mFocusArt?.A, undefined);
  });
  await test('清空连接/登录缓存后，同编号会话也不会接收旧连接的迟到结果', async () => {
    const c = controller(), artifact = deferred(); activate(c, 'A'); add(c, 'A');
    service.getReportResult = () => artifact.promise;
    const read = c._loadRunResult({ sessionId: 'A', runId: 'RA', artifactId: 'ART' });
    c._clearSessionMessages(); artifact.resolve(result); await read;
    assert.equal(c.models.chat.getProperty('/messages').length, 0);
  });
  await test('20261024：报表结果超过 50 行时聊天里只画 50 行 + 「查看全部 N 行」，数据集仍保留全部行', () => {
    const c = controller(); activate(c, 'A');
    const big = { schemaJson: '{"columns":[{"name":"M","label":"物料"},{"name":"Q","label":"数量"}]}',
      rowsJson: JSON.stringify(Array.from({ length: 120 }, (_, i) => ['M' + i, i])), rowCount: 500 };
    const e = c._pushReportResult(big, 'RBIG');
    assert.equal(e.analysis.datasets[0].rows.length, 120);
    assert.equal(e.analysis.datasets[0].total, 500);
    assert.equal((e.extraHtml.match(/<tr>/g) || []).length, 51);   // 表头 1 + 预览 50
    assert.ok(e.extraHtml.includes('data-act="all"') && e.extraHtml.includes('120'));
    assert.ok(e.extraHtml.includes('500'));                         // 后端共 500 行
    const small = c._pushReportResult(result, 'RSMALL');
    assert.ok(!small.extraHtml.includes('data-act="all"'));
  });
  await test('20261028：边跑边看 —— 进度步骤写进条目、文字转义、标题跟着当前步骤；刚完成的一步带动效', () => {
    const c = controller(); activate(c, 'LIVE');
    c._isNearBottom = () => false;
    const e = add(c, '');
    c._mLive = { [e.uid]: { cid: 'C1', sid: 'LIVE', timer: 0, stopped: false, fails: 0, n: 0, seen: {} } };
    c._applyLive(e.uid, [
      { seq: 1, phase: 'UNDERSTANDING', label: '理解问题', status: 'OK', elapsedMs: 400 },
      { seq: 2, phase: 'TOOL_DECISION', label: '检查可用工具', status: 'OK' },
      { seq: 3, phase: 'NOTE', label: '先查 <script>x</script>', status: 'OK' },
      { seq: 4, phase: 'EXECUTING', toolLabel: '数据分析查询', label: '按类型', status: 'RUNNING', args: [['表', 'MARA']] }
    ], false);
    assert.ok(e.liveHtml.includes('先查 &lt;script&gt;') && !e.liveHtml.includes('<script>'));
    assert.ok(!e.liveHtml.includes('检查可用工具'));          // 工具判断这一步不显示
    assert.ok(e.liveHtml.includes('进行中') && e.liveHtml.includes('lvChipK'));
    assert.equal(e.thinkingLabel, '数据分析查询 · 按类型…');
    c._applyLive(e.uid, e.liveSteps.map((st) => st.seq === 4 ? Object.assign({}, st, {
      status: 'OK', rows: 5, elapsedMs: 600, detail: 'SELECT 1', preview: { columns: ['类型', '数量'], rows: [['FERT', '128']] } }) : st), false);
    assert.ok(e.liveHtml.includes('5 行 · 0.6 秒') && e.liveHtml.includes('<details') && e.liveHtml.includes('class="num"'));
    assert.ok(e.liveHtml.includes('is-done') && !e.liveHtml.includes('is-new'));
  });

  await test('20261028：侧栏转圈 —— 本页没结束的提问 + 后台执行中的报表都算；离开会话不清，结束才撤', () => {
    const c = controller();
    const item = (sid) => ({ sid, cls: new Set(), data(k) { return k === 'sid' ? this.sid : undefined; },
      toggleStyleClass(n, on) { if (on) { this.cls.add(n); } else { this.cls.delete(n); } } });
    const items = [item('A'), item('B'), item('C'), item(undefined)];
    c.byId = (id) => id === 'sessionList' ? { getItems: () => items } : null;
    c._mSessRun = { T1: 'A' };
    c._mRuns = { R1: { sessionId: 'B', timer: -1 }, R2: { sessionId: 'C', timer: null } };
    assert.deepEqual(Object.keys(c._runningSids()).sort(), ['A', 'B']);
    c._syncSessionRunning();
    assert.deepEqual(items.map((i) => i.cls.has('sessItemRunning')), [true, true, false, false]);
    c._releaseBusy();                                  // 切到别的会话：还在跑的照样转
    c._syncSessionRunning();
    assert.ok(items[0].cls.has('sessItemRunning'));
    c._sessRunDone('T1');                              // 这一轮结束
    assert.ok(!items[0].cls.has('sessItemRunning') && items[1].cls.has('sessItemRunning'));
    c._sessRunDone('T1');                              // 迟到的第二次收尾不报错
  });
  await test('20261028：步骤详情只有 SQL 才叫「查看 SQL」，其余叫「查看详情」', () => {
    const c = controller();
    const html = c._liveHtml('U', [
      { seq: 1, phase: 'EXECUTING', label: '模型输出格式不对, 已要求重写', status: 'REJECTED', detail: '输出缺少 action 字段' },
      { seq: 2, phase: 'EXECUTING', label: '按类型', status: 'OK', detail: '  select a from mara' }
    ], {});
    assert.ok(html.includes('<summary>查看详情</summary>') && html.includes('<summary>查看 SQL</summary>'));
  });

  console.log(`\n━━ 结果：${passed} 通过，0 失败`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
