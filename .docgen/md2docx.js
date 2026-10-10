/* md2docx.js — 把 docs/ 下的整理版 markdown 转成带封面/目录/页码的 Word 手册
 * 用法: node .docgen/md2docx.js  (在项目根目录运行, 依赖项目 node_modules 的 docx 包)
 * 输出: docs/<同名>.docx
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, PageNumber, NumberFormat, AlignmentType, HeadingLevel,
  WidthType, BorderStyle, ShadingType, SectionType, TableOfContents,
  PageBreak, LevelFormat, TableLayoutType,
} = require("docx");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");

/* ── 配色(DM-1 深青·AI/科技) ───────────────────────────── */
const P = {
  bg: "162235", accent: "37DCF2",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  headText: "1B6B7A",           // 正文标题色(白底, 用暗化的青)
  body: "1A1A1A",
  tbl: { headerBg: "1B6B7A", headerText: "FFFFFF", accentLine: "1B6B7A", innerLine: "C8DDE2", surface: "EDF3F5" },
  codeBg: "F2F4F7", codeText: "24292E", inlineCode: "9C2B4B",
  quote: "5A6472",
};

const FONT_BODY = { ascii: "Times New Roman", eastAsia: "SimSun" };
const FONT_HEAD = { ascii: "Arial", eastAsia: "SimHei" };
const FONT_CODE = { ascii: "Consolas", eastAsia: "Microsoft YaHei" };

/* ── 封面配方 R1 必备函数(照 skill design-system) ─────────── */
const NB = { style: BorderStyle.NONE, size: 0, color: "auto" };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };

function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([..."，。、；：！？", ..."的与和及之在于为", ..."-_—–·/", ..." \t"]);
  const lines = [];
  let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) {
        if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    if (breakAt === -1) {
      breakAt = charsPerLine;
      const prevChar = remaining[breakAt - 1], nextChar = remaining[breakAt];
      if (prevChar && nextChar && !breakAfter.has(prevChar) && !breakAfter.has(nextChar) &&
          /[\u4e00-\u9fff]/.test(prevChar) && /[\u4e00-\u9fff]/.test(nextChar)) breakAt -= 1;
    }
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
    const last = lines.pop();
    lines[lines.length - 1] += last;
  }
  return lines;
}

function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  const charsPerLine = (pt) => Math.floor(maxWidthTwips / (pt * 20));
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) { lines = splitTitleLines(title, charsPerLine(minPt)); titlePt = minPt; }
  return { titlePt, titleLines: lines };
}

function calcCoverSpacing(params) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838, marginTop = 0, marginBottom = 0 } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - marginTop - marginBottom - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const safeRemaining = Math.max(usableHeight - contentHeight, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}

function buildCoverR1(config) {
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const accentLeft = { style: BorderStyle.SINGLE, size: 8, color: P.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join("  "), size: 18, color: P.accent,
        font: { ascii: "Calibri", eastAsia: "SimHei" }, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      indent: { left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [new TextRun({ text: titleLines[i], size: titleSize, bold: true,
        color: P.cover.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" } })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      indent: { left: padL }, spacing: { after: 800 },
      children: [new TextRun({ text: config.subtitle, size: 24, color: P.cover.subtitleColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      indent: { left: padL + 200 }, spacing: { after: 80 },
      border: { left: accentLeft },
      children: [new TextRun({ text: line, size: 24, color: P.cover.metaColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      new TextRun({ text: config.footerLeft || "", size: 16, color: P.cover.footerColor, font: { ascii: "Arial", eastAsia: "Microsoft YaHei" } }),
      new TextRun({ text: "                                        " }),
      new TextRun({ text: config.footerRight || "", size: 16, color: P.cover.footerColor, font: { ascii: "Arial", eastAsia: "Microsoft YaHei" } }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders,
        children,
      })],
    })],
  })];
}

/* ── 行内解析: `code` / **bold** / <mark>revision</mark> / [text](link) ── */
function inlineRuns(text, opt) {
  const o = Object.assign({ size: 24, color: P.body, bold: false, font: FONT_BODY }, opt || {});
  const runs = [];
  const parts = String(text).split(/(`[^`]+`|<mark>.*?<\/mark>)/g);
  for (const part of parts) {
    if (!part) continue;
    const marked = part.match(/^<mark>([\s\S]*?)<\/mark>$/);
    if (marked) {
      runs.push(...inlineRuns(marked[1], Object.assign({}, o, { highlight: "yellow" })));
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      runs.push(new TextRun({ text: part.slice(1, -1), size: o.size, bold: o.bold,
        color: P.inlineCode, font: FONT_CODE, highlight: o.highlight }));
      continue;
    }
    // 链接只保留文字
    let seg = part.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    const boldParts = seg.split(/(\*\*[^*]+\*\*)/g);
    for (const bp of boldParts) {
      if (!bp) continue;
      if (bp.startsWith("**") && bp.endsWith("**") && bp.length > 4) {
        runs.push(new TextRun({ text: bp.slice(2, -2), size: o.size, bold: true, color: o.color, font: o.font, highlight: o.highlight }));
      } else {
        runs.push(new TextRun({ text: bp, size: o.size, bold: o.bold, color: o.color, font: o.font, highlight: o.highlight }));
      }
    }
  }
  return runs.length ? runs : [new TextRun({ text: "", size: o.size, color: o.color, font: o.font })];
}

/* ── markdown 块解析 ─────────────────────────────────── */
function parseMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0, listCounter = 0;
  let firstH1Skipped = false;
  const newOlRef = () => `ol-${++listCounter}`;

  while (i < lines.length) {
    const line = lines[i];

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length === 1 && !firstH1Skipped) { firstH1Skipped = true; i++; continue; } // 文档大标题→封面
      blocks.push({ type: "heading", level: Math.min(h[1].length - 1, 4), text: h[2].trim() });
      i++; continue;
    }
    // 代码块
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      i++;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      blocks.push({ type: "code", lang, lines: code });
      continue;
    }
    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const parseRow = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, "|").trim());
      const header = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    // 引用块
    if (/^>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: quote.filter((l, idx, arr) => !(l === "" && (idx === 0 || idx === arr.length - 1))) });
      continue;
    }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { i++; continue; }
    // 复选框列表
    const cb = line.match(/^(\s*)- \[([ xX])\] (.*)$/);
    if (cb) {
      blocks.push({ type: "check", level: Math.min(Math.floor(cb[1].length / 2), 1), checked: cb[2] !== " ", text: cb[3] });
      i++; continue;
    }
    // 无序列表
    const ul = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (ul) {
      blocks.push({ type: "ul", level: Math.min(Math.floor(ul[1].length / 2), 1), text: ul[2] });
      i++; continue;
    }
    // 有序列表(遇新列表换 reference)
    const ol = line.match(/^(\s*)(\d+)[.、]\s+(.*)$/);
    if (ol) {
      const prev = blocks[blocks.length - 1];
      if (!prev || prev.type !== "ol-item") blocks.push({ type: "ol-start", ref: newOlRef() });
      blocks.push({ type: "ol-item", ref: blocks[blocks.length - 1] && blocks[blocks.length - 1].type === "ol-start" ? blocks[blocks.length - 1].ref : prev.ref, level: Math.min(Math.floor(ol[1].length / 2), 1), text: ol[3] });
      i++; continue;
    }
    // 空行
    if (/^\s*$/.test(line)) { i++; continue; }
    // 普通段落(单行=一段)
    blocks.push({ type: "para", text: line.trim() });
    i++;
  }
  // ol-start 合并进 items
  const cleaned = [];
  let curRef = null;
  for (const b of blocks) {
    if (b.type === "ol-start") { curRef = b.ref; continue; }
    if (b.type === "ol-item") b.ref = curRef || "ol-x";
    cleaned.push(b);
  }
  return { blocks, olRefs: [...new Set(cleaned.filter(b => b.type === "ol-item").map(b => b.ref))] };
}

/* ── 块 → docx 元素 ──────────────────────────────────── */
const codeCellMargins = { top: 100, bottom: 100, left: 180, right: 120 };

function renderBlocks(blocks) {
  const out = [];
  let h1Seen = 0;
  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx];
    const nextIsTable = blocks[idx + 1] && blocks[idx + 1].type === "table";
    switch (b.type) {
      case "heading": {
        const lvl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][b.level - 1] || HeadingLevel.HEADING_3;
        const sizes = [32, 28, 24, 22];
        const p = {
          heading: lvl,
          spacing: { before: b.level === 1 ? 360 : 240, after: b.level === 1 ? 160 : 120, line: 312 },
          children: inlineRuns(b.text, { size: sizes[b.level - 1], bold: true, color: P.headText, font: FONT_HEAD }),
        };
        if (b.level === 1) { h1Seen++; if (h1Seen > 1) p.pageBreakBefore = true; }
        out.push(new Paragraph(p));
        break;
      }
      case "para": {
        out.push(new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          indent: { firstLine: 480 },
          spacing: { line: 312, after: 60 },
          keepNext: nextIsTable || undefined,
          children: inlineRuns(b.text),
        }));
        break;
      }
      case "quote": {
        b.lines.forEach((l, qi) => {
          out.push(new Paragraph({
            indent: { left: 400 },
            spacing: { line: 300, before: qi === 0 ? 120 : 0, after: qi === b.lines.length - 1 ? 120 : 20 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: P.tbl.accentLine, space: 10 } },
            children: inlineRuns(l, { size: 22, color: P.quote }),
          }));
        });
        break;
      }
      case "code": {
        const codeParas = b.lines.map(l => new Paragraph({
          spacing: { line: 252, lineRule: "atLeast", before: 0, after: 0 },
          children: [new TextRun({ text: l.length ? l : " ", size: 17, color: P.codeText, font: FONT_CODE })],
        }));
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          layout: TableLayoutType.FIXED,
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: P.tbl.innerLine },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: P.tbl.innerLine },
            left: { style: BorderStyle.SINGLE, size: 4, color: P.tbl.innerLine },
            right: { style: BorderStyle.SINGLE, size: 4, color: P.tbl.innerLine },
            insideHorizontal: NB, insideVertical: NB,
          },
          rows: [new TableRow({
            children: [new TableCell({
              shading: { type: ShadingType.CLEAR, fill: P.codeBg },
              margins: codeCellMargins,
              children: codeParas.length ? codeParas : [new Paragraph({ children: [new TextRun({ text: " ", size: 17, font: FONT_CODE })] })],
            })],
          })],
        }));
        out.push(new Paragraph({ spacing: { after: 60 }, children: [] })); // 表后间隙
        break;
      }
      case "table": {
        const nCols = b.header.length;
        const widths = nCols === 2 ? [26, 74] : Array(nCols).fill(Math.floor(100 / nCols));
        if (nCols === 2) { /* nothing */ } else { widths[nCols - 1] = 100 - widths.slice(0, -1).reduce((a, c) => a + c, 0); }
        const mkCell = (text, isHeader, w) => new TableCell({
          width: { size: w, type: WidthType.PERCENTAGE },
          shading: isHeader ? { type: ShadingType.CLEAR, fill: P.tbl.headerBg } : undefined,
          margins: { top: 60, bottom: 60, left: 120, right: 120 },
          children: [new Paragraph({
            alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
            spacing: { line: 276 },
            children: inlineRuns(text, {
              size: 20,
              bold: isHeader,
              color: isHeader ? P.tbl.headerText : P.body,
              font: isHeader ? FONT_HEAD : FONT_BODY,
            }),
          })],
        });
        const rows = [new TableRow({
          tableHeader: true, cantSplit: true,
          children: b.header.map((t, ci) => mkCell(t, true, widths[ci])),
        })];
        for (const r of b.rows) {
          rows.push(new TableRow({
            cantSplit: true,
            children: b.header.map((_, ci) => mkCell(r[ci] !== undefined ? r[ci] : "", false, widths[ci])),
          }));
        }
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 8, color: P.tbl.accentLine },
            bottom: { style: BorderStyle.SINGLE, size: 8, color: P.tbl.accentLine },
            left: NB, right: NB,
            insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: P.tbl.innerLine },
            insideVertical: NB,
          },
          rows,
        }));
        out.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
        break;
      }
      case "ul": {
        out.push(new Paragraph({
          bullet: { level: b.level },
          alignment: AlignmentType.JUSTIFIED,
          spacing: { line: 312, after: 40 },
          children: inlineRuns(b.text, { size: 22 }),
        }));
        break;
      }
      case "check": {
        out.push(new Paragraph({
          bullet: { level: b.level },
          spacing: { line: 312, after: 40 },
          children: [
            new TextRun({ text: b.checked ? "☑ " : "□ ", size: 22, color: P.headText, font: FONT_HEAD }),
            ...inlineRuns(b.text, { size: 22 }),
          ],
        }));
        break;
      }
      case "ol-item": {
        out.push(new Paragraph({
          numbering: { reference: b.ref, level: b.level },
          alignment: AlignmentType.JUSTIFIED,
          spacing: { line: 312, after: 40 },
          children: inlineRuns(b.text, { size: 22 }),
        }));
        break;
      }
    }
  }
  return out;
}

/* ── 组装文档 ────────────────────────────────────────── */
function buildDoc(md, coverCfg) {
  const { blocks, olRefs } = parseMarkdown(md);
  const numberingConfig = olRefs.map(ref => ({
    reference: ref,
    levels: [{
      level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 640, hanging: 360 } } },
    }, {
      level: 1, format: LevelFormat.DECIMAL, text: "%1)", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 1120, hanging: 320 } } },
    }],
  }));

  const pgSize = { width: 11906, height: 16838 };
  const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

  const pageNumFooter = () => new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "888888" })],
    })],
  });
  const titleHeader = () => new Header({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: "CCCCCC", space: 4 } },
      children: [new TextRun({ text: coverCfg.title, size: 16, color: "999999", font: { ascii: "Arial", eastAsia: "Microsoft YaHei" } })],
    })],
  });

  return new Document({
    numbering: { config: numberingConfig },
    styles: {
      default: {
        document: {
          run: { font: FONT_BODY, size: 24, color: P.body },
          paragraph: { spacing: { line: 312 } },
        },
        heading1: {
          run: { font: FONT_HEAD, size: 32, bold: true, color: P.headText },
          paragraph: { spacing: { before: 360, after: 160, line: 312 } },
        },
        heading2: {
          run: { font: FONT_HEAD, size: 28, bold: true, color: P.headText },
          paragraph: { spacing: { before: 240, after: 120, line: 312 } },
        },
        heading3: {
          run: { font: FONT_HEAD, size: 24, bold: true, color: P.headText },
          paragraph: { spacing: { before: 200, after: 100, line: 312 } },
        },
        heading4: {
          run: { font: FONT_HEAD, size: 22, bold: true, color: P.headText },
          paragraph: { spacing: { before: 180, after: 80, line: 312 } },
        },
      },
    },
    sections: [
      { // 封面
        properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
        children: buildCoverR1(coverCfg),
      },
      { // 目录(罗马页码)
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
        },
        footers: { default: pageNumFooter() },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 480, after: 360 },
            children: [new TextRun({ text: "目  录", bold: true, size: 32, font: { eastAsia: "SimHei", ascii: "Times New Roman" }, color: "000000" })],
          }),
          new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
          new Paragraph({
            spacing: { before: 200 },
            children: [new TextRun({
              text: "注: 本目录由域代码生成。编辑文档后请在目录上右键选择「更新域 → 更新整个目录」以刷新页码。",
              italics: true, size: 18, color: "888888",
            })],
          }),
        ],
      },
      { // 正文(阿拉伯页码从 1 起)
        properties: {
          type: SectionType.NEXT_PAGE,
          page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
        },
        headers: { default: titleHeader() },
        footers: { default: pageNumFooter() },
        children: renderBlocks(blocks),
      },
    ],
  });
}

/* ── 五份文档的封面配置 ───────────────────────────────── */
const META_COMMON = ["更新时间: 2026-10-11", "当前版本: 后端 A/B 批 · 前端 Agent 场景增量", "适用环境: S/4HANA 760 · SAP 网关 client 470（SAP_BASIS 以现场实测为准）"];
const covers = {
  "00-项目说明文档": {
    title: "SAP AI 对话助手 项目说明文档",
    subtitle: "项目介绍 · 架构全景 · 功能清单 · 与传统 ABAP Tcode 方案差异 · 版本演进",
    englishLabel: "PROJECT OVERVIEW",
    metaLines: ["文档编号: 00", ...META_COMMON],
    footerLeft: "SAP AI CHAT", footerRight: "docs/00",
  },
  "01-后端开发文档": {
    title: "SAP AI 对话助手 后端开发文档",
    subtitle: "20 个 ABAP 对象 · 4 EntityType · 6 ComplexType · 22 个 Function Import · 核心流程与部署核对",
    englishLabel: "BACKEND DEVELOPMENT",
    metaLines: ["文档编号: 01", ...META_COMMON],
    footerLeft: "SAP AI CHAT", footerRight: "docs/01",
  },
  "02-前端开发文档": {
    title: "SAP AI 对话助手 前端开发文档",
    subtitle: "UI5 工程结构 · 启动链路 · 服务层与控制器方法地图 · 双模式机制 · 构建原理",
    englishLabel: "FRONTEND DEVELOPMENT",
    metaLines: ["文档编号: 02", ...META_COMMON],
    footerLeft: "SAP AI CHAT", footerRight: "docs/02",
  },
  "03-后端实施文档": {
    title: "SAP AI 对话助手 后端实施文档",
    subtitle: "SE11 建表 → SEGW 建模 → SE24 粘类 → SM59/SICF → 验证清单 → 传输发布",
    englishLabel: "BACKEND IMPLEMENTATION",
    metaLines: ["文档编号: 03", ...META_COMMON],
    footerLeft: "SAP AI CHAT", footerRight: "docs/03",
  },
  "04-前端实施文档": {
    title: "SAP AI 对话助手 前端实施文档",
    subtitle: "构建 → 打包 → SE38 上传(全量/增量) → SICF → 验证 → 回滚 → Git 管理",
    englishLabel: "FRONTEND IMPLEMENTATION",
    metaLines: ["文档编号: 04", ...META_COMMON],
    footerLeft: "SAP AI CHAT", footerRight: "docs/04",
  },
};

(async () => {
  for (const [name, cfg] of Object.entries(covers)) {
    const md = fs.readFileSync(path.join(DOCS, name + ".md"), "utf-8");
    const doc = buildDoc(md, cfg);
    const buf = await Packer.toBuffer(doc);
    fs.writeFileSync(path.join(DOCS, name + ".docx"), buf);
    console.log("OK:", name + ".docx", (buf.length / 1024).toFixed(0) + "KB");
  }
})().catch(e => { console.error(e); process.exit(1); });
