/**
 * 引擎 0.13.0：Office 文件读写（src/office.js）+ 文件夹后端接入（read_file 分页 / writeOffice 确认、备份、撤回）
 * 运行：cd agent-bundle && node --test test/office.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  openZip, makeZip, officeToText, buildXlsx, buildDocx, parseCsv, csvValue, colName, colIndex, excelDate, markdownToDocxBody, topLevel
} from "../src/office.js";
import { FolderBackend, canWritePath } from "../src/folder-backend.js";

// ---------- 内存文件夹（File System Access API 的最小替身） ----------
class MemFile {
  constructor(name, dir) { this.kind = "file"; this.name = name; this.dir = dir; }
  async getFile() {
    const d = this.dir.files.get(this.name);
    return { size: d.bytes.length, lastModified: d.mtime, text: async () => new TextDecoder().decode(d.bytes), arrayBuffer: async () => d.bytes.slice().buffer };
  }
  async createWritable(opts = {}) {
    const dir = this.dir, name = this.name;
    let buf = opts.keepExistingData ? dir.files.get(name).bytes.slice() : new Uint8Array(0);
    let pos = 0;
    return {
      async seek(p) { pos = p; },
      async write(x) {
        const b = typeof x === "string" ? new TextEncoder().encode(x) : x instanceof ArrayBuffer ? new Uint8Array(x) : x;
        const n = new Uint8Array(Math.max(buf.length, pos + b.length)); n.set(buf); n.set(b, pos); buf = n; pos += b.length;
      },
      async close() { dir.files.set(name, { bytes: buf, mtime: Date.now() + Math.random() }); }
    };
  }
}
class MemDir {
  constructor(name = "root") { this.kind = "directory"; this.name = name; this.files = new Map(); this.dirs = new Map(); }
  async getDirectoryHandle(n, { create } = {}) {
    if (!this.dirs.has(n)) { if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); this.dirs.set(n, new MemDir(n)); }
    return this.dirs.get(n);
  }
  async getFileHandle(n, { create } = {}) {
    if (!this.files.has(n)) {
      if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
      this.files.set(n, { bytes: new Uint8Array(0), mtime: Date.now() });
    }
    return new MemFile(n, this);
  }
  async removeEntry(n) { this.files.delete(n); }
  async *entries() {
    for (const [n, d] of this.dirs) yield [n, d];
    for (const n of this.files.keys()) yield [n, new MemFile(n, this)];
  }
}

// ---------- zip ----------
test("zip：打包再解开，压缩 / 不压缩都对，中文文件名", async () => {
  const big = "灵犀".repeat(500);
  const z = await makeZip([{ name: "a.txt", data: "hi" }, { name: "目录/大.txt", data: big }]);
  const u = openZip(z);
  assert.deepEqual(u.names, ["a.txt", "目录/大.txt"]);
  assert.equal(await u.text("a.txt"), "hi");
  assert.equal(await u.text("目录/大.txt"), big);
  assert.equal(await u.read("没有.txt"), null);
});

test("zip：不是 zip 时给出说明", () => {
  assert.throws(() => openZip(new TextEncoder().encode("plain text, not a zip")), /不是有效的 Office 文件/);
});

// ---------- 小工具 ----------
test("列名换算", () => {
  assert.equal(colName(0), "A"); assert.equal(colName(25), "Z"); assert.equal(colName(26), "AA"); assert.equal(colName(701), "ZZ"); assert.equal(colName(702), "AAA");
  for (const i of [0, 25, 26, 51, 701, 702, 16383]) assert.equal(colIndex(colName(i)), i);
});

test("Excel 日期序列号", () => {
  assert.equal(excelDate(45658), "2025-01-01");
  assert.equal(excelDate(45658.5), "2025-01-01 12:00");
  assert.equal(excelDate(44197, true), "2025-01-02");
});

test("CSV 解析：引号、逗号、换行、BOM", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","他说""好"""\r\n"多\n行",\r\n'), [["a", "b"], ["x,1", '他说"好"'], ["多\n行", ""]]);
});

test("CSV 值：普通数字转数字，编号保留文本", () => {
  assert.equal(csvValue("12"), 12);
  assert.equal(csvValue("12.50"), 12.5);
  assert.equal(csvValue("-3.2"), -3.2);
  assert.equal(csvValue("12.5-"), -12.5);   // SAP 负号在后
  assert.equal(csvValue("0"), 0);
  assert.equal(csvValue("0.25"), 0.25);
  assert.equal(csvValue("000123"), "000123"); // 料号前导 0
  assert.equal(csvValue("12345678901234567"), "12345678901234567"); // 超过 15 位
  assert.equal(csvValue("1,234"), "1,234");
  assert.equal(csvValue("2025-01-01"), "2025-01-01");
  assert.equal(csvValue(""), "");
});

test("topLevel：同名嵌套按深度配对", () => {
  const els = topLevel("<w:p>a<w:tbl><w:tr><w:tc><w:tbl>x</w:tbl></w:tc></w:tr></w:tbl></w:p><w:tbl>y</w:tbl><w:p/>", ["w:tbl", "w:p"]);
  assert.deepEqual(els.map(e => e.name), ["w:p", "w:tbl", "w:p"]);
  const inner = topLevel(els[0].inner, ["w:tbl"]);
  assert.equal(inner.length, 1);
  assert.match(inner[0].inner, /<w:tbl>x<\/w:tbl>/);
});

// ---------- xlsx ----------
test("xlsx：新建再读回，数字 / 文本 / 前导 0 / 多工作表 / 工作表名清洗", async () => {
  const bytes = await buildXlsx([
    { name: "库存", columns: ["物料", "工厂", "数量", "说明"], rows: [["000123", "1000", 12.5, "a\tb"], ["ABC", "1000", -3, null], [], ["X", null, 0, "<&>"]] },
    { name: "库存", rows: [[1, 2, 3]] },
    { name: "a/b:c*?[x]", rows: [] }
  ]);
  const u = openZip(bytes);
  assert.ok(u.names.includes("xl/worksheets/sheet3.xml"));
  const wb = await u.text("xl/workbook.xml");
  assert.match(wb, /name="库存_2"/);
  assert.match(wb, /name="a_b_c___x_"/);
  const sheet1 = await u.text("xl/worksheets/sheet1.xml");
  assert.match(sheet1, /state="frozen"/);
  assert.match(sheet1, /<c r="C2"><v>12.5<\/v><\/c>/);   // 数字存成数字
  assert.match(sheet1, /<c r="A2" t="s">/);               // 料号存成文本

  const t = await officeToText("/x.xlsx", bytes);
  const lines = t.split("\n");
  assert.ok(lines.includes("## 工作表 1「库存」：4 行有数据，A–D 列"));
  assert.ok(lines.includes("行\tA\tB\tC\tD"));
  assert.ok(lines.includes("1\t物料\t工厂\t数量\t说明"));
  assert.ok(lines.includes("2\t000123\t1000\t12.5\ta b"));
  assert.ok(lines.includes("3\tABC\t1000\t-3"));
  assert.ok(lines.includes("5\tX\t\t0\t<&>"));
  assert.ok(lines.includes("## 工作表 3「a_b_c___x_」：空表"));
});

test("xlsx：读真实格式 —— 共享字符串富文本、行内字符串、布尔、日期格式、隐藏表、无 r 属性", async () => {
  const W = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files = [
    { name: "xl/workbook.xml", data: `<workbook ${W}><workbookPr/><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="藏" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="/xl/worksheets/s2.xml"/></Relationships>' },
    { name: "xl/sharedStrings.xml", data: '<sst><si><t>普通</t></si><si><r><rPr><b/></rPr><t>富</t></r><r><t xml:space="preserve">文本 </t></r><rPh><t>ふり</t></rPh></si><si/></sst>' },
    { name: "xl/styles.xml", data: '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/><numFmt numFmtId="165" formatCode="#,##0.00_);[Red](#,##0.00)"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>' },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet ${W}><sheetData>` +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>行内</t></is></c></row>' +
      '<row r="3"><c r="A3" s="1"><v>45658</v></c><c r="B3" s="2"><v>45659</v></c><c r="C3" s="3"><v>1234.5</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="str"><f>A1&amp;B1</f><v>普通富文本 </v></c></row>' +
      '<row><c><v>0.1</v></c><c><v>0.30000000000000004</v></c></row>' +
      '<row r="9"/></sheetData></worksheet>' },
    { name: "xl/worksheets/s2.xml", data: `<worksheet ${W}><sheetData><row r="2"><c r="B2" t="e"><v>#N/A</v></c></row></sheetData></worksheet>` }
  ];
  const t = await officeToText("/r.xlsx", await makeZip(files));
  const lines = t.split("\n");
  assert.ok(lines.includes("1\t普通\t富文本 \t\t行内"), t);
  assert.ok(lines.includes("3\t2025-01-01\t2025-01-02\t1234.5\tTRUE\t普通富文本 "), t);
  assert.ok(lines.includes("4\t0.1\t0.3"), t);
  assert.ok(lines.includes("## 工作表 2「藏」（隐藏）：1 行有数据，A–B 列"), t);
  assert.ok(lines.includes("2\t\t#N/A"), t);
});

test("xlsx：合并单元格、图片位置、文本框文字、批注（需求文档常用）", async () => {
  const W = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const anchor = (col, row, body) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:row>9</xdr:row></xdr:to>${body}<xdr:clientData/></xdr:twoCellAnchor>`;
  const files = [
    { name: "xl/workbook.xml", data: `<workbook ${W}><sheets><sheet name="需求" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet ${W}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row></sheetData>` +
      '<mergeCells count="2"><mergeCell ref="A1:D1"/><mergeCell ref="B3:C4"/></mergeCells><drawing r:id="rId5"/><legacyDrawing r:id="rId6"/></worksheet>' },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: '<Relationships>' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
      '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments1.xml"/></Relationships>' },
    { name: "xl/drawings/drawing1.xml", data: '<xdr:wsDr xmlns:xdr="x" xmlns:a="a">' +
      anchor(0, 2, '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="图片 1" descr="界面截图"/></xdr:nvPicPr></xdr:pic>') +
      anchor(5, 0, '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="3" name="文本框 2"/></xdr:nvSpPr><xdr:txBody><a:bodyPr/><a:p><a:r><a:t>1. 工厂必填</a:t></a:r></a:p><a:p><a:r><a:t>2. 校验 &amp; 报错</a:t></a:r></a:p></xdr:txBody></xdr:sp>') +
      anchor(7, 10, '<xdr:graphicFrame><a:graphic/></xdr:graphicFrame>') + "</xdr:wsDr>" },
    { name: "xl/comments1.xml", data: '<comments><authors><author>张三</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>张三:</t></r><r><t xml:space="preserve">\n标题要改</t></r></text></comment></commentList></comments>' }
  ];
  const t = await officeToText("/q.xlsx", await makeZip(files));
  const lines = t.split("\n");
  assert.ok(lines.includes("合并单元格（2）：A1:D1；B3:C4"), t);
  assert.ok(lines.includes("图片（内容读不到，只有位置和名称）（2）：A3 附近「界面截图」；H11 附近（图表）"), t);
  assert.ok(lines.includes("文本框（1）：F1 附近「1. 工厂必填 / 2. 校验 & 报错」"), t);
  assert.ok(lines.includes("批注（1）：A1（张三）「张三: 标题要改」"), t);
});

test("xlsx：单元格太多时拒绝生成", async () => {
  const rows = Array.from({ length: 1001 }, () => Array(500).fill(1));
  await assert.rejects(() => buildXlsx([{ rows }]), /单元格太多/);
});

// ---------- docx ----------
test("docx：Markdown 新建再读回 —— 标题、列表、表格、粗体、转义", async () => {
  const md = "# 月度库存分析\n\n说明 **重点** 内容 <a&b>\n\n## 一、结论\n- 第一条\n1. 第一步\n\n| 物料 | 数量 |\n|---|---|\n| 000123 | 12 |\n| A\\|B | |\n\n---\n### 附录\n普通段落";
  const bytes = await buildDocx(md);
  const doc = await openZip(bytes).text("word/document.xml");
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(doc, /<w:b\/><\/w:rPr><w:t xml:space="preserve">重点<\/w:t>/);
  assert.match(doc, /&lt;a&amp;b&gt;/);
  const t = await officeToText("/r.docx", bytes);
  const lines = t.split("\n");
  assert.ok(lines.includes("# 月度库存分析"), t);
  assert.ok(lines.includes("## 一、结论"), t);
  assert.ok(lines.includes("### 附录"), t);
  assert.ok(lines.includes("说明 重点 内容 <a&b>"), t);
  assert.ok(lines.includes("• 第一条"), t);
  assert.ok(lines.includes("1. 第一步"), t);
  assert.ok(lines.includes("| 物料 | 数量 |"), t);
  assert.ok(lines.includes("| 000123 | 12 |"), t);
  assert.ok(lines.includes("| A\\|B |  |"), t);
  assert.ok(!t.includes("---\n### 附录"), "分隔线不应进正文");
});

test("docx：中文样式编号（styleId=1）按样式名认标题；修订删除的字不读", async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const files = [
    { name: "word/styles.xml", data: `<w:styles ${W}><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="a3"><w:name w:val="List Paragraph"/></w:style></w:styles>` },
    { name: "word/document.xml", data: `<w:document ${W}><w:body>` +
      '<w:p><w:pPr><w:pStyle w:val="1"/><w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>保留</w:t></w:r><w:del><w:r><w:delText>删掉</w:delText></w:r></w:del><w:r><w:tab/><w:t>后</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="a3"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p>' +
      '<w:sdt><w:sdtContent><w:p><w:r><w:t>内容控件里的段落</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
      "</w:body></w:document>" }
  ];
  const t = await officeToText("/z.docx", await makeZip(files));
  const lines = t.split("\n");
  assert.ok(lines.includes("# 第一章"), t);
  assert.ok(lines.includes("保留\t后"), t);
  assert.ok(lines.includes("- 列表项"), t);
  assert.ok(lines.includes("内容控件里的段落"), t);
});

test("markdownToDocxBody：表头分隔行只认第二行", () => {
  const x = markdownToDocxBody("| a | b |\n|---|---|\n| - | - |");
  assert.equal((x.match(/<w:tr>/g) || []).length, 2);
});

// ---------- pptx ----------
test("pptx：按 presentation.xml 的顺序读每页", async () => {
  const files = [
    { name: "ppt/presentation.xml", data: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>' },
    { name: "ppt/_rels/presentation.xml.rels", data: '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>' },
    { name: "ppt/slides/slide1.xml", data: '<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>' },
    { name: "ppt/slides/slide2.xml", data: '<p:sld><a:p><a:r><a:t>标题</a:t></a:r><a:br/><a:r><a:t lang="zh">换行</a:t></a:r></a:p><a:p></a:p></p:sld>' }
  ];
  const t = await officeToText("/p.pptx", await makeZip(files));
  assert.match(t, /## 第 1 页\n标题\n换行\n\n## 第 2 页\n第二页/);
});

test("旧格式给出另存说明", async () => {
  await assert.rejects(() => officeToText("/a.xls", new Uint8Array(10)), /另存为 \.xlsx/);
  await assert.rejects(() => officeToText("/a.doc", new Uint8Array(10)), /另存为 \.docx/);
});

// ---------- 文件夹后端 ----------
test("文件夹：read_file 读 xlsx 转文本并分页；旧格式报错；write_file 仍不能写 xlsx", async () => {
  const root = new MemDir();
  const fb = new FolderBackend(root);
  const rows = Array.from({ length: 30 }, (_, i) => ["M" + i, i]);
  const bytes = await buildXlsx([{ name: "S", columns: ["料号", "数量"], rows }]);
  root.files.set("库存.xlsx", { bytes, mtime: 1 });
  const r1 = await fb.read("/库存.xlsx", 0, 5);
  assert.equal(r1.mimeType, "text/plain");
  assert.equal(r1.content.split("\n").length, 5);
  assert.equal(r1.totalLines, 35);
  // 第 0 行说明、1 空行、2 工作表标题、3 列名行、4 起是 Excel 第 1 行 …… 第 34 行是 Excel 第 31 行
  const r2 = await fb.read("/库存.xlsx", 34, 5);
  assert.equal(r2.content, "31\tM29\t29");
  root.files.set("旧.xls", { bytes: new Uint8Array(5), mtime: 1 });
  assert.match((await fb.read("/旧.xls")).error, /旧格式/);
  root.files.set("坏.docx", { bytes: new TextEncoder().encode("oops"), mtime: 1 });
  assert.match((await fb.read("/坏.docx")).error, /读不了/);
  assert.equal(canWritePath("/x.xlsx"), false);
  assert.match((await fb.write("/x.xlsx", "a,b")).error, /create_excel_file/);
});

test("文件夹：writeOffice 先确认（给文本预览）、覆盖前备份、可撤回；拒绝时不写", async () => {
  const root = new MemDir();
  const asked = [];
  let answer = true;
  const fb = new FolderBackend(root, { confirm: async req => { asked.push(req); return answer; } });
  const v1 = await buildXlsx([{ name: "A", rows: [["旧"]] }]);
  const p1 = await officeToText("/r.xlsx", v1);
  assert.deepEqual(await fb.writeOffice("/out/r.xlsx", v1, p1, "1 行"), { path: "/out/r.xlsx", filesUpdate: null });
  assert.equal(asked[0].action, "新建");
  assert.equal(asked[0].before, null);
  assert.match(asked[0].after, /1\t旧/);

  const v2 = await buildXlsx([{ name: "A", rows: [["新"]] }]);
  await fb.writeOffice("/out/r.xlsx", v2, await officeToText("/r.xlsx", v2), "1 行");
  assert.equal(asked[1].action, "覆盖");
  assert.match(asked[1].before, /1\t旧/);   // 覆盖时确认框能对比旧内容
  assert.match((await fb.read("/out/r.xlsx")).content, /1\t新/);
  assert.equal(fb.changes.length, 2);
  assert.ok(fb.changes[1].backup.startsWith("/.lingxi/备份/"));

  await fb.undoLast();
  assert.match((await fb.read("/out/r.xlsx")).content, /1\t旧/);
  await fb.undoLast();
  assert.equal((await root.getDirectoryHandle("out")).files.has("r.xlsx"), false);

  answer = false;
  const r = await fb.writeOffice("/out/r.docx", await buildDocx("x"), "x", "");
  assert.match(r.error, /用户拒绝/);
  assert.equal((await root.getDirectoryHandle("out")).files.has("r.docx"), false);

  assert.match((await fb.writeOffice("/a.pdf", new Uint8Array(1), "", "")).error, /只能新建/);
  assert.match((await fb.writeOffice("/.lingxi/a.xlsx", v1, "", "")).error, /read-only/);
});
