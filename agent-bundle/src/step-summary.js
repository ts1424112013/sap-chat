/**
 * 每一步工具的「一句话结果」—— 不花模型时间，按工具名和返回内容生成（界面改版方案 V1.1 §3）。
 * 取不到结构化信息时退回「返回 N 字」。
 */

function parse(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try { return JSON.parse(t); } catch (e) {
    // SAP 裁剪过的 JSON 不完整：只取开头几个数字字段
    const o = {};
    for (const k of ["total", "count", "total_rows", "rows_sent", "field_count", "rows_matched", "returned"]) {
      const m = new RegExp(`"${k}"\\s*:\\s*(\\d+)`).exec(t);
      if (m) o[k] = Number(m[1]);
    }
    const tb = /"table"\s*:\s*"([^"]+)"/.exec(t);
    if (tb) o.table = tb[1];
    const ds = /"desc"\s*:\s*"([^"]*)"/.exec(t);
    if (ds) o.desc = ds[1];
    return Object.keys(o).length ? o : null;
  }
}

const n = v => Number(v || 0).toLocaleString("zh-CN");
const cut = (s, k = 60) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k) + "…" : s; };

/** 数据集数组里第一个的行数说明 */
function dsText(arr) {
  const d = Array.isArray(arr) ? arr[0] : arr;
  if (!d || typeof d !== "object") return "";
  if (d.status && d.status !== "OK") return "查询失败：" + cut(d.error, 80);
  const total = d.total_rows != null ? d.total_rows : (d.rows ? d.rows.length : null);
  if (total == null) return "";
  let s = `查到 ${n(total)} 行`;
  if (d.rows_sent != null && d.rows_sent < total) s += `（给模型看了 ${n(d.rows_sent)} 行）`;
  return s;
}

/** 分组结果的前几组：「已下达 210、部分报工 86、待收货 30」 */
function topGroups(o) {
  const ds = o && (o.dataset || (Array.isArray(o.datasets) ? o.datasets[0] : null));
  if (!ds || !Array.isArray(ds.rows) || !ds.rows.length || !Array.isArray(ds.columns) || ds.columns.length < 2) return "";
  const iNum = ds.columns.findIndex((c, i) => i > 0 && c && c.numeric);
  if (iNum < 0) return "";
  return ds.rows.slice(0, 3).map(r => `${cut(r[0], 16)} ${n(r[iNum])}`).join("、");
}

export function summarizeStep(tool, args, text, ok) {
  const a = args || {};
  const t = String(text || "");
  if (!ok) return cut(t.replace(/^(工具执行失败：|Error:\s*)/, ""), 100) || "失败";
  const o = parse(t);
  if (o && o.ok === false) return cut(o.error || o.message || "失败", 100);
  switch (tool) {
    case "search_tables":
      if (o && Array.isArray(o.tables)) {
        const names = o.tables.slice(0, 3).map(x => x && (x.name || x.tabname || x.TABNAME)).filter(Boolean);
        return `找到 ${n(o.count != null ? o.count : o.tables.length)} 张表${names.length ? "：" + names.join("、") + (o.tables.length > 3 ? " 等" : "") : ""}`;
      }
      break;
    case "describe_table":
      if (o && o.table) return `${o.table}${o.desc ? " " + o.desc : ""}，${n(o.field_count)} 个字段`;
      break;
    case "run_sql":
    case "sap_data_analysis":
    case "call_function":
      if (o) {
        const s = dsText(o.dataset || o.datasets);
        if (s) return s + (o.name ? `（${cut(o.name, 30)}）` : "");
      }
      break;
    case "query_result":
    case "lookup_by_result": {
      if (o) {
        const g = topGroups(o);
        const tot = o.total != null ? o.total : null;
        if (g) return `${tot != null ? n(tot) + " 组：" : ""}${g}${tot > 3 ? " …" : ""}`;
        if (tot != null) return `符合条件 ${n(tot)} 行${o.returned != null ? "，返回 " + n(o.returned) + " 行" : ""}`;
      }
      break;
    }
    case "list_results":
      if (o && Array.isArray(o.results)) {
        if (!o.results.length) return "本会话还没有报表结果";
        const f = o.results[0];
        return `找到 ${o.results.length} 份：${cut(f.label, 24)}${f.report ? "（" + f.report + "）" : ""}${f.rows != null ? "，" + n(f.rows) + " 行" : ""}${o.results.length > 1 ? " 等" : ""}`;
      }
      break;
    case "read_result": {
      const m = /共\s*([\d,]+)\s*行/.exec(t);
      if (m) return `结果概况：共 ${m[1]} 行`;
      break;
    }
    case "read_file": {
      if (/^Error/.test(t)) return cut(t, 100);
      const lines = t.split("\n").length;
      const m = /共\s*(\d+)\s*行|totalLines["\s:]+(\d+)/.exec(t);
      return `读了 ${n(lines)} 行${m ? `（共 ${n(m[1] || m[2])} 行）` : ""}`;
    }
    case "ls":
    case "glob": {
      const k = t.split("\n").filter(l => l.trim() && !/^Error/.test(l)).length;
      return k ? `${n(k)} 项` : "空";
    }
    case "grep": {
      const k = t.split("\n").filter(l => /:\d+:/.test(l) || /^\s*\d+:/.test(l)).length;
      return k ? `${n(k)} 处匹配` : (/no matches|未找到|No matches/i.test(t) ? "没有匹配" : cut(t, 60));
    }
    case "write_file":
      return /Successfully|已/.test(t) ? `已写入 ${cut(a.file_path || a.path, 50)}` : cut(t, 80);
    case "edit_file":
      return /Successfully|已/.test(t) ? `已修改 ${cut(a.file_path || a.path, 50)}` : cut(t, 80);
    case "save_result_to_folder":
      return cut(t, 100);
    case "task":
      return "子任务完成：" + cut(t, 60);
    case "read_program_source": {
      const m = /"total_lines"\s*:\s*(\d+)|共\s*(\d+)\s*行/.exec(t);
      return m ? `读了源码（共 ${n(m[1] || m[2])} 行）` : `读了源码（${n(t.length)} 字）`;
    }
    default:
      break;
  }
  if (/^adt_/.test(tool)) {
    let m;
    switch (tool) {
      case "adt_search": m = /找到 (\d+) 个对象/.exec(t); return m ? `找到 ${n(m[1])} 个对象` : cut(t, 60);
      case "adt_read_source":
        m = /命中 (\d+) 处/.exec(t); if (m) return `「${cut(a.keyword, 20)}」命中 ${n(m[1])} 处`;
        m = /共 (\d+) 行，第 (\d+)–(\d+) 行/.exec(t); if (m) return `读了第 ${m[2]}–${m[3]} 行（共 ${n(m[1])} 行）`;
        return cut(t.split("\n")[0], 60);
      case "adt_structure": m = /结构（(\d+) 项）/.exec(t); return m ? `${n(m[1])} 项` : cut(t, 60);
      case "adt_where_used": m = /共 (\d+) 个/.exec(t); return m ? `被 ${n(m[1])} 个对象使用` : cut(t, 60);
      case "adt_package": m = /共 (\d+) 个对象/.exec(t); return m ? `${n(m[1])} 个对象` : cut(t, 60);
      case "adt_syntax_check": m = /错误 (\d+) 个，警告 \/ 提示 (\d+) 个/.exec(t);
        return m ? `错误 ${m[1]} 个，警告 ${m[2]} 个` : (/通过/.test(t) ? "语法检查通过" : cut(t, 60));
      default: return cut(t, 60);
    }
  }
  if (o && (o.total != null || o.count != null)) return `共 ${n(o.total != null ? o.total : o.count)} 条`;
  return `返回 ${n(t.length)} 字`;
}

/** 工具行上显示的主要参数（一个，过长截断） */
export function mainArg(tool, args) {
  const a = args || {};
  if (/^adt_/.test(tool)) {
    const obj = a.object || a.query || a.package || "";
    return cut(obj + (a.keyword ? " · " + a.keyword : a.start_line > 1 ? " · 第 " + a.start_line + " 行起" : ""), 80);
  }
  const v = a.file_path || a.path || a.pattern || a.keyword || a.table || a.tabname || a.tcode ||
    a.purpose || a.name || a.description || a.result_id || a.function || "";
  return cut(typeof v === "string" ? v : JSON.stringify(v), 80);
}
