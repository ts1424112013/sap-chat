function unwrap(payload, action) {
  const root = payload?.d ?? payload;
  return root?.[action] && typeof root[action] === 'object' ? root[action] : root;
}

function cookiesFrom(response) {
  const entries = response.headers.getSetCookie?.() ?? [];
  return entries.map((entry) => entry.split(';', 1)[0]).join('; ');
}

function mergeCookies(previous, response) {
  const pairs = new Map();
  for (const part of [previous, cookiesFrom(response)].filter(Boolean).join('; ').split('; ')) {
    const pos = part.indexOf('=');
    if (pos > 0) pairs.set(part.slice(0, pos), part.slice(pos + 1));
  }
  return [...pairs].map(([key, value]) => `${key}=${value}`).join('; ');
}

export class SapClient {
  constructor(env = process.env) {
    if (!env.SAP_ODATA_URL || !env.SAP_USER || !env.SAP_PASSWORD) {
      throw new Error('请设置 SAP_ODATA_URL、SAP_USER 和 SAP_PASSWORD。');
    }
    this.base = new URL(env.SAP_ODATA_URL);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) {
      throw new Error('SAP_ODATA_URL 必须是无凭据、无查询参数的 HTTP(S) 服务地址。');
    }
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/';
    if (env.SAP_CLIENT && !/^\d{3}$/.test(env.SAP_CLIENT)) throw new Error('SAP_CLIENT 必须是三位数字。');
    this.sapClient = env.SAP_CLIENT;
    this.auth = `Basic ${Buffer.from(`${env.SAP_USER}:${env.SAP_PASSWORD}`, 'utf8').toString('base64')}`;
  }

  url(action, params = {}) {
    const url = new URL(action, this.base);
    if (this.sapClient) url.searchParams.set('sap-client', this.sapClient);
    // Function Import 参数为 OData 字符串字面量；内部单引号需双写。
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, `'${String(value).replace(/'/g, "''")}'`);
    }
    return url;
  }

  async request(action, { method = 'GET', headers = {}, params = {}, signal } = {}) {
    const response = await fetch(this.url(action, params), {
      method, headers: { Accept: 'application/json', Authorization: this.auth, ...headers },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`SAP ${action} 请求失败（HTTP ${response.status}）。`);
    return response;
  }

  async login(signal) {
    const metadata = await this.request('$metadata', { headers: { 'x-csrf-token': 'fetch' }, signal });
    const token = metadata.headers.get('x-csrf-token');
    if (!token || token.toLowerCase() === 'required') throw new Error('SAP 未返回 CSRF 令牌，无法验证灵犀账号。');
    let cookies = mergeCookies('', metadata);
    const response = await this.request('Login', {
      method: 'POST', headers: { 'x-csrf-token': token, ...(cookies ? { Cookie: cookies } : {}) }, signal
    });
    cookies = mergeCookies(cookies, response);
    const result = unwrap(await response.json(), 'Login');
    if (result?.Success !== 'X') throw new Error(result?.Message || '当前 SAP 用户未开通灵犀。');
    let user;
    try { user = JSON.parse(result.Json || '{}'); } catch { throw new Error('灵犀登录信息格式错误。'); }
    return { cookies, user };
  }

  async call(action, params, scene, signal) {
    const { cookies, user } = await this.login(signal);
    const scenes = String(user.Scenes || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (user.Role !== 'ADMIN' && scenes.length && !scenes.includes(scene)) {
      throw new Error(`当前用户未开放${scene === 'FIORI' ? 'Fiori 报表' : '报表执行'}场景。`);
    }
    const response = await this.request(action, { params, headers: cookies ? { Cookie: cookies } : {}, signal });
    const result = unwrap(await response.json(), action);
    if (result?.Success !== 'X') throw new Error(result?.Message || `SAP ${action} 返回失败。`);
    let data = null;
    if (result.ResultJson) {
      try { data = JSON.parse(result.ResultJson); } catch { throw new Error(`SAP ${action} 返回了无法解析的数据。`); }
    }
    return { message: result.Message || '', data };
  }
}
