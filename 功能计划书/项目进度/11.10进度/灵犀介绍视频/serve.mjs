// 本地预览：node serve.mjs [端口]，浏览器打开 http://localhost:8092/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8092);
const types = { ".html": "text/html; charset=utf-8", ".m4a": "audio/mp4", ".json": "application/json", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  const file = path.join(dir, rel);
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  const data = fs.readFileSync(file);
  const type = types[path.extname(file)] || "application/octet-stream";
  // 音频支持 Range（浏览器拖动 / 跳段时需要）
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : data.length - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${data.length}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    return res.end(data.subarray(start, end + 1));
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": data.length });
  res.end(data);
}).listen(port, () => console.log(`灵犀介绍视频：http://localhost:${port}/`));
