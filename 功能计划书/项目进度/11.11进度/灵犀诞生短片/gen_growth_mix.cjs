// 取 44.1 kHz、16 位、单声道原配乐 WAV，加强三块名字牌和六个工具的重拍。
const fs = require("node:fs");
const { names, tools } = require("./growth-beats.js");
const source = fs.readFileSync(process.argv[2]);
const rate = 44100;
let pos = 12;
let formatOK = false;
while (pos + 8 <= source.length) {
  const tag = source.toString("ascii", pos, pos + 4);
  if (tag === "data") break;
  const size = source.readUInt32LE(pos + 4);
  if (tag === "fmt " && size >= 16) {
    const encoding = source.readUInt16LE(pos + 8);
    const pcm = encoding === 1 || (encoding === 0xfffe && size >= 40 && source.readUInt32LE(pos + 32) === 1);
    formatOK = pcm && source.readUInt16LE(pos + 10) === 1
      && source.readUInt32LE(pos + 12) === rate && source.readUInt16LE(pos + 22) === 16;
  }
  pos += 8 + size + (size % 2);
}
if (!formatOK || pos + 8 > source.length) throw new Error("需要 44.1 kHz、16 位、单声道 PCM WAV");

const start = pos + 8;
const samples = source.readUInt32LE(pos + 4) / 2;
// 给重音留出响度余量，避免 AAC 编码后的峰值顶到上限。
for (let i = 0; i < samples; i++) {
  const offset = start + i * 2;
  source.writeInt16LE(Math.round(source.readInt16LE(offset) * 0.82), offset);
}
const accents = [...names.map((at, i) => [at, [0.62, 0.66, 0.78][i]]), ...tools.map((at, i) => [at, i % 2 ? 0.44 : 0.6])];   // [时刻, 力度]
accents.forEach(([at, gain]) => {
  const onset = Math.round(at * rate);
  const lead = Math.round(0.105 * rate);
  const tail = Math.round(0.38 * rate);
  let phase = 0;
  for (let k = -lead; k < tail; k++) {
    if (onset + k < 0 || onset + k >= samples) continue;
    const offset = start + (onset + k) * 2;
    const raw = source.readInt16LE(offset) / 32768;
    let value;
    if (k < 0) {
      const approach = (k + lead) / lead;
      value = raw * (1 - 0.77 * approach * approach * (3 - 2 * approach));
    } else {
      const t = k / rate;
      phase += 2 * Math.PI * (52 + 92 * Math.exp(-t * 33)) / rate;
      const kick = Math.sin(phase) * Math.exp(-t * 13);
      const tap = Math.sin(2 * Math.PI * 1100 * t) * Math.exp(-t * 95);
      const accent = gain * (kick + 0.29 * tap) * (1 - Math.exp(-t * 5500));
      value = raw * (1 - 0.77 * Math.exp(-t * 12)) + accent * Math.min(1, (tail - k) / 1200);
    }
    source.writeInt16LE(Math.round(Math.max(-0.94, Math.min(0.94, value)) * 32767), offset);
  }
});
fs.writeFileSync(process.argv[3], source);
