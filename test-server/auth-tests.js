/**
 * 事务码权限自助申请 —— 前端契约与演示模式语义测试（无网络、无 SAP）
 * 运行: node auth-tests.js   （或 npm run test:auth）
 *
 * 覆盖两层：
 *   1) ChatService 的 9 个 auth* 方法对真实后端的调用约定：FI 名、参数名、POST 参数放 URL、
 *      成功解析 camelCase 的 ResultJson、失败抛后端原话（用假 fetch 回放）
 *   2) AuthMockBackend 的语义（与 ZCL_AI_AUTH_SERVICE 一一对应）：自助 / 批量代加 / 审批 / 撤销 /
 *      BLOCK 只拦自助 / 表动态与规则 / 校验与权限
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

const registry = {
  'sap/base/Log': { error() {}, warning() {}, info() {}, debug() {} },
  'sap/ui/model/odata/v2/ODataModel': function () {}, 'sap/ui/model/Filter': function () {},
  'sap/ui/model/FilterOperator': {}, 'sap/ui/model/Sorter': function () {}
};
function load(name) {
  if (registry[name]) { return registry[name]; }
  const file = path.join(WEBAPP, name.replace(/^zai\/chat\//, '') + '.js');
  let out;
  const sandbox = {
    sap: { ui: { define: (deps, fn) => { out = fn.apply(null, deps.map(load)); } } },
    console, Promise, Date, RegExp, Math, JSON, Object, Array, String, Number, Error, Uint8Array,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, unescape, escape, URLSearchParams,
    parseInt, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    jQuery: { extend: extend }, window: fakeWindow, fetch: (u, i) => fakeFetch(u, i)
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  registry[name] = out;
  return out;
}

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
const countOf = (s, sub) => s.split(sub).length - 1;

(async () => {
  const svc = load('zai/chat/service/ChatService');
  const as = (id, role) => svc._setAppUser({ userId: id, role: role || 'USER' });
  const submit = (o) => svc.authSubmit(Object.assign({ Tcode: 'ZDPMM051', WerksList: '1000', Reason: '业务使用' }, o));
  const statuses = (r) => r.lines.map((l) => l.status).join(',');

  /* ---------------- 1) 对真实后端的调用约定 ---------------- */
  console.log('\n━━ ChatService · 对后端的调用约定');
  svc.setConfig({ mode: 'backend', host: '', path: '/p/' });
  svc._sCsrfToken = 'T0';
  resetFetch([{ status: 200, json: { d: { AuthSubmit: { Success: 'X', Message: '共 1 条', ResultJson: JSON.stringify({ lines: [{ reqId: 'R1', targetUser: 'USERA', tcode: 'ZDPMM051', werks: '1000', tabname: 'ZIDPPP009', status: 'DONE', message: '权限已开通' }], summary: '共 1 条', error: '' }) } } } }]);
  let r = await svc.authSubmit({ Tcode: 'ZDPMM051', WerksList: '1000,2000', Reason: "O'Brien 需要" });
  const c = fetchLog[0];
  check('AuthSubmit 是 POST，带 CSRF 令牌', c.init.method === 'POST' && c.init.headers['x-csrf-token'] === 'T0');
  check('参数都在 URL 里（Tcode / WerksList / Reason），没有 form 正文', /AuthSubmit\?Tcode='ZDPMM051'&WerksList='1000%2C2000'&Reason='O''Brien/.test(c.url) && !c.init.body, c.url);
  check('成功时返回解析后的 camelCase 结果', r.lines[0].reqId === 'R1' && r.lines[0].targetUser === 'USERA' && r.summary === '共 1 条');

  resetFetch([{ status: 200, json: { d: { AuthList: { Success: 'X', Message: '', ResultJson: '{"requests":[],"total":0,"error":""}' } } } }]);
  r = await svc.authList({ Status: 'PENDING', User: 'USERA', Tcode: 'ZDPMM051', Top: '50', Skip: '0' });
  check('AuthList 是 GET，不带 CSRF 头，参数名为 Status/User/Tcode/Top/Skip', fetchLog[0].init.method === 'GET' && !fetchLog[0].init.headers['x-csrf-token'] &&
    /AuthList\?Status='PENDING'&User='USERA'&Tcode='ZDPMM051'&Top='50'&Skip='0'/.test(fetchLog[0].url), fetchLog[0].url);

  resetFetch([{ status: 200, json: { d: { AuthConfig: { Success: '', Message: '该操作仅管理员可执行', ResultJson: '{"tables":[],"rules":[],"error":"该操作仅管理员可执行"}' } } } }]);
  await rejects('后端 Success 为空 → 抛后端原话', svc.authConfig(), /仅管理员/);

  resetFetch([{ status: 404, text: 'Resource not found' }]);
  await rejects('FI 还没在 SEGW 建（404）→ 抛出 HTTP 错误', svc.authConfig(), /HTTP 404/);

  const names = { authBatchAdd: 'AuthBatchAdd', authDecide: 'AuthDecide', authRevoke: 'AuthRevoke', authTableSave: 'AuthTableSave', authRuleSave: 'AuthRuleSave', authTableDescribe: 'AuthTableDescribe' };
  for (const k of Object.keys(names)) {
    resetFetch([{ status: 200, json: { d: { [names[k]]: { Success: 'X', ResultJson: '{}' } } } }]);
    await svc[k]({ X: '1' });
    check(`${k} 调用 FI ${names[k]}`, new RegExp('/p/' + names[k] + '\\?').test(fetchLog[0].url), fetchLog[0].url);
  }

  /* ---------------- 2) 演示模式语义 ---------------- */
  svc.setConfig({ mode: 'mock' });
  resetFetch([]);
  as('USERA');

  console.log('\n━━ 自助申请');
  r = await submit({ WerksList: '1000,2000,1000', Users: 'ADMIN', TargetUser: 'ADMIN' });
  check('多个工厂去重，各写一行，全部 DONE', statuses(r) === 'DONE,DONE' && r.lines.every((l) => l.targetUser === 'USERA'), statuses(r));
  check('目标账号只能是登录用户，前端传的 Users / TargetUser 被忽略', r.lines.every((l) => l.targetUser === 'USERA'));
  r = await submit({ WerksList: '1000' });
  check('同一组合再申请 → EXISTS，不重复写', statuses(r) === 'EXISTS');
  r = await submit({ WerksList: 'ALL' });
  check('申请 ALL → PENDING（默认要审批）', statuses(r) === 'PENDING', statuses(r));
  const pendingId = r.lines[0].reqId;
  r = await submit({ WerksList: 'ALL' });
  check('相同的待审批申请不再重复排队', statuses(r) === 'PENDING' && r.lines[0].reqId === pendingId && /已有相同/.test(r.lines[0].message));
  r = await submit({ Tcode: 'ZDPMM702' });
  check('规则 BLOCK：自助申请被拒绝，表里不写', statuses(r) === 'REJECTED' && /不允许自助/.test(r.lines[0].message), statuses(r));
  await rejects('没有权限表的事务码 → 提示联系 IT', submit({ Tcode: 'ZNOTABLE' }), /尚未配置权限表/);
  await rejects('事务码不存在', submit({ Tcode: 'ZNOPE' }), /不存在/);
  await rejects('事务码格式不合法', submit({ Tcode: "ZD'PMM" }), /格式不合法/);
  await rejects('工厂不存在', submit({ WerksList: '9999' }), /工厂 9999 不存在/);
  await rejects('工厂超长 / 含单引号被拒绝，不报 SQL 错', submit({ WerksList: "10'0" }), /工厂格式不合法/);
  await rejects('申请原因必填', submit({ Reason: '  ' }), /申请原因必填/);

  console.log('\n━━ 权限与开关');
  await rejects('普通用户不能批量代加', svc.authBatchAdd({ Users: 'USERB', Tcode: 'ZDPMM051', WerksList: '1000', Reason: 'x' }), /仅管理员/);
  await rejects('普通用户不能审批', svc.authDecide({ ReqId: pendingId, Approve: 'X' }), /仅管理员/);
  await rejects('普通用户不能撤销', svc.authRevoke({ ReqId: pendingId }), /仅管理员/);
  await rejects('普通用户不能读配置', svc.authConfig(), /仅管理员/);
  await rejects('普通用户不能登记表', svc.authTableSave({ Tabname: 'ZIDPPP009', FmapJson: '[]' }), /仅管理员/);
  await rejects('普通用户不能改规则', svc.authRuleSave({ TcodePat: 'ZX*', RuleMode: 'AUTO' }), /仅管理员/);
  r = await svc.authList({ User: 'SOMEONEELSE' });
  check('普通用户的列表忽略 User 参数，只看自己的', r.requests.length > 0 && r.requests.every((x) => x.requester === 'USERA'));
  fakeWindow.localStorage.setItem('zaiChat.cfg.AUTH_ENABLED', '');
  await rejects('开关关闭 → 自助申请被拒', submit(), /尚未启用/);
  await rejects('开关关闭 → 普通用户查记录也被拒（对话框显示"尚未启用"）', svc.authList({}), /尚未启用/);
  as('ADMIN', 'ADMIN');
  await rejects('开关关闭 → 批量代加被拒（不写权限表）', svc.authBatchAdd({ Users: 'USERB', Tcode: 'ZDPMM051', WerksList: '1000', Reason: 'x' }), /尚未启用/);
  r = await svc.authConfig();
  check('开关关闭 → 配置照常可读（可以先配好再打开）', r.tables.length === 1 && r.rules.length === 3);
  r = await svc.authTableDescribe({ Tabname: 'ZIDPPP009' });
  check('开关关闭 → 读表结构照常', r.fields.length === 3);
  r = await svc.authList({});
  check('开关关闭 → ADMIN 照常查记录', r.total > 0);
  as('USERA');
  fakeWindow.localStorage.setItem('zaiChat.cfg.AUTH_ENABLED', 'X');
  svc._setAppUser(null);
  await rejects('未登录 → 拒绝', submit(), /未开通/);

  console.log('\n━━ 审批 / 驳回 / 撤销');
  as('ADMIN', 'ADMIN');
  r = await svc.authList({ Status: 'PENDING', User: 'USERA' });
  check('管理员按目标账号 / 状态筛选', r.requests.length === 1 && r.requests[0].reqId === pendingId);
  await rejects('驳回必须写原因', svc.authDecide({ ReqId: pendingId, Approve: '', Message: ' ' }), /请填写驳回原因/);
  r = await svc.authDecide({ ReqId: pendingId, Approve: 'X', Message: '' });
  check('批准 → DONE 并写表', r.lines[0].status === 'DONE', r.lines[0].status);
  await rejects('已处理的申请不能再审批', svc.authDecide({ ReqId: pendingId, Approve: 'X' }), /只能处理待审批/);
  r = await svc.authList({ User: 'USERA', Status: 'DONE' });
  const doneRow = r.requests.filter((x) => x.werks === 'ALL')[0];
  check('已开通的申请标记可撤销，不暴露原始主键', doneRow.revocable === 'X' && !('keyJson' in doneRow));
  r = await svc.authRevoke({ ReqId: pendingId, Message: '岗位调整' });
  check('撤销 → REVOKED', r.lines[0].status === 'REVOKED' && r.lines[0].message === '岗位调整');
  await rejects('已撤销的不能再撤销', svc.authRevoke({ ReqId: pendingId }), /只能撤销/);
  as('USERA');
  r = await submit({ WerksList: 'ALL' });
  check('撤销之后可以重新申请（又进入待审批）', statuses(r) === 'PENDING');
  as('ADMIN', 'ADMIN');
  r = await svc.authDecide({ ReqId: r.lines[0].reqId, Approve: '', Message: '先不开' });
  check('驳回 → REJECTED 且不写表', r.lines[0].status === 'REJECTED');
  await rejects('没处理的待审批不能撤销', (async () => { as('USERA'); const s = await submit({ WerksList: 'ALL' }); as('ADMIN', 'ADMIN'); return svc.authRevoke({ ReqId: s.lines[0].reqId }); })(), /只能撤销/);

  console.log('\n━━ 批量代加');
  r = await svc.authBatchAdd({ Users: 'DEMOUSER, LOCKED\nUSERB NOBODY', Tcode: 'ZDPMM051', WerksList: '1000,2000', Reason: '邮件申请' });
  const by = (u) => r.lines.filter((l) => l.targetUser === u).map((l) => l.status).join(',');
  check('可用账号逐工厂写入，锁定 / 不存在的账号逐条报 FAILED，其余照常', by('DEMOUSER') === 'DONE,DONE' && by('USERB') === 'DONE,DONE' && by('LOCKED') === 'FAILED' && by('NOBODY') === 'FAILED', JSON.stringify(r.lines.map((l) => l.targetUser + ':' + l.status)));
  check('汇总里有各状态的条数', /已开通 4/.test(r.summary) && /失败或拒绝 2/.test(r.summary), r.summary);
  r = await svc.authBatchAdd({ Users: 'USERB', Tcode: 'ZDPMM702', WerksList: '1000', Reason: 'IT 处理' });
  check('规则 BLOCK 只拦自助，IT 批量代加不受限', statuses(r) === 'DONE', statuses(r));
  r = await svc.authBatchAdd({ Users: 'USERB', Tcode: 'ZDPMM051', WerksList: 'ALL', Reason: 'IT 处理' });
  check('批量代加申请 ALL 不走审批', statuses(r) === 'DONE');
  const many = Array.from({ length: 101 }, (_, i) => 'U' + i).join(',');
  await rejects('一次最多 100 个账号', svc.authBatchAdd({ Users: many, Tcode: 'ZDPMM051', WerksList: '1000', Reason: 'x' }), /1 至 100/);

  console.log('\n━━ 权限表与规则（动态）');
  let d = await svc.authTableDescribe({ Tabname: 'ZAUTH_TEST' });
  check('读表结构：按字段名给出建议映射（TCD→事务码、BNAME→账号、PLANT→工厂、ERDAT→日期）', d.fields.length === 4 && ['TCD', 'BNAME', 'PLANT', 'ERDAT'].every((f) => d.fields.some((x) => x.fieldname === f)) && d.fields.filter((x) => x.mapType !== 'INITIAL').length === 1, JSON.stringify(d.fields.map((x) => x.fieldname + ':' + x.mapType)));
  const map = (fields) => JSON.stringify(fields.map((f) => ({ f: f.fieldname, t: f.mapType, c: f.constVal || '' })));
  const sugg = { TCD: 'TCODE', BNAME: 'USER', PLANT: 'WERKS', ERDAT: 'DATE' };
  const full = d.fields.map((f) => Object.assign({}, f, { mapType: sugg[f.fieldname] }));
  for (const bad of ['ZAI_CHAT_USER', 'USR02', 'ZNOPE', 'zai_x']) {
    await rejects(`不能登记 ${bad}`, svc.authTableDescribe({ Tabname: bad }), /只能登记|不存在/);
  }
  await rejects('主键字段留空 → 拒绝', svc.authTableSave({ Tabname: 'ZAUTH_TEST', Active: 'X', FmapJson: map(full.map((f) => f.fieldname === 'PLANT' ? Object.assign({}, f, { mapType: 'INITIAL' }) : f)) }), /主键字段 PLANT 必须配置映射/);
  await rejects('漏提交字段 → 拒绝', svc.authTableSave({ Tabname: 'ZAUTH_TEST', Active: 'X', FmapJson: map(full.slice(0, 3)) }), /必须提交每个字段/);
  await rejects('没有 USER 映射 → 拒绝', svc.authTableSave({ Tabname: 'ZAUTH_TEST', Active: 'X', FmapJson: map(full.map((f) => f.fieldname === 'BNAME' ? Object.assign({}, f, { mapType: 'CONST', constVal: 'X' }) : f)) }), /至少要有一个 USER/);
  await rejects('参与自动发现必须有 TCODE 映射', svc.authTableSave({ Tabname: 'YAUTH_SINGLE', Discover: 'X', Active: 'X', FmapJson: JSON.stringify([{ f: 'UNAME', t: 'USER', c: '' }, { f: 'WERKS', t: 'WERKS', c: '' }]) }), /TCODE 映射/);
  await rejects('固定值必须填值', svc.authTableSave({ Tabname: 'ZAUTH_TEST', Active: 'X', FmapJson: map(full.map((f) => f.fieldname === 'ERDAT' ? Object.assign({}, f, { mapType: 'CONST', constVal: '' }) : f)) }), /没填值/);
  r = await svc.authTableSave({ Tabname: 'ZAUTH_TEST', Descr: '测试表', Discover: 'X', Active: 'X', FmapJson: map(full) });
  check('字段名不同的表可以登记', /已保存/.test(r.message));
  await rejects('规则指向未登记的表 → 拒绝', svc.authRuleSave({ TcodePat: 'ZDEMO001', Tabname: 'YAUTH_SINGLE', RuleMode: 'AUTO', Active: 'X' }), /未登记或未启用/);
  await rejects('规则格式不合法', svc.authRuleSave({ TcodePat: "ZD'*", RuleMode: 'AUTO', Active: 'X' }), /格式不合法/);
  await rejects('规则处理方式不合法', svc.authRuleSave({ TcodePat: 'ZDEMO001', RuleMode: 'MAYBE', Active: 'X' }), /AUTO \/ APPROVE \/ BLOCK/);
  await svc.authRuleSave({ TcodePat: 'ZDEMO001', Tabname: 'ZAUTH_TEST', RuleMode: 'AUTO', Active: 'X' });
  as('USERA');
  r = await submit({ Tcode: 'ZDEMO001', WerksList: '1000' });
  check('按规则写到新登记的表', statuses(r) === 'DONE' && r.lines[0].tabname === 'ZAUTH_TEST');
  const st = svc._mockAuthState();
  const row = st.rows.ZAUTH_TEST[0];
  check('行里字段按映射填：TCD / BNAME / PLANT，ERDAT = 当天', row.TCD === 'ZDEMO001' && row.BNAME === 'USERA' && row.PLANT === '1000' && /^\d{8}$/.test(row.ERDAT), JSON.stringify(row));
  as('ADMIN', 'ADMIN');
  await svc.authRuleSave({ TcodePat: 'ZDPMM05*', Tabname: '', RuleMode: 'APPROVE', Active: 'X' });
  as('USERA');
  r = await submit({ Tcode: 'ZDPMM052', WerksList: '3000' });
  check('精确规则优先于通配：ZDPMM052 有精确规则（自动通过），不受 ZDPMM05* 影响', statuses(r) === 'DONE', statuses(r));
  as('ADMIN', 'ADMIN');
  await svc.authRuleSave({ TcodePat: 'ZDPMM052', Delete: 'X' });
  as('USERA');
  r = await submit({ Tcode: 'ZDPMM052', WerksList: '2000' });
  check('删掉精确规则后，通配 ZDPMM05* 生效（需要审批）', statuses(r) === 'PENDING', statuses(r));
  as('ADMIN', 'ADMIN');
  r = await svc.authDecide({ ReqId: r.lines[0].reqId, Approve: 'X' });
  check('审批通过后写入', r.lines[0].status === 'DONE');
  // 20261022（V1.1）：同一种映射可以配给多个字段，写入同一个值；查重 / 自动发现看全部同类字段
  await rejects('两列都配工厂、没有账号 → 仍按缺 USER 拒绝', svc.authTableSave({ Tabname: 'ZAUTH_NOPLANT', Active: 'X', FmapJson: JSON.stringify([{ f: 'TCODE', t: 'WERKS', c: '' }, { f: 'BNAME', t: 'WERKS', c: '' }]) }), /至少要有一个 USER/);
  r = await svc.authTableSave({ Tabname: 'ZAUTH_TWIN', Descr: '两列账号 + 两列事务码', Discover: 'X', Active: 'X', FmapJson: JSON.stringify([{ f: 'TCODE', t: 'TCODE', c: '' }, { f: 'UNAME', t: 'USER', c: '' }, { f: 'TCODE_ALT', t: 'TCODE', c: '' }, { f: 'OWNER', t: 'USER', c: '' }]) });
  check('同一种映射可以配给多个字段（两个 USER、两个 TCODE）', /已保存/.test(r.message), r.message);
  svc._mockAuthState().rows.ZAUTH_TWIN.push({ TCODE: 'ZOLD', UNAME: 'SOMEONE', TCODE_ALT: 'ZNOTABLE', OWNER: 'SOMEONE' });
  as('USERA');
  r = await submit({ Tcode: 'ZNOTABLE', WerksList: '1000' });
  check('自动发现看全部 TCODE 列：事务码只出现在第二列也能找到表', statuses(r) === 'DONE' && r.lines[0].tabname === 'ZAUTH_TWIN', JSON.stringify(r.lines));
  const twin = svc._mockAuthState().rows.ZAUTH_TWIN.filter((x) => x.UNAME === 'USERA')[0] || {};
  check('同类字段写同一个值：两列账号都是 USERA、两列事务码都是 ZNOTABLE', twin.OWNER === 'USERA' && twin.TCODE === 'ZNOTABLE' && twin.TCODE_ALT === 'ZNOTABLE', JSON.stringify(twin));
  r = await submit({ Tcode: 'ZNOTABLE', WerksList: '1000' });
  check('再申请 → EXISTS（查重比对全部同类字段）', statuses(r) === 'EXISTS', statuses(r));
  as('ADMIN', 'ADMIN');
  r = await svc.authTableSave({ Tabname: 'ZAUTH_NOPLANT', Descr: '没有工厂列', Discover: '', Active: 'X', FmapJson: JSON.stringify([{ f: 'TCODE', t: 'TCODE', c: '' }, { f: 'BNAME', t: 'USER', c: '' }]) });
  check('没有工厂列的表也能登记', /已保存/.test(r.message));
  await svc.authRuleSave({ TcodePat: 'ZNOTABLE', Tabname: 'ZAUTH_NOPLANT', RuleMode: 'AUTO', Active: 'X' });
  as('USERA');
  r = await submit({ Tcode: 'ZNOTABLE', WerksList: '1000,2000,3000' });
  check('写没有工厂列的表：申请了 3 个工厂也只写一行，记录里工厂为空', r.lines.length === 1 && r.lines[0].status === 'DONE' && r.lines[0].werks === '' && svc._mockAuthState().rows.ZAUTH_NOPLANT.length === 1, JSON.stringify(r.lines));
  r = await submit({ Tcode: 'ZNOTABLE', WerksList: '1000' });
  check('再申请 → EXISTS', statuses(r) === 'EXISTS');
  as('ADMIN', 'ADMIN');
  await svc.authRuleSave({ TcodePat: 'ZNOTABLE', Tabname: 'ZAUTH_NOPLANT', RuleMode: 'APPROVE', Active: 'X' });
  r = await svc.authBatchAdd({ Users: 'USERB', Tcode: 'ZNOTABLE', WerksList: '1000', Reason: 'x' });
  check('批量代加写没有工厂列的表', statuses(r) === 'DONE' && r.lines[0].werks === '');
  as('DEMOUSER');
  r = await submit({ Tcode: 'ZNOTABLE', WerksList: '2000' });
  check('规则要审批时，没有工厂列的申请进入待审批（工厂为空）', statuses(r) === 'PENDING' && r.lines[0].werks === '');
  as('ADMIN', 'ADMIN');
  r = await svc.authDecide({ ReqId: r.lines[0].reqId, Approve: 'X' });
  check('审批工厂为空的申请 → 开通', r.lines[0].status === 'DONE', r.lines[0].status + ' ' + r.lines[0].message);
  const cfg = await svc.authConfig();
  check('配置页能读到已登记的表（含字段映射）和规则', cfg.tables.length === 4 && cfg.tables.some((t) => t.tabname === 'ZAUTH_TEST' && t.fields.some((f) => f.fieldname === 'TCD' && f.mapType === 'TCODE')) && cfg.tables.some((t) => t.tabname === 'ZAUTH_TWIN' && t.fields.filter((f) => f.mapType === 'USER').length === 2) && cfg.rules.length >= 4, cfg.tables.map((t) => t.tabname).join(','));

  console.log('\n━━ 列表分页');
  const all = await svc.authList({ Top: '5', Skip: '0' });
  const page2 = await svc.authList({ Top: '5', Skip: '5' });
  check('分页：总数一致、第二页不与第一页重叠', all.total > 5 && all.requests.length === 5 && page2.total === all.total && page2.requests.every((x) => !all.requests.some((y) => y.reqId === x.reqId)));

  console.log(`\n━━ 结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
