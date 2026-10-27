/**
 * 报表自动登记：选择屏解析的 JS 参考实现（10.24 记录 #03b）
 * ---------------------------------------------------------------------------
 * 用途：在本地用真实报表源码验证解析规则（语句切分 / 链式声明 / 说明文字 / 单选组 /
 * 默认值 / 危险项识别），ABAP 版 ZCL_AI_RPT_SCANNER 照同一套规则写。两边规则改动要同步。
 * 本地没有 TEXTPOOL / DDIC：调用方可传 opt.textpool（{ S: {P1: '已出貨報表'}, I: {'001': '…'} }）
 * 与 opt.ddic（ref → {type: 'D'|'C'|'N'|'I'|'P', len, label}），不传就只用源码里的信息。
 * 输出（与 ABAP ty_draft 对应）：{ header: {purpose, module, tcode}, params: [行], notes: [] }
 * 行：{ param_id, abap_name, sel_kind, label, label_src, data_type, type_length, required,
 *       multi_value, range_allowed, default_type, default_value, allowed_ops, include, note }
 */
'use strict';

/* ---------------- 规则（ABAP 版常量同名） ---------------- */
// 名字（去掉 P_/S_ 前缀与结尾数字）命中 → 危险（输出 / 传输 / 写入 / 布局变式）
const NAME_DANGER = /^(?:P_|S_|L_)?(FTP|PWD|PASS|PASSWD|PASSWORD|FILE|FILENA|FNAME|PATH|MAIL|EMAIL|SEND|SBT|BAKJOB|UPLOAD|UPLD|DOWNLOAD|DOWN|DNLD|FORMAT|CACHE|GLOBAL|BI|JOB|DEL|DELE|DELETE|SAVE|UPD|UPDATE|ALV_DEF|VARIANT|VARI|LAYOUT)\d*$/;
// 标签命中 → 危险
// 与 ABAP 版同一写法：ABAP 的 POSIX 正则没有 \b，用 (^|[^A-Z]) … ([^A-Z]|$) 代替
const LABEL_DANGER = /FTP|密碼|密码|PASSWORD|本地文件|文件路徑|文件路径|文件名|檔案|郵件|邮件|E-?MAIL|上傳|上传|下載|下载|發送|发送|緩存表|缓存表|寫入|写入|刪除|删除|DELETE|UPLOAD|DOWNLOAD|BACKGROUND JOB|JOB NAME|布局|變式|变式|LAYOUT|(^|[^A-Z])BI([^A-Z]|$)|(^|[^A-Z])SEND([^A-Z]|$)/i;
// 引用类型命中 → 布局变式（不登记）
const REF_DANGER = /^(DISVARIANT|SLIS_VARI|RSVAR)/i;
// 输出方式组里可以安全固定的那一项
const SAFE_OUT = /ALV|顯示|显示|DISPLAY|查詢|查询|QUERY|(^|[^A-Z])LIST([^A-Z]|$)|屏幕|畫面|画面/i;
// 永远跳过的内部参数
const SKIP_NAMES = ['P_AICAP', 'P_RUNID'];
// 事件块关键字（INITIALIZATION 段的结束）
const EVENT_RE = /^(START-OF-SELECTION|END-OF-SELECTION|AT\s+SELECTION-SCREEN|AT\s+LINE-SELECTION|AT\s+USER-COMMAND|TOP-OF-PAGE|END-OF-PAGE|LOAD-OF-PROGRAM|FORM\s|MODULE\s|CLASS\s|INITIALIZATION)/i;

/* ---------------- 1) 切语句：去注释、按句点切（字面量里的句点不算）、展开链式冒号 ---------------- */
function statements(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];          // { text, line }
  const comments = [];     // 整行注释 { line, text }
  let buf = '', start = -1, inLit = null;
  lines.forEach((raw, i) => {
    if (/^\*/.test(raw)) { comments.push({ line: i, text: raw.replace(/^\*+/, '').replace(/^[\s\-=]+|[\s\-=]+$/g, '') }); return; }
    let line = raw;
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (inLit) {
        buf += c;
        if (c === inLit) { inLit = null; }
        continue;
      }
      if (c === '"') { break; }                      // 行内注释
      if (c === "'" || c === '`' || c === '|') { inLit = c; buf += c; if (start < 0) { start = i; } continue; }
      if (c === '.') {
        if (buf.trim()) { out.push({ text: buf.trim(), line: start < 0 ? i : start }); }
        buf = ''; start = -1;
        continue;
      }
      if (start < 0 && c.trim()) { start = i; }
      buf += c;
    }
    inLit = null;   // 字面量 / 模板不跨行（ABAP 规则）
    buf += ' ';
  });
  if (buf.trim()) { out.push({ text: buf.trim(), line: start }); }
  // 链式：HEAD: a, b → HEAD a / HEAD b（冒号、逗号都要在字面量 / 括号外）
  const res = [];
  out.forEach((st) => {
    const iColon = outerIndex(st.text, ':');
    if (iColon < 0) { res.push(st); return; }
    const head = st.text.slice(0, iColon).trim();
    splitOuter(st.text.slice(iColon + 1), ',').forEach((part) => {
      if (part.trim()) { res.push({ text: (head + ' ' + part.trim()).trim(), line: st.line }); }
    });
  });
  return { stmts: res, comments: comments };
}
function outerIndex(s, ch) {
  let lit = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (lit) { if (c === lit) { lit = null; } continue; }
    if (c === "'" || c === '`' || c === '|') { lit = c; continue; }
    if (c === '(') { depth++; } else if (c === ')') { depth--; }
    else if (c === ch && depth === 0) { return i; }
  }
  return -1;
}
function splitOuter(s, ch) {
  const parts = [];
  let rest = s;
  for (;;) {
    const i = outerIndex(rest, ch);
    if (i < 0) { parts.push(rest); break; }
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return parts;
}
/** 按空白切词（字面量整体一个词）；返回 {up: 大写词（字面量原样）, raw} */
function tokens(s) {
  const out = [];
  let cur = '', lit = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (lit) { cur += c; if (c === lit) { lit = null; } continue; }
    if (c === "'" || c === '`') { lit = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) { out.push(cur); }
  return out.map((t) => ({ raw: t, up: /^['`]/.test(t) ? t : t.toUpperCase() }));
}
const unq = (t) => (/^'.*'$|^`.*`$/.test(t) ? t.slice(1, -1) : t);
const hasCjk = (s) => /[一-鿿]/.test(s || '');

/* ---------------- 2) 解析选择屏 ---------------- */
function parseScreen(src) {
  const { stmts, comments } = statements(src);
  const decl = [];          // 参数 / 选择项，按声明顺序
  const commentFor = {};    // 参数名 → 说明变量（COMMENT … FOR FIELD）
  const lineGroups = [];    // BEGIN OF LINE … END OF LINE 里的 {comments: [var], params: [name], order: [...]}
  const blocks = [];        // 栈 {title}
  const assigns = {};       // 变量 → ['值', …]（INITIALIZATION 里的 x = '…' / p = sy-datum - n）
  let curLine = null, inInit = false;
  stmts.forEach((st) => {
    const t = tokens(st.text);
    const k0 = t[0] ? t[0].up : '';
    if (EVENT_RE.test(st.text.replace(/\s+/g, ' '))) { inInit = /^INITIALIZATION/i.test(st.text); }
    if (k0 === 'SELECTION-SCREEN') {
      const s = t.map((x) => x.up).join(' ');
      if (/BEGIN OF BLOCK/.test(s)) {
        const mT = /TITLE\s+(\S+)/.exec(s);
        blocks.push({ title: mT ? mT[1] : '' });
      } else if (/END OF BLOCK/.test(s)) {
        blocks.pop();
      } else if (/BEGIN OF LINE/.test(s)) {
        curLine = { comments: [], params: [], order: [], line: st.line };
        lineGroups.push(curLine);
      } else if (/END OF LINE/.test(s)) {
        curLine = null;
      } else if (/\bCOMMENT\b/.test(s)) {
        // COMMENT [pos](len) var [FOR FIELD p] [MODIF ID m]
        const iC = t.findIndex((x) => x.up === 'COMMENT');
        let j = iC + 1;
        if (t[j] && /^[\/\d(]/.test(t[j].up)) { j++; }
        const v = t[j] ? t[j].up : '';
        const iF = t.findIndex((x, n) => x.up === 'FIELD' && t[n - 1] && t[n - 1].up === 'FOR');
        if (iF > 0 && t[iF + 1]) { commentFor[t[iF + 1].up] = v; }
        else if (curLine) { curLine.comments.push(v); curLine.order.push({ c: v }); }
      }
      return;
    }
    if (k0 === 'PARAMETERS' || k0 === 'PARAMETER' || k0 === 'SELECT-OPTIONS') {
      const p = parseDecl(t, k0 === 'SELECT-OPTIONS' ? 'S' : 'P');
      if (p) {
        p.line = st.line;
        p.block = blocks.length ? blocks[blocks.length - 1].title : '';
        if (curLine) { curLine.params.push(p.name); curLine.order.push({ p: p.name }); p.lineGroup = curLine; }
        decl.push(p);
      }
      return;
    }
    // x = '字面量' / p = sy-datum [+|- n]（只看 INITIALIZATION 段，说明变量也在这里赋值）
    if (inInit && t.length >= 3 && t[1].up === '=') {
      const v = t.slice(2).map((x) => x.raw).join(' ');
      (assigns[k0] = assigns[k0] || []).push(v);
    }
  });
  return { decl, commentFor, lineGroups, assigns, comments };
}

function parseDecl(t, kind) {
  if (!t[1]) { return null; }
  const mName = /^([A-Z0-9_]+)(?:\((\d+)\))?$/.exec(t[1].up);
  if (!mName) { return null; }
  const p = { kind, name: mName[1], len: mName[2] ? parseInt(mName[2], 10) : 0, ref: '', builtin: '', obligatory: false,
    def: null, checkbox: false, group: '', noDisplay: false, noIntervals: false, noExt: false, modif: '', lower: false };
  for (let i = 2; i < t.length; i++) {
    const u = t[i].up;
    if ((u === 'TYPE' || u === 'LIKE' || u === 'FOR') && t[i + 1]) {
      const r = t[i + 1].up;
      if (u === 'TYPE' && /^(C|N|D|T|I|P|F|STRING|X)$/.test(r)) { p.builtin = r; } else { p.ref = r; }
      i++;
    } else if (u === 'OBLIGATORY') { p.obligatory = true; }
    else if (u === 'DEFAULT' && t[i + 1]) { p.def = t[i + 1].raw; i++; }
    else if (u === 'CHECKBOX' && t[i - 1] && t[i - 1].up === 'AS') { p.checkbox = true; }
    else if (u === 'RADIOBUTTON' && t[i + 1] && t[i + 1].up === 'GROUP' && t[i + 2]) { p.group = t[i + 2].up; i += 2; }
    else if (u === 'NO-DISPLAY') { p.noDisplay = true; }
    else if (u === 'INTERVALS' && t[i - 1] && t[i - 1].up === 'NO') { p.noIntervals = true; }
    else if (u === 'NO-EXTENSION') { p.noExt = true; }
    else if (u === 'ID' && t[i - 1] && t[i - 1].up === 'MODIF' && t[i + 1]) { p.modif = t[i + 1].up; i++; }
    else if (u === 'CASE' && t[i - 1] && t[i - 1].up === 'LOWER') { p.lower = true; }
    else if (u === 'LENGTH' && !(t[i - 1] && t[i - 1].up === 'VISIBLE') && t[i + 1] && /^\d+$/.test(t[i + 1].up)) { p.len = parseInt(t[i + 1].up, 10); i++; }
  }
  return p;
}

/* ---------------- 3) 标签、类型、默认值 ---------------- */
function labelOf(name, scr, opt) {
  const tp = (opt.textpool && opt.textpool.S) || {};
  if (tp[name]) { return { text: tp[name], src: 'TEXTPOOL' }; }
  let v = scr.commentFor[name];
  if (!v) {
    // 同一 BEGIN OF LINE 里没写 FOR FIELD 的说明：取紧跟在参数后面的那个，没有就取前面的
    const p = scr.decl.find((d) => d.name === name);
    const lg = p && p.lineGroup;
    if (lg) {
      const iP = lg.order.findIndex((o) => o.p === name);
      const after = lg.order.slice(iP + 1).find((o) => o.c);
      const before = lg.order.slice(0, iP).reverse().find((o) => o.c);
      v = (after || before || {}).c;
    }
  }
  if (v) {
    const t = textOfVar(v, scr, opt);
    if (t) { return { text: t, src: 'COMMENT' }; }
  }
  return null;
}
function textOfVar(v, scr, opt) {
  const mT = /^TEXT-(\w{3})$/.exec(v);
  if (mT) { return ((opt.textpool && opt.textpool.I) || {})[mT[1]] || ''; }
  // 只认字面量赋值（com_icon = icon_message_information 这种不是文字）
  const vals = (scr.assigns[v] || []).filter((s) => /^'.*'$|^`.*`$/.test(String(s).trim())).map((s) => unq(String(s).trim())).filter((s) => s.trim());
  return vals.filter(hasCjk).pop() || vals.pop() || '';
}
function typeOf(p, opt) {
  const ddic = (opt.ddic && opt.ddic[p.ref]) || null;
  let k = p.builtin || (ddic && ddic.type) || '';
  if (!k && /^SY(ST)?-(DATUM|DATLO)$/.test(p.ref)) { k = 'D'; }
  const len = p.len || (ddic && ddic.len) || 0;
  if (k === 'D') { return { data_type: 'DATE', len: 8 }; }
  if (k === 'I' || k === 'P' || k === 'F') { return { data_type: 'NUM', len: len }; }
  return { data_type: 'CHAR', len: len };
}
/** 默认值：DEFAULT 字面量 / 数字 → STATIC；DEFAULT sy-datum → TODAY 0；INITIALIZATION 里 p = sy-datum ± n → TODAY ±n */
function defaultOf(p, scr) {
  const fromDef = parseDefault(p.def);
  if (fromDef) { return fromDef; }
  const a = (scr.assigns[p.name] || []).map(parseDefault).filter(Boolean).pop();
  return a || null;
}
function parseDefault(v) {
  if (v === null || v === undefined) { return null; }
  const s = String(v).trim();
  const mD = /^SY-DATUM(?:\s*([+-])\s*(\d+))?$/i.exec(s);
  if (mD) { return { type: 'TODAY', value: mD[1] ? (mD[1] === '-' ? '-' : '') + mD[2] : '0' }; }
  if (/^'.*'$/.test(s)) { return { type: 'STATIC', value: s.slice(1, -1) }; }
  if (/^-?\d+$/.test(s)) { return { type: 'STATIC', value: s }; }
  return null;
}
function isDanger(name, label, ref) {
  return NAME_DANGER.test(name) || (label && LABEL_DANGER.test(label)) || REF_DANGER.test(ref || '');
}

/* ---------------- 4) 头注释 ---------------- */
function parseHeader(src) {
  const h = { purpose: '', module: '', tcode: '' };
  String(src).replace(/\r/g, '').split('\n').slice(0, 60).forEach((l) => {
    // 与 ABAP 版同一写法：POSIX 没有懒惰量词，先贪婪取到行尾，再去掉结尾的 * 与空格
    const m = /^\*\s*(Purpose|SAP\s*Module|T-?CODE)\s*(:|：)\s*(.*)$/i.exec(l);
    if (!m) { return; }
    const k = m[1].toUpperCase().replace(/\s+/g, '');
    const v = m[3].replace(/\s*\*+\s*$/, '').trim();
    if (k === 'PURPOSE' && !h.purpose) { h.purpose = v; }
    else if (k === 'SAPMODULE' && !h.module) { h.module = v.toUpperCase(); }
    else if (/^T-?CODE$/.test(k) && !h.tcode) { h.tcode = v.toUpperCase(); }
  });
  return h;
}

/* ---------------- 5) 组装登记草稿 ---------------- */
function scan(src, opt) {
  opt = opt || {};
  const scr = parseScreen(src);
  const rows = [];
  const notes = [];
  const groups = {};
  const blockLabel = (b) => (b ? textOfVar(b, scr, opt) : '');
  const label = (p) => labelOf(p.name, scr, opt) || ((opt.ddic && opt.ddic[p.ref] && opt.ddic[p.ref].label) ? { text: opt.ddic[p.ref].label, src: 'DDIC' } : { text: p.name, src: 'NAME' });
  scr.decl.forEach((p) => {
    if (p.noDisplay || SKIP_NAMES.indexOf(p.name) >= 0) { return; }
    if (p.group) {
      let g = groups[p.group];
      if (!g) {
        g = groups[p.group] = { name: p.group, buttons: [], at: rows.length, first: p };
        rows.push({ __group: p.group });
      }
      g.buttons.push(p);
      return;
    }
    const lb = label(p);
    // 10.27 记录 #04（SCANNER V1.0b）：所在选择屏块的标题 → GROUP_LABEL，参数卡按它给复选框分组
    const row = { param_id: p.name, abap_name: p.name, label: lb.text, label_src: lb.src, required: false, multi_value: false, range_allowed: false,
      default_type: '', default_value: '', allowed_ops: '', include: true, note: '', group_label: blockLabel(p.block) };
    if (p.checkbox) {
      Object.assign(row, { sel_kind: 'C', data_type: 'BOOL', type_length: 1, allowed_ops: unq(p.def || '').toUpperCase() === 'X' ? 'X' : '' });
    } else {
      const ty = typeOf(p, opt);
      const df = defaultOf(p, scr);
      Object.assign(row, { sel_kind: p.kind, data_type: ty.data_type, type_length: ty.len });
      if (p.kind === 'S') {
        if (ty.data_type === 'DATE' && !p.noIntervals) { row.range_allowed = true; }
        else if (!p.noExt) { row.multi_value = true; }
      }
      if (df) { row.default_type = df.type; row.default_value = df.value; }
      // 程序必填但有默认值（或 INITIALIZATION 赋值）：登记成选填 + 默认（不填就按默认下发，与 SAP 界面一致）
      row.required = p.obligatory && !df;
    }
    if (isDanger(p.name, lb.text, p.ref)) {
      row.include = false;
      row.note = REF_DANGER.test(p.ref || '') ? '布局变式，不登记' : '疑似输出 / 传输 / 写入类，默认不登记（确认是业务条件再用「强制登记」）';
    }
    rows.push(row);
  });
  // 单选组 → R（普通）或 F（输出方式组：安全项固定 X，其余空格）
  Object.keys(groups).forEach((gk) => {
    const g = groups[gk];
    const opts = g.buttons.map((b) => {
      const lb = label(b);
      return { name: b.name, text: lb.text, src: lb.src, def: unq(b.def || '').toUpperCase() === 'X' };
    });
    if (!opts.some((o) => o.def)) { opts[0].def = true; }   // 程序没写 DEFAULT：SAP 默认选第一个
    const danger = opts.some((o) => isDanger(o.name, o.text, ''));
    const idx = rows.findIndex((r) => r.__group === gk);
    const gLabel = blockLabel(g.first.block);   // 单选组取第一个按钮所在块
    let out = [];
    if (!danger) {
      const lbl = groupLabel(g, scr, opt);
      let ops = opts.map((o) => o.name + '=' + o.text + (o.def ? '*' : '')).join(';');
      let note = '';
      if (ops.length > 120) {
        ops = opts.map((o) => o.name + '=' + o.text.slice(0, 8) + (o.def ? '*' : '')).join(';');
        note = '选项文字太长，已截到 8 个字';
      }
      if (ops.length > 120) { note = '选项超过 120 字符，ALLOWED_OPS 放不下，请减少选项或改短文字后手工登记'; }
      out.push({ param_id: ('RB_' + gk).slice(0, 30), abap_name: gk, sel_kind: 'R', label: lbl.text, label_src: lbl.src, data_type: 'ENUM', type_length: 0,
        required: false, multi_value: false, range_allowed: false, default_type: '', default_value: '', allowed_ops: ops, include: ops.length <= 120, note: note, options: opts,
        group_label: gLabel });
    } else {
      const safe = opts.find((o) => SAFE_OUT.test(o.text) || SAFE_OUT.test(o.name));
      if (safe) {
        out = opts.map((o) => ({ param_id: ('OUT_' + o.name).slice(0, 30), abap_name: o.name, sel_kind: 'F', label: '（固定）' + o.text, label_src: o.src, data_type: 'CHAR', type_length: 1,
          required: false, multi_value: false, range_allowed: false, default_type: '', default_value: '', allowed_ops: o === safe ? 'X' : '', include: true,
          note: o === safe ? '输出方式组：固定为这一项' : '输出方式组：固定为空', group_label: gLabel }));
      } else {
        notes.push('单选组 ' + gk + ' 像是输出方式组，但找不到可以固定的 ALV / 查询项，未登记（保持程序默认），请人工确认');
      }
    }
    rows.splice(idx, 1, ...out);
  });
  rows.forEach((r, i) => { r.sort_no = (i + 1) * 10; });
  return { header: parseHeader(src), params: rows, notes: notes };
}

/**
  * 单选组标签：候选 ① 紧挨在组前面、没有参数的那一行 SELECTION-SCREEN 说明（如 0033 的「狀態選項」）
  * ② 组前 3 行内的整行注释（如 0003C 的「*以物料文件/過帳日期作為基準日」）③ 所在块标题（TITLE TEXT-001 / b_com02）；
  * 优先取带中文的候选，都没有中文就取第一个非空的；全空 →「单选组 G」
  */
function groupLabel(g, scr, opt) {
  const first = g.first;
  const lg = first.lineGroup;
  const cands = [];
  // ①：组所在行之前最近的一个 BEGIN OF LINE，且两者之间没有别的参数声明
  const myLine = lg ? lg.line : first.line;
  const prev = scr.lineGroups.filter((l) => l.line < myLine).pop();
  if (prev && prev.params.length === 0 && prev.comments.length &&
      !scr.decl.some((d) => d.line > prev.line && d.line < first.line && d !== first)) {
    const t = prev.comments.map((v) => textOfVar(v, scr, opt)).filter(Boolean).pop();
    if (t) { cands.push({ text: t, src: 'COMMENT' }); }
  }
  // ②
  const cm = scr.comments.filter((c) => c.line < myLine && c.line >= myLine - 3 && c.text).pop();
  if (cm) { cands.push({ text: cm.text, src: 'SRC_COMMENT' }); }
  // ③
  if (first.block) {
    const t = textOfVar(first.block, scr, opt);
    if (t) { cands.push({ text: t, src: 'BLOCK' }); }
  }
  return cands.filter((c) => hasCjk(c.text))[0] || cands[0] || { text: '单选组 ' + g.name, src: 'NAME' };
}

module.exports = { scan, statements, tokens, parseScreen, parseHeader, parseDefault, isDanger, NAME_DANGER, LABEL_DANGER, SAFE_OUT };
