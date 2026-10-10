# SAP 数据分析能力 实施与部署说明

版本：V1.1（与 2026-10-11 A/B 批对齐）
日期：2026-10-11
依据：《SAP数据分析能力_开发计划_V1.0_20261002》（功能计划书/开发计划/）
状态：数据分析代码已实施；SAP 端激活（SE24/SEGW）与真实数据联调待执行。报表场景、代码分析和 Agent 模型白名单的新增部署动作见 [03-后端实施文档](03-后端实施文档.md)“〇-A 当前批次”。

<mark>版本边界：本文专门说明 `AnalysisJson`/AgentCapabilities 数据分析增量；本批普通对话默认不读 SAP，代码源码改由 CODE 场景的 `read_program_source` 提供，不能再按本文旧的普通对话源码路径验收。</mark>

### 2026-10-11 测评验收补充

数据分析部署完成后，管理员从“设置 → 测评”选择 DATA 或全部题目执行题库 `20261011`。D01-D11 用真实数据/工具验证统计、找表、趋势、多维汇总和两轮追问；D08 必须拒绝删除数据；D12 在 DATA 场景执行报表时必须确定性提示换到 REPORT 且不调用工具。报告中应能看到 `run_sql`/`sap_data_analysis`、回答关键词、`maxRounds/maxSeconds`、协议错误和被拒次数。该测评只读、默认清理临时会话，不新增 `AgentCapabilities` 以外的 OData/数据库对象；前端演示模式结果不作为 SAP 数据分析通过证据。

---

## 1 交付物清单

### 1.1 后端 ABAP（backend-abap/，SE24 整类粘贴）

| 对象 | 状态 | 说明 |
|---|---|---|
| ZCL_AI_DATA_ANALYSIS_SERVICE | 新增 | 数据分析公共服务：能力目录（P0 注册 MARA）、查询计划校验（validate_plan/validate_query/check_value）、受控查询执行（detail/group/trend，动态 WHERE 白名单拼接）、统一数据集手工 JSON 序列化（数值列不加引号）、AnalysisJson 组装 |
| ZCL_AI_TOOL_REGISTRY | 修改 | 新增常量 gc_tool_data_analysis；注册第 5 个工具 `sap_data_analysis`（params 为空，args 直接承载计划 JSON）；get_tools_for_domain 增加 DATA 域映射 |
| ZCL_AI_DOMAIN_CARDS | 修改 | 新增 gc_dom_data='DATA'；match_domain 在库存意图之后增加统计/趋势/分布等关键词路由；get_card 增加数据分析领域卡（口径与自查清单） |
| ZCL_AI_AGENT_GUARD | 修改 | 新增 parse_analysis_plan（计划 JSON 解析+规范化+形状校验）、parse_analysis_output（结构化分析输出清洗：字段白名单/长度截断/图表类型与数据集·字段引用校验）、extract_args_object（感知字符串的配平括号提取，支持嵌套 args）、私有 extract_json_object/clean_text |
| ZCL_AI_AGENT_SERVICE | 修改 | ty_agent_result 新增 analysis_json 字段；analyze_agent 工具执行段新增统一分发分支（sap_data_analysis → 计划解析/校验/执行/按查询 Trace/数据集回填；其余工具走原库存实现）；计划被拒与参数被拒共用“修复一次”通道；final 后如有数据集则追加一次结构化分析模型调用（受同一预算约束，失败降级为仅数据集）；message 附数据集数量 |
| ZCL_ZAI_CHAT_DPC_EXT | 修改 | 新增 agentcapabilities_get_entityset 重定义（GET /AgentCapabilities）；头部注释补充 SEGW 变更要求 |

### 1.2 前端（webapp/）

| 文件 | 状态 | 说明 |
|---|---|---|
| service/ChatService.js | 修改 | sendAgent 解析 AnalysisJson 并经 _sanitizeAnalysis 白名单复核（datasets≤4 归一化、charts 仅 bar/line/pie 且 dataset/x/y 引用必须存在）；新增 getAgentCapabilities（GET /AgentCapabilities，Promise 记忆化，失败返回空数组）；mock 模式新增数据分析演示分支（2 个数据集 + 3 种图表）与能力目录样例；统计意图路由优先于库存演示 |
| controller/App.controller.js | 修改 | _attachAgentProcess 携带 analysis 重建条目；msgItemFactory 在正文下渲染分析区块；新增 _buildAnalysisHtml（摘要/发现/数据集表格/错误与空态提示）、_chartToSvg/_axisChartSvg/_pieSvg（原生 SVG：柱状/折线/饼图，viewBox 自适应，x 标签抽稀、饼图超 12 片合并“其他”）；所有动态文本经 Formatter.escapeHtml，与 markdown 正文同一安全模型 |
| utils/Formatter.js | 修改 | 新增 toNumber（安全取数）、formatMetricNumber（千分位）、niceAxisMax（1/2/5×10^k 刻度上限） |
| css/style.css | 修改 | 追加 .analysisBlock/.analysisSummary/.analysisFindings/.analysisDs/.analysisTable/.anSvg 等样式，复用主题变量，含暗色覆盖 |
| i18n/i18n.properties | 修改 | 追加 analysisRows/analysisTruncated/analysisEmpty/analysisDsError/analysisChartSkip/analysisOther |

不改动：App.view.xml（聊天布局保持，结构化结果由消息工厂生成控件）、ZCL_AI_INVENTORY_TOOLS、ZCL_AI_CHAT_SERVICE、审计表（无新增数据库表）。

## 2 SEGW 变更清单（SAP 端，计划 §14）

SEGW 项目 ZAI_CHAT：

1. **ComplexType `AgentResult` 增加属性 `AnalysisJson`**：Edm.String，nullable；其余属性（SessionId/Answer/Status/ModelId/Rounds/ElapsedMs/TraceJson/Message）不变。
2. **新增 EntityType `AgentCapability`**（无 CRUD，仅读取），属性全 Edm.String：
   `Entity`(Key)、`Label`、`Dimensions`、`Metrics`、`Operations`、`MaxRows`、`TimeoutSec`、`Permission`、`SensitiveFields`。
   运行时生成的字段名对应：entity / label / dimensions / metrics / operations / maxrows / timeoutsec / permission / sensitivefields（DPC_EXT 实现已按此命名，若 SEGW 属性名不同请同步修改）。
3. **新增 EntitySet `AgentCapabilities`** 绑定上述 EntityType。
4. **Generate Runtime**，激活服务；如前端看不到新字段/新 EntitySet，清理 `/IWFND/CACHE` 或 SICF 重启（计划 §18 元数据缓存风险）。

## 3 ABAP 激活顺序（SE24 整类粘贴，计划 §17）

1. 备份现有 4 个 Agent 类源码与前端 BSP 包。
2. SE24 新建 `ZCL_AI_DATA_ANALYSIS_SERVICE` → 粘贴 → 激活（无 ABAP 类依赖，最先激活）。
3. 覆盖粘贴 `ZCL_AI_TOOL_REGISTRY` → 激活。
4. 覆盖粘贴 `ZCL_AI_AGENT_GUARD` → 激活。
5. 覆盖粘贴 `ZCL_AI_AGENT_SERVICE` → 激活。
6. SEGW 完成第 2 节变更并 Generate Runtime。
7. 覆盖粘贴 `ZCL_ZAI_CHAT_DPC_EXT` → 激活。
8. 回滚：恢复旧类源码 + 旧 SEGW 运行时 + 旧前端包；本次无新增数据库表/字段，无需回滚表结构。

## 4 前端构建部署

```
npm run build        # 已验证通过（ui5 build --all --clean-dest）
```
按现有 BSP 增量部署 dist/ 产物。

## 5 已验证项（本地）

- `node --check`：ChatService.js / App.controller.js / Formatter.js 全部通过。
- `npm run build` 成功（hljs 的 eval 警告为既有告警，与本次无关）。
- ABAP 六个类 CLASS/ENDCLASS、METHOD/ENDMETHOD 配对核对通过；跨类引用（GUARD→SERVICE 类型、SERVICE 常量、DPC→SERVICE）清单核对一致。
- 浏览器（ui5 serve :8081，演示模式）：
  - Agent 问“统计一下物料主档：按物料类型分布,再看近半年创建趋势” → Trace 显示两条“数据分析查询”+“生成结构化分析”；摘要/发现（含 warn 档）/两张数据集表格/柱状·饼·折线三图全部渲染；数值列右对齐。
  - 回归：库存问题（A001@0001）走原库存工具演示路径，行为不变；Trace 卡正常。

## 6 SAP 环境测试用例（待执行，计划 §16）

1. `/IWFND/GW_CLIENT` 验证 `GET /AgentCapabilities` 返回 MARA 声明。
2. 普通聊天（AnalyzeCode）不触发任何 SAP 查询工具。
3. Agent 问“按物料类型统计物料主档” → 生成 group 计划 → 返回数据集 + 表格 + 图表。
4. 一个问题拆两个查询（group MTART + trend ERSDA）→ 两个数据集独立返回。
5. 问“分析 ZTABLE 数据” → 后端返回“实体不在能力目录”用户可读提示。
6. 过滤字段/操作符/非法日期/危险字符 → 计划被拒，模型修复一次或如实说明。
7. 行数超上限 → `truncated=true` 与截断说明。
8. 图表配置仅为后端 JSON（前端不执行模型 HTML/JS）；字段引用无效时不渲染并展示说明。
9. 原对话 / Agent 库存 / 权限（W_WERKS_MAT）路径回归。
10. 真实 MARA 数据下核对 MATNR 前导零、ERSDA 空值（00000000 → 空串）、(空) 维度展示。

## 7 已知限制与兼容性

- **历史消息不回放分析区块**：ZAI_CHAT_MSG 仅存 markdown 正文，重新打开会话只见文字与 Trace 之外的分析结果不保留（P2 可考虑新增列持久化 AnalysisJson）。
- **AnalysisJson 为可选字段**：未做 SEGW 增量前调用 AnalyzeAgent，多余 ABAP 字段被网关忽略，旧前端行为不变（灰度安全）；但前端表格/图表需等 SEGW 增属性后才可用。
- **trend 仅支持 ERSDA**（目录声明的日期字段）；group 维度 P0 限单维度（计划 §15 P1 口径中多查询已支持，多维分组属 P2）。
- **无过滤时 detail/group 全表扫描上限 1001 行**：MARA 大数据量下建议模型始终携带过滤条件；P2 增加强制日期区间。
- **权限**：MARA 无工厂字段，P0 未接 W_WERKS_MAT；表级 S_TABU_DIS/S_TABU_NAM 需 SAP 端确认后在能力目录 permission 声明。
- **模型不守协议**：沿用“非法输出仅修复一次 + ABAP 降级”机制；结构化分析失败时 AnalysisJson 仍含数据集（summary/findings/charts 为空或兜底文案）。
