// 生成短片配乐（纯音乐，无人声、无音效）：node gen_music.mjs
// 稀疏钢琴 + 绵长弦乐铺底 + 柔和拨音，D 大调，每小节 4 秒，共 33 小节（132 秒）+ 尾音。
// 输出 music.wav，并用 Mac 自带的 afconvert 转成 music.m4a（页面播放用）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100, DUR = 134, N = SR * DUR;
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
// [和弦, 铺底强度, 低音强度, 高八度弦乐强度]；八段画面：0 / 16 / 30 / 46 / 60 / 76 / 94 / 110 秒
const BARS = [
  ["D9", 0, 0, 0], ["D9", 0.15, 0, 0], ["G", 0.25, 0, 0], ["As", 0.3, 0, 0],
  ["Bm", 0.4, 0, 0], ["G", 0.45, 0, 0], ["D9", 0.5, 0, 0], ["As", 0.5, 0, 0],
  ["D9", 0.55, 0.3, 0], ["Fm", 0.6, 0.4, 0], ["G", 0.6, 0.4, 0], ["A", 0.65, 0.5, 0],
  ["Bm", 0.7, 0.6, 0], ["G", 0.7, 0.6, 0], ["As", 0.75, 0.7, 0.2],
  ["D9", 0.85, 0.8, 0.4], ["Fm", 0.9, 0.9, 0.5], ["G", 0.95, 0.9, 0.7], ["A", 1, 1, 0.9],
  ["Bm", 1, 1, 1], ["G", 1, 1, 0.9], ["DF", 1, 1, 1], ["A", 1, 1, 1], ["D9", 0.95, 0.9, 0.8],
  ["G", 0.9, 0.8, 0.6], ["DF", 0.85, 0.8, 0.5], ["Em", 0.8, 0.7, 0.4], ["A", 0.7, 0.6, 0.2],
  ["D9", 0.6, 0.5, 0], ["G", 0.5, 0.4, 0], ["D9", 0.45, 0.3, 0], ["D9", 0.3, 0.2, 0], ["D9", 0.15, 0, 0],
];
BARS.forEach(([c, lv, bl, hi], bi) => {
  const t0 = bi * 4, ch = CH[c];
  if (lv > 0) ch.p.forEach((m, j) => pad(t0 - 0.6, 4, m, 0.06 * lv, (j / (ch.p.length - 1)) * 1.2 - 0.6));
  if (bl > 0) bass(t0 - 0.3, 4, ch.b, 0.11 * bl);
  if (hi > 0) ch.p.slice(-2).forEach((m, j) => pad(t0 - 0.6, 4, m + 12, 0.035 * hi, j ? 0.5 : -0.5, 2.6, 3.6));
});

// 柔和拨音：记录返回到 Excel 成形（60–108 秒），渐强再收
const PAT = [0, 2, 1, 3, 2, 1, 3, 2];
for (let t = 60, k = 0; t < 108; t += 0.5, k++) {
  const ch = CH[BARS[Math.floor(t / 4)][0]].p;
  const amp = 0.02 + 0.06 * sm(60, 76, t) * (1 - sm(96, 108, t));
  pluck(t, ch[PAT[k % 8] % ch.length] + 12, amp, k % 2 ? 0.55 : -0.55);
}

// 钢琴旋律：按每小节的和弦音走一条起伏的线，强度越高音越密、音区越高
const CONT = [2, 4, 3, 5, 4, 6, 5, 3, 4, 2, 3, 1, 2, 4, 5, 3];
const MEL = [];
BARS.forEach(([c, lv], bi) => {
  if (bi >= 28) return;
  const t0 = bi * 4, tones = []; for (let o = 0; o < 3; o++) CH[c].p.forEach((m) => tones.push(((m - 62) % 12 + 12) % 12 + 62 + o * 12));
  tones.sort((a, b) => a - b);
  const reg = Math.round(lv * 5), n = lv < 0.35 ? 2 : 4, vel = 0.3 + 0.25 * lv;
  for (let j = 0; j < n; j++) { const m = tones[Math.min(tones.length - 1, CONT[(bi * 3 + j * 5) % 16] + reg)]; MEL.push([t0 + j * (4 / n), m, vel * (j ? 0.85 : 1)]); }
  if (lv >= 0.85) { MEL.push([t0, tones[Math.min(tones.length - 1, CONT[(bi * 3) % 16] + reg)] - 12, vel * 0.8]); MEL.push([t0 + 3.5, tones[Math.min(tones.length - 1, CONT[(bi * 3 + 7) % 16] + reg)], vel * 0.7]); }
});
// 几个画面节点上的单音：发送（6 秒）、提交执行（46 秒）、得出结论（92 秒）；结尾收在主和弦
MEL.push([6, 81, 0.5], [6, 62, 0.3], [46, 85, 0.5], [46, 57, 0.35], [92, 86, 0.55], [92, 74, 0.5], [92, 50, 0.45]);
MEL.push([112, 74, 0.5], [112, 78, 0.4], [112, 50, 0.4], [114, 81, 0.3], [116, 71, 0.35], [117, 74, 0.3], [118, 79, 0.3], [120, 78, 0.4], [120, 50, 0.35], [122, 76, 0.3],
  [124, 74, 0.45], [124, 69, 0.35], [124, 62, 0.35], [124, 50, 0.35], [126, 81, 0.2], [128, 86, 0.18]);
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
  const fade = 1 - sm(127, 133.5, i / SR);
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
