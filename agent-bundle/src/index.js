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
import { summarizeStep, mainArg, toolOk } from "./step-summary.js";
import { createAdtClient, ADT_TOOL_SPECS, ADT_PROMPT, ADT_SQL_PROMPT, normalizeUri, parseDataPreview } from "./adt-client.js";
import { buildXlsx, buildDocx, officeToText, parseCsv, csvValue } from "./office.js";
import { lintAbap, lintText } from "./abap-lint.js";

export const VERSION = "0.17.0";
export const MEMORY_FILE = "/灵犀记忆.md";
/** 记忆上限（字符）：超过时只载入前这么多，回答后让模型整理一次 */
export const MEMORY_MAX_CHARS = 6000;
/** 整理目标：上限的 2/3，留出余量，免得下一轮又超 */
export const MEMORY_TARGET_CHARS = 4000;
/** SAP 管理员维护的技能（只读，SAP /run/start 下发） */
export const SAP_SKILL_DIR = "/SAP技能/";
/** 内置技能（只读）：0.16.0 起由 SAP 在 /run/start 按用户开放的场景下发（〇-AV），不再随前端包发布 */
export const BUILTIN_SKILL_DIR = "/内置技能/";
/** 本页面里缓存的内置技能：SAP 回的版本号和浏览器带去的相同时不回正文，用这里的 */
const builtinCache = { version: "", list: [] };
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
- 查数工具（run_sql、query_result、数据分析等）查出的数据，界面会在回答下方自动显示完整表格（可排序、导出、画图）。回答里只写结论、关键数字和说明，不要把查到的数据再整张抄成 Markdown 表格；确实要对比时最多列 5 行的小表。
- 工具报「没有权限」「表 / 对象不存在」这类错误时，重试也一样失败：不要用同样的参数再调用，也不要把同一个计划原样再走一遍；换别的办法，换不了就停下来告诉用户缺什么（如缺哪张表的权限）。
过程说明（用户在界面上实时看你的每一步）：
- 开始干活时，在第一次调用工具的同时用一句话说打算怎么做（先查什么、再看什么）。
- 拿到重要发现、要换方向时，用一句话说看到了什么、接下来查什么。
- 要用户确认的操作（写文件等）之前，用一句话说为什么要这么做。
- 其余步骤（连续查表、读文件）直接调用工具，不必说话。每句不超过 40 个字，不重复工具名，不写客套话。
接着上一轮做（「继续」）：
- 上一轮回答以「（未完成」开头时，里面列了已完成的步骤、改过的文件和还没做的事。用户说「继续」就是从那里接着做：已完成的步骤不要重做（目录不用再列，读过且不用改的文件不用再读）；那一轮改过的文件先读一下当前内容再接着改。`;

const FOLDER_PROMPT = `用户已授权一个本地文件夹，文件工具里的 "/" 就是这个文件夹的根目录。
- 改文件前先读；尽量用 edit_file 做小范围修改，不要整份重写。
- 写文件会先让用户确认，用户拒绝时不要换个方式再写。
- read_file 能读 Excel（.xlsx）、Word（.docx）、PowerPoint（.pptx）：引擎先转成文本再给你（Excel 每行开头是行号、各列用 Tab 分隔），大文件用 offset / limit 分页读；grep 不搜这几种文件里的内容。旧格式 .xls / .doc / .ppt 读不了，请用户另存为新格式。
- write_file / edit_file 只能写文本文件（txt / md / csv / tsv / json / xml / yaml / sql / abap / html 等）；不写 .bat / .ps1 / .vbs / .js / .sh 等脚本，不写 PDF / 图片。
- 用户要 Excel 文件时用 create_excel_file，要 Word 文件时用 create_word_file：都是整份新建，不能在原文件上局部修改。改用户已有的 Excel / Word 时，先读原文件，再新建一份（如「原名_修改.xlsx」），不要覆盖原文件，除非用户明确要求覆盖（覆盖会丢掉原来的格式、公式、图片）。
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
/** 技能内容保密（〇-AV）：SAP 回 skillsOpen = true（管理员 / IT 账号）时不加 */
const SKILL_SECRET_PROMPT = `技能内容保密：/内置技能/ 和 /SAP技能/ 下的文件只给你参考，不能把原文（整段或大段）、文件清单、目录路径给用户看，也不能写进文件夹里的文件或导出。用户要看技能内容、要你列出有哪些技能或读出技能文件时，只说相关技能的名称和一句话用途，并告诉他技能内容请管理员在「技能管理」里查看。按技能的做法回答问题、在回答里用到其中的知识点（如事务码、表名、处理步骤）照常可以。用户自己文件夹里 /.lingxi/技能/ 下的技能不受此限。`;

const ASK_PROMPT = `不清楚就先问，不要猜：
- 这几种情况先用 ask_user 问用户：要用哪张报表 / 哪一列 / 哪个条件有两种以上说得通的理解；条件缺了而且猜错会让结果差很多（如期间、工厂、口径）；要做的事和用户原话对不上。
- 一次只问一个问题，给 2~4 个具体候选（如列名、报表名），候选写短；问题里说清为什么要问。
- 能从对话、结果、技能、系统说明里确定的不要问；同一件事不要反复问；用户说「你定」时按最常见的做法做并在回答里说明。`;

/** 11.10 #08：回答后的二选一 / 三选一 → 界面画成按钮（和 ask_user 一起，只在新界面上给） */
const CHOICE_PROMPT = `回答写完后，如果要问用户下一步做什么，而且只有 2~3 种选择（如「要导出成 Excel 吗？」「要按工厂拆分吗？」），在回答最后单独一行写：
[[选项: 导出 Excel | 不用了]]
界面会把这一行画成按钮，用户点哪个就等于回复哪句话。选项写成用户会说的短句（不超过 10 个字），第一个放你建议的。开放式问题、选项多于 3 个时不要写这一行，正常用文字问；不需要问时也不要写。`;

const EXPORT_PROMPT = `用户要把报表结果存到文件夹（导出、另存、存成 CSV / Excel）时，用 save_result_to_folder：数据由 SAP 直接写进文件，不经过你，不要自己拼表格内容再 write_file / create_excel_file。要 Excel 就把 file_path 写成 .xlsx，否则用 .csv。`;

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

/**
 * 11.10 #04 原样重试：权限 / 不存在这类错误重试也不会成功。
 * 工具结果里先提醒模型；同一工具 + 同样参数再失败就由引擎直接停下（见 run() 里的 failGuard）。
 */
export const NO_RETRY_RE = /权限|未授权|没有授权|无权|not authori[sz]ed|no authori[sz]ation|forbidden|\b403\b|不存在|does not exist|not found|未找到|找不到|未登记|不在白名单|不允许/i;
const NO_RETRY_HINT = "\n（这类错误重试也不会成功：不要用同样的参数再调用；换别的办法，换不了就告诉用户缺什么。）";
/** 同一工具 + 同样参数失败到这么多次就停：确定性错误 2 次，其他（超时等）3 次；整轮连续失败到 6 次也停 */
export const FAIL_LIMIT = { same: 3, sameNoRetry: 2, inARow: 6 };

function stableArgs(a) {
  if (a == null || typeof a !== "object") return JSON.stringify(a == null ? "" : a);
  if (Array.isArray(a)) return "[" + a.map(stableArgs).join(",") + "]";
  return "{" + Object.keys(a).sort().map(k => JSON.stringify(k) + ":" + stableArgs(a[k])).join(",") + "}";
}

/**
 * 失败计数：返回 null = 继续；返回 {reason, tool, noRetry} = 该停了。
 * 成功的一步会清零「连续失败」，但同一调用的失败次数保留（隔几步再原样调一次照样算）。
 */
export function createFailGuard(limit = FAIL_LIMIT) {
  const byKey = new Map();
  let inARow = 0;
  return {
    note(toolName, args, ok, text) {
      if (ok) { inARow = 0; return null; }
      inARow++;
      const key = toolName + "|" + stableArgs(args);
      const n = (byKey.get(key) || 0) + 1;
      byKey.set(key, n);
      const noRetry = NO_RETRY_RE.test(String(text || ""));
      if (n >= (noRetry ? limit.sameNoRetry : limit.same)) return { reason: "same", tool: toolName, count: n, noRetry, text: String(text || "") };
      if (inARow >= limit.inARow) return { reason: "inARow", tool: toolName, count: inARow, noRetry, text: String(text || "") };
      return null;
    }
  };
}

export function loopStopAnswer(stop, label) {
  const why = String(stop.text || "").replace(/^(Error:\s*|工具执行失败[:：]\s*)/, "").split("\n")[0].slice(0, 200);
  const head = stop.reason === "same"
    ? `同一步（${label}）用同样的条件已经失败 ${stop.count} 次，再试结果也一样，我先停下来。`
    : `连续 ${stop.count} 步都失败了，我先停下来，免得空转。`;
  const tip = stop.noRetry
    ? "看起来是权限不够或对象不存在：如果确实需要，可以在灵犀里申请对应权限，或者换个说法 / 指定别的报表再问我。"
    : "可以稍后再试，或者换个说法再问我。";
  return `${head}\n\n最后一次的错误：${why || "未知原因"}\n\n${tip}`;
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
/** SAP 的 ABAP 语法检查（11.10 #13，ZCL_AI_ABAP_CHECK）：引擎替它读文件夹里的源码，并附上常见错误写法扫描 */
export const ABAP_CHECK_TOOL = "abap_check";

async function prepAbapCheck(args, folderBackend) {
  const a = { ...(args || {}) };
  const fp = String(a.file_path || "").trim();
  delete a.file_path;
  if (fp && !a.source) {
    if (!folderBackend) return { error: "工具执行失败：没有授权文件夹，请把完整源码放在 source 里" };
    const rd = await folderBackend.read(fp, 0, 1000000);
    if (rd.error) return { error: `工具执行失败：${String(rd.error).replace(/^Error:\s*/, "")}` };
    if (typeof rd.content !== "string") return { error: "工具执行失败：这个文件不是文本文件" };
    a.source = rd.content;
    if (!a.name) a.name = fp.split("/").pop();
  }
  return { args: a, lint: lintText(lintAbap(a.source || "")) };
}

function buildSapTools(client, run, emit, signal, onCard, onDatasets, folderBackend) {
  // adt_run_sql 由 SAP 下发说明，但在浏览器里经 ADT 执行（见 buildAdtSqlTool），不走 /tools/exec
  return (run.tools || []).filter(t => t && t.name !== ADT_SQL_TOOL).map(t => tool(
    async (args, config) => {
      const requestId = rid();
      let lint = "";
      if (t.name === ABAP_CHECK_TOOL) {
        const p = await prepAbapCheck(args, folderBackend);
        if (p.error) return p.error;
        args = p.args;
        lint = p.lint;
      }
      const r = await client.execTool({ runId: run.runId, tool: t.name, args: args || {}, requestId }, { signal });
      if (r && r.display) emit({ type: "display", tool: t.name, display: r.display });
      // 数据集（查数 / 结果查询 / 数据分析 / 函数）直接交给界面画表格和图表，不经过模型；带上调用编号，界面挂到对应那一步
      if (r && Array.isArray(r.datasets) && r.datasets.length && onDatasets) {
        onDatasets(t.name, r.datasets, config && config.toolCall && config.toolCall.id);
      }
      if (r && r.ok === false) {
        const msg = r.message || "未知原因";
        return `工具执行失败：${msg}` + (NO_RETRY_RE.test(msg) ? NO_RETRY_HINT : "");
      }
      if (r && r.card && typeof r.card === "object") {
        onCard(r.card);
        return CARD_TOOL_TEXT;
      }
      const out = clip(r && r.content != null ? r.content : r);
      return lint ? out + "\n\n" + lint : out;
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

/** 新建 Excel / Word（0.13.0）：模型给内容，引擎生成文件；写前同样要用户确认、先备份、可撤回 */
function buildOfficeTools(folderBackend) {
  const checkPath = (p, ext) => {
    const path = String(p || "").trim();
    if (!path.startsWith("/")) return [null, "工具执行失败：file_path 要以 / 开头，是文件夹里的路径"];
    if (/^\/(草稿|SAP技能|large_tool_results|conversation_history)\//.test(path)) return [null, "工具执行失败：只能存进用户文件夹"];
    if (!path.toLowerCase().endsWith("." + ext)) return [null, `工具执行失败：file_path 要以 .${ext} 结尾`];
    return [path, null];
  };
  const excel = tool(
    async ({ file_path, sheets }) => {
      const [path, bad] = checkPath(file_path, "xlsx");
      if (bad) return bad;
      let list = sheets;
      if (typeof list === "string") { try { list = JSON.parse(list); } catch (e) { return "工具执行失败：sheets 要是数组"; } }
      if (!Array.isArray(list) || !list.length) return "工具执行失败：sheets 至少要有一个工作表";
      let bytes, preview;
      try {
        bytes = await buildXlsx(list);
        preview = await officeToText(path, bytes);
      } catch (e) { return `工具执行失败：${(e && e.message) || e}`; }
      const nRows = list.reduce((n, s) => n + ((s && Array.isArray(s.rows)) ? s.rows.length : 0), 0);
      const w = await folderBackend.writeOffice(path, bytes, preview, `${list.length} 个工作表，${nRows} 行数据`);
      if (w && w.error) return w.error;
      return `已保存 ${path}：${list.length} 个工作表，共 ${nRows} 行数据（不含表头）。`;
    },
    {
      name: "create_excel_file",
      description: "在用户文件夹里新建一个 Excel（.xlsx）文件（写前会让用户确认；同名文件会被整份覆盖，原文件先备份）。" +
        "有表头时第一行加粗并冻结。可以用 styles 给单元格填底色、改字体颜色、加粗。数字用数值类型传（能求和）；料号、工单号等编号用字符串传（保留前导 0）。" +
        "报表结果要存成 Excel 时不要用这个，用 save_result_to_folder。",
      schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "文件夹里的路径，以 .xlsx 结尾，如 /分析/库存汇总.xlsx" },
          sheets: {
            type: "array",
            description: "工作表（至少一个）",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "工作表名（≤ 31 字）" },
                columns: { type: "array", items: { type: "string" }, description: "表头（列名）" },
                rows: { type: "array", items: { type: "array", items: {} }, description: "数据行，每行是一个数组，顺序和表头一致" },
                styles: {
                  type: "array",
                  description: "可选：单元格格式（底色、字体颜色、加粗），如状态列标红、预警行填黄、用底色拼图案。行号按 Excel 里的实际位置（有表头时表头是第 1 行、数据从第 2 行开始）；只设格式不填值的单元格也会显示底色",
                  items: {
                    type: "object",
                    properties: {
                      range: { type: "string", description: "单元格或区域，如 B3、A2:D2、C2:C20" },
                      fill: { type: "string", description: "底色：#RRGGBB 或 红 / 浅红 / 黄 / 浅黄 / 绿 / 浅绿 / 蓝 / 浅蓝 / 橙 / 紫 / 灰 / 浅灰 / 黑 / 白" },
                      font_color: { type: "string", description: "字体颜色，写法同 fill" },
                      bold: { type: "boolean", description: "加粗" }
                    },
                    required: ["range"]
                  }
                }
              },
              required: ["rows"]
            }
          }
        },
        required: ["file_path", "sheets"]
      }
    }
  );
  const word = tool(
    async ({ file_path, content }) => {
      const [path, bad] = checkPath(file_path, "docx");
      if (bad) return bad;
      const text = String(content || "");
      if (!text.trim()) return "工具执行失败：content 不能为空";
      let bytes, preview;
      try {
        bytes = await buildDocx(text);
        preview = await officeToText(path, bytes);
      } catch (e) { return `工具执行失败：${(e && e.message) || e}`; }
      const w = await folderBackend.writeOffice(path, bytes, preview, `${text.length} 字`);
      if (w && w.error) return w.error;
      return `已保存 ${path}（${text.length} 字）。`;
    },
    {
      name: "create_word_file",
      description: "在用户文件夹里新建一个 Word（.docx）文件（写前会让用户确认；同名文件会被整份覆盖，原文件先备份）。" +
        "content 用简单 Markdown：# / ## / ### 标题，- 或 1. 列表，| 表格 |（第二行 |---|），**粗体**，空行分段；其余每行一段。不支持图片。",
      schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "文件夹里的路径，以 .docx 结尾，如 /报告/月度库存分析.docx" },
          content: { type: "string", description: "文档内容（简单 Markdown）" }
        },
        required: ["file_path", "content"]
      }
    }
  );
  return [excel, word];
}

/** 把一份报表结果整份写进文件夹（数据 SAP → 浏览器 → 文件，不经过模型；写前同样要用户确认） */
function buildExportTool(client, run, folderBackend, signal) {
  return tool(
    async ({ result_id, file_path }) => {
      const path = String(file_path || "").trim();
      const asXlsx = /\.xlsx$/i.test(path);
      if (!asXlsx && !/\.csv$/i.test(path)) return "工具执行失败：file_path 要以 .csv 或 .xlsx 结尾";
      let r;
      try {
        r = await client.exportResult({ runId: run.runId, resultId: String(result_id || "") }, { signal });
      } catch (e) {
        if (signal && signal.aborted) throw e;
        return `工具执行失败：${(e && e.message) || e}`;
      }
      if (!r || typeof r.csv !== "string") return "工具执行失败：SAP 没有返回数据";
      let w;
      if (asXlsx) {
        // 0.13.0：存成 Excel。普通数字存成数字（能求和），料号等有前导 0 的保留文本
        const rows = parseCsv(r.csv).filter(x => x.length > 1 || (x[0] || "") !== "");
        const head = rows.shift() || [];
        try {
          const bytes = await buildXlsx([{ name: r.label || "结果", columns: head, rows: rows.map(x => x.map(csvValue)) }]);
          w = await folderBackend.writeOffice(path, bytes, await officeToText(path, bytes), `${r.rows} 行 × ${r.columns} 列`);
        } catch (e) { return `工具执行失败：生成 Excel 出错：${(e && e.message) || e}`; }
      } else {
        // 带 BOM：Excel 直接双击打开时中文不乱码
        w = await folderBackend.write(path, "﻿" + r.csv);
      }
      if (w && w.error) return w.error;
      return `已保存 ${path}：「${r.label || result_id}」${r.rows} 行 × ${r.columns} 列` +
        (r.truncated ? `（结果超过导出上限，只导出了前 ${r.rows} 行）` : "") + "。";
    },
    {
      name: "save_result_to_folder",
      description: "把一份报表结果的全部行存成 CSV 或 Excel（.xlsx）文件，放进用户授权的文件夹（写前会让用户确认）。result_id 用 list_results 查到的结果号。",
      schema: {
        type: "object",
        properties: {
          result_id: { type: "string", description: "结果号（list_results 返回的 id）" },
          file_path: { type: "string", description: "文件夹里的路径，以 .csv 或 .xlsx 结尾，如 /报表结果/库存.xlsx" }
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
      case "skill": out.push({ k: "skill", text: (String(e.name || "") + (e.source === "BUILTIN" ? "（内置）" : e.source === "FOLDER" ? "（文件夹）" : "")).slice(0, 60) }); break;
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

/** 11.11 #05：模型调用次数用到最后一次时，不再给工具、提示模型收尾 —— 以前用满就 429，整轮「未完成」 */
export const LAST_CALL_NOTE = "（系统提示：这次运行的模型调用次数已经用完，这是最后一次。不要再调用工具，直接基于已有结果回答：" +
  "说清已经完成了哪些、还差哪些没做；用户发「继续」可以接着做。）";

export function lastCallInit(init) {
  if (!init || typeof init.body !== "string") return init;
  try {
    const b = JSON.parse(init.body);
    if (!Array.isArray(b.tools) || !b.tools.length) return init;
    b.tool_choice = "none";
    b.messages = [...(Array.isArray(b.messages) ? b.messages : []), { role: "user", content: LAST_CALL_NOTE }];
    return { ...init, body: JSON.stringify(b) };
  } catch (e) { return init; }
}

/** 主模型的 fetch：数调用次数（与 SAP 的 BRUN_MAX_MODEL 同口径），第 max 次改成收尾请求；max = 0 不限 */
export function budgetFetch(baseFetch, max) {
  let n = 0;
  return (input, init) => {
    n++;
    return baseFetch(input, max > 0 && n >= max ? lastCallInit(init) : init);
  };
}

/**
 * 11.11 #04 / #05：运行没正常结束（出错、停止、页面关闭、调用次数用完）时存进会话的「进度说明」——
 * 已完成的步骤、失败的步骤、改过的文件、计划里还没做的。下一轮「继续」时模型从会话历史里看到它，从断点接着做。
 */
export function interruptedAnswer(trace, reason, changes) {
  const steps = compactSteps(trace).filter(x => x.k === "tool");
  const done = steps.filter(x => x.st === "OK");
  const bad = steps.filter(x => x.st === "ERROR");
  const line = x => `- ${x.tool}${x.arg ? " " + x.arg : ""}${x.sum ? " → " + x.sum : ""}`;
  const out = [`（未完成：${String(reason || "运行中断").slice(0, 200)}）`, ""];
  out.push(done.length ? `已完成 ${done.length} 步${done.length > 25 ? "（只列最后 25 步）" : ""}：` : "还没有完成任何步骤。");
  done.slice(-25).forEach(x => out.push(line(x)));
  if (bad.length) { out.push("", "失败的步骤："); bad.slice(-5).forEach(x => out.push(line(x))); }
  if (changes && changes.length) {
    out.push("", "已经改动的文件：");
    changes.slice(-20).forEach(c => out.push(`- ${c.action} ${c.path}`));
  }
  let todos = null;
  for (const e of trace || []) if (e.type === "todos") todos = e.todos;
  const left = (todos || []).filter(t => t && t.status !== "completed");
  if (left.length) { out.push("", "计划里还没做的："); left.slice(0, 10).forEach(t => out.push(`- ${String(t.content || "").slice(0, 80)}`)); }
  out.push("", "发「继续」可以从这里接着做，已完成的步骤不用重做。");
  return out.join("\n").slice(0, 3500);
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
    builtinVersion: builtinCache.version,
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

  // 11.11 #04：页面关闭 / 刷新时运行还没收尾 → 用 keepalive 把问题、进度说明和过程记录写回 SAP 会话，
  // 刷新后能看到停在哪一步，「继续」也有上下文（以前这一轮什么都不留，会话里只剩上一次的结果）
  let finished = false;
  let folderRef = null;
  const onHide = () => {
    if (finished) return;
    finished = true;
    const body = { runId: runInfo.runId, status: "ERROR", message: "页面刷新或关闭，运行中断", skillsUsed: [],
      answer: interruptedAnswer(trace, "页面刷新或关闭，运行中断", folderRef ? folderRef.changes : []),
      steps: compactSteps(trace) };
    if (JSON.stringify(body).length > 56000) body.steps = body.steps.slice(-40);
    if (JSON.stringify(body).length > 56000) body.steps = [];
    client.finishRun(body, { keepalive: true }).catch(() => {});
  };
  const hasWin = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (hasWin) window.addEventListener("pagehide", onHide);

  let allowAllWrites = false;
  // 文件夹后端：调用方可传入同一个实例跨多轮复用（撤回要用到之前的修改记录）
  let folderBackend = o.folderBackend || (o.folder ? new FolderBackend(o.folder) : null);
  folderRef = folderBackend;
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
      fetch: budgetFetch(client.modelFetch(runInfo.runId), (runInfo.limits && runInfo.limits.maxModelCalls) || 0),
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
  // 内置技能：顺序在最前，同名时后面的 SAP 技能 / 文件夹技能优先
  const builtinFiles = {};
  const builtinTitle = {};
  // SAP 下发：builtinSkills 是数组 = 新的一份（换掉缓存）；没带 = 和浏览器手里的版本相同；版本号为空 = 这个用户没有内置技能
  if (Array.isArray(runInfo.builtinSkills)) {
    builtinCache.version = String(runInfo.builtinVersion || "");
    builtinCache.list = runInfo.builtinSkills;
  } else if (!runInfo.builtinVersion || runInfo.builtinVersion !== builtinCache.version) {
    builtinCache.version = "";
    builtinCache.list = [];
  }
  for (const b of builtinCache.list) {
    const dir = String((b && b.dir) || "");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(dir) || typeof b.content !== "string" || !b.content) continue;
    builtinFiles[`/${dir}/SKILL.md`] = b.content;
    builtinTitle[dir] = String(b.title || dir).slice(0, 60);
    // 附带资料（如 references/xxx.md）：同一目录下，SKILL.md 里写了什么时候读
    for (const f of Array.isArray(b.files) ? b.files : []) {
      const rel = String((f && f.path) || "");
      if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\.md$/.test(rel) || rel.includes("..") || rel === "SKILL.md" || typeof f.content !== "string") continue;
      builtinFiles[`/${dir}/${rel}`] = f.content;
    }
  }
  const builtinBackend = Object.keys(builtinFiles).length ? new ReadonlyMemBackend(builtinFiles, { owner: "随灵犀发布的内置技能" }) : null;
  const skillSources = [...(builtinBackend ? [BUILTIN_SKILL_DIR] : []), ...(sapSkillBackend ? [SAP_SKILL_DIR] : []),
    ...(folderHasSkills ? [FOLDER_SKILL_DIR] : [])];

  const backend = (cfg) => {
    const mem = new StateBackend(cfg);
    const routes = { "/large_tool_results/": mem, "/conversation_history/": mem, "/草稿/": mem };
    if (sapSkillBackend) routes[SAP_SKILL_DIR] = sapSkillBackend;
    if (builtinBackend) routes[BUILTIN_SKILL_DIR] = builtinBackend;
    return folderBackend || sapSkillBackend || builtinBackend ? new CompositeBackend(folderBackend || mem, routes) : mem;
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
  const tools = buildSapTools(client, runInfo, emit, inner.signal, onCard, onDatasets, folderBackend);
  if (folderBackend && !(folderBackend.opts && folderBackend.opts.readOnly)) tools.push(buildDeleteTool(folderBackend), ...buildOfficeTools(folderBackend));
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
      skillSources.length && runInfo.skillsOpen !== true ? SKILL_SECRET_PROMPT : "",
      canExport ? EXPORT_PROMPT : "",
      canAsk ? ASK_PROMPT : "",
      canAsk ? CHOICE_PROMPT : "",
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
    m = p.match(/^\/内置技能\/([^/]+)\/SKILL\.md$/);
    if (m && builtinTitle[m[1]] && !skillsUsed.has("builtin:" + m[1])) {
      skillsUsed.set("builtin:" + m[1], builtinTitle[m[1]]);
      track({ type: "skill", source: "BUILTIN", id: m[1], name: builtinTitle[m[1]] });
      return;
    }
    m = p.match(/^\/\.lingxi\/技能\/([^/]+)\/SKILL\.md$/);
    if (m && !skillsUsed.has("folder:" + m[1])) {
      skillsUsed.set("folder:" + m[1], m[1]);
      track({ type: "skill", source: "FOLDER", id: "", name: m[1] });
    }
  };

  const callArgs = {};
  const failGuard = createFailGuard();
  let loopStop = null;
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
              const ok = toolOk(t, m.status);
              track({ type: "tool_end", id: m.tool_call_id, tool: m.name, ok,
                summary: summarizeStep(m.name, callArgs[m.tool_call_id], t, ok), preview: t.slice(0, 1000) });
              // 11.10 #04：同一步原样失败多次 → 引擎直接停，不再让模型空转
              const stop = !loopStop && !card && !askOther ? failGuard.note(m.name, callArgs[m.tool_call_id], ok, t) : null;
              if (stop) {
                loopStop = stop;
                const label = (mainArg(m.name, callArgs[m.tool_call_id]) ? `${m.name} ${mainArg(m.name, callArgs[m.tool_call_id])}` : m.name).slice(0, 80);
                loopStop.label = label;
                track({ type: "loop_stop", tool: m.name, reason: stop.reason, count: stop.count });
                inner.abort(new Error("lingxi-loop"));
              }
            }
          }
        }
      }
    }
  } catch (e) {
    if ((card || askOther || loopStop) && !(o.signal && o.signal.aborted)) {
      // 参数卡 / 用户要自己说明：正常收尾，不是错误
    } else {
      status = o.signal && o.signal.aborted ? "CANCELLED" : "ERROR";
      errorMsg = (e && e.message) || String(e);
      track({ type: "error", message: errorMsg, status: e && e.status });
    }
  }
  if (card && status === "OK") answer = String(card.answer || answer || "请在下面的参数卡里核对参数后提交。");
  else if (askOther && status === "OK") answer = askOther + "\n\n请在输入框里直接说明。";
  else if (loopStop && status === "OK") answer = loopStopAnswer(loopStop, loopStop.label || loopStop.tool);

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

  // 11.11 #04 / #05：没正常结束 → 回答换成进度说明（存进会话，「继续」据此接着做）
  let partial = "";
  if (status !== "OK" && !answer) {
    partial = interruptedAnswer(trace, status === "CANCELLED" ? "你停止了这次运行" : errorMsg,
      folderBackend ? folderBackend.changes : []);
  }
  if (hasWin) window.removeEventListener("pagehide", onHide);
  if (finished) {   // 页面已在关闭，收尾已经用 keepalive 发过
    emit({ type: "phase", phase: "done", status });
    if (status !== "OK") throw Object.assign(new Error(errorMsg || status), { status, trace, runId: runInfo.runId, partial });
  }
  finished = true;
  try {
    await client.finishRun({
      runId: runInfo.runId, status, answer: answer || partial, message: errorMsg,
      skillsUsed: [...skillsUsed.keys()].filter(k => !k.startsWith("folder:") && !k.startsWith("builtin:")),
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
  if (status !== "OK") throw Object.assign(new Error(errorMsg || status), { status, trace, runId: runInfo.runId, partial });
  return {
    answer, runId: runInfo.runId, trace, card, datasets, title,
    skills: [...skillsUsed.values()],
    changes: folderBackend ? folderBackend.changes.slice() : [], elapsedMs: Date.now() - started, folder: folderBackend
  };
}

export { lintAbap, prepAbapCheck };
export {
  createSapClient, SapAgentError,
  FolderBackend, folderSupported, pickFolder, restoreFolder, requestFolderPermission, forgetFolder,
  summarizeStep, mainArg, createAdtClient, normalizeUri, parseDataPreview,
  officeToText, buildXlsx, buildDocx
};
