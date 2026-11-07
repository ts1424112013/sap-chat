# 灵犀浏览器 Agent 引擎（打包工程）

把 [Deep Agents](https://github.com/langchain-ai/deepagentsjs) 的浏览器入口和依赖打成一个文件
`webapp/thirdparty/lingxi-agent/lingxi-agent.js`（挂 `window.LingxiAgent`），随灵犀 BSP 一起发布。
员工电脑不用装任何东西；本目录只在开发机上用。

## 命令

```bash
npm ci          # 首次，版本全部锁死在 package-lock.json
npm run build   # 生成 webapp/thirdparty/lingxi-agent/lingxi-agent.js（约 2.6 MB）
node test/mock-sap.mjs 8091   # 模拟 SAP + 剧本模型，浏览器打开 http://localhost:8091/poc.html 点「运行」
```

## 结构

| 文件 | 作用 |
|---|---|
| `src/index.js` | `LingxiAgent.run()`：向 SAP 要运行号 → 建 Deep Agent → 流式执行 → 回写 SAP |
| `src/sap-client.js` | 调 SAP `/sap/bc/zai_agent`（run/start、chat/completions、tools/exec、run/finish） |
| `src/folder-backend.js` | 文件夹后端：文件工具接到用户选的文件夹；改前确认、自动备份、修改记录、撤回 |
| `shims/` | 浏览器替身：`node:crypto`（sha256）、`node:async_hooks`、`process` |
| `test/` | 模拟 SAP 服务与自测页（浏览器私有存储 OPFS 当文件夹） |

## 打包时处理过的坑（升级 deepagents 时复查）

- 浏览器入口仍 `import { createHash } from "node:crypto"` → 换成 `shims/node-crypto.js`。
- `langsmith` 加载时 `new AsyncLocalStorage()` → `shims/async-hooks.js`；跟踪全部关闭。
- 有代码直接读全局 `process` → `inject` 包内替身，不挂到 window。
- LangChain 估 token 会去公网下载编码表 → 打包时换成直接失败，走按字数估算。
- deepagents 1.16 待办工具不再默认开启 → 显式加 `todoListMiddleware()`。
- 框架自带的改前确认依赖异步上下文（浏览器没有）→ 改为文件夹后端里 `await confirm()`。
- 记忆中间件经 `CompositeBackend.downloadFiles` 读文件 → 文件夹后端实现了 `downloadFiles`。
