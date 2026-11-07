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
  if (p === "/results/export") {
    const bad = checkHeaders(req, true);
    if (bad.length || data.runId !== req.headers["x-lingxi-run"]) return send(res, 400, { ok: false, message: bad.join("；") || "运行号不一致" });
    if (data.resultId !== "ART1") return send(res, 200, { ok: false, message: "结果不存在" });
    return send(res, 200, { ok: true, label: "库存结果", rows: 2, columns: 2, truncated: false, csv: "物料,库存\nM1,10\nM2,\"1,200\"\n" });
  }
  if (p === "/run/finish") {
    const run = runs.get(data.runId);
    if (run) Object.assign(run, { status: data.status, answer: data.answer, skillsUsed: data.skillsUsed, steps: data.steps });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { message: "unknown " + p });
});

server.listen(port, () => console.log(`mock SAP agent service on http://localhost:${port}/poc.html`));
