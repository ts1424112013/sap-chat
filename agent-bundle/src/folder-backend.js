/**
 * 文件夹后端：把 Deep Agents 的文件工具（ls / read_file / write_file / edit_file / grep / glob）
 * 接到用户在浏览器里选定的本地文件夹（File System Access API，需 HTTPS + Chrome/Edge）。
 *
 * 路径约定：Agent 看到的 "/" 就是所选文件夹的根；不能用 ".." 跳出去。
 * 安全约定：
 *   - 改、删之前把原文件备份到 .lingxi/备份/<本次会话时间>/，并往 .lingxi/修改记录.md 追加一行；
 *   - .lingxi/ 目录对 Agent 只读（备份和记录只能由本后端写）；
 *   - 单个文本文件读取上限 2 MB，grep/glob 最多遍历 3000 个文件。
 */

export const META_DIR = ".lingxi";
const BACKUP_DIR = "备份";
const LOG_FILE = "修改记录.md";
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_WALK_FILES = 3000;
const SKIP_DIRS = new Set([".git", "node_modules", ".svn", "__pycache__"]);

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "ini", "cfg", "conf", "log",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "less", "html", "htm", "svg", "sql", "abap",
  "py", "java", "kt", "go", "rs", "c", "h", "cpp", "hpp", "cs", "sh", "bat", "ps1", "properties", "env"
]);
const MIME = {
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", md: "text/markdown",
  xml: "application/xml", html: "text/html", htm: "text/html", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

function extOf(p) {
  const name = p.split("/").pop() || "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}
export function mimeOf(p) {
  const e = extOf(p);
  if (MIME[e]) return MIME[e];
  return TEXT_EXT.has(e) || e === "" ? "text/plain" : "application/octet-stream";
}
export function isTextPath(p) {
  const m = mimeOf(p);
  return m.startsWith("text/") || m === "application/json" || m === "application/xml" || m === "image/svg+xml";
}

/** 把 Agent 给的路径规范成段数组；非法返回 null。"/" → [] */
export function splitPath(p) {
  if (typeof p !== "string") return null;
  const s = p.replace(/\\/g, "/").trim();
  if (!s.startsWith("/")) return null;
  const parts = s.split("/").filter(Boolean);
  for (const seg of parts) {
    if (seg === "." || seg === ".." || seg.includes("\0")) return null;
  }
  return parts;
}

/** 简单 glob → 正则：支持 ** / * / ? / {a,b}；匹配对象是相对根的路径（不带前导 /） */
export function globToRegExp(glob) {
  let g = String(glob || "*").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!g.includes("/")) g = "**/" + g; // "*.csv" 在任意层级都匹配
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const j = g.indexOf("}", i);
      if (j < 0) { re += "\\{"; continue; }
      re += "(?:" + g.slice(i + 1, j).split(",").map(x => x.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
      i = j;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** 字符串替换，语义与 Deep Agents 内置 edit 一致 */
export function replaceOnce(content, oldString, newString, replaceAll) {
  if (content === "" && oldString === "") return [newString, 0];
  if (oldString === "") return "Error: oldString cannot be empty when file has content";
  const n = content.split(oldString).length - 1;
  if (n === 0) return `Error: String not found in file: '${oldString}'`;
  if (n > 1 && !replaceAll) return `Error: String '${oldString}' appears ${n} times. Use replace_all=true or give more surrounding context.`;
  return [content.split(oldString).join(newString), n];
}

function stamp(d = new Date()) {
  const z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function fsError(e, path) {
  const n = e && e.name;
  if (n === "NotFoundError") return `Error: '${path}' not found`;
  if (n === "TypeMismatchError") return `Error: '${path}' is a directory, not a file (or the other way round)`;
  if (n === "NotAllowedError" || n === "SecurityError") return `Error: no permission for '${path}'. Ask the user to re-authorize the folder.`;
  if (n === "NoModificationAllowedError" || n === "InvalidStateError") return `Error: '${path}' is locked (maybe open in Excel/another program). Ask the user to close it and retry.`;
  return `Error: ${path}: ${(e && e.message) || e}`;
}

export class FolderBackend {
  /**
   * @param {FileSystemDirectoryHandle} root 用户选的文件夹
   * @param {{ question?: () => string, onChange?: (rec) => void, readOnly?: boolean,
   *           confirm?: (req: {action:string, path:string, before:string|null, after:string|null}) => Promise<boolean|{approved:boolean,message?:string}> }} [opts]
   *   confirm：改、删之前调用，用户同意才写；不给就直接写
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.name = root && root.name;
    this.opts = opts;
    this.session = stamp();
    /** 本页面里的修改记录（撤回用），最新在后 */
    this.changes = [];
  }

  // ---------- 句柄定位 ----------
  async _dir(parts, create = false) {
    let d = this.root;
    for (const seg of parts) d = await d.getDirectoryHandle(seg, { create });
    return d;
  }
  async _file(path, create = false) {
    const parts = splitPath(path);
    if (!parts || parts.length === 0) throw Object.assign(new Error("invalid path"), { name: "InvalidPath" });
    const dir = await this._dir(parts.slice(0, -1), create);
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }
  _isMeta(path) {
    const parts = splitPath(path);
    return !!parts && parts[0] === META_DIR;
  }
  _guardWrite(path) {
    const parts = splitPath(path);
    if (!parts || parts.length === 0) return `Error: invalid path '${path}'. Use an absolute path inside the folder, e.g. /report.csv`;
    if (parts[0] === META_DIR) return `Error: ${META_DIR}/ is managed by 灵犀 (backups and change log) and is read-only.`;
    if (this.opts.readOnly) return "Error: the folder is opened read-only.";
    return null;
  }

  // ---------- 读 ----------
  async ls(path = "/") {
    const parts = splitPath(path);
    if (!parts) return { error: `Error: invalid path '${path}'` };
    try {
      const dir = await this._dir(parts);
      const base = "/" + parts.map(s => s + "/").join("");
      const files = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind === "directory") files.push({ path: base + name + "/", is_dir: true, size: 0, modified_at: "" });
        else {
          let size = 0, modified_at = "";
          try { const f = await h.getFile(); size = f.size; modified_at = new Date(f.lastModified).toISOString(); } catch (e) { /* 被占用时只给名字 */ }
          files.push({ path: base + name, is_dir: false, size, modified_at });
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { files };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  async _readFile(path) {
    const h = await this._file(path);
    return h.getFile();
  }

  async read(path, offset = 0, limit = 500) {
    try {
      const f = await this._readFile(path);
      const mimeType = mimeOf(path);
      if (!isTextPath(path)) {
        if (f.size > MAX_TEXT_BYTES * 5) return { error: `Error: '${path}' is too large to read (${f.size} bytes)` };
        return { content: new Uint8Array(await f.arrayBuffer()), mimeType };
      }
      if (f.size > MAX_TEXT_BYTES) return { error: `Error: '${path}' is ${f.size} bytes; text files over 2 MB are not read. Use grep to find the part you need.` };
      const text = await f.text();
      const lines = text.split("\n");
      const total = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      const off = Math.max(0, Number(offset) || 0);
      const lim = Math.max(0, limit == null ? 500 : Number(limit));
      const sel = lines.slice(off, off + lim);
      if (sel.length === 0 || off >= total || lim === 0) return { content: sel.join("\n"), mimeType };
      const end = Math.min(off + sel.length, total);
      return { content: sel.join("\n"), mimeType, totalLines: total, startLine: off + 1, endLine: end, nextOffset: end < total ? end : undefined };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  async readRaw(path) {
    try {
      const f = await this._readFile(path);
      const mimeType = mimeOf(path);
      const ts = new Date(f.lastModified).toISOString();
      const content = isTextPath(path) ? await f.text() : new Uint8Array(await f.arrayBuffer());
      return { data: { content, mimeType, created_at: ts, modified_at: ts } };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  /** 批量读原始字节（记忆中间件等内部组件用） */
  async downloadFiles(paths) {
    const out = [];
    for (const p of paths) {
      if (!splitPath(p) || splitPath(p).length === 0) { out.push({ path: p, content: null, error: "invalid_path" }); continue; }
      try {
        const f = await this._readFile(p);
        out.push({ path: p, content: new Uint8Array(await f.arrayBuffer()), error: null });
      } catch (e) {
        const n = e && e.name;
        out.push({ path: p, content: null, error: n === "NotFoundError" ? "file_not_found" : n === "TypeMismatchError" ? "is_directory" : (n === "NotAllowedError" || n === "SecurityError") ? "permission_denied" : "file_not_found" });
      }
    }
    return out;
  }

  // ---------- 遍历 ----------
  async _walk(startParts, visit) {
    let count = 0, truncated = false;
    const walk = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (count >= MAX_WALK_FILES) { truncated = true; return; }
        const rel = prefix ? prefix + "/" + name : name;
        if (h.kind === "directory") {
          if (SKIP_DIRS.has(name) || (rel === META_DIR + "/" + BACKUP_DIR)) continue;
          await walk(h, rel);
        } else {
          count++;
          await visit(rel, h);
        }
      }
    };
    await walk(await this._dir(startParts), startParts.join("/"));
    return truncated;
  }

  async glob(pattern, path = "/") {
    const parts = splitPath(path);
    if (!parts) return { error: `Error: invalid path '${path}'` };
    try {
      const re = globToRegExp(pattern);
      const base = parts.join("/");
      const files = [];
      const truncated = await this._walk(parts, async (rel, h) => {
        const relToBase = base ? rel.slice(base.length + 1) : rel;
        if (re.test(relToBase)) {
          let size = 0, modified_at = "";
          try { const f = await h.getFile(); size = f.size; modified_at = new Date(f.lastModified).toISOString(); } catch (e) { /* ignore */ }
          files.push({ path: "/" + rel, is_dir: false, size, modified_at });
        }
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { files, truncated };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  async grep(pattern, path = "/", glob = null, maxCount = null) {
    const parts = splitPath(path || "/");
    if (!parts) return { error: `Error: invalid path '${path}'` };
    if (!pattern) return { error: "Error: empty pattern" };
    const cap = maxCount && maxCount > 0 ? maxCount : 500;
    try {
      const re = glob ? globToRegExp(glob) : null;
      const base = parts.join("/");
      const matches = [];
      let truncated = await this._walk(parts, async (rel, h) => {
        if (matches.length >= cap) return;
        const p = "/" + rel;
        if (!isTextPath(p)) return;
        if (re && !re.test(base ? rel.slice(base.length + 1) : rel)) return;
        let f; try { f = await h.getFile(); } catch (e) { return; }
        if (f.size > MAX_TEXT_BYTES) return;
        const lines = (await f.text()).split("\n");
        for (let i = 0; i < lines.length && matches.length < cap; i++) {
          if (lines[i].includes(pattern)) matches.push({ path: p, line: i + 1, text: lines[i].slice(0, 500) });
        }
      });
      if (matches.length >= cap) truncated = true;
      return { matches, truncated };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  // ---------- 写（备份 + 记录） ----------
  async _exists(path) {
    try { await this._file(path); return true; } catch (e) { return false; }
  }

  async _backup(path) {
    let f;
    try { f = await this._readFile(path); } catch (e) { return null; } // 新文件无需备份
    const parts = splitPath(path);
    const target = [META_DIR, BACKUP_DIR, this.session, ...parts];
    const dir = await this._dir(target.slice(0, -1), true);
    // 同一会话里同一文件只保留第一次的原样（撤回到会话开始前）
    let bh;
    try { bh = await dir.getFileHandle(target[target.length - 1]); return "/" + target.join("/"); } catch (e) { /* 还没备份过 */ }
    bh = await dir.getFileHandle(target[target.length - 1], { create: true });
    const w = await bh.createWritable();
    await w.write(await f.arrayBuffer());
    await w.close();
    return "/" + target.join("/");
  }

  async _log(action, path, detail) {
    const rec = { at: new Date().toISOString(), action, path, detail: detail || "", question: (this.opts.question && this.opts.question()) || "" };
    try {
      const dir = await this._dir([META_DIR], true);
      const h = await dir.getFileHandle(LOG_FILE, { create: true });
      const f = await h.getFile();
      const w = await h.createWritable({ keepExistingData: true });
      const head = f.size === 0 ? "# 灵犀修改记录\n\n| 时间 | 操作 | 文件 | 说明 | 对应提问 |\n|---|---|---|---|---|\n" : "";
      const cell = s => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
      await w.seek(f.size);
      await w.write(head + `| ${rec.at} | ${action} | ${cell(path)} | ${cell(rec.detail)} | ${cell(rec.question)} |\n`);
      await w.close();
    } catch (e) { /* 记录失败不影响主操作 */ }
    return rec;
  }

  /** 改前确认：返回 null 表示同意，否则返回给 Agent 的拒绝说明 */
  async _confirm(action, path, before, after) {
    if (!this.opts.confirm) return null;
    let r;
    try { r = await this.opts.confirm({ action, path, before, after }); } catch (e) { r = { approved: false, message: (e && e.message) || "确认失败" }; }
    const approved = r === true || (r && r.approved === true);
    if (approved) return null;
    const why = r && r.message ? `：${r.message}` : "";
    return `Error: 用户拒绝了这次${action}（${path}）${why}。不要换个方式再改，先问用户想怎么处理。`;
  }

  async _textOrNull(path) {
    if (!isTextPath(path)) return null;
    try { const f = await this._readFile(path); return f.size > MAX_TEXT_BYTES ? null : await f.text(); } catch (e) { return null; }
  }

  async _writeText(path, content) {
    const h = await this._file(path, true);
    const w = await h.createWritable();
    await w.write(content);
    await w.close();
  }

  async write(path, content) {
    const bad = this._guardWrite(path);
    if (bad) return { error: bad };
    try {
      const existed = await this._exists(path);
      const denied = await this._confirm(existed ? "覆盖" : "新建", path, existed ? await this._textOrNull(path) : null, String(content));
      if (denied) return { error: denied };
      const backup = existed ? await this._backup(path) : null;
      await this._writeText(path, String(content));
      const rec = await this._log(existed ? "覆盖" : "新建", path, `${String(content).length} 字符`);
      this.changes.push({ ...rec, backup, created: !existed });
      this.opts.onChange && this.opts.onChange(this.changes[this.changes.length - 1]);
      return { path, filesUpdate: null };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  async edit(path, oldString, newString, replaceAll = false) {
    const bad = this._guardWrite(path);
    if (bad) return { error: bad };
    if (!isTextPath(path)) return { error: `Error: '${path}' is not a text file; edit only works on text files.` };
    try {
      const f = await this._readFile(path);
      if (f.size > MAX_TEXT_BYTES) return { error: `Error: '${path}' is too large to edit` };
      const r = replaceOnce(await f.text(), oldString, newString, replaceAll);
      if (typeof r === "string") return { error: r };
      const before = await f.text();
      const denied = await this._confirm("修改", path, before, r[0]);
      if (denied) return { error: denied };
      const backup = await this._backup(path);
      await this._writeText(path, r[0]);
      const rec = await this._log("修改", path, `替换 ${r[1]} 处`);
      this.changes.push({ ...rec, backup, created: false });
      this.opts.onChange && this.opts.onChange(this.changes[this.changes.length - 1]);
      return { path, filesUpdate: null, occurrences: r[1] };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  async delete(path) {
    const bad = this._guardWrite(path);
    if (bad) return { error: bad };
    const parts = splitPath(path);
    try {
      if (!(await this._exists(path))) return { error: `Error: '${path}' not found or is a directory (only single files can be deleted)` };
      const denied = await this._confirm("删除", path, await this._textOrNull(path), null);
      if (denied) return { error: denied };
      const backup = await this._backup(path);
      if (!backup) return { error: `Error: '${path}' not found or is a directory (only single files can be deleted)` };
      const dir = await this._dir(parts.slice(0, -1));
      await dir.removeEntry(parts[parts.length - 1]);
      const rec = await this._log("删除", path, "已备份");
      this.changes.push({ ...rec, backup, created: false, deleted: true });
      this.opts.onChange && this.opts.onChange(this.changes[this.changes.length - 1]);
      return { path, filesUpdate: null };
    } catch (e) { return { error: fsError(e, path) }; }
  }

  /** 撤回本页面里最近一次修改：新建的删掉，改过 / 删过的从备份恢复 */
  async undoLast() {
    const c = this.changes.pop();
    if (!c) return { error: "没有可撤回的修改" };
    try {
      if (c.created) {
        const parts = splitPath(c.path);
        const dir = await this._dir(parts.slice(0, -1));
        await dir.removeEntry(parts[parts.length - 1]);
      } else if (c.backup) {
        const src = await (await this._file(c.backup)).getFile();
        const h = await this._file(c.path, true);
        const w = await h.createWritable();
        await w.write(await src.arrayBuffer());
        await w.close();
      }
      await this._log("撤回", c.path, `撤回 ${c.action}`);
      return { path: c.path, action: c.action };
    } catch (e) {
      this.changes.push(c);
      return { error: fsError(e, c.path) };
    }
  }
}

// ---------- 授权与记住文件夹（IndexedDB 只存句柄，不存内容） ----------
const DB = "lingxi-agent", STORE = "folders";

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req && req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export function folderSupported() {
  return typeof window !== "undefined" && window.isSecureContext && typeof window.showDirectoryPicker === "function";
}

/** 让用户选文件夹（必须在点击事件里调用），并记住；key 一般用 SAP 用户名 */
export async function pickFolder(key) {
  const h = await window.showDirectoryPicker({ id: "lingxi-agent", mode: "readwrite" });
  try { await idbDo("readwrite", s => s.put(h, key)); } catch (e) { /* 记不住也能用 */ }
  return h;
}

/** 取回上次的文件夹；返回 { handle, permission: 'granted'|'prompt'|'denied' } 或 null */
export async function restoreFolder(key) {
  let h;
  try { h = await idbDo("readonly", s => s.get(key)); } catch (e) { return null; }
  if (!h) return null;
  let permission = "prompt";
  try { permission = await h.queryPermission({ mode: "readwrite" }); } catch (e) { /* 老浏览器 */ }
  return { handle: h, permission };
}

/** 重新请求权限（必须在点击事件里调用） */
export async function requestFolderPermission(handle) {
  return handle.requestPermission({ mode: "readwrite" });
}

export async function forgetFolder(key) {
  try { await idbDo("readwrite", s => s.delete(key)); } catch (e) { /* ignore */ }
}
