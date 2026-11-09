/**
 * MCP 连接 M1（《03》〇-AU）参考测试：ABAP 在本地跑不了，这里把 ZCL_AI_MCP_CLIENT 的 JSON 小解析器
 * （skip_ws / skip_value / json_member / json_items / sse_pick）和握手顺序逐行照抄成 JS，
 * 对着模拟 MCP 服务（local-mcp/test/mock-mcp-http.mjs）走一遍：initialize → 会话号 → tools/list 翻页 →
 * tools/call（JSON 与 SSE 两种回应）→ 结果取法同 ZCL_AI_MCP_SERVICE=>call → 改了工具定义指纹会变。
 * 改 ABAP 的解析或握手时，同步改这里。
 * 运行: node mcp-client-ref-tests.js   （或 npm run test:mcp）
 */
const path = require('path');
const crypto = require('crypto');

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  —— ' + info : '')); }
}

/* ---------- 照抄 ZCL_AI_MCP_CLIENT 的解析 ---------- */
const charAt = (s, i) => (i >= 0 && i < s.length ? s[i] : '');
function skipWs(s, p) {
  let r = p;
  while (r < s.length) { const c = s[r]; if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { r++; } else { break; } }
  return r;
}
function skipValue(s, p) {
  let r = p; const n = s.length;
  if (r >= n) { return r; }
  let c = s[r];
  if (c === '"') {
    r++;
    while (r < n) { c = s[r]; if (c === '\\') { r += 2; continue; } r++; if (c === '"') { return r; } }
    return n + 1;
  }
  if (c === '{' || c === '[') {
    let d = 0;
    while (r < n) {
      c = s[r];
      if (c === '"') { r = skipValue(s, r); continue; }
      if (c === '{' || c === '[') { d++; } else if (c === '}' || c === ']') { d--; if (d === 0) { return r + 1; } }
      r++;
    }
    return n + 1;
  }
  while (r < n) { c = s[r]; if (c === ',' || c === '}' || c === ']' || c === ' ' || c === '\n' || c === '\t') { break; } r++; }
  return r;
}
function jsonMember(s, key) {
  const n = s.length; let p = skipWs(s, 0);
  if (charAt(s, p) !== '{') { return ''; }
  p++;
  const want = '"' + key + '"';
  for (;;) {
    p = skipWs(s, p);
    if (charAt(s, p) !== '"') { return ''; }
    const ke = skipValue(s, p); if (ke <= p || ke > n) { return ''; }
    const k = s.slice(p, ke);
    p = skipWs(s, ke); if (charAt(s, p) !== ':') { return ''; }
    p = skipWs(s, p + 1);
    const ve = skipValue(s, p); if (ve <= p || ve > n) { return ''; }
    if (k === want) { return s.slice(p, ve); }
    p = skipWs(s, ve); if (charAt(s, p) !== ',') { return ''; }
    p++;
  }
}
function jsonItems(s) {
  const n = s.length, out = []; let p = skipWs(s, 0);
  if (charAt(s, p) !== '[') { return out; }
  p++;
  for (;;) {
    p = skipWs(s, p);
    const c = charAt(s, p); if (!c || c === ']') { return out; }
    const e = skipValue(s, p); if (e <= p || e > n) { return out; }
    out.push(s.slice(p, e));
    p = skipWs(s, e); if (charAt(s, p) !== ',') { return out; }
    p++;
  }
}
function jsonString(raw) {
  if (!raw || raw[0] !== '"') { return raw === 'null' ? '' : raw; }
  try { return JSON.parse(raw); } catch (e) { return raw.slice(1, -1); }
}
function ssePick(body, id) {
  const lines = body.replace(/\r\n/g, '\n').split('\n'); lines.push('');
  let data = '';
  for (const l of lines) {
    if (l === '') { if (data) { if (jsonMember(data, 'id') === String(id)) { return data; } data = ''; } continue; }
    if (l.length >= 5 && l.slice(0, 5) === 'data:') { let d = l.slice(5); if (d[0] === ' ') { d = d.slice(1); } data = data ? data + '\n' + d : d; }
  }
  return '';
}

/* ---------- 照抄握手 / 请求头 ---------- */
function makeClient(url, user) {
  let session = '', proto = '', id = 0;
  async function post(body) {
    const h = { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json, text/event-stream' };
    if (proto) { h['MCP-Protocol-Version'] = proto; }
    if (session) { h['Mcp-Session-Id'] = session; }
    if (user) { h['X-Lingxi-User'] = user; }
    const res = await fetch(url, { method: 'POST', headers: h, body });
    const sid = res.headers.get('mcp-session-id'); if (sid) { session = sid; }
    return { code: res.status, resp: await res.text(), ctype: (res.headers.get('content-type') || '').toLowerCase() };
  }
  async function rpc(method, params) {
    id++;
    const body = `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)}` + (params ? `,"params":${params}` : '') + '}';
    const r = await post(body);
    if (r.code < 200 || r.code >= 300) { return { error: `MCP 服务返回 HTTP ${r.code}: ${r.resp.slice(0, 300)}` }; }
    const msg = r.ctype.includes('text/event-stream') ? ssePick(r.resp, id) : r.resp;
    if (!msg) { return { error: 'MCP 服务没有返回本次请求的结果' }; }
    const e = jsonMember(msg, 'error');
    if (e && e !== 'null') { return { error: 'MCP 错误: ' + (jsonString(jsonMember(e, 'message')) || e) }; }
    return { result: jsonMember(msg, 'result') };
  }
  return {
    get session() { return session; },
    async initialize() {
      const r = await rpc('initialize', '{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"lingxi-sap","version":"1.0"}}');
      if (r.error) { return r; }
      proto = jsonString(jsonMember(r.result, 'protocolVersion')) || '2025-03-26';
      await post(`{"jsonrpc":"2.0","method":"notifications/initialized"}`);
      const info = jsonMember(r.result, 'serverInfo');
      return { name: jsonString(jsonMember(info, 'name')), version: jsonString(jsonMember(info, 'version')), proto };
    },
    async listTools() {
      let cursor = '', out = [];
      for (let i = 0; i < 20; i++) {
        const r = await rpc('tools/list', cursor ? `{"cursor":${cursor}}` : '');
        if (r.error) { return r; }
        out = out.concat(jsonItems(jsonMember(r.result, 'tools')));
        cursor = jsonMember(r.result, 'nextCursor');
        if (!cursor || cursor === 'null' || cursor === '""') { break; }
      }
      return { tools: out };
    },
    callTool(name, args) { return rpc('tools/call', `{"name":${JSON.stringify(name)},"arguments":${args || '{}'}}`); }
  };
}

/* ---------- 照抄 ZCL_AI_MCP_SERVICE=>call 的结果取法 ---------- */
function resultText(res) {
  const isErr = jsonMember(res, 'isError') === 'true';
  let text = '';
  for (const part of jsonItems(jsonMember(res, 'content'))) {
    const type = jsonString(jsonMember(part, 'type'));
    const piece = type === 'text' ? jsonString(jsonMember(part, 'text')) : `[${type} 类型的内容, 未显示]`;
    text = text ? text + '\n' + piece : piece;
  }
  const st = jsonMember(res, 'structuredContent');
  if (!text && st && st !== 'null') { text = st; }
  return { isErr, text };
}
const fingerprint = (desc, schema) => crypto.createHash('md5').update(desc + '\n' + schema).digest('hex');
const llmName = (srv, tool) => ('mcp_' + srv + '_' + tool).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);

(async () => {
  const { startMock } = await import(path.join(__dirname, '../local-mcp/test/mock-mcp-http.mjs'));
  const server = await startMock(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/mcp`;
  try {
    console.log('\n━━ MCP 客户端参考实现（对模拟 Streamable HTTP 服务）');
    for (const mode of ['json', 'sse']) {
      const c = makeClient(base + (mode === 'sse' ? '?sse=1' : ''), 'ZHANGSAN');
      const init = await c.initialize();
      check(`[${mode}] initialize：服务名 / 版本 / 协议版本，拿到会话号`,
        init.name === 'mock-mcp' && init.version === '0.1.0' && init.proto === '2025-03-26' && !!c.session, JSON.stringify(init));
      const lt = await c.listTools();
      const names = (lt.tools || []).map((t) => jsonString(jsonMember(t, 'name')));
      check(`[${mode}] tools/list 翻页拿全 3 个工具`, names.join(',') === 'get_material,list_plants,post_goods_movement', names.join(','));
      const ro = (lt.tools || []).map((t) => jsonMember(jsonMember(t, 'annotations'), 'readOnlyHint') === 'true' ? 'READ' : 'WRITE');
      check(`[${mode}] 只读标注：有 readOnlyHint 的预填只读，没标注的当会改数据`, ro.join(',') === 'READ,READ,WRITE', ro.join(','));
      const schema = jsonMember(lt.tools[0], 'inputSchema');
      const req = jsonItems(jsonMember(schema, 'required')).map(jsonString);
      check(`[${mode}] 参数结构原文可解析、required 取得到`, JSON.parse(schema).properties.matnr.type === 'string' && req.join() === 'matnr');
      const call = await c.callTool('get_material', '{"matnr":"100-200"}');
      const rt = resultText(call.result || '');
      check(`[${mode}] tools/call：文本内容取得到、带上了调用人（用户本人模式的请求头）`,
        !call.error && !rt.isErr && /100-200/.test(rt.text) && /ZHANGSAN/.test(rt.text), call.error || rt.text);
      const bad = await c.callTool('nope', '{}');
      check(`[${mode}] 不存在的工具 → JSON-RPC error 转成错误信息`, /^MCP 错误: 没有这个工具/.test(bad.error || ''), bad.error);
      const miss = await c.callTool('get_material', '{}');
      check(`[${mode}] 服务返回 isError = true 时当失败`, resultText(miss.result || '').isErr === true);
    }
    const noSess = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    check('没带会话号直接调 → 服务拒绝（所以每次都先 initialize）', noSess.status === 400);

    const c2 = makeClient(base);
    await c2.initialize();
    const before = (await c2.listTools()).tools[0];
    await fetch(`http://127.0.0.1:${port}/flip`, { method: 'POST' });
    const after = (await c2.listTools()).tools[0];
    const fp = (t) => fingerprint(jsonString(jsonMember(t, 'description')), jsonMember(t, 'inputSchema'));
    check('服务改了工具说明 → 指纹变化（SAP 据此自动停用、标待复核）', fp(before) !== fp(after));
    check('给模型的工具名 mcp_<服务>_<工具>：小写、只留字母数字下划线、≤ 64',
      llmName('SAPMCP', 'get-Material.v2') === 'mcp_sapmcp_get_material_v2' && llmName('S', 'x'.repeat(80)).length === 64);
  } finally {
    server.close();
  }
  console.log('\n' + (fail === 0 ? '全部通过: ' + pass + ' 项' : '失败: ' + fail + ' 项 / 通过: ' + pass + ' 项'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
