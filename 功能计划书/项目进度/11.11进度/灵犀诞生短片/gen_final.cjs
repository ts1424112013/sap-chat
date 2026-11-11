// 完整版音轨：原配乐 130 秒不剪，只在两段鼓点里按 K 线卡点的方式加重音，输出 WAV 和 final-beats.js。
// 用法（macOS）：
//   afconvert -f WAVE -d LEI16@44100 -c 1 "../../11.10进度/灵犀品牌短片/music.m4a" /tmp/lingxi-source.wav
//   node gen_final.cjs /tmp/lingxi-source.wav /tmp/lingxi-final.wav && afconvert -f m4af -d aac -b 192000 /tmp/lingxi-final.wav music-final.m4a
const fs = require("fs"); const b = fs.readFileSync(process.argv[2]); const o = b.indexOf("data") + 8, sr = 44100, N = (b.length - o) >> 1; const x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = b.readInt16LE(o + i * 2) / 32768;
const beat = (k) => 0.0946 + 0.53141 * k, sm = (a, c, v) => { v = Math.min(1, Math.max(0, (v - a) / (c - a))); return v * v * (3 - 2 * v); };   // 原曲第 k 拍；鼓点进入的 17.10 秒是第 32 拍
// 成长段：第 j 记在第 32 + 2j 拍（j=0…56）。j=54、55 是进门前抽掉的那一小节；j=56（76.62 秒，原曲鼓点退场前最后一个小节第一拍）走进 SAP，最重。
// 收束段：第 i 记在第 176 + 2i 拍（i=0…24）。i=0（93.62 秒）鼓点回来；i=22（117.01 秒）「灵犀」亮起。
const MG = { 0: 1, 2: 0.9, 8: 0.85, 16: 1, 22: 1, 28: 0.95, 38: 0.85, 50: 0.95, 52: 0.85, 56: 1.3 }, FG = { 0: 1, 8: 0.9, 22: 1.25 };
const mid = [], fin = []; for (let j = 0; j <= 56; j++) mid.push({ j, t: +beat(32 + 2 * j).toFixed(4), heavy: j % 2 ? 0 : 1, mute: j === 54 || j === 55 ? 1 : 0, g: MG[j] ?? (j % 2 ? 0.8 : 0.74) });
for (let i = 0; i <= 24; i++) fin.push({ i, t: +beat(176 + 2 * i).toFixed(4), heavy: i % 2 ? 0 : 1, mute: 0, g: FG[i] ?? (i % 2 ? 0.8 : 0.74) });
const calm = [146, 150, 154, 158, 162, 166, 170].map((k) => +beat(k).toFixed(4));   // 安静段里原曲自己的几个重音
const T54 = mid[54].t, T56 = mid[56].t, y = new Float32Array(N);
for (let i = 0; i < N; i++) { const t = i / sr; let g = 0.8 + (0.74 - 0.8) * sm(16.6, 17.1, t) + 0.06 * sm(T56 + 0.6, T56 + 2, t) - 0.06 * sm(93.1, 93.6, t);
  g *= 1 - 0.74 * sm(T54 - 0.12, T54 + 0.05, t) * (t < T56 ? 1 : 0);                                         // 进门前：把音乐压下去一整小节
  y[i] = x[i] * g; }
let seed = 7, pn = 0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
function hit(t, g, heavy, big, gap) { const s = Math.round(t * sr); let ph = 0;
  if (gap) { const pre = Math.round(gap * sr); for (let i = 0; i < pre; i++) { const u = i / pre; y[s - pre + i] *= 1 - 0.7 * u * u; } }
  for (let i = 0; i < Math.round((big ? 1.4 : 0.8) * sr) && s + i < N; i++) { const u = i / sr, f = heavy ? 46 + 130 * Math.exp(-u * 26) : 70 + 150 * Math.exp(-u * 40); ph += 2 * Math.PI * f / sr;
    const body = Math.sin(ph) * Math.exp(-u * (big ? 3.4 : heavy ? 6 : 16)) * (1 - Math.exp(-u * 2500)), knock = Math.sin(2 * Math.PI * (heavy ? 1750 : 2300) * u) * Math.exp(-u * 190) * (heavy ? 0.38 : 0.55), nz = rnd(), click = (nz - pn) * Math.exp(-u * (big ? 9 : 600)) * (big ? 0.5 : 0.45); pn = nz;
    y[s + i] = y[s + i] * (1 - (heavy ? 0.68 : 0.3) * Math.exp(-u * (heavy ? 9 : 22))) + g * ((heavy ? 0.86 : 0.6) * body + knock + 0.2 * click); } }
for (const a of mid) if (!a.mute) hit(a.t, a.g, a.heavy, a.j === 56, a.j === 0 ? 0.2 : 0);
for (const a of fin) hit(a.t, a.g, a.heavy, a.i === 22, a.i === 22 ? 0.25 : 0);
const w = Buffer.alloc(44 + N * 2); w.write("RIFF", 0); w.writeUInt32LE(36 + N * 2, 4); w.write("WAVEfmt ", 8); w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(1, 22); w.writeUInt32LE(sr, 24); w.writeUInt32LE(sr * 2, 28); w.writeUInt16LE(2, 32); w.writeUInt16LE(16, 34); w.write("data", 36); w.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) w.writeInt16LE(Math.round(Math.max(-1, Math.min(1, Math.tanh(y[i] * 1.15) / Math.tanh(1.15) * 0.94)) * 32767), 44 + i * 2);
fs.writeFileSync(process.argv[3], w);
const strip = (a) => a.map(({ g, ...r }) => r);
fs.writeFileSync("final-beats.js", `// 完整版每一记重音的时刻（片中秒），由 gen_final.cjs 生成，画面和声音共用。mid：成长段；fin：收束段；calm：安静段里原曲自己的重音。heavy=1 小节第一拍的底鼓，0 小节中间的轻敲；mute=1 是进门前抽掉的那一小节。\nconst FINAL_BEATS = ${JSON.stringify({ mid: strip(mid), fin: strip(fin), calm, length: +(N / sr).toFixed(2) })};\n`);
const rms = (a, c) => { let q = 0; const p = Math.round(a * sr), e = Math.round(c * sr); for (let i = p; i < e; i++) q += (w.readInt16LE(44 + i * 2) / 32768) ** 2; return Math.sqrt(q / (e - p)); }, db = (v) => (20 * Math.log10(v + 1e-6)).toFixed(1);
console.log("length", (N / sr).toFixed(2), " door", T56, " mid accents", mid.length, " fin accents", fin.length);
let s2 = ""; for (let t = 0; t < N / sr - 5; t += 10) s2 += t + "s:" + db(rms(t, t + 10)) + " "; console.log("level per 10s (dB):", s2); console.log("the muted bar:", db(rms(T54 + 0.1, T56 - 0.3)), "dB;  door hit jump:", (20 * Math.log10(rms(T56, T56 + 0.04) / rms(T56 - 0.3, T56 - 0.01))).toFixed(0), "dB");
