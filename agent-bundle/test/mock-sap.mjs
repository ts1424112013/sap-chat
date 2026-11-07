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
    runs.set(runId, { modelCalls: 0, toolCalls: 0, question: data.question });
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
    const reply = (message, calls) => send(res, 200, {
      id: "chatcmpl-" + run.modelCalls, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock-model",
      choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    });
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
    if (data.tool === "list_results") return send(res, 200, { ok: true, content: JSON.stringify({ results: [{ id: "ART1", label: "库存结果", rows: 1 }] }) });
    if (data.tool === "open_report") {
      return send(res, 200, { ok: true, content: "参数卡已生成", card: {
        tool: "open_report", taskId: "T1", taskModule: "REPORT", taskStatus: "WAITING_INPUT", needsInput: true,
        pendingParamsJson: JSON.stringify({ report_id: "ZMM001", tcode: "ZMM001", params: [{ param_id: "WERKS", label: "工厂", required: true }] }),
        answer: "【报表 测试库存】(ZMM001) 请填参数"
      } });
    }
    if (data.tool !== "search_tables") return send(res, 200, { ok: false, message: "工具未授权：" + data.tool });
    if (data.args && data.args.keyword === "坏参数") return send(res, 200, { ok: false, message: "参数被拒绝: keyword 不合法" });
    return send(res, 200, { ok: true, content: JSON.stringify({ rows: [{ TABNAME: "AFKO", DDTEXT: "订单表头" }, { TABNAME: "AFPO", DDTEXT: "订单项目" }], total: 2 }) });
  }
  if (p === "/results/export") {
    const bad = checkHeaders(req, true);
    if (bad.length || data.runId !== req.headers["x-lingxi-run"]) return send(res, 400, { ok: false, message: bad.join("；") || "运行号不一致" });
    if (data.resultId !== "ART1") return send(res, 200, { ok: false, message: "结果不存在" });
    return send(res, 200, { ok: true, label: "库存结果", rows: 2, columns: 2, truncated: false, csv: "物料,库存\nM1,10\nM2,\"1,200\"\n" });
  }
  if (p === "/run/finish") {
    const run = runs.get(data.runId);
    if (run) Object.assign(run, { status: data.status, answer: data.answer, skillsUsed: data.skillsUsed });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { message: "unknown " + p });
});

server.listen(port, () => console.log(`mock SAP agent service on http://localhost:${port}/poc.html`));
