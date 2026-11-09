/*
 * 内置技能包：builtin-skills/<目录>/SKILL.md（+ 同目录下其他 .md 附带资料）→ 部署产物/builtin-skills.json
 * 20261110（《03》〇-AV）起不进前端包：管理员在「技能管理 → 内置 → 导入内置技能包」选这个文件，存进 SAP 表 ZAI_BSKILL，
 * 每次提问由 SAP 按用户开放的场景下发给新引擎（没开对应场景的用户拿不到）。
 * 改了 builtin-skills 下的文件后运行：node scripts/build-builtin-skills.js（npm run build 前也会自动跑）
 * 加 --check：只检查包是否和源文件一致，不写文件（测试用）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'builtin-skills');
const OUT_REL = '部署产物/builtin-skills.json';
const outFile = path.join(root, OUT_REL);
const SCENES = ['REPORT', 'FIORI', 'DATA', 'CODE'];

/** 只认本项目 SKILL.md 用到的几种写法：name / description / metadata 下的 scenes、order（列表顺序）、title、source */
function parseFront(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(file + '：开头缺 --- 包起来的 name / description');
  const out = {};
  let inMeta = false;
  for (const line of m[1].split('\n')) {
    const kv = /^(\s*)([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (!kv[1]) inMeta = kv[2] === 'metadata';
    if (kv[1] && !inMeta) continue;
    let v = kv[3].trim();
    if (!v) continue;
    if (v.startsWith('"')) v = JSON.parse(v);
    out[(kv[1] ? 'meta.' : '') + kv[2]] = v;
  }
  return out;
}

/** 目录下所有 .md（相对路径，/ 分隔，按名字排序） */
function listMd(dir, base = '') {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) out.push(...listMd(path.join(dir, d.name), rel));
    else if (d.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

const sha = s => crypto.createHash('sha1').update(s).digest('hex');

function collect() {
  const dirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  return dirs.map(dir => {
    const file = path.join('builtin-skills', dir, 'SKILL.md');
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const f = parseFront(content, file);
    if (f.name !== dir) throw new Error(file + '：name 必须和目录名一致（' + dir + '）');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(dir) || dir.length > 40) throw new Error(file + '：目录名只用小写字母、数字和单个连字符，最长 40');
    if (!f.description || f.description.length > 1024) throw new Error(file + '：description 必填，最多 1024 字');
    const title = f['meta.title'] || dir;
    if (title.length > 60) throw new Error(file + '：title 最长 60 字');
    const scenes = String(f['meta.scenes'] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!scenes.length || scenes.some(s => !SCENES.includes(s))) throw new Error(file + '：metadata.scenes 必填，只能是 ' + SCENES.join(' / '));
    // 附带资料：技能目录下除 SKILL.md 以外的 .md 文件（如 references/xxx.md），模型按 SKILL.md 的指引再读
    const files = listMd(path.join(root, 'builtin-skills', dir)).filter(r => r !== 'SKILL.md').map(r => {
      if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\.md$/.test(r) || r.includes('..')) throw new Error(file + '：附带文件名只用字母、数字、点、下划线和连字符：' + r);
      return { path: r, content: fs.readFileSync(path.join(root, 'builtin-skills', dir, r), 'utf8') };
    });
    const version = sha(JSON.stringify([content, files])).slice(0, 12);
    return { dir, title, description: f.description, source: f['meta.source'] || '', scenes: scenes.join(','),
      sortNo: Number(f['meta.order']) || 9999, version, content, files };
  }).sort((a, b) => a.sortNo - b.sortNo || a.dir.localeCompare(b.dir));
}

function build() {
  const skills = collect();
  const version = sha(JSON.stringify(skills)).slice(0, 10);
  return JSON.stringify({ version, skills }, null, 1) + '\n';
}

const json = build();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (cur !== json) { console.error(OUT_REL + ' 和 builtin-skills/ 不一致，请运行 node scripts/build-builtin-skills.js'); process.exit(1); }
  console.log('内置技能包与源文件一致');
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, json);
  const n = JSON.parse(json).skills.length;
  console.log('内置技能包：' + n + ' 个 → ' + OUT_REL + '（' + Math.round(Buffer.byteLength(json) / 1024) + ' KB）；在技能管理 → 内置 → 导入');
}

module.exports = { parseFront };
