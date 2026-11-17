/**
 * 引擎 0.18.0（11.11 #03 / #04 / #05）：失败步骤判定、调用次数最后一次收尾、中断进度说明
 * 运行：cd agent-bundle && node --test test/interrupt.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lastCallInit, budgetFetch, interruptedAnswer, LAST_CALL_NOTE, run } from "../src/index.js";
import { toolOk } from "../src/step-summary.js";

test("#03 SAP 工具回 {\"ok\":false} 算失败，不再打绿勾", () => {
  assert.equal(toolOk('{"ok":false,"error":"ZIDPMM501_SUB 不存在或无法读取"}'), false);
  assert.equal(toolOk('  { "ok" : false }'), false);
  assert.equal(toolOk("工具执行失败：x"), false);
  assert.equal(toolOk("Error: x"), false);
  assert.equal(toolOk("anything", "error"), false);
  assert.equal(toolOk('{"ok":true,"total_lines":374}'), true);
  assert.equal(toolOk("读了 374 行"), true);
});

test("#05 最后一次模型调用：tool_choice = none 并追加收尾提示；没有工具的请求不动", () => {
  const body = { model: "m", messages: [{ role: "user", content: "q" }], tools: [{ type: "function" }] };
  const out = JSON.parse(lastCallInit({ method: "POST", body: JSON.stringify(body) }).body);
  assert.equal(out.tool_choice, "none");
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[1].content, LAST_CALL_NOTE);
  const plain = { body: JSON.stringify({ messages: [] }) };
  assert.equal(lastCallInit(plain), plain);
  assert.equal(lastCallInit({ body: "not json" }).body, "not json");
});

test("#05 budgetFetch 只改第 max 次及以后；max = 0 不限", async () => {
  const seen = [];
  const base = async (u, init) => { seen.push(JSON.parse(init.body).tool_choice || ""); return "ok"; };
  const init = () => ({ body: JSON.stringify({ messages: [], tools: [{}] }) });
  const f = budgetFetch(base, 3);
  for (let i = 0; i < 4; i++) await f("u", init());
  assert.deepEqual(seen, ["", "", "none", "none"]);
  seen.length = 0;
  const g = budgetFetch(base, 0);
  for (let i = 0; i < 3; i++) await g("u", init());
  assert.deepEqual(seen, ["", "", ""]);
});

test("#04 中断进度说明：原因、已完成 / 失败步骤、改过的文件、计划里没做的、继续提示", () => {
  const trace = [
    { type: "todos", todos: [{ content: "读三个程序", status: "completed" }, { content: "改表名", status: "in_progress" }, { content: "语法检查", status: "pending" }] },
    { type: "tool_start", id: "1", tool: "read_file", arg: "/代码/ZIDPMM501.abap", at: 0 },
    { type: "tool_end", id: "1", ok: true, summary: "读了 374 行", at: 10 },
    { type: "tool_start", id: "2", tool: "read_program_source", arg: "ZIDPMM501_SUB", at: 10 },
    { type: "tool_end", id: "2", ok: false, summary: "不存在", at: 12 },
    { type: "tool_start", id: "3", tool: "edit_file", arg: "/代码/ZIDPMM502.abap", at: 12 }
  ];
  const a = interruptedAnswer(trace, "这次运行的模型调用已达上限(40 次)", [{ action: "修改", path: "/代码/ZIDPMM501.abap" }]);
  assert.match(a, /^（未完成：这次运行的模型调用已达上限\(40 次\)）/);
  assert.match(a, /已完成 1 步/);
  assert.match(a, /read_file \/代码\/ZIDPMM501\.abap → 读了 374 行/);
  assert.match(a, /失败的步骤：\n- read_program_source ZIDPMM501_SUB → 不存在/);
  assert.match(a, /已经改动的文件：\n- 修改 \/代码\/ZIDPMM501\.abap/);
  assert.match(a, /计划里还没做的：\n- 改表名\n- 语法检查/);
  assert.match(a, /发「继续」可以根据已保存的进度接着做/);
  assert.ok(!/edit_file/.test(a.split("已经改动")[0].split("失败的步骤")[0]), "没做完的步骤不算已完成");
  assert.ok(interruptedAnswer([], "").startsWith("（未完成：运行中断）"));
  assert.ok(interruptedAnswer(trace, "x".repeat(10000)).length <= 3500);
});

test("初始化异常也写回当前运行的中断进度，并关闭确认入口", async () => {
  const finishes = [];
  const events = [];
  await assert.rejects(run({
    question: "继续任务",
    context: { sessionId: "S1" },
    folderBackend: { changes: [{ action: "修改", path: "/other-session.txt" }], ls: async () => {
      throw new Error("文件夹暂时不可用");
    } },
    client: {
      root: "https://sap.invalid",
      startRun: async () => ({ runId: "R1", tools: [] }),
      modelFetch: () => async () => { throw new Error("不应调用模型"); },
      finishRun: async body => finishes.push(body)
    },
    onEvent: e => events.push(e)
  }), { status: "ERROR", runId: "R1", message: "文件夹暂时不可用" });
  assert.equal(finishes.length, 1);
  assert.match(finishes[0].answer, /^（未完成：文件夹暂时不可用）/);
  assert.doesNotMatch(finishes[0].answer, /other-session/);
  assert.ok(events.some(e => e.type === "cancel_asks"));
});

test("继续使用前一轮的原问题、进度并要求读取当前文件，SAP 仍收到用户原话", async () => {
  const requests = [];
  const starts = [];
  const finishes = [];
  const answer = await run({
    question: "继续",
    history: [
      { role: "user", content: "核对需求并检查代码" },
      { role: "assistant", content: "（未完成：你停止了这次运行）\n已完成 1 步", unsaved: true }
    ],
    client: {
      root: "https://sap.invalid",
      startRun: async body => {
        starts.push(body);
        return {
          runId: "R2", model: "mock", tools: [],
          chatContext: { through: 0, summary: "", messages: [] }
        };
      },
      modelFetch: () => async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "reply", object: "chat.completion", model: "mock", choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "核对完成" } }
        ], usage: { prompt_tokens: 340, completion_tokens: 12, total_tokens: 352 } }), { headers: { "Content-Type": "application/json" } });
      },
      finishRun: async body => finishes.push(body)
    }
  });
  assert.equal(starts[0].question, "继续");
  const messages = requests[0].messages;
  assert.ok(messages.some(m => m.content === "核对需求并检查代码"));
  assert.ok(messages.some(m => typeof m.content === "string" && m.content.includes("已完成 1 步")));
  assert.match(messages.at(-1).content, /已完成的写入、删除和提交不要重复执行/);
  assert.match(messages.at(-1).content, /先读取文件的当前内容/);
  assert.equal(answer.answer, "核对完成");
  assert.equal(finishes[0].status, "OK");
  assert.deepEqual(finishes[0].steps.at(-1), { k: "usage", ds: 340, dn: 256000 });
});

test("跨轮压缩会保存覆盖序号，新运行沿用摘要并带上后续原文", async () => {
  const history = Array.from({ length: 66 }, (_, i) => ({
    seq: i + 1, role: i % 2 ? "assistant" : "user", content: `原始消息 ${i + 1}`
  }));
  const requests = [];
  const events = [];
  let checkpoint;
  const makeClient = () => ({
    root: "https://sap.invalid",
    startRun: async body => {
      assert.equal(body.chatContext, true);
      return {
        runId: checkpoint ? "R4" : "R3", model: "mock", tools: [],
        chatContext: checkpoint || { through: 0, summary: "", messages: history }
      };
    },
    modelFetch: () => async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const summarizing = request.messages.some(m => typeof m.content === "string" && m.content.startsWith("你在压缩当前 SAP 聊天"));
      const content = summarizing ? "已确认仅查工厂 1000" : "当前回答";
      return new Response(JSON.stringify({ id: "reply", object: "chat.completion", model: "mock", choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content } }
      ] }), { headers: { "Content-Type": "application/json" } });
    },
    finishRun: async body => {
      if (checkpoint) {
        assert.equal(body.contextSeq, undefined, "短的后续对话无需重新压缩");
        return;
      }
      assert.equal(body.contextSeq, 60);
      assert.equal(body.contextSummary, "已确认仅查工厂 1000");
      checkpoint = {
        through: body.contextSeq,
        summary: body.contextSummary,
        messages: [
          ...history.filter(m => m.seq > body.contextSeq),
          { seq: 67, role: "user", content: "查本期库存" },
          { seq: 68, role: "assistant", content: body.answer }
        ]
      };
    }
  });

  await run({ question: "查本期库存", client: makeClient(), onEvent: e => events.push(e) });
  const summarized = JSON.parse(requests[0].messages.at(-1).content);
  assert.equal(summarized.messages.length, 60);
  assert.equal(summarized.messages[0].content, "原始消息 1");
  assert.ok(events.some(e => e.type === "compacted" && e.scope === "chat"));

  const result = await run({ question: "换成上期", client: makeClient() });
  assert.equal(result.answer, "当前回答");
  assert.equal(requests.length, 3);
  const continued = requests[2].messages;
  assert.ok(continued.some(m => m.content === "【本聊天历史摘要】\n已确认仅查工厂 1000"));
  assert.ok(continued.some(m => m.content === "原始消息 61"));
  assert.ok(continued.some(m => m.content === "查本期库存"));
  assert.ok(!continued.some(m => m.content === "原始消息 60"));
  assert.equal(continued.at(-1).content, "换成上期");
});

test("摘要请求失败仍可回答，并保留上次已保存的摘要", async () => {
  const requests = [];
  const finishes = [];
  const messages = Array.from({ length: 10 }, (_, i) => ({
    seq: i + 11, role: i % 2 ? "assistant" : "user", content: `历史 ${i + 11} ` + "长".repeat(2500)
  }));
  const result = await run({
    question: "最新问题",
    client: {
      root: "https://sap.invalid",
      startRun: async () => ({
        runId: "R5", model: "mock", tools: [], limits: { contextTokens: 16000 },
        chatContext: { through: 10, summary: "旧口径", messages }
      }),
      modelFetch: () => async (_url, init) => {
        requests.push(JSON.parse(init.body));
        if (requests.length === 1) throw new Error("摘要调用失败");
        return new Response(JSON.stringify({ id: "reply", object: "chat.completion", model: "mock", choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "最新回答" } }
        ] }), { headers: { "Content-Type": "application/json" } });
      },
      finishRun: async body => finishes.push(body)
    }
  });
  assert.equal(result.answer, "最新回答");
  assert.equal(finishes[0].contextSeq, undefined);
  assert.ok(requests[1].messages.some(m => m.content === "【本聊天历史摘要】\n旧口径"));
  assert.ok(requests[1].messages.some(m => m.content === messages.at(-1).content));
});

test("收尾遇到临时网络错误时重发同一结果，权限错误直接提示", async () => {
  for (const status of [503, 403]) {
    const bodies = [];
    const events = [];
    await run({
      question: "测试收尾",
      client: {
        startRun: async () => ({ runId: "R3", answer: "已完成" }),
        finishRun: async body => {
          bodies.push(body);
          if (bodies.length === 1) throw Object.assign(new Error("SAP 请求失败"), { status });
        }
      },
      onEvent: event => events.push(event)
    });
    assert.equal(bodies.length, status === 503 ? 2 : 1);
    if (status === 503) assert.deepEqual(bodies[1], bodies[0]);
    assert.equal(events.some(event => event.type === "save_failed"), status === 403);
  }
});
