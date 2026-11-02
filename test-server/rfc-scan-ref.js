/**
 * RFC 函数执行：登记规则的本地参考实现（设计：功能计划书/RFC函数执行/01 §3）
 *
 * 和 ABAP 版逐条对应，改规则两边同步（npm run test:rfcscan 锁住）：
 *   - nameDanger  ↔ ZCL_AI_RFC_EXEC=>name_danger
 *   - scanSource  ↔ ZCL_AI_RFC_EXEC=>scan_source（写库目标是不是透明表由调用方查 DD02L；这里用 transp 集合代替）
 *   - draftParams ↔ ZCL_AI_RPT_SCANNER=>scan_function 里「接口 → 参数草稿」那一段
 *   - defaultResult ↔ ZCL_AI_RFC_EXEC=>default_result
 */

const NAME_WORDS = ['CREATE', 'CHANGE', 'DELETE', 'POST', 'SAVE', 'UPDATE', 'CANCEL', 'RELEASE', 'SEND'];

/** 函数名疑似写入类：返回命中的词（空串 = 没命中） */
function nameDanger(fm) {
  const up = String(fm || '').trim().toUpperCase();
  for (const w of NAME_WORDS) {
    if (up.indexOf(w) >= 0) { return w; }
  }
  return '';
}

/** 去掉行内 " 注释（字面量 '…' / `…` 里的 " 不算）；同时给出字面量内容清空后的版本 */
function stripComment(line) {
  let code = '';
  let nolit = '';
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!q) {
      if (c === '"') { break; }
      if (c === "'" || c === '`') { q = c; }
      nolit += c;
    } else if (c === q) {
      q = '';
      nolit += c;
    }
    code += c;
  }
  return { code, nolit };
}

function addHit(hits, level, code, text, line) {
  if (hits.some((h) => h.code === code && h.line === line)) { return; }
  hits.push({ level, code, text, line });
}

function addTarget(tok, line, targets, hits) {
  let t = tok;
  if (t[0] === '(') {
    addHit(hits, 'BLOCK', 'DYNWRITE', '用动态表名写数据库', line);
    return;
  }
  if (/[-[>]/.test(t)) { return; }
  const m = /^[A-Z0-9_/]+/.exec(t);
  if (!m) { return; }
  t = m[0];
  if (targets.some((x) => x.table === t && x.line === line)) { return; }
  targets.push({ table: t, line });
}

/**
 * 扫函数本体源码：提交 / 异步写入 / 写库候选 / 跳出类语句
 * @param {string[]} lines 源码行
 * @returns {{hits: object[], targets: object[]}}
 */
function scanSource(lines) {
  const hits = [];
  const targets = [];
  const stmts = [];
  let buf = '';
  let start = 0;
  lines.forEach((line, idx) => {
    const lno = idx + 1;
    if (line.length > 0 && line[0] === '*') { return; }
    const { code, nolit } = stripComment(line);
    const upCode = code.toUpperCase();
    if (upCode.indexOf("'BAPI_TRANSACTION_COMMIT'") >= 0) {
      addHit(hits, 'BLOCK', 'BAPICOMMIT', '调用 BAPI_TRANSACTION_COMMIT', lno);
    }
    if (upCode.indexOf("'POPUP_") >= 0) {
      addHit(hits, 'WARN', 'POPUP', '调用弹窗函数(后台作业里会中止)', lno);
    }
    const up = nolit.toUpperCase();
    // ABAP 的 SPLIT 不产生末尾空段，行尾句点时补一段：效果等同 JS 的 split
    const pcs = up.split('.');
    pcs.forEach((pc, i) => {
      if (!buf.trim() && pc.trim()) { start = lno; }
      buf = buf + ' ' + pc;
      if (i < pcs.length - 1) {
        if (buf.trim()) { stmts.push({ text: buf, line: start }); }
        buf = '';
      }
    });
  });
  if (buf.trim()) { stmts.push({ text: buf, line: start }); }

  stmts.forEach((st) => {
    const s = st.text.replace(/:/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const tok = s.split(' ').filter(Boolean);
    if (!tok.length) { return; }
    const [t1 = '', t2 = '', t3 = ''] = tok;
    const seq = ' ' + s + ' ';
    const line = st.line;
    if (seq.indexOf(' COMMIT WORK ') >= 0) { addHit(hits, 'BLOCK', 'COMMIT', '提交数据库(COMMIT WORK)', line); }
    if (seq.indexOf(' IN UPDATE TASK ') >= 0) { addHit(hits, 'BLOCK', 'UPDTASK', '更新任务(IN UPDATE TASK)', line); }
    if (seq.indexOf(' IN BACKGROUND TASK ') >= 0) { addHit(hits, 'BLOCK', 'BGTASK', '后台任务(IN BACKGROUND TASK)', line); }
    if (seq.indexOf(' STARTING NEW TASK ') >= 0) { addHit(hits, 'BLOCK', 'NEWTASK', '异步调用(STARTING NEW TASK)', line); }
    if (t1 === 'SUBMIT') { addHit(hits, 'WARN', 'SUBMIT', '运行其他程序(SUBMIT)', line); }
    if (t1 === 'CALL' && ['TRANSACTION', 'SCREEN', 'DIALOG'].indexOf(t2) >= 0) {
      addHit(hits, 'WARN', 'CALLUI', `调用界面(CALL ${t2}, 后台作业里会中止)`, line);
    }
    switch (t1) {
      case 'UPDATE':
        if (t2) { addTarget(t2, line, targets, hits); }
        break;
      case 'INSERT':
        if (t2 === 'LINES' || t2 === 'INITIAL' || seq.indexOf(' INTO TABLE ') >= 0) { break; }
        if (t2 === 'INTO') {
          if (t3) { addTarget(t3, line, targets, hits); }
        } else if (t3 === 'FROM' || tok.length === 2) {
          addTarget(t2, line, targets, hits);
        }
        break;
      case 'MODIFY':
        if (t2 && ['TABLE', 'LINE', 'SCREEN', 'CURRENT'].indexOf(t2) < 0) { addTarget(t2, line, targets, hits); }
        break;
      case 'DELETE':
        if (t2 === 'FROM') {
          if (t3 && ['MEMORY', 'SHARED', 'DATABASE'].indexOf(t3) < 0) { addTarget(t3, line, targets, hits); }
        } else if (t2 && ['ADJACENT', 'TABLE', 'DATASET', 'REPORT', 'TEXTPOOL', 'DYNPRO'].indexOf(t2) < 0) {
          addTarget(t2, line, targets, hits);
        }
        break;
      default:
        break;
    }
  });
  return { hits, targets };
}

/** check_writes 的本地版：名字 + 源码 + 写库目标（transp = 透明表名集合，代替 DD02L） */
function checkWrites(fm, lines, transp) {
  const hits = [];
  const w = nameDanger(fm);
  if (w) { addHit(hits, 'NAME', 'NAME', `函数名含 ${w}(疑似写入类)`, 0); }
  const r = scanSource(lines);
  r.hits.forEach((h) => hits.push(h));
  r.targets.forEach((t) => {
    if (t.table.length <= 30 && transp.has(t.table)) { addHit(hits, 'BLOCK', 'DBWRITE', `写数据库表 ${t.table}`, t.line); }
  });
  return hits;
}

/**
 * FUPARAREF 默认值 → 参数卡默认（ABAP 版 = SCANNER.fm_default：ABAP_TRUE / SY-DATLO 先认，其余交给 parse_default）
 * SY-DATUM → TODAY 0；SY-DATUM ± n → TODAY ±n；字面量 / 整数 → STATIC；空字面量和表达式不认
 */
function parseFmDefault(defval) {
  const v = String(defval || '').trim();
  if (!v) { return null; }
  const up = v.toUpperCase();
  if (up === 'ABAP_TRUE') { return { type: 'STATIC', value: 'X' }; }
  if (up === 'SY-DATUM' || up === 'SY-DATLO') { return { type: 'TODAY', value: '0' }; }
  const md = /^SY-DATUM\s*([+-])\s*([0-9]+)$/.exec(up);
  if (md) { return { type: 'TODAY', value: md[1] === '-' ? '-' + md[2] : md[2] }; }
  let m = /^'(.*)'$/.exec(v);
  if (m) { return m[1] ? { type: 'STATIC', value: m[1] } : null; }
  m = /^`(.*)`$/.exec(v);
  if (m) { return m[1] ? { type: 'STATIC', value: m[1] } : null; }
  if (/^-?\d+$/.test(v)) { return { type: 'STATIC', value: v }; }
  return null;
}

/**
 * 接口 → 参数草稿（params 是 read_interface 的结果：name/kind/shape/data_type/type_length/optional/defval/label/text）
 * @returns {{rows: object[], error: string, notes: string[]}}
 */
function draftParams(params) {
  const rows = [];
  const notes = [];
  let error = '';
  let sort = 0;
  params.forEach((p) => {
    if (p.kind === 'X' || p.kind === 'E') { return; }
    if (p.kind === 'T' && p.shape !== 'RANGE') { return; }
    const required = p.kind === 'I' && !p.optional;
    const row = {
      param_id: p.name, abap_name: p.name, display_label: p.label || p.name,
      label_src: p.text ? 'FUNCT' : (p.label && p.label !== p.name ? 'DDIC' : 'NAME'),
      sel_kind: '', data_type: p.data_type || 'CHAR', type_length: p.type_length || 0,
      required: false, multi_value: false, range_allowed: false,
      default_type: '', default_value: '', allowed_ops: '', include: true, note: '', sort_no: 0
    };
    if (p.shape === 'SCALAR' && (p.kind === 'I' || p.kind === 'C')) {
      row.sel_kind = 'P';
      row.required = required;
      const d = parseFmDefault(p.defval);
      if (d) { row.default_type = d.type; row.default_value = d.value; }
    } else if (p.shape === 'FLAG' && (p.kind === 'I' || p.kind === 'C')) {
      row.sel_kind = 'C';
      row.data_type = 'BOOL';
      row.type_length = 1;
      const d = parseFmDefault(p.defval);
      if (d && d.value.toUpperCase() === 'X') { row.allowed_ops = 'X'; }
    } else if (p.shape === 'RANGE') {
      row.sel_kind = 'S';
      row.required = required;
      if (row.data_type === 'DATE') { row.range_allowed = true; } else { row.multi_value = true; }
    } else {
      row.include = false;
      row.sel_kind = 'P';
      row.note = p.shape === 'GENERIC' ? '通用类型，不支持传值' : '结构 / 表参数，一期不支持传值';
      if (required) {
        error = `必填参数 ${p.name} 是${p.shape === 'GENERIC' ? '通用类型' : '结构 / 表'}，一期不支持，函数不能登记`;
      }
    }
    if (row.include) { sort += 10; row.sort_no = sort; }
    rows.push(row);
  });
  if (!rows.some((r) => r.include) && !error) { error = '函数没有可填的输入参数，一期不能登记（参数卡至少要一项）'; }
  return { rows, error, notes };
}

function defaultResult(params) {
  const p = params.filter((x) => x.shape === 'TABLE' && x.name !== 'RETURN' && ['T', 'E', 'C'].indexOf(x.kind) >= 0)[0];
  return p ? p.name : '';
}

module.exports = { nameDanger, stripComment, scanSource, checkWrites, parseFmDefault, draftParams, defaultResult };
