/**
 * Office 文件（xlsx / docx / pptx）读写（引擎 0.13.0）
 *
 * 不引第三方库：Office 文件就是 zip + XML。解压 / 压缩用浏览器自带的 DecompressionStream / CompressionStream
 * （"deflate-raw"，Chrome / Edge 103+），XML 用正则按需取，Node 18+ 也能跑（单元测试）。
 *
 *   读：officeToText(path, bytes) → 给模型看的文本
 *       xlsx：每个工作表一节，每行开头是 Excel 行号，后面 A、B、C… 列用 Tab 分隔（日期格式的单元格转成 yyyy-mm-dd）
 *       docx：段落一行一段，标题加 #，列表加 -，表格转成 | a | b |
 *       pptx：每页一节，文本框里的段落一行一段
 *   写：buildXlsx(sheets) / buildDocx(markdown) → Uint8Array（新建文件；不改用户原有文件的格式）
 *
 * 不支持：旧格式 .xls / .doc / .ppt、加密文件、ZIP64（超过 4 GB）。
 */

export const OFFICE_READ_EXT = new Set(["xlsx", "xlsm", "docx", "pptx"]);
export const OFFICE_WRITE_EXT = new Set(["xlsx", "docx"]);
export const OFFICE_OLD_EXT = { xls: "xlsx", doc: "docx", ppt: "pptx" };

/** 读：转文本时的上限（防止超大表格把浏览器卡死；模型本来也只能分页看） */
export const XLSX_MAX_ROWS = 20000;
const CELL_MAX_CHARS = 500;

export function extOf(p) {
  const name = String(p || "").split("/").pop() || "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

// ======================================================================
// ZIP
// ======================================================================

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function pipeBytes(bytes, stream) {
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

/**
 * 读 zip 目录：返回 { names: string[], read(name) → Promise<Uint8Array|null>, text(name) → Promise<string|null> }
 * 不是 zip（或加密 / ZIP64）时抛错，错误信息直接给模型看。
 */
export function openZip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 Office 文件（文件损坏，或者其实是旧格式 / 加密文件）");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (p === 0xffffffff || count === 0xffff) throw new Error("文件太大（ZIP64），不支持");
  const entries = new Map();
  const dec = new TextDecoder("utf-8");
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) throw new Error("Office 文件目录损坏");
    const flags = u16(b, p + 8), method = u16(b, p + 10);
    const csize = u32(b, p + 20), usize = u32(b, p + 24);
    const nlen = u16(b, p + 28), elen = u16(b, p + 30), clen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { flags, method, csize, usize, local });
    p += 46 + nlen + elen + clen;
  }
  const read = async name => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.flags & 1) throw new Error("文件加了密码，读不了；请用户去掉密码后另存一份");
    const lo = e.local;
    if (u32(b, lo) !== 0x04034b50) throw new Error("Office 文件内容损坏");
    const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    const data = b.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return pipeBytes(data, new DecompressionStream("deflate-raw"));
    throw new Error(`不支持的压缩方式 ${e.method}`);
  };
  return {
    names: [...entries.keys()],
    read,
    async text(name) {
      const d = await read(name);
      return d ? new TextDecoder("utf-8").decode(d) : null;
    }
  };
}

let CRC_TABLE = null;
function crc32(b) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 打 zip：files = [{ name, data: string | Uint8Array }]；能压缩就压缩，否则原样存 */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const canDeflate = typeof CompressionStream === "function";
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(raw);
    let body = raw, method = 0;
    if (canDeflate && raw.length > 64) {
      const z = await pipeBytes(raw, new CompressionStream("deflate-raw"));
      if (z.length < raw.length) { body = z; method = 8; }
    }
    const h = new Uint8Array(30 + name.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
    v.setUint16(8, method, true); v.setUint16(10, dosTime, true); v.setUint16(12, dosDate, true);
    v.setUint32(14, crc, true); v.setUint32(18, body.length, true); v.setUint32(22, raw.length, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
    h.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true); cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(h, body);
    central.push(c);
    offset += h.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of all) { out.set(x, o); o += x.length; }
  return out;
}

// ======================================================================
// XML 小工具
// ======================================================================

export function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (x) { return m; }
    }
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e];
  });
}

/** 写 XML：转义，并去掉 XML 不允许的控制字符 */
export function escXml(s) {
  return String(s == null ? "" : s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 取标签上的属性值（name 可带前缀，如 w:val；anyPrefix = 必须带前缀、前缀随意，如关系号 r:id —— 不能和无前缀的 id 混淆） */
function attr(tag, name, anyPrefix = false) {
  const n = name.replace(/[.:]/g, "\\$&");
  const re = anyPrefix ? new RegExp(`\\s[\\w.-]+:${n}="([^"]*)"`) : new RegExp(`\\s${n}="([^"]*)"`);
  const m = re.exec(tag);
  return m ? decodeXml(m[1]) : null;
}

/**
 * 取顶层元素：在 xml 里按出现顺序找 names 里的元素（同名嵌套按深度配对），
 * 返回 [{ name, open, inner }]；不在 names 里的外层容器（如 w:sdt）会被穿透。
 */
export function topLevel(xml, names) {
  const want = new Set(names);
  const re = /<(\/?)([A-Za-z_][\w.:-]*)\b[^>]*?(\/?)>/g;
  const out = [];
  let cur = null, depth = 0, open = "", innerStart = 0, m;
  while ((m = re.exec(xml))) {
    const [all, close, name, self] = m;
    if (cur === null) {
      if (!close && want.has(name)) {
        if (self) { out.push({ name, open: all, inner: "" }); continue; }
        cur = name; depth = 1; open = all; innerStart = re.lastIndex;
      }
      continue;
    }
    if (name !== cur) continue;
    if (close) {
      if (--depth === 0) { out.push({ name, open, inner: xml.slice(innerStart, m.index) }); cur = null; }
    } else if (!self) depth++;
  }
  return out;
}

/** 解析 .rels：Id → 规范后的包内路径 */
function parseRels(xml, baseDir) {
  const map = {};
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), target = attr(m[0], "Target"), mode = attr(m[0], "TargetMode");
    if (!id || !target || mode === "External") continue;
    map[id] = resolvePath(baseDir, target);
  }
  return map;
}
function resolvePath(baseDir, target) {
  const segs = (target.startsWith("/") ? target.slice(1) : baseDir + target).split("/");
  const out = [];
  for (const s of segs) {
    if (s === "..") out.pop();
    else if (s && s !== ".") out.push(s);
  }
  return out.join("/");
}

const clipCell = s => (s.length > CELL_MAX_CHARS ? s.slice(0, CELL_MAX_CHARS) + "…" : s);
const oneLine = s => String(s).replace(/\r\n|\r|\n|\t/g, " ");

// ======================================================================
// 读 xlsx
// ======================================================================

/** "AB" → 27（从 0 开始） */
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
/** 0 → "A"，27 → "AB" */
export function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateFormat(id, code) {
  if (BUILTIN_DATE_FMT.has(id)) return true;
  if (!code) return false;
  const c = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs年月日]/i.test(c) && !/^[#0.,;%\s-]*$/.test(c);
}

/** Excel 序列号 → "yyyy-mm-dd[ hh:mm[:ss]]"（1900 / 1904 两种日期系统） */
export function excelDate(serial, date1904) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86400000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  const z = n => String(n).padStart(2, "0");
  let s = `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`;
  const secs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  if (secs) s += ` ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}` + (d.getUTCSeconds() ? `:${z(d.getUTCSeconds())}` : "");
  return s;
}

function tidyNumber(v) {
  const n = Number(v);
  if (!isFinite(n)) return v;
  if (Math.abs(n) < 1e15 && !Number.isInteger(n)) return String(parseFloat(n.toPrecision(15)));
  return String(n);
}

function richText(xml) {
  // <si> / <is>：多段富文本拼起来；去掉日文注音
  const s = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

async function xlsxToText(zip) {
  const wb = await zip.text("xl/workbook.xml");
  if (!wb) throw new Error("不是 Excel 文件（缺少 xl/workbook.xml）");
  const rels = parseRels(await zip.text("xl/_rels/workbook.xml.rels"), "xl/");
  const date1904 = /<workbookPr\b[^>]*\sdate1904="(1|true)"/.test(wb);

  const shared = [];
  const ss = await zip.text("xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? richText(m[1]) : "");

  // 样式：哪些单元格格式是日期
  const dateXf = [];
  const st = await zip.text("xl/styles.xml");
  if (st) {
    const codes = {};
    for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) codes[Number(attr(m[0], "numFmtId"))] = attr(m[0], "formatCode");
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st);
    if (xfs) for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) {
      const id = Number(attr(m[0], "numFmtId") || 0);
      dateXf.push(isDateFormat(id, codes[id]));
    }
  }

  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => ({
    name: attr(m[0], "name") || "",
    hidden: /\sstate="(hidden|veryHidden)"/.test(m[0]),
    path: rels[attr(m[0], "id", true)] || ""
  }));
  const out = ["（Excel 文件转成的文本：每个工作表一节；每行开头是 Excel 行号，后面是 A、B、C… 各列的值，用 Tab 分隔；空单元格留空，空行省略；日期格式的单元格已转成 yyyy-mm-dd。）"];
  let budget = XLSX_MAX_ROWS, cut = false;
  for (let si = 0; si < sheets.length; si++) {
    const sh = sheets[si];
    const xml = sh.path ? await zip.text(sh.path) : null;
    if (xml == null) { out.push("", `## 工作表 ${si + 1}「${sh.name}」：不是普通工作表（图表页等），跳过`); continue; }
    const rows = [];
    let maxCol = -1, total = 0;
    let autoRow = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rAttr = /\sr="(\d+)"/.exec(rm[1]);
      const rowNo = rAttr ? Number(rAttr[1]) : autoRow + 1;
      autoRow = rowNo;
      if (!rm[2]) continue;
      const cells = [];
      let autoCol = -1;
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = cm[1];
        const ref = /\sr="([A-Z]+)\d*"/i.exec(a);
        const ci = ref ? colIndex(ref[1]) : autoCol + 1;
        autoCol = ci;
        const body = cm[2] || "";
        const t = (/\st="(\w+)"/.exec(a) || [])[1] || "n";
        const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
        const v = vm ? decodeXml(vm[1]) : "";
        let val = "";
        if (t === "s") val = shared[Number(v)] ?? "";
        else if (t === "inlineStr") { const is = /<is>([\s\S]*?)<\/is>/.exec(body); val = is ? richText(is[1]) : ""; }
        else if (t === "b") val = v === "1" ? "TRUE" : v === "0" ? "FALSE" : v;
        else if (t === "str" || t === "e") val = v;
        else if (v !== "") {
          const s = Number((/\ss="(\d+)"/.exec(a) || [])[1] || 0);
          val = dateXf[s] && isFinite(Number(v)) ? excelDate(Number(v), date1904) : tidyNumber(v);
        }
        if (val === "") continue;
        cells[ci] = clipCell(oneLine(val));
        if (ci > maxCol) maxCol = ci;
      }
      if (!cells.length) continue;
      total++;
      if (budget > 0) { rows.push(rowNo + "\t" + Array.from(cells, c => c ?? "").join("\t")); budget--; }
      else cut = true;
    }
    out.push("", `## 工作表 ${si + 1}「${sh.name}」${sh.hidden ? "（隐藏）" : ""}：` +
      (total ? `${total} 行有数据，A–${colName(maxCol)} 列` + (rows.length < total ? `（只转了前 ${rows.length} 行）` : "") : "空表"));
    if (total) {
      out.push("行\t" + Array.from({ length: maxCol + 1 }, (_, i) => colName(i)).join("\t"));
      out.push(...rows);
    }
  }
  if (cut) out.push("", `（整个文件超过 ${XLSX_MAX_ROWS} 行，后面的行没有转出来。需要全部数据时请用户另存为 CSV 再读。）`);
  return out.join("\n");
}

// ======================================================================
// 读 docx
// ======================================================================

function docxParaText(pXml) {
  const body = pXml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/, "");
  let s = "";
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<w:(drawing|pict)\b/g;
  for (const m of body.matchAll(re)) {
    if (m[1] !== undefined) s += decodeXml(m[1]);
    else if (m[2] === "tab") s += "\t";
    else if (m[2]) s += "\n";
    else if (m[3]) s += "[图片]";
  }
  return s;
}

async function docxToText(zip) {
  const doc = await zip.text("word/document.xml");
  if (!doc) throw new Error("不是 Word 文件（缺少 word/document.xml）");
  // 样式编号 → 标题级别（中文 Word 的样式编号常是 "1"、"2"，要看样式名 heading 1）
  const level = {};
  const st = await zip.text("word/styles.xml");
  if (st) for (const s of topLevel(st, ["w:style"])) {
    const id = attr(s.open, "w:styleId");
    const nm = /<w:name\s+w:val="([^"]*)"/.exec(s.inner);
    const name = nm ? decodeXml(nm[1]).toLowerCase() : "";
    const h = /^heading (\d)$/.exec(name);
    if (id && h) level[id] = Number(h[1]);
    else if (id && name === "title") level[id] = 1;
  }
  const bodyM = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(doc);
  const lines = [];
  const para = p => {
    const ps = /<w:pStyle\s+w:val="([^"]*)"/.exec(p.inner);
    const lv = ps ? level[decodeXml(ps[1])] : 0;
    const t = docxParaText(p.inner);
    if (!t.trim()) return "";
    if (lv) return "#".repeat(Math.min(lv, 6)) + " " + t.trim();
    if (/<w:numPr\b/.test(p.inner)) return "- " + t.trim();
    return t;
  };
  const cellText = tc => topLevel(tc, ["w:p", "w:tbl"])
    .map(x => (x.name === "w:p" ? docxParaText(x.inner) : "[表格]")).filter(s => s.trim()).join(" ");
  const walk = xml => {
    for (const el of topLevel(xml, ["w:p", "w:tbl"])) {
      if (el.name === "w:p") { lines.push(para(el)); continue; }
      const rows = topLevel(el.inner, ["w:tr"]).map(tr =>
        topLevel(tr.inner, ["w:tc"]).map(tc => oneLine(cellText(tc.inner)).replace(/\|/g, "\\|")));
      if (!rows.length) continue;
      lines.push("");
      rows.forEach((r, i) => {
        lines.push("| " + r.join(" | ") + " |");
        if (i === 0) lines.push("|" + " --- |".repeat(Math.max(1, r.length)));
      });
      lines.push("");
    }
  };
  walk(bodyM ? bodyM[1] : doc);
  return ["（Word 文件转成的文本：标题前加 #，列表前加 -，表格转成 | 分隔的行；页眉页脚、批注、修订删除的文字没有转出来。）", "",
    ...lines].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ======================================================================
// 读 pptx
// ======================================================================

async function pptxToText(zip) {
  const pres = await zip.text("ppt/presentation.xml");
  if (!pres) throw new Error("不是 PowerPoint 文件（缺少 ppt/presentation.xml）");
  const rels = parseRels(await zip.text("ppt/_rels/presentation.xml.rels"), "ppt/");
  let slides = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map(m => rels[attr(m[0], "id", true)]).filter(Boolean);
  if (!slides.length) {
    slides = zip.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  }
  const out = ["（PowerPoint 文件转成的文本：每页一节，文本框和表格里的文字一段一行；图片、图表里的文字和备注没有转出来。）"];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.text(slides[i]);
    if (!xml) continue;
    const paras = topLevel(xml, ["a:p"]).map(p => {
      let s = "";
      for (const m of p.inner.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) s += m[1] !== undefined ? decodeXml(m[1]) : "\n";
      return s;
    }).filter(s => s.trim());
    out.push("", `## 第 ${i + 1} 页`, ...(paras.length ? paras : ["（没有文字）"]));
  }
  return out.join("\n");
}

/** 读：Office 文件 → 文本；不支持的抛错（错误信息直接给模型） */
export async function officeToText(path, bytes) {
  const e = extOf(path);
  if (OFFICE_OLD_EXT[e]) throw new Error(`.${e} 是旧格式，读不了；请用户在 Office 里另存为 .${OFFICE_OLD_EXT[e]} 后再读`);
  const zip = openZip(bytes);
  if (e === "xlsx" || e === "xlsm") return xlsxToText(zip);
  if (e === "docx") return docxToText(zip);
  if (e === "pptx") return pptxToText(zip);
  throw new Error(`不支持 .${e}`);
}

// ======================================================================
// 写 xlsx
// ======================================================================

const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const ODR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** 显示宽度：中日韩字符算 2 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

/** 工作表名：Excel 规定 ≤ 31 字、不含 []:*?/\、不重名 */
function sheetNames(list) {
  const used = new Set();
  return list.map((n, i) => {
    let s = String(n || "").replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").trim().slice(0, 31) || `Sheet${i + 1}`;
    let k = 2, base = s;
    while (used.has(s.toLowerCase())) s = base.slice(0, 31 - String(k).length - 1) + "_" + k++;
    used.add(s.toLowerCase());
    return s;
  });
}

export const XLSX_MAX_CELLS = 500000;

/**
 * 新建 xlsx。sheets = [{ name, columns?: string[], rows: any[][] }]
 * 数字（JS number）存成数字；字符串一律存成文本（保留料号、工单号的前导 0）。有 columns 时第一行是加粗表头并冻结。
 */
export async function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("至少要有一个工作表");
  let cells = 0;
  for (const s of sheets) {
    cells += ((s && s.rows) || []).reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0) + ((s && s.columns) || []).length;
  }
  if (cells > XLSX_MAX_CELLS) throw new Error(`单元格太多（${cells} 个，上限 ${XLSX_MAX_CELLS}）`);
  const names = sheetNames(sheets.map(s => s && s.name));
  const shared = [], sharedIdx = new Map();
  const si = s => {
    let i = sharedIdx.get(s);
    if (i === undefined) { i = shared.length; shared.push(s); sharedIdx.set(s, i); }
    return i;
  };
  const files = [];
  const sheetXml = sheets.map(sh => {
    const head = Array.isArray(sh.columns) && sh.columns.length ? sh.columns.map(c => (c == null ? "" : String(c))) : null;
    const body = (Array.isArray(sh.rows) ? sh.rows : []).map(r => (Array.isArray(r) ? r : [r]));
    const all = head ? [head, ...body] : body;
    const widths = [];
    const rowsXml = all.map((r, ri) => {
      const cs = r.map((v, ci) => {
        if (v == null || v === "") return "";
        const ref = colName(ci) + (ri + 1);
        const isHead = head && ri === 0;
        const style = isHead ? ' s="1"' : "";
        widths[ci] = Math.max(widths[ci] || 0, dispWidth(typeof v === "number" ? String(v) : v));
        if (typeof v === "number" && isFinite(v) && !isHead) return `<c r="${ref}"${style}><v>${v}</v></c>`;
        return `<c r="${ref}"${style} t="s"><v>${si(typeof v === "object" ? JSON.stringify(v) : String(v))}</v></c>`;
      }).join("");
      return `<row r="${ri + 1}">${cs}</row>`;
    }).join("");
    const cols = widths.length
      ? "<cols>" + Array.from(widths, (w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, (w || 0) + 2))}" customWidth="1"/>`).join("") + "</cols>"
      : "";
    const pane = head ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>' : "";
    return XML_HEAD + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ODR}">` +
      `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
      cols + `<sheetData>${rowsXml}</sheetData></worksheet>`;
  });
  const n = sheets.length;
  files.push({ name: "[Content_Types].xml", data: XML_HEAD + `<Types xmlns="${CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheetXml.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    "</Types>" });
  files.push({ name: "_rels/.rels", data: XML_HEAD + `<Relationships xmlns="${REL}">` +
    `<Relationship Id="rId1" Type="${ODR}/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: "xl/workbook.xml", data: XML_HEAD +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ODR}"><bookViews><workbookView/></bookViews><sheets>` +
    names.map((nm, i) => `<sheet name="${escXml(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + "</sheets></workbook>" });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: XML_HEAD + `<Relationships xmlns="${REL}">` +
    names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ODR}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${n + 1}" Type="${ODR}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="${ODR}/sharedStrings" Target="sharedStrings.xml"/></Relationships>` });
  files.push({ name: "xl/styles.xml", data: XML_HEAD +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font>' +
    '<font><b/><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });
  sheetXml.forEach((x, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x }));
  files.push({ name: "xl/sharedStrings.xml", data: XML_HEAD +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map(s => `<si><t xml:space="preserve">${escXml(s)}</t></si>`).join("") + "</sst>" });
  return makeZip(files);
}

/** 解析 CSV（RFC 4180：逗号分隔、双引号转义）；去掉 BOM */
export function parseCsv(text) {
  const s = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 报表结果（CSV 文本）里的值要不要存成数字：只有普通十进制数才转；
 * 有前导 0 的（料号、工单号）、超过 15 位的、带千分位的都保留文本。SAP 的负号在后（"12.5-"）也认。
 */
export function csvValue(v) {
  const s = String(v).trim();
  let m = /^(-?)(\d+)(\.\d+)?$/.exec(s) || /^()(\d+)(\.\d+)?-$/.exec(s);
  if (!m) return v;
  const neg = m[1] === "-" || s.endsWith("-");
  if (m[2].length > 1 && m[2][0] === "0") return v;
  if ((m[2] + (m[3] || "")).length > 16) return v;
  const n = Number(m[2] + (m[3] || ""));
  return neg ? -n : n;
}

// ======================================================================
// 写 docx
// ======================================================================

function runsXml(text, bold) {
  // **粗体**；其余原样
  const parts = String(text).split(/\*\*(.+?)\*\*/);
  return parts.map((t, i) => {
    if (!t) return "";
    const b = bold || i % 2 === 1;
    return `<w:r>${b ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${escXml(t)}</w:t></w:r>`;
  }).join("");
}
function paraXml(text, { style, bold, indent } = {}) {
  const ppr = (style ? `<w:pStyle w:val="${style}"/>` : "") + (indent ? '<w:ind w:left="420" w:hanging="210"/>' : "");
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${runsXml(text, bold)}</w:p>`;
}
function tableXml(rows) {
  const ncol = Math.max(...rows.map(r => r.length));
  const w = Math.floor(9000 / Math.max(1, ncol));
  const grid = "<w:tblGrid>" + `<w:gridCol w:w="${w}"/>`.repeat(ncol) + "</w:tblGrid>";
  const trs = rows.map((r, ri) => "<w:tr>" + Array.from({ length: ncol }, (_, ci) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${paraXml(r[ci] == null ? "" : r[ci], { bold: ri === 0 })}</w:tc>`).join("") + "</w:tr>").join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}${trs}</w:tbl>`;
}

/** Markdown 风格文本 → docx 正文：# 标题（1~3 级）、- / 1. 列表、| 表格 |、**粗体**、空行；其余每行一段 */
export function markdownToDocxBody(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const rows = [];
      const first = i;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const l = lines[i].trim();
        // 表格第二行是分隔行（|---|---|）时不进表格；后面的「| - | - |」是数据
        if (!(i === first + 1 && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(l))) {
          rows.push(l.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|")));
        }
        i++;
      }
      i--;
      if (rows.length) out.push(tableXml(rows), "<w:p/>");
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(paraXml(h[2].trim(), { style: "Heading" + Math.min(3, h[1].length) })); continue; }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) continue; // 分隔线
    const b = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (b) { out.push(paraXml("• " + b[1], { indent: true })); continue; }
    const n = /^\s*(\d+[.、)])\s+(.*)$/.exec(line);
    if (n) { out.push(paraXml(n[1] + " " + n[2], { indent: true })); continue; }
    out.push(line.trim() ? paraXml(line) : "<w:p/>");
  }
  // 连续空段只留一个
  return out.join("").replace(/(<w:p\/>){2,}/g, "<w:p/>");
}

export async function buildDocx(markdown) {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const font = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="等线" w:cs="Times New Roman"/>';
  const heading = (n, sz) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/>` +
    `<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
  const files = [
    { name: "[Content_Types].xml", data: XML_HEAD + `<Types xmlns="${CT}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: "_rels/.rels", data: XML_HEAD + `<Relationships xmlns="${REL}">` +
      `<Relationship Id="rId1" Type="${ODR}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: XML_HEAD + `<Relationships xmlns="${REL}">` +
      `<Relationship Id="rId1" Type="${ODR}/styles" Target="styles.xml"/></Relationships>` },
    { name: "word/styles.xml", data: XML_HEAD + `<w:styles xmlns:w="${W}">` +
      `<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>` +
      '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      heading(1, 32) + heading(2, 28) + heading(3, 24) +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>' +
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:tblPr><w:tblBorders>' +
      ["top", "left", "bottom", "right", "insideH", "insideV"].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("") +
      "</w:tblBorders></w:tblPr></w:style></w:styles>" },
    { name: "word/document.xml", data: XML_HEAD + `<w:document xmlns:w="${W}" xmlns:r="${ODR}"><w:body>` +
      markdownToDocxBody(markdown) +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
      "</w:body></w:document>" }
  ];
  return makeZip(files);
}
