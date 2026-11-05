/**
 * 前端纯逻辑测试（改进清单 PROC-03）—— 无网络、无 UI5 运行时
 * 运行: node frontend-tests.js   （或 npm run test:frontend）
 *
 * 用 vm + sap.ui.define 垫片加载 webapp/ 下的模块（与 agent-eval-tests.js 同一做法），
 * fetch 换成按调用顺序回放的假实现，覆盖：
 *   Formatter（转义 / 白名单清洗 / Markdown）、TraceService.normalizeResult、
 *   ChartRenderer.analyze、ChatService 的 FI 通道（CSRF 重试 FE-01、V8 失败判断 FE-02、
 *   POST 参数位置 FE-08、OData 字符串字面量转义）、长文本通道（20261021，AnalyzeCode 414）、
 *   思考模式（20261029：思考设置解析 / 保存、回答开头 <think> 块拆分、演示对话带思考）。
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

// 20261030：_fetchCsrf 改用 XMLHttpRequest（V8.3csrf-xhr），共用上面的回放队列与调用记录
function FakeXHR() { this.readyState = 0; this.status = 0; this._h = {}; this._rh = {}; }
FakeXHR.prototype.open = function (m, u) { this._m = m; this._u = u; this.readyState = 1; };
FakeXHR.prototype.setRequestHeader = function (k, v) { this._h[k] = v; };
FakeXHR.prototype.getResponseHeader = function (k) { return this._rh[k.toLowerCase()] || null; };
FakeXHR.prototype.send = function () {
  const that = this;
  fetchLog.push({ url: this._u, init: { method: this._m, headers: this._h }, xhr: true });
  const r = fetchQueue.shift() || { status: 0 };
  setTimeout(function () {
    that.status = r.status;
    that._rh = r.headers || {};
    that.readyState = 4;
    if (that.onreadystatechange) { that.onreadystatechange(); }
  }, 0);
};

const registry = {
  'sap/base/Log': { error() {}, warning() {}, info() {}, debug() {} },
  'sap/ui/model/odata/v2/ODataModel': function () {},
  'sap/ui/model/Filter': function () {},
  'sap/ui/model/FilterOperator': {},
  'sap/ui/model/Sorter': function () {},
  // 20261024：DataGrid 只测纯函数，Dialog / HTML 给空壳
  'sap/m/Dialog': function () {},
  'sap/m/Button': function () {},
  'sap/ui/core/HTML': function () {}
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
    fetch: function (u, i) { return fakeFetch(u, i); },
    XMLHttpRequest: FakeXHR
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
  const LingXiState = load('zai/chat/utils/LingXiState');

  console.log('\n━━ 首页时段问候');
  const HeroGreeting = load('zai/chat/utils/HeroGreeting');
  const atHour = (h, m = 0) => new Date(2026, 0, 1, h, m);
  check('早晨显示早上好；午间、下午和晚上各用对应问候',
    [[5, 'welcomeMorning'], [10, 'welcomeMorning'], [11, 'welcomeNoon'], [12, 'welcomeNoon'],
     [13, 'welcomeAfternoon'], [17, 'welcomeAfternoon'], [18, 'welcomeEvening'], [22, 'welcomeEvening']]
      .every(([h, k]) => HeroGreeting.greetingKey(atHour(h)) === k));
  check('深夜和凌晨不会显示早上好',
    [23, 0, 4].every(h => HeroGreeting.greetingKey(atHour(h)) === 'welcomeLate'));
  const greeting1 = HeroGreeting.pick('', atHour(9), () => 0);
  const greeting2 = HeroGreeting.pick(greeting1.key, atHour(9), () => 0);
  check('相邻两次进入首页不重复，标题与副标题按同一组抽取',
    greeting1.key !== greeting2.key && greeting2.titleKey === 'heroWarm' + greeting2.key + 'Title' &&
    greeting2.subKey === 'heroWarm' + greeting2.key + 'Sub');
  check('深夜抽取舒缓文案',
    HeroGreeting.pick('', atHour(0), () => 0.99).key.startsWith('Night'));

  console.log('\n━━ Lynx · 任务表情');
  check('等待后端和请求未完成时使用思考动效',
    LingXiState.message(true, false, false) === 'thinking' &&
    LingXiState.message(false, false, true) === 'thinking' &&
    LingXiState.message(true, true, false) === 'thinking' &&
    LingXiState.message(false, true, true) === 'thinking');
  check('开始输出正文后使用加强版运行动效',
    LingXiState.message(false, true, false) === 'running');
  check('普通对话回复结束恢复原始图标',
    LingXiState.message(false, false, false) === 'idle');
  check('后台报表仍执行时，提交回复继续使用运行动效',
    LingXiState.message(false, false, false, 'active') === 'running' &&
    LingXiState.message(true, false, true, 'active') === 'running');
  check('报表就绪、失败、停止或失去跟踪后都恢复原始图标',
    ['ready', 'failed', 'stopped', 'stalled'].every(s => LingXiState.message(false, false, false, s) === 'idle'));
  check('手动停止优先于仍未清理的等待、打字和后台状态',
    LingXiState.message(true, true, true, 'active', true) === 'idle');
  check('无后台执行的 Agent 回复和历史消息保持原始图标',
    LingXiState.message(false, false, false, '') === 'idle' &&
    LingXiState.message(false, false, false) === 'idle');
  check('侧栏区分等待、输出与独立后台报表，空闲时静止',
    LingXiState.activity(true, false, false) === 'thinking' &&
    LingXiState.activity(true, false, true) === 'running' &&
    LingXiState.activity(false, true, false) === 'running' &&
    LingXiState.activity(false, false, false) === 'idle');
  check('忙碌结束后的旧 streaming 标记不会重新激活侧栏',
    LingXiState.activity(false, false, true) === 'idle');

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

  // 20261021：用户列表 —— 后端 /ui2/cl_json 返回 ABAP 大写字段名，前端统一成驼峰
  resetFetch([{ status: 200, json: { d: { UsersList: { Success: 'X', Json: '[{"USERID":"ZHANGSAN","USERNAME":"张三","ROLE":"ADMIN","ACTIVE":"X"},{"USERID":"LISI","USERNAME":"","ROLE":"USER","ACTIVE":""}]' } } } }]);
  let users = await ChatService.getUsersData();
  check('用户列表：读得出大写字段 USERID/USERNAME/ROLE/ACTIVE', users.length === 2 && users[0].UserId === 'ZHANGSAN' && users[0].UserName === '张三' && users[0].Role === 'ADMIN' && users[0].Active === 'X', JSON.stringify(users));
  check('用户列表：停用用户 Active 为空串', users[1].UserId === 'LISI' && users[1].Active === '' && users[1].Role === 'USER', JSON.stringify(users[1]));
  resetFetch([{ status: 200, json: { d: { UsersList: { Success: 'X', Json: '[{"UserId":"A","UserName":"甲","Role":"USER","Active":"X"}]' } } } }]);
  users = await ChatService.getUsersData();
  check('用户列表：驼峰字段照常读', users.length === 1 && users[0].UserId === 'A' && users[0].UserName === '甲' && users[0].Active === 'X', JSON.stringify(users));
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

  // 20261030（QAS demo7 登录 403）：换牌走 XHR、强制不走缓存；登录 401 / 403 分开提示
  console.log('\n━━ ChatService · 换牌 XHR 与登录提示（10-30 QAS demo7）');
  resetFetch([{ status: 200, headers: { 'x-csrf-token': 'TOK1' } }]);
  let tok = await ChatService._fetchCsrf('Basic QUJDOjEyMw==');
  const cs = fetchLog[0] || { url: '', init: { headers: {} } };
  check('换牌用 XHR 并读到响应头里的令牌', tok === 'TOK1' && cs.xhr === true, JSON.stringify(cs));
  check('换牌 URL 带时间戳（不命中浏览器缓存）', /\/p\/\$metadata\?_=\d+$/.test(cs.url), cs.url);
  check('换牌带 If-Modified-Since 1970（不走 304 协商）', /1970/.test(cs.init.headers['If-Modified-Since'] || ''));
  check('换牌带 x-csrf-token: fetch 与 Basic 头', cs.init.headers['x-csrf-token'] === 'fetch' && cs.init.headers.Authorization === 'Basic QUJDOjEyMw==');
  resetFetch([{ status: 401 }]);
  err = null;
  try { await ChatService._fetchCsrf('Basic x'); } catch (e) { err = e; }
  check('换牌 401 仍报 "bad"', err && err.message === 'bad', err && err.message);
  resetFetch([{ status: 0 }]);
  err = null;
  try { await ChatService._fetchCsrf(''); } catch (e) { err = e; }
  check('换牌网络不通报 "HTTP 0"', err && err.message === 'HTTP 0', err && err.message);

  resetFetch([
    { status: 200, headers: { 'x-csrf-token': 'TOK2' } },
    { status: 403, headers: { 'x-csrf-token': 'Required' }, text: 'CSRF token validation failed' }
  ]);
  err = null;
  try { await ChatService.appLogin('u1', 'p1'); } catch (e) { err = e; }
  check('登录 Login 403 报 "csrf"（不再说密码不正确）', err && err.message === 'csrf', err && err.message);
  const lg = fetchLog.filter((c) => /Login$/.test(c.url))[0];
  check('登录 POST 带上换来的令牌', lg && lg.init.headers['x-csrf-token'] === 'TOK2', JSON.stringify(lg));
  resetFetch([{ status: 401 }]);
  err = null;
  try { await ChatService.appLogin('u1', 'wrong'); } catch (e) { err = e; }
  check('登录密码错（换牌 401）报 "bad"', err && err.message === 'bad', err && err.message);
  resetFetch([{ status: 200, headers: { 'x-csrf-token': 'TOK3' } }, { status: 401 }]);
  err = null;
  try { await ChatService.appLogin('u1', 'p1'); } catch (e) { err = e; }
  check('登录 Login 401 报 "bad"', err && err.message === 'bad', err && err.message);
  resetFetch([{ status: 404 }]);
  err = null;
  try { await ChatService.appLogin('u1', 'p1'); } catch (e) { err = e; }
  check('服务没发布（换牌 404）报 "noService"', err && err.message === 'noService', err && err.message);

  // 20261021：长文本通道（AnalyzeCode 414）—— 假 OData 模型记录 create / callFunction
  console.log('\n━━ ChatService · 长文本通道（414）');
  function fakeModel(bHasSet, oOpt) {
    const o = oOpt || {};
    const log = { creates: [], calls: [] };
    const m = {
      log,
      metadataLoaded: () => Promise.resolve(),
      getServiceMetadata: () => ({ dataServices: { schema: [{ entityContainer: [{ entitySet: bHasSet ? [{ name: 'Sessions' }, { name: 'ChatTexts' }] : [{ name: 'Sessions' }] }] }] } }),
      create: (sPath, oData, mp) => { log.creates.push({ path: sPath, data: oData }); if (o.createFail) { mp.error({ statusCode: 500, message: 'boom' }); } else { mp.success({ TextId: 'T' + log.creates.length, Content: '' }); } },
      callFunction: (sFi, mp) => {
        log.calls.push({ fi: sFi, params: mp.urlParameters });
        if (o.taskMissing && sFi === '/AnalyzeTask') { mp.error({ statusCode: 404, message: 'not found' }); return; }
        mp.success({ Answer: 'ok', Status: 'OK' });
      }
    };
    return m;
  }
  ChatService.setConfig({ mode: 'backend', host: '', path: '/p/' });
  const origGetModel = ChatService._getModel;
  const longQ = '请审查这段代码：\n' + 'DATA lv_x TYPE string. " 中文注释\n'.repeat(120);
  let fm = fakeModel(true);
  ChatService._getModel = () => fm;
  await ChatService.send({ sessionId: 'S1', question: '短问题', modelId: 'M1' });
  check('短问题：不走暂存，原文作为 Question', fm.log.creates.length === 0 && fm.log.calls[0].params.Question === '短问题');
  check('普通对话请求原样携带指定的配置模型编号', fm.log.calls[0].params.ModelId === 'M1');
  check('判定按 URL 编码后的长度（长代码超过 LONG_Q_LIMIT）', encodeURIComponent(longQ).length > ChatService.LONG_Q_LIMIT);
  fm = fakeModel(true);
  await ChatService.send({ sessionId: 'S1', question: longQ, modelId: 'AUTO' });
  check('长问题：先 POST /ChatTexts（正文在请求体）', fm.log.creates.length === 1 && fm.log.creates[0].path === '/ChatTexts' && fm.log.creates[0].data.Content === longQ);
  check('长问题：AnalyzeCode 的 Question 换成 @@ZAI_TEXT:<TextId>', fm.log.calls.length === 1 && fm.log.calls[0].fi === '/AnalyzeCode' && fm.log.calls[0].params.Question === '@@ZAI_TEXT:T1', JSON.stringify(fm.log.calls[0]));
  fm = fakeModel(true, { taskMissing: true });
  ChatService._taskApiAvailable = null;
  await ChatService.sendTask({ sessionId: 'S1', question: longQ, modelId: 'M2' });
  check('Agent：AnalyzeTask 也走暂存', fm.log.calls[0].fi === '/AnalyzeTask' && fm.log.calls[0].params.Question === '@@ZAI_TEXT:T1');
  check('Agent：回退 AnalyzeAgent 时复用同一引用、不再存第二次', fm.log.creates.length === 1 && fm.log.calls[1].fi === '/AnalyzeAgent' && fm.log.calls[1].params.Question === '@@ZAI_TEXT:T1', JSON.stringify(fm.log));
  check('Agent 请求及兼容回退都沿用指定的配置模型编号', fm.log.calls.every((c) => c.params.ModelId === 'M2'));
  ChatService._taskApiAvailable = null;
  fm = fakeModel(false);
  err = null;
  try { await ChatService.send({ sessionId: 'S1', question: longQ }); } catch (e) { err = e; }
  check('后端没有 ChatTexts：给可读提示、不调函数导入', err && /长文本通道/.test(err.message) && fm.log.calls.length === 0, err ? err.message : '没有抛错');
  fm = fakeModel(true, { createFail: true });
  err = null;
  try { await ChatService.send({ sessionId: 'S1', question: longQ }); } catch (e) { err = e; }
  check('暂存失败：报错带原因、不调函数导入', err && /长文本暂存失败/.test(err.message) && fm.log.calls.length === 0, err ? err.message : '没有抛错');
  ChatService._getModel = origGetModel;

  ChatService.setConfig({ mode: 'mock' });
  resetFetch([]);
  r = await ChatService._taskCall('Tasks', {}, false);
  check('演示模式 _taskCall 不发请求', r.success === false && fetchLog.length === 0);
  const mockUsers = await ChatService.getUsersData();
  check('演示模式用户列表带一行只读的内置管理员', mockUsers.length >= 1 && mockUsers[0].UserId === 'ADMIN' && mockUsers[0].BuiltIn === true && fetchLog.length === 0, JSON.stringify(mockUsers));

  // ---------- 20261024（10.24 记录 #02）：大结果集预览 + 分页查看器 ----------
  console.log('\n━━ DataGrid（大结果集预览 / 分页查看器）');
  const DG = load('zai/chat/utils/DataGrid');
  const rows = [];
  for (let i = 0; i < 250; i++) { rows.push(['P' + (i % 3), 'M' + i, i % 7 === 0 ? '' : String(1000 - i) + '.5', i === 5 ? '12.5-' : 'x']); }
  check('预览 50 行、每页 100 行', DG.PREVIEW_ROWS === 50 && DG.PAGE_SIZE === 100);
  let pg = DG.pageOf(rows, 1);
  check('第 1 页：1–100，共 3 页', pg.rows.length === 100 && pg.from === 1 && pg.to === 100 && pg.pages === 3 && pg.total === 250);
  pg = DG.pageOf(rows, 3);
  check('最后一页：201–250', pg.rows.length === 50 && pg.from === 201 && pg.to === 250);
  check('页码越界夹回（0 → 1，99 → 3）', DG.pageOf(rows, 0).page === 1 && DG.pageOf(rows, 99).page === 3);
  pg = DG.pageOf([], 1);
  check('空数据：1 页、from/to 为 0', pg.pages === 1 && pg.from === 0 && pg.to === 0 && pg.rows.length === 0);
  check('搜索不分大小写、任一格命中', DG.filterRows(rows, 'p1').length === 83 && DG.filterRows(rows, 'M249').length === 1 && DG.filterRows(rows, '  ').length === 250);
  check('搜索不改原数组', DG.filterRows(rows, 'zzz').length === 0 && rows.length === 250);
  let srt = DG.sortRows(rows, 2, 'asc');
  check('数值列升序按数值比（不是按字符串），空值排最后', srt[0][2] === '751.5' && srt[srt.length - 1][2] === '' && Number(srt[1][2]) > Number(srt[0][2]));
  srt = DG.sortRows(rows, 2, 'desc');
  check('降序：最大在前，空值仍在最后', srt[0][2] === '999.5' && srt[srt.length - 1][2] === '');
  srt = DG.sortRows([['b'], ['12.5-'], ['3']], 0, 'asc');
  check('SAP 后置负号按负数比；数字与文字混排时按文本比', DG.sortRows([['5'], ['12.5-'], ['3']], 0, 'asc').map((r) => r[0]).join() === '12.5-,3,5' && srt.length === 3);
  check('稳定排序：相同值保持原顺序', DG.sortRows([['1', 'a'], ['0', 'b'], ['1', 'c']], 0, 'asc').map((r) => r[1]).join() === 'b,a,c');
  check('不排序（列 < 0）返回副本', DG.sortRows(rows, -1, 'asc') !== rows && DG.sortRows(rows, -1, 'asc')[0] === rows[0]);
  const cols = [{ label: '<b>工厂</b>' }, { label: '物料' }, { label: '金额', numeric: true }];
  const longVal = '很长很长很长很长很长很长很长很长很长很长很长很长很长很长';
  let th = DG.tableHtml(cols, [['<img src=x onerror=1>', longVal, '1,234.5']], { cls: 'analysisTable' });
  check('表格转义列名与单元格', th.indexOf('<img') < 0 && th.indexOf('&lt;img') >= 0 && th.indexOf('&lt;b&gt;工厂') >= 0);
  check('长文本格加 title（悬停看全），短的不加', (th.match(/title="/g) || []).length === 1 && th.indexOf('title="' + longVal + '"') >= 0);
  check('数值列右对齐 class=num；额外 class 带上', /<td class="num">1,234.5<\/td>/.test(th) && th.indexOf('dgTable analysisTable') >= 0);
  th = DG.tableHtml(cols, [['a', 'b', 'c'], ['d', 'e', 'f']], { rowNo: 101, sortable: true, sortCol: 1, sortDir: 'desc', sortTip: 't' });
  check('查看器表格：行号从 101 起、列头可排序、当前排序列带 ↓', /<td class="dgNo">101<\/td>/.test(th) && /<td class="dgNo">102<\/td>/.test(th) && (th.match(/data-col="/g) || []).length === 3 && th.indexOf('dgSort') >= 0 && th.indexOf('↓') >= 0);
  const T = DG.TEXTS;
  const st = { ds: { name: 'D', columns: cols, rows: rows, truncated: true, total: 1200 }, query: '', sortCol: -1, sortDir: 'asc', page: 3 };
  let vb = DG.viewerBodyHtml(st, T);
  check('查看器第 3 页：范围文字、上一页可点、下一页禁用', vb.foot.indexOf('第 201–250 行，共 250 行') >= 0 && /data-act="prev">/.test(vb.foot) && /data-act="next" disabled/.test(vb.foot) && (vb.table.match(/<tr>/g) || []).length === 51);
  check('规模说明：250 行 × 3 列 + 后端共 1200 行', vb.meta.indexOf('250 行 × 3 列') >= 0 && vb.meta.indexOf('1200') >= 0);
  st.query = 'M24'; st.page = 9;
  vb = DG.viewerBodyHtml(st, T);
  check('搜索后：匹配行数、页码夹回第 1 页、只有一页（上下页都禁用）', vb.meta.indexOf('匹配 11 行') >= 0 && st.page === 1 && /data-act="prev" disabled/.test(vb.foot) && /data-act="next" disabled/.test(vb.foot) && vb.hits.length === 11);
  st.query = 'zzz';
  vb = DG.viewerBodyHtml(st, T);
  check('搜不到：显示没有匹配的行', vb.table.indexOf('dgEmpty') >= 0 && vb.table.indexOf(T.noMatch) >= 0 && vb.foot.indexOf('dgRange"></span>') >= 0);
  const tools = Formatter.dataToolsHtml(0, '', '查看全部 300 行');
  check('工具条：给了「查看全部」时它在最前且是主按钮，生成图表退为普通按钮', /^<div class="dataTools" data-ds="0"><button type="button" class="dtBtn dtPrimary" data-act="all">查看全部 300 行<\/button><button type="button" class="dtBtn" data-act="chart">/.test(tools));
  check('工具条：没给时和原来一样（生成图表是主按钮，没有 all）', Formatter.dataToolsHtml(0).indexOf('data-act="all"') < 0 && Formatter.dataToolsHtml(0).indexOf('dtBtn dtPrimary" data-act="chart"') >= 0);

  // 模型选择必须落到明确配置，旧 AUTO / 停用配置 / 场景限制不能漏到请求中。
  console.log('\n━━ 配置模型选择');
  const SceneModels = load('zai/chat/controller/mixin/SceneModels');
  const modelData = {
    '/models': [
      { ModelId: 'AUTO', ModelName: '旧路由', IsActive: 'X' },
      { ModelId: 'OFF', ModelName: '已停用', IsActive: '' },
      { ModelId: 'M1', ModelName: '本地模型', IsActive: 'X' },
      { ModelId: 'M2', ModelName: '云端模型', IsActive: 'X' }
    ],
    '/workspaceMode': 'CHAT', '/currentSession': { id: 'S1' }
  };
  const chatModel = { getProperty: (p) => modelData[p], setProperty: (p, v) => { modelData[p] = v; } };
  const modelController = Object.assign(Object.create(SceneModels), {
    getView: () => ({ getModel: () => chatModel }), _modelUserKey: () => 'MODEL_TEST',
    _rb: () => ({ getText: (k) => k })
  });
  modelController._applySessionModel();
  check('首次使用选择第一条启用配置；路由和停用项不在菜单里',
    modelData['/currentModel'] === 'M1' && modelData['/modelsView'].map((m) => m.ModelId).join() === 'M1,M2');
  modelController.onModelPick({ getSource: () => ({ getBindingContext: () => ({ getProperty: () => 'M2' }) }) });
  modelData['/currentSession'] = { id: 'S2' };
  modelController._applySessionModel();
  check('新对话沿用上次手动选择', modelData['/currentModel'] === 'M2');
  modelController._rememberSessionModel('S2', 'M1');
  modelController._applySessionModel();
  check('旧对话自己的模型优先，胶囊显示实际模型名',
    modelData['/currentModel'] === 'M1' && modelData['/currentModelName'] === '本地模型');
  modelController._rememberSessionModel('S2', 'AUTO');
  modelController._applySessionModel();
  check('旧对话记住的 AUTO 自动换成有效配置', modelData['/currentModel'] === 'M2');
  modelData['/models'][3].IsActive = '';
  modelController._applySessionModel();
  check('上次模型停用后回到启用配置', modelData['/currentModel'] === 'M1');
  modelData['/models'][3].IsActive = 'X';
  modelData['/workspaceMode'] = 'AGENT';
  modelData['/currentSession'] = { id: 'S2', mode: 'AGENT', agentType: 'CODE' };
  modelController._mAgentModelRules = { ALL: ['M1'], CODE: ['M2'] };
  modelController._syncModelList();
  check('Agent 场景只使用配置中允许的模型',
    modelData['/currentModel'] === 'M2' && modelData['/modelsView'].map((m) => m.ModelId).join() === 'M2');
  modelController._mAgentModelRules.CODE = ['MISSING'];
  modelController._syncModelList();
  check('场景没有可用配置时清空模型，显示空状态，不能回退 AUTO',
    modelData['/currentModel'] === '' && modelData['/modelsView'].length === 0 && modelData['/currentModelName'] === 'modelPickEmpty');
  modelData['/models'] = [];
  modelController._applySessionModel();
  check('模型配置为空时不沿用失效编号', modelData['/currentModel'] === '');

  console.log('\n━━ Agent 边跑边看（演示后端）');
  const MockBackend = load('zai/chat/service/MockBackend');
  const sc = MockBackend._mockLiveScript({
    trace: [{ phase: 'UNDERSTANDING', label: '理解问题' }, { phase: 'COMPOSING', label: '整理报表参数' }],
    pendingParamsJson: JSON.stringify({ report_id: 'R1', report_name: '出货', params: [{ param_id: 'A', label: '工厂', required: true }] })
  });
  check('参数卡类回复补上「匹配报表 → 读取参数定义」两步，最后一步叫「生成参数卡」',
    sc.map((t) => t.tool || t.phase).join() === 'UNDERSTANDING,match_report,read_params,COMPOSING' && sc[3].liveLabel === '生成参数卡',
    sc.map((t) => t.tool || t.phase).join());
  check('没有过程摘要时也从「理解问题」开始', MockBackend._mockLiveScript({}).map((t) => t.phase).join() === 'UNDERSTANDING');
  check('不认识的运行编号：进度为 NONE', MockBackend._mockAgentProgress.call({}, 'X').status === 'NONE');

  console.log('\n━━ 组合分析（ComboData，20261031）');
  const ComboData = load('zai/chat/utils/ComboData');
  const dsA = { name: '未交', columns: [{ name: 'WERKS', label: '工厂', numeric: false }, { name: 'MATNR', label: '物料', numeric: false }, { name: 'Q', label: '未交数量' }],
    rows: [['1000', 'M852', '662'], ['1000', 'M870', '480'], ['2000', 'M428', '538']] };
  const dsB = { name: '库存', columns: [{ name: 'W', label: '工厂', numeric: false }, { name: 'M', label: '物料', numeric: false }, { name: 'S', label: '库存' }],
    rows: [['1000', 'M852', '400'], ['1000', 'M852', '10'], ['2000', 'M428', '900']] };
  const keys = ComboData.suggestKeys(dsA, dsB);
  check('关联列按同名维度列推荐（工厂、物料）', keys.length === 2 && keys[0].a === 0 && keys[1].a === 1, JSON.stringify(keys));
  check('有共同维度列 → 默认关联', ComboData.suggestMode([dsA, dsB]) === 'join');
  const j = ComboData.join([dsA, dsB], ['未交', '库存'], [[], keys], false);
  check('左连接：主表行数不变，同一关联值多行先求和', j.rows.length === 3 && j.rows[0][3] === 410 && j.rows[1][3] === '' && j.matched === 2,
    JSON.stringify(j.rows));
  check('只保留都对上的行', ComboData.join([dsA, dsB], ['未交', '库存'], [[], keys], true).rows.length === 2);
  check('订单号前导零视为同一个', ComboData.normKey('004541152') === ComboData.normKey('4541152'));
  const dsA2 = { name: '未交9月', columns: dsA.columns, rows: [['3000', 'M1', '5']] };
  check('结构相同 → 默认追加', ComboData.suggestMode([dsA, dsA2]) === 'append');
  const ap = ComboData.append([dsA, dsA2], ['10月', '9月']);
  check('追加：加「来源」列，行数相加', ap.columns[0].label === '来源' && ap.rows.length === 4 && ap.rows[3][0] === '9月' && ap.rows[3][1] === '3000');
  const dsC = { name: 'ship', columns: [{ name: 'MODE', label: 'Ship Mode' }, { name: 'V', label: '2026-10' }], rows: [['D', '32592'], ['C', '3308']] };
  check('没有共同列 → 并排', ComboData.suggestMode([dsA, dsC]) === 'side');
  check('并排导出 CSV 含两张表名', /未交/.test(ComboData.sideCsv([dsA, dsC], ['未交', 'ship'])) && /ship/.test(ComboData.sideCsv([dsA, dsC], ['未交', 'ship'])));
  const jc = ComboData.join([dsA, dsB], ['未交', '库存'], [[], []], false);
  check('没选关联列的表不参与，并说明', jc.columns.length === 3 && /没选关联列/.test(jc.note));

  // 20261031（二期方案 §7.1）：截断提示
  check('完整数据不提示', ComboData.truncInfo(dsA, 'REPORT_RESULT') === null && ComboData.truncNotes([dsA, dsB], ['未交', '库存'], [], 'join').length === 0);
  const dsR = Object.assign({}, dsA, { total: 23415, truncated: true });
  const tr = ComboData.truncInfo(dsR, 'REPORT_RESULT');
  check('报表执行：写明样例行数和后端总数', tr && /3 行样例/.test(tr.text) && /23,415/.test(tr.text), tr && tr.text);
  check('Fiori：写"前 N 行"', /只取回前 3 行（共 23,415 行）/.test(ComboData.truncInfo(dsR, 'FIORI_RESULT').text));
  check('只有截断标记、不知道总数', /不是全部/.test(ComboData.truncInfo(Object.assign({}, dsA, { truncated: true }), '').text));
  const tn = ComboData.truncNotes([dsA, dsR], ['未交', 'ZM001'], ['FIORI_RESULT', 'REPORT_RESULT'], 'join');
  check('关联：只列被截断的那份 + 说明关联和合计不完整', tn.length === 2 && /「ZM001」/.test(tn[0]) && /关联和合计都不完整/.test(tn[1]), JSON.stringify(tn));
  check('追加的后果说明换措辞', /合计和行数都不完整/.test(ComboData.truncNotes([dsR], ['ZM001'], ['REPORT_RESULT'], 'append')[1]));

  // 20261031：组合分析二期（与 ZCL_AI_COMBO_SERVICE 同口径）
  console.log('\n━━ 组合分析二期（ComboData 汇总 / ComboMockBackend，20261031）');
  check('关联值归一：日期统一成 YYYYMMDD', ComboData.normKey('2026-1-5') === '20260105' && ComboData.normKey('2026.01.05') === ComboData.normKey('20260105'));
  const dsF = { name: 'F', columns: [{ name: 'MATNR', label: '物料', numeric: false }, { name: 'AMT', label: '金额' }], rows: [['M1', '5'], ['M2', '7']] };
  const dsR2 = { name: 'R', columns: [{ name: 'MATNR', label: 'MATNR', numeric: false }, { name: 'QTY', label: 'QTY' }], rows: [['M1', '1']] };
  const kn = ComboData.suggestKeys(dsF, dsR2);
  check('标题不同、列名相同（老报表 MATNR vs Fiori「物料」）也推荐为关联列', kn.length === 1 && kn[0].a === 0 && kn[0].b === 0, JSON.stringify(kn));
  const jb = ComboData.combineBySpec([dsA, dsB], ['未交', '库存'], { mode: 'join', keys: [null, [{ a: 'WERKS', b: 'W' }, { a: 'MATNR', b: 'M' }]] });
  check('按列名提交的关联说明 = 按下标关联的结果', JSON.stringify(jb.rows) === JSON.stringify(j.rows));
  const dsG = { name: 'G', columns: [{ name: 'WERKS', label: '工厂' }, { name: 'MAT', label: '物料', numeric: false }, { name: 'AMT', label: '金额' }],
    rows: [['1000', 'A', '10.5'], ['1000', 'B', '3'], ['2000', 'A', '20'], ['2000', 'C', '1'], ['1000', 'A', '4']] };
  const gs = ComboData.groupSummary(dsG, [1], 2, [0]);
  check('分组汇总：关联列（工厂）不当度量；按金额从大到小，超出的并成「其他」',
    gs.measures.join() === '金额' && gs.groups[0].key[0] === 'A' && gs.groups[0].sums[0] === 34.5 && gs.groups[0].n === 3 &&
    gs.other && gs.other.n === 1 && gs.groupCount === 3, JSON.stringify(gs));
  const gs2 = ComboData.groupSummary(dsG, [1], 50, []);
  check('排序用的度量取取值最多的数值列（金额，不是工厂代码）', gs2.measures[0] === '金额', gs2.measures.join());
  check('自动汇总维度：取值 2～50 的文字列，优先关联列', JSON.stringify(ComboData.autoGroup(dsG, [1])) === '[1]');
  const big = { name: 'big', columns: [{ name: 'K', label: 'K', numeric: false }, { name: 'V', label: 'V' }], rows: [] };
  for (let i = 0; i < 300; i++) { big.rows.push(['k' + i, String(i)]); }
  const ed = ComboData.edgeRows(big, 3, 200);
  check('明细举例：超过 200 行取最大 / 最小各 N 行；不超过就给全部',
    !ed.all && ed.top[0][1] === '299' && ed.bottom[0][1] === '0' && ed.top.length === 3 && ComboData.edgeRows(dsG, 3, 200).all === true);
  const CM = load('zai/chat/service/ComboMockBackend');
  const fakeSvc = Object.assign({}, CM, {
    _mockTime: () => '2026-10-31 20:00',
    _fioriStats: () => ({ rowCount: 0, numeric: [] }),
    _mockFioriState: () => ({ runs: {
      FA1: { def: { reportId: 'SO', analyzeEnabled: 'X' }, sessionId: 'S1', ds: { columns: dsA.columns.map((c) => ({ name: c.name, label: c.label, numeric: c.name === 'Q' })), rows: dsA.rows.map((r) => ({ WERKS: r[0], MATNR: r[1], Q: Number(r[2]) })) } },
      FA2: { def: { reportId: 'INV', analyzeEnabled: 'X' }, sessionId: 'S2', ds: { columns: dsB.columns.map((c) => ({ name: c.name, label: c.label, numeric: c.name === 'S' })), rows: dsB.rows.map((r) => ({ W: r[0], M: r[1], S: Number(r[2]) })) } },
      FA3: { def: { reportId: 'PO', analyzeEnabled: '' }, sessionId: 'S2', ds: { columns: [], rows: [] } }
    } })
  });
  const spec = { mode: 'JOIN', sources: [{ artifactId: 'FA1', type: 'FIORI_RESULT', name: '未交' }, { artifactId: 'FA2', type: 'FIORI_RESULT', name: '库存' }],
    keys: [null, [{ a: 'WERKS', b: 'W' }, { a: 'MATNR', b: 'M' }]] };
  const cr = fakeSvc._mockComboCreate({ SessionId: 'S9', SpecJson: JSON.stringify(spec), ClientRequestId: 'R1' });
  const crRows = JSON.parse(cr.rowsJson), crSrc = JSON.parse(cr.sourcesJson), crSum = JSON.parse(cr.summaryJson);
  check('演示后端：跨会话来源组合成 COMBO 结果，行是按列名作键的对象，来源清单带原会话',
    cr.artifactId.indexOf('CART') === 0 && cr.rowCount === 3 && crRows[0].S_1 === 410 && crSrc[1].sessionId === 'S2' && crSrc[1].aggregated === true,
    cr.rowsJson);
  check('演示后端：汇总不把关联列（工厂）当度量', crSum.group.measures.indexOf('工厂') < 0, JSON.stringify(crSum.group));
  check('演示后端：同一请求号返回同一结果（幂等）', fakeSvc._mockComboCreate({ SessionId: 'S9', SpecJson: JSON.stringify(spec), ClientRequestId: 'R1' }).artifactId === cr.artifactId);
  let rej = '';
  try { fakeSvc._mockComboCreate({ SessionId: 'S9', SpecJson: JSON.stringify({ mode: 'APPEND', sources: [spec.sources[0], { artifactId: 'FA3', type: 'FIORI_RESULT', name: '采购' }] }) }); } catch (e) { rej = e.message; }
  check('演示后端：未开放模型分析的报表整体拒绝，并说明是哪一份', /第 2 份「采购」/.test(rej) && /未开放模型分析/.test(rej), rej);
  check('演示后端：聚焦本会话的组合结果才走组合回答', !!fakeSvc._mockComboFocused({ sessionId: 'S9', focusedArtifactId: cr.artifactId }) &&
    !fakeSvc._mockComboFocused({ sessionId: 'S1', focusedArtifactId: cr.artifactId }));

  // 20261101：按用户开放场景 + 报表授权（与 ZCL_AI_ACCESS 同口径）
  console.log('\n━━ 用户权限（UserAccess / 演示后端，20261101）');
  const UA = load('zai/chat/utils/UserAccess');
  check('场景串规范化：固定顺序、去重、去非法、认中文逗号', UA.normScenes('code，report,REPORT,auto, fiori').join() === 'REPORT,FIORI,CODE');
  check('空 = 四个全开；管理员永远全开', UA.effectiveScenes('USER', '').length === 4 && UA.effectiveScenes('ADMIN', 'DATA').length === 4 &&
    UA.effectiveScenes('USER', 'DATA').join() === 'DATA');
  check('「自动」所有人可用；旧库存场景按数据分析判断', UA.sceneOk(UA.SCENES, 'AUTO') && UA.sceneOk(['REPORT', 'FIORI'], 'AUTO') && UA.sceneOk(['CODE'], '') &&
    !UA.sceneOk(['REPORT', 'FIORI'], 'INVENTORY') && UA.sceneOk(['DATA'], 'INVENTORY') && UA.sceneOk(['REPORT', 'FIORI'], 'fiori') && !UA.sceneOk(['REPORT', 'FIORI'], 'DATA'));
  check('报表串规范化：只认 REPORT / FIORI，去掉引号、逗号等会破坏参数的写法',
    UA.normReports('report:zdpmm702, FIORI:shipment ,BAD:x,REPORT:,REPORT:ZDPMM702,FIORI:a"b').join() === 'REPORT:ZDPMM702,FIORI:SHIPMENT');
  const g1 = { aclOn: true, admin: false, grants: ['REPORT:A', 'REPORT:B', 'FIORI:X'] };
  check('1 用户 A、B：A 可用、C 不可用；Fiori 与报表执行互不影响',
    UA.reportOk(g1, 'REPORT', 'a') && !UA.reportOk(g1, 'REPORT', 'C') && !UA.reportOk(g1, 'FIORI', 'A') && UA.reportOk(g1, 'FIORI', 'X'));
  check('开关不开 / 管理员 → 全部可用', UA.reportOk({ aclOn: false, grants: [] }, 'REPORT', 'C') && UA.reportOk({ aclOn: true, admin: true, grants: [] }, 'FIORI', 'Z'));
  check('「REPORT:*」= 这一类全部', UA.reportOk({ aclOn: true, grants: ['REPORT:*'] }, 'REPORT', 'ANY') && !UA.reportOk({ aclOn: true, grants: ['REPORT:*'] }, 'FIORI', 'ANY'));
  check('用户管理简述', UA.summary('USER', 'REPORT,FIORI', 'REPORT:A,REPORT:B,FIORI:X') === '场景 2/4 · 报表执行 2 · Fiori 1' &&
    UA.summary('USER', '', '') === '全部场景 · 未分配报表' && UA.summary('ADMIN', '', '') === '管理员 · 全部' && UA.summary('PUBLIC', '', '') === '暂无公共报表',
    UA.summary('USER', 'REPORT,FIORI', 'REPORT:A,REPORT:B,FIORI:X'));

  const MB2 = load('zai/chat/service/MockBackend');
  const FMB = load('zai/chat/service/FioriMockBackend');
  const uaRows = [{ UserId: 'USER1', Role: 'USER', Active: 'X', AgentScenes: 'REPORT,FIORI', Reports: 'REPORT:ZDPMM702,REPORT:ZDPMM455,FIORI:SHIPMENT' },
    { UserId: 'USER2', Role: 'USER', Active: 'X', AgentScenes: '', Reports: 'REPORT:ZDPMM702,REPORT:ZDPSD010' }];
  const mkSvc = (who, role) => Object.assign({}, MB2, FMB, {
    getAppUser: () => ({ userId: who, role: role, scenes: (uaRows.filter((u) => u.UserId === who)[0] || {}).AgentScenes || '' }),
    isAdmin: () => role === 'ADMIN',
    allowedScenes: function () { return UA.effectiveScenes(role, this.getAppUser().scenes); },
    _mockUsers: () => uaRows,
    _mockPublicReports: () => 'REPORT:ZDPSD012',
    _sanitizeAnalysis: (a) => a
  });
  fakeWindow.localStorage.setItem('zaiChat.cfg.RPT_ACL_ENABLED', 'X');
  const ids = async (svc) => (await svc._mockReportDefs()).defs.map((d) => d.REPORT_ID).sort().join();
  const s1 = mkSvc('USER1', 'USER'), s2 = mkSvc('USER2', 'USER'), sa = mkSvc('ADMIN', 'ADMIN');
  check('演示后端：1 用户目录 = A、B + 公共', await ids(s1) === 'ZDPMM455,ZDPMM702,ZDPSD012', await ids(s1));
  check('演示后端：2 用户目录 = A、C + 公共', await ids(s2) === 'ZDPMM702,ZDPSD010,ZDPSD012', await ids(s2));
  check('演示后端：管理员看全部', (await sa._mockReportDefs()).defs.length >= 5);
  check('演示后端：Fiori 目录只给授权的', s1._mockFioriDefsList().map((d) => d.reportId).join() === 'SHIPMENT' && s2._mockFioriDefsList().length === 0);
  let fe = '';
  try { s1._mockFioriRun({ ReportId: 'PO_OPEN', ParamsJson: '{}', ClientRequestId: 'ua-1', SessionId: 's' }); } catch (e) { fe = e.message; }
  check('演示后端：没授权的 Fiori 报表取数被拒', /没有报表「.*」的使用权限/.test(fe), fe);
  check('演示后端：一句话找报表不出没授权的', s1._fioriCandidates('采购未清').length === 0);
  fakeWindow.localStorage.removeItem('zaiChat.cfg.RPT_ACL_ENABLED');
  check('演示后端：开关关掉 → 1 用户也看全部', (await s1._mockReportDefs()).defs.length >= 5);
  fakeWindow.localStorage.setItem('zaiChat.cfg.RPT_ACL_ENABLED', 'X');
  const uaStore = { sessions: [], messages: {} };
  const s1Store = Object.assign(s1, { _mockStore: () => uaStore, _mockSave: () => {}, _mockComboFocused: () => null });
  const dn = await s1Store._mockSendAgent({ sessionId: 'ua-s', question: '统计物料', scene: 'DATA' });
  check('演示后端：没开放的场景直接拒绝（DENIED）', dn.status === 'DENIED' && /数据分析/.test(dn.answer), dn.answer);
  const da = await s1Store._mockSendAgent({ sessionId: 'ua-s2', question: '你好', scene: 'AUTO' });
  check('演示后端：没四个全开也能用「自动」', da.status !== 'DENIED' && !/没有「自动」/.test(da.answer || ''), da.answer);
  const dt = await s1Store._mockSendAgent({ sessionId: 'ua-s3', question: '分析表 MARA 的物料类型分布', scene: 'AUTO' });
  check('演示后端：「自动」里点名查表，但没开数据分析 → 说明能力未开放，并记进会话历史', /「数据分析」.*没有开放给你/.test(dt.answer) && !dt.analysis &&
    (uaStore.messages['ua-s3'] || []).length === 2 && uaStore.sessions.some((x) => x.SessionId === 'ua-s3' && x.AgentType === 'AUTO'), dt.answer);
  const dq = await s1Store._mockSendAgent({ sessionId: 'ua-s4', question: '统计一下物料类型分布', scene: 'AUTO' });
  check('演示后端：「自动」里没点名的数据类问题 → 普通回答，不带数据集', dq.status !== 'DENIED' && !(dq.analysis && dq.analysis.datasets));
  const dr = await s1Store._mockSendAgent({ sessionId: 'ua-s5', question: '执行 ZDPSD010', scene: 'AUTO' });
  check('演示后端：「自动」里执行报表照样核报表授权（1 用户没有 C），会话仍记为「自动」', /没有报表「.*」的使用权限/.test(dr.answer) &&
    uaStore.sessions.some((x) => x.SessionId === 'ua-s5' && x.AgentType === 'AUTO'), dr.answer);
  const s3 = Object.assign(mkSvc('USER3', 'USER'), { getAppUser: () => ({ userId: 'USER3', role: 'USER', scenes: 'DATA' }),
    allowedScenes: () => ['DATA'], _mockStore: () => uaStore, _mockSave: () => {}, _mockComboFocused: () => null });
  const dr3 = await s3._mockSendAgent({ sessionId: 'ua-s6', question: '执行 ZDPMM702', scene: 'AUTO' });
  check('演示后端：没开报表执行 → 「自动」里执行报表说明能力未开放', /「报表执行」.*没有开放给你/.test(dr3.answer), dr3.answer);
  fakeWindow.localStorage.removeItem('zaiChat.cfg.RPT_ACL_ENABLED');

  const csSrcUA = fs.readFileSync(path.join(WEBAPP, 'service/ChatService.js'), 'utf8');
  const saveUA = (csSrcUA.match(/saveUserAccess: function[\s\S]*?\n                \},/) || [''])[0];
  check('保存授权：发 Scenes / Reports / AccessSet，报表串走长文本通道', /Scenes: sScenes/.test(saveUA) && /Reports: sArg/.test(saveUA) &&
    /AccessSet: "X"/.test(saveUA) && /_prepareQuestion\(sReports\)/.test(saveUA));
  check('SEGW 没加参数时不显示授权维护（看 $metadata 有没有 SaveUser.Scenes）', /_fiHasParam\("SaveUser", "Scenes"\)/.test(csSrcUA));

  console.log('\n━━ 思考模式（20261029）');
  check('思考设置解析：大小写不敏感、写法只认 DS/QW/OL + 1/0、同一模型以第一次为准（与后端 parse_think_cfg 一致）',
    JSON.stringify(ChatService.parseThinkCfg(' ds_v4 = ds1 ,GLM=QW0,BAD=XX1,DS_V4=QW1,OLL=ol1,,=DS1')) ===
      JSON.stringify({ DS_V4: 'DS1', GLM: 'QW0', OLL: 'OL1' }));
  check('思考设置写回：按模型 ID 排序、丢掉无效项', ChatService.formatThinkCfg({ B: 'QW0', A: 'DS1', C: 'ZZ1' }) === 'A=DS1,B=QW0');
  const sp1 = ChatService.splitThink('\n<think>\n先确认口径\n再查表\n</think>\n\n**结论**：3 行');
  check('拆开回答开头的 <think> 块：思考去掉首尾空白，回答只留正文', sp1.reasoning === '先确认口径\n再查表' && sp1.answer === '**结论**：3 行');
  check('没有思考块 / 思考块不在开头：原样返回',
    ChatService.splitThink('普通回答').answer === '普通回答' && ChatService.splitThink('普通回答').reasoning === '' &&
    ChatService.splitThink('标签 <think>x</think> 在中间').answer === '标签 <think>x</think> 在中间');
  const wr = ChatService._withThink({ answer: '<think>\n想\n</think>\n\n答' });
  const wr2 = ChatService._withThink(wr);
  check('发送结果后处理：answer 只留回答、思考放 reasoning；重复处理不变', wr.answer === '答' && wr.reasoning === '想' && wr2.answer === '答' && wr2.reasoning === '想');
  check('空思考块（模型关思考时的 <think></think>）去掉，不生成 reasoning',
    (function () { const r = ChatService._withThink({ answer: '<think>\n\n</think>\n\n答' }); return r.answer === '答' && !r.reasoning; })());
  check('参数写法推荐：Ollama → OL；名字带 deepseek → DS；其他 → QW',
    ChatService.suggestThinkStyle({ ModelType: 'OLLAMA', ApiModel: 'deepseek-r1' }) === 'OL' &&
    ChatService.suggestThinkStyle({ ModelType: 'OPENAI', ApiModel: 'DeepSeek-V4-Flash' }) === 'DS' &&
    ChatService.suggestThinkStyle({ ModelType: 'OPENAI', ApiModel: 'glm-4.6' }) === 'QW');
  ChatService.setConfig({ mode: 'mock' });
  await ChatService.getModelThinkMap(true);
  check('演示模式默认给 DeepSeek 演示模型开思考，其他模型不开',
    ChatService.isThinkOn('mock_deepseek') && !ChatService.isThinkOn('MOCK_OLLAMA_QWEN') && ChatService.thinkModeOf('MOCK_DEEPSEEK') === 'DS1');
  await ChatService.saveModelThink('mock_vllm', 'QW0');
  const mAfter = await ChatService.getModelThinkMap(true);
  check('保存一个模型的思考设置：先重读再改这一项，其他模型保留', mAfter.MOCK_VLLM === 'QW0' && mAfter.MOCK_DEEPSEEK === 'DS1' && !ChatService.isThinkOn('MOCK_VLLM'));
  await ChatService.saveModelThink('MOCK_VLLM', '');
  check('改回「不传」= 删掉这一项', !('MOCK_VLLM' in (await ChatService.getModelThinkMap(true))));
  let tooLong = '';
  try {
    const mBig = {};
    for (let i = 0; i < 20; i++) { mBig['MODEL_LONG_ID_' + String(i).padStart(4, '0')] = 'DS1'; }
    ChatService._mThink = mBig;
    const fnGet = ChatService.getModelThinkMap;
    ChatService.getModelThinkMap = () => Promise.resolve(Object.assign({}, mBig));
    try { await ChatService.saveModelThink('ONE_MORE', 'QW1'); } catch (e) { tooLong = e.message; }
    ChatService.getModelThinkMap = fnGet;
  } finally { await ChatService.getModelThinkMap(true); }
  check('超过 CFGVALUE 255 字时拒绝保存并说明原因', /255/.test(tooLong), tooLong);
  const sidT = 'S_THINK_' + Date.now();
  const rThink = await ChatService.send({ sessionId: sidT, question: '怎么连接后端？', modelId: 'MOCK_DEEPSEEK' });
  const histT = (ChatService._mockStore().messages[sidT] || []).filter((m) => m.Role === 'assistant');
  check('演示对话（开思考的模型）：回答不含 <think>，思考在 reasoning；历史里存的回答不含思考',
    !/<think>/i.test(rThink.answer) && /对话模式/.test(rThink.reasoning || '') && histT.length === 1 && !/<think>/i.test(histT[0].Content));
  const rNo = await ChatService.send({ sessionId: sidT + 'B', question: '你好', modelId: 'MOCK_OLLAMA_QWEN' });
  check('演示对话（没开思考的模型）：没有 reasoning，回答与原来一致', !rNo.reasoning && /演示模式/.test(rNo.answer));

  console.log('\n━━ 输入框「深度思考」按钮（20261029）');
  ChatService.setConfig({ mode: 'mock' });
  await ChatService.getModelThinkMap(true);
  fakeWindow.localStorage.removeItem(ChatService.THINK_PREF_KEY);
  check('配了参数写法的模型才算支持思考', ChatService.thinkCapable('MOCK_DEEPSEEK') && !ChatService.thinkCapable('MOCK_VLLM'));
  check('没点过按钮：按模型管理里的开关', ChatService.getThinkPref('MOCK_DEEPSEEK') === undefined && ChatService.effectiveThink('MOCK_DEEPSEEK') === true);
  ChatService.setThinkPref('mock_deepseek', false);
  check('点过按钮：按用户的（按模型记，大小写不敏感）', ChatService.getThinkPref('MOCK_DEEPSEEK') === false && ChatService.effectiveThink('MOCK_DEEPSEEK') === false);
  ChatService.setThinkPref('MOCK_VLLM', true);
  check('不支持思考的模型：点过也不思考', ChatService.effectiveThink('MOCK_VLLM') === false);
  const rOff = await ChatService.send({ sessionId: 'S_TB_' + Date.now(), question: '你好', modelId: 'MOCK_DEEPSEEK', think: 'N' });
  check('演示：按钮关掉时（Think=N）开了思考的模型也不思考', !rOff.reasoning);
  fakeWindow.localStorage.removeItem(ChatService.THINK_PREF_KEY);

  function thinkModel(bParam) {
    const calls = [];
    const fi = (n) => ({ name: n, parameter: [{ name: 'SessionId' }, { name: 'Question' }].concat(bParam ? [{ name: 'Think' }] : []) });
    return {
      calls,
      metadataLoaded: () => Promise.resolve(),
      getServiceMetadata: () => ({ dataServices: { schema: [{ entityContainer: [{ entitySet: [{ name: 'Sessions' }],
        functionImport: [fi('AnalyzeCode'), fi('AnalyzeTask')] }] }] } }),
      callFunction: (sFi, mp) => {
        calls.push({ fi: sFi, params: mp.urlParameters });
        mp.success({ Answer: '<think>\n先想一下\n</think>\n\n回答', Status: 'OK' });
      }
    };
  }
  ChatService.setConfig({ mode: 'backend', host: '', path: '/p/' });
  let tm = thinkModel(true);
  ChatService._getModel = () => tm;
  ChatService._taskApiAvailable = null;
  check('后端声明了 Think 参数：两种模式都能按次开关', ChatService.supportsThinkToggle('CHAT') && ChatService.supportsThinkToggle('AGENT'));
  const rB = await ChatService.send({ sessionId: 'S1', question: '问', modelId: 'M1', think: 'X' });
  await ChatService.sendTask({ sessionId: 'S1', question: '问', modelId: 'M1', think: 'N' });
  check('AnalyzeCode 带 Think=X、AnalyzeTask 带 Think=N', tm.calls[0].params.Think === 'X' && tm.calls[1].fi === '/AnalyzeTask' && tm.calls[1].params.Think === 'N',
    JSON.stringify(tm.calls.map((c) => [c.fi, c.params.Think])));
  check('后端回答开头的思考块拆到 reasoning（真实接口路径）', rB.answer === '回答' && rB.reasoning === '先想一下');
  await ChatService.send({ sessionId: 'S1', question: '问', modelId: 'M1' });
  check('没传 think：不带 Think 参数（按模型配置）', !('Think' in tm.calls[2].params));
  tm = thinkModel(false);
  ChatService._taskApiAvailable = null;
  check('SEGW 还没加 Think 参数：不显示按钮', !ChatService.supportsThinkToggle('CHAT') && !ChatService.supportsThinkToggle('AGENT'));
  await ChatService.send({ sessionId: 'S1', question: '问', modelId: 'M1', think: 'X' });
  await ChatService.sendTask({ sessionId: 'S1', question: '问', modelId: 'M1', think: 'X' });
  check('SEGW 还没加 Think 参数：不发送（不会因多余参数报错）', tm.calls.length === 2 && tm.calls.every((c) => !('Think' in c.params)));
  ChatService._getModel = origGetModel;
  ChatService._taskApiAvailable = null;
  ChatService.setConfig({ mode: 'mock' });

  console.log('\n━━ 定时任务（ScheduleData / ScheduleMockBackend / ChatService，20261104）');
  const SD = load('zai/chat/utils/ScheduleData');
  // 2026-11-05 是周四
  check('星期：2026-11-05 是周四(3)、2026-11-09 是周一(0)', SD.weekday('20261105') === 3 && SD.weekday('20261109') === 0);
  check('相对日期：今天 / 昨天 / N 天前', SD.resolveToken('@TODAY', '20261105') === '20261105' &&
    SD.resolveToken('@TODAY-1', '20261105') === '20261104' && SD.resolveToken('@today-10', '20261105') === '20261026');
  check('相对日期：本周一 / 本月首末 / 上月首末 / 今年第一天',
    SD.resolveToken('@WEEK_START', '20261105') === '20261102' && SD.resolveToken('@MONTH_START', '20261105') === '20261101' &&
    SD.resolveToken('@MONTH_END', '20261105') === '20261130' && SD.resolveToken('@LMONTH_START', '20261105') === '20261001' &&
    SD.resolveToken('@LMONTH_END', '20261105') === '20261031' && SD.resolveToken('@YEAR_START', '20261105') === '20260101');
  check('相对日期：跨年 / 闰年二月', SD.resolveToken('@LMONTH_START', '20260115') === '20251201' &&
    SD.resolveToken('@LMONTH_END', '20240315') === '20240229' && SD.resolveToken('@MONTH_END', '20280210') === '20280229');
  check('不认识的记号 → null；天数超过 366 → null；不是记号原样', SD.resolveToken('@TOMORROW', '20261105') === null &&
    SD.resolveToken('@TODAY-400', '20261105') === null && SD.resolveToken('20260101', '20261105') === '20260101');
  const scRp = SD.resolveParams({ p_werks: 'ABZ1', s_budat: '@LMONTH_START,@LMONTH_END', p_d: '@TODAY-1' }, '20261105');
  check('参数换算：范围逐项、非日期原样', scRp.p_werks === 'ABZ1' && scRp.s_budat === '20261001,20261031' && scRp.p_d === '20261104', JSON.stringify(scRp));
  check('界面状态 ↔ 值：N 天前 / 昨天 / 固定日期', SD.modeValue('N_DAYS', 7, '') === '@TODAY-7' && SD.dateMode('@TODAY-7').mode === 'N_DAYS' &&
    SD.dateMode('@TODAY-1').mode === '@TODAY-1' && SD.dateMode('2026-11-01').fixed === '20261101' && SD.modeValue('', 0, '20261101') === '20261101');
  check('每周：只在勾的星期跑', SD.dueOn({ freq: 'WEEKLY', weekdays: 'X X X  ' }, '20261102') && !SD.dueOn({ freq: 'WEEKLY', weekdays: 'X X X  ' }, '20261103'));
  check('每月：31 号在 11 月按最后一天；99 = 最后一天', SD.dueOn({ freq: 'MONTHLY', monthDay: 31 }, '20261130') &&
    !SD.dueOn({ freq: 'MONTHLY', monthDay: 31 }, '20261129') && SD.dueOn({ freq: 'MONTHLY', monthDay: 99 }, '20260228'));
  const scNow = new Date(2026, 10, 5, 10, 0, 0);   // 周四 10:00
  check('下次运行：每天 09:00 → 明天；每天 11:00 → 今天', SD.nextRun({ freq: 'DAILY', time: '0900' }, scNow) === '20261106090000' &&
    SD.nextRun({ freq: 'DAILY', time: '11:00' }, scNow) === '20261105110000');
  check('下次运行：工作日 09:00（周四 10 点）→ 周五；周五 10 点 → 下周一',
    SD.nextRun({ freq: 'WEEKLY', time: '0900', weekdays: 'XXXXX  ' }, scNow) === '20261106090000' &&
    SD.nextRun({ freq: 'WEEKLY', time: '0900', weekdays: 'XXXXX  ' }, new Date(2026, 10, 6, 10, 0, 0)) === '20261109090000');
  check('下次运行：每 3 小时从 08:00 起（10:00）→ 11:00', SD.nextRun({ freq: 'HOURLY', time: '0800', everyHours: 3 }, scNow) === '20261105110000');
  check('触发文字', SD.trigText({ freq: 'WEEKLY', time: '0900', weekdays: 'XXXXX  ' }) === '工作日 09:00' &&
    SD.trigText({ freq: 'WEEKLY', time: '1730', weekdays: 'X X    ' }) === '每周一、三 17:30' &&
    SD.trigText({ freq: 'MONTHLY', time: '0800', monthDay: 99 }) === '每月最后一天 08:00' &&
    SD.trigText({ freq: 'HOURLY', time: '0800', everyHours: 2 }) === '每 2 小时(从 08:00 起)');
  check('触发校验：时间格式 / 每周没勾 / 每 N 小时范围', SD.checkTrigger({ freq: 'DAILY', time: '25:00' }, 0) !== '' &&
    SD.checkTrigger({ freq: 'WEEKLY', time: '0900', weekdays: '       ' }, 0) !== '' &&
    SD.checkTrigger({ freq: 'HOURLY', time: '0900', everyHours: 0 }, 0) !== '' && SD.checkTrigger({ freq: 'DAILY', time: '09:00' }, 0) === '');

  // 演示后端：新建（只有指令）→ 列表 → 立即运行 → 未读 → SEEN → 暂停 → 删除
  ChatService.setConfig({ mode: 'mock' });
  fakeWindow.localStorage.removeItem('zaiChat.mockSched.v1');
  ChatService._oSchedMock = null;
  check('演示模式：定时任务恒可用', await ChatService.scheduleAvailable());
  let scErr = '';
  try { await ChatService.scheduleSave({ name: '', instruction: 'x', triggers: [{ freq: 'DAILY', time: '0900' }] }); } catch (e) { scErr = e.message; }
  check('没名称 → 拒绝', /名称/.test(scErr), scErr);
  scErr = '';
  try { await ChatService.scheduleSave({ name: 'A', instruction: 'x', scene: 'REPORT', triggers: [{ freq: 'DAILY', time: '0900' }] }); } catch (e) { scErr = e.message; }
  check('没有数据来源时不能选报表执行场景（无人值守不让灵犀自己跑报表）', /场景只能选/.test(scErr), scErr);
  const sc1 = (await ChatService.scheduleSave({ name: '每日简报', instruction: '统计昨天各工厂出货', scene: 'DATA',
    triggers: [{ freq: 'WEEKLY', time: '09:00', weekdays: 'XXXXX  ' }, { freq: 'DAILY', time: '1700' }] })).item;
  check('新建成功：两个触发、场景 DATA、有下次运行时间', sc1.schedId && sc1.triggers.length === 2 && sc1.scene === 'DATA' && /^\d{14}$/.test(sc1.nextRun), JSON.stringify(sc1));
  const scPre = (await ChatService.scheduleAction('', 'PREFILL', 'ART123')).item;
  check('设为定时（PREFILL）：带出数据来源、场景跟随来源、参数含日期', scPre.srcType === 'REPORT' && scPre.scene === 'REPORT' &&
    scPre.params.some((p) => p.dataType === 'DATE'), JSON.stringify(scPre));
  scErr = '';
  try {
    await ChatService.scheduleSave({ name: '库存', instruction: '', fromArtifactId: 'ART123', params: { p_werks: 'X999' }, triggers: [{ freq: 'DAILY', time: '0800' }] });
  } catch (e) { scErr = e.message; }
  check('数据来源的非日期参数不能改', /不能在这里修改/.test(scErr), scErr);
  const sc2 = (await ChatService.scheduleSave({ name: '库存', instruction: '', fromArtifactId: 'ART123', params: { p_budat: '@TODAY-1' },
    triggers: [{ freq: 'DAILY', time: '0800' }] })).item;
  check('只跑报表（指令留空）+ 日期改成相对日期', sc2.srcType === 'REPORT' && sc2.params.filter((p) => p.paramId === 'p_budat')[0].value === '@TODAY-1');
  await ChatService.scheduleAction(sc2.schedId, 'RUNNOW', '');
  let scLst = (await ChatService.scheduleList('')).items;
  const sc2b = scLst.filter((x) => x.schedId === sc2.schedId)[0];
  const scRuns = (await ChatService.scheduleRuns(sc2.schedId)).runs;
  check('立即运行：写运行记录（参数已按当天换算）、置未读', sc2b.unread === 'X' && scRuns.length === 1 && !/@TODAY/.test(scRuns[0].paramsUsed), JSON.stringify(scRuns[0]));
  await ChatService.scheduleAction(sc2.schedId, 'SEEN', '');
  scLst = (await ChatService.scheduleList('')).items;
  check('SEEN 后不再未读', scLst.filter((x) => x.schedId === sc2.schedId)[0].unread === '');
  const scp = (await ChatService.scheduleAction(sc1.schedId, 'PAUSE', '')).item;
  check('暂停：状态 PAUSED、没有下次运行', scp.status === 'PAUSED' && !scp.nextRun);
  await ChatService.scheduleAction(sc1.schedId, 'DELETE', '');
  scLst = (await ChatService.scheduleList('')).items;
  check('删除', scLst.length === 1 && scLst[0].schedId === sc2.schedId);

  // 真实接口：参数名 / HTTP 方法
  ChatService.setConfig({ mode: 'backend', host: '', path: '/p/' });
  const scCalls = [];
  const origTaskCall = ChatService._taskCall;
  ChatService._taskCall = function (a, p, post) { scCalls.push({ a, p, post }); return Promise.resolve({ success: true, message: '', result: { items: [] } }); };
  await ChatService.scheduleList('ALL');
  await ChatService.scheduleAction('S1', 'RUNNOW', '');
  await ChatService.scheduleRuns('S1');
  await ChatService.scheduleSave({ name: 'A' }, 'R1');
  check('四个 FI：List GET(Scope) / Action POST / Runs GET / Save POST(ScheduleJson, ClientRequestId)',
    scCalls[0].a === 'ScheduleList' && scCalls[0].p.Scope === 'ALL' && !scCalls[0].post &&
    scCalls[1].a === 'ScheduleAction' && scCalls[1].post && scCalls[1].p.Action === 'RUNNOW' &&
    scCalls[2].a === 'ScheduleRuns' && !scCalls[2].post &&
    scCalls[3].a === 'ScheduleSave' && scCalls[3].post && JSON.parse(scCalls[3].p.ScheduleJson).name === 'A' && scCalls[3].p.ClientRequestId === 'R1',
    JSON.stringify(scCalls));
  ChatService._taskCall = function () { return Promise.resolve({ success: false, message: '定时任务功能未开启(SCHED_ENABLED)', result: null }); };
  scErr = '';
  try { await ChatService.scheduleList(''); } catch (e) { scErr = e.message; }
  check('后端失败：抛后端原话', /SCHED_ENABLED/.test(scErr), scErr);
  ChatService._taskCall = origTaskCall;
  const Fmt = load('zai/chat/utils/Formatter');
  check('结果卡工具条：只有传了 bSched 才有「设为定时」', /sched-add/.test(Fmt.dataToolsHtml(0, '', '', true)) && !/sched-add/.test(Fmt.dataToolsHtml(0, '', '')));
  ChatService.setConfig({ mode: 'mock' });

  console.log('\n━━ 联合分析 #01 报表接力（20261105）');
  check('结果卡工具条：传了来源短号才有「和结果 X 关联」，文字转义', /data-act="relay-join"[^>]*>和结果 0050569C 关联/.test(Fmt.dataToolsHtml(0, '', '', false, '0050569C')) &&
    !/relay-join/.test(Fmt.dataToolsHtml(0, '', '', true)) && Fmt.dataToolsHtml(0, '', '', false, '<b>').indexOf('&lt;b&gt;') > 0);
  ['sap/m/VBox', 'sap/m/HBox', 'sap/m/Text', 'sap/m/Label', 'sap/m/Input', 'sap/m/DatePicker', 'sap/m/ToggleButton',
    'sap/ui/core/Icon', 'sap/m/ResponsivePopover', 'sap/m/TextArea'].forEach((k) => { if (!registry[k]) { registry[k] = function () {}; } });
  const AskCard = load('zai/chat/utils/AskCard');
  const aMany = Array.from({ length: 1021 }, (_, i) => '1AM' + i).join(',');
  const sShow = AskCard.valueDisplay({ multi_value: true, data_type: 'CHAR' }, aMany);
  check('提交回显：上千个值只列前 5 个 + 总数；少量值照旧全列', /^1AM0、1AM1、1AM2、1AM3、1AM4 … 共 1021 个$/.test(sShow) &&
    AskCard.valueDisplay({ multi_value: true, data_type: 'CHAR' }, 'A,B,C') === 'A、B、C', sShow);
  check('范围参数不受影响', AskCard.valueDisplay({ range_allowed: true, data_type: 'DATE' }, '20261101,20261105') === '2026-11-01 ~ 2026-11-05');
  check('合并参数定义：后端预填的值不会被登记默认值覆盖', (() => {
    const r = AskCard.mergeParamDefs([{ param_id: 'MATNR', multi_value: true }], [{ PARAM_ID: 'MATNR', DEFAULT_TYPE: 'STATIC', DEFAULT_VALUE: 'X1' }], { MATNR: 'A,B' });
    return r.values.MATNR === 'A,B';
  })());

  console.log('\n━━ 多重选择（仿 SAP GUI，20261105）');
  check('Excel 一列（\\r\\n）、Tab、中英文逗号、分号、空格都拆成单个值', JSON.stringify(AskCard.splitMulti('HHZZ\r\nHHCD\r\n\r\nHHTJ\t1001，1002;1003 1004')) ===
    JSON.stringify(['HHZZ', 'HHCD', 'HHTJ', '1001', '1002', '1003', '1004']));
  check('去重保持先后顺序', JSON.stringify(AskCard.uniqVals(['C1', 'C2', 'C1', 'C3', 'C2'])) === JSON.stringify(['C1', 'C2', 'C3']));
  const askSrc = fs.readFileSync(path.join(WEBAPP, 'utils/AskCard.js'), 'utf8');
  check('多值参数（非范围、非日期）才有多重选择按钮；粘贴含换行时接管并入已有值', /if \(bMulti && !bDate\) \{\s+oCtl = buildMulti\(/.test(askSrc) &&
    /attachBrowserEvent\("paste"/.test(askSrc) && /fnSet\(uniqVals\(fnVals\(\)\.concat\(splitMulti\(t\)\)\)\)/.test(askSrc));
  check('剪贴板按钮只在安全上下文显示（http 用 Ctrl+V）', /navigator\.clipboard\.readText &&[\s\S]{0,80}window\.isSecureContext/.test(askSrc));

  console.log('\n━━ 参数卡草稿（切换会话 / 刷新后填过的值还在，20261105）');
  check('AskCard：四处改动都通知控制器（输入框 / 单选组 / 复选框 / 表参数；多重选择走输入框那处）',
    (fs.readFileSync(path.join(WEBAPP, 'utils/AskCard.js'), 'utf8').match(/fireEdit\(oAsk\);/g) || []).length === 4);
  let iHook = 0;
  AskCard.setEditHook(function () { iHook++; });
  check('setEditHook 注册后可调用（不抛错）', typeof AskCard.setEditHook === 'function');
  const ctlSrc = fs.readFileSync(path.join(WEBAPP, 'controller/App.controller.js'), 'utf8');
  const rrSrc = fs.readFileSync(path.join(WEBAPP, 'controller/mixin/ResultRestore.js'), 'utf8');
  const fpSrc = fs.readFileSync(path.join(WEBAPP, 'controller/mixin/FioriPanel.js'), 'utf8');
  check('控制器：onInit 注册草稿；重建参数卡叠上草稿（报表 + Fiori）；提交 / 取数成功后删草稿',
    /AskCard\.setEditHook\(this\._askDraftSave\.bind\(this\)\)/.test(ctlSrc) && (ctlSrc.match(/this\._askDraftOf\(oTask\.taskId\)\.values/g) || []).length === 2 &&
    /that\._askDraftClear\(oAsk\.taskId\)/.test(ctlSrc) && /that\._askDraftClear\(oAsk\.taskId\)/.test(fpSrc));
  check('草稿只存还没提交的参数卡，按 用户 + 任务号，最多 30 张、14 天', /oAsk\.kind !== "params" \|\| oAsk\.state !== "open" \|\| !oAsk\.taskId/.test(rrSrc) &&
    /"zaiChat\.askDraft\.v1\." \+ this\._modelUserKey\(\)/.test(rrSrc) && /aIds\.slice\(30\)/.test(rrSrc) && /14 \* 86400000/.test(rrSrc));

  console.log(`\n━━ 结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
