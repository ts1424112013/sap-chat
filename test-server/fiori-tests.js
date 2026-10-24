/**
 * 报表目录 + Fiori 报表分析 —— 前端契约与演示模式语义测试（无网络、无 SAP）
 * 运行: node fiori-tests.js   （或 npm run test:fiori）
 *
 * 覆盖：
 *   1) utils/ReportCatalog 纯函数：过滤 / 分类计数 / 行 HTML（转义、停用）/ 整体 HTML 各状态
 *   2) CatalogPanel 字段映射：ReportDefinitions 的大写键、FioriReportDefs 的 camelCase
 *   3) ChatService 对后端的调用约定：ReportDefinitions / FioriReportDefs / RunFioriReport / FioriReportResult
 *   4) FioriMockBackend 语义（与 ZCL_AI_ODATA_SHAPER / ZCL_AI_FIORI_REPORT_SERVICE 同口径，期望值与
 *      SE38 ZAI_TEST_ODATA_INTERNAL / ZAI_FRPT_MAINT 的离线自测一致）：清洗、FLAT / PIVOT / EXPAND、
 *      $filter、统计、Agent 一轮（选择报表 → 参数卡、闸门、分析、重跑、找报表）、幂等
 *   5) AskCard 的 ENUM、分析闸门 HTML、场景列表
 * ABAP 本身只能在 SAP 上验证，见 backend-abap/00_对象清单与部署顺序_20261019.md 第七节。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEBAPP = path.join(__dirname, '../webapp');
function isPlain(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
function extend() {
  const args = Array.prototype.slice.call(arguments);
  const deep = args[0] === true;
  if (typeof args[0] === 'boolean') { args.shift(); }
  const target = args.shift() || {};
  args.forEach(function (src) {
    Object.keys(src || {}).forEach(function (k) {
      const v = src[k];
      if (deep && isPlain(v)) { target[k] = extend(true, isPlain(target[k]) ? target[k] : {}, v); }
      else if (deep && Array.isArray(v)) { target[k] = extend(true, [], v); }
      else if (v !== undefined) { target[k] = v; }
    });
  });
  return target;
}
function memStore() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}
const fakeWindow = { sessionStorage: memStore(), localStorage: memStore(), setTimeout, clearTimeout };

let fetchLog = [];
let fetchQueue = [];
function fakeFetch(url, init) {
  fetchLog.push({ url: url, init: init || {} });
  const r = fetchQueue.shift();
  if (!r) { return Promise.reject(new Error('fetch 队列为空: ' + url)); }
  const headers = r.headers || {};
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300, status: r.status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: () => Promise.resolve(r.json),
    text: () => Promise.resolve(r.text || (r.json ? JSON.stringify(r.json) : ''))
  });
}
function resetFetch(queue) { fetchLog = []; fetchQueue = queue.slice(); }

/** UI5 控件垫片：只够模块加载（纯函数测试不渲染） */
function Ctl(o) { this.o = o || {}; this.d = {}; }
Ctl.prototype.setContent = function (s) { this.o.content = s; return this; };
Ctl.prototype.getContent = function () { return this.o.content; };
Ctl.prototype.attachAfterRendering = function () { return this; };
Ctl.prototype.getDomRef = function () { return null; };
Ctl.prototype.data = function (k, v) { if (v === undefined) { return this.d[k]; } this.d[k] = v; return this; };
Ctl.prototype.addStyleClass = function () { return this; };

const registry = {
  'sap/base/Log': { error() {}, warning() {}, info() {}, debug() {} },
  'sap/ui/model/odata/v2/ODataModel': function () {}, 'sap/ui/model/Filter': function () {},
  'sap/ui/model/FilterOperator': {}, 'sap/ui/model/Sorter': function () {},
  'sap/ui/core/HTML': Ctl, 'sap/m/MessageToast': { show() {} },
  'sap/m/VBox': Ctl, 'sap/m/HBox': Ctl, 'sap/m/Text': Ctl, 'sap/m/Label': Ctl, 'sap/m/Input': Ctl,
  'sap/m/DatePicker': Ctl, 'sap/m/Button': Ctl, 'sap/m/ToggleButton': Ctl, 'sap/ui/core/Icon': Ctl
};
function load(name) {
  if (registry[name]) { return registry[name]; }
  const file = path.join(WEBAPP, name.replace(/^zai\/chat\//, '') + '.js');
  let out;
  const sandbox = {
    sap: { ui: { define: (deps, fn) => { out = fn.apply(null, deps.map(load)); } } },
    console, Promise, Date, RegExp, Math, JSON, Object, Array, String, Number, Error, Uint8Array,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, unescape, escape, URLSearchParams,
    parseInt, isNaN, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    jQuery: { extend: extend }, window: fakeWindow, fetch: (u, i) => fakeFetch(u, i)
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  registry[name] = out;
  return out;
}

/** i18n：读真实 i18n.properties（文案改了测试也跟着走） */
const I18N = {};
fs.readFileSync(path.join(WEBAPP, 'i18n/i18n.properties'), 'utf8').split(/\r?\n/).forEach((l) => {
  const m = /^([A-Za-z0-9_.]+)=(.*)$/.exec(l);
  if (m) { I18N[m[1]] = m[2]; }
});
const rb = {
  getText: (k, a) => String(I18N[k] === undefined ? k : I18N[k]).replace(/\{(\d+)\}/g, (s, i) => (a && a[+i] !== undefined ? a[+i] : s))
};

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function rejects(name, promise, re) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  check(name, err && re.test(err.message), err ? err.message : '没有抛错');
  return err;
}

(async () => {
  /* ---------------- 1) ReportCatalog ---------------- */
  console.log('\n━━ ReportCatalog 纯函数');
  const RC = load('zai/chat/utils/ReportCatalog');
  const items = [
    { id: 'A', title: 'shipment報表', code: '', desc: '出货透视', category: '销量分析', keywords: 'ship mode,出货', paramCount: 4 },
    { id: 'B', title: '订单未交明细', code: '', desc: '未交数量', category: '销量分析', paramCount: 1 },
    { id: 'C', title: '采购未清报表', code: '', desc: '未清 PO', category: '采购', paramCount: 1 },
    { id: 'D', title: 'MIH 需求报表', code: 'ZDPMM702', desc: '按工厂汇总', paramCount: 2, disabled: true, disabledText: '暂未开放' }
  ];
  check('不分大小写匹配报表名', RC.filterItems(items, 'SHIPMENT').map((i) => i.id).join() === 'A');
  check('匹配 TCode', RC.filterItems(items, '702').map((i) => i.id).join() === 'D');
  check('匹配关键词与说明', RC.filterItems(items, '出货').map((i) => i.id).join() === 'A' && RC.filterItems(items, '未清').map((i) => i.id).join() === 'C');
  check('分类过滤 + 搜索叠加', RC.filterItems(items, '', '销量分析').length === 2 && RC.filterItems(items, '未交', '销量分析').map((i) => i.id).join() === 'B');
  check('搜不到返回空', RC.filterItems(items, 'zzz').length === 0);
  const cnt = RC.countByCategory(items);
  check('分类计数（"" = 全部）', cnt[''] === 4 && cnt['销量分析'] === 2 && cnt['采购'] === 1);
  const evil = RC.rowHtml({ id: 'X"1', title: '<img onerror=1>', code: 'Z&1', desc: '"q"' }, { texts: { pick: '执行' } });
  check('行 HTML 转义报表名 / 代码 / 说明 / id', evil.indexOf('<img') < 0 && evil.indexOf('&lt;img') >= 0 && evil.indexOf('Z&amp;1') >= 0 && evil.indexOf('data-id="X&quot;1"') >= 0);
  const off = RC.rowHtml(items[3], { texts: { pick: '执行', offTip: '未开放' } });
  check('停用行：off 样式、aria-disabled、没有执行按钮、显示暂未开放', /class="catRow off"/.test(off) && /aria-disabled="true"/.test(off) && off.indexOf('catPick') < 0 && off.indexOf('暂未开放') >= 0);
  const T = { title: '报表目录', loading: '加载中', loadFail: '加载失败', retry: '重试', empty: '没有报表', noMatch: '无匹配', all: '全部', searchPh: '搜' };
  check('加载中状态', RC.html({ texts: T }, { status: 'loading', items: [] }).indexOf('加载中') >= 0);
  const errHtml = RC.html({ texts: T }, { status: 'error', items: [], message: '报表目录加载失败：HTTP 500' });
  check('失败状态：显示原因 + 重试按钮', errHtml.indexOf('HTTP 500') >= 0 && errHtml.indexOf('catRetry') >= 0);
  check('空清单：显示后端说明（如能力未开启）', RC.html({ texts: T }, { status: 'ready', items: [], message: '报表读取能力未开启' }).indexOf('报表读取能力未开启') >= 0);
  const tabs = RC.html({ texts: T, categories: ['销量分析', '采购', '生产'] }, { status: 'ready', items: items.slice(0, 3), query: '', category: '' });
  check('分类页签：全部 + 有报表的分类（没有报表的"生产"不显示）', /data-cat=""[^>]*>全部 <small>3/.test(tabs) && tabs.indexOf('data-cat="采购"') >= 0 && tabs.indexOf('data-cat="生产"') < 0);
  check('「全部」页签按分类分组', (tabs.match(/class="catGroup"/g) || []).length === 2);
  const one = RC.html({ texts: T, categories: ['销量分析', '采购'] }, { status: 'ready', items: items.slice(0, 3), query: '', category: '采购' });
  check('选中某个分类时不分组、行上显示分类标签', one.indexOf('catGroup') < 0 && one.indexOf('class="biz"') >= 0);
  const TF = Object.assign({ count: '共 {0} 张', expand: '展开', collapse: '收起' }, T);
  const mini = RC.html({ texts: TF, collapsible: true }, { status: 'ready', items: items.slice(0, 3), collapsed: true });
  check('收起态：只有胶囊（catToggle + 张数），不渲染 .catalog 与报表行', mini.indexOf('catalogMini') >= 0 && mini.indexOf('catToggle') >= 0 && mini.indexOf('共 3 张') >= 0 && mini.indexOf('class="catalog"') < 0 && mini.indexOf('catRow') < 0);
  const open = RC.html({ texts: TF, collapsible: true }, { status: 'ready', items: items.slice(0, 3), collapsed: false });
  check('展开态：完整目录 + 标题栏收起按钮', open.indexOf('class="catalog"') >= 0 && open.indexOf('catFold') >= 0 && (open.match(/class="catRow/g) || []).length === 3);
  check('不可收起时忽略 collapsed、也没有收起按钮', RC.html({ texts: TF }, { status: 'ready', items: items.slice(0, 3), collapsed: true }).indexOf('catFold') < 0 && RC.html({ texts: TF }, { status: 'ready', items: items.slice(0, 3), collapsed: true }).indexOf('catRow') >= 0);

  /* ---------------- 2) CatalogPanel 映射 ---------------- */
  console.log('\n━━ CatalogPanel 字段映射');
  const CP = load('zai/chat/controller/mixin/CatalogPanel');
  const ctx = Object.assign({ _rb: () => rb }, CP);
  let it = ctx._catReportItem({ REPORT_ID: 'ZDPMM702', TCODE: 'ZDPMM702', NAME: 'MIH 需求报表', DESCRIPTION: 'x', EXEC_ENABLED: 'X', PARAMS: [{}, {}] });
  check('ReportDefinitions 大写键 → 目录行', it.id === 'ZDPMM702' && it.code === 'ZDPMM702' && it.title === 'MIH 需求报表' && it.paramCount === 2 && it.disabled === false && it.badges[0] === I18N.catBadgeJob);
  it = ctx._catReportItem({ report_id: 'R2', tcode: 'ZX01', name: 'n', params: [] });
  check('小写键也认；exec_enabled 为空 → 停用 + 暂未开放', it.code === 'ZX01' && it.disabled === true && it.disabledText === I18N.catOff);
  it = ctx._catFioriItem({ reportId: 'SHIPMENT', reportName: 'shipment報表', category: '销量分析', keywords: 'k', description: 'd', params: [{}, {}, {}] });
  check('FioriReportDefs camelCase → 目录行', it.id === 'SHIPMENT' && it.title === 'shipment報表' && it.category === '销量分析' && it.paramCount === 3 && !it.disabled);
  check('点选发出的文字', rb.getText('catSendReport', ['ZDPMM702']) === '执行 ZDPMM702' && rb.getText('catSendFiori', ['shipment報表']) === '选择报表：shipment報表');
  check('有目录的场景只有报表执行和 Fiori 报表', ctx._catScene('REPORT') && ctx._catScene('FIORI') && !ctx._catScene('DATA') && !ctx._catScene('AUTO'));

  /* ---------------- 2b) 20261024：报表执行目录按模块分类（10.24 记录 #01） ---------------- */
  console.log('\n━━ 报表执行目录 · 模块分类');
  check('事务码 ZDP + 模块：ZDPMM702 / ZDPSD012 / ZDPPP123', RC.moduleOf('ZDPMM702') === 'MM' && RC.moduleOf('ZDPSD012') === 'SD' && RC.moduleOf('ZDPPP123') === 'PP');
  check('事务码 Z + 模块：ZFI001 / zmm05（不分大小写、去空格）', RC.moduleOf('ZFI001') === 'FI' && RC.moduleOf(' zmm05 ') === 'MM');
  check('事务码推不出时看程序名：ZRSD_IDP_0022_NEW / ZRMM_IDP_0003C', RC.moduleOf('', 'ZRSD_IDP_0022_NEW') === 'SD' && RC.moduleOf('ZX999', 'ZRMM_IDP_0003C') === 'MM');
  check('登记表显式模块优先（以后加 MODULE 列可人工修正）', RC.moduleOf('ZDPMM702', 'ZRMM_IDP_0702', 'pp') === 'PP');
  check('都推不出返回空串', RC.moduleOf('ZNOTABLE', 'ZTEST_PROG') === '' && RC.moduleOf('', '') === '' && RC.moduleOf(undefined, null) === '');
  check('不把非模块前缀误判（ZDEMO001 / SE16N）', RC.moduleOf('ZDEMO001') === '' && RC.moduleOf('SE16N') === '');
  const mods = [{ id: '1', category: 'SD' }, { id: '2', category: '其他' }, { id: '3', category: 'MM' }, { id: '4', category: 'LE' }, { id: '5', category: 'MM' }, { id: '6', category: 'PP' }];
  check('按模块稳定排序：MM → PP → SD → 其他显式模块 → 「其他」', RC.sortByModule(mods, '其他').map((x) => x.id).join() === '3,5,6,1,4,2');
  check('排序不改原数组', mods.map((x) => x.id).join() === '1,2,3,4,5,6');
  it = ctx._catReportItem({ REPORT_ID: 'R1', TCODE: 'ZDPSD012', PROGNAME: 'ZRSD_IDP_0012', NAME: 'n', EXEC_ENABLED: 'X', PARAMS: [] });
  check('目录行 category = 由事务码推出的模块', it.category === 'SD');
  it = ctx._catReportItem({ REPORT_ID: 'R2', TCODE: '', PROGNAME: 'ZRMM_IDP_0003C', NAME: 'n', PARAMS: [] });
  check('没有事务码按程序名推', it.category === 'MM');
  it = ctx._catReportItem({ REPORT_ID: 'R3', TCODE: 'ZNOTABLE', NAME: 'n', PARAMS: [] });
  check('推不出 → 「其他」', it.category === I18N.catModOther && I18N.catModOther === '其他');
  check('报表执行目录配置 categoryChip，Fiori 不配', ctx._catCfg('REPORT').categoryChip === true && !ctx._catCfg('FIORI').categoryChip);
  const mmOnly = [{ id: 'a', title: 'A', code: 'ZDPMM702', category: 'MM', paramCount: 1 }, { id: 'b', title: 'B', code: 'ZDPMM004A', category: 'MM', paramCount: 2 }];
  const chip = RC.html({ texts: T, categories: null, categoryChip: true }, { status: 'ready', items: mmOnly, query: '', category: '' });
  check('只有一个模块：不出页签，但每行标出模块', chip.indexOf('bizTabs') < 0 && (chip.match(/class="biz"/g) || []).length === 2);
  const multi = RC.html({ texts: T, categories: ['MM', 'SD'], categoryChip: true }, { status: 'ready', items: mmOnly.concat([{ id: 'c', title: 'C', code: 'ZDPSD012', category: 'SD' }]), query: '', category: '' });
  check('多个模块：出页签（全部 3 · MM 2 · SD 1）并分组', /全部 <small>3/.test(multi) && /MM <small>2/.test(multi) && /SD <small>1/.test(multi) && (multi.match(/class="catGroup"/g) || []).length === 2);
  check('搜索词能搜模块名', RC.filterItems(mmOnly.concat([{ id: 'c', title: 'C', category: 'SD' }]), 'sd').map((x) => x.id).join() === 'c');

  /* ---------------- 3) ChatService 对后端的调用约定 ---------------- */
  console.log('\n━━ ChatService · 对后端的调用约定');
  const svc = load('zai/chat/service/ChatService');
  svc.setConfig({ mode: 'backend', host: '', path: '/p/' });
  svc._sCsrfToken = 'T0';

  resetFetch([{ status: 200, json: { d: { ReportDefinitions: { Success: 'X', Message: '', ResultJson: JSON.stringify([{ REPORT_ID: 'ZDPMM702', TCODE: 'ZDPMM702', NAME: 'MIH', EXEC_ENABLED: 'X', PARAMS: [] }]) } } } }]);
  let r = await svc.getReportCatalog();
  check('报表执行目录：GET ReportDefinitions，原样带回大写键', fetchLog[0].init.method === 'GET' && /\/p\/ReportDefinitions$/.test(fetchLog[0].url) && r.defs[0].TCODE === 'ZDPMM702', fetchLog[0].url);
  resetFetch([{ status: 200, json: { d: { ReportDefinitions: { Success: 'X', Message: '报表读取能力未开启(REPORT_READ_ENABLED)', ResultJson: '[]' } } } }]);
  r = await svc.getReportCatalog();
  check('能力未开：空清单 + 后端说明', r.defs.length === 0 && /REPORT_READ_ENABLED/.test(r.message));
  resetFetch([{ status: 500, text: 'boom' }]);
  await rejects('接口失败 → 抛错（目录显示原因 + 重试）', svc.getReportCatalog(), /HTTP 500/);

  resetFetch([{ status: 200, json: { d: { FioriReportDefs: { Success: 'X', Message: '', ResultJson: JSON.stringify({ reports: [{ reportId: 'SHIPMENT', reportName: 's', params: [] }], message: '', error: '' }) } } } }]);
  r = await svc.getFioriReportDefs();
  check('Fiori 目录：GET FioriReportDefs → reports', fetchLog[0].init.method === 'GET' && /\/p\/FioriReportDefs$/.test(fetchLog[0].url) && r.defs[0].reportId === 'SHIPMENT');
  resetFetch([{ status: 200, json: { d: { FioriReportDefs: { Success: 'X', Message: 'Fiori 报表能力未开启(FIORI_ENABLED)', ResultJson: '{"reports":[],"message":"","error":""}' } } } }]);
  r = await svc.getFioriReportDefs();
  check('Fiori 能力未开：空清单 + Message 里的说明', r.defs.length === 0 && /FIORI_ENABLED/.test(r.message));

  resetFetch([{ status: 200, json: { d: { RunFioriReport: { Success: 'X', Message: '已取数 2 行', ResultJson: JSON.stringify({ artifactId: 'A1', runId: 'R1', label: 's', rowCount: 2, rowsJson: '[]', schemaJson: '{"columns":[]}', analyzeEnabled: 'X', analyzed: '', truncated: '', elapsedMs: 800, message: '', error: '' }) } } } }]);
  r = await svc.runFioriReport({ sessionId: 'S1', taskId: 'T1', reportId: 'SHIPMENT', paramsJson: '{"SITE":"HH\'ZZ"}', clientRequestId: 'C1' });
  const c = fetchLog[0];
  check('RunFioriReport 是 POST + CSRF，参数名 SessionId / TaskId / ReportId / ParamsJson / ClientRequestId 都在 URL',
    c.init.method === 'POST' && c.init.headers['x-csrf-token'] === 'T0' && /RunFioriReport\?SessionId='S1'&TaskId='T1'&ReportId='SHIPMENT'&ParamsJson='.*'&ClientRequestId='C1'/.test(c.url) && !c.init.body, c.url);
  check('参数值里的单引号写成两个', /HH''ZZ/.test(decodeURIComponent(c.url)));
  check('成功返回 camelCase 结果，Message 补进 message', r.artifactId === 'A1' && r.rowCount === 2 && r.message === '已取数 2 行');
  resetFetch([{ status: 200, json: { d: { RunFioriReport: { Success: '', Message: '「site」超过 4 位: HHZZZ', ResultJson: '{"error":"「site」超过 4 位: HHZZZ"}' } } } }]);
  await rejects('参数被拒 → 抛后端原话（参数卡保持打开显示错误）', svc.runFioriReport({ sessionId: 'S1', reportId: 'SHIPMENT', clientRequestId: 'C2' }), /超过 4 位/);
  resetFetch([{ status: 200, json: { d: { FioriReportResult: { Success: 'X', ResultJson: '{"artifactId":"A1","rowsJson":"[]"}' } } } }]);
  r = await svc.getFioriReportResult('A1');
  check('FioriReportResult 是 GET，参数 ArtifactId', fetchLog[0].init.method === 'GET' && /FioriReportResult\?ArtifactId='A1'/.test(fetchLog[0].url) && r.artifactId === 'A1');
  check('模型白名单多了 FIORI 键 AGENT_MODELS_FIORI', svc.AGENT_MODEL_KEYS.FIORI === 'AGENT_MODELS_FIORI');

  /* ---------------- 4) 演示模式语义 ---------------- */
  svc.setConfig({ mode: 'mock' });
  resetFetch([]);

  console.log('\n━━ 结构转换（与 ZCL_AI_ODATA_SHAPER 同口径）');
  check('清洗：前导空格', svc._fioriClean('     139418') === '139418');
  check('清洗：千分位', svc._fioriClean('1,234,567.50') === '1234567.50');
  check('清洗：ABAP 尾负号', svc._fioriClean('100-') === '-100');
  check('清洗：/Date(ms)/', svc._fioriClean('/Date(1640995200000)/') === '2022-01-01');
  check('数值列：12.5 是，0045 / 2026-10-01 不是', svc._fioriNumericCol(['12.5', '']) && !svc._fioriNumericCol(['0045']) && !svc._fioriNumericCol(['2026-10-01']));
  const pivotJson = { d: { results: [
    { Name: '202610', Description: '2026-10', Position: '2', DynamicDataSet: { results: [{ Value: '     139418' }, { Value: '      33390' }] } },
    { Name: 'SHMODE', Description: 'Ship Mode', Position: '1', DynamicDataSet: { results: [{ Value: 'D' }, { Value: 'C' }] } }
  ] } };
  let ds = svc._fioriShape(pivotJson, 'PIVOT', {});
  check('PIVOT：按 Position 排列，期间列是数值列', ds.columns.map((x) => x.name).join() === 'SHMODE,202610' && ds.columns[1].numeric === true && ds.columns[0].numeric === false);
  // JS 对象的整数形键（"202610"）总排在前面，按字段比，不比字符串顺序（表格按列清单渲染）
  check('PIVOT：第 1 行 = D / 139418（与 SE38 自测一致）', ds.rows[0].SHMODE === 'D' && ds.rows[0]['202610'] === 139418, JSON.stringify(ds.rows[0]));
  ds = svc._fioriShape({ d: { results: [{ Name: 'A', Position: '1', DynamicDataSet: { results: [{ Value: 'x' }, { Value: 'y' }] } }, { Name: 'B', Position: '2', DynamicDataSet: { results: [{ Value: '1' }] } }] } }, 'PIVOT', {});
  check('PIVOT：列长度不一致 → 报错不硬拼', /列长度不一致/.test(ds.error));
  ds = svc._fioriShape({ d: { results: [
    { __metadata: { type: 'X' }, Werks: '1000', Vbeln: '0045000001', Netwr: '1,200.50', ToItem: { __deferred: {} } },
    { __metadata: { type: 'X' }, Werks: '2000', Vbeln: '0045000002', Netwr: '300.00', ToItem: { __deferred: {} } }
  ] } }, 'FLAT', {});
  check('FLAT：去掉 __metadata / 嵌套；单据号保留前导零；金额去千分位（与 SE38 自测一致）',
    JSON.stringify(ds.rows[0]) === '{"Werks":1000,"Vbeln":"0045000001","Netwr":1200.5}' && ds.columns.length === 3, JSON.stringify(ds.rows[0]));
  ds = svc._fioriShape({ d: { results: [{ Aufnr: '100001', ToItems: { results: [{ Matnr: 'FG1', Qty: '10' }, { Matnr: 'FG2', Qty: '20' }] } }] } }, 'EXPAND',
    { itemList: 'ToItems.results', headerCols: ['Aufnr'], itemCols: ['Matnr', 'Qty'] });
  check('EXPAND：抬头复制到每个行项目', ds.rows.length === 2 && JSON.stringify(ds.rows[1]) === '{"Aufnr":100001,"Matnr":"FG2","Qty":20}');

  console.log('\n━━ 参数 → $filter（与 build_filter 同口径）');
  const defP = { params: [
    { paramId: 'SITE', label: 'site', dataType: 'CHAR', typeLength: 4, multiValue: true, odataProp: 'Site', filterOp: 'IN', valueFmt: 'STRING' },
    { paramId: 'DATE', label: '日期区间', dataType: 'DATE', typeLength: 8, required: true, rangeAllowed: true, odataProp: 'BegDat', odataPropTo: 'EndDat', filterOp: 'BT2', valueFmt: 'DATETIME' }
  ] };
  let f = svc._fioriBuildFilter(defP, { SITE: 'HHZZ, HHCD', DATE: '20261015,20261015' });
  check('IN + BT2（与 ZAI_FRPT_MAINT 自测期望一字不差）',
    f.error === '' && f.filter === "(Site eq 'HHZZ' or Site eq 'HHCD') and BegDat ge datetime'2026-10-15T00:00:00' and EndDat le datetime'2026-10-15T00:00:00'", f.filter + f.error);
  f = svc._fioriBuildFilter(defP, { SITE: "HH'Z", DATE: '20261001,20261031' });
  check('单引号写成两个', f.filter.indexOf("Site eq 'HH''Z'") === 0, f.filter);
  f = svc._fioriBuildFilter(defP, { SITE: 'HHZZZ' });
  check('超长拒绝不截断 + 必填缺失', /超过 4 位/.test(f.error) && /必填/.test(f.error), f.error);
  f = svc._fioriBuildFilter(defP, { DATE: '20260231' });
  check('无效日期 20260231 被拒', /不是有效日期/.test(f.error), f.error);
  f = svc._fioriBuildFilter({ params: [{ paramId: 'DIM', label: '維度', dataType: 'ENUM', multiValue: true, enumJson: [{ key: 'SHMODE' }], filterOp: 'IN' }] }, { DIM: 'XX' });
  check('ENUM 只接受登记的选项', /没有选项 XX/.test(f.error));
  f = svc._fioriBuildFilter({ params: [{ paramId: 'DIM', label: '維度', dataType: 'ENUM', multiValue: true, enumJson: [{ key: 'SHMODE' }] }] }, { DIM: 'SHMODE' });
  check('属性名未确认（odataProp 空）：只校验、不进 $filter', f.error === '' && f.filter === '');

  console.log('\n━━ 后端统计（与 compute_stats 同口径）');
  const st = svc._fioriStats(svc._fioriShape(pivotJson, 'PIVOT', {}));
  check('合计 172808、最大在 D、D 占比 80.68%', st.numeric[0].sum === 172808 && st.numeric[0].maxAt === 'D' && st.top[0].key === 'D' && st.top[0].share === 80.68, JSON.stringify(st));

  console.log('\n━━ Agent 一轮 + 分析闸门（演示模式）');
  const sid = 'S' + Date.now();
  const turn = (q, fid) => svc._fioriTurn({ sessionId: sid, question: q, focusedArtifactId: fid || '' });
  let t = turn('选择报表：shipment報表');
  const pend = JSON.parse(t.pending || '{}');
  check('「选择报表：」→ 参数卡（kind = FIORI，带报表名、参数、默认值）', t.kind === 'CARD' && pend.kind === 'FIORI' && pend.report_id === 'SHIPMENT' && pend.params.length === 4 && pend.values.DIM === 'SHMODE' && /^\d{8},\d{8}$/.test(pend.values.DATE));
  check('待填参数的 ENUM 选项以 JSON 字符串给出（AskCard 直接渲染）', JSON.parse(pend.params[0].enum_json)[0].key === 'SHMODE' && pend.params[0].data_type === 'ENUM');
  t = turn('选择报表：不存在的报表');
  check('报表名不存在 → 确定性说明', t.kind === 'ANSWER' && /没有找到名为「不存在的报表」/.test(t.answer));
  t = turn('今天天气');
  check('无关问题 → 场景说明（列出分类）', t.kind === 'ANSWER' && /当前是「Fiori 报表」场景/.test(t.answer) && /销量分析/.test(t.answer));
  t = turn('出货');
  const AskCard = load('zai/chat/utils/AskCard');
  const det = AskCard.detectChoices(t.answer);
  check('一句话命中多张 → 编号选项，前端识别成选择卡，点选发出「选择报表：…」',
    t.kind === 'ANSWER' && det && det.options.length === 2 && det.options[0].send === '选择报表：shipment報表', t.answer);
  t = turn('采购未清');
  check('只命中一张 → 直接出参数卡', t.kind === 'CARD' && JSON.parse(t.pending).report_id === 'PO_OPEN');

  const run1 = await svc.runFioriReport({ sessionId: sid, taskId: 'T1', reportId: 'SHIPMENT', paramsJson: JSON.stringify({ DIM: 'SHMODE', DATE: '20261015,20261015', SITE: 'HHZZ' }), clientRequestId: 'REQ1' });
  const rows = JSON.parse(run1.rowsJson);
  check('取数：D = 139418、C = 33390（设计 §10 第 5 项的演示版）', rows.length === 2 && rows[0].SHMODE === 'D' && rows[0]['202610'] === 139418 && rows[1]['202610'] === 33390, run1.rowsJson);
  check('请求 URI 带 URL 编码后的 $filter 与 $expand', /\$filter=.*BegDat%20ge%20datetime/.test(run1.requestUri) && /\$expand=DynamicDataSet/.test(run1.requestUri));
  const again = await svc.runFioriReport({ sessionId: sid, taskId: 'T1', reportId: 'SHIPMENT', paramsJson: '{}', clientRequestId: 'REQ1' });
  check('同一 ClientRequestId 重复提交 → 同一结果（幂等）', again.artifactId === run1.artifactId);
  await rejects('site 填 HHZZZ → 被拒，不报语法错', svc.runFioriReport({ sessionId: sid, reportId: 'SHIPMENT', paramsJson: JSON.stringify({ DIM: 'SHMODE', DATE: '20261015,20261015', SITE: 'HHZZZ' }), clientRequestId: 'REQ2' }), /超过 4 位/);

  t = turn('哪个最大', run1.artifactId);
  check('没点「交给模型分析」先问数据 → 闸门提示，不分析', t.kind === 'ANSWER' && /还没有交给模型/.test(t.answer));
  check('此时结果未标记已分析', svc._mockFioriState().runs[run1.artifactId].analyzed === false);
  t = turn(rb.getText('fioriAnalyzeAsk'), run1.artifactId);
  check('点「交给模型分析」（问题 = fioriAnalyzeAsk）→ ANALYZE，结果记 ANALYZED', t.kind === 'ANALYZE' && svc._mockFioriState().runs[run1.artifactId].analyzed === true);
  t = turn('哪个最大', run1.artifactId);
  check('同意之后的追问照常带数据', t.kind === 'ANALYZE');
  t = turn('按 region 再看一次', run1.artifactId);
  check('重跑意图 → 参数卡，预填上次的参数', t.kind === 'CARD' && JSON.parse(t.pending).values.SITE === 'HHZZ' && /重新取数/.test(t.answer));

  const sid2 = sid + 'b';
  const run2 = await svc.runFioriReport({ sessionId: sid2, taskId: 'T2', reportId: 'PO_OPEN', paramsJson: '{"SITE":"1000"}', clientRequestId: 'REQ3' });
  t = svc._fioriTurn({ sessionId: sid2, question: '分析一下这个结果', focusedArtifactId: run2.artifactId });
  check('报表未开放模型分析 → 说"分析一下"也被拒', t.kind === 'ANSWER' && /未开放模型分析/.test(t.answer) && run2.analyzeEnabled === '');
  const r2rows = JSON.parse(run2.rowsJson);
  check('FLAT 演示：尾负号转负数、/Date()/ 转日期', r2rows[0].Menge === -5 && /^2026-10-1\d$/.test(r2rows[0].Eindt), run2.rowsJson);

  const res = await svc.getFioriReportResult(run1.artifactId);
  check('结果重读：与取数时一致', res.artifactId === run1.artifactId && res.rowsJson === run1.rowsJson);
  await rejects('结果不存在 → 抛错', svc.getFioriReportResult('NOPE'), /不存在/);

  const oAg = await svc._mockSendAgent({ sessionId: 'SCN' + Date.now(), question: '选择报表：工单良率日报', scene: 'FIORI' });
  check('演示 Agent：FIORI 会话走 Fiori 一轮，返回任务字段与待填参数', oAg.needsInput === true && oAg.taskModule === 'FIORI' && JSON.parse(oAg.pendingParamsJson).report_id === 'WO_YIELD');

  fakeWindow.localStorage.setItem('zaiChat.cfg.FIORI_ENABLED', '');
  r = await svc.getFioriReportDefs();
  check('FIORI_ENABLED 关闭 → 目录为空 + 说明', r.defs.length === 0 && /FIORI_ENABLED/.test(r.message));
  await rejects('FIORI_ENABLED 关闭 → 取数被拒', svc.runFioriReport({ sessionId: sid, reportId: 'SHIPMENT', paramsJson: '{}', clientRequestId: 'REQ9' }), /未开启/);
  check('FIORI_ENABLED 关闭 → Agent 说明能力未开启', /能力未开启/.test(turn('选择报表：shipment報表').answer));
  fakeWindow.localStorage.removeItem('zaiChat.cfg.FIORI_ENABLED');
  r = await svc.getReportCatalog();
  check('演示模式的报表执行目录：4 张（20261024 加了 ZDPSD012）、一张未开放（大写键）', r.defs.length === 4 && r.defs.filter((d) => d.EXEC_ENABLED !== 'X').length === 1);
  {
    // 20261024：演示 ZDPSD012 的参数定义与后端 get_params 整理后同口径；演示 Agent「执行 ZDPSD012」只给类型
    const d12 = r.defs.filter((d) => d.TCODE === 'ZDPSD012')[0];
    const kinds = d12.PARAMS.map((p) => p.SEL_KIND).join('');
    check('演示 ZDPSD012：有单选组 R ×2、复选框 C ×2，没有 F；R 是 ENUM 带 ENUM_JSON 与默认项', /RR/.test(kinds) && /CC/.test(kinds) && kinds.indexOf('F') < 0 &&
      d12.PARAMS.filter((p) => p.SEL_KIND === 'R').every((p) => p.DATA_TYPE === 'ENUM' && JSON.parse(p.ENUM_JSON).length === 3 && !!p.DEFAULT_VALUE));
    const t12 = await svc._mockReportAgent({ sessionId: 'S12', question: '执行 zdpsd012' });
    const pj = JSON.parse(t12.pendingParamsJson);
    check('演示 Agent「执行 ZDPSD012」→ 参数卡：只带类型（单选组 ENUM、复选框 BOOL），不带选项和默认值（前端补）', t12.needsInput === true && t12.taskModule === 'REPORT' && pj.report_id === 'ZDPSD012' &&
      pj.params.filter((p) => p.data_type === 'ENUM').length === 2 && pj.params.filter((p) => p.data_type === 'BOOL').length === 2 && pj.params.every((p) => p.enum_json === undefined));
    check('演示 Agent：不是「执行 X」的问题交回通用演示（返回 null）', svc._mockReportAgent({ sessionId: 'S12', question: '统计一下出货' }) === null);
    const tNo = await svc._mockReportAgent({ sessionId: 'S12', question: '执行 ZNOPE01' });
    check('演示 Agent：未登记的事务码 → 说明未登记、不出卡片', tNo.needsInput === false && /未登记/.test(tNo.answer) && !tNo.pendingParamsJson);
  }

  /* ---------------- 5) AskCard ENUM / 闸门 HTML / 场景 ---------------- */
  console.log('\n━━ AskCard ENUM、分析闸门、场景列表');
  const pEnum = { param_id: 'DIM', data_type: 'ENUM', multi_value: true, enum_json: '[{"key":"SHMODE","text":"ship mode"},{"key":"REGION","text":"region"}]' };
  check('enum_json 字符串解析成选项', AskCard.enumOptions(pEnum).map((o) => o.key).join() === 'SHMODE,REGION');
  check('坏的 enum_json 不报错，返回空', AskCard.enumOptions({ enum_json: '{bad' }).length === 0);
  check('提交回显用选项文字', AskCard.valueDisplay(pEnum, 'SHMODE,REGION') === 'ship mode、region');
  check('普通参数回显不变（范围 ~，多值 、）', AskCard.valueDisplay({ range_allowed: true }, '20261001,20261031') === '2026-10-01 ~ 2026-10-31');

  {
  // ---- 20261024（10.24 记录 #03a）：报表选择项 + 参数卡排版 ----
  console.log('\n━━ AskCard 报表选择项（单选组 / 复选框 / 固定值）与排版');
  const rPend = [
    { param_id: 'P_PLANT', label: '工廠', required: true, data_type: 'CHAR', multi_value: true },
    { param_id: 'RB_SHIP', label: '出貨狀態', required: false, data_type: 'ENUM' },
    { param_id: 'RB_NODEF', label: '無默認', required: false, data_type: 'ENUM' },
    { param_id: 'P_CANCEL', label: '含取消發票', required: false, data_type: 'BOOL' },
    { param_id: 'P_ERR', label: '只看異常', required: false, data_type: 'BOOL' },
    { param_id: 'P_HID', label: '輸出', data_type: 'CHAR' },
    { param_id: 'S_X', label: '其他', data_type: 'CHAR' }
  ];
  const defP = [
    { PARAM_ID: 'P_PLANT', SEL_KIND: 'S' },
    { PARAM_ID: 'RB_SHIP', SEL_KIND: 'R', DEFAULT_VALUE: 'P_ALL', ENUM_JSON: '[{"key":"P_SHIP","text":"已出貨"},{"key":"P_ALL","text":"全部"}]' },
    { PARAM_ID: 'RB_NODEF', SEL_KIND: 'R', ENUM_JSON: '[{"key":"A1","text":"甲"},{"key":"A2","text":"乙"}]' },
    { PARAM_ID: 'P_CANCEL', SEL_KIND: 'C' },
    { PARAM_ID: 'P_ERR', SEL_KIND: 'C', DEFAULT_VALUE: 'X', HELP_TEXT: '數量不一致的行' },
    { PARAM_ID: 'P_HID', SEL_KIND: 'F' }
  ];
  let mg = AskCard.mergeParamDefs(rPend, defP, {});
  const byId = (id) => mg.params.filter((x) => x.param_id === id)[0];
  check('合并：单选组拿到选项（enum_json）、单选、默认项填进 values', AskCard.enumOptions(byId('RB_SHIP')).map((o) => o.key).join() === 'P_SHIP,P_ALL' && byId('RB_SHIP').multi_value === false && mg.values.RB_SHIP === 'P_ALL');
  check('合并：有默认项的单选组 keep_one（不能点掉），没默认的不 keep 且加「不选 = 程序默认」说明', byId('RB_SHIP').keep_one === true && byId('RB_NODEF').keep_one === false && /程序的默认/.test(byId('RB_NODEF').help_text));
  check('合并：复选框是 BOOL，默认 X 的预先勾上，说明文字带过来', byId('P_ERR').data_type === 'BOOL' && mg.values.P_ERR === 'X' && mg.values.P_CANCEL === undefined && byId('P_ERR').help_text === '數量不一致的行');
  check('合并：定义里 sel_kind = F 的兜底隐藏；目录里没有的参数原样保留', !byId('P_HID') && !!byId('S_X') && mg.params.length === 6);
  mg = AskCard.mergeParamDefs(rPend, defP, { RB_SHIP: 'P_SHIP', P_ERR: '' });
  check('合并：用户已有的值（含取消勾选的空串）不被默认值覆盖', mg.values.RB_SHIP === 'P_SHIP' && mg.values.P_ERR === '');
  check('合并：小写 / camelCase 键的定义也认', AskCard.mergeParamDefs([{ param_id: 'c1', data_type: 'BOOL' }], [{ paramId: 'C1', selKind: 'C', defaultValue: 'X' }], {}).values.c1 === 'X');
  check('复选框回显：X → 是，空 → 否', AskCard.valueDisplay({ data_type: 'BOOL' }, 'X') === '是' && AskCard.valueDisplay({ data_type: 'BOOL' }, '') === '否');
  const mk = (n, o) => Array.from({ length: n }, (_, i) => Object.assign({ param_id: 'O' + i, label: 'O' + i }, o || {}));
  let lay = AskCard.layoutParams([].concat(mk(2, { required: true }), [{ param_id: 'E', data_type: 'ENUM', enum_json: [{ key: 'A' }] }, { param_id: 'B1', data_type: 'BOOL' }], mk(6).map((p, i) => Object.assign(p, { param_id: 'X' + i }))));
  check('排版：单选组 1、平铺 3（必填 2 + 补 1 个选填）、开关 1、折叠 5', lay.enums.length === 1 && lay.shown.length === 3 && lay.bools.length === 1 && lay.more.length === 5 && lay.shown[2].param_id === 'X0');
  lay = AskCard.layoutParams(mk(4));
  check('排版：只有 4 个选填 → 平铺 3 + 剩 1 个不折叠（一起平铺）', lay.shown.length === 4 && lay.more.length === 0);
  lay = AskCard.layoutParams(mk(5));
  check('排版：5 个选填 → 平铺 3、折叠 2', lay.shown.length === 3 && lay.more.length === 2);
  lay = AskCard.layoutParams([{ param_id: 'M', data_type: 'ENUM', multi_value: true, required: true, enum_json: [{ key: 'A' }] }]);
  check('排版：多选 ENUM（Fiori 维度）不放进顶部单选组，按必填 / 选填排', lay.enums.length === 0 && lay.shown.length === 1);
  // 20261024（自动登记）：登记的默认值预填 —— STATIC 原值、TODAY ± n 天；用户已填的不覆盖；记下 default_shown
  const today = new Date(), ymd = (d) => '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  check('defaultValueOf：STATIC 原值、TODAY 0 / -1 / +1、USER 不预填', AskCard.defaultValueOf('STATIC', 'ABG1') === 'ABG1' && AskCard.defaultValueOf('TODAY', '0') === ymd(today) &&
    AskCard.defaultValueOf('TODAY', '-1') === ymd(yest) && AskCard.defaultValueOf('TODAY', '') === ymd(today) && AskCard.defaultValueOf('USER', 'x') === '');
  const mgd = AskCard.mergeParamDefs(
    [{ param_id: 'P_WERKS', label: '工厂' }, { param_id: 'P_DATE', label: '基准日期', data_type: 'DATE' }, { param_id: 'T_DAY1', label: '天数1' }, { param_id: 'S_X', label: 'x' }],
    [{ PARAM_ID: 'P_WERKS', SEL_KIND: 'P', DEFAULT_TYPE: 'STATIC', DEFAULT_VALUE: 'ABG1' }, { PARAM_ID: 'P_DATE', SEL_KIND: 'P', DEFAULT_TYPE: 'TODAY', DEFAULT_VALUE: '-1' },
     { PARAM_ID: 'T_DAY1', SEL_KIND: 'P', DEFAULT_TYPE: 'STATIC', DEFAULT_VALUE: '7' }, { PARAM_ID: 'S_X', SEL_KIND: 'S', DEFAULT_TYPE: 'USER' }],
    { T_DAY1: '9' });
  check('合并：工厂预填 ABG1、基准日期预填昨天、用户已填的天数不覆盖、USER 默认不预填', mgd.values.P_WERKS === 'ABG1' && mgd.values.P_DATE === ymd(yest) && mgd.values.T_DAY1 === '9' && mgd.values.S_X === undefined);
  check('合并：预填的参数带 default_shown（折叠区判断「已填」时不算它）', mgd.params[0].default_shown === 'ABG1' && mgd.params[2].default_shown === undefined);
  }

  const FP = load('zai/chat/controller/mixin/FioriPanel');
  const fctx = Object.assign({ _rb: () => rb }, FP);
  const gLocked = fctx._fioriGateHtml({ uid: 'u1', fiori: { analyzable: true, state: 'locked', artifactId: 'A' } });
  check('闸门（未同意）：提示 + 「交给模型分析」按钮（data-act=fiori-analyze，挂在 data-uid 上）',
    gLocked.indexOf(I18N.fioriGateLocked) >= 0 && /data-act="fiori-analyze"/.test(gLocked) && /data-uid="u1"/.test(gLocked));
  const gSent = fctx._fioriGateHtml({ uid: 'u1', fiori: { analyzable: true, state: 'sent', artifactId: 'A' } });
  check('闸门（已发出）：没有按钮', gSent.indexOf('fiori-analyze') < 0 && gSent.indexOf(I18N.fioriGateSent) >= 0);
  const gOff = fctx._fioriGateHtml({ uid: 'u1', fiori: { analyzable: false, artifactId: 'A' } });
  check('闸门（未开放分析）：没有按钮，说明原因', gOff.indexOf('fiori-analyze') < 0 && gOff.indexOf(I18N.fioriGateOff) >= 0);
  const gNoArt = fctx._fioriGateHtml({ uid: 'u1', fiori: { analyzable: false, artifactId: '' } });
  check('闸门（结果未登记）：说明任务层未开启', gNoArt.indexOf(I18N.fioriGateNoArtifact) >= 0);

  const SM = load('zai/chat/controller/mixin/SceneModels');
  check('场景：有「Fiori 报表」，没有「库存查询」按钮', SM.SCENES.map((s) => s.key).join() === 'REPORT,FIORI,DATA,CODE,AUTO');
  check('旧库存会话按「自动」显示；fiori 识别为 FIORI', SM._normScene('INVENTORY') === 'AUTO' && SM._normScene('fiori') === 'FIORI');
  check('i18n 有新场景文案', !!I18N.sceneFIORI && !!I18N.sceneFIORISub && !!I18N.sceneFIORIPh && !!I18N.taskMod_FIORI);

  console.log(`\n━━ 结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
