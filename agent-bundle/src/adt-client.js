/**
 * ADT 代码工具（只读）：浏览器直接调本机 SAP 的 /sap/bc/adt，用用户自己的登录。
 * 方案见 功能计划书/Deep Agents浏览器接入/03-ADT代码工具方案。
 *
 * 安全边界：
 *   - 只拼白名单里的几类对象地址（报表 / 包含程序 / 类 / 接口 / 函数组与函数 / CDS / 表 / 结构 / 数据元素 / 域 / 包），
 *     模型给不了任意 URL；不碰 datapreview（自由 SQL）、写源码、加锁、激活、执行代码。
 *   - 权限由 SAP 自己判断（S_ADT_RES / S_DEVELOP）；没权限时如实告诉模型。
 *   - 每次调用先向灵犀 SAP 服务报备（/tools/audit：校验运行号、计入工具次数、写审计），被拒就不调。
 */

export const ADT_ROOT = "/sap/bc/adt";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const PAGE_LINES = 400;
const MAX_HITS = 60;
const MAX_CHECK_BYTES = 1024 * 1024;

/** 对象名：字母数字下划线，可带命名空间（/ABC/ 或 %2fabc%2f），$ 开头的本地包 */
const NAME = "(?:%2f[a-z0-9_]+%2f|/[a-z0-9_]+/)?(?:%24|\\$)?[a-z0-9_]+";
const URI_RE = new RegExp(
  "^/sap/bc/adt/(?:" +
    "(programs/programs|programs/includes|oo/interfaces|ddic/ddl/sources|ddic/tables|ddic/structures|ddic/dataelements|ddic/domains|packages)/" + NAME +
    "|oo/classes/" + NAME + "(?:/includes/(?:definitions|implementations|macros|testclasses))?" +
    "|functions/groups/" + NAME + "(?:/fmodules/" + NAME + ")?" +
  ")$");

/** 能做语法检查 / 有源码的对象（不含包、域、数据元素） */
const SOURCE_RE = /^\/sap\/bc\/adt\/(programs\/|oo\/|functions\/|ddic\/ddl\/|ddic\/tables\/|ddic\/structures\/)/;

/** 搜索时可选的类型（简写 → ADT 类型） */
export const ADT_TYPES = {
  CLAS: "CLAS/OC", INTF: "INTF/OI", PROG: "PROG/P", INCL: "PROG/I", FUGR: "FUGR/F", FUNC: "FUGR/FF",
  DDLS: "DDLS/DF", TABL: "TABL/DT", STRU: "TABL/DS", DTEL: "DTEL/DE", DOMA: "DOMA/DD", DEVC: "DEVC/K"
};
const TYPE_ZH = {
  "CLAS/OC": "类", "INTF/OI": "接口", "PROG/P": "报表", "PROG/I": "包含程序", "FUGR/F": "函数组", "FUGR/FF": "函数",
  "DDLS/DF": "CDS", "TABL/DT": "表", "TABL/DS": "结构", "DTEL/DE": "数据元素", "DOMA/DD": "域", "DEVC/K": "包"
};

/** 规范化并校验对象地址；不合法返回空串 */
export function normalizeUri(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  try { if (/^https?:/i.test(s)) s = new URL(s).pathname; } catch (e) { return ""; }
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  s = s.replace(/\/source\/main$/i, "");
  s = s.toLowerCase();
  if (/\.\.|\/\//.test(s)) return "";
  return URI_RE.test(s) ? s : "";
}

/** 模型给的对象名：只允许名字字符，统一大写 */
function cleanName(s, allowStar) {
  const v = String(s || "").trim().toUpperCase();
  const re = allowStar ? /^[A-Z0-9_/$*]{1,40}$/ : /^[A-Z0-9_/$]{1,40}$/;
  return re.test(v) ? v : "";
}

function attr(el, local) {
  if (!el || !el.attributes) return "";
  for (const a of el.attributes) if (a.localName === local) return a.value;
  return "";
}
function all(doc, local) {
  return doc ? Array.from(doc.getElementsByTagNameNS("*", local)) : [];
}
function parseXml(text) {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    return doc.getElementsByTagName("parsererror").length ? null : doc;
  } catch (e) { return null; }
}
/** ADT 错误回应 <exc:exception><message>…</message> 里的说明 */
function excMessage(text) {
  const doc = parseXml(text || "");
  const m = doc && (all(doc, "localizedMessage")[0] || all(doc, "message")[0]);
  return m ? m.textContent.trim().slice(0, 300) : "";
}
/** 链接里的 #start=行,列 */
function lineOf(href) {
  const m = /[#&]start=(\d+)/.exec(String(href || ""));
  return m ? Number(m[1]) : 0;
}

/** UTF-8 文本 → base64（分段，避免长代码撑爆参数） */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class AdtError extends Error {
  constructor(message, status) { super(message); this.name = "AdtError"; this.status = status; }
}

/**
 * @param {object} o
 * @param {(path:string, init:object)=>Promise<Response>} o.fetch  已带同源、Cookie、sap-client 的请求函数（path 以 /sap/bc/adt 开头）
 */
export function createAdtClient({ fetch: f }) {
  let csrf = "";

  async function call(path, { method = "GET", accept = "application/*", body, contentType, signal, csrfRetry = true } = {}) {
    if (!path.startsWith(ADT_ROOT + "/")) throw new AdtError("ADT 地址不合法", 0);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error("timeout")), TIMEOUT_MS);
    const onAbort = () => ctl.abort(signal.reason);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    const headers = { Accept: accept };
    if (contentType) headers["Content-Type"] = contentType;
    if (method !== "GET") {
      if (!csrf) csrf = await fetchToken(signal);
      headers["x-csrf-token"] = csrf;
    }
    let res, text;
    try {
      res = await f(path, { method, headers, body, signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      if (signal && signal.aborted) throw e;
      throw new AdtError(ctl.signal.aborted ? "ADT 请求超时（60 秒）" : "连不上 ADT 服务：" + ((e && e.message) || e), 0);
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    // 令牌过期：重取一次再试
    if (res.status === 403 && method !== "GET" && csrfRetry && /required/i.test(res.headers.get("x-csrf-token") || "")) {
      csrf = "";
      return call(path, { method, accept, body, contentType, signal, csrfRetry: false });
    }
    if (!res.ok) {
      const why = excMessage(text);
      if (res.status === 401 || res.status === 403) throw new AdtError("没有权限" + (why ? "：" + why : "（SAP 返回 " + res.status + "）"), res.status);
      if (res.status === 404) throw new AdtError("对象不存在，或这类对象不支持这个操作" + (why ? "：" + why : ""), 404);
      throw new AdtError(`ADT 返回 ${res.status}` + (why ? "：" + why : ""), res.status);
    }
    const truncated = text.length > MAX_BYTES;
    return { text: truncated ? text.slice(0, MAX_BYTES) : text, truncated };
  }

  async function fetchToken(signal) {
    const res = await f(ADT_ROOT + "/discovery", { method: "GET", headers: { "x-csrf-token": "fetch", Accept: "application/atomsvc+xml" }, signal });
    const tok = res.headers.get("x-csrf-token") || "";
    try { await res.text(); } catch (e) { /* 只要令牌 */ }
    if (!res.ok || !tok || /required/i.test(tok)) {
      throw new AdtError(res.status === 401 || res.status === 403 ? "没有 ADT 权限（SAP 返回 " + res.status + "）" : "取不到 ADT 令牌（SAP 返回 " + res.status + "）", res.status);
    }
    return tok;
  }

  /** 按名字搜对象 → [{ name, type, typeText, description, package, uri }] */
  async function search(query, type, max, signal) {
    const q = cleanName(query, true);
    if (!q) throw new AdtError("query 只能是对象名（字母、数字、下划线、命名空间 /ABC/），可用 * 通配", 0);
    let path = `${ADT_ROOT}/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(q)}&maxResults=${max || 50}`;
    const ty = type ? (ADT_TYPES[String(type).toUpperCase()] || String(type).toUpperCase()) : "";
    if (ty) {
      if (!Object.values(ADT_TYPES).includes(ty)) throw new AdtError("type 只能是 " + Object.keys(ADT_TYPES).join(" / "), 0);
      path += "&objectType=" + encodeURIComponent(ty);
    }
    const r = await call(path, { accept: "application/xml", signal });
    const doc = parseXml(r.text);
    if (!doc) throw new AdtError("ADT 搜索结果解析失败", 0);
    return all(doc, "objectReference").map(el => {
      const t = attr(el, "type");
      return { name: attr(el, "name"), type: t, typeText: TYPE_ZH[t] || t, description: attr(el, "description"),
        package: attr(el, "packageName"), uri: normalizeUri(attr(el, "uri")) };
    }).filter(o => o.name);
  }

  /** object = 对象地址或对象名；名字时按名字精确搜，拿第一个能用的地址 */
  async function resolve(object, preferType, signal) {
    const s = String(object || "").trim();
    if (!s) throw new AdtError("缺少 object（对象名或 adt_search 返回的对象地址）", 0);
    if (/^(https?:\/\/[^/]+)?\/sap\/bc\/adt\//i.test(s)) {
      const u = normalizeUri(s);
      if (!u) throw new AdtError("对象地址不在允许范围内（只能读报表 / 包含程序 / 类 / 接口 / 函数 / CDS / 表 / 结构 / 数据元素 / 域 / 包）", 0);
      return { uri: u, name: decodeURIComponent(u.split("/").pop()).toUpperCase(), type: "" };
    }
    const name = cleanName(s, false);
    if (!name) throw new AdtError("对象名不合法：" + s.slice(0, 40), 0);
    const list = (await search(name, preferType, 20, signal)).filter(o => o.name.toUpperCase() === name && o.uri);
    if (!list.length) throw new AdtError(`没有找到对象 ${name}（或没有权限看到它）`, 404);
    const order = ["CLAS/OC", "PROG/P", "INTF/OI", "FUGR/FF", "DDLS/DF", "TABL/DT", "TABL/DS", "PROG/I", "FUGR/F", "DTEL/DE", "DOMA/DD", "DEVC/K"];
    list.sort((a, b) => (order.indexOf(a.type) + 1 || 99) - (order.indexOf(b.type) + 1 || 99));
    return list[0];
  }

  /** 源码（带行号分页 / 按关键字找行）；域、数据元素没有源码 → 读定义 */
  async function readSource({ object, include, start_line, max_lines, keyword }, signal) {
    const o = await resolve(object, "", signal);
    let uri = o.uri;
    if (/\/(ddic\/domains|ddic\/dataelements|packages)\//.test(uri)) return readDefinition(o, signal);
    if (include) {
      const inc = String(include).toLowerCase();
      if (!/^(definitions|implementations|macros|testclasses)$/.test(inc) || !/^\/sap\/bc\/adt\/oo\/classes\/[^/]+$/.test(uri)) {
        throw new AdtError("include 只能用于类：definitions / implementations / macros / testclasses", 0);
      }
      uri += "/includes/" + inc;
    }
    const r = await call(uri + "/source/main", { accept: "text/plain", signal });
    const lines = r.text.replace(/\r\n/g, "\n").split("\n");
    const total = lines.length;
    const head = `${o.name}${o.type ? "（" + (TYPE_ZH[o.type] || o.type) + "）" : ""} 共 ${total} 行` + (r.truncated ? "（源码超过 2 MB，只取了前面部分）" : "");
    const kw = String(keyword || "").trim();
    if (kw) {
      const k = kw.toLowerCase();
      const hits = [];
      lines.forEach((l, i) => { if (l.toLowerCase().includes(k)) hits.push(i); });
      if (!hits.length) return { text: `${head}；没有找到「${kw}」。`, rows: 0, total };
      const keep = new Set();
      for (const h of hits.slice(0, MAX_HITS)) for (let i = Math.max(0, h - 3); i <= Math.min(total - 1, h + 3); i++) keep.add(i);
      const out = [];
      let prev = -2;
      for (const i of [...keep].sort((a, b) => a - b)) {
        if (i !== prev + 1) out.push("…");
        out.push(`${String(i + 1).padStart(5)}  ${lines[i]}`);
        prev = i;
      }
      return { text: `${head}；「${kw}」命中 ${hits.length} 处` + (hits.length > MAX_HITS ? `（只列前 ${MAX_HITS} 处）` : "") + "：\n" + out.join("\n"), rows: hits.length, total };
    }
    const from = Math.max(1, Math.floor(Number(start_line) || 1));
    const n = Math.min(PAGE_LINES, Math.max(1, Math.floor(Number(max_lines) || PAGE_LINES)));
    const to = Math.min(total, from + n - 1);
    if (from > total) return { text: `${head}；start_line ${from} 超出范围。`, rows: 0, total };
    const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");
    const more = to < total ? `\n…还有 ${total - to} 行，继续读用 start_line=${to + 1}` : "";
    return { text: `${head}，第 ${from}–${to} 行：\n${body}${more}`, rows: to - from + 1, total };
  }

  /** 域（固定值）/ 数据元素 / 包 的定义摘要 */
  async function readDefinition(o, signal) {
    const r = await call(o.uri, { accept: "application/*", signal });
    const doc = parseXml(r.text);
    if (!doc) return { text: r.text.slice(0, 4000), rows: 0 };
    const root = doc.documentElement;
    const out = [`${attr(root, "name") || o.name} ${attr(root, "description")}`.trim()];
    const pick = loc => { const e = all(doc, loc)[0]; return e ? e.textContent.trim() : ""; };
    const dt = pick("datatype") || pick("dataType");
    if (dt) out.push(`类型 ${dt} 长度 ${Number(pick("length")) || ""}${Number(pick("decimals")) ? " 小数 " + Number(pick("decimals")) : ""}`);
    const dom = all(doc, "typeName")[0];
    if (dom && dom.textContent.trim()) out.push("域 / 类型：" + dom.textContent.trim());
    const fix = all(doc, "fixValue").map(fv => {
      const g = loc => { const e = Array.from(fv.children).find(c => c.localName === loc); return e ? e.textContent.trim() : ""; };
      return `${g("low")}${g("high") ? "–" + g("high") : ""}  ${g("text")}`;
    });
    if (fix.length) out.push(`固定值（${fix.length} 个）：\n` + fix.slice(0, 200).join("\n"));
    const vt = all(doc, "valueTableRef")[0];
    if (vt && attr(vt, "name")) out.push("值表：" + attr(vt, "name"));
    for (const loc of ["shortFieldLabel", "mediumFieldLabel", "longFieldLabel", "headingFieldLabel"]) {
      const e = all(doc, loc)[0];
      if (e && e.textContent.trim()) { out.push("字段标签：" + e.textContent.trim()); break; }
    }
    return { text: out.join("\n"), rows: fix.length };
  }

  /** 对象结构：方法 / 属性 / FORM / 包含程序（带起始行） */
  async function structure({ object }, signal) {
    const o = await resolve(object, "", signal);
    if (!SOURCE_RE.test(o.uri)) throw new AdtError("只有程序、类、接口、函数、CDS 有结构视图", 0);
    const r = await call(o.uri + "/objectstructure", { accept: "application/*", signal });
    const doc = parseXml(r.text);
    if (!doc) throw new AdtError("结构解析失败", 0);
    const items = [];
    const walk = (el, depth) => {
      for (const c of Array.from(el.children)) {
        if (c.localName !== "objectStructureElement") continue;
        const link = Array.from(c.children).find(x => x.localName === "link" && /start=/.test(attr(x, "href")));
        const vis = attr(c, "visibility");
        const extra = [vis && vis !== "unknown" ? vis : "", attr(c, "level") === "static" ? "static" : ""].filter(Boolean).join(" ");
        items.push(`${"  ".repeat(depth)}${attr(c, "name")}  ${attr(c, "type")}${extra ? " " + extra : ""}${link ? "  行 " + lineOf(attr(link, "href")) : ""}${attr(c, "description") ? "  " + attr(c, "description") : ""}`);
        if (items.length < 400) walk(c, depth + 1);
      }
    };
    walk(doc.documentElement, 0);
    if (!items.length) return { text: `${o.name} 没有可列出的结构；用 adt_read_source 的 keyword 定位。`, rows: 0 };
    return { text: `${o.name} 的结构（${items.length} 项）：\n` + items.slice(0, 400).join("\n"), rows: items.length };
  }

  /** 被谁使用（where-used） */
  async function whereUsed({ object }, signal) {
    const o = await resolve(object, "", signal);
    const body = `<?xml version="1.0" encoding="ASCII"?>` +
      `<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">` +
      `<usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>`;
    const r = await call(`${ADT_ROOT}/repository/informationsystem/usageReferences?uri=${encodeURIComponent(o.uri)}`, {
      method: "POST", body,
      contentType: "application/vnd.sap.adt.repository.usagereferences.request.v1+xml",
      accept: "application/vnd.sap.adt.repository.usagereferences.result.v1+xml", signal
    });
    const doc = parseXml(r.text);
    if (!doc) throw new AdtError("被使用清单解析失败", 0);
    const refs = all(doc, "referencedObject");
    const results = refs.filter(el => attr(el, "isResult") === "true");
    const list = (results.length ? results : refs).map(el => {
      const ao = Array.from(el.children).find(c => c.localName === "adtObject") || el;
      const pk = Array.from(ao.children || []).find(c => c.localName === "packageRef");
      const t = attr(ao, "type");
      return { name: attr(ao, "name"), type: TYPE_ZH[t] || t, package: pk ? attr(pk, "name") : "", description: attr(ao, "description"), usage: attr(el, "usageInformation") };
    }).filter(x => x.name && x.name.toUpperCase() !== o.name);
    if (!list.length) return { text: `没有找到使用 ${o.name} 的对象。`, rows: 0 };
    const shown = list.slice(0, 200);
    return { text: `使用 ${o.name} 的对象共 ${list.length} 个` + (list.length > 200 ? "（只列前 200 个）" : "") + "：\n" +
      shown.map(x => `${x.name}  ${x.type}${x.package ? "  包 " + x.package : ""}${x.description ? "  " + x.description : ""}`).join("\n"), rows: list.length };
  }

  /** 包里的对象（按类型分组） */
  async function packageContents({ package: pkg }, signal) {
    const name = cleanName(pkg, false);
    if (!name) throw new AdtError("package 只能是包名", 0);
    const r = await call(`${ADT_ROOT}/repository/nodestructure?parent_type=DEVC%2FK&parent_name=${encodeURIComponent(name)}&withShortDescriptions=true`, {
      method: "POST", accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.RepositoryObjectTreeContent", signal
    });
    const doc = parseXml(r.text);
    if (!doc) throw new AdtError("包内容解析失败", 0);
    const nodes = all(doc, "SEU_ADT_REPOSITORY_OBJ_NODE").map(n => {
      const g = loc => { const e = Array.from(n.children).find(c => c.localName === loc); return e ? e.textContent.trim() : ""; };
      return { type: g("OBJECT_TYPE"), name: g("OBJECT_NAME"), description: g("DESCRIPTION") };
    }).filter(x => x.name);
    if (!nodes.length) return { text: `包 ${name} 里没有对象，或包不存在。`, rows: 0 };
    const groups = {};
    for (const x of nodes) (groups[x.type] = groups[x.type] || []).push(x);
    const out = Object.keys(groups).sort().map(t => `【${TYPE_ZH[t] || t}】${groups[t].length} 个\n` +
      groups[t].slice(0, 150).map(x => `  ${x.name}${x.description ? "  " + x.description : ""}`).join("\n") +
      (groups[t].length > 150 ? `\n  …还有 ${groups[t].length - 150} 个` : ""));
    return { text: `包 ${name} 共 ${nodes.length} 个对象：\n` + out.join("\n"), rows: nodes.length };
  }

  /**
   * 语法检查。只给 object：查 SAP 里已激活的版本。
   * 同时给 source（或 file，由调用方先读成文本放进 source）：把这段代码当作对象的新内容交给 SAP 检查，
   * 只走 checkruns，不保存、不加锁、不激活，SAP 上的对象不变。
   */
  async function syntaxCheck({ object, include, source, sourceLabel }, signal) {
    const o = await resolve(object, "", signal);
    if (!SOURCE_RE.test(o.uri)) throw new AdtError("只有程序、类、接口、函数、CDS 能做语法检查", 0);
    let main = o.uri;
    if (include) {
      const inc = String(include).toLowerCase();
      if (!/^(definitions|implementations|macros|testclasses)$/.test(inc) || !/^\/sap\/bc\/adt\/oo\/classes\/[^/]+$/.test(o.uri)) {
        throw new AdtError("include 只能用于类：definitions / implementations / macros / testclasses", 0);
      }
      main = o.uri + "/includes/" + inc;
    }
    const hasSrc = typeof source === "string" && source.trim() !== "";
    if (typeof source === "string" && !hasSrc) throw new AdtError("source 是空的，没有可检查的代码", 0);
    const srcLines = hasSrc ? source.replace(/\r\n/g, "\n").split("\n") : [];
    if (hasSrc && new TextEncoder().encode(source).length > MAX_CHECK_BYTES) throw new AdtError("代码超过 1 MB，请拆小后再检查", 0);
    const artifactUri = main + "/source/main";
    const inner = hasSrc
      ? `<chkrun:artifacts><chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${artifactUri}">` +
        `<chkrun:content>${toBase64(srcLines.join("\r\n"))}</chkrun:content></chkrun:artifact></chkrun:artifacts>`
      : "";
    const body = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<chkrun:checkObject adtcore:uri="${o.uri}" chkrun:version="active">${inner}</chkrun:checkObject></chkrun:checkObjectList>`;
    const r = await call(`${ADT_ROOT}/checkruns?reporters=abapCheckRun`, {
      method: "POST", body, contentType: "application/vnd.sap.adt.checkobjects+xml",
      accept: "application/vnd.sap.adt.checkmessages+xml", signal
    });
    const doc = parseXml(r.text);
    if (!doc) throw new AdtError("语法检查结果解析失败", 0);
    const msgs = all(doc, "checkMessage").map(m => {
      const ty = attr(m, "type");
      const href = attr(m, "uri");
      const path = decodeURIComponent((href.split("#")[0] || "")).toLowerCase();
      const line = lineOf(href);
      // 指向这次交上去的代码时，把那一行原文带上，模型不用再回头找
      const code = hasSrc && line && path === artifactUri && srcLines[line - 1] != null ? srcLines[line - 1].trim().slice(0, 160) : "";
      return { type: ty === "E" ? "错误" : ty === "W" ? "警告" : "提示", line, text: attr(m, "shortText"), code,
        where: hasSrc && path === artifactUri ? "" : path.split("/").slice(-3).join("/") };
    });
    const what = hasSrc
      ? `${o.name}${include ? " " + String(include).toLowerCase() : ""}（${sourceLabel || "交来的代码"}，${srcLines.length} 行，只检查、未保存）`
      : `${o.name}（已激活版本）`;
    const nErr = msgs.filter(m => m.type === "错误").length;
    if (!msgs.length) return { text: `${what}语法检查通过，没有错误和警告。`, rows: 0 };
    return { text: `${what}语法检查：错误 ${nErr} 个，警告 / 提示 ${msgs.length - nErr} 个：\n` +
      msgs.slice(0, 100).map(m => `${m.type}  行 ${m.line || "?"}  ${m.text}${m.where ? "  （" + m.where + "）" : ""}${m.code ? "\n      代码：" + m.code : ""}`).join("\n"), rows: msgs.length };
  }

  return { call, search, resolve, readSource, structure, whereUsed, packageContents, syntaxCheck };
}

/** 六个工具的说明与参数（给模型） */
export const ADT_TOOL_SPECS = [
  {
    name: "adt_search",
    description: "按名字搜 SAP 开发对象（类、报表、函数、CDS、表等），可用 * 通配。返回对象名、类型、说明、包和对象地址。",
    schema: { type: "object", properties: {
      query: { type: "string", description: "对象名或带 * 的名字，如 ZCL_AI_* 、*RPT*" },
      type: { type: "string", description: "可选，只搜一类：" + Object.keys(ADT_TYPES).join(" / ") }
    }, required: ["query"] }
  },
  {
    name: "adt_read_source",
    description: "读对象源码（带行号，每次最多 400 行，可翻页），或用 keyword 只看命中行和前后 3 行。域 / 数据元素返回定义和固定值。",
    schema: { type: "object", properties: {
      object: { type: "string", description: "对象名（如 ZCL_AI_AGENT_SERVICE）或 adt_search 返回的对象地址" },
      start_line: { type: "integer", description: "从第几行开始，默认 1" },
      max_lines: { type: "integer", description: "最多读几行，默认且最多 400" },
      keyword: { type: "string", description: "可选：只返回包含这个词的行（不分大小写）" },
      include: { type: "string", description: "可选，类的局部部分：definitions / implementations / macros / testclasses" }
    }, required: ["object"] }
  },
  {
    name: "adt_structure",
    description: "看对象结构：类的方法 / 属性、程序的 FORM / 包含程序等，带起始行号。读大对象前先看结构，再按行号读需要的部分。",
    schema: { type: "object", properties: { object: { type: "string", description: "对象名或对象地址" } }, required: ["object"] }
  },
  {
    name: "adt_where_used",
    description: "查哪些对象使用了这个对象（被谁调用 / 引用），最多列 200 个。",
    schema: { type: "object", properties: { object: { type: "string", description: "对象名或对象地址" } }, required: ["object"] }
  },
  {
    name: "adt_package",
    description: "列出一个开发包里的对象，按类型分组。",
    schema: { type: "object", properties: { package: { type: "string", description: "包名，如 ZIDPPP" } }, required: ["package"] }
  },
  {
    name: "adt_syntax_check",
    description: "语法检查（不改代码、不保存、不激活）。只给 object：查 SAP 里已激活的版本。" +
      "检查自己写 / 改的代码：再给 file（文件夹里的代码文件，优先，省得把代码再抄一遍）或 source（代码全文），" +
      "SAP 把它当作 object 的新内容检查，对象本身不变。返回错误 / 警告、行号和那一行代码。",
    schema: { type: "object", properties: {
      object: { type: "string", description: "对象名或对象地址。检查新代码时是这段代码要放进的对象（必须已在 SAP 建好）" },
      file: { type: "string", description: "可选：文件夹里的代码文件路径，如 /代码/ZMM_REPORT.abap，内容是对象的完整源码" },
      source: { type: "string", description: "可选：代码全文（没有文件时用）" },
      include: { type: "string", description: "可选，类的局部部分：definitions / implementations / macros / testclasses（file / source 是这一部分的完整内容）" }
    }, required: ["object"] }
  }
];

export const ADT_PROMPT = `可以用 adt_ 开头的工具查看 SAP 开发对象（只读，权限和用户在 Eclipse 里一样）：
- 不知道确切名字时先 adt_search；知道名字可以直接把名字传给其他 adt 工具。
- 大的类 / 程序先 adt_structure 看结构，再用 adt_read_source 按行号或 keyword 读需要的部分，不要整份从头读到尾。
- 「谁调用了 / 哪里用到」用 adt_where_used；「包里有什么」用 adt_package；「有没有语法错误」用 adt_syntax_check。
- 自己写或改的 ABAP 代码，写进文件夹后用 adt_syntax_check 带 file 检查（没有文件夹时带 source）；有错误就改了再查，直到没有错误再交给用户。这一步只检查，代码不会保存或激活到 SAP。
- 要检查的对象还没在 SAP 建好时，不要拿别的对象凑：请用户先在 SE38 / SE24 建一个同名空对象，或告诉你可以用哪个测试对象。
- 结论要引用对象名和行号，没读到的代码不要猜；工具说没有权限时如实告诉用户。`;
