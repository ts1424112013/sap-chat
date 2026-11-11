// 试剪音轨：从原配乐里剪出 29.80–46.60 秒，按 K 线卡点的方式加重音——每小节第一拍一记底鼓，小节中间一记轻敲，每一下对应画面里的一个动作。
// 用法（需要 macOS 的 afconvert）：
//   afconvert -f WAVE -d LEI16@44100 -c 1 "../../../11.10进度/灵犀品牌短片/music.m4a" /tmp/lingxi-source.wav && node build_trial.cjs /tmp/lingxi-source.wav hits.json trial.wav
const fs = require("fs"); const b = fs.readFileSync(process.argv[2]); const o = b.indexOf("data") + 8, sr = 44100, n = (b.length - o) >> 1; const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + i * 2) / 32768;
const { H } = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const S0 = 29.80, S1 = 46.60, beat = (k) => 0.0946 + 0.53141 * k;                 // 实测拍子网格；鼓点进入的 17.10 秒是第 32 拍，所以小节第一拍是 4 的倍数
const near = (k) => { let best = null; for (const [t] of H) if (Math.abs(t - beat(k)) < 0.03 && (best === null || Math.abs(t - beat(k)) < Math.abs(best - beat(k)))) best = t; return best ?? beat(k); };   // 对到原曲在这一拍的实际起音
// [第几拍, 力度, 落拍前是否抽掉一口]
const ACC = [[60, 0.72, 0], [62, 0.8, 0], [64, 0.8, 0], [66, 0.8, 0], [68, 1, 1], [70, 0.85, 0], [72, 0.8, 0], [74, 0.9, 0], [76, 0.85, 0], [78, 0.85, 0], [80, 1, 1], [82, 0.8, 0], [84, 0.62, 0]];
const N = Math.round((S1 - S0) * sr), y = new Float32Array(N), i0 = Math.round(S0 * sr);
for (let i = 0; i < N; i++) { const t = i / sr; let g = 0.76 * Math.min(1, t / 0.25); const tail = (S1 - S0) - t; if (tail < 1.3) { const k = tail / 1.3; g *= k * k * (3 - 2 * k); } y[i] = x[i0 + i] * g; }
let seed = 7, pn = 0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
const out = [];
for (const [k, g, gap] of ACC) { const heavy = k % 4 === 0, t = near(k), s = Math.round((t - S0) * sr); let ph = 0; out.push({ k, t: +(t - S0).toFixed(4), heavy: heavy ? 1 : 0 });
  if (gap) { const pre = Math.round(0.17 * sr); for (let i = 0; i < pre; i++) { const u = i / pre; y[s - pre + i] *= 1 - 0.72 * u * u; } }
  for (let i = 0; i < Math.round(0.8 * sr) && s + i < N; i++) { const u = i / sr, f = heavy ? 46 + 130 * Math.exp(-u * 26) : 70 + 150 * Math.exp(-u * 40); ph += 2 * Math.PI * f / sr;
    const body = Math.sin(ph) * Math.exp(-u * (heavy ? 6 : 16)) * (1 - Math.exp(-u * 2500)), knock = Math.sin(2 * Math.PI * (heavy ? 1750 : 2300) * u) * Math.exp(-u * 190) * (heavy ? 0.38 : 0.55), nz = rnd(), click = (nz - pn) * Math.exp(-u * 600) * 0.45; pn = nz;
    y[s + i] = y[s + i] * (1 - (heavy ? 0.68 : 0.3) * Math.exp(-u * (heavy ? 9 : 22))) + g * ((heavy ? 0.86 : 0.6) * body + knock + 0.2 * click); } }
const w = Buffer.alloc(44 + N * 2); w.write("RIFF", 0); w.writeUInt32LE(36 + N * 2, 4); w.write("WAVEfmt ", 8); w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(1, 22); w.writeUInt32LE(sr, 24); w.writeUInt32LE(sr * 2, 28); w.writeUInt16LE(2, 32); w.writeUInt16LE(16, 34); w.write("data", 36); w.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) w.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Math.tanh(y[i] * 1.15) / Math.tanh(1.15))) * 32767), 44 + i * 2);
fs.writeFileSync(process.argv[4], w);
fs.writeFileSync("trial-beats.js", "// 试剪音轨里每一记重音的时刻（秒）。由 build_trial.cjs 生成，画面和声音共用这一份。heavy=1 是小节第一拍的底鼓，0 是小节中间的轻敲。\nconst TRIAL_BEATS = " + JSON.stringify(out) + ";\n");
const rms = (a, c) => { let q = 0; const p = Math.round(a * sr), e = Math.round(c * sr); for (let i = p; i < e; i++) q += (w.readInt16LE(44 + i * 2) / 32768) ** 2; return Math.sqrt(q / (e - p)); }, db = (v) => (20 * Math.log10(v + 1e-6)).toFixed(1);
for (const a of out) console.log("beat", a.k, a.heavy ? "底鼓" : "轻敲", "at", a.t.toFixed(3), " level", db(rms(a.t - 0.06, a.t - 0.01)), "→", db(rms(a.t, a.t + 0.04)), "dB");
