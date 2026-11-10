/**
 * 引擎 0.17.0（11.10 #13）：ABAP 常见错误写法扫描 + abap_check 读文件夹源码
 * 运行：cd agent-bundle && node --test test/abap-lint.test.mjs
 * 样本取自 11.10 记录 #13 附录里灵犀生成的三个程序（摘要）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lintAbap, prepAbapCheck } from "../src/index.js";
import { summarizeStep } from "../src/step-summary.js";

const BAD = `REPORT zrpp_sub_module_monitor.
TABLES: zidpmm501, zidpmm502.
SELECT-OPTIONS: s_werks FOR zidpmm501-werks,
                s_erdat FOR aufk-erdat.
DATA: lv_cnt TYPE i.
SELECTION-SCREEN COMMENT (31) comm002 FOR FIELD p_file.
START-OF-SELECTION.
  SELECT COUNT(*) FROM csk t INTO lv_cnt WHERE kostl = p_kostl.
  SELECT SUM( labst ) FROM mspr
    WHERE matnr = gs_stock-matnr
    ADDING CORRESPONDING FIELDS OF gs_stock.
  SELECT SUM( r~bdmng - r~enmng ) INTO lv_uniss FROM resb AS r WHERE r~aufnr = lv_aufnr.
  MODIFY gt_result FROM gs_result TRANSPORTING
    unissqty = lv_uniss WHERE subname = lv_sub.
  " 注释里的 FROM csk t 不算
  WRITE: / 'FROM abc d'.
`;

test("扫描出文档里那几类：表名断开、ADDING、聚合套表达式、TRANSPORTING 赋值、FOR 未声明的表", () => {
  const f = lintAbap(BAD);
  const rules = f.map(x => x.rule);
  assert.deepEqual([...new Set(rules)].sort(),
    ["adding-corresponding", "aggregate-expr", "select-options-for", "table-space", "transporting-assign"]);
  assert.equal(f.find(x => x.rule === "table-space").line, 8);
  assert.match(f.find(x => x.rule === "select-options-for").message, /AUFK/);
  assert.equal(f.filter(x => x.rule === "table-space").length, 1, "注释 / 字符串里的不算");
});

test("正常写法不误报：别名写 AS、新写法聚合、SELECTION-SCREEN COMMENT 自带变量、TRANSPORTING 字段名", () => {
  const ok = `REPORT z.
TABLES mara.
DATA: lv_x TYPE p DECIMALS 2.
SELECT-OPTIONS s_matnr FOR mara-matnr.
SELECTION-SCREEN COMMENT (31) comm002.
SELECT SUM( r~bdmng - r~enmng ) FROM resb AS r WHERE r~aufnr = @lv_aufnr INTO @lv_x.
SELECT SINGLE * FROM mara INTO @DATA(ls_m) WHERE matnr = @lv_m.
SELECT a~matnr FROM mara AS a INNER JOIN marc AS c ON c~matnr = a~matnr INTO TABLE @DATA(lt).
MODIFY gt FROM gs TRANSPORTING qty WHERE id = lv_id.
lv_x = '1.5'.`;
  assert.deepEqual(lintAbap(ok), []);
});

test("abap_check：file_path → 引擎读文件放进 source，附上扫描结果；没授权文件夹时说明", async () => {
  const fb = { read: async (p) => (p === "/程序/z.abap" ? { content: BAD } : { error: "Error: not found" }) };
  const p = await prepAbapCheck({ file_path: "/程序/z.abap" }, fb);
  assert.equal(p.args.source, BAD);
  assert.equal(p.args.file_path, undefined);
  assert.equal(p.args.name, "z.abap");
  assert.match(p.lint, /第 8 行：「FROM CSK T」/);
  assert.match((await prepAbapCheck({ file_path: "/x.abap" }, null)).error, /source/);
  assert.match((await prepAbapCheck({ file_path: "/y.abap" }, fb)).error, /not found/);
  assert.equal((await prepAbapCheck({ source: "REPORT z." }, null)).lint, "");
});

test("过程里一句话结果", () => {
  assert.equal(summarizeStep("abap_check", {}, '{"ok":true,"passed":true,"lines":373,"message":"x"}', true), "语法检查通过（373 行）");
  assert.equal(summarizeStep("abap_check", {}, '{"ok":true,"passed":false,"line":244,"word":"T","message":"表 \\"CSK\\" 未知","code":"x"}', true),
    '第 244 行：表 "CSK" 未知');
});
