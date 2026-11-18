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
      querySeq: 2001 + args.index,
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
  assert.deepEqual(result.datasets[0].export_query, { runId: "result-tables-test", querySeq: 2002 });
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

test("多次查到同一份数据只显示一张结果卡，独立报表照常显示", () => {
  const result = { name: "工厂 1000", source: "RESULT", columns: [{ name: "MATNR" }], rows: [["0001"]], export_query: { runId: "r1", querySeq: 2001 } };
  const dup = { ...result, export_query: { runId: "r1", querySeq: 2002 } };
  const other = { ...result, name: "工厂 2000", export_query: { runId: "r1", querySeq: 2003 } };
  const tables = new Map([["D1", result], ["D2", dup], ["D3", other]]);
  assert.deepEqual(selectResultTables("见下方。\n[[结果表:D1,D2,D3]]", tables).datasets, [result, other]);
});

test("第二张报表参数卡：从上一份报表的查询结果或过程说明中自动补齐工厂参数", async () => {
  let step = 0;
  const client = {
    root: "https://sap.test",
    startRun: async () => ({
      runId: "relay-card-test",
      model: "mock",
      tools: [
        { name: "query_result", description: "查结果", parameters: { type: "object", properties: { result_id: { type: "string" } } } },
        { name: "prefill_report", description: "报表接力", parameters: { type: "object", properties: { result_id: { type: "string" }, tcode: { type: "string" }, target_param: { type: "string" }, source_column: { type: "string" } } } }
      ]
    }),
    execTool: async ({ tool }) => {
      if (tool === "query_result") {
        return {
          ok: true,
          content: '{"ok":true,"rows":1}',
          datasets: [{ name: "源报表工厂", status: "OK", columns: [{ name: "WERKS", label: "工廠" }], rows: [["ABZ1"]] }]
        };
      }
      return {
        ok: true,
        content: '{"ok":true,"card":true}',
        card: {
          tool: "prefill_report",
          taskId: "T_SECOND",
          taskModule: "REPORT",
          taskStatus: "WAITING_INPUT",
          needsInput: true,
          pendingParamsJson: JSON.stringify({
            report_id: "RPT_ZDPMM159",
            tcode: "ZDPMM159",
            params: [
              { param_id: "P_WERKS", label: "工廠", required: true, data_type: "CHAR", multi_value: false, range_allowed: false },
              { param_id: "CPN", label: "客戶料號", required: false, data_type: "CHAR", multi_value: true, range_allowed: false }
            ],
            values: { CPN: "A01,A02" }
          }),
          answer: "已带入客户料号。"
        }
      };
    },
    finishRun: async () => {},
    modelFetch: () => async () => {
      step++;
      const message = step === 1
        ? {
          role: "assistant",
          content: "先看上一份报表的工厂。",
          tool_calls: [{ id: "c1", type: "function", function: { name: "query_result", arguments: '{"result_id":"ART1"}' } }]
        }
        : {
          role: "assistant",
          content: "工厂唯一值为 ABZ1，现在打开 ZDPMM159 参数卡。",
          tool_calls: [{ id: "c2", type: "function", function: { name: "prefill_report", arguments: '{"result_id":"ART1","tcode":"ZDPMM159","target_param":"CPN","source_column":"客戶料號"}' } }]
        };
      return Response.json({
        id: "mock_" + step, object: "chat.completion", model: "mock",
        choices: [{ index: 0, finish_reason: "tool_calls", message }]
      });
    }
  };
  const result = await run({ question: "执行 ZDPMM159，工厂等于以上报表的工厂，cpn等于客户料号", client });
  const pending = JSON.parse(result.card.pendingParamsJson);
  assert.equal(pending.values.P_WERKS, "ABZ1");
  assert.equal(pending.values.CPN, "A01,A02");
});
