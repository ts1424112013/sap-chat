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

export const VERSION = "0.1.0";
export const MEMORY_FILE = "/灵犀记忆.md";
const MAX_TOOL_CHARS = 60000;

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

function clip(s, n = MAX_TOOL_CHARS) {
  s = typeof s === "string" ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + `\n…[已截断，原长 ${s.length} 字符]` : s;
}

function rid() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "");
}

/** 把 SAP 返回的工具清单包装成 LangChain 工具；执行时再交给 SAP 校验 */
function buildSapTools(client, run, emit, signal) {
  return (run.tools || []).map(t => tool(
    async (args) => {
      const requestId = rid();
      const r = await client.execTool({ runId: run.runId, tool: t.name, args: args || {}, requestId }, { signal });
      if (r && r.display) emit({ type: "display", tool: t.name, display: r.display });
      if (r && r.ok === false) return `工具执行失败：${r.message || "未知原因"}`;
      return clip(r && r.content != null ? r.content : r);
    },
    {
      name: t.name,
      description: t.description || t.name,
      schema: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} }
    }
  ));
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
 * @param {{sessionId?:string, scene?:string, modelId?:string, think?:boolean}} [o.context]
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
    folder: o.folderBackend ? o.folderBackend.name : (o.folder ? o.folder.name : "")
  }, { signal: o.signal });
  if (!runInfo || !runInfo.runId) throw new SapAgentError("SAP 没有返回运行号", 0, runInfo);
  emit({ type: "run", runId: runInfo.runId, model: runInfo.model, tools: (runInfo.tools || []).map(t => t.name) });

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

  const backend = (cfg) => {
    const mem = new StateBackend(cfg);
    const routes = { "/large_tool_results/": mem, "/conversation_history/": mem, "/草稿/": mem };
    return folderBackend ? new CompositeBackend(folderBackend, routes) : mem;
  };

  let memoryFiles;
  if (folderBackend) {
    const m = await folderBackend.read(MEMORY_FILE, 0, 1);
    if (!m.error) memoryFiles = [MEMORY_FILE];
  }

  const agent = createDeepAgent({
    name: "lingxi",
    model,
    tools: buildSapTools(client, runInfo, emit, o.signal),
    systemPrompt: [BASE_PROMPT, folderBackend ? FOLDER_PROMPT : NO_FOLDER_PROMPT, runInfo.systemPrompt || ""].filter(Boolean).join("\n\n"),
    backend,
    memory: memoryFiles,
    // deepagents 1.16 起待办工具只给部分模型默认开启，这里显式加上。
    // 改文件确认不用框架的 interrupt（浏览器里没有异步上下文），由文件夹后端自己等用户点确认。
    middleware: [todoListMiddleware()]
  });

  const messages = [...(o.history || []).map(h => ({ role: h.role, content: h.content })), { role: "user", content: o.question }];
  const config = { configurable: { thread_id: runInfo.runId }, recursionLimit: (runInfo.limits && runInfo.limits.recursionLimit) || 120, signal: o.signal };

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
    status = o.signal && o.signal.aborted ? "CANCELLED" : "ERROR";
    errorMsg = (e && e.message) || String(e);
    track({ type: "error", message: errorMsg, status: e && e.status });
  }

  try {
    await client.finishRun({ runId: runInfo.runId, status, answer, message: errorMsg, trace: trace.slice(-200) });
  } catch (e) { emit({ type: "warn", message: "运行结果未能写回 SAP 会话：" + e.message }); }

  emit({ type: "phase", phase: "done", status });
  if (status !== "OK") throw Object.assign(new Error(errorMsg || status), { status, trace, runId: runInfo.runId });
  return { answer, runId: runInfo.runId, trace, changes: folderBackend ? folderBackend.changes.slice() : [], elapsedMs: Date.now() - started, folder: folderBackend };
}

export {
  createSapClient, SapAgentError,
  FolderBackend, folderSupported, pickFolder, restoreFolder, requestFolderPermission, forgetFolder
};
