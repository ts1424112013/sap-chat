# SAP 动态 SQL 业务分析开发计划

版本：V1.1（已确认方向）
日期：2026-10-04
项目：SAP AI 对话助手
关系：取代《SAP数据分析能力_开发计划_V1.0_20261002》中"禁止 SQL、仅能力目录白名单"的设计边界

> 执行状态（2026-10-05）：P0 代码已落地，待 SAP 激活验证。已完成 SQL Guard、动态执行器、DDIC 元数据工具、Agent 三工具注册与分发、数据集回填、Trace SQL 展开和 CSV 导出。确认结果见第 12 节，第 13 节为同期修复的安全问题。

## 1 背景与目标

现有 `sap_data_analysis` 只能对能力目录里的 MARA 五个字段做 detail/group/trend，新业务场景（采购、销售、生产、财务、多表关联）每加一个都要改 ABAP 代码，不满足"任意业务分析"的需求。

本期目标：

1. 模型根据用户问题自行查找表、读取表结构、编写 SELECT 语句。
2. Agent 把 SQL 交给 ABAP 后端执行；后端只允许单条只读 SELECT，校验后执行并取回数据。
3. 数据回填给模型做分析，最终输出文字结论、表格和图表（复用现有数据集/图表格式）。
4. SQL 语法错误时把编译器报错回给模型自动修正。
5. 每条 SQL 的执行人、语句、涉及的表、行数、耗时都进入审计日志。

非目标（本期不做）：INSERT/UPDATE/DELETE/MODIFY、调用函数/BAPI、运行报表、跨 client 查询、跨数据库连接。

## 2 总体流程

```text
用户提问（Agent 模式）
  -> 模型: search_tables  按业务关键词查表（DD02T 描述）
  -> 模型: describe_table 读字段、类型、描述、主键
  -> 模型: run_sql        提交一条已完成字段确认的 SELECT
       -> ZCL_AI_SQL_GUARD     词法扫描 + 规则校验 + 表权限校验
       -> ZCL_AI_SQL_EXECUTOR  执行（行数上限）-> 统一数据集
       -> 失败: 报错原文回给模型，修正后重试（有次数上限）
  -> 模型: 基于数据集给出分析（summary/findings/charts）
  -> 前端: 文字 + 表格 + 图表 + Trace 中可展开的 SQL
```

三个工具都是只读的，注册进现有 `ZCL_AI_TOOL_REGISTRY`，沿用现有 Agent 循环、协议护栏、Trace 和审计，不新建 OData 入口。

## 3 关键技术选型：SQL 方言与执行方式（已确认方案 A）

### 方案 A（推荐）：ABAP Open SQL + 动态生成子程序执行

模型编写规范化的 Open SQL SELECT（表使用 AS 别名、字段优先使用 `~` 表示别名字段、显式 JOIN、英文聚合别名）。后端把它包进一个临时生成的子程序池：

```abap
PROGRAM.
FORM run USING iv_max TYPE i CHANGING cr_data TYPE REF TO data.
  <模型的 SELECT 语句>
    INTO TABLE @DATA(lt_result)
    UP TO @iv_max ROWS.
  CREATE DATA cr_data LIKE lt_result.
  ASSIGN cr_data->* TO FIELD-SYMBOL(<lt>).
  <lt> = lt_result.
ENDFORM.
```

`GENERATE SUBROUTINE POOL` 会返回编译报错（行号、消息），直接回给模型修正。`INTO`、`UP TO` 由后端拼接，模型的语句里不允许写这两个子句。

补充约束：
- `run_sql` 前，本次请求中涉及的每张表都必须成功执行 `describe_table`；未确认字段时返回明确错误，由模型补充字段确认后重试。
- 聚合查询中的非聚合字段必须全部出现在 `GROUP BY`；聚合字段统一使用英文 ASCII 别名，避免中文别名和不同模型的字段命名差异。
- 已知表名可以跳过 `search_tables`，但不能跳过 `describe_table`。

优点：
- 支持 JOIN、子查询、GROUP BY、HAVING、ORDER BY、聚合函数、CASE 和 7.5x 的 SQL 表达式，满足多表分析。
- 自动按当前 client 过滤（MANDT），不会读到其他 client 的数据。
- 字段名、表名在编译期校验，非法语句在执行前就被挡住。
- 模型对 Open SQL 的掌握程度足够，配合报错重试，成功率可接受。

缺点：
- `GENERATE SUBROUTINE POOL` 属于代码生成，Code Inspector/安全扫描会标红，需要 Basis/安全负责人知情。语句必须经过第 4 节的校验后才能被拼进代码，这是本方案的主要风险点，校验做不好就等于代码注入。
- 每个会话的生成次数有系统上限（约 36 个子程序池/内部会话），单次请求内重试次数需控制在 10 次以内。

### 方案 B：原生 SQL（ADBC，`CL_SQL_STATEMENT`）

模型写 HANA SQL，直接经 ADBC 执行。

优点：SQL 能力最强（窗口函数、CTE），模型最熟悉标准 SQL；不生成 ABAP 代码。
缺点：
- 不自动过滤 client，必须在每张表上强制 `MANDT = 当前 client`，多表 JOIN 时校验很难做严。
- 绕过 ABAP 表缓冲和 Open SQL 的类型安全，字段要按数据库原始名和类型处理（日期是字符串、数量是 DEC）。
- SAP 官方不建议业务代码直接走原生 SQL；ADBC 的 SQL 校验只能靠自己做词法分析。

结论：推荐方案 A。方案 B 只作为后续"高级分析"开关保留。

## 4 SQL 安全校验（ZCL_AI_SQL_GUARD）

"只 SELECT"不能只靠检查开头是否为 SELECT，必须做词法扫描。以下规则全部在后端执行，任何一条不通过就拒绝，并把原因回给模型。

1. 结构：去掉首尾空白后必须以 `SELECT` 开头；只允许一条语句，不允许 `.`（ABAP 语句结束符）出现在字符串常量之外。
2. 关键字黑名单（字符串常量之外，按完整单词匹配）：`INTO`、`UP TO`、`INSERT`、`UPDATE`、`DELETE`、`MODIFY`、`CLIENT SPECIFIED`、`USING CLIENT`、`CONNECTION`、`BYPASSING BUFFER`、`FOR UPDATE`、`FORM`、`ENDFORM`、`PERFORM`、`CALL`、`SUBMIT`、`EXEC`、`DATA`、`FIELD-SYMBOLS`、`ASSIGN`、`CREATE`、`GENERATE`、`INCLUDE`。
3. 字符禁止：注释符 `*`（行首）和 `"`；换行统一替换为空格后再校验；反引号字符串常量需完整闭合。
4. 表名提取：从 `FROM`/`JOIN` 后提取全部表名（含子查询），每张表都要：
   - 存在于 DD02L，且类型为透明表、视图或 CDS 视图；
   - 不在敏感表黑名单（见下）；
   - 通过表授权校验：调用 `VIEW_AUTHORITY_CHECK`（内部检查 S_TABU_NAM/S_TABU_DIS，等同 SE16 的权限逻辑）。
5. 长度：语句不超过 4000 字符，JOIN 表数不超过 8 张。
6. 注意：方案 A 中 SQL 会被拼进生成的 ABAP 代码，所以这里的校验对象是"ABAP 代码注入"，而不只是"SQL 写操作"。即使只给 IT 用也不放宽本节规则。
6. 校验通过后，再由后端拼接 `INTO TABLE @DATA(lt_result) UP TO @iv_max ROWS` 生成代码。

敏感表黑名单（存 Z 表 ZAI_SQL_BLACKLIST，可维护，支持通配符）。第一阶段只开放给 IT 账号、模型为内网私有化部署，因此第一版只放"凭据类"表，业务数据（含人事、银行）不拦截，由表授权控制：
- 口令与凭据：USR02、USH02、USRPWDHISTORY、RSECTAB、SSF_PSE_D
- 本项目自身：ZAI_MODEL_CFG（含 API Key）

以后开放给业务用户前，再把人事（PA*/PB*/HRP*/PCL*）、银行（BNKA/LFBK/KNBK/REGUH/PAYR）加进黑名单。

即使 IT 账号有 SAP_ALL，表授权校验也要保留：它校验的是当前登录用户，以后其他用户使用这个功能时同样受控。

## 5 执行控制（ZCL_AI_SQL_EXECUTOR）

### 5.1 上限取值与理由

| 参数（ZAI_CHAT_CFG 键） | 取值 | 理由 |
|---|---|---|
| `SQL_MAX_ROWS` 单条取回行数 | 5000（硬上限 50000） | 分析类问题绝大多数是汇总结果，几十到几百行；5000 足够做明细核对，又不会让 ABAP 内存和 OData 响应过大 |
| `SQL_LLM_ROWS` 回填模型的明细行数 | 200 行 + 列统计 | 内网模型上下文通常 32k–128k token，200 行×10 列约 1–2 万 token；超出时提示模型改用 GROUP BY，而不是把几千行塞给模型。前端仍显示全部取回行 |
| `SQL_MAX_EXEC` 单次请求 run_sql 次数 | 5（含报错重试） | 正常 1–2 次即可，5 次足够修正语法错误；同时远低于子程序池的生成上限 |
| `AGENT_MAX_ROUNDS` Agent 最大轮数 | 现为 4，SQL 场景需 10 | 一次 SQL 分析的典型轮次：搜表 1 + 读结构 1–2 + 执行 1–2 + 最终分析 1 = 4–6 轮，4 轮不够 |
| `AGENT_BUDGET_SEC` Agent 总时长 | 现为 60，SQL 场景 180 | 6 轮模型调用 × 每轮 10–25 秒（私有化模型的常见水平）≈ 60–150 秒，60 秒必然超时 |

为了减少轮次，`describe_table` 一次可传最多 5 张表。

### 5.2 180 秒需要 Basis 配合确认的参数

Agent 是一个同步 OData 请求，180 秒期间要求链路上所有超时都不短于它：

- ICM：HTTP 端口的 `PROCTIMEOUT`（SMICM → 服务，默认通常 60 秒）需 ≥ 200 秒，或给 `/sap/opu/odata/sap/ZAI_CHAT_SRV` 单独设置；否则浏览器会在 60 秒收到 ICM 超时，而后端仍在跑。
- 对话工作进程最大运行时间：`rdisp/max_wprun_time` 或新版的 `rdisp/scheduler/max_runtime`（默认 600 秒），一般无需改。
- 如有反向代理/负载均衡（Web Dispatcher、Nginx），其超时也要 ≥ 200 秒。
- 前端 UI5 ODataModel 默认不设超时，无需改。

如果 Basis 不方便放宽 ICM 超时，退路是把 SQL 场景改成异步执行（前端轮询运行状态），工作量会增加，放到 P2。

### 5.3 其他控制

- 超时：SAP 无法对单条 Open SQL 设超时。控制手段为：行数上限；禁止无 WHERE 的大表明细（MSEG、ACDOCA、BSEG、MATDOC、VBFA、CDPOS 等，无 WHERE 且无 GROUP BY 时拒绝，大表清单存配置）。
- 结果转换：动态结果表通过 RTTI（`CL_ABAP_STRUCTDESCR`）取列名和类型，转成现有统一数据集格式（columns/rows），日期、数量、金额按 DDIC 类型格式化。

## 6 元数据工具（让模型知道该查哪张表）

| 工具 | 参数 | 行为 |
|---|---|---|
| `search_tables` | `keyword`（中文或英文） | 在 DD02T（当前登录语言 + EN）中按描述模糊匹配，同时匹配表名；最多返回 30 张，含表名和描述。排除敏感表 |
| `describe_table` | `table` | 调用 `DDIF_FIELDINFO_GET`，返回字段名、描述、类型、长度、是否主键、检查表；最多 150 个字段 |
| `run_sql` | `sql`、`purpose`（一句话说明目的） | 校验并执行，返回数据集 |

另外，领域卡（`ZCL_AI_DOMAIN_CARDS`）中加入常用业务模块的"表地图"提示，减少模型盲目搜表，第一版覆盖：
- MM：MARA/MARC/MARD/MSEG/MKPF/EKKO/EKPO/EBAN
- SD：VBAK/VBAP/LIKP/LIPS/VBRK/VBRP/KNA1
- PP：AFKO/AFPO/RESB
- FI/CO：ACDOCA/BKPF/BSEG/SKAT/CSKS

同时写清楚常见口径：金额/数量必须带货币/单位字段一起分组；日期字段为 YYYYMMDD 字符格式等。

## 7 与现有功能的关系

- `sap_data_analysis`（MARA 白名单）保留，暂不删除。领域路由为 DATA 时同时提供 4 个新工具和旧工具，提示模型优先用 run_sql；稳定后再下线旧工具。
- 库存四个工具不变。
- 普通对话模式不开放 run_sql，只在 Agent 模式可用。
- 新增配置开关 `SQL_ANALYSIS_ENABLED`（ZAI_CHAT_CFG）。第一阶段只给 IT 账号用：ZAI_CHAT_USER 新增字段 `SQL_ALLOWED`，由管理员在用户管理界面勾选；后端在 run_sql/search_tables/describe_table 执行前校验，未勾选的用户在 DATA 域拿不到这三个工具。

## 8 审计

新增表 `ZAI_SQL_LOG`：RUN_ID、STEP_NO、UNAME、时间戳、SQL 原文（STRING）、涉及表清单、状态（OK/REJECTED/ERROR）、拒绝/报错原因、返回行数、耗时 ms。被拒绝的语句也记录，方便发现模型或用户的越权尝试。

## 9 前端改动

- Trace 中 run_sql 步骤可展开，显示 SQL 原文（等宽字体、高亮）、行数、耗时；被拒绝时显示原因。
- 数据集表格支持更多列（横向滚动）和导出 CSV。
- 复用现有 bar/line/pie 图表与 `AnalysisJson` 格式，不改 OData 结构。
- 顺带修复审查发现的 Markdown XSS（SQL 和数据结果会进入 Markdown 渲染，这个漏洞在本功能下风险更高）。

## 10 ABAP 对象清单

| 对象 | 类型 | 内容 |
|---|---|---|
| ZCL_AI_SQL_GUARD | 新建类 | 词法扫描、关键字/字符校验、表名提取、黑名单、VIEW_AUTHORITY_CHECK |
| ZCL_AI_SQL_EXECUTOR | 新建类 | 生成子程序池、执行、RTTI 转数据集、列统计、报错整理 |
| ZCL_AI_DDIC_TOOLS | 新建类 | search_tables、describe_table |
| ZAI_SQL_LOG | 新建表 | SQL 审计 |
| ZAI_SQL_BLACKLIST | 新建表 | 敏感表黑名单（支持通配符） |
| ZCL_AI_TOOL_REGISTRY | 修改 | 注册 3 个工具，DATA 域工具清单 |
| ZCL_AI_AGENT_SERVICE | 修改 | 新工具分发、重试次数、SQL 场景预算 |
| ZCL_AI_AGENT_GUARD | 修改 | run_sql 参数解析（SQL 为长字符串，需正确处理 JSON 转义） |
| ZCL_AI_DOMAIN_CARDS | 修改 | DATA 域加入 Open SQL 写法规范和表地图 |
| ZAI_CHAT_CFG / ZAI_CHAT_USER | 数据/字段 | 开关、行数上限、SQL 授权标记 |

OData（SEGW）不需要改动。

## 11 实施阶段与验收

P0：后端可跑通
- search_tables / describe_table 返回正确
- 单表、两表 JOIN、GROUP BY、子查询四类 SELECT 可执行并返回数据集
- 非 SELECT、含黑名单关键字、多语句、注释、敏感表、无权限表全部被拒绝
- 语法错误能回给模型并修正成功

P1：分析与展示
- 典型场景端到端：采购订单金额按供应商 Top10、销售订单按月趋势、库存呆滞物料（MARD + MSEG 最近移动日期）
- Trace 显示 SQL，结果表格、图表、CSV 导出
- 审计表记录完整

P2：增强
- 常用分析模板（存 Z 表，模型可参考）
- 结果缓存、方案 B（原生 SQL）开关评估

安全测试用例单独列一份（注入尝试：字符串常量中藏关键字、反引号未闭合、大小写混写、子查询中引用敏感表、用 CDS 视图包一层敏感表等）。

## 12 确认结果（2026-10-04）

| 问题 | 结论 | 对设计的影响 |
|---|---|---|
| SQL 方言 | 方案 A，公司允许 `GENERATE SUBROUTINE POOL` | 按第 3 节实施 |
| 系统版本 | 755 | 2026-10-05 确认：ABAP Platform 2020（S/4HANA 2020 SP03），SAP_BASIS 755 SP0003 |
| 使用范围 | 第一阶段只给 IT 账号 | `SQL_ALLOWED` 用户标记；黑名单只拦凭据类表（第 4 节） |
| 数据外发 | 内网私有化模型，数据可全部发送 | 不做出网字段脱敏 |
| 行数与预算 | 由开发方评估 | 采用第 5.1 节取值，ICM 超时需 Basis 确认（第 5.2 节） |
| 同期修复高危问题 | 一起修 | 见第 13 节 |

版本说明：SAP_BASIS 的标准版本号是 750/751/…/758，"760" 不是常见的 SAP_BASIS 编号，可能是其他组件的版本。实施前请在 SAP GUI"系统 → 状态 → 组件信息"中确认 SAP_BASIS 版本。为保险起见：
- 后端代码按 7.50 可用的语法编写（与现有代码一致）；
- 领域卡中告诉模型可用的 SQL 语法级别，由配置 `SQL_SYNTAX_LEVEL` 控制：750 时禁止 `WITH`（CTE）和窗口函数，754 及以上放开；
- 模型若用了不支持的语法，编译报错会回给模型修正，不会导致错误数据。

## 13 同期修复的审查问题

动态 SQL 会让模型接触任意业务数据，以下问题若不修会被放大，本期一起处理：

| # | 问题 | 修复方式 |
|---|---|---|
| 1 | 前端 Markdown 渲染 XSS（Formatter.js `_inline` 图片/链接规则组合可注入属性） | 链接/图片 URL 禁止 `"<>'` 等字符并统一属性转义；渲染后再经过一层白名单清洗（只允许已知标签和属性），不引入外部依赖 |
| 2 | 普通对话通道可读任意表和源码，无权限校验 | 表取样前调用 `VIEW_AUTHORITY_CHECK`，源码读取前校验 S_DEVELOP（ACTVT 03）；凭据类表复用 ZAI_SQL_BLACKLIST |
| 3 | 保存/测试模型配置不校验管理员 | `save_model_cfg`、`test_model` 入口调用 `v8_require_admin` |
| 4 | 消息/会话越权读取（只按 SessionId 查询） | 新增 `assert_session_owner`，在 Messages 查询、对话 analyze、get_history 中调用 |
| 5 | 后端不校验用户是否已开通 | `analyze` / `analyze_agent` 入口校验 ZAI_CHAT_USER 中存在且有效 |
| 6 | SAP 明文密码存 localStorage | 改为 sessionStorage，关闭浏览器即清除；不再强制"记住" |
| 7 | 切换会话时旧回复写进新会话 | 回复返回时比对当前会话 ID，不一致则丢弃 |
| 8 | Agent 接口接收模式为空的旧对话会话 | 条件由 `= 'CHAT'` 改为 `<> 'AGENT'` |
| 9 | 数据分析 GROUP BY 无 ORDER BY，TopN 不准 | SQL 中加 `ORDER BY cnt DESCENDING` |

暂不处理（不影响本期功能，后续单独安排）：API Key 明文存表（建议迁到 SM59 目的地认证）、两个大类的拆分、mock 降级的默认口令。

## 14 实施顺序

1. 建立 git 基线提交（当前目录不是 git 仓库）。
2. 第 13 节安全修复（前端可本地构建验证；ABAP 需在 SAP 激活验证）。
3. P0：ZCL_AI_SQL_GUARD、ZCL_AI_SQL_EXECUTOR、ZCL_AI_DDIC_TOOLS、两张 Z 表、工具注册与分发。
4. P1：前端 SQL Trace 展示、CSV 导出、领域卡表地图。
5. 每一步交付 ABAP 源码 + SE11/SE24 激活顺序说明，由你在 SAP 中激活并回传报错。
