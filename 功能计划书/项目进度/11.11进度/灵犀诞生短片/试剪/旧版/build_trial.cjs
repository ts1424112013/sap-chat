// 用法：afconvert -f WAVE -d LEI16@44100 -c 1 ../music.m4a /tmp/lingxi-source.wav
// 然后：node build_trial.cjs /tmp/lingxi-source.wav trial.wav
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2]);
const sampleRate = 44100;
let offset = 12;
while (offset + 8 <= source.length && source.toString("ascii", offset, offset + 4) !== "data") {
  const size = source.readUInt32LE(offset + 4);
  offset += 8 + size + (size % 2);
}
if (offset + 8 > source.length) throw new Error("源文件需要是 44.1 kHz 单声道 PCM WAV");
const sourceSize = source.readUInt32LE(offset + 4);
offset += 8;
const start = Math.round(29.8 * sampleRate);
const length = Math.round(16.8 * sampleRate);
if ((start + length) * 2 > sourceSize) throw new Error("源音轨太短");

const beat = (n) => 0.0946 - 29.8 + 0.53141 * n;
const accents = [6.964, 9.088, 13.338]; // 托住、合表、交付
const mix = new Float64Array(length);
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const fade = (from, to, t) => smooth((t - from) / (to - from));
let low = 0, middle = 0;
const lowCoef = 1 - Math.exp(-2 * Math.PI * 170 / sampleRate);
const midCoef = 1 - Math.exp(-2 * Math.PI * 2100 / sampleRate);

// 保留原曲，前后收掉低频与尖锐打击声。乐句让位的地方压低整个底轨。
for (let i = 0; i < length; i++) {
  const t = i / sampleRate;
  const sample = source.readInt16LE(offset + (start + i) * 2) / 32768;
  low += lowCoef * (sample - low);
  middle += midCoef * (sample - middle);
  const drive = fade(1.5, 3.6, t) * (1 - fade(13.35, 13.85, t));
  let gain = 0.59 * fade(0, 0.23, t) * (1 - fade(15.35, 16.75, t));
  for (const [at, width, floor] of [[6.964, 0.31, 0.08], [9.088, 0.11, 0.55], [13.338, 0.38, 0.04]]) {
    gain *= 1 - (1 - floor) * fade(at - width, at - 0.035, t) * (1 - fade(at + 0.03, at + 0.25, t));
  }
  mix[i] = gain * (low * (0.13 + 0.54 * drive) + (middle - low) * (0.72 + 0.28 * drive) + (sample - middle) * (0.07 + 0.63 * drive));
}

let seed = 1471;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296 * 2 - 1;
};
function drum(at, kind, gain) {
  const index = Math.round(at * sampleRate);
  const duration = kind === "impact" ? 0.82 : kind === "kick" ? 0.31 : 0.21;
  let phase = 0, previous = 0;
  for (let i = 0; i < duration * sampleRate && index + i < length; i++) {
    const t = i / sampleRate;
    const raw = noise(), high = raw - previous;
    previous = raw;
    phase += 2 * Math.PI * (49 + 115 * Math.exp(-t * 32)) / sampleRate;
    const kick = (Math.sin(phase) + 0.27 * Math.sin(phase * 2)) * Math.exp(-t * (kind === "impact" ? 7 : 15));
    const snap = high * (Math.exp(-t * 58) + (t > 0.021 ? 0.42 * Math.exp(-(t - 0.021) * 45) : 0));
    const note = (Math.sin(2 * Math.PI * 147 * t) + 0.42 * Math.sin(2 * Math.PI * 294 * t)) * Math.exp(-t * 5.5);
    let value;
    if (kind === "impact") value = 0.78 * kick + 0.24 * snap + 0.22 * note;
    else if (kind === "kick") value = 0.92 * kick + 0.08 * snap;
    else if (kind === "clap") value = snap * 0.6 + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 38) * 0.36;
    else value = high * Math.exp(-t * 80) * 0.63;
    mix[index + i] += gain * value * (1 - Math.exp(-t * 4200));
  }
}

// 脚步是弱拍。对齐记录之后打击乐加密。结尾最后一记落下，只剩余音。
for (const [n, g] of [[61, 0.22], [63, 0.36], [65, 0.31], [67, 0.38], [70, 0.33], [71, 0.38], [72, 0.40], [75, 0.46], [77, 0.55], [79, 0.43]]) drum(beat(n), "kick", g);
for (const n of [64, 66, 70, 72, 74, 76, 78, 79.5]) drum(beat(n), "clap", n >= 74 ? 0.28 : 0.17);
for (const n of [63.5, 64.5, 65.5, 66.5, 70.5, 71.5, 72.5, 74, 74.5, 75, 75.5, 76, 76.5, 77, 77.5, 78, 78.5, 79, 79.5, 80]) drum(beat(n), "tick", n >= 74 ? 0.14 : 0.08);
accents.forEach((time, i) => drum(time, "impact", [0.88, 0.78, 1.03][i]));

const out = Buffer.alloc(44 + length * 2);
out.write("RIFF", 0);
out.writeUInt32LE(36 + length * 2, 4);
out.write("WAVEfmt ", 8);
out.writeUInt32LE(16, 16);
out.writeUInt16LE(1, 20);
out.writeUInt16LE(1, 22);
out.writeUInt32LE(sampleRate, 24);
out.writeUInt32LE(sampleRate * 2, 28);
out.writeUInt16LE(2, 32);
out.writeUInt16LE(16, 34);
out.write("data", 36);
out.writeUInt32LE(length * 2, 40);
let peak = 0;
for (let i = 0; i < length; i++) {
  const value = Math.tanh(mix[i] * 1.22) * 0.96;
  peak = Math.max(peak, Math.abs(value));
  out.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
}
fs.writeFileSync(process.argv[3], out);
console.log(`${(length / sampleRate).toFixed(2)}s, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
