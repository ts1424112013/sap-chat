/**
 * 灵犀 SAP Agent 服务（SICF /sap/bc/zai_agent，处理类 ZCL_AI_AGENT_HTTP）的浏览器端调用。
 *
 * 约定（与 ABAP 端一致，见 功能计划书/Deep Agents浏览器接入/02 §5.1）：
 *   POST {base}/run/start         { sessionId, scene, modelId, question, think }
 *        → { runId, model, tools:[{name,description,parameters}], limits, systemPrompt }
 *   POST {base}/chat/completions  OpenAI 兼容；头 X-Lingxi-Run 指明运行号；SAP 用自己的模型配置转发
 *   POST {base}/tools/exec        { runId, tool, args, requestId } → { ok, content, message, display? }
 *   POST {base}/run/finish        { runId, status, answer, skillsUsed, steps }（steps = 精简过程记录）
 *   POST {base}/run/steps         { sessionId } → { runs: [{ msgSeq, steps }] }
 *   POST {base}/results/export    { runId, resultId } → { ok, label, rows, columns, csv, truncated }
 *   /tools/exec 的结果可带 card（报表参数卡：taskId / taskModule / taskStatus / needsInput / pendingParamsJson / answer），
 *   引擎拿到后立刻结束本次运行，由界面显示参数卡
 *
 * 同源、沿用 SAP 登录 Cookie；每个请求都带 X-Lingxi-Agent 头（SAP 端据此 + Origin 防跨站）。
 * 浏览器不持有模型密钥；模型 SDK 加的 Authorization（Bearer）一律去掉，避免 ICF 把它当登录凭据；
 * 只有调用方显式给的 Basic 头（本地开发经代理）才带上。
 */

export class SapAgentError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "SapAgentError";
    this.status = status;
    this.body = body;
  }
}

/** 从页面地址带上 sap-client / sap-language，与 OData 请求保持同一个 client */
function sapQuery() {
  try {
    const q = new URLSearchParams(window.location.search);
    const out = new URLSearchParams();
    for (const k of ["sap-client", "sap-language"]) if (q.get(k)) out.set(k, q.get(k));
    const s = out.toString();
    return s ? "?" + s : "";
  } catch (e) { return ""; }
}

export function createSapClient({ base = "/sap/bc/zai_agent", origin, timeoutMs = 300000, authHeader = "" } = {}) {
  // 只接受 Basic（本地开发经代理时灵犀自己的登录头）；模型 SDK 自带的 Bearer 一律丢弃
  const basic = /^Basic\s+\S+$/.test(authHeader || "") ? authHeader : "";
  const root = (origin || window.location.origin) + base.replace(/\/+$/, "");
  const qs = sapQuery();

  function headers(runId, extra) {
    const h = new Headers(extra || {});
    h.delete("authorization");
    if (basic) h.set("Authorization", basic);
    h.set("X-Lingxi-Agent", "1");
    h.set("X-Requested-With", "XMLHttpRequest");
    if (runId) h.set("X-Lingxi-Run", runId);
    return h;
  }

  async function post(path, body, { runId, signal, okFalseThrows = true } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
    if (signal) signal.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
    let res;
    try {
      res = await fetch(root + path + qs, {
        method: "POST",
        credentials: "same-origin",
        headers: headers(runId, { "Content-Type": "application/json" }),
        body: JSON.stringify(body || {}),
        signal: ctl.signal
      });
    } finally { clearTimeout(t); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON（如 ICF 错误页） */ }
    if (!res.ok) {
      const msg = (data && (data.message || (data.error && data.error.message))) || `SAP 返回 ${res.status}`;
      throw new SapAgentError(msg, res.status, data || text.slice(0, 500));
    }
    // 工具执行的 ok:false 是给模型看的失败原因（参数被拒等），不终止运行
    if (okFalseThrows && data && data.ok === false && data.message) throw new SapAgentError(data.message, res.status, data);
    return data;
  }

  /** 给 ChatOpenAI 用的 fetch：只允许打到本服务，补头、去 Authorization */
  function modelFetch(runId) {
    return (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith(root)) return Promise.reject(new SapAgentError("模型请求只能发往 SAP Agent 服务", 0));
      const u = url.includes("?") || !qs ? url : url + qs;
      return fetch(u, { ...init, credentials: "same-origin", headers: headers(runId, init.headers) });
    };
  }

  return {
    root,
    startRun: (p, o) => post("/run/start", p, o),
    execTool: (p, o) => post("/tools/exec", p, { ...o, runId: p.runId, okFalseThrows: false }),
    finishRun: (p, o) => post("/run/finish", p, { ...o, runId: p.runId }),
    exportResult: (p, o) => post("/results/export", p, { ...o, runId: p.runId }),
    /** 会话里新引擎各轮的精简过程记录（刷新 / 重开会话时画回来）→ { runs: [{ msgSeq, steps }] } */
    getSteps: (p, o) => post("/run/steps", p, o),
    modelFetch
  };
}
