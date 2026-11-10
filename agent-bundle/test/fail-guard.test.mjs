/**
 * 引擎 0.17.0（11.10 #04）：同一步原样失败 → 停，不再空转
 * 运行：cd agent-bundle && node --test test/fail-guard.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFailGuard, loopStopAnswer, NO_RETRY_RE } from "../src/index.js";

test("权限类错误：同一工具同样参数第 2 次失败就停（参数键顺序不同也算同一次）", () => {
  const g = createFailGuard();
  assert.equal(g.note("describe_table", { table: "/UI2/CATALOGS", x: 1 }, false, "工具执行失败：没有权限读取表 /UI2/CATALOGS"), null);
  assert.equal(g.note("describe_table", { table: "/UI2/PAGE_BUILDER_CONF" }, false, "工具执行失败：没有权限读取表"), null);
  const s = g.note("describe_table", { x: 1, table: "/UI2/CATALOGS" }, false, "工具执行失败：没有权限读取表 /UI2/CATALOGS");
  assert.ok(s);
  assert.equal(s.reason, "same");
  assert.equal(s.noRetry, true);
  assert.match(loopStopAnswer(s, "describe_table /UI2/CATALOGS"), /已经失败 2 次[\s\S]*没有权限读取表[\s\S]*申请/);
});

test("超时等可能临时的错误：同样参数第 3 次才停；中间成功不清同一调用的次数", () => {
  const g = createFailGuard();
  assert.equal(g.note("run_sql", { sql: "A" }, false, "工具执行失败：timeout"), null);
  assert.equal(g.note("read_file", { p: 1 }, true, "ok"), null);
  assert.equal(g.note("run_sql", { sql: "A" }, false, "工具执行失败：timeout"), null);
  assert.equal(g.note("run_sql", { sql: "A" }, false, "工具执行失败：timeout").reason, "same");
});

test("参数每次都换但连续 6 步失败也停；成功一步清零连续计数", () => {
  const g = createFailGuard();
  for (let i = 0; i < 5; i++) assert.equal(g.note("run_sql", { sql: "Q" + i }, false, "语法错误"), null);
  assert.equal(g.note("x", {}, true, ""), null);
  for (let i = 0; i < 5; i++) assert.equal(g.note("run_sql", { sql: "R" + i }, false, "语法错误"), null);
  assert.equal(g.note("run_sql", { sql: "R9" }, false, "语法错误").reason, "inARow");
});

test("不可重试错误的识别", () => {
  for (const t of ["没有权限读取表", "表 ZXX 不存在", "Not authorized", "HTTP 403", "未登记的报表"]) assert.ok(NO_RETRY_RE.test(t), t);
  for (const t of ["timeout", "语法错误：缺少 FROM", "连接中断"]) assert.ok(!NO_RETRY_RE.test(t), t);
});
