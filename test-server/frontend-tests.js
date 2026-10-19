/**
 * 前端纯逻辑测试（改进清单 PROC-03）—— 无网络、无 UI5 运行时
 * 运行: node frontend-tests.js   （或 npm run test:frontend）
 *
 * 用 vm + sap.ui.define 垫片加载 webapp/ 下的模块（与 agent-eval-tests.js 同一做法），
 * fetch 换成按调用顺序回放的假实现，覆盖：
 *   Formatter（转义 / 白名单清洗 / Markdown）、TraceService.normalizeResult、
 *   ChartRenderer.analyze、ChatService 的 FI 通道（CSRF 重试 FE-01、V8 失败判断 FE-02、
 *   POST 参数位置 FE-08、OData 字符串字面量转义）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEBAPP = path.join(__dirname, '../webapp');

// ---------- 垫片 ----------
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
const memStore = function () {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
};
const fakeWindow = { sessionStorage: memStore(), localStorage: memStore(), setTimeout, clearTimeout };

// fetch 回放：每次调用记录 {url, init}，按队列顺序返回预设响应
let fetchLog = [];
let fetchQueue = [];
function fakeFetch(url, init) {
  fetchLog.push({ url: url, init: init || {} });
  const r = fetchQueue.shift();
  if (!r) { return Promise.reject(new Error('fetch 队列为空: ' + url)); }
  const headers = r.headers || {};
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    json: () => Promise.resolve(r.json),
    text: () => Promise.resolve(r.text || (r.json ? JSON.stringify(r.json) : ''))
  });
}
function resetFetch(queue) { fetchLog = []; fetchQueue = queue.slice(); }

const registry = {
  'sap/base/Log': { error() {}, warning() {}, info() {}, debug() {} },
  'sap/ui/model/odata/v2/ODataModel': function () {},
  'sap/ui/model/Filter': function () {},
  'sap/ui/model/FilterOperator': {},
  'sap/ui/model/Sorter': function () {}
};
function load(name) {
  if (registry[name]) { return registry[name]; }
  const file = path.join(WEBAPP, name.replace(/^zai\/chat\//, '') + '.js');
  let out;
  const sandbox = {
    sap: { ui: { define: (deps, fn) => { out = fn.apply(null, deps.map(load)); } } },
    console, Promise, Date, RegExp, Math, JSON, Object, Array, String, Number, Error, Uint8Array,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, unescape, escape, URLSearchParams,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    jQuery: { extend: extend },
    window: fakeWindow,
    fetch: function (u, i) { return fakeFetch(u, i); }
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  registry[name] = out;
  return out;
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const countOf = (s, sub) => s.split(sub).length - 1;

(async () => {
  const Formatter = load('zai/chat/utils/Formatter');
  const TraceService = load('zai/chat/service/TraceService');
  const ChartRenderer = load('zai/chat/utils/ChartRenderer');
  const ChatService = load('zai/chat/service/ChatService');

  console.log('\n━━ Formatter');
  check('escapeHtml 转义五个字符', Formatter.escapeHtml(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  check('escapeHtml 空值返回空串', Formatter.escapeHtml(null) === '' && Formatter.escapeHtml(undefined) === '');
  const dirty = '<img src="x.png" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">x</a><a href="https://ok">y</a>';
  const clean = Formatter.sanitizeHtml(dirty);
  check('sanitizeHtml 去掉事件属性', !/onerror/i.test(clean), clean);
  check('sanitizeHtml 去掉 script 标签', !/<script/i.test(clean), clean);
  check('sanitizeHtml 拦截 javascript: 链接', !/javascript:/i.test(clean), clean);
  check('sanitizeHtml 保留 https 链接', /href="https:\/\/ok"/.test(clean), clean);
  const md = Formatter.markdownToHtml('说明\n```abap\nDATA lv TYPE i.\n  lv = <1>.\n```');
  check('markdownToHtml 代码块生成 pre 并转义尖括号', /<pre/.test(md) && /&lt;1&gt;/.test(md) && !/<1>/.test(md), md);

  console.log('\n━━ TraceService');
  const norm = TraceService.normalizeResult({ d: { AnalyzeTask: { Answer: 'ok', Status: 'ok', Rounds: '2', TraceJson: '[]' } } });
  check('normalizeResult 剥掉 d.AnalyzeTask 包装', norm.answer === 'ok' && norm.status === 'OK' && norm.rounds === 2, JSON.stringify(norm));

  console.log('\n━━ ChartRenderer');
  const ana = ChartRenderer.analyze({ columns: [{ name: 'M', label: 'Ship Mode' }, { name: 'Q', label: '202610' }], rows: [['D', '139418'], ['C', '33390']] });
  check('analyze：维度列作 X、数值列作 Y、可出图', ana.chartable === true && ana.x === 0 && ana.y[0] === 1, JSON.stringify(ana));
  const one = ChartRenderer.analyze({ columns: [{ name: 'A' }], rows: [['1']] });
  check('analyze：只有一行不出图并给原因', one.chartable === false && /1 行/.test(one.reason));

  console.log('\n━━ ChatService · FI 通道');
  ChatService.setConfig({ mode: 'backend', host: '', path: '/p/' });
  check('_isCsrfFail 识别 statusCode 403', ChatService._isCsrfFail({ statusCode: 403 }) === true);
  check('_isCsrfFail 识别 "HTTP 403 - 响应体"', ChatService._isCsrfFail(new Error('HTTP 403 - CSRF token validation failed')) === true);
  check('_isCsrfFail 不误判 404', ChatService._isCsrfFail(new Error('HTTP 404')) === false);

  // FE-01：令牌失效 → 403 → 换牌重试，第二次 URL 只含一份查询串
  ChatService._sCsrfToken = 'bad';
  resetFetch([
    { status: 403, text: 'CSRF token validation failed' },
    { status: 200, headers: { 'x-csrf-token': 'NEW' }, json: {} },
    { status: 200, json: { d: { StartReportRun: { Success: 'X', Message: '', ResultJson: '{"reportRunId":"R1"}' } } } }
  ]);
  let r = await ChatService._taskCall('StartReportRun', { TaskId: 'T1', ParamsJson: '{"a":1}' }, true);
  const runCalls = fetchLog.filter((c) => /StartReportRun/.test(c.url));
  check('FE-01：403 后自动换牌重试一次', runCalls.length === 2 && /\$metadata/.test(fetchLog[1].url), fetchLog.map((c) => c.url).join(' | '));
  check('FE-01：重试请求的 URL 只有一个 ?', runCalls.length === 2 && countOf(runCalls[1].url, '?') === 1, runCalls[1] && runCalls[1].url);
  check('FE-01：重试请求带新令牌', runCalls.length === 2 && runCalls[1].init.headers['x-csrf-token'] === 'NEW');
  check('FE-01：重试成功后结果正常解析', r.success === true && r.result && r.result.reportRunId === 'R1', JSON.stringify(r));

  // 参数是 OData 字符串字面量：单引号写成两个（与 UI5 ODataModel.callFunction 同口径）
  resetFetch([{ status: 200, json: { d: { Tasks: { Success: 'X', ResultJson: '[]' } } } }]);
  await ChatService._taskCall('Tasks', { SessionId: "O'Brien" }, false);
  check('参数里的单引号写成两个', fetchLog.length === 1 && fetchLog[0].url.indexOf("SessionId='O''Brien'") > 0, fetchLog[0] && fetchLog[0].url);
  check('GET 不带 CSRF 头', fetchLog.length === 1 && !fetchLog[0].init.headers['x-csrf-token']);

  resetFetch([{ status: 500, text: '{"error":{"message":{"value":"内部错误"}}}' }]);
  r = await ChatService._taskCall('Tasks', { SessionId: 'S' }, false);
  check('_taskCall 失败返回 success=false 并带后端原因', r.success === false && /内部错误/.test(r.message), JSON.stringify(r));

  // FE-08：V8 写操作参数改走 URL（不再放 form 正文）
  ChatService._sCsrfToken = 'T0';
  resetFetch([{ status: 200, json: { d: { UpdateSession: { Success: 'X', Message: '已更新', Json: '' } } } }]);
  let v = await ChatService._v8Call('UpdateSession', { SessionId: 'S1', Title: '新名字', Pinned: '' }, true);
  const up = fetchLog[0] || { url: '', init: {} };
  check('FE-08：V8 POST 参数在 URL 里', /UpdateSession\?SessionId='S1'&Title='/.test(up.url) && up.url.indexOf(encodeURIComponent('新名字')) > 0, up.url);
  check('FE-08：V8 POST 不再带 form 正文', up.init.method === 'POST' && !up.init.body, JSON.stringify(up.init));
  check('FE-08：V8 POST 带 CSRF 令牌', up.init.headers && up.init.headers['x-csrf-token'] === 'T0');

  // FE-02：后端失败（Success 为空串）要抛出后端原话
  resetFetch([{ status: 200, json: { d: { SaveUser: { Success: '', Message: 'SU01 中不存在用户 NOBODY，请先在 SAP 创建', Json: '' } } } }]);
  let err = null;
  try { await ChatService._v8Call('SaveUser', { UserId: 'NOBODY' }, true); } catch (e) { err = e; }
  check('FE-02：Success 为空串时抛错并带后端消息', err && /SU01 中不存在用户 NOBODY/.test(err.message), err ? err.message : '没有抛错');
  resetFetch([{ status: 200, json: { d: { UsersList: { Success: 'X', Json: '[{"UserId":"A"}]' } } } }]);
  v = await ChatService._v8Call('UsersList', null, false);
  check('FE-02：成功路径照常返回 Json', v === '[{"UserId":"A"}]');
  resetFetch([{ status: 200, json: { d: { Legacy: { Json: 'old' } } } }]);
  v = await ChatService._v8Call('Legacy', null, false);
  check('FE-02：旧后端没有 Success 字段时放行', v === 'old');
  resetFetch([{ status: 500, text: '<error/>' }]);
  err = null;
  try { await ChatService._v8Call('UsersList', null, false); } catch (e) { err = e; }
  check('V8 HTTP 失败保持原错误文案 "HTTP 500"', err && err.message === 'HTTP 500', err ? err.message : '没有抛错');

  // V8 POST 令牌失效同样只重试一次、URL 不重复
  ChatService._sCsrfToken = 'bad';
  resetFetch([
    { status: 403, text: 'CSRF token validation failed' },
    { status: 200, headers: { 'x-csrf-token': 'N2' }, json: {} },
    { status: 200, json: { d: { SaveConfig: { Success: 'X', Message: '保存成功' } } } }
  ]);
  await ChatService._v8Call('SaveConfig', { ConfigKey: 'K', ConfigValue: 'V' }, true);
  const cfgCalls = fetchLog.filter((c) => /SaveConfig/.test(c.url));
  check('V8 POST 403 重试后 URL 只有一个 ?', cfgCalls.length === 2 && countOf(cfgCalls[1].url, '?') === 1, cfgCalls.map((c) => c.url).join(' | '));

  ChatService.setConfig({ mode: 'mock' });
  resetFetch([]);
  r = await ChatService._taskCall('Tasks', {}, false);
  check('演示模式 _taskCall 不发请求', r.success === false && fetchLog.length === 0);

  console.log(`\n━━ 结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
