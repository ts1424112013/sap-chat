import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/index.js";
import { selectResultTables } from "../src/result-tables.js";

test("只有本轮明确选择的表进入回答，过程预览仍按工具归属显示", async () => {
  const names = ["试查物料", "最终排名", "复核数量"];
  const events = [];
  let saved;
  let modelRefs;
  let turn = 0;
  const client = {
    root: "https://sap.test",
    startRun: async () => ({
      runId: "result-tables-test",
      model: "mock",
      tools: [{ name: "query_result", parameters: {
        type: "object", properties: { index: { type: "integer" } }, required: ["index"]
      } }]
    }),
    execTool: async ({ args }) => ({
      ok: true,
      content: '{"ok":true,"rows":1}',
      datasets: [{ name: names[args.index], status: "OK", columns: [{ name: "MATNR" }], rows: [["001"]] }]
    }),
    modelFetch: () => async (_url, init) => {
      const messages = JSON.parse(init.body).messages;
      const index = turn++;
      let message;
      if (index < names.length) {
        message = { role: "assistant", content: "", tool_calls: [{
          id: "call_" + index, type: "function", function: { name: "query_result", arguments: JSON.stringify({ index }) }
        }] };
      } else {
        const results = messages.filter(m => m.role === "tool");
        modelRefs = results.map(m => /可展示的结果表编号：(D\d+)/.exec(
          typeof m.content === "string" ? m.content : JSON.stringify(m.content))?.[1]);
        message = { role: "assistant", content: "排名见下方。\n[[结果表:D2]]" };
      }
      return Response.json({
        id: "mock-" + index, object: "chat.completion", model: "mock",
        choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }]
      });
    },
    finishRun: async body => { saved = body; }
  };
  const result = await run({ question: "给我最终排名", client, onEvent: e => events.push(e) });
  assert.deepEqual(modelRefs, ["D1", "D2", "D3"]);
  assert.deepEqual(result.datasets.map(d => d.name), ["最终排名"]);
  assert.deepEqual(events.filter(e => e.type === "datasets").map(e => [e.id, e.preview[0].name]),
    names.map((name, i) => ["call_" + i, name]));
  assert.equal(events.find(e => e.type === "answer").text, "排名见下方。");
  assert.equal(saved.answer, "排名见下方。");
});

test("只需文字结论时不显示表格，未知或重复的编号不产生额外表格", () => {
  const tables = new Map([["D1", { name: "试查" }], ["D2", { name: "结果" }]]);
  assert.deepEqual(selectResultTables("共 2 条。", tables), { answer: "共 2 条。", datasets: [] });
  assert.deepEqual(selectResultTables("见下方。\n[[结果表：D99，D2、D2]]", tables),
    { answer: "见下方。", datasets: [{ name: "结果" }] });
});
