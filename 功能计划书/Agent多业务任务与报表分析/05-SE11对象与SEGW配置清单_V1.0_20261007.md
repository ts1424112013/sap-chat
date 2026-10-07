# Agent 多业务任务与报表分析：SE11 对象与 SEGW 配置清单

版本：V1.0
日期：2026-10-07（Asia/Shanghai）
状态：**代码已完成，以下 SAP 端对象均未创建**（本地无 DDIC/SEGW 环境）。
本文是激活新功能的唯一前置清单；未完成前，相关 ABAP 类无法激活、
新函数导入无法调用，但旧链路完全不受影响（全部能力在开关之后）。

## 1. 功能开关（复用 ZAI_CHAT_CFG，不新建配置系统）

| CFGKEY | 默认 | 含义 |
|---|---|---|
| `TASK_CONTEXT_ENABLED` | 空=关 | 任务层总开关；关闭时任务/结果/上下文代码全部跳过 |
| `REPORT_READ_ENABLED` | 空=关 | 报表登记/参数/已有结果可见 |
| `REPORT_EXEC_ENABLED` | 空=关 | 报表执行（双重开关：全局 + 报表级 EXEC_ENABLED） |

打开顺序：TASK_CONTEXT → REPORT_READ → REPORT_EXEC（逐用户/逐环境灰度）。

## 2. SE11 新增表（7 张，激活顺序即编号顺序）

> 命名已避开已知 DDIC 保留字（MODE/ROWS/DOMAIN 的教训见 V13 踩坑档案）。
> 长文本用 SSTRING 或 STRING 由 P0 按系统实测定；MANDT 为首键。

### 2.1 ZAI_TASK（业务任务）
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| MANDT | CLNT 3 | PK | |
| TASK_ID | CHAR 32 | PK | GUID_32 |
| SESSION_ID | CHAR 32 | | 归属会话 |
| PARENT_TASK_ID | CHAR 32 | 可空 | 比较/派生任务 |
| MODULE_ID | CHAR 30 | | REPORT/INVENTORY/DATA/CODE/GENERAL |
| INTENT_CODE | CHAR 40 | | 结构化意图 |
| TITLE | CHAR 120 | | 用户可见标题 |
| STATUS | CHAR 20 | | 11 态任务状态 |
| OWNER | CHAR 12 | | 创建用户（归属事实源） |
| FOCUS_ARTIFACT_ID | CHAR 32 | 可空 | 当前聚焦结果 |
| CURRENT_VERSION | INT4 | | 乐观锁版本 |
| PENDING_JSON | STRING / SSTRING | | 待办参数 JSON（可重建） |
| SUMMARY_TEXT | STRING / SSTRING | | 面向模型摘要（非事实源） |
| CREATED_AT / CHANGED_AT | CHAR 14 | | YYYYMMDDhhmmss |

索引：SESSION_ID + OWNER + STATUS（活跃任务查询）；CHANGED_AT。

### 2.2 ZAI_TASK_MSG（任务-消息关联；不改 ZAI_CHAT_MSG 主键）
| 字段 | 类型 | 键 |
|---|---|---|
| MANDT | CLNT 3 | PK |
| TASK_ID | CHAR 32 | PK |
| MSG_SEQ | INT4 | PK |
| SESSION_ID | CHAR 32 | （防跨会话误关联） |
| ROLE | CHAR 12 | |
| RELEVANCE | CHAR 12 | CURRENT/SUMMARY/REFERENCE |
| CREATED_AT | CHAR 14 | |

### 2.3 ZAI_ARTIFACT（结果索引）
| 字段 | 类型 | 键 | 说明 |
|---|---|---|---|
| MANDT | CLNT 3 | PK | |
| ARTIFACT_ID | CHAR 32 | PK | |
| TASK_ID | CHAR 32 | | |
| SESSION_ID | CHAR 32 | | |
| ARTIFACT_TYPE | CHAR 30 | | REPORT_RESULT/TABLE_DATA/INVENTORY_RESULT/ANALYSIS |
| SOURCE_TYPE | CHAR 20 | | ZTABLE/QUERY/SNAPSHOT/INLINE |
| SOURCE_REF | CHAR 120 | | |
| REPORT_RUN_ID | CHAR 32 | 可空 | 报表结果必填（结果来源追溯） |
| DATASET_ID | CHAR 32 | 可空 | |
| LABEL | CHAR 120 | | |
| STATUS | CHAR 20 | | AVAILABLE/STALE/EXPIRED/DENIED |
| ROW_COUNT | INT4 | | |
| SCHEMA_JSON | STRING / SSTRING | | 字段/单位/敏感级 |
| SUMMARY_JSON | STRING / SSTRING | | 受控摘要 |
| CREATED_AT | CHAR 14 | | |
| EXPIRES_AT | CHAR 14 | 可空 | |
| OWNER | CHAR 12 | | 访问授权事实源 |

### 2.4 ZAI_RPT_DEF（报表登记）
REPORT_ID CHAR30 PK / TCODE CHAR20（大写, 唯一索引）/ PROGRAM CHAR40 /
REPORT_NAME CHAR120 / DESCRIPTION STRING / REPORT_KIND CHAR20 /
RESULT_MODE CHAR20 / RESULT_REF CHAR120 / EXEC_MODE CHAR12 /
READ_ENABLED CHAR1 / EXEC_ENABLED CHAR1 / ANALYZE_ENABLED CHAR1 /
MAX_ROWS INT4 / MAX_RUNTIME_SEC INT4 / ROLE_RULE STRING /
CONFIG_VERSION CHAR32 / ACTIVE CHAR1 / CREATED_AT / CHANGED_AT CHAR14

> TCode 不当 PROGRAM 用：先查登记，再核验程序（P0/SAP 端核实）。

### 2.5 ZAI_RPT_PARAM（报表参数）
REPORT_ID CHAR30 PK / CONFIG_VERSION CHAR32 PK / PARAM_ID CHAR30 PK /
ABAP_NAME CHAR30 / LABEL CHAR120 / DATA_TYPE CHAR20 / LENGTH INT4 /
DECIMALS INT4 / REQUIRED CHAR1 / MULTI_VALUE CHAR1 / RANGE_ALLOWED CHAR1 /
DEFAULT_TYPE CHAR20 / DEFAULT_VALUE STRING / ALLOWED_OPS CHAR120 /
VALUE_SOURCE CHAR20 / VALIDATION_RULE STRING（如 `GE:P_DATE_FROM`，后端可执行规则引用，不存模型代码）/
HELP_TEXT STRING / SORT_NO INT4 / ACTIVE CHAR1

### 2.6 ZAI_RPT_RUN（报表运行；参数/配置版本冻结点）
REPORT_RUN_ID CHAR32 PK / TASK_ID CHAR32 / REQUEST_ID CHAR32（唯一索引 =
幂等事实源）/ REPORT_ID CHAR30 / CONFIG_VERSION CHAR32 / TCODE CHAR20 /
PROGRAM CHAR40 / PARAMS_JSON STRING / PARAMS_HASH CHAR64（一致性哈希,
非安全哈希；P0 可换标准工具）/ STATUS CHAR20（CREATED/SUBMITTED/RUNNING/
READY/FAILED/TIMEOUT/UNKNOWN）/ SAP_JOB_NAME CHAR32 / SAP_JOB_NUMBER CHAR8 /
RESULT_ARTIFACT_ID CHAR32 / STARTED_AT / FINISHED_AT CHAR14 / ROW_COUNT INT4 /
ERROR_CODE CHAR40（脱敏）/ ERROR_MESSAGE STRING（脱敏）/ CREATED_BY CHAR12 / CREATED_AT CHAR14

### 2.7 ZAI_RPT_STEP（运行步骤审计）
REPORT_RUN_ID CHAR32 PK / STEP_NO INT4 PK / TASK_ID CHAR32 /
PHASE CHAR20（RESOLVE/VALIDATE/SUBMIT/POLL/RESULT/ANALYZE）/ STATUS CHAR20 /
ELAPSED_MS INT4 / SAFE_SUMMARY STRING（脱敏）/ CREATED_AT CHAR14

> 锁对象：ZAI_RPT_RUN 建议配 E 锁（防同 run 并发写状态）；
> ZAI_TASK 乐观锁靠 CURRENT_VERSION，可不建锁对象。P0 定。

## 3. SEGW 变更（项目 ZAI_CHAT）

### 3.1 ComplexType `AgentResult` 增加可选属性（全 Edm.String，可空）
`TaskId / TaskModule / TaskStatus / NeedsInput / PendingParamsJson / ArtifactRefsJson`
→ 对应 ZCL_AI_AGENT_SERVICE 的 ty_agent_result 新组件。
旧前端不读这些属性，零影响。

### 3.2 新增 ComplexType `GenericResult`（3 属性，全 Edm.String）
`Success / Message / ResultJson`
→ 供以下 7 个新函数导入统一返回（ResultJson 承载服务层 JSON，协议见 02 设计 §4.3）。

### 3.3 新增 Function Import（全部 POST，除注明）
| 名称 | 参数 | 返回 |
|---|---|---|
| AnalyzeTask | SessionId, Question, ModelId, TaskId, ClientRequestId, FocusedArtifactId | AgentResult |
| Tasks | SessionId | GenericResult |
| TaskContext | SessionId, TaskId | GenericResult |
| ReportDefinitions | （无） | GenericResult |
| StartReportRun | SessionId, TaskId, ReportId, ParamsJson, ClientRequestId | GenericResult |
| ReportRunStatus | ReportRunId | GenericResult |
| ReportResult | ArtifactId | GenericResult |
| TaskAction | SessionId, TaskId, Action | GenericResult |

DPC_EXT 的 execute_action 分发分支已全部实现；SEGW 生成 runtime 前
网关在 metadata 层拒绝这些调用（前端能力探测自动回退旧 AnalyzeAgent）。

## 4. 激活顺序（部署步骤）

1. SE11：按 2.1 → 2.7 顺序建表并激活（含索引）。
2. SE24：按依赖顺序贴类/激活（对齐踩坑清单 §2.5）：
   `ZCL_AI_TASK_SERVICE` → `ZCL_AI_REPORT_SERVICE`（MOCK 引用其常量与
   parse_flat_kv，**必须先于 MOCK**）→ `ZCL_AI_REPORT_MOCK` →
   `ZCL_AI_INTENT_ROUTER` → `ZCL_AI_TOOL_REGISTRY`（重贴）→
   `ZCL_AI_AGENT_SERVICE`（重贴）→ `ZCL_ZAI_CHAT_DPC_EXT`（重贴）。
   或全贴完统一激活。
3. SEGW：3.1/3.2/3.3 → Generate Runtime → 重新发布服务。
4. 配置：ZAI_CHAT_CFG 维护三个开关（默认全部关闭）。
5. 冒烟：按 03 清单逐场景验证；REPORT_EXEC_ENABLED 保持关闭直至
   P0/SAP 侧核验完成。

### 4.1 重贴核对标记（踩坑清单 §2.6：贴后先 grep 再激活）

| 类 | grep 标记 |
|---|---|
| ZCL_AI_TASK_SERVICE | `TASK_CONTEXT_ENABLED`（task_enabled 方法内）；全文无 `name_values`/`low_case` |
| ZCL_AI_REPORT_SERVICE | `parse_flat_kv`（实现+2 处调用）；无 `CONV x1`；norm_json 为手工拼装扁平对象 |
| ZCL_AI_REPORT_MOCK | `zcl_ai_report_service=>parse_flat_kv`（read_scenario 内） |
| ZCL_AI_INTENT_ROUTER | "表"规则在 quick_route 内先于执行规则 |
| ZCL_AI_TOOL_REGISTRY | `get_tools_for_module`；INVENTORY 分支无 `run_sql` |
| ZCL_AI_AGENT_SERVICE | `build_report_intro`、`finish_det`（定义+实现各 1）；保留既有 `iv_max = 10 / iv_max = 180` |
| ZCL_ZAI_CHAT_DPC_EXT | `to_agent_odata`（2 调用+1 实现）、`to_generic_odata`（7 调用+1 实现）、`ty_agent_odata` |

## 4.2 传输到 QAS（踩坑清单 §3.E 增量）

- SICF 节点 /default_host/sap/opu/odata/sap/zai_chat_srv 手工激活（未激活=401 循环，不是密码问题）。
- /IWFND/MAINT_SERVICE：服务注册 + 系统别名 LOCAL（RFC 目标 NONE）复核。
- Generate Runtime 后**先用 Gateway 客户端验证 $metadata 全字段回显**
  （重点：AgentResult 新属性 TaskId/TaskModule/... 与 GenericResult
  Success/Message/ResultJson；带下划线字段全空 = §2.3 坑指纹复发）。
- SM30：TASK_CONTEXT_ENABLED / REPORT_READ_ENABLED / REPORT_EXEC_ENABLED
  三个配置键在 QAS 重新维护（**配置数据不随传输走**），逐环境灰度。
- 激活后跑一轮真实请求，看 /IWFND/ERROR_LOG 无新 CX 错误。

## 5. 必须在 SAP 端确认的阻塞项（本地无法验证）

| # | 事项 | 影响对象 |
|---|---|---|
| 1 | 7 张表的 DDIC 激活、长文本字段类型（STRING vs SSTRING）、索引与锁对象 | 全部新表 |
| 2 | SEGW 生成 runtime 后函数导入参数/返回绑定实测 | DPC_EXT |
| 3 | `/ui2/cl_json=>name_values`/`name_value` 类型与 `generate` 对嵌套的行为实测 | REPORT_SERVICE |
| 4 | 真实试点报表的 TCode/程序/选择屏幕字段/结果表关联方式 | ZAI_RPT_DEF/PARAM 维护数据 |
| 5 | S_TCODE、程序执行、后台作业用户与 SUBMIT VIA JOB 行为、sy-tcode 依赖 | 真实执行适配器（未实现，当前只有 Mock） |
| 6 | 结果表是否按运行分区/被 GUI 覆盖写（结果准确性前提） | 结果分析开放条件 |
| 7 | ICM PROCTIMEOUT ≥ 200s（Agent 预算 180s 的前提，V13 已知项复认） | AGENT_SERVICE |
| 8 | 内部模型真实 ID/预算/JSON 稳定性 | 预算配置 |

> **Mock 边界声明**：`ZCL_AI_REPORT_MOCK` 与 test-server 的执行链路是
> 测试 double，契约与未来真实适配器一致；Mock 通过**不能**证明真实
> SAP 权限、后台作业和结果锁正确。真实适配器（SUBMIT WITH
> SELECTION-TABLE + 结果表关联）为 P0 后的下一段工作。
