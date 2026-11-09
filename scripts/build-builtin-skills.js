/*
 * 内置技能打包：builtin-skills/<目录>/SKILL.md → webapp/skills/builtin-skills.json
 * 随前端包（dist）一起上传 BSP；新引擎运行时读这个文件，挂成只读目录 /内置技能/。
 * 改了 builtin-skills 下的文件后运行：node scripts/build-builtin-skills.js（npm run build 前会自动跑）
 * 加 --check：只检查 JSON 是否和源文件一致，不写文件（测试用）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'builtin-skills');
const outFile = path.join(root, 'webapp/skills/builtin-skills.json');

/** 只认本项目 SKILL.md 用到的几种写法：name / description / metadata 下的 order（列表顺序）、title、source */
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

function collect() {
  const dirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  return dirs.map(dir => {
    const file = path.join('builtin-skills', dir, 'SKILL.md');
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const f = parseFront(content, file);
    if (f.name !== dir) throw new Error(file + '：name 必须和目录名一致（' + dir + '）');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(dir)) throw new Error(file + '：目录名只用小写字母、数字和单个连字符');
    if (!f.description || f.description.length > 1024) throw new Error(file + '：description 必填，最多 1024 字');
    return { dir, order: Number(f['meta.order']) || 9999, title: f['meta.title'] || dir, description: f.description, source: f['meta.source'] || '', content };
  }).sort((a, b) => a.order - b.order || a.dir.localeCompare(b.dir)).map(({ order, ...s }) => s);
}

function build() {
  const skills = collect();
  const version = crypto.createHash('sha1').update(JSON.stringify(skills)).digest('hex').slice(0, 10);
  return JSON.stringify({ version, skills }, null, 1) + '\n';
}

const json = build();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (cur !== json) { console.error('webapp/skills/builtin-skills.json 和 builtin-skills/ 不一致，请运行 node scripts/build-builtin-skills.js'); process.exit(1); }
  console.log('内置技能 JSON 与源文件一致');
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, json);
  const n = JSON.parse(json).skills.length;
  console.log('内置技能：' + n + ' 个 → webapp/skills/builtin-skills.json（' + Math.round(json.length / 1024) + ' KB）');
}

module.exports = { parseFront };
