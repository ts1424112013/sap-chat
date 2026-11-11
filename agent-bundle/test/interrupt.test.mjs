/**
 * 引擎 0.18.0（11.11 #03 / #04 / #05）：失败步骤判定、调用次数最后一次收尾、中断进度说明
 * 运行：cd agent-bundle && node --test test/interrupt.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lastCallInit, budgetFetch, interruptedAnswer, LAST_CALL_NOTE } from "../src/index.js";
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
  assert.match(a, /发「继续」可以从这里接着做/);
  assert.ok(!/edit_file/.test(a.split("已经改动")[0].split("失败的步骤")[0]), "没做完的步骤不算已完成");
  assert.ok(interruptedAnswer([], "").startsWith("（未完成：运行中断）"));
  assert.ok(interruptedAnswer(trace, "x".repeat(10000)).length <= 3500);
});
