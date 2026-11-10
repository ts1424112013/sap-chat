// 生成短片配乐（纯音乐，无人声、无音效）：node gen_music.mjs
// 稀疏钢琴 + 绵长弦乐铺底 + 柔和拨音，D 大调，每小节 4 秒，共 22 小节（88 秒）+ 尾音。
// 输出 music.wav，并用 Mac 自带的 afconvert 转成 music.m4a（页面播放用）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100, DUR = 93, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N), SL = new Float32Array(N), SRt = new Float32Array(N);
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const sm = (a, b, x) => { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const panG = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];

function put(i, s, gl, gr, send) {
  if (i < 0 || i >= N) return;
  const l = s * gl, r = s * gr;
  L[i] += l; R[i] += r; SL[i] += l * send; SRt[i] += r * send;
}

// 柔和的钢琴音：少量泛音，高泛音衰减更快
function piano(t0, m, vel, pan = 0) {
  const f0 = hz(m), i0 = Math.floor(t0 * SR), n = SR * 9, [gl, gr] = panG(pan);
  const base = 4.2 * Math.pow(60 / m, 1.2);
  for (let k = 1; k <= 7; k++) {
    const fk = k * f0 * Math.sqrt(1 + 0.0005 * k * k);
    if (fk > 9000) break;
    const a = (vel * 0.5) / Math.pow(k, 2.0), tau = base / Math.pow(k, 0.8), w = (2 * Math.PI * fk) / SR;
    for (let i = 0; i < n; i++) {
      const t = i / SR, env = Math.min(1, t / 0.012) * Math.exp(-t / tau);
      if (t > 1 && env < 1e-4) break;
      put(i0 + i, a * env * Math.sin(w * i), gl, gr, 0.6);
    }
  }
}

// 弦乐般的铺底：慢起慢落，两路微失谐
function pad(t0, dur, m, amp, pan = 0, att = 2.2, rel = 3.2) {
  const i0 = Math.floor(t0 * SR), n = Math.floor((dur + rel) * SR), [gl, gr] = panG(pan);
  const trP = rnd() * 6.28, trF = 0.15 + rnd() * 0.12;
  for (const cents of [-5, 5]) {
    const f0 = hz(m) * 2 ** (cents / 1200);
    for (let k = 1; k <= 4; k++) {
      const a = amp / 2 / Math.pow(k, 2.3), w = (2 * Math.PI * f0 * k) / SR, ph = rnd() * 6.28;
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = sm(0, att, t) * (1 - sm(dur, dur + rel, t)) * (1 + 0.08 * Math.sin(6.28 * trF * t + trP));
        put(i0 + i, a * env * Math.sin(w * i + ph), gl, gr, 0.7);
      }
    }
  }
}

function bass(t0, dur, m, amp) {
  const i0 = Math.floor(t0 * SR), n = Math.floor((dur + 2) * SR), w = (2 * Math.PI * hz(m)) / SR;
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = sm(0, 1.0, t) * (1 - sm(dur, dur + 2, t));
    put(i0 + i, amp * env * (Math.sin(w * i) + 0.25 * Math.sin(2 * w * i)), 0.707, 0.707, 0.25);
  }
}

function pluck(t0, m, amp, pan) {
  const i0 = Math.floor(t0 * SR), n = SR * 3, w = (2 * Math.PI * hz(m)) / SR, [gl, gr] = panG(pan);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / 0.006) * Math.exp(-t / 0.55);
    put(i0 + i, amp * env * (Math.sin(w * i) + 0.18 * Math.sin(3 * w * i)), gl, gr, 0.9);
  }
}

const CH = {
  D9: { p: [50, 57, 64, 66, 69], b: 38 }, G: { p: [55, 59, 62, 66], b: 43 }, Bm: { p: [59, 62, 66, 69], b: 47 },
  As: { p: [57, 62, 64, 69], b: 45 }, A: { p: [57, 61, 64, 69], b: 45 }, Fm: { p: [54, 57, 61, 64], b: 42 },
  DF: { p: [54, 57, 62, 66], b: 42 }, Em: { p: [52, 55, 59, 62, 66], b: 40 },
};
// [和弦, 铺底强度, 低音强度, 高八度弦乐强度]
const BARS = [
  ["D9", 0, 0, 0], ["D9", 0.15, 0, 0], ["G", 0.28, 0, 0],
  ["Bm", 0.45, 0, 0], ["G", 0.5, 0, 0], ["As", 0.55, 0, 0],
  ["D9", 0.65, 0.5, 0], ["Fm", 0.7, 0.6, 0], ["G", 0.78, 0.7, 0.2],
  ["Bm", 0.85, 0.8, 0.4], ["G", 0.92, 0.9, 0.6], ["DF", 1.0, 1.0, 0.9], ["A", 1.0, 1.0, 1.0], ["Bm", 0.95, 0.9, 0.7],
  ["G", 0.7, 0.6, 0.3], ["DF", 0.55, 0.45, 0.1], ["Em", 0.45, 0.35, 0],
  ["D9", 0.5, 0.4, 0], ["G", 0.45, 0.3, 0], ["D9", 0.4, 0.3, 0], ["D9", 0.3, 0.2, 0], ["D9", 0.15, 0, 0],
];
BARS.forEach(([c, lv, bl, hi], bi) => {
  const t0 = bi * 4, ch = CH[c];
  if (lv > 0) ch.p.forEach((m, j) => pad(t0 - 0.6, 4, m, 0.06 * lv, (j / (ch.p.length - 1)) * 1.2 - 0.6));
  if (bl > 0) bass(t0 - 0.3, 4, ch.b, 0.11 * bl);
  if (hi > 0) ch.p.slice(-2).forEach((m, j) => pad(t0 - 0.6, 4, m + 12, 0.035 * hi, j ? 0.5 : -0.5, 2.6, 3.6));
});

// 柔和拨音：只在「执行」段（36–56 秒），随音乐舒展渐强再收
const PAT = [0, 2, 1, 3, 2, 1, 3, 2];
for (let t = 36, k = 0; t < 56; t += 0.5, k++) {
  const ch = CH[BARS[Math.floor(t / 4)][0]].p;
  const amp = 0.02 + 0.06 * sm(36, 45, t) * (1 - sm(51, 56, t));
  pluck(t, ch[PAT[k % 8] % ch.length] + 12, amp, k % 2 ? 0.55 : -0.55);
}

// 钢琴旋律：[秒, 音高, 力度]
const MEL = [
  [1, 69, .5], [3, 78, .4], [5, 76, .4], [7, 74, .35], [9, 81, .5], [9, 62, .3], [10.5, 78, .3],
  [12, 71, .45], [13, 74, .4], [14, 78, .45], [16, 76, .4], [17, 74, .35], [18, 71, .4], [20, 69, .45], [21, 73, .4], [22, 76, .45], [23, 81, .35],
  [24, 78, .5], [25, 76, .4], [26, 74, .4], [27, 81, .5], [28, 73, .4], [29, 76, .4], [30, 81, .5], [31, 78, .4], [32, 83, .5], [33, 81, .45], [34, 78, .45], [35, 86, .5],
  [36, 78, .55], [36, 90, .4], [37, 86, .45], [38, 83, .45], [39, 81, .4], [39.5, 83, .4], [40, 86, .55], [41, 83, .45], [42, 79, .45], [43, 81, .45], [43.5, 83, .4],
  [44, 93, .55], [44, 81, .5], [45, 90, .5], [46, 86, .5], [47, 88, .5], [48, 88, .6], [48, 76, .45], [49, 85, .5], [50, 81, .5], [51, 85, .45], [51.5, 88, .4],
  [52, 90, .5], [52, 78, .45], [53, 86, .45], [54, 83, .4], [55, 81, .35],
  [56, 83, .4], [58, 79, .35], [60, 81, .4], [62, 78, .35], [64, 79, .35], [65, 76, .3], [66, 73, .3], [67, 76, .25],
  [68, 74, .5], [68, 78, .4], [68, 50, .4], [70, 81, .3], [72, 71, .35], [73, 74, .3], [74, 79, .3], [76, 78, .35], [78, 76, .3],
  [80, 74, .45], [80, 69, .35], [80, 62, .35], [80, 50, .35], [82, 81, .2], [84, 86, .18],
];
MEL.forEach(([t, m, v]) => piano(t, m, v, ((m - 74) / 24) * 0.6));

// 混响（Freeverb 结构）
function reverb(inp, spread) {
  const out = new Float32Array(N), fb = 0.93, damp = 0.28;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({ b: new Float32Array(n + spread), i: 0, s: 0 }));
  const aps = [556, 441, 341, 225].map((n) => ({ b: new Float32Array(n + spread), i: 0 }));
  for (let i = 0; i < N; i++) {
    const x = inp[i] * 0.03; let o = 0;
    for (const c of combs) { const y = c.b[c.i]; c.s = y * (1 - damp) + c.s * damp; c.b[c.i] = x + c.s * fb; if (++c.i >= c.b.length) c.i = 0; o += y; }
    for (const a of aps) { const bo = a.b[a.i]; const y = bo - o; a.b[a.i] = o + bo * 0.5; if (++a.i >= a.b.length) a.i = 0; o = y; }
    out[i] = o;
  }
  return out;
}
const WL = reverb(SL, 0), WR = reverb(SRt, 23);
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = 1 - sm(87, 92.5, i / SR);
  L[i] = (L[i] * 0.8 + WL[i] * 0.95) * fade; R[i] = (R[i] * 0.8 + WR[i] * 0.95) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = 0.89 / peak, buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4); }
const wav = path.join(dir, "music.wav"), m4a = path.join(dir, "music.m4a");
fs.writeFileSync(wav, buf);
try { execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "192000", wav, m4a]); console.log("已生成 music.m4a"); fs.unlinkSync(wav); }
catch { console.log("没有 afconvert（非 Mac），保留 music.wav；请自行转成 music.m4a"); }
console.log(`时长 ${DUR} 秒，峰值 ${peak.toFixed(3)}`);
