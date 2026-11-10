/**
 * ABAP 常见「编造写法」扫描（11.10 记录 #13）：abap_check（SAP 语法检查）一次只报第一个错误，
 * 这里在浏览器里先把模型常犯、一眼能认出的几类一次全列出来，和 SAP 的结果一起交给模型。
 * 只做提示，不代替 SAP 语法检查；宁可漏报，不要误报。
 */

/** 去掉注释和字符串字面量（保持行号、列数不变），免得注释 / 文本里的词被当成代码 */
function stripCode(line) {
  if (/^\*/.test(line)) return "";
  let out = "", q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { out += " "; if (c === q) q = null; continue; }
    if (c === "'" || c === "`" || c === "|") { q = c; out += " "; continue; }
    if (c === '"') break;
    out += c;
  }
  return out;
}

/** 按句号切语句，记下每条语句开始的行号 */
function statements(lines) {
  const out = [];
  let buf = "", start = 0;
  lines.forEach((raw, i) => {
    const l = stripCode(raw);
    if (!l.trim()) return;
    if (!buf.trim()) { buf = ""; start = i + 1; }
    let rest = l;
    let k;
    while ((k = rest.indexOf(".")) >= 0) {
      // 小数 / 表名里的点（如 1.5、/UI2/X.）不算句号：句号后面是空白或行尾
      const after = rest[k + 1];
      if (after !== undefined && !/\s/.test(after)) { buf += rest.slice(0, k + 1); rest = rest.slice(k + 1); continue; }
      buf += rest.slice(0, k);
      if (buf.trim()) out.push({ line: start, text: buf.replace(/\s+/g, " ").trim() });
      buf = ""; start = i + 1;
      rest = rest.slice(k + 1);
    }
    if (rest.trim()) buf += rest + " ";
  });
  if (buf.trim()) out.push({ line: start, text: buf.replace(/\s+/g, " ").trim() });
  return out;
}

const AFTER_TABLE = new Set(["WHERE", "INTO", "AS", "INNER", "LEFT", "RIGHT", "CROSS", "JOIN", "FIELDS", "UP", "ORDER", "GROUP",
  "HAVING", "FOR", "CLIENT", "USING", "BYPASSING", "CONNECTION", "ON", "APPENDING", "UNION", "PACKAGE", "%_HINTS", "OUTER",
  "WITH", "OPTIONS", "AND", "OR", "OFFSET", "EXCEPT", "INTERSECT", "SINGLE", "DISTINCT", "PRIVILEGED", "TO", "ENDSELECT"]);

/**
 * @param {string} source
 * @returns {{line:number, rule:string, message:string}[]}
 */
export function lintAbap(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const sts = statements(lines);
  const out = [];
  const add = (line, rule, message) => { if (out.length < 30) out.push({ line, rule, message }); };

  // 声明过的名字：TABLES、DATA / TYPES / PARAMETERS / SELECT-OPTIONS / CONSTANTS / FIELD-SYMBOLS / RANGES
  const declared = new Set();
  for (const s of sts) {
    const u = s.text.toUpperCase();
    const m = /^(TABLES|DATA|CLASS-DATA|STATICS|TYPES|PARAMETERS|PARAMETER|SELECT-OPTIONS|CONSTANTS|RANGES|NODES)\s*:?\s*(.*)$/.exec(u);
    if (m) {
      for (const part of m[2].split(",")) {
        const n = /^\s*(?:BEGIN OF\s+)?([A-Z_][\w/]*)/.exec(part);
        if (n) declared.add(n[1]);
      }
    }
    for (const d of u.matchAll(/\bDATA\(\s*([A-Z_]\w*)\s*\)/g)) declared.add(d[1]);
  }

  for (const s of sts) {
    const u = s.text.toUpperCase();
    // ① 表名中间有空格：FROM csk t WHERE …（模型把 CSKT 断开了）
    for (const m of u.matchAll(/\b(FROM|JOIN)\s+([A-Z][A-Z0-9_]{1,15})\s+([A-Z][A-Z0-9_]{0,3})\b(?!~)/g)) {
      const next = m[3];
      if (AFTER_TABLE.has(next)) continue;
      // 后面紧跟 AS 的才是别名；裸写的短词多半是表名被断开
      add(s.line, "table-space", `「${m[1]} ${m[2]} ${next}」：表名中间像是多了空格（是不是 ${m[2]}${next}？），别名要写 AS`);
    }
    // ② 不存在的子句：ADDING CORRESPONDING FIELDS OF
    if (/\bADDING\s+CORRESPONDING\s+FIELDS\b/.test(u)) {
      add(s.line, "adding-corresponding", "ABAP SQL 没有 ADDING CORRESPONDING FIELDS OF；累加要先 INTO 到临时变量再加，或用 SUM( ) 聚合");
    }
    // ③ TRANSPORTING 后面跟赋值
    const tr = /\bTRANSPORTING\s+(.*?)(?:\bWHERE\b|$)/.exec(u);
    if (tr && /=/.test(tr[1]) && /^(MODIFY|READ)\b/.test(u)) {
      add(s.line, "transporting-assign", "TRANSPORTING 后面只能写字段名，不能写「字段 = 值」：先给工作区字段赋值，再 MODIFY … FROM wa TRANSPORTING 字段");
    }
    // ④ 老写法（无逗号、无 @）里聚合函数套算术表达式
    if (/^SELECT\b/.test(u) && /\b(SUM|AVG|MIN|MAX)\(\s*[A-Z_][\w~]*\s*[-+*/]\s*[A-Z_][\w~]*/.test(u) && !/@/.test(u)) {
      add(s.line, "aggregate-expr", "聚合里写算术表达式（如 SUM( a - b )）是新 ABAP SQL 写法，要整条改成新写法（字段逗号分隔、宿主变量加 @），或分开 SUM 后再相减");
    }
    // ⑤ SELECT-OPTIONS … FOR 表-字段，表没在 TABLES / DATA 里声明
    const so = /^SELECT-OPTIONS\s*:?\s*\w+\s+FOR\s+([A-Z_][\w/]*)-/.exec(u);
    if (so && !declared.has(so[1])) {
      add(s.line, "select-options-for", `SELECT-OPTIONS … FOR ${so[1]}-…：${so[1]} 没有在 TABLES 里声明，也不是已定义的变量（加 TABLES ${so[1].toLowerCase()}. 或改成 FOR 已定义的变量）`);
    }
    for (const m of s.text.toUpperCase().matchAll(/,\s*([A-Z_]\w*)\s+FOR\s+([A-Z_][\w/]*)-/g)) {
      if (!declared.has(m[2])) add(s.line, "select-options-for", `SELECT-OPTIONS ${m[1]} FOR ${m[2]}-…：${m[2]} 没有在 TABLES 里声明`);
    }
  }
  return out;
}

/** 给模型看的一段文字；没有发现时返回 "" */
export function lintText(findings) {
  if (!findings || !findings.length) return "";
  return "常见错误写法扫描（浏览器里做的粗查，和 SAP 语法检查的结果一起改；可能有个别误报）：\n" +
    findings.map(f => `- 第 ${f.line} 行：${f.message}`).join("\n");
}
