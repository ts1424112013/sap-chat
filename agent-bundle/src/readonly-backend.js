/**
 * 只读内存后端：把一组固定文本文件（如 SAP 下发的技能）挂成 Deep Agents 的文件目录。
 * 路径相对挂载点，"/" 是根；Agent 只能 ls / read / glob / grep，写、改、删一律拒绝。
 */
import { globToRegExp, splitPath } from "./folder-backend.js";

export class ReadonlyMemBackend {
  /** @param {Record<string,string>} files 绝对路径（以 / 开头）→ 文本内容 */
  constructor(files = {}) {
    this.files = new Map();
    for (const [p, c] of Object.entries(files)) {
      const parts = splitPath(p);
      if (parts && parts.length) this.files.set("/" + parts.join("/"), String(c));
    }
    this.ts = new Date().toISOString();
  }

  _norm(path) {
    const parts = splitPath(path || "/");
    return parts ? "/" + parts.join("/") : null;
  }

  async ls(path = "/") {
    const p = this._norm(path);
    if (p === null) return { error: `Error: invalid path '${path}'` };
    const base = p === "/" ? "/" : p + "/";
    const seen = new Map();
    for (const [fp, c] of this.files) {
      if (!fp.startsWith(base)) continue;
      const rest = fp.slice(base.length);
      const i = rest.indexOf("/");
      if (i < 0) seen.set(fp, { path: fp, is_dir: false, size: c.length, modified_at: this.ts });
      else {
        const d = base + rest.slice(0, i) + "/";
        if (!seen.has(d)) seen.set(d, { path: d, is_dir: true, size: 0, modified_at: "" });
      }
    }
    if (!seen.size && p !== "/" && !this.files.has(p)) return { error: `Error: '${path}' not found` };
    return { files: [...seen.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }

  async read(path, offset = 0, limit = 500) {
    const p = this._norm(path);
    if (p === null || !this.files.has(p)) return { error: `Error: '${path}' not found` };
    const lines = this.files.get(p).split("\n");
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(0, limit == null ? 500 : Number(limit));
    const sel = lines.slice(off, off + lim);
    const end = Math.min(off + sel.length, lines.length);
    return { content: sel.join("\n"), mimeType: "text/markdown", totalLines: lines.length, startLine: off + 1, endLine: end, nextOffset: end < lines.length ? end : undefined };
  }

  async readRaw(path) {
    const p = this._norm(path);
    if (p === null || !this.files.has(p)) return { error: `Error: '${path}' not found` };
    return { data: { content: this.files.get(p), mimeType: "text/markdown", created_at: this.ts, modified_at: this.ts } };
  }

  async downloadFiles(paths) {
    const enc = new TextEncoder();
    return paths.map(path => {
      const p = this._norm(path);
      return p !== null && this.files.has(p)
        ? { path, content: enc.encode(this.files.get(p)), error: null }
        : { path, content: null, error: "file_not_found" };
    });
  }

  async glob(pattern, path = "/") {
    const p = this._norm(path);
    if (p === null) return { error: `Error: invalid path '${path}'` };
    const re = globToRegExp(pattern);
    const base = p === "/" ? "/" : p + "/";
    const files = [];
    for (const [fp, c] of this.files) {
      if (fp.startsWith(base) && re.test(fp.slice(base.length))) files.push({ path: fp, is_dir: false, size: c.length, modified_at: this.ts });
    }
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  async grep(pattern, path = "/", glob = null) {
    const p = this._norm(path);
    if (p === null) return { error: `Error: invalid path '${path}'` };
    if (!pattern) return { error: "Error: empty pattern" };
    const re = glob ? globToRegExp(glob) : null;
    const base = p === "/" ? "/" : p + "/";
    const matches = [];
    for (const [fp, c] of this.files) {
      if (!fp.startsWith(base) || (re && !re.test(fp.slice(base.length)))) continue;
      c.split("\n").forEach((l, i) => { if (l.includes(pattern)) matches.push({ path: fp, line: i + 1, text: l.slice(0, 500) }); });
    }
    return { matches };
  }

  async write(path) { return { error: `Error: '${path}' 是只读目录（由 SAP 管理员维护），不能写。` }; }
  async edit(path) { return { error: `Error: '${path}' 是只读目录（由 SAP 管理员维护），不能改。` }; }
  async delete(path) { return { error: `Error: '${path}' 是只读目录（由 SAP 管理员维护），不能删。` }; }
}

/** SAP 技能 → SKILL.md（Agent Skills 格式：YAML 头 name / description + 正文） */
export function skillFiles(skills) {
  const files = {};
  const used = new Set();
  for (const s of skills || []) {
    if (!s || !s.id || !s.body) continue;
    let dir = String(s.id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "skill";
    while (used.has(dir)) dir += "_";
    used.add(dir);
    const name = String(s.name || s.id).replace(/\s+/g, " ").trim();
    const desc = String(s.description || s.name || "").replace(/\s+/g, " ").trim().slice(0, 1000) || name;
    files[`/${dir}/SKILL.md`] = [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(desc)}`,
      "metadata:",
      `  sap_skill_id: ${JSON.stringify(String(s.id))}`,
      "---",
      "",
      `# ${name}`,
      "",
      "以下是管理员维护的做法；工具权限、数据范围不因技能改变。",
      "",
      String(s.body)
    ].join("\n");
  }
  return files;
}
