# AI 对话助手：对话模式与 Agent 模式分离开发计划

> 版本：V1.0
>
> 日期：2026-09-27
>
> 状态：可交给 ZCode 开发的功能计划书
>
> 适用项目：`/Users/tangtang/Desktop/AIProject/sap-chat`

## 1. 需求背景

当前系统已经存在一个 `agentMode` 字段，以及 `AnalyzeCode`（普通对话）和 `AnalyzeAgent`（库存分析 Agent）两条调用路径，但用户界面仍然把 Agent 当作输入框旁的“库存分析”开关。这样会带来三个问题：

1. 用户不容易理解当前到底处于哪种工作方式。
2. 普通对话和 Agent 任务混在同一个会话中，容易误把上下文、角色、附件或历史消息带到另一种工作方式。
3. 未来新增采购 Agent、销售 Agent、开发 Agent 时，底部按钮会不断堆叠，无法形成统一的产品结构。

本需求将系统设计为两种清晰的工作模式：

- **对话模式（Chat）**：类似普通 AI 聊天，重点是连续上下文、角色、附件和自然语言问答。
- **Agent 模式（Agent）**：类似 Codex 的任务执行模式，重点是目标、计划、工具调用、过程、结果和可追溯性。

附件图片仅作为界面方向参考：第一张图参考 SAP AI 的品牌和左侧历史会话结构；第二张图参考“不同工作模式位于左侧导航、当前模式有明显选中态”的产品结构。图片中的文案、布局和交互不需要原样复制。

## 2. 产品决策

### 2.1 推荐交互：左侧模式导航 + 模式内会话列表

左侧导航固定展示两个一级入口：

```text
SAP AI

工作模式
  💬 对话
  ◇ Agent

+ 新建对话 / 新建任务

当前模式的历史记录
  搜索
  会话列表
```

右侧顶部显示当前模式和当前会话名称，例如：

```text
对话模式                         Agent 模式
普通上下文对话                   库存分析 Agent · 已完成
```

不建议只使用一个“模式切换开关”。模式开关适合临时功能，而本需求中的两种模式已经是不同的产品工作流，应该像第二张图中的 Chat / Agent 一样成为可进入的一级入口。

### 2.2 模式是会话级属性，不是全局临时状态

每个会话创建时就确定 `mode`：

```text
mode = CHAT       对话模式
mode = AGENT      Agent 模式
```

进入已有会话时，必须以会话保存的 `mode` 为准恢复页面。不能因为用户上一次在 Agent 模式，打开一个旧的普通对话就继续以 Agent 方式发送。

### 2.3 Agent 首期继续使用库存 Agent，但产品名称不再写死为“库存分析”

首期 Agent 能力只有库存分析，这是后端已有 `AnalyzeAgent` 的实际能力。界面统一称为“Agent”，在 Agent 首页和新建任务入口展示可用 Agent：

```text
Agent
  库存分析（已可用）
  更多 Agent（规划中）
```

用户选择“库存分析”后，创建一个 `mode=AGENT`、`agentType=INVENTORY` 的 Agent 任务会话。将来增加采购或销售 Agent 时，沿用同一套模式和会话框架，不再新增另一套聊天页面。

## 3. 两种模式的行为边界

| 项目 | 对话模式 | Agent 模式 |
|---|---|---|
| 目标 | 连续问答、解释、写作、代码讨论 | 完成一个可执行的分析或业务任务 |
| 上下文 | 使用当前会话的自然语言历史 | 使用任务目标、计划、工具结果和最终报告 |
| 后端入口 | `AnalyzeCode` | 首期 `AnalyzeAgent` |
| 角色选择 | 支持 | 首期隐藏或禁用，避免干扰 Agent 计划和槽位抽取 |
| 文本附件 | 支持 | 首期不支持；后续改为 Agent 输入材料 |
| 工具调用 | 不主动调用业务工具 | 由受控工具注册表决定是否调用 |
| 过程展示 | 不展示内部推理，仅展示回答 | 展示安全的步骤摘要、工具名、状态、耗时和结果摘要 |
| 输出 | 普通回答 | 任务报告、状态、Trace 和后续建议 |
| 停止 | 停止前端流式展示 | 取消前端等待；后端运行是否可取消按后续能力处理 |
| 历史 | 对话历史 | Agent 任务历史，显示任务状态 |

安全要求：无论哪种模式，都不能把模型的内部思维链原文展示给用户。Agent 只返回允许展示的步骤摘要和审计字段。

## 4. 页面设计

### 4.1 左侧边栏

保留当前 SAP AI 品牌区和历史会话区，在“新对话”上方新增工作模式区。

推荐控件：

- `modeNav`：模式导航容器。
- `chatModeNav`：对话入口。
- `agentModeNav`：Agent 入口。
- `newSessionBtn`：根据当前模式显示“新建对话”或“新建 Agent 任务”。
- `sessionSearch`：只搜索当前模式的会话；如需要全局搜索，另加“全部模式”筛选。
- `sessionList`：显示当前模式的会话。

会话列表项至少显示：标题、更新时间、模式图标；Agent 还显示任务状态（进行中 / 已完成 / 部分完成 / 失败）。

### 4.2 顶部工作区

顶部显示当前模式标签，不使用含义不清的通用“模式”徽标：

- 对话模式：`💬 对话`
- Agent 模式：`◇ Agent`
- Agent 类型：`库存分析`

Agent 会话右上角增加“查看任务信息”入口，展示任务类型、创建时间、模型、状态和 Trace 是否可用。

### 4.3 对话模式空状态

沿用当前第一张图和现有首页结构：居中欢迎语、输入框、快捷提示、角色选择、附件按钮。

输入区不再放“库存分析”按钮；模式已经由左侧导航确定，避免用户以为一次发送可以临时改变会话模式。

### 4.4 Agent 模式空状态

进入 Agent 一级入口但尚未创建任务时，展示 Agent 类型卡片：

```text
选择一个 Agent

[库存分析]
查询工厂、物料的库存快照、当天收发和批次信息
只读 · 需要 SAP 库存权限
```

点击卡片后创建 Agent 会话，并将输入区切换为任务输入：

```text
描述你要完成的任务，例如：
分析 0001 工厂 A001 物料今天的库存和收发
```

### 4.5 Agent 对话页

消息区域采用“任务报告 + 过程摘要”的结构：

```text
任务目标
分析 0001 工厂 A001 物料当天库存

执行状态：已完成 · 3 步 · 12.4 秒

最终报告
...

[查看执行过程]
  1. 解析物料与工厂
  2. 查询当前库存快照
  3. 查询当天收发
```

过程只显示白名单信息：步骤标题、工具 ID 的用户友好名称、成功/失败、行数、耗时和必要的错误说明。不要显示完整 Prompt、系统指令、模型内部推理或敏感原始数据。

## 5. 前端数据模型

### 5.1 当前全局模型调整

现有：

```js
agentMode: false
```

改为：

```js
workspaceMode: "CHAT",       // "CHAT" | "AGENT"
agentType: "",               // 首期 "INVENTORY"
currentSession: {
    id: "",
    mode: "CHAT",
    agentType: "",
    status: "IDLE"
},
sessions: [],
modeSessions: {
    CHAT: [],
    AGENT: []
}
```

为兼容旧代码，可在迁移期间保留：

```js
agentMode: workspaceMode === "AGENT"
```

但新代码禁止直接以 `agentMode` 作为唯一业务判断。

### 5.2 会话对象

前端统一使用以下字段：

```json
{
  "SessionId": "...",
  "Title": "0001 工厂 A001 库存分析",
  "Mode": "AGENT",
  "AgentType": "INVENTORY",
  "Status": "COMPLETED",
  "MessageCount": 2,
  "UpdatedAt": "2026-09-27T10:30:00+08:00",
  "CreatedBy": "USER"
}
```

旧会话没有 `Mode` 时按 `CHAT` 处理，保证历史数据可继续打开。

## 6. 前端开发改动

### 6.1 `webapp/view/App.view.xml`

1. 在左侧品牌区和新建按钮之间增加模式导航。
2. 将现有 `agentToggleHero`、`agentToggleDock` 移除，或在过渡版本隐藏，不再作为主入口。
3. 新增 Agent 首页卡片和 Agent 类型选择区域。
4. 右侧顶部增加当前工作模式标识。
5. Agent 消息项支持状态摘要、执行步骤折叠区和任务状态。
6. 保持首页输入区和对话输入区共用同一个 `chat>/input`，但根据 `workspaceMode` 切换文案和控件。

### 6.2 `webapp/controller/App.controller.js`

新增或改造以下方法：

```text
onSelectWorkspaceMode(event)
onNewChatSession()
onNewAgentTask(event)
_loadSessionById(sessionId)
_restoreWorkspaceBySession(session)
_filterSessionsByMode()
_sendChatMessage(payload)
_sendAgentTask(payload)
_confirmModeSwitchIfNeeded()
```

`onSend` 只负责收集输入、判断当前会话类型和调用分流方法，不再通过一个布尔值承担所有模式逻辑。

模式切换规则：

- 没有输入、没有未完成请求时，直接切换。
- 有未发送内容时，弹出确认：“切换模式后当前输入仍保留，是否继续？”
- 有进行中的请求时，禁止直接切换，先提示停止或等待。
- 切换模式不清空另一模式的历史，但创建新会话时必须使用目标模式。
- 打开历史会话时，以会话自身的 `Mode` 恢复模式，不以当前全局模式覆盖。

### 6.3 `webapp/service/ChatService.js`

保留现有方法以兼容：

```js
send(payload)       // 普通对话
sendAgent(payload)   // 首期库存 Agent
```

新增统一入口：

```js
sendByMode({
    mode: "CHAT" | "AGENT",
    agentType: "INVENTORY",
    sessionId,
    question,
    modelId
})
```

统一入口内部路由到现有 `send` 或 `sendAgent`。这样后续新增 Agent 类型时，控制器不需要继续增加 `if/else`。

## 7. 后端接口与数据契约

### 7.1 Sessions 接口

现有 `Sessions` 返回结果需要新增：

```text
Mode
AgentType
Status
```

兼容策略：

- 数据库字段为空时返回 `CHAT`。
- 老会话不补写也能正常打开。
- 新建会话时由前端传入模式，后端再次校验并保存。

### 7.2 普通对话

继续使用：

```text
AnalyzeCode(SessionId, Question, ModelId, ProgramName)
```

后端必须校验会话 `Mode=CHAT`。如果普通接口收到 Agent 会话 ID，应返回明确错误，不允许静默改变模式。

### 7.3 Agent 任务

短期继续使用：

```text
AnalyzeAgent(SessionId, Question, ModelId)
```

后端必须校验：

- 会话 `Mode=AGENT`。
- `AgentType=INVENTORY`。
- 用户具有相应工厂和库存数据权限。
- Agent 最大轮数、总耗时、工具数量和结果大小符合现有 Agent 方案。

后续可演进为：

```text
RunAgent(SessionId, AgentType, Goal, ModelId)
```

但不作为本期必做项，避免一次改动同时影响现有 `AnalyzeAgent` 联调。

### 7.4 新建会话接口

如果现有系统没有独立的新建会话接口，可以先在首次发送时创建；但首次发送必须携带模式字段，建议扩展现有会话保存逻辑：

```json
{
  "SessionId": "...",
  "Mode": "AGENT",
  "AgentType": "INVENTORY",
  "Title": ""
}
```

## 8. 数据库改动建议

在现有 `ZAI_CHAT_SESS` 增加字段：

| 字段 | 类型建议 | 默认值 | 说明 |
|---|---|---|---|
| `MODE` | CHAR(10) | `CHAT` | `CHAT` / `AGENT` |
| `AGENT_TYPE` | CHAR(30) | 空 | Agent 类型，如 `INVENTORY` |
| `STATUS` | CHAR(20) | `IDLE` | 对话可用；Agent 为任务状态 |
| `PARENT_SESSION_ID` | CHAR(64) | 空 | 预留任务拆分或子任务，不作为本期功能 |

已有 `ZAI_AGENT_RUN`、`ZAI_AGENT_STEP` 继续用于 Agent 运行审计，不要把 Trace 明细全部塞进普通消息正文。

数据库迁移要求：

1. 老数据 `MODE` 为空时按 `CHAT` 读取。
2. 新建字段后先完成读兼容，再切换写入。
3. 不删除、不重建已有会话和消息数据。

## 9. 权限与安全要求

- 模式切换本身不代表权限提升。
- Agent 的每个工具仍由后端白名单、参数 Schema、业务授权和审计控制。
- 前端隐藏按钮不能作为权限控制。
- 普通对话不能通过提示词要求后端执行 Agent 工具。
- Agent 不能通过用户输入修改 `Mode`、`AgentType` 或工具白名单。
- Trace 中的物料、库存数量和用户信息按现有数据权限和脱敏规则返回。
- 任务失败时返回可解释状态，不返回 ABAP 堆栈、网关密钥或内部 Prompt。

## 10. 分阶段开发计划

### P0：数据和交互基础

1. 确认两种模式的命名、图标、颜色和状态文案。
2. 给 `ZAI_CHAT_SESS` 增加 `MODE`、`AGENT_TYPE`、`STATUS`。
3. Sessions 接口增加字段，老会话兼容为 `CHAT`。
4. 前端增加左侧模式导航、当前模式徽标和模式内历史过滤。
5. 去掉“库存分析”底部切换按钮作为主入口。

验收：打开旧会话仍显示为对话模式；从 Agent 入口新建会话后不会复用普通对话的会话 ID。

### P1：前后端分流

1. `onSend` 改用 `sendByMode`。
2. 普通会话调用 `AnalyzeCode`，Agent 会话调用 `AnalyzeAgent`。
3. 两个接口增加会话模式校验。
4. Agent 首页增加库存分析卡片。
5. Agent 会话增加任务状态和 Trace 折叠区。
6. `agentMode` 仅作为兼容字段，停止新增对它的直接依赖。

验收：同一用户可以同时拥有普通对话和库存 Agent 任务；错误的接口与会话组合会被后端拒绝。

### P2：体验完善

1. Agent 任务支持重新运行、复制任务目标和继续追问。
2. Agent 历史支持按状态筛选。
3. Agent 类型卡片支持配置化读取，不把类型写死在 XML。
4. 补充加载、超时、部分完成、无权限、空结果等状态。
5. 增加前端回归测试和后端接口测试。

### P3：扩展 Agent 类型

只有在库存 Agent 稳定后，才增加采购、销售或开发 Agent。新增类型必须复用：

```text
同一会话模型 + 同一 Agent 入口 + 同一状态模型 + 同一 Trace 展示 + 独立工具白名单
```

## 11. 验收标准

### 11.1 对话模式

- 新建对话默认 `Mode=CHAT`。
- 支持普通上下文、角色和文本附件。
- 发送请求只调用 `AnalyzeCode`。
- 对话历史不会显示为 Agent 任务。
- 打开旧会话无需迁移即可继续使用。

### 11.2 Agent 模式

- 从 Agent 入口选择“库存分析”后创建 `Mode=AGENT`、`AgentType=INVENTORY` 会话。
- 发送请求只调用 `AnalyzeAgent`。
- 页面显示任务状态、最终回答和安全的步骤摘要。
- Agent 不携带普通模式的角色前缀和附件内容。
- Agent 的超时、无权限、空数据和工具错误均有明确结果。

### 11.3 隔离性

- 从对话切换到 Agent 不会改变原对话的模式。
- 从 Agent 打开普通历史会话时，页面自动恢复到对话模式。
- 普通接口不能处理 Agent 会话，Agent 接口不能处理普通会话。
- 页面刷新后能恢复当前会话和正确模式。
- 左侧列表按当前模式显示，搜索结果不会把两种会话混在一起。

## 12. ZCode 开发顺序与文件清单

建议 ZCode 按以下顺序实现：

1. 后端数据库字段和 Sessions 返回字段。
2. `ZCL_ZAI_CHAT_DPC_EXT` 的 Sessions 映射及模式校验。
3. `ChatService.js` 的 `sendByMode` 兼容封装。
4. `App.controller.js` 的会话恢复、模式选择、发送分流。
5. `App.view.xml` 的左侧模式导航、Agent 首页卡片和输入区状态。
6. `style.css` 的模式导航、选中态、Agent 状态和 Trace 样式。
7. `i18n.properties` 的中英文文案。
8. Mock 模式同步支持两种会话，避免前端无法本地验收。
9. 完成 P0/P1 验收用例后，再进行 P2 体验优化。

重点文件：

```text
webapp/view/App.view.xml
webapp/controller/App.controller.js
webapp/service/ChatService.js
webapp/css/style.css
webapp/i18n/i18n.properties
backend-abap/ZCL_ZAI_CHAT_DPC_EXT.abap
backend-abap/ZCL_AI_AGENT_SERVICE.abap
```

## 13. 开发约束

- 不要重写现有普通对话链路；先做会话模式字段和路由分离。
- 不要把 Agent 设计成一个前端按钮的更多分支；必须以会话 `Mode` 为最终依据。
- 不要把普通对话历史自动转换成 Agent 任务。
- 不要在前端实现权限判断或工具选择。
- 不要展示模型内部思维链。
- 不要因为本次需求删除现有 `AnalyzeAgent`、`ZAI_AGENT_RUN`、`ZAI_AGENT_STEP` 或现有 Trace 能力。
- 新增或修改功能计划书统一放在：

```text
/Users/tangtang/Desktop/AIProject/sap-chat/功能计划书
```

建议命名格式：

```text
AI对话助手_<功能主题>_开发计划_V<版本>_<YYYYMMDD>.md
```

## 14. 本期最终方案一句话

**把“对话”和“Agent”设计成两个有独立历史、独立会话状态和独立后端链路的工作模式；首期 Agent 复用现有库存分析能力，后续通过 Agent 类型扩展，而不是继续堆叠输入框开关。**
