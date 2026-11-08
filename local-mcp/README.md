# 灵犀 SAP 本地 MCP

这是灵犀现有 SAP 报表接口的独立 MCP 适配服务。它通过本机标准输入输出连接 MCP 客户端；SAP 报表仍由现有 OData 服务提供。当前工作区没有 DeepSeek Harness，也没有把本服务接入现有 UI5 对话或 ABAP Agent。

## 已接工具

- `sap_report_definitions`：获取当前用户的已登记报表与参数。
- `sap_report_result`：按完整 ArtifactId 读取该用户已有的报表结果；行数受 SAP 后端限制。
- `sap_fiori_report_definitions`：读取当前用户可用的 Fiori 报表目录。

每次调用先按当前用户完成 SAP 网关认证、CSRF 令牌获取和灵犀 `Login`，再检查登录返回的场景权限。SAP 目录接口负责筛选报表授权，结果接口负责核对归属；本服务返回结果前还会核对该报表是否仍在当前用户可用目录中。工具返回 `message` 与 `data`，后端禁用或失败时不会伪造结果。

本版未实现报表提交、状态轮询、Fiori 结果读取、SAP 源码读取或数据分析工具。报表状态接口虽然使用 GET，也可能推进作业状态和登记结果；Fiori 结果进入模型还需要沿用现有的用户分析确认流程，故暂不开放。

## 安装和配置

要求 Node.js 20.3 或更高版本。首次在本目录执行 `npm ci`；离线环境需提前准备依赖包。

启动 MCP 客户端前，设置环境变量：

| 变量 | 说明 |
| --- | --- |
| `SAP_ODATA_URL` | 灵犀 OData 服务完整根地址，例如 `https://sap.example.com/sap/opu/odata/sap/ZAI_CHAT_SRV/`，不要带账号、密码和查询参数 |
| `SAP_CLIENT` | SAP client，三位数字，例如 `470`；DSH 示例中需提供 |
| `SAP_USER` | SAP 用户名 |
| `SAP_PASSWORD` | 该 SAP 用户的密码 |

服务不把凭据写入代码或日志；运行环境仍能读取其环境变量。不要把密码写进版本库或直接放在 shell 历史里。建议使用 HTTPS：HTTP Basic 身份认证在 HTTP 连接上无法加密传输。

## 连接 DeepSeek Harness

仓库提供 `dsh-patch.yml`，采用官方 MCP 客户端的 stdio 配置，并显式传入上面的环境变量。它按启动命令的当前目录寻找 `local-mcp/src/server.js`，所以需先进入本项目根目录。安装 DeepSeek Harness 并配置模型后，在项目根目录执行：

```sh
dsh web --patch "$PWD/local-mcp/dsh-patch.yml"
```

工具会显示为 `mcp__lingxi-sap__sap_report_definitions` 等名称。`dsh` 和模型配置不由本服务安装或创建；Harness 的插件配置方式见 [官方 MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)。

## 验证

在本目录运行 `npm test`，测试启动真正的 MCP 子进程，连接本地模拟 SAP，验证工具发现、登录、CSRF 和 Cookie、OData 参数、场景权限、报表授权撤销以及拒绝未开通用户。模拟结果不能替代真实 SAP 权限和环境验收。
