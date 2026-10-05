# SAP 数据分析能力开发计划

版本：V1.0  
日期：2026-10-02  
项目：SAP AI 对话助手

> **执行状态：本次仅完成项目审查和开发计划编写，未实施后续代码改动。**
> 代码实施、SAP 激活和联调由后续开发代理按本计划执行；当前工作区保留现有前后端代码。

## 1 当前项目现状

项目采用 SAPUI5 前端、ABAP OData 服务 `ZAI_CHAT_SRV`、企业内大模型和 ABAP Agent 编排器。普通对话通过 `AnalyzeCode`，Agent 通过 `AnalyzeAgent`。Agent 已具备领域路由、工具注册表、JSON 协议、参数校验、工厂权限检查、结果裁剪、Trace 和审计；当前工具实现集中在库存域，包含物料候选、库存快照、收发汇总和批次库存四个只读工具。

普通对话已经支持 ABAP 程序识别、表结构读取、表样例取数，但表分析仍是一次非结构化取样，不能让 Agent 生成受控的分组、趋势和多维查询计划。前端已有统一 `ChatService`、Agent Trace 卡片、Markdown 表格和图片渲染基础，但没有结构化数据集和图表组件。

本地可以检查 JavaScript、ABAP 源码结构和 OData 契约；SE11、SEGW、SE24 激活、SAP 权限和真实业务数据必须在 SAP 环境验证。

## 2 本次目标与非目标

### 目标

1. 增加 SAP 能力目录，声明实体、字段、维度、指标、操作、权限和上限。
2. 让 Agent 只生成结构化查询计划，不生成 SQL 或任意 OData URL。
3. 后端重新校验实体、字段、操作符、过滤值、权限、行数和超时。
4. 实现 MARA 单实体 `detail/group/trend` 数据分析 MVP。
5. 将库存能力纳入统一工具注册和分发入口，保持原有行为。
6. 支持一个请求包含多个查询，返回统一数据集。
7. 返回结构化摘要、发现、异常和图表配置。
8. 前端渲染分析表格和安全的 SVG 图表，并在 Trace 中展示查询阶段。

### 非目标

不开发 SAP 写入、修改、删除、过账、报表运行器、任意 SQL、任意 OData URL、自动执行用户提供的程序代码。

## 3 目标架构

```text
UI5 输入
  -> ChatService.sendAgent
  -> OData AnalyzeAgent / AgentCapabilities
  -> ZCL_AI_AGENT_SERVICE
       -> 领域/能力目录
       -> 模型结构化计划
       -> ZCL_AI_AGENT_GUARD 计划校验
       -> ZCL_AI_DATA_ANALYSIS_SERVICE 公共 ABAP 查询服务
       -> 统一数据集
       -> 模型结构化分析结果
       -> Trace + 审计
  -> AgentResult
  -> UI5 文字、表格、图表
```

Agent 和已有 OData 入口在同一个 ABAP 系统内时，共同调用公共 ABAP Service 层，不通过 HTTP 回调自身 OData。

## 4 职责边界

- 前端 Agent：收集问题、显示思考状态、展示查询计划摘要、表格和图表；不决定最终权限。
- `ZCL_AI_AGENT_SERVICE`：编排理解、计划、校验、执行、分析和收口。
- `ZCL_AI_TOOL_REGISTRY`：工具白名单、参数 Schema、能力域映射。
- `ZCL_AI_AGENT_GUARD`：严格 JSON、计划和参数校验。
- `ZCL_AI_DATA_ANALYSIS_SERVICE`：能力目录和受控数据查询；不接受 SQL。
- `ZCL_AI_INVENTORY_TOOLS`：库存专用只读工具，通过通用工具分发调用。
- DPC_EXT：OData Function Import/EntitySet 参数分发，不实现业务查询。
- 模型：生成计划和分析文本/结构化 JSON；不能绕过后端校验。

## 5 SAP 能力目录设计

新增 `GET /AgentCapabilities`，返回能力项：`entity`、`label`、`dimensions`、`metrics`、`operations`、`max_rows`、`timeout_sec`、`permission`、`sensitive_fields`。P0 固定注册 MARA：`MATNR`、`MTART`、`MATKL`、`ERSDA`、`MEINS`，指标 `count`，操作 `detail/group/trend`。库存域继续通过工具注册表暴露。

能力目录先采用 ABAP 常量注册，P2 再迁移到配置表。未注册实体和字段直接返回用户可读的“不支持”错误。

## 6 查询计划设计

模型只输出 JSON：

```json
{"intent":"table_analysis","queries":[{"name":"按物料类型统计","entity":"MARA","operation":"group","dimensions":["MTART"],"metrics":["count"],"filters":[]}]}
```

过滤条件为结构化对象：`field`、`operator`、`value`，操作符仅允许 `eq/ne/like/ge/le/between` 中被实体声明的子集。后端拒绝未知实体、字段、指标、维度、操作、重复字段、危险字符、非法日期和超限行数。

## 7 多维度查询

P1 支持 `queries` 数组最多 4 条；每条查询独立校验、独立执行和独立返回。一个请求可同时包含 `group MTART`、`group MATKL`、`trend ERSDA`。单条失败不丢弃其他成功数据集，结果中保留 `status/error`。

## 8 统一数据集格式

```json
{"name":"按物料类型统计","status":"OK","columns":[{"name":"MTART","label":"物料类型"},{"name":"COUNT","label":"数量"}],"rows":[["FERT",1200],["ROH",860]],"total_rows":2,"truncated":false,"source":"SAP ABAP Service","elapsed_ms":34}
```

数据集限制单条最多 10000 行、单次最多 4 个数据集、回填模型总字符数 120000；超限返回 `truncated=true` 和说明。

## 9 模型分析结果格式

```json
{"summary":"物料主要集中在 FERT 和 ROH。","findings":[{"title":"类型分布","detail":"FERT 占比最高。","severity":"info"}],"datasets":["按物料类型统计"],"charts":[{"type":"bar","title":"各物料类型数量","dataset":"按物料类型统计","x":"MTART","y":"COUNT"}]}
```

模型输出必须经过后端 JSON 解析、字段清洗和图表引用校验。不能包含 HTML、JavaScript、SQL 或未声明的数据集引用。

## 10 图表配置格式

只允许 `bar`、`line`、`pie` 三种类型；字段为 `title/dataset/x/y`，可选 `series`。前端只按白名单字段生成 SVG，不执行模型返回的 HTML 或 JavaScript。字段不存在、数据集不存在或行数为空时不渲染图表并展示说明。

## 11 安全策略

- 查询计划只能使用能力目录声明的实体、字段、维度、指标和操作符。
- ABAP 后端二次校验，前端校验只用于即时提示。
- 每个能力定义最大行数、超时、权限要求和可返回字段。
- 工厂数据复用 `W_WERKS_MAT`，表数据按现有授权策略接入；真实 `S_TABU_DIS/S_TABU_NAM` 需 SAP 端确认。
- 敏感字段不进入能力目录；返回字段按白名单投影。
- 结果超限返回 `truncated`，不静默丢数据。
- 所有查询只读；禁止 SQL 字符串、动态表名和任意 OData URL。
- Trace 只记录阶段、查询名称、行数、耗时和脱敏错误，不记录密钥、SQL 或完整敏感数据。

## 12 前端改造

1. `ChatService.js` 增加能力目录读取、结构化 AgentResult 解包和数据集校验。
2. `App.controller.js` 在 Agent 回复中增加分析结果解析、数据表格、图表渲染和错误提示。
3. `Formatter.js` 增加安全 JSON/图表数值格式化辅助方法。
4. `App.view.xml` 保持现有聊天布局，结构化结果由消息工厂生成 UI5 控件。
5. 图表先用原生 SVG/UI5 控件实现，不新增外部图表依赖。

## 13 ABAP 改造

1. 新增 `ZCL_AI_DATA_ANALYSIS_SERVICE.abap`：能力目录、计划解析、MARA 查询、统一数据集。
2. 扩展 `ZCL_AI_TOOL_REGISTRY`：注册 `sap_data_analysis`，并保留库存工具注册。
3. 扩展 `ZCL_AI_AGENT_GUARD`：查询计划、过滤条件和分析结果校验。
4. 重构 `ZCL_AI_AGENT_SERVICE`：工具统一分发，增加数据分析计划和数据集回填；库存走原实现。
5. 扩展 `ZCL_ZAI_CHAT_DPC_EXT`：`AgentCapabilities` EntitySet 或 Function Import，`AnalyzeAgent` 继续兼容原参数。

## 14 OData 与数据表

P0 新增 `AgentCapabilities` EntitySet；`AnalyzeAgent` 返回结构新增可选 `AnalysisJson`，原有 `Answer/Status/TraceJson` 保持不变。SEGW 增加 `AnalysisJson` 属性并重新生成运行时。P0 不新增数据库表；沿用现有 Agent 审计表。P2 再考虑能力目录配置表和缓存表。

## 15 分阶段实施与验收

### P0 能力目录、计划、校验、单维度和基础分析

- 能力目录返回 MARA 声明。
- 普通聊天不进入 SAP 查询工具。
- 支持 `MARA detail/group/trend` 的单查询。
- 后端拒绝未知实体、字段、操作符和非法过滤。
- 返回统一数据集和基础分析 JSON。
- 库存工具通过统一分发仍可执行。

### P1 多维度、综合分析、图表、Trace 和异常

- 最多 4 条查询独立执行。
- 模型根据多个数据集生成综合结论。
- 前端渲染表格、bar/line/pie 图表。
- 查询计划、查询耗时、行数和错误进入 Trace。
- 无权限、OData/ABAP 错误转为用户可读信息。

### P2 扩展能力、复杂过滤、缓存和导出

- 增加 MARC/MARD 等实体和库存结构分析。
- 增加更严格的日期区间、排序和分页。
- 能力目录后台管理、结果缓存和导出。

## 16 测试计划

### 静态测试

- `npm run build`。
- JavaScript 语法和 OData 参数名检查。
- ABAP 类、方法、字段和 DDIC 名称静态核对。
- 文档与源码接口清单核对。

### 本地行为测试

1. 普通聊天不调用 SAP 查询。
2. MARA 分析生成数据集。
3. 一个问题生成两个查询。
4. 未知表返回不支持提示。
5. 未知字段被拒绝。
6. 非法过滤被拒绝。
7. 行数超限返回 `truncated`。
8. 图表配置仅为 JSON 并可渲染。
9. 原对话、Agent、库存路径保持兼容。

### SAP 环境测试

在 `/IWFND/GW_CLIENT` 和真实账号下验证能力目录、SEGW 激活、授权对象、真实 MARA 数据、超时和大模型结构化输出。

## 17 部署、升级和回滚

1. 备份当前前端 BSP 包和 4 个 Agent 类源码。
2. SE24 按依赖顺序激活新 Service、Registry、Guard、Agent、DPC_EXT。
3. SEGW 增加 `AgentCapabilities` 和 `AgentResult.AnalysisJson`，Generate Runtime，激活 OData。
4. 前端执行 `npm run build`，按现有 BSP 增量部署。
5. 使用能力目录、普通聊天、Agent、库存和权限用例回归。
6. 失败时恢复旧类源码、旧 SEGW 运行时和旧前端包；数据库无新增字段时无需回滚表结构。

## 18 风险与兼容性

- ABAP 7.5x 的 JSON 解析和动态结构能力有限，采用固定结构和白名单，减少激活风险。
- MARA 的真实字段类型、客户端字段和权限组必须在 SAP 系统确认。
- 大模型可能不遵守 JSON，沿用一次修复和 ABAP 降级机制。
- `AnalysisJson` 为可选字段，旧前端仍读取 `Answer/TraceJson`，保证灰度升级。
- OData 元数据缓存可能导致前端暂时看不到新增字段，需要清缓存或重新加载服务元数据。
