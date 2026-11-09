# 依赖包（node_modules 压缩包）

仓库不直接存 node_modules。四个目录各打成一个 zip，**放在单独的 `deps` 分支**（只有这个目录，没有代码）；main 分支不存压缩包。

## 取压缩包

在项目根目录（main 分支上）运行：

```bash
scripts/deps-branch.sh fetch
```

压缩包会落到本地 `deps/`（已被 .gitignore 忽略，不会混进 main 的提交）。也可以在 GitHub 上切到 `deps` 分支直接下载。

## 解压

压缩包里带着目录路径，**在项目根目录解压**就会落到原位置。

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

`deps` 分支根目录另有 `node_modules_20261005.zip`：10-05 的旧版 Windows 依赖包，留档用。

## 依赖变了怎么办

`deps/LOCKS.txt`（在 deps 分支里）记着打包时各 `package-lock.json` 的哈希。

```bash
scripts/deps-branch.sh check          # 哪些依赖比压缩包新
scripts/deps-branch.sh update --push  # 重新打包有变化的部分，提交并推送 deps 分支
```

`update` 打包的是本机现在的 node_modules，先在对应目录 `npm ci` 再运行；它只改 deps 分支，不动当前分支和工作区。
