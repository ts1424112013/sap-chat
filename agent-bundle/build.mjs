/**
 * 打包：deepagents/browser + LangChain 依赖 → ../webapp/thirdparty/lingxi-agent/lingxi-agent.js
 * 一个文件、ES2020、IIFE，挂 window.LingxiAgent；不进 Component-preload，运行时按需加载。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "../webapp/thirdparty/lingxi-agent/lingxi-agent.js");
const shim = name => path.join(here, "shims", name);
const minify = !process.argv.includes("--dev");

// Node 内置模块：crypto 有浏览器实现；其余只在 Node 分支里被引用，换成空模块
const emptyNode = ["fs", "fs/promises", "path", "os", "child_process", "util", "url", "stream", "events", "process"];

const nodeShims = {
  name: "lingxi-node-shims",
  setup(b) {
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: shim("node-crypto.js") }));
    b.onResolve({ filter: /^(node:)?async_hooks$/ }, () => ({ path: shim("async-hooks.js") }));
    // LangChain 估 token 时会去公网下载编码表：直接失败，走它自带的按字数估算
    b.onLoad({ filter: /@langchain[\\/]core[\\/]dist[\\/]utils[\\/]tiktoken\.js$/ }, () => ({
      contents: `const no = async () => { throw new Error("tiktoken disabled in 灵犀"); };
export const getEncoding = no, encodingForModel = no, tiktoken_exports = { getEncoding: no, encodingForModel: no };`,
      loader: "js"
    }));
    const re = new RegExp("^(node:)?(" + emptyNode.map(s => s.replace("/", "\\/")).join("|") + ")$");
    b.onResolve({ filter: re }, a => ({ path: a.path, namespace: "lingxi-empty" }));
    b.onLoad({ filter: /.*/, namespace: "lingxi-empty" }, a => ({
      contents: `const m = new Proxy({}, { get(_, k) { if (k === "__esModule") return false; if (k === "default") return m; return () => { throw new Error("${"${a.path}"} 在浏览器里不可用: " + String(k)); }; } }); module.exports = m;`.replace("${a.path}", a.path),
      loader: "js"
    }));
  }
};

const res = await build({
  entryPoints: [path.join(here, "src/index.js")],
  outfile,
  bundle: true,
  format: "iife",
  globalName: "LingxiAgent",
  platform: "browser",
  target: ["es2020", "chrome100", "edge100"],
  conditions: ["browser", "import", "default"],
  mainFields: ["browser", "module", "main"],
  minify,
  sourcemap: minify ? false : "inline",
  legalComments: "eof",
  metafile: true,
  inject: [shim("process.js")],
  logLevel: "warning",
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.LANGSMITH_TRACING": '"false"',
    "process.env.LANGCHAIN_TRACING_V2": '"false"',
    "process.env.LANGSMITH_API_KEY": '""',
    "process.env.LANGCHAIN_API_KEY": '""',
    "process.env.OPENAI_API_KEY": '""'
  },
  banner: { js: `/* 灵犀浏览器 Agent 引擎 · deepagents ${JSON.parse(fs.readFileSync(path.join(here, "node_modules/deepagents/package.json"))).version} · 由 agent-bundle/build.mjs 生成，勿手改 */` },
  plugins: [nodeShims]
});

fs.writeFileSync(path.join(here, "meta.json"), JSON.stringify(res.metafile));
const size = fs.statSync(outfile).size;
console.log(`✔ ${path.relative(process.cwd(), outfile)}  ${(size / 1024).toFixed(0)} KB`);
