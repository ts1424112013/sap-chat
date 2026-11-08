/**
 * 灵犀浏览器 Agent 引擎（Deep Agents 浏览器版）。
 * 打包后挂在 window.LingxiAgent，供 UI5 端 webapp/service/BrowserAgentService.js 调用。
 *
 * 一次 run():
 *   1. SAP /run/start 拿运行号、允许的工具、模型名、场景说明；
 *   2. 建 Deep Agent：模型走 SAP 转发；SAP 工具按清单包装；文件工具接到所选文件夹；
 *      超长工具结果、压缩后的旧对话放浏览器内存（/large_tool_results/、/conversation_history/、/草稿/）；
 *   3. 流式执行，把待办 / 工具调用 / 改文件确认 / 回答推给界面；
 *   4. SAP /run/finish 落会话与审计。
 */
import { createDeepAgent, CompositeBackend, StateBackend, createSummarizationMiddleware } from "deepagents/browser";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { todoListMiddleware } from "langchain";
import { createSapClient, SapAgentError } from "./sap-client.js";
import {
  FolderBackend, folderSupported, pickFolder, restoreFolder, requestFolderPermission, forgetFolder, isTextPath
} from "./folder-backend.js";
import { ReadonlyMemBackend, skillFiles } from "./readonly-backend.js";
import { summarizeStep, mainArg } from "./step-summary.js";
import { createAdtClient, ADT_TOOL_SPECS, ADT_PROMPT, ADT_SQL_PROMPT, normalizeUri, parseDataPreview } from "./adt-client.js";

export const VERSION = "0.12.0";
export const MEMORY_FILE = "/灵犀记忆.md";
/** 记忆上限（字符）：超过时只载入前这么多，回答后让模型整理一次 */
export const MEMORY_MAX_CHARS = 6000;
/** 整理目标：上限的 2/3，留出余量，免得下一轮又超 */
export const MEMORY_TARGET_CHARS = 4000;
/** SAP 管理员维护的技能（只读，SAP /run/start 下发） */
export const SAP_SKILL_DIR = "/SAP技能/";
/** 文件夹自带的技能：.lingxi/技能/<名字>/SKILL.md */
export const FOLDER_SKILL_DIR = "/.lingxi/技能/";
const MAX_TOOL_CHARS = 60000;
const CARD_TOOL_TEXT = "参数卡已经显示给用户。本次运行到此结束，不要再调用工具。";

/**
 * 上下文压缩时机。框架估 token 用「字数 ÷ 4」（按英文），中文实际约每字 0.6～1 token，会少算 2～3 倍；
 * 所以按 2.2 倍折算：估算值到「上下文 × 60% ÷ 2.2」就压缩（256K 模型 ≈ 7 万估算 token：
 * 纯中文实际约 19 万、偏英文 / JSON 实际约 7 万，都在上限内）。每次只把最近约「上下文 × 40% ÷ 2.2」的内容交给模型去总结。
 * 万一还是超了：SAP / 网关回「maximum context length」，框架会先压缩再重试一次。
 */
export const CJK_TOKEN_FACTOR = 2.2;
export function contextPlan(ctxTokens) {
  const ctx = Math.max(8000, Number(ctxTokens) || 256000);
  return {
    ctx,
    trigger: Math.floor(ctx * 0.6 / CJK_TOKEN_FACTOR),
    trimToSummarize: Math.floor(ctx * 0.4 / CJK_TOKEN_FACTOR),
    keepMessages: 6
  };
}

const SUMMARY_PROMPT = `你在为一个 SAP 业务助手压缩对话记录。请用中文写一份简洁的总结，后面的工作只能看到这份总结：
1. 用户要做的事、已经定下的口径和结论；
2. 已经查到的关键数字、表名、字段、报表 / 结果号（result_id）、对象名，原样保留；
3. 改过或新建的文件路径；
4. 还没做完的事（对照待办）。
不要编造内容，不要写客套话。

对话记录：
{conversation}

总结：`;

const BASE_PROMPT = `你是「灵犀」，公司内部的 SAP 业务助手，运行在用户浏览器里。
工作方式：
- 多步任务先用 write_todos 列出计划，做完一项勾一项；简单问题直接回答，不必列计划。
- SAP 数据只能通过 SAP 工具获取，不要编造数字；工具返回"部分数据 / 已截断"时，回答里要说明。
- 回答用中文，先给结论，再给依据。
过程说明（用户在界面上实时看你的每一步）：
- 开始干活时，在第一次调用工具的同时用一句话说打算怎么做（先查什么、再看什么）。
- 拿到重要发现、要换方向时，用一句话说看到了什么、接下来查什么。
- 要用户确认的操作（写文件等）之前，用一句话说为什么要这么做。
- 其余步骤（连续查表、读文件）直接调用工具，不必说话。每句不超过 40 个字，不重复工具名，不写客套话。`;

const FOLDER_PROMPT = `用户已授权一个本地文件夹，文件工具里的 "/" 就是这个文件夹的根目录。
- 改文件前先读；尽量用 edit_file 做小范围修改，不要整份重写。
- 写文件会先让用户确认，用户拒绝时不要换个方式再写。
- 只能写文本文件（txt / md / csv / tsv / json / xml / yaml / sql / abap / html 等）：表格存成 .csv，文档存成 .md；不写 .bat / .ps1 / .vbs / .js / .sh 等脚本，不写 Excel / Word / PDF / 图片。
- 只有用户明确说要删某个文件时才用 delete_file，一次删一个，每次都会让用户确认；不要为了「整理」自己删文件，删文件夹做不到。
- .lingxi/ 目录是灵犀的备份和修改记录，只读。
- ${MEMORY_FILE} 是这个文件夹的长期记忆（上限 ${MEMORY_MAX_CHARS} 字）：只记以后还用得上的规则（口径、格式、命名习惯、用户纠正过的做法），不记一次性的数字、查询结果、临时安排，不记密码、令牌等凭据。
  记之前先看已有条目：同类的用 edit_file 改那一条，不要再追加一条重复的；每条一行，写短。
- /草稿/ 下的文件只在本次对话里存在，不会写进用户文件夹，可以放中间结果。`;

/**
 * 记忆正文进系统提示（替换框架自带的记忆说明：那段是英文、约 4000 字，还要求「每次先写记忆」，记忆涨得快）。
 * 超过上限只放前 MEMORY_MAX_CHARS 字，并告诉模型本次结束后会整理。
 */
export function memorySection(text) {
  const t = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!t) return "";
  const over = t.length > MEMORY_MAX_CHARS;
  return `以下是 ${MEMORY_FILE} 的内容（这个文件夹以前记下的规则）：和当前问题相关的要遵守；和用户这次说的冲突时，以用户这次说的为准，并用 edit_file 改掉记忆里那一条。
<灵犀记忆>
${over ? t.slice(0, MEMORY_MAX_CHARS) : t}
</灵犀记忆>` + (over ? `\n（记忆共 ${t.length} 字，超过上限 ${MEMORY_MAX_CHARS} 字，只载入了前 ${MEMORY_MAX_CHARS} 字；本次回答后会整理。）` : "");
}

export const MEMORY_COMPACT_PROMPT = `你在整理「灵犀」（SAP 业务助手）的长期记忆文件。记忆是以前记下的规则，会放进以后每次对话的系统提示里。
整理要求：
1. 重复或意思相同的规则合并成一条；
2. 前后矛盾的，保留写在后面（更新）的那条；
3. 删掉一次性、已过时的内容（某天的具体数字、查询结果、临时安排）；
4. 表名、字段名、报表名、事务码、口径、数值原样保留；不改变规则的意思，不新增原文没有的规则；
5. 用 Markdown：第一行「# 灵犀记忆」，下面按主题分组「## 主题」，每条规则一行「- 」开头；
6. 整理后不超过 ${MEMORY_TARGET_CHARS} 字。
只输出整理后的文件全文：不要解释，不要代码块标记。`;

/** 模型整理结果的清理与校验：不合格返回 { error } */
export function cleanMemory(out, before) {
  let t = String(out || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n/, "").replace(/\n```\s*$/, "").trim();
  if (!t) return { error: "模型没有返回内容" };
  if (!/^#\s*灵犀记忆/.test(t)) t = "# 灵犀记忆\n\n" + t;
  const n0 = String(before || "").trim().length;
  if (t.length > MEMORY_MAX_CHARS) return { error: `整理后仍有 ${t.length} 字，超过上限` };
  if (n0 && t.length >= n0) return { error: "整理后没有变短" };
  // 重复多的记忆可以缩得很短，不按比例判断；只要求还有规则行（防止模型只回一句「已整理」）
  if (!/^\s*[-*]\s+\S/m.test(t)) return { error: "整理结果里没有规则条目" };
  return { text: t + "\n" };
}

/**
 * 回答后整理记忆：文件超过上限时让模型合并重复规则，写回前走正常的改文件确认（有对比、有备份、可撤回）。
 * 用户拒绝或整理失败都不影响本次运行；同一份内容被拒绝过就不再问（同一个文件夹后端内）。
 */
async function compactMemoryAfterRun(folderBackend, makeModel, track, signal) {
  const r = await folderBackend.read(MEMORY_FILE, 0, 100000);
  if (r.error || typeof r.content !== "string") return;
  const before = r.content.replace(/^\uFEFF/, "");
  const n0 = before.trim().length;
  if (n0 <= MEMORY_MAX_CHARS) return;
  if (folderBackend._memSkip === before) return;
  const id = "memory-compact-" + Date.now();
  track({ type: "tool_start", id, tool: "compact_memory", args: { file_path: MEMORY_FILE }, arg: MEMORY_FILE });
  let ok = false, summary = "";
  try {
    const m = await makeModel().invoke([
      { role: "system", content: MEMORY_COMPACT_PROMPT },
      { role: "user", content: `当前记忆（${n0} 字）：\n\n${before}` }
    ], { signal });
    const c = cleanMemory(textOf(m), before);
    if (c.error) {
      summary = "没有整理：" + c.error;
    } else {
      const w = await folderBackend.write(MEMORY_FILE, c.text, "整理记忆");
      if (w.error) summary = /拒绝/.test(w.error) ? "你没有同意，记忆保持原样" : "没有写入：" + w.error.replace(/^Error:\s*/, "");
      else { ok = true; summary = `${n0.toLocaleString()} → ${c.text.trim().length.toLocaleString()} 字`; }
    }
  } catch (e) {
    if (signal && signal.aborted) summary = "已停止";
    else summary = "整理失败：" + ((e && e.message) || e);
  }
  if (!ok) folderBackend._memSkip = before;
  track({ type: "tool_end", id, tool: "compact_memory", ok, summary, preview: "" });
}

const NO_FOLDER_PROMPT = `用户没有授权本地文件夹；文件工具只能用来存放本次对话里的中间结果（浏览器内存，刷新即失）。`;

const SKILL_PROMPT = `技能是做某类事的固定做法：技能清单里有和当前问题相关的，先用 read_file 读它的 SKILL.md，再按做法执行；不相关就不读。`;

const ASK_PROMPT = `不清楚就先问，不要猜：
- 这几种情况先用 ask_user 问用户：要用哪张报表 / 哪一列 / 哪个条件有两种以上说得通的理解；条件缺了而且猜错会让结果差很多（如期间、工厂、口径）；要做的事和用户原话对不上。
- 一次只问一个问题，给 2~4 个具体候选（如列名、报表名），候选写短；问题里说清为什么要问。
- 能从对话、结果、技能、系统说明里确定的不要问；同一件事不要反复问；用户说「你定」时按最常见的做法做并在回答里说明。`;

const EXPORT_PROMPT = `用户要把报表结果存到文件夹（导出、另存、存成 CSV / Excel）时，用 save_result_to_folder：数据由 SAP 直接写进文件，不经过你，不要自己拼表格内容再 write_file。`;

/** 会话标题：任务第一轮回答后让模型起一个短标题（多一次很短的模型调用；失败就不改标题） */
export const TITLE_PROMPT = `你在给一段 SAP 业务助手的对话起标题。根据用户的问题和助手的回答，写一个 6~16 个字的中文标题：
点出具体对象（报表名 / 事务码 / 表 / 程序 / 物料 / 工厂等）和要做的事，如「ZDPMM702 成品可用库存」「ZCL_AI_ACCESS 调用方」「工厂 1000 未清采购」。
只输出标题本身：不要引号、书名号、句号，不要「标题：」前缀。`;

export function cleanTitle(s) {
  let t = String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n").map(x => x.trim()).filter(Boolean)[0] || "";
  t = t.replace(/^(标题|会话标题|title)\s*[:：]\s*/i, "").replace(/^[「『《"'“‘【\s]+|[」』》"'”’】。.!！?？\s]+$/g, "").replace(/\*\*/g, "").trim();
  if (t.length > 32) t = t.slice(0, 32);
  return t.length >= 2 ? t : "";
}

async function makeTitle(model, question, answer, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), 20000);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) { if (signal.aborted) return ""; signal.addEventListener("abort", onAbort, { once: true }); }
  try {
    const m = await model.invoke([
      { role: "system", content: TITLE_PROMPT },
      { role: "user", content: `用户的问题：${String(question || "").slice(0, 500)}\n\n助手的回答（开头）：${String(answer || "").slice(0, 600)}` }
    ], { signal: ctl.signal });
    return cleanTitle(textOf(m));
  } catch (e) {
    return "";
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function clip(s, n = MAX_TOOL_CHARS) {
  s = typeof s === "string" ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `\n…[已截断，原长 ${s.length} 字符]` : s;
}

function rid() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "");
}

/**
 * 把 SAP 返回的工具清单包装成 LangChain 工具；执行时再交给 SAP 校验。
 * 工具结果带 card（报表参数卡）时交给 onCard：引擎随即结束本次运行，由界面显示参数卡。
 */
function buildSapTools(client, run, emit, signal, onCard, onDatasets) {
  // adt_run_sql 由 SAP 下发说明，但在浏览器里经 ADT 执行（见 buildAdtSqlTool），不走 /tools/exec
  return (run.tools || []).filter(t => t && t.name !== ADT_SQL_TOOL).map(t => tool(
    async (args, config) => {
      const requestId = rid();
      const r = await client.execTool({ runId: run.runId, tool: t.name, args: args || {}, requestId }, { signal });
      if (r && r.display) emit({ type: "display", tool: t.name, display: r.display });
      // 数据集（查数 / 结果查询 / 数据分析 / 函数）直接交给界面画表格和图表，不经过模型；带上调用编号，界面挂到对应那一步
      if (r && Array.isArray(r.datasets) && r.datasets.length && onDatasets) {
        onDatasets(t.name, r.datasets, config && config.toolCall && config.toolCall.id);
      }
      if (r && r.ok === false) return `工具执行失败：${r.message || "未知原因"}`;
      if (r && r.card && typeof r.card === "object") {
        onCard(r.card);
        return CARD_TOOL_TEXT;
      }
      return clip(r && r.content != null ? r.content : r);
    },
    {
      name: t.name,
      description: t.description || t.name,
      schema: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} }
    }
  ));
}

/**
 * 问用户（只在浏览器里，不经过 SAP）：界面在过程里弹出候选按钮，等用户点。
 * 用户选「我直接说」时调 onOther 结束本次运行（问题本身就是这次的回答），等用户在输入框里补充。
 */
function buildAskTool(ask, track, signal, onOther) {
  return tool(
    async ({ question, options }) => {
      const q = String(question || "").trim().slice(0, 300);
      const opts = (Array.isArray(options) ? options : []).map(x => String(x || "").trim().slice(0, 80)).filter(Boolean).slice(0, 4);
      if (!q || opts.length < 2) return "工具执行失败：question 不能为空，options 要给 2~4 个候选";
      track({ type: "ask", question: q, options: opts });
      let r;
      try { r = await ask({ question: q, options: opts }); } catch (e) { r = { cancel: true }; }
      if (signal && signal.aborted) throw signal.reason || new Error("用户停止");
      if (!r || r.cancel) {
        track({ type: "asked", question: q, answer: "", cancel: true });
        throw new Error("用户停止");
      }
      if (r.other) {
        track({ type: "asked", question: q, answer: "我直接说", other: true });
        onOther(q);
        return "用户想自己说明，本次运行结束。";
      }
      const a = String(r.answer || "").slice(0, 200);
      track({ type: "asked", question: q, answer: a });
      return `用户选择：${a}`;
    },
    {
      name: "ask_user",
      description: "有不清楚、需要用户拍板的地方时问用户：界面显示问题和候选按钮，返回用户选的那一项。一次只问一个问题。",
      schema: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问的问题，一句话，说清为什么要问" },
          options: { type: "array", items: { type: "string" }, description: "2~4 个候选答案，写短（界面另外会给「我直接说」）" }
        },
        required: ["question", "options"]
      }
    }
  );
}

/** 删除文件夹里的单个文件（11.8 #02）：每次确认、先备份到 .lingxi/备份/、可撤回 */
function buildDeleteTool(folderBackend) {
  return tool(
    async ({ file_path }) => {
      const path = String(file_path || "").trim();
      if (!path.startsWith("/")) return "工具执行失败：file_path 要以 / 开头，是文件夹里的路径";
      if (/^\/(草稿|SAP技能|large_tool_results|conversation_history)\//.test(path)) return "工具执行失败：这里不是用户文件夹里的文件，不能删";
      if (path.replace(/\/+$/, "") === MEMORY_FILE) return `工具执行失败：${MEMORY_FILE} 是长期记忆，不能删；要去掉某条规则用 edit_file 改`;
      const r = await folderBackend.delete(path);
      if (r && r.error) return r.error;
      return `已删除 ${path}（原文件备份在 .lingxi/备份/，用户可以撤回）。`;
    },
    {
      name: "delete_file",
      description: "删除用户文件夹里的一个文件（不能删文件夹）。只在用户明确要求删除时用；删除前会让用户确认，原文件会备份。",
      schema: {
        type: "object",
        properties: { file_path: { type: "string", description: "要删除的文件路径，如 /旧数据/库存_1001.csv" } },
        required: ["file_path"]
      }
    }
  );
}

/** 把一份报表结果整份写进文件夹（数据 SAP → 浏览器 → 文件，不经过模型；写前同样要用户确认） */
function buildExportTool(client, run, folderBackend, signal) {
  return tool(
    async ({ result_id, file_path }) => {
      const path = String(file_path || "").trim();
      if (!/\.csv$/i.test(path)) return "工具执行失败：file_path 要以 .csv 结尾（Excel 可以直接打开 CSV）";
      let r;
      try {
        r = await client.exportResult({ runId: run.runId, resultId: String(result_id || "") }, { signal });
      } catch (e) {
        if (signal && signal.aborted) throw e;
        return `工具执行失败：${(e && e.message) || e}`;
      }
      if (!r || typeof r.csv !== "string") return "工具执行失败：SAP 没有返回数据";
      // 带 BOM：Excel 直接双击打开时中文不乱码
      const w = await folderBackend.write(path, "﻿" + r.csv);
      if (w && w.error) return w.error;
      return `已保存 ${path}：「${r.label || result_id}」${r.rows} 行 × ${r.columns} 列` +
        (r.truncated ? `（结果超过导出上限，只导出了前 ${r.rows} 行）` : "") + "。";
    },
    {
      name: "save_result_to_folder",
      description: "把一份报表结果的全部行存成 CSV 文件，放进用户授权的文件夹（写前会让用户确认）。result_id 用 list_results 查到的结果号。",
      schema: {
        type: "object",
        properties: {
          result_id: { type: "string", description: "结果号（list_results 返回的 id）" },
          file_path: { type: "string", description: "文件夹里的路径，以 .csv 结尾，如 /报表结果/库存.csv" }
        },
        required: ["result_id", "file_path"]
      }
    }
  );
}

/**
 * ADT 代码工具（只读，浏览器直连 /sap/bc/adt）。每次调用先报 SAP /tools/audit（校验运行号、计入工具次数、写审计），
 * SAP 拒绝或报不了就不调 ADT；调完再报一次结果（失败不影响回答）。
 */
const ADT_SQL_TOOL = "adt_run_sql";

/**
 * IT 自由 SQL（0.10.0）：SAP 下发了 adt_run_sql 才挂。先报 /tools/audit（target = SQL 全文，SAP 用 SQL 守卫校验，
 * 被拒就不发），再调 ADT datapreview/freestyle；数据集交给界面画表格，调完回填状态和行数（SAP 记进 ZAI_SQL_LOG）。
 */
function buildAdtSqlTool(adt, client, run, signal, onDatasets) {
  const spec = (run.tools || []).find(t => t && t.name === ADT_SQL_TOOL);
  if (!spec) return null;
  return tool(
    async (args, config) => {
      const a = args || {};
      const sql = String(a.sql || "").trim();
      if (!sql) return "工具执行失败：缺少 sql";
      if (sql.length > 4000) return "工具执行失败：SQL 超过 4000 字符";
      let seq = 0;
      try {
        const r = await client.auditAdt({ runId: run.runId, tool: ADT_SQL_TOOL, target: sql }, { signal });
        if (!r || r.ok === false) return `工具执行失败：${(r && r.message) || "SAP 没有允许这次查询"}`;
        seq = r.seq || 0;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        return `工具执行失败：${(e && e.message) || "SAP 审计接口不可用，不能执行 SQL"}`;
      }
      const t0 = Date.now();
      let out, status = "OK";
      try {
        out = await adt.runSql(a, signal);
        if (out.dataset && onDatasets) onDatasets(ADT_SQL_TOOL, [out.dataset], config && config.toolCall && config.toolCall.id);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        status = e && (e.status === 401 || e.status === 403) ? "DENIED" : "ERROR";
        out = { text: `工具执行失败：${(e && e.message) || e}`, rows: 0 };
      }
      client.auditAdt({ runId: run.runId, seq, status, ms: Date.now() - t0, rows: out.rows || 0 }, {}).catch(() => {});
      return clip(out.text);
    },
    { name: ADT_SQL_TOOL, description: spec.description || ADT_SQL_TOOL,
      schema: spec.parameters && typeof spec.parameters === "object" ? spec.parameters : { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } }
  );
}

function buildAdtTools(adt, client, run, signal, folderBackend) {
  // 语法检查带 file：从用户选的文件夹读代码（只读文本文件）
  const readCode = async file => {
    if (!folderBackend) throw new Error("这次没有选文件夹，读不了 file；请改用 source 传代码全文");
    if (!isTextPath(file)) throw new Error(`${file} 不是文本文件，不能当代码检查`);
    const r = await folderBackend.readRaw(file);
    if (r.error) throw new Error(r.error);
    return String(r.data.content || "").replace(/^\uFEFF/, "");
  };
  const fns = {
    adt_search: async a => {
      const list = await adt.search(a.query, a.type, 50, signal);
      if (!list.length) return { text: `没有找到名字匹配「${a.query}」的对象（或没有权限看到）。`, rows: 0 };
      return { text: `找到 ${list.length} 个对象` + (list.length >= 50 ? "（最多列 50 个，可以把名字写得更具体）" : "") + "：\n" +
        list.map(o => `${o.name}  ${o.typeText}${o.package ? "  包 " + o.package : ""}${o.description ? "  " + o.description : ""}  ${o.uri}`).join("\n"), rows: list.length };
    },
    adt_read_source: a => adt.readSource(a, signal),
    adt_structure: a => adt.structure(a, signal),
    adt_where_used: a => adt.whereUsed(a, signal),
    adt_package: a => adt.packageContents(a, signal),
    adt_syntax_check: async a => {
      if (a.file && a.source) throw new Error("file 和 source 只给一个");
      if (a.file) return adt.syntaxCheck({ ...a, source: await readCode(String(a.file)), sourceLabel: "文件 " + String(a.file).slice(0, 120) }, signal);
      return adt.syntaxCheck(a, signal);
    }
  };
  return ADT_TOOL_SPECS.map(spec => tool(
    async args => {
      const a = args || {};
      const target = (String(a.object || a.query || a.package || "").slice(0, 200) + (a.keyword ? " ~" + String(a.keyword).slice(0, 40) : "") +
        (a.file ? " <" + String(a.file).slice(0, 80) : "") + (typeof a.source === "string" && a.source ? ` <代码 ${a.source.split("\n").length} 行` : "")).slice(0, 250);
      // 白名单外的地址：不报审计、不发请求，直接拒绝
      if (/^(https?:\/\/[^/]+)?\/sap\/bc\/adt\//i.test(String(a.object || "").trim()) && !normalizeUri(a.object)) {
        return "工具执行失败：对象地址不在允许范围内（只能读报表 / 包含程序 / 类 / 接口 / 函数 / CDS / 表 / 结构 / 数据元素 / 域 / 包）";
      }
      let seq = 0;
      try {
        const r = await client.auditAdt({ runId: run.runId, tool: spec.name, target }, { signal });
        if (!r || r.ok === false) return `工具执行失败：${(r && r.message) || "SAP 没有允许这次调用"}`;
        seq = r.seq || 0;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        return `工具执行失败：${(e && e.message) || "SAP 审计接口不可用，不能调用 ADT"}`;
      }
      const t0 = Date.now();
      let out, status = "OK";
      try {
        out = await fns[spec.name](a);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        status = e && (e.status === 401 || e.status === 403) ? "DENIED" : "ERROR";
        out = { text: `工具执行失败：${(e && e.message) || e}`, rows: 0 };
      }
      client.auditAdt({ runId: run.runId, seq, status, ms: Date.now() - t0, rows: out.rows || 0 }, {}).catch(() => {});
      return clip(out.text);
    },
    { name: spec.name, description: spec.description, schema: spec.schema }
  ));
}

/**
 * 精简的过程记录（存进 SAP，刷新 / 重开会话时按同样样式画回来）：
 * 每步只留类型、工具、主要参数、一句话结果、状态、耗时；不存文件内容、源码、返回全文、思考全文。
 * k: say 说明 | plan 计划 | tool 工具 | skill 技能 | note 提示 | card 参数卡 | think 思考（只留耗时）
 */
export function compactSteps(trace) {
  const out = [];
  const byId = {};
  let plan = null;
  for (const e of trace || []) {
    if (out.length >= 200) break;
    switch (e.type) {
      case "say": out.push({ k: "say", text: String(e.text || "").slice(0, 300) }); break;
      case "think": out.push({ k: "think", ms: e.ms || 0 }); break;
      case "todos":
        if (!plan) { plan = { k: "plan", text: "" }; out.push(plan); }
        plan.text = JSON.stringify((e.todos || []).map(t => [String(t.content || "").slice(0, 60), t.status])).slice(0, 1000);
        break;
      case "tool_start": {
        if (e.tool === "ask_user") break;   // 问答另记一条（asked）
        const s = { k: "tool", id: e.id, tool: e.tool, arg: String(e.arg || "").slice(0, 200), st: "RUNNING", at: e.at };
        byId[e.id] = s; out.push(s); break;
      }
      case "tool_end": {
        const s = byId[e.id];
        if (s) { s.st = e.ok ? "OK" : "ERROR"; s.sum = String(e.summary || "").slice(0, 200); s.ms = Math.max(0, (e.at || 0) - (s.at || 0)); }
        break;
      }
      case "datasets": { const s = byId[e.id]; if (s) { s.ds = e.index; s.dn = e.count; } break; }
      case "confirmed":
        out.push({ k: "note", st: e.approved ? "OK" : "ERROR",
          text: (e.approved ? (e.auto ? "已按本次允许自动" : "已同意") : "已拒绝") + e.action + " " + String(e.path || "").slice(0, 120) });
        break;
      case "skill": out.push({ k: "skill", text: String(e.name || "").slice(0, 60) }); break;
      case "asked":
        if (!e.cancel) out.push({ k: "note", st: "OK", text: ("问：" + String(e.question || "").slice(0, 120) + " → " + String(e.answer || "")).slice(0, 300) });
        break;
      case "compacted": out.push({ k: "note", text: "对话较长，已自动压缩" }); break;
      case "card": out.push({ k: "card", tool: e.tool || "" }); break;
      default: break;
    }
  }
  for (const s of out) { if (s.st === "RUNNING") s.st = "STOPPED"; delete s.at; delete s.id; }
  return out;
}

function msgType(m) {
  if (!m) return "";
  if (typeof m._getType === "function") return m._getType();
  return m.type || m.role || "";
}
function textOf(m) {
  const c = m && m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === "string" ? p : p.text || "")).join("");
  return "";
}

/**
 * 运行一轮对话。
 * @param {object} o
 * @param {string} o.question
 * @param {Array<{role:'user'|'assistant',content:string}>} [o.history] 之前几轮（已在 SAP 会话里）
 * @param {{sessionId?:string, scene?:string, modelId?:string, think?:boolean, skillId?:string}} [o.context]
 * 返回 { answer, card?, skills[], changes[], … }；card = SAP 报表参数卡（taskId / taskModule / taskStatus /
 * needsInput / pendingParamsJson / answer），有卡时 answer 就是卡的说明
 * @param {FileSystemDirectoryHandle} [o.folder] 已授权的文件夹
 * @param {boolean} [o.confirmWrites=true] 写文件前要求确认
 * @param {(evt)=>void} [o.onEvent] 过程事件
 * @param {FolderBackend} [o.folderBackend] 跨轮复用的文件夹后端（优先于 o.folder）
 * @param {(req:{action,path,before,after})=>Promise<boolean|{approved:boolean,message?:string}>} [o.confirm] 写文件确认
 * @param {(req:{question:string, options:string[]})=>Promise<{answer?:string, other?:boolean, cancel?:boolean}>} [o.ask]
 *        问用户（ask_user 工具）；不传时不给模型这个工具
 * @param {boolean} [o.title] 任务第一轮：回答后让模型起会话标题（结果 title，SAP 收尾时替换默认标题）
 * @param {AbortSignal} [o.signal]
 * @param {object} [o.sap] createSapClient 参数（base 等）
 * @param {object} [o.client] 测试时注入
 */
export async function run(o) {
  const emit = e => { try { o.onEvent && o.onEvent(e); } catch (x) { /* 界面错误不打断运行 */ } };
  const client = o.client || createSapClient(o.sap);
  const ctx = o.context || {};
  const started = Date.now();
  const trace = [];
  const track = e => { trace.push({ ...e, at: Date.now() - started }); emit(e); };

  emit({ type: "phase", phase: "start" });
  const runInfo = await client.startRun({
    sessionId: ctx.sessionId || "", scene: ctx.scene || "", modelId: ctx.modelId || "",
    question: o.question, think: !!ctx.think, skillId: ctx.skillId || "",
    focusArtifactId: ctx.focusArtifactId || "",
    folder: o.folderBackend ? o.folderBackend.name : (o.folder ? o.folder.name : "")
  }, { signal: o.signal });
  if (!runInfo || !runInfo.runId) throw new SapAgentError("SAP 没有返回运行号", 0, runInfo);
  emit({ type: "run", runId: runInfo.runId, model: runInfo.model, tools: (runInfo.tools || []).map(t => t.name), adt: runInfo.adt === true,
    limits: { maxModelCalls: (runInfo.limits && runInfo.limits.maxModelCalls) || 0, maxToolCalls: (runInfo.limits && runInfo.limits.maxToolCalls) || 0,
      contextTokens: (runInfo.limits && runInfo.limits.contextTokens) || 0 } });

  // SAP 已经给出确定性回答（Fiori 报表参数卡 / 候选清单 / 闸门提示）：不调模型，直接收尾
  if (runInfo.answer) {
    const det = { answer: String(runInfo.answer), card: runInfo.card && typeof runInfo.card === "object" ? runInfo.card : null };
    if (det.card) track({ type: "card", tool: det.card.tool || "", taskId: det.card.taskId || "" });
    try {
      await client.finishRun({ runId: runInfo.runId, status: "OK", answer: det.answer, message: "", skillsUsed: [], steps: compactSteps(trace) });
    } catch (e) { emit({ type: "warn", message: "运行结果未能写回 SAP 会话：" + e.message }); }
    emit({ type: "phase", phase: "done", status: "OK" });
    return { answer: det.answer, runId: runInfo.runId, trace, card: det.card, skills: [], datasets: [], deterministic: true,
      changes: [], elapsedMs: Date.now() - started, folder: o.folderBackend || null };
  }

  let allowAllWrites = false;
  // 文件夹后端：调用方可传入同一个实例跨多轮复用（撤回要用到之前的修改记录）
  let folderBackend = o.folderBackend || (o.folder ? new FolderBackend(o.folder) : null);
  if (folderBackend) {
    folderBackend.opts = {
      ...folderBackend.opts,
      question: () => o.question,
      onChange: c => track({ type: "file_changed", action: c.action, path: c.path, backup: c.backup }),
      confirm: o.confirmWrites === false ? null : async req => {
        // 用户在本次运行里选过「都不再询问」：同类写入自动通过（只在本次运行有效）
        const isDelete = req.action === "删除";
        if (allowAllWrites && !isDelete) {
          track({ type: "confirmed", action: req.action, path: req.path, approved: true, auto: true });
          return { approved: true };
        }
        track({ type: "confirm", action: req.action, path: req.path });
        // 没有确认界面时一律拒绝，绝不静默写用户文件
        const r = o.confirm ? await o.confirm(req) : { approved: false, message: "界面不支持确认" };
        const ok = r === true || (r && r.approved === true);
        // 「本次都不再询问」只管写和改；删除每次都问（11.8 #02）
        const always = !isDelete && !!(r && r.always === true);
        if (ok && always) allowAllWrites = true;
        track({ type: "confirmed", action: req.action, path: req.path, approved: ok, always });
        return r;
      }
    };
  }

  const model = new ChatOpenAI({
    model: runInfo.model || "lingxi",
    apiKey: "sap-session",
    temperature: runInfo.temperature != null ? runInfo.temperature : 0.2,
    maxRetries: 0,
    timeout: (runInfo.limits && runInfo.limits.modelTimeoutMs) || 240000,
    streaming: false,
    configuration: {
      baseURL: client.root,
      fetch: client.modelFetch(runInfo.runId),
      dangerouslyAllowBrowser: true
    }
  });

  // 技能：SAP 下发的（只读目录）+ 文件夹里 .lingxi/技能/ 下的（项目自带做法）
  const sapSkills = skillFiles(runInfo.skills);
  const skillIdByDir = {};
  for (const s of runInfo.skills || []) {
    const p = Object.keys(sapSkills).find(k => sapSkills[k].includes(`sap_skill_id: ${JSON.stringify(String(s.id))}`));
    if (p) skillIdByDir[p.split("/")[1]] = { id: String(s.id), name: s.name || s.id };
  }
  const sapSkillBackend = Object.keys(sapSkills).length ? new ReadonlyMemBackend(sapSkills) : null;
  let folderHasSkills = false;
  if (folderBackend) {
    const l = await folderBackend.ls(FOLDER_SKILL_DIR);
    folderHasSkills = !l.error && (l.files || []).some(f => f.is_dir);
  }
  const skillSources = [...(sapSkillBackend ? [SAP_SKILL_DIR] : []), ...(folderHasSkills ? [FOLDER_SKILL_DIR] : [])];

  const backend = (cfg) => {
    const mem = new StateBackend(cfg);
    const routes = { "/large_tool_results/": mem, "/conversation_history/": mem, "/草稿/": mem };
    if (sapSkillBackend) routes[SAP_SKILL_DIR] = sapSkillBackend;
    return folderBackend || sapSkillBackend ? new CompositeBackend(folderBackend || mem, routes) : mem;
  };

  // 记忆：自己读、自己放进系统提示（有上限），不用框架的 memory 选项
  let memoryText = "";
  if (folderBackend) {
    const m = await folderBackend.read(MEMORY_FILE, 0, 100000);
    if (!m.error && typeof m.content === "string") memoryText = m.content;
  }

  // 报表参数卡：工具拿到卡就停下（和原 Agent 一样，参数由用户在卡上确认后提交，聊天里不执行报表）
  const inner = new AbortController();
  if (o.signal) {
    if (o.signal.aborted) inner.abort(o.signal.reason);
    else o.signal.addEventListener("abort", () => inner.abort(o.signal.reason), { once: true });
  }
  let card = null;
  const onCard = c => {
    if (card) return;
    card = c;
    track({ type: "card", tool: c.tool || "", taskId: c.taskId || "" });
    // 立即停：不能再发下一轮模型请求（SAP 会照样转发给模型，白花一次调用）
    inner.abort(new Error("lingxi-card"));
  };

  const datasets = [];
  const onDatasets = (toolName, list, callId) => {
    const first = datasets.length;
    for (const d of list) if (d && typeof d === "object" && datasets.length < 8) datasets.push(d);
    // index = 这一步的数据集在本次运行 datasets 里从第几个开始（界面按它把数据卡挂到这一步下面）
    // preview：每个数据集只带列名和前 3 行，供过程里就地预览；完整数据在运行结果的 datasets 里
    track({ type: "datasets", tool: toolName, id: callId || "", index: first, count: datasets.length - first,
      preview: list.slice(0, 2).map(d => ({
        name: (d && d.name) || "", total: d && (d.total_rows != null ? d.total_rows : (d.rows || []).length),
        columns: ((d && d.columns) || []).slice(0, 6).map(c => (c && (c.label || c.name)) || ""),
        numeric: ((d && d.columns) || []).slice(0, 6).map(c => !!(c && c.numeric)),
        rows: ((d && d.rows) || []).slice(0, 3).map(r => (Array.isArray(r) ? r : []).slice(0, 6))
      })) });
  };
  const tools = buildSapTools(client, runInfo, emit, inner.signal, onCard, onDatasets);
  if (folderBackend && !(folderBackend.opts && folderBackend.opts.readOnly)) tools.push(buildDeleteTool(folderBackend));
  const canExport = !!(folderBackend && runInfo.export);
  if (canExport) tools.push(buildExportTool(client, runInfo, folderBackend, inner.signal));
  // ADT 代码工具：SAP 说这次可以用（开关 + 代码分析权限 + 开发显示权限）才挂上
  const canAdt = runInfo.adt === true && typeof client.adtFetch === "function" && typeof client.auditAdt === "function";
  const adtClient = canAdt ? createAdtClient({ fetch: client.adtFetch }) : null;
  if (canAdt) tools.push(...buildAdtTools(adtClient, client, runInfo, inner.signal, folderBackend));
  const sqlTool = canAdt ? buildAdtSqlTool(adtClient, client, runInfo, inner.signal, onDatasets) : null;
  if (sqlTool) tools.push(sqlTool);
  // 问用户：选「我直接说」时和参数卡一样立即停，问题就是这次的回答
  let askOther = "";
  const canAsk = typeof o.ask === "function";
  if (canAsk) {
    tools.push(buildAskTool(o.ask, track, inner.signal, q => {
      if (askOther || card) return;
      askOther = q;
      inner.abort(new Error("lingxi-ask"));
    }));
  }

  // 替换框架默认的对话压缩（同名中间件按名字替换）：按模型上下文和中文比例提前压缩
  const ctxPlan = contextPlan(runInfo.limits && runInfo.limits.contextTokens);
  const summarization = createSummarizationMiddleware({
    backend,
    trigger: { type: "tokens", value: ctxPlan.trigger },
    keep: { type: "messages", value: ctxPlan.keepMessages },
    trimTokensToSummarize: ctxPlan.trimToSummarize,
    summaryPrompt: SUMMARY_PROMPT
  });

  const agent = createDeepAgent({
    name: "lingxi",
    model,
    tools,
    systemPrompt: [
      BASE_PROMPT,
      folderBackend ? FOLDER_PROMPT : NO_FOLDER_PROMPT,
      skillSources.length ? SKILL_PROMPT : "",
      canExport ? EXPORT_PROMPT : "",
      canAsk ? ASK_PROMPT : "",
      canAdt ? ADT_PROMPT : "",
      sqlTool ? ADT_SQL_PROMPT : "",
      runInfo.systemPrompt || "",
      memorySection(memoryText)
    ].filter(Boolean).join("\n\n"),
    backend,
    skills: skillSources.length ? skillSources : undefined,
    // deepagents 1.16 起待办工具只给部分模型默认开启，这里显式加上。
    // 改文件确认不用框架的 interrupt（浏览器里没有异步上下文），由文件夹后端自己等用户点确认。
    middleware: [todoListMiddleware(), summarization]
  });

  const messages = [...(o.history || []).map(h => ({ role: h.role, content: h.content })), { role: "user", content: o.question }];
  const config = { configurable: { thread_id: runInfo.runId }, recursionLimit: (runInfo.limits && runInfo.limits.recursionLimit) || 120, signal: inner.signal };

  const skillsUsed = new Map();
  const noteSkill = (toolName, args) => {
    if (toolName !== "read_file" || !args) return;
    const p = String(args.file_path || args.path || "");
    let m = p.match(/^\/SAP技能\/([^/]+)\/SKILL\.md$/);
    if (m && skillIdByDir[m[1]] && !skillsUsed.has(skillIdByDir[m[1]].id)) {
      skillsUsed.set(skillIdByDir[m[1]].id, skillIdByDir[m[1]].name);
      track({ type: "skill", source: "SAP", id: skillIdByDir[m[1]].id, name: skillIdByDir[m[1]].name });
      return;
    }
    m = p.match(/^\/\.lingxi\/技能\/([^/]+)\/SKILL\.md$/);
    if (m && !skillsUsed.has("folder:" + m[1])) {
      skillsUsed.set("folder:" + m[1], m[1]);
      track({ type: "skill", source: "FOLDER", id: "", name: m[1] });
    }
  };

  const callArgs = {};
  let lastModelAt = Date.now();
  let answer = "";
  let status = "OK";
  let errorMsg = "";
  try {
    {
      const stream = await agent.stream({ messages }, { ...config, streamMode: "updates" });
      for await (const chunk of stream) {
        for (const [, upd] of Object.entries(chunk || {})) {
          if (!upd || typeof upd !== "object") continue;
          if (Array.isArray(upd.todos)) track({ type: "todos", todos: upd.todos.map(t => ({ content: t.content, status: t.status })) });
          // 对话压缩：框架把这一次的压缩记在状态 _summarizationEvent 里
          if (upd._summarizationEvent && typeof upd._summarizationEvent === "object") {
            track({ type: "compacted", file: upd._summarizationEvent.filePath || "" });
          }
          const msgs = Array.isArray(upd.messages) ? upd.messages : (upd.messages && upd.messages.value) || [];
          for (const m of msgs) {
            const ty = msgType(m);
            if (ty === "ai") {
              // 深度思考（DeepSeek 的 reasoning_content）：单独交给界面，默认收起；不进会话正文
              const rc = m.additional_kwargs && m.additional_kwargs.reasoning_content;
              const now = Date.now();
              if (typeof rc === "string" && rc.trim()) track({ type: "think", text: rc.trim(), ms: now - lastModelAt });
              lastModelAt = now;
              // 真实用量（网关返回 usage 时）：界面据此显示上下文用了多少
              const um = m.usage_metadata;
              if (um && um.input_tokens) emit({ type: "usage", input: um.input_tokens, output: um.output_tokens || 0, ctx: ctxPlan.ctx });
              const calls = m.tool_calls || [];
              const t = textOf(m);
              if (calls.length && t && t.trim()) track({ type: "say", text: t.trim() });
              for (const c of calls) {
                if (c.name === "write_todos") continue;
                noteSkill(c.name, c.args);
                callArgs[c.id] = c.args;
                track({ type: "tool_start", id: c.id, tool: c.name, args: c.args, arg: mainArg(c.name, c.args) });
              }
              if (!calls.length && t) { answer = t; emit({ type: "answer", text: t }); }
            } else if (ty === "tool") {
              if (m.name === "write_todos") continue;
              const t = textOf(m);
              const ok = !/^(Error|工具执行失败)/.test(t) && m.status !== "error";
              track({ type: "tool_end", id: m.tool_call_id, tool: m.name, ok,
                summary: summarizeStep(m.name, callArgs[m.tool_call_id], t, ok), preview: t.slice(0, 1000) });
            }
          }
        }
      }
    }
  } catch (e) {
    if ((card || askOther) && !(o.signal && o.signal.aborted)) {
      // 参数卡 / 用户要自己说明：正常收尾，不是错误
    } else {
      status = o.signal && o.signal.aborted ? "CANCELLED" : "ERROR";
      errorMsg = (e && e.message) || String(e);
      track({ type: "error", message: errorMsg, status: e && e.status });
    }
  }
  if (card && status === "OK") answer = String(card.answer || answer || "请在下面的参数卡里核对参数后提交。");
  else if (askOther && status === "OK") answer = askOther + "\n\n请在输入框里直接说明。";

  // 会话标题：只在任务第一轮、正常结束时起；用一个不开流式、输出很短的模型实例
  let title = "";
  if (o.title && status === "OK" && answer) {
    const titleModel = new ChatOpenAI({
      model: runInfo.model || "lingxi", apiKey: "sap-session", temperature: 0.3, maxTokens: 40, maxRetries: 0,
      timeout: 20000, streaming: false,
      configuration: { baseURL: client.root, fetch: client.modelFetch(runInfo.runId), dangerouslyAllowBrowser: true }
    });
    title = await makeTitle(titleModel, o.question, answer, o.signal);
    if (title) emit({ type: "title", title });
  }

  try {
    await client.finishRun({
      runId: runInfo.runId, status, answer, message: errorMsg,
      skillsUsed: [...skillsUsed.keys()].filter(k => !k.startsWith("folder:")),
      steps: compactSteps(trace),
      title
    });
  } catch (e) { emit({ type: "warn", message: "运行结果未能写回 SAP 会话：" + e.message }); }

  // 记忆超过上限：回答已经给出、会话已写回，再整理（要用户确认写入）
  if (folderBackend && status === "OK" && !(o.signal && o.signal.aborted)) {
    const makeModel = () => new ChatOpenAI({
      model: runInfo.model || "lingxi", apiKey: "sap-session", temperature: 0, maxTokens: 8000, maxRetries: 0,
      timeout: (runInfo.limits && runInfo.limits.modelTimeoutMs) || 240000, streaming: false,
      configuration: { baseURL: client.root, fetch: client.modelFetch(runInfo.runId), dangerouslyAllowBrowser: true }
    });
    try { await compactMemoryAfterRun(folderBackend, makeModel, track, o.signal); }
    catch (e) { emit({ type: "warn", message: "整理记忆失败：" + ((e && e.message) || e) }); }
  }

  emit({ type: "phase", phase: "done", status });
  if (status !== "OK") throw Object.assign(new Error(errorMsg || status), { status, trace, runId: runInfo.runId });
  return {
    answer, runId: runInfo.runId, trace, card, datasets, title,
    skills: [...skillsUsed.values()],
    changes: folderBackend ? folderBackend.changes.slice() : [], elapsedMs: Date.now() - started, folder: folderBackend
  };
}

export {
  createSapClient, SapAgentError,
  FolderBackend, folderSupported, pickFolder, restoreFolder, requestFolderPermission, forgetFolder,
  summarizeStep, mainArg, createAdtClient, normalizeUri, parseDataPreview
};
