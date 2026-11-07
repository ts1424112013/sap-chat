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
import { createDeepAgent, CompositeBackend, StateBackend } from "deepagents/browser";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { todoListMiddleware } from "langchain";
import { createSapClient, SapAgentError } from "./sap-client.js";
import {
  FolderBackend, folderSupported, pickFolder, restoreFolder, requestFolderPermission, forgetFolder
} from "./folder-backend.js";
import { ReadonlyMemBackend, skillFiles } from "./readonly-backend.js";

export const VERSION = "0.3.0";
export const MEMORY_FILE = "/灵犀记忆.md";
/** SAP 管理员维护的技能（只读，SAP /run/start 下发） */
export const SAP_SKILL_DIR = "/SAP技能/";
/** 文件夹自带的技能：.lingxi/技能/<名字>/SKILL.md */
export const FOLDER_SKILL_DIR = "/.lingxi/技能/";
const MAX_TOOL_CHARS = 60000;
const CARD_TOOL_TEXT = "参数卡已经显示给用户。本次运行到此结束，不要再调用工具。";

const BASE_PROMPT = `你是「灵犀」，公司内部的 SAP 业务助手，运行在用户浏览器里。
工作方式：
- 多步任务先用 write_todos 列出计划，做完一项勾一项；简单问题直接回答，不必列计划。
- SAP 数据只能通过 SAP 工具获取，不要编造数字；工具返回"部分数据 / 已截断"时，回答里要说明。
- 回答用中文，先给结论，再给依据。`;

const FOLDER_PROMPT = `用户已授权一个本地文件夹，文件工具里的 "/" 就是这个文件夹的根目录。
- 改文件前先读；尽量用 edit_file 做小范围修改，不要整份重写。
- 写文件会先让用户确认，用户拒绝时不要换个方式再写。
- .lingxi/ 目录是灵犀的备份和修改记录，只读。
- ${MEMORY_FILE} 是这个文件夹的长期记忆：学到对以后有用的规则（口径、格式、命名习惯）时，用 edit_file / write_file 记进去，保持简短。
- /草稿/ 下的文件只在本次对话里存在，不会写进用户文件夹，可以放中间结果。`;

const NO_FOLDER_PROMPT = `用户没有授权本地文件夹；文件工具只能用来存放本次对话里的中间结果（浏览器内存，刷新即失）。`;

const SKILL_PROMPT = `技能是做某类事的固定做法：技能清单里有和当前问题相关的，先用 read_file 读它的 SKILL.md，再按做法执行；不相关就不读。`;

const EXPORT_PROMPT = `用户要把报表结果存到文件夹（导出、另存、存成 CSV / Excel）时，用 save_result_to_folder：数据由 SAP 直接写进文件，不经过你，不要自己拼表格内容再 write_file。`;

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
  return (run.tools || []).map(t => tool(
    async (args) => {
      const requestId = rid();
      const r = await client.execTool({ runId: run.runId, tool: t.name, args: args || {}, requestId }, { signal });
      if (r && r.display) emit({ type: "display", tool: t.name, display: r.display });
      // 数据集（查数 / 结果查询 / 数据分析 / 函数）直接交给界面画表格和图表，不经过模型
      if (r && Array.isArray(r.datasets) && r.datasets.length && onDatasets) onDatasets(t.name, r.datasets);
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
  emit({ type: "run", runId: runInfo.runId, model: runInfo.model, tools: (runInfo.tools || []).map(t => t.name) });

  // SAP 已经给出确定性回答（Fiori 报表参数卡 / 候选清单 / 闸门提示）：不调模型，直接收尾
  if (runInfo.answer) {
    const det = { answer: String(runInfo.answer), card: runInfo.card && typeof runInfo.card === "object" ? runInfo.card : null };
    if (det.card) track({ type: "card", tool: det.card.tool || "", taskId: det.card.taskId || "" });
    try {
      await client.finishRun({ runId: runInfo.runId, status: "OK", answer: det.answer, message: "", trace: trace.slice(-200), skillsUsed: [] });
    } catch (e) { emit({ type: "warn", message: "运行结果未能写回 SAP 会话：" + e.message }); }
    emit({ type: "phase", phase: "done", status: "OK" });
    return { answer: det.answer, runId: runInfo.runId, trace, card: det.card, skills: [], datasets: [], deterministic: true,
      changes: [], elapsedMs: Date.now() - started, folder: o.folderBackend || null };
  }

  // 文件夹后端：调用方可传入同一个实例跨多轮复用（撤回要用到之前的修改记录）
  let folderBackend = o.folderBackend || (o.folder ? new FolderBackend(o.folder) : null);
  if (folderBackend) {
    folderBackend.opts = {
      ...folderBackend.opts,
      question: () => o.question,
      onChange: c => track({ type: "file_changed", action: c.action, path: c.path, backup: c.backup }),
      confirm: o.confirmWrites === false ? null : async req => {
        track({ type: "confirm", action: req.action, path: req.path });
        // 没有确认界面时一律拒绝，绝不静默写用户文件
        const r = o.confirm ? await o.confirm(req) : { approved: false, message: "界面不支持确认" };
        const ok = r === true || (r && r.approved === true);
        track({ type: "confirmed", action: req.action, path: req.path, approved: ok });
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

  let memoryFiles;
  if (folderBackend) {
    const m = await folderBackend.read(MEMORY_FILE, 0, 1);
    if (!m.error) memoryFiles = [MEMORY_FILE];
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
  const onDatasets = (toolName, list) => {
    for (const d of list) if (d && typeof d === "object" && datasets.length < 8) datasets.push(d);
    track({ type: "datasets", tool: toolName, count: list.length });
  };
  const tools = buildSapTools(client, runInfo, emit, inner.signal, onCard, onDatasets);
  const canExport = !!(folderBackend && runInfo.export);
  if (canExport) tools.push(buildExportTool(client, runInfo, folderBackend, inner.signal));

  const agent = createDeepAgent({
    name: "lingxi",
    model,
    tools,
    systemPrompt: [
      BASE_PROMPT,
      folderBackend ? FOLDER_PROMPT : NO_FOLDER_PROMPT,
      skillSources.length ? SKILL_PROMPT : "",
      canExport ? EXPORT_PROMPT : "",
      runInfo.systemPrompt || ""
    ].filter(Boolean).join("\n\n"),
    backend,
    memory: memoryFiles,
    skills: skillSources.length ? skillSources : undefined,
    // deepagents 1.16 起待办工具只给部分模型默认开启，这里显式加上。
    // 改文件确认不用框架的 interrupt（浏览器里没有异步上下文），由文件夹后端自己等用户点确认。
    middleware: [todoListMiddleware()]
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
          const msgs = Array.isArray(upd.messages) ? upd.messages : (upd.messages && upd.messages.value) || [];
          for (const m of msgs) {
            const ty = msgType(m);
            if (ty === "ai") {
              const calls = m.tool_calls || [];
              for (const c of calls) {
                if (c.name === "write_todos") continue;
                noteSkill(c.name, c.args);
                track({ type: "tool_start", id: c.id, tool: c.name, args: c.args });
              }
              const t = textOf(m);
              if (!calls.length && t) { answer = t; emit({ type: "answer", text: t }); }
              else if (t) emit({ type: "thinking", text: t });
            } else if (ty === "tool") {
              if (m.name === "write_todos") continue;
              const t = textOf(m);
              track({ type: "tool_end", id: m.tool_call_id, tool: m.name, ok: !/^(Error|工具执行失败)/.test(t), preview: t.slice(0, 300) });
            }
          }
        }
      }
    }
  } catch (e) {
    if (card && !(o.signal && o.signal.aborted)) {
      // 参数卡收尾：不是错误
    } else {
      status = o.signal && o.signal.aborted ? "CANCELLED" : "ERROR";
      errorMsg = (e && e.message) || String(e);
      track({ type: "error", message: errorMsg, status: e && e.status });
    }
  }
  if (card && status === "OK") answer = String(card.answer || answer || "请在下面的参数卡里核对参数后提交。");

  try {
    await client.finishRun({
      runId: runInfo.runId, status, answer, message: errorMsg, trace: trace.slice(-200),
      skillsUsed: [...skillsUsed.keys()].filter(k => !k.startsWith("folder:"))
    });
  } catch (e) { emit({ type: "warn", message: "运行结果未能写回 SAP 会话：" + e.message }); }

  emit({ type: "phase", phase: "done", status });
  if (status !== "OK") throw Object.assign(new Error(errorMsg || status), { status, trace, runId: runInfo.runId });
  return {
    answer, runId: runInfo.runId, trace, card, datasets,
    skills: [...skillsUsed.values()],
    changes: folderBackend ? folderBackend.changes.slice() : [], elapsedMs: Date.now() - started, folder: folderBackend
  };
}

export {
  createSapClient, SapAgentError,
  FolderBackend, folderSupported, pickFolder, restoreFolder, requestFolderPermission, forgetFolder
};
