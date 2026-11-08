/**
 * 本地模拟 SAP Agent 服务（/sap/bc/zai_agent）+ 剧本模型，用来在真实浏览器里验证打包后的引擎。
 * 不连 SAP、不连模型。运行：node agent-bundle/test/mock-sap.mjs [端口]
 *
 * 剧本按"请求里已有几条 assistant 消息"决定下一步，覆盖：
 *   列计划 → ls → 读 CSV → 调 SAP 工具 → 改 CSV（需确认）→ 新建汇总（需确认）→ 写记忆（需确认）→ 回答
 * 同时校验：请求带 X-Lingxi-Agent / X-Lingxi-Run 头、没有 Authorization、tools 里有内置和 SAP 工具。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8091);
const BASE = "/sap/bc/zai_agent";
const runs = new Map();
const log = [];

const SAP_TOOLS = [{
  name: "search_tables",
  description: "按关键字搜索 SAP 表（表名与描述）",
  parameters: { type: "object", properties: { keyword: { type: "string", description: "关键字" } }, required: ["keyword"] }
}];

const call = (name, args) => ({ id: "call_" + Math.random().toString(16).slice(2, 10), type: "function", function: { name, arguments: JSON.stringify(args) } });
const SCRIPT = [
  () => [call("write_todos", { todos: [
    { content: "看看文件夹里有什么", status: "in_progress" },
    { content: "查 SAP 工单相关表", status: "pending" },
    { content: "修正 CSV 并写汇总", status: "pending" }
  ] })],
  () => [call("ls", { path: "/" })],
  () => [call("read_file", { file_path: "/工单.csv" })],
  () => [call("search_tables", { keyword: "工单" }), call("write_todos", { todos: [
    { content: "看看文件夹里有什么", status: "completed" },
    { content: "查 SAP 工单相关表", status: "completed" },
    { content: "修正 CSV 并写汇总", status: "in_progress" }
  ] })],
  () => [call("edit_file", { file_path: "/工单.csv", old_string: "1001,未完工", new_string: "1001,已完工" })],
  () => [call("write_file", { file_path: "/汇总.md", content: "# 工单汇总\n\n- 1001 已完工\n- 1002 未完工（缺料）\n" })],
  () => [call("write_file", { file_path: "/灵犀记忆.md", content: "# 灵犀记忆\n\n- 工单状态列只用「已完工 / 未完工」两种写法\n" })],
  () => null
];

// 场景二：记忆文件已存在 + 子 Agent + 用户拒绝修改
const SCRIPT2 = [
  () => [call("search_tables", { keyword: "坏参数" })],
  () => [call("task", { description: "子任务：数一下 1001 出现几次", subagent_type: "general-purpose" })],
  () => [call("edit_file", { file_path: "/工单.csv", old_string: "1002,未完工", new_string: "1002,已完工" })],
  () => null
];

// 场景三：SAP 技能 + 文件夹技能 + 报表结果存到文件夹 + 报表参数卡（拿到卡即停）
const RPT_TOOLS = [
  { name: "list_results", description: "列出本会话的报表结果", parameters: { type: "object", properties: {} } },
  { name: "open_report", description: "打开报表参数卡", parameters: { type: "object", properties: { tcode: { type: "string" } }, required: ["tcode"] } }
];
const SAP_SKILLS = [{ id: "SK1", name: "库存盘点", description: "盘点库存、导出库存结果时的做法", body: "MARKER-SKILL 先列结果再导出" }];
const SCRIPT3 = [
  () => [call("read_file", { file_path: "/SAP技能/SK1/SKILL.md" })],
  () => [call("list_results", {})],
  () => [call("save_result_to_folder", { result_id: "ART1", file_path: "/导出/库存.csv" })],
  () => [call("open_report", { tcode: "ZMM001" })],
  () => null
];

// 场景九：ADT 代码工具（SAP 回 adt:true；浏览器直连 /sap/bc/adt；每次先报 /tools/audit）
const SCRIPT9 = [
  () => [call("adt_search", { query: "ZCL_AI_AGENT*", type: "CLAS" })],
  () => [call("adt_structure", { object: "ZCL_AI_AGENT_SERVICE" })],
  () => [call("adt_read_source", { object: "/sap/bc/adt/oo/classes/zcl_ai_agent_service", keyword: "browser_start" })],
  () => [call("adt_read_source", { object: "ZCL_AI_AGENT_SERVICE", start_line: 3, max_lines: 2 })],
  () => [call("adt_where_used", { object: "ZCL_AI_AGENT_SERVICE" })],
  () => [call("adt_package", { package: "ZIDPPP" })],
  () => [call("adt_syntax_check", { object: "ZCL_AI_AGENT_SERVICE" })],
  () => [call("adt_read_source", { object: "/sap/bc/adt/datapreview/freestyle" })],
  () => [call("adt_read_source", { object: "ZCL_SECRET" })],
  () => [call("adt_read_source", { object: "SHKZG" })],
  // 检查自己写的代码：source 直接给 / file 从文件夹读；只走 checkruns，不保存
  () => [call("adt_syntax_check", { object: "ZCL_AI_AGENT_SERVICE", include: "implementations", source: "CLASS lcl IMPLEMENTATION.\n  SYNTAXERR lv_x.\nENDCLASS." })],
  () => [call("adt_syntax_check", { object: "ZCL_AI_AGENT_SERVICE", file: "/代码/zcl_ai_agent_service.abap" })],
  () => null
];
// 场景十：IT 自由 SQL（adt_run_sql，0.10.0）—— SAP 下发工具说明，浏览器经 ADT datapreview/freestyle 执行
const SQL_TOOL = { name: "adt_run_sql", description: "执行一条只读 ABAP SQL（模拟）",
  parameters: { type: "object", properties: { sql: { type: "string" }, max_rows: { type: "integer" }, purpose: { type: "string" } }, required: ["sql"] } };
const SCRIPT10 = [
  () => [call("adt_run_sql", { sql: "SELECT WERKS, COUNT( * ) AS CNT FROM AUFK GROUP BY WERKS;", max_rows: 50, purpose: "各工厂工单数" })],
  () => [call("adt_run_sql", { sql: "SELECT BNAME FROM USR02" })],
  () => [call("adt_run_sql", { sql: "SELECT BADCOL FROM AUFK" })],
  () => null
];
const adt = { log: [], token: "TOK1", rotated: false, audits: [], sqlBodies: [] };
const ref = (name, type, uri, pkg, desc) =>
  `<adtcore:objectReference adtcore:uri="${uri}" adtcore:type="${type}" adtcore:name="${name}" adtcore:packageName="${pkg}"${desc ? ` adtcore:description="${desc}"` : ""}/>`;
const SRC = ["CLASS zcl_ai_agent_service DEFINITION PUBLIC.", "  PUBLIC SECTION.", "    CLASS-METHODS browser_start.", "    CLASS-METHODS browser_tool.",
  "ENDCLASS.", "CLASS zcl_ai_agent_service IMPLEMENTATION.", "  METHOD browser_start.", "    \" 开始一次运行", "  ENDMETHOD.", "ENDCLASS."].join("\n");
function adtRoute(req, res, url, body) {
  const p = url.pathname.slice("/sap/bc/adt".length);
  adt.log.push({ method: req.method, path: p + url.search, csrf: req.headers["x-csrf-token"] || "", auth: !!req.headers.authorization, agentHdr: !!req.headers["x-lingxi-agent"] });
  const xml = (code, s, extra = {}) => { res.writeHead(code, { "Content-Type": "application/xml; charset=utf-8", ...extra }); res.end(s); };
  const exc = (code, msg) => xml(code, `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><namespace id="com.sap.adt"/><type id="ExceptionResourceNoAuthorization"/><message lang="EN">${msg}</message></exc:exception>`);
  if (p === "/discovery") {
    if (req.headers["x-csrf-token"] === "fetch") adt.fetches = (adt.fetches || 0) + 1;
    return xml(200, `<app:service xmlns:app="http://www.w3.org/2007/app"/>`, { "x-csrf-token": adt.token });
  }
  if (req.method === "POST") {
    // 第一次语法检查时假装令牌过期：回 403 + Required，引擎应重取令牌再试
    if (p === "/checkruns" && !adt.rotated) { adt.rotated = true; adt.token = "TOK2"; return xml(403, "", { "x-csrf-token": "Required" }); }
    if (req.headers["x-csrf-token"] !== adt.token) return xml(403, "", { "x-csrf-token": "Required" });
  }
  if (p === "/repository/informationsystem/search") {
    const q = (url.searchParams.get("query") || "").toUpperCase();
    const all = [
      ref("ZCL_AI_AGENT_SERVICE", "CLAS/OC", "/sap/bc/adt/oo/classes/zcl_ai_agent_service", "ZIDPPP", "Agent 编排"),
      ref("ZCL_AI_AGENT_HTTP", "CLAS/OC", "/sap/bc/adt/oo/classes/zcl_ai_agent_http", "ZIDPPP", ""),
      ref("ZCL_SECRET", "CLAS/OC", "/sap/bc/adt/oo/classes/zcl_secret", "ZSEC", ""),
      ref("SHKZG", "DOMA/DD", "/sap/bc/adt/ddic/domains/shkzg", "BF", "借贷标识")
    ].filter(s => { const n = /adtcore:name="([^"]+)"/.exec(s)[1]; return q.endsWith("*") ? n.startsWith(q.slice(0, -1)) : n === q; });
    return xml(200, `<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${all.join("")}</adtcore:objectReferences>`);
  }
  if (p === "/datapreview/freestyle" && req.method === "POST") {
    adt.sqlBodies.push({ body, rowNumber: url.searchParams.get("rowNumber"), ctype: req.headers["content-type"] || "" });
    if (/BADCOL/.test(body)) return xml(400, `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><namespace id="com.sap.adt"/><type id="ExceptionDataPreview"/><localizedMessage lang="ZH">"BADCOL" 未知</localizedMessage></exc:exception>`);
    const col = (name, desc, type, vals) => `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="${type}" dataPreview:description="${desc}"/>` +
      `<dataPreview:dataSet>${vals.map(v => `<dataPreview:data>${v}</dataPreview:data>`).join("")}</dataPreview:dataSet></dataPreview:columns>`;
    return xml(200, `<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
      `<dataPreview:totalRows>3</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>` +
      `<dataPreview:executedQueryString>${body.replace(/</g, "&lt;")}</dataPreview:executedQueryString><dataPreview:queryExecutionTime>12.5</dataPreview:queryExecutionTime>` +
      col("WERKS", "工厂", "C", ["ABG1", "ABZ1", "AAD1"]) + col("CNT", "", "I", ["120", "45", "7"]) + `</dataPreview:tableData>`);
  }
  if (p === "/oo/classes/zcl_secret/source/main") return exc(403, "No authorization to access the resource /sap/bc/adt/oo/classes/zcl_secret");
  if (p === "/oo/classes/zcl_ai_agent_service/source/main") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(SRC); }
  if (p === "/oo/classes/zcl_ai_agent_service/objectstructure") {
    const el = (n, t, line, vis) => `<abapsource:objectStructureElement adtcore:name="${n}" adtcore:type="${t}" visibility="${vis}"><atom:link href="/sap/bc/adt/oo/classes/zcl_ai_agent_service/source/main#start=${line},4" rel="http://www.sap.com/adt/relations/source/definitionIdentifier"/></abapsource:objectStructureElement>`;
    return xml(200, `<?xml version="1.0" encoding="utf-8"?><abapsource:objectStructureElement xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZCL_AI_AGENT_SERVICE" adtcore:type="CLAS/OC">` +
      el("BROWSER_START", "CLAS/OM", 3, "public") + el("BROWSER_TOOL", "CLAS/OM", 4, "public") + `</abapsource:objectStructureElement>`);
  }
  if (p === "/repository/informationsystem/usageReferences") {
    const ro = (n, t, pkg, isRes) => `<usageReferences:referencedObject uri="/x/${n}" isResult="${isRes}"><usageReferences:adtObject adtcore:name="${n}" adtcore:type="${t}"><adtcore:packageRef adtcore:name="${pkg}"/></usageReferences:adtObject></usageReferences:referencedObject>`;
    adt.whereUsedUri = url.searchParams.get("uri");
    return xml(200, `<?xml version="1.0" encoding="utf-8"?><usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences" xmlns:adtcore="http://www.sap.com/adt/core"><usageReferences:referencedObjects>` +
      ro("ZIDPPP", "DEVC/K", "ZIDPPP", "false") + ro("ZCL_AI_AGENT_HTTP", "CLAS/OC", "ZIDPPP", "true") + ro("ZCL_AI_DPC_EXT", "CLAS/OC", "ZIDPPP", "true") +
      `</usageReferences:referencedObjects></usageReferences:usageReferenceResult>`);
  }
  if (p === "/repository/nodestructure") {
    const node = (t, n, d) => `<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>${t}</OBJECT_TYPE><OBJECT_NAME>${n}</OBJECT_NAME><DESCRIPTION>${d}</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>`;
    return xml(200, `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><TREE_CONTENT>` +
      node("CLAS/OC", "ZCL_AI_AGENT_SERVICE", "Agent 编排") + node("CLAS/OC", "ZCL_AI_AGENT_HTTP", "") + node("TABL/DT", "ZAI_BRUN", "运行号") +
      `</TREE_CONTENT></DATA></asx:values></asx:abap>`);
  }
  if (p === "/checkruns") {
    adt.checkBody = adt.checkBody || body;
    (adt.checkBodies = adt.checkBodies || []).push(body);
    const m = /<chkrun:artifact [^>]*chkrun:uri="([^"]+)"[^>]*><chkrun:content>([^<]*)</.exec(body);
    if (m) {
      // 交来的代码：含 SYNTAXERR 的行报错误，否则通过
      const src = Buffer.from(m[2], "base64").toString("utf8");
      adt.checkSources = [...(adt.checkSources || []), src];
      const errs = src.split("\r\n").map((l, i) => /SYNTAXERR/.test(l) ? i + 1 : 0).filter(Boolean);
      return xml(200, `<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"><chkrun:checkReport chkrun:reporter="abapCheckRun"><chkrun:checkMessageList>` +
        errs.map(n => `<chkrun:checkMessage chkrun:uri="${m[1]}#start=${n},2" chkrun:type="E" chkrun:shortText="语句 SYNTAXERR 未定义"/>`).join("") +
        `</chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>`);
    }
    return xml(200, `<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"><chkrun:checkReport chkrun:reporter="abapCheckRun"><chkrun:checkMessageList>` +
      `<chkrun:checkMessage chkrun:uri="/sap/bc/adt/oo/classes/zcl_ai_agent_service/source/main#start=8,5" chkrun:type="W" chkrun:shortText="变量 LV_X 未使用"/>` +
      `</chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>`);
  }
  if (p === "/ddic/domains/shkzg") {
    return xml(200, `<?xml version="1.0" encoding="utf-8"?><doma:domain adtcore:name="SHKZG" adtcore:type="DOMA/DD" adtcore:description="Soll-/Haben-Kennzeichen" xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core"><doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>000001</doma:length><doma:decimals>000000</doma:decimals></doma:typeInformation><doma:valueInformation><doma:valueTableRef/><doma:fixValues><doma:fixValue><doma:position>0001</doma:position><doma:low>H</doma:low><doma:high/><doma:text>Haben</doma:text></doma:fixValue><doma:fixValue><doma:position>0002</doma:position><doma:low>S</doma:low><doma:high/><doma:text>Soll</doma:text></doma:fixValue></doma:fixValues></doma:valueInformation></doma:content></doma:domain>`);
  }
  return exc(404, "not found " + p);
}

function send(res, code, obj, type = "application/json") {
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

function checkHeaders(req, needRun) {
  const problems = [];
  if (req.headers["x-lingxi-agent"] !== "1") problems.push("缺 X-Lingxi-Agent");
  if (req.headers.authorization) problems.push("带了 Authorization");
  if (needRun && !runs.has(req.headers["x-lingxi-run"])) problems.push("运行号无效");
  return problems;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/sap/bc/adt/")) {
    let b = "";
    for await (const c of req) b += c;
    return adtRoute(req, res, url, b);
  }
  if (url.pathname === "/__adt") return send(res, 200, adt);
  if (req.method !== "POST") {
    if (!url.pathname.startsWith(BASE) && req.method === "HEAD") return send(res, 200, "");
    if (url.pathname === "/" || url.pathname === "/poc.html") return send(res, 200, fs.readFileSync(path.join(here, "poc.html"), "utf8"), "text/html");
    if (url.pathname === "/lingxi-agent.js") return send(res, 200, fs.readFileSync(path.join(here, "../../webapp/thirdparty/lingxi-agent/lingxi-agent.js"), "utf8"), "text/javascript");
    if (url.pathname === "/__log") return send(res, 200, log);
    if (url.pathname === "/__runs") return send(res, 200, Object.fromEntries(runs));
    return send(res, 404, { message: "not found" });
  }
  let body = "";
  for await (const c of req) body += c;
  const data = body ? JSON.parse(body) : {};
  const p = url.pathname.slice(BASE.length);
  log.push({ url: req.url, method: req.method, path: p, headers: { agent: req.headers["x-lingxi-agent"], run: req.headers["x-lingxi-run"] || "", auth: !!req.headers.authorization } });

  if (p === "/run/start") {
    const bad = checkHeaders(req, false);
    if (bad.length) return send(res, 400, { ok: false, message: bad.join("；") });
    const runId = "R" + Date.now().toString(36);
    runs.set(runId, { modelCalls: 0, toolCalls: 0, question: data.question, focus: data.focusArtifactId || "" });
    if (String(data.question || "").includes("场景六")) {
      // 上下文压缩：模型上限设成 4 万 token，工具连续回大段中文
      return send(res, 200, { runId, model: "mock-model", tools: SAP_TOOLS, limits: { recursionLimit: 80, contextTokens: 40000 }, systemPrompt: "场景：DATA（模拟）" });
    }
    if (String(data.question || "").includes("场景四")) {
      // Fiori 场景的确定性回答：SAP 直接给回答和参数卡，浏览器不该再调模型
      return send(res, 200, { runId, model: "mock-model", tools: [], limits: { recursionLimit: 80 }, systemPrompt: "",
        answer: "【Fiori 报表 测试】请在参数卡里填写后取数",
        card: { tool: "fiori", taskId: "F1", taskModule: "FIORI", taskStatus: "WAITING_INPUT", needsInput: true,
          pendingParamsJson: JSON.stringify({ kind: "FIORI", report_id: "FR1", report_name: "测试", params: [] }), answer: "x" } });
    }
    if (String(data.question || "").includes("场景十")) {
      return send(res, 200, { runId, model: "mock-model", tools: [...SAP_TOOLS, SQL_TOOL], adt: true, limits: { recursionLimit: 80 }, systemPrompt: "场景：DATA（模拟）" });
    }
    if (String(data.question || "").includes("场景九")) {
      return send(res, 200, { runId, model: "mock-model", tools: SAP_TOOLS, adt: true, limits: { recursionLimit: 80 }, systemPrompt: "场景：CODE（模拟）" });
    }
    if (String(data.question || "").includes("场景三")) {
      return send(res, 200, { runId, model: "mock-model", tools: [...SAP_TOOLS, ...RPT_TOOLS], skills: SAP_SKILLS, export: true,
        limits: { recursionLimit: 80 }, systemPrompt: "场景：REPORT（模拟）" });
    }
    return send(res, 200, { runId, model: "mock-model", tools: SAP_TOOLS, limits: { recursionLimit: 80 }, systemPrompt: "场景：DATA（模拟）" });
  }
  if (p === "/chat/completions") {
    const bad = checkHeaders(req, true);
    if (bad.length) return send(res, 400, { error: { message: bad.join("；") } });
    const run = runs.get(req.headers["x-lingxi-run"]);
    run.modelCalls++;
    const msgs = data.messages || [];
    const step = msgs.filter(m => m.role === "assistant").length;
    const sys = msgs.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
    const firstUser = String((msgs.find(m => m.role === "user") || {}).content || "");
    if (!firstUser.startsWith("你在为") && !sys.startsWith("你在给一段")) run.hasAdtTools = (data.tools || []).some(t => t.function && /^adt_/.test(t.function.name));
    if (!firstUser.startsWith("你在为") && !sys.startsWith("你在给一段")) run.sysHasAdtRule = sys.includes("adt_search");
    const reply = (message, calls) => send(res, 200, {
      id: "chatcmpl-" + run.modelCalls, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock-model",
      choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    });
    // 会话标题请求（引擎 0.8.0：第一轮回答后）：不进剧本
    if (sys.startsWith("你在给一段 SAP 业务助手的对话起标题")) {
      run.titleCalls = (run.titleCalls || 0) + 1;
      run.titleUserMsg = firstUser;
      return reply({ role: "assistant", content: "标题：「ZCL_AI_AGENT_SERVICE 结构与调用方」。" });
    }
    if (run.question && run.question.includes("场景八")) {
      // 不清楚就问：第一步 ask_user，第二步按用户选的回答（选「我直接说」时引擎应停下，不再有第二步）
      run.step8 = (run.step8 || 0) + 1;
      run.sysHasAskRule = sys.includes("不清楚就先问");
      run.hasAskTool = (data.tools || []).some(t => t.function && t.function.name === "ask_user");
      if (run.step8 === 1) {
        const c = [call("ask_user", { question: "结果里有两列像料号，要带哪一列？", options: ["鴻海料號", "客戶料號"] })];
        return reply({ role: "assistant", content: "", tool_calls: c }, c);
      }
      const t = msgs.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("|");
      return reply({ role: "assistant", content: "完成 场景八 " + t });
    }
    if (run.question && run.question.includes("场景七")) {
      // 界面改版要的事件：节点说明（content + tool_calls）、深度思考（reasoning_content）、用量、本次都允许
      run.step7 = (run.step7 || 0) + 1;
      run.sysHasNarrationRule = run.sysHasNarrationRule || sys.includes("过程说明");
      const usage = { prompt_tokens: 1234 * run.step7, completion_tokens: 20, total_tokens: 1234 * run.step7 + 20 };
      const rep = (message, calls) => send(res, 200, { id: "c7-" + run.step7, object: "chat.completion", created: 1, model: "mock-model",
        choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }], usage });
      if (run.step7 === 1) {
        const c = [call("search_tables", { keyword: "工单" })];
        return rep({ role: "assistant", content: "先查工单相关的表，再统计。", reasoning_content: "用户想看工单状态，先找表。", tool_calls: c }, c);
      }
      if (run.step7 === 2) { const c = [call("write_file", { file_path: "/七-1.md", content: "一" })]; return rep({ role: "assistant", content: "", tool_calls: c }, c); }
      if (run.step7 === 3) { const c = [call("write_file", { file_path: "/七-2.md", content: "二" })]; return rep({ role: "assistant", content: "", tool_calls: c }, c); }
      return rep({ role: "assistant", content: "完成 场景七" });
    }
    if (run.question && run.question.includes("场景六")) {
      if (firstUser.startsWith("你在为一个 SAP 业务助手压缩对话记录")) {
        run.summaries = (run.summaries || 0) + 1;
        run.summaryPromptChars = firstUser.length;
        return reply({ role: "assistant", content: "总结：用户要看大结果，已经查过几次，每次都是一大段数据。" });
      }
      run.step6 = (run.step6 || 0) + 1;
      run.maxBody = Math.max(run.maxBody || 0, body.length);
      run.sawSummary = run.sawSummary || msgs.some(m => String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("总结：用户要看大结果"));
      // 第 4 次主请求假装网关报超出上下文（同 SAP 413 的写法），引擎应压缩后重试
      if (run.step6 === 4 && !run.overflowSent) {
        run.overflowSent = true;
        return send(res, 413, { error: { message: "这一轮发给模型的内容太大(上限 160 KB), 请先总结已有结果 (maximum context length exceeded)", type: "lingxi_error" } });
      }
      if (run.step6 <= 6) {
        const c = [call("search_tables", { keyword: "大结果" })];
        return reply({ role: "assistant", content: "", tool_calls: c }, c);
      }
      return reply({ role: "assistant", content: `完成 场景六 summaries=${run.summaries || 0}` });
    }
    if (run.question && run.question.includes("场景十")) {
      run.step10 = (run.step10 || 0) + 1;
      if (run.step10 === 1) {
        run.hasSqlTool = (data.tools || []).some(t => t.function && t.function.name === "adt_run_sql");
        run.sysHasSqlRule = sys.includes("有 adt_run_sql 时不要用 run_sql");
      }
      const c10 = (SCRIPT10[run.step10 - 1] || (() => null))();
      if (c10) return reply({ role: "assistant", content: "", tool_calls: c10 }, c10);
      run.toolTexts10 = msgs.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      return reply({ role: "assistant", content: "完成 场景十" });
    }
    if (run.question && run.question.includes("场景九")) {
      run.step9 = (run.step9 || 0) + 1;
      const c9 = (SCRIPT9[run.step9 - 1] || (() => null))();
      if (c9) return reply({ role: "assistant", content: "", tool_calls: c9 }, c9);
      run.toolTexts9 = msgs.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      return reply({ role: "assistant", content: "完成 场景九" });
    }
    if (firstUser.startsWith("子任务")) {
      run.subagent = true;
      return reply({ role: "assistant", content: "子任务结果：1001 出现 1 次" });
    }
    // 主 Agent 的请求：内置工具和 SAP 工具都要在
    const names = (data.tools || []).map(t => t.function && t.function.name);
    for (const need of ["write_todos", "ls", "read_file", "edit_file", "write_file", "task", "search_tables"]) {
      if (!names.includes(need)) return send(res, 400, { error: { message: "tools 里缺 " + need + "；实际：" + names.join(",") } });
    }
    if (run.question && run.question.includes("场景三")) {
      if (step === 0) {
        run.sysHasSapSkill = sys.includes("/SAP技能/SK1/SKILL.md") && sys.includes("库存盘点");
        run.sysHasFolderSkill = sys.includes("项目口径");
        run.hasExportTool = names.includes("save_result_to_folder");
      }
      const toolTexts = msgs.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      if (step === 1) run.skillRead = toolTexts.some(t => t.includes("MARKER-SKILL"));
      const c3 = (SCRIPT3[step] || (() => null))();
      if (c3) return reply({ role: "assistant", content: "", tool_calls: c3 }, c3);
      return reply({ role: "assistant", content: "不应该走到这里：拿到参数卡后应当停止" });
    }
    if (run.question && run.question.includes("场景二")) {
      const c2 = (SCRIPT2[step] || (() => null))();
      if (c2) return reply({ role: "assistant", content: "", tool_calls: c2 }, c2);
      const toolTexts = msgs.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      const flags = {
        memory: sys.includes("MARKER-42"),
        subagent: toolTexts.some(t => t.includes("子任务结果")),
        rejected: toolTexts.some(t => t.includes("用户拒绝")),
        toolErr: toolTexts.some(t => t.includes("工具执行失败") && t.includes("参数被拒绝"))
      };
      return reply({ role: "assistant", content: "FLAGS " + JSON.stringify(flags) });
    }
    const calls = (SCRIPT[step] || (() => null))();
    const message = calls
      ? { role: "assistant", content: "", tool_calls: calls }
      : { role: "assistant", content: `完成：1001 已改为已完工，汇总写在 /汇总.md，规则记进了记忆。（模型调用 ${run.modelCalls} 次；系统提示里${sys.includes("灵犀记忆") ? "有" : "没有"}记忆说明）` };
    return send(res, 200, {
      id: "chatcmpl-" + run.modelCalls, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock-model",
      choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    });
  }
  if (p === "/tools/exec") {
    const bad = checkHeaders(req, true);
    if (bad.length || data.runId !== req.headers["x-lingxi-run"]) return send(res, 400, { ok: false, message: bad.join("；") || "运行号不一致" });
    runs.get(data.runId).toolCalls++;
    if (data.tool === "list_results") return send(res, 200, { ok: true, content: JSON.stringify({ results: [{ id: "ART1", label: "库存结果", rows: 1 }] }),
      datasets: [{ name: "库存结果", status: "OK", total_rows: 1, columns: [{ name: "MATNR", label: "物料", numeric: false }], rows: [["M1"]] }] });
    if (data.tool === "open_report") {
      return send(res, 200, { ok: true, content: "参数卡已生成", card: {
        tool: "open_report", taskId: "T1", taskModule: "REPORT", taskStatus: "WAITING_INPUT", needsInput: true,
        pendingParamsJson: JSON.stringify({ report_id: "ZMM001", tcode: "ZMM001", params: [{ param_id: "WERKS", label: "工厂", required: true }] }),
        answer: "【报表 测试库存】(ZMM001) 请填参数"
      } });
    }
    if (data.tool !== "search_tables") return send(res, 200, { ok: false, message: "工具未授权：" + data.tool });
    if (data.args && data.args.keyword === "坏参数") return send(res, 200, { ok: false, message: "参数被拒绝: keyword 不合法" });
    if (data.args && data.args.keyword === "大结果") return send(res, 200, { ok: true, content: "物料库存明细：" + "工厂一千号仓库成品".repeat(800) });
    return send(res, 200, { ok: true, content: JSON.stringify({ rows: [{ TABNAME: "AFKO", DDTEXT: "订单表头" }, { TABNAME: "AFPO", DDTEXT: "订单项目" }], total: 2 }) });
  }
  if (p === "/tools/audit") {
    const bad = checkHeaders(req, true);
    if (bad.length || data.runId !== req.headers["x-lingxi-run"]) return send(res, 400, { ok: false, message: bad.join("；") || "运行号不一致" });
    const run = runs.get(data.runId);
    if (!run.adtOk) run.adtOk = /场景九|场景十/.test(String(run.question || ""));
    if (!run.adtOk) return send(res, 200, { ok: false, message: "这次运行没有开放 ADT" });
    if (data.seq) {
      const a = adt.audits.find(x => x.runId === data.runId && x.seq === data.seq);
      if (a) Object.assign(a, { status: data.status, ms: data.ms, rows: data.rows });
      return send(res, 200, { ok: true });
    }
    // SAP 端 SQL 守卫：受保护表直接拒绝（浏览器不应再发 ADT 请求）
    if (data.tool === "adt_run_sql" && /USR02/i.test(data.target || "")) {
      adt.audits.push({ runId: data.runId, seq: 0, tool: data.tool, target: data.target, status: "REJECTED" });
      return send(res, 200, { ok: false, message: "SQL 被拒绝: 表 USR02 属于受保护表, 不允许查询" });
    }
    run.toolCalls++;
    const seq = adt.audits.filter(x => x.runId === data.runId).length + 1;
    adt.audits.push({ runId: data.runId, seq, tool: data.tool, target: data.target, status: "CALL" });
    return send(res, 200, { ok: true, seq });
  }
  if (p === "/results/export") {
    const bad = checkHeaders(req, true);
    if (bad.length || data.runId !== req.headers["x-lingxi-run"]) return send(res, 400, { ok: false, message: bad.join("；") || "运行号不一致" });
    if (data.resultId !== "ART1") return send(res, 200, { ok: false, message: "结果不存在" });
    return send(res, 200, { ok: true, label: "库存结果", rows: 2, columns: 2, truncated: false, csv: "物料,库存\nM1,10\nM2,\"1,200\"\n" });
  }
  if (p === "/run/finish") {
    const run = runs.get(data.runId);
    if (run) Object.assign(run, { status: data.status, answer: data.answer, skillsUsed: data.skillsUsed, steps: data.steps, title: data.title });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { message: "unknown " + p });
});

server.listen(port, () => console.log(`mock SAP agent service on http://localhost:${port}/poc.html`));
