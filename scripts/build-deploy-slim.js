/* 部署精简包：从 ui5 build 产出的 dist 里只挑浏览器运行时会用到的文件。
 *
 * 起因（10.29 QAS 排障）：整包 10,479 个文件，/UI5/UI5_REPOSITORY_LOAD 要传约 1.5 小时，
 * 中途断开就会留下新旧 UI5 混用的半成品。文件少了，上传时间和中断风险一起降下来。
 *
 * 用法：node scripts/build-deploy-slim.js [--in dist] [--out dist-deploy] [--themes a,b] [--zip]
 *   去掉：.map、-dbg 调试版、.less 主题源文件、测试框架、没用到的主题、只有主题没有代码的库文件夹
 *   保留：其余全部（含所有语言包）；主题留 base + config.js 里的 ui5Theme（或 --themes 指定）
 *   注意：精简包里没有调试版，URL 加 sap-ui-debug=true 会找不到文件。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const inDir = path.resolve(args.in || path.join(root, 'dist'));
const outDir = path.resolve(args.out || path.join(root, 'dist-deploy'));

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'zip') { o.zip = true; continue; }
    if (!['in', 'out', 'themes'].includes(key) || i + 1 >= argv.length) {
      fail('用法: --in <dist目录> --out <输出目录> --themes sap_horizon,... --zip');
    }
    o[key] = argv[++i];
  }
  return o;
}

function walk(dir, base = dir, list = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, list);
    else if (e.isFile()) list.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return list;
}

function readText(rel) {
  const p = path.join(inDir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/* ---------- 输入检查 ---------- */
if (!fs.existsSync(path.join(inDir, 'index.html')) || !fs.existsSync(path.join(inDir, 'resources/sap-ui-core.js'))) {
  fail('输入目录不是带 UI5 运行时的 dist（缺 index.html 或 resources/sap-ui-core.js）: ' + inDir);
}
const overlap = (a, b) => a === b || a.startsWith(b + path.sep);
if (overlap(outDir, inDir) || overlap(inDir, outDir) || outDir === root) fail('输出目录不能和输入目录或项目根目录重叠: ' + outDir);

/* ---------- 要保留的主题 ---------- */
let themes = args.themes ? args.themes.split(',').map(s => s.trim()).filter(Boolean) : [];
if (!themes.length) {
  const m = (readText('config-dbg.js') + readText('config.js')).match(/ui5Theme\s*:\s*["']([\w-]+)["']/);
  themes = [m ? m[1] : 'sap_horizon'];
  if (!m) console.warn('! config.js 里没读到 ui5Theme，按 sap_horizon 处理');
}
const keepThemes = new Set(['base', ...themes]);

/* ---------- 分类规则（按顺序，第一条命中的算数） ---------- */
const files = walk(inDir);
const themedLibs = new Set();
for (const f of files) {
  const i = f.indexOf('/themes/');
  if (i > 0) themedLibs.add(f.slice(0, i));
}
for (const t of themes) {
  if (!files.includes('resources/sap/ui/core/themes/' + t + '/library.css')) fail('dist 里没有主题 ' + t);
}
// 主题包会给所有 SAP 库都带一份皮肤，包里没有代码的库用不上
const themeOnlyLibs = [...themedLibs].filter(lib =>
  !files.some(f => f.startsWith(lib + '/') && !f.startsWith(lib + '/themes/')));

const RULES = [
  ['系统文件', f => /(^|\/)\.DS_Store$/.test(f)],
  ['source map', f => f.endsWith('.map')],
  ['调试版 -dbg', f => /-dbg(\.[^/.]+)?\.js$/.test(f)],
  ['主题源文件 .less', f => f.endsWith('.less')],
  ['测试框架', f => /^test-resources\//.test(f)
    || f === 'resources/sap-ui-testenv.js'
    || /^resources\/sap\/ui\/(test|qunit)\//.test(f)
    || /^resources\/sap\/ui\/thirdparty\/(qunit|sinon|blanket)[^/]*$/.test(f)],
  ['只有主题的库', f => themeOnlyLibs.some(lib => f.startsWith(lib + '/'))],
  ['没用到的主题', f => { const m = f.match(/\/themes\/([^/]+)\//); return !!m && !keepThemes.has(m[1]); }],
];

const removed = {};
const kept = [];
for (const f of files) {
  const hit = RULES.find(([, test]) => test(f));
  if (hit) removed[hit[0]] = (removed[hit[0]] || 0) + 1;
  else kept.push(f);
}

/* ---------- 写输出（只覆盖之前生成过的精简包） ---------- */
if (fs.existsSync(outDir)) {
  const entries = fs.readdirSync(outDir).filter(n => n !== '.DS_Store');
  const looksLikeSlim = fs.existsSync(path.join(outDir, 'index.html')) && fs.existsSync(path.join(outDir, 'resources/sap-ui-core.js'));
  if (entries.length && !looksLikeSlim) fail('输出目录已存在且不像精简包，不覆盖: ' + outDir);
  fs.rmSync(outDir, { recursive: true, force: true });
}
let bytesIn = 0, bytesOut = 0;
for (const f of files) bytesIn += fs.statSync(path.join(inDir, f)).size;
for (const f of kept) {
  const dst = path.join(outDir, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(inDir, f), dst);
  bytesOut += fs.statSync(dst).size;
}

/* ---------- 自检：启动必需的文件一个都不能少 ---------- */
const libs = new Set(['sap.ui.core']);
const bootLibs = readText('index.html').match(/data-sap-ui-libs="([^"]+)"/);
if (bootLibs) bootLibs[1].split(',').map(s => s.trim()).filter(Boolean).forEach(l => libs.add(l));
try {
  const deps = JSON.parse(readText('manifest.json'))['sap.ui5'].dependencies.libs;
  Object.keys(deps || {}).forEach(l => libs.add(l));
} catch (e) { /* manifest 没有依赖声明就只查启动库 */ }

const required = ['index.html', 'config.js', 'manifest.json', 'Component-preload.js', 'resources/sap-ui-core.js'];
for (const lib of libs) {
  const dir = 'resources/' + lib.replace(/\./g, '/');
  required.push(dir + '/library-preload.js');
  for (const t of themes) {
    const css = dir + '/themes/' + t + '/library.css';
    if (themedLibs.has(dir) && !fs.existsSync(path.join(inDir, css))) fail('dist 里没有主题 ' + t + '：' + css);
    if (themedLibs.has(dir)) required.push(css);
  }
}
const missing = required.filter(f => !fs.existsSync(path.join(outDir, f)));
if (missing.length) fail('精简包缺少必需文件:\n  ' + missing.join('\n  '));

/* ---------- 打 zip（文件直接放在 zip 根目录） ---------- */
let zipPath = '';
if (args.zip) {
  zipPath = outDir + '.zip';
  fs.rmSync(zipPath, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: outDir });
}

/* ---------- 汇总 ---------- */
const mb = n => (n / 1048576).toFixed(1) + ' MB';
console.log('部署精简包已生成');
console.log('  输入  ' + inDir + '  ' + files.length + ' 个文件, ' + mb(bytesIn));
console.log('  输出  ' + outDir + '  ' + kept.length + ' 个文件, ' + mb(bytesOut));
console.log('  保留主题  ' + [...keepThemes].join(', ') + '    检查过的库  ' + [...libs].join(', '));
console.log('  去掉:');
for (const [name] of RULES) if (removed[name]) console.log('    ' + String(removed[name]).padStart(5) + '  ' + name);
if (zipPath) console.log('  zip   ' + zipPath + '  ' + mb(fs.statSync(zipPath).size));
