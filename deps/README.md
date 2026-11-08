# 依赖包（node_modules 压缩包）

仓库不直接存 node_modules，四个目录各打成一个 zip 放在这里。压缩包里带着目录路径，**在项目根目录解压**就会落到原位置。

| 压缩包 | 解压后 | 用途 |
|---|---|---|
| `node_modules-root.zip` | `node_modules/` | 前端（UI5，`npm start`） |
| `node_modules-test-server.zip` | `test-server/node_modules/` | 测试（`npm run test:abap` / `test:frontend`） |
| `node_modules-agent-bundle.zip` | `agent-bundle/node_modules/` | 新引擎打包，只在开发机用（员工电脑不需要） |
| `node_modules-local-mcp.zip` | `local-mcp/node_modules/` | 本地 SAP MCP 服务 |

```bash
unzip -o deps/node_modules-root.zip
unzip -o deps/node_modules-test-server.zip
unzip -o deps/node_modules-agent-bundle.zip
unzip -o deps/node_modules-local-mcp.zip
```

Windows 可以右键「全部解压缩」到项目根目录（注意不要多套一层文件夹）。

注意：压缩包是在 Mac 上打的。`agent-bundle` 用的 esbuild 带的是 Mac 版程序，在 Windows 上打包引擎要在 `agent-bundle` 里重新 `npm ci`；前端和测试不受影响。

依赖有变化（`package-lock.json` 改了）时重新打包：

```bash
zip -qr -X -9 deps/node_modules-root.zip node_modules -x "*.DS_Store"
```
