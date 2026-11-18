const REF_LINE = /\n\n可展示的结果表编号：[A-Z0-9, ]+$/;
const SELECTION_LINE = /^[ \t]*\[\[结果表[:：][ \t]*(D\d+(?:[ \t]*[,，、][ \t]*D\d+)*)[ \t]*\]\][ \t]*\r?$/gm;

export function withTableRefs(text, ids) {
  return ids.length ? text + "\n\n可展示的结果表编号：" + ids.join(", ") : text;
}

export function withoutTableRefs(text) {
  return text.replace(REF_LINE, "");
}

export function selectResultTables(text, tables) {
  const selected = new Map();
  const fingerprints = new Set();
  const answer = text.replace(SELECTION_LINE, (_, ids) => {
    for (const id of ids.split(/[\s,，、]+/)) {
      // 与 ChatService._sanitizeAnalysis 的回答区表格上限一致。
      if (selected.size >= 4) break;
      if (!tables.has(id) || selected.has(id)) continue;
      const d = tables.get(id);
      const fingerprint = JSON.stringify([d.name, d.source, d.columns, d.rows, d.total_rows, d.truncated]);
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      selected.set(id, d);
    }
    return "";
  }).trimEnd();
  return { answer, datasets: [...selected.values()] };
}
