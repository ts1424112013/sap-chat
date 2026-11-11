// 重剪版音轨：静下来 → 一步步长起来 → 再静下来。从原配乐（44.1 kHz、16 位、单声道 WAV）重新编排，输出 WAV 和 cut-beats.js。
// 用法（macOS）：
//   afconvert -f WAVE -d LEI16@44100 -c 1 "../../11.10进度/灵犀品牌短片/music.m4a" /tmp/lingxi-source.wav
//   node gen_cut.cjs /tmp/lingxi-source.wav /tmp/lingxi-cut.wav && afconvert -f m4af -d aac -b 192000 /tmp/lingxi-cut.wav music-cut.m4a
const fs = require("fs"); const b = fs.readFileSync(process.argv[2]); const o = b.indexOf("data") + 8, sr = 44100, n = (b.length - o) >> 1; const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + i * 2) / 32768;
const beat = (k) => 0.0946 + 0.53141 * k;                     // 原曲第 k 拍；鼓点进入的 17.10 秒是第 32 拍，小节第一拍是 4 的倍数
const lowpass = (v, hz) => { const a = 1 - Math.exp(-2 * Math.PI * hz / sr), out = new Float32Array(v.length); let y = 0, y2 = 0; for (let i = 0; i < v.length; i++) { y += a * (v[i] - y); y2 += a * (y - y2); out[i] = y2; } return out; };
const highpass = (v, hz) => { const lp = lowpass(v, hz), out = new Float32Array(v.length); for (let i = 0; i < v.length; i++) out[i] = v[i] - lp[i]; return out; };
const xs = lowpass(x, 4500), xh = highpass(x, 140), xsh = highpass(xs, 140);          // 柔化的（开头用）、去掉低频的（收尾用）、两者都做的（最后的旋律用）
// 编排（片中秒 ← 原曲秒）：开头 0–17.10；中段前六小节 17.10–29.85；跳到原曲第 92 拍接着走，让「走进 SAP」落在鼓点退场前最后一个小节第一拍；
// 之后顺着原曲进入安静段；最后接回开头的旋律。
const T_SPLICE = beat(56), O_SPLICE = beat(92), T_DOOR = beat(108), T_REPRISE = T_SPLICE + (93.60 - O_SPLICE), O_REPRISE = 0.62, LEN = T_REPRISE + 16.4;
const N = Math.round(LEN * sr), y = new Float32Array(N), sm = (a, c, v) => { v = Math.min(1, Math.max(0, (v - a) / (c - a))); return v * v * (3 - 2 * v); };
for (let i = 0; i < N; i++) { const t = i / sr; let v;
  if (t < T_SPLICE) { const k = sm(16.6, 17.1, t), q = i; v = (xs[q] * 0.62 * (1 - k) + x[q] * 0.74 * k) * sm(0, 1.6, t); }                       // 开头：柔化；到第一记重拍前换回原声
  else if (t < T_REPRISE + 0.6) { const q = Math.round((t - T_SPLICE + O_SPLICE) * sr), k = sm(T_DOOR + 0.7, T_DOOR + 2.2, t); v = x[q] * 0.74 * (1 - k) + xh[q] * 0.74 * k;      // 中段；高潮之后撤掉低频
    if (t < T_SPLICE + 0.03) { const f = (t - T_SPLICE) / 0.03, p = x[i] * 0.74; v = p * Math.cos(f * Math.PI / 2) + v * Math.sin(f * Math.PI / 2); }
    if (t > T_REPRISE) { const f = (t - T_REPRISE) / 0.6, r = xsh[Math.round((t - T_REPRISE + O_REPRISE) * sr)] * 0.74; v = v * Math.cos(f * Math.PI / 2) + r * Math.sin(f * Math.PI / 2); } }
  else v = xsh[Math.round((t - T_REPRISE + O_REPRISE) * sr)] * 0.74;                                                                               // 最后：开头的旋律，去掉低频
  y[i] = v * (1 - sm(LEN - 3.6, LEN - 0.05, t)); }
// 重音：第 j 记落在第 32 + 2j 拍。偶数是小节第一拍（底鼓），奇数是小节中间（轻敲）。j=36、37 是进门前抽掉的那一小节，不出声；j=38 走进 SAP，最重。
const GAIN = { 0: 1, 2: 0.9, 8: 0.85, 16: 1, 22: 1, 30: 0.95, 34: 0.8, 38: 1.3 }, out = [];
let seed = 7, pn = 0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
for (let j = 0; j <= 38; j++) { const heavy = j % 2 === 0, mute = j === 36 || j === 37, t = beat(32 + 2 * j), s = Math.round(t * sr); out.push({ j, t: +t.toFixed(4), heavy: heavy ? 1 : 0, mute: mute ? 1 : 0 }); if (mute) continue;
  const g = GAIN[j] ?? (heavy ? 0.74 : 0.8), big = j === 38; let ph = 0;
  if (j === 0 || big) { const pre = Math.round((big ? 1.06 : 0.2) * sr); for (let i = 0; i < pre; i++) { const u = i / pre; y[s - pre + i] *= 1 - (big ? 0.86 : 0.7) * Math.min(1, u * (big ? 4 : 1)) ** 2; } }   // 落拍前抽掉一口；进门前抽掉整整两拍
  for (let i = 0; i < Math.round((big ? 1.4 : 0.8) * sr) && s + i < N; i++) { const u = i / sr, f = heavy ? 46 + 130 * Math.exp(-u * 26) : 70 + 150 * Math.exp(-u * 40); ph += 2 * Math.PI * f / sr;
    const body = Math.sin(ph) * Math.exp(-u * (big ? 3.4 : heavy ? 6 : 16)) * (1 - Math.exp(-u * 2500)), knock = Math.sin(2 * Math.PI * (heavy ? 1750 : 2300) * u) * Math.exp(-u * 190) * (heavy ? 0.38 : 0.55), nz = rnd(), click = (nz - pn) * Math.exp(-u * (big ? 9 : 600)) * (big ? 0.5 : 0.45); pn = nz;
    y[s + i] = y[s + i] * (1 - (heavy ? 0.68 : 0.3) * Math.exp(-u * (heavy ? 9 : 22))) + g * ((heavy ? 0.86 : 0.6) * body + knock + 0.2 * click); } }
const w = Buffer.alloc(44 + N * 2); w.write("RIFF", 0); w.writeUInt32LE(36 + N * 2, 4); w.write("WAVEfmt ", 8); w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(1, 22); w.writeUInt32LE(sr, 24); w.writeUInt32LE(sr * 2, 28); w.writeUInt16LE(2, 32); w.writeUInt16LE(16, 34); w.write("data", 36); w.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) w.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Math.tanh(y[i] * 1.15) / Math.tanh(1.15) * 0.94)) * 32767), 44 + i * 2);
fs.writeFileSync(process.argv[3], w);
fs.writeFileSync("cut-beats.js", `// 重剪版每一记重音的时刻（片中秒），由 gen_cut.cjs 生成，画面和声音共用。heavy=1 小节第一拍的底鼓，0 小节中间的轻敲；mute=1 是进门前抽掉的那一小节（不出声）。\nconst CUT_BEATS = ${JSON.stringify(out)};\nconst CUT_MARKS = ${JSON.stringify({ splice: +T_SPLICE.toFixed(3), door: +T_DOOR.toFixed(3), reprise: +T_REPRISE.toFixed(3), length: +LEN.toFixed(2) })};\n`);
const rms = (a, c) => { let q = 0; const p = Math.round(a * sr), e = Math.round(c * sr); for (let i = p; i < e; i++) q += (w.readInt16LE(44 + i * 2) / 32768) ** 2; return Math.sqrt(q / (e - p)); }, db = (v) => (20 * Math.log10(v + 1e-6)).toFixed(1);
console.log("length", LEN.toFixed(2), "splice", T_SPLICE.toFixed(3), "door", T_DOOR.toFixed(3), "reprise", T_REPRISE.toFixed(3));
console.log("accent jumps (dB):", out.filter((a) => !a.mute).map((a) => a.j + ":" + (20 * Math.log10(rms(a.t, a.t + 0.04) / rms(a.t - 0.06, a.t - 0.01))).toFixed(0)).join(" "));
let s2 = ""; for (let t = 0; t < LEN; t += 5) s2 += t + "s:" + db(rms(t, Math.min(LEN, t + 5))) + " "; console.log("level per 5s (dB):", s2);
