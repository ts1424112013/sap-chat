# 灵犀 LingXi · SAP AI 对话助手 · 项目总览

> **本文件是项目的"当前位置"——新会话从这里开始读。**
> 最后更新：2026-10-27（权限字段映射新增随机值，前后端配套更新）。历史版本明细见 [CHANGE-HIGHLIGHTS.md](CHANGE-HIGHLIGHTS.md)（仅存档）。

---

## 一、这是什么

基于 **SAP UI5 (1.130 / 随包自带 + sap_horizon)** 的企业内 AI 对话应用，对接 ABAP OData 服务（`ZAI_CHAT_SRV`）与企业内大模型网关（OpenAI 兼容）。**两种工作模式**：「💬 对话」直接上下文问答（源码/表分析、角色、附件）；「✦ Agent」**通用对话化编排**——每条消息先理解和规划，按需调用受控工具（库存只读工具为首个工具域），检查后回答，回复附"已思考 N 秒"阶段摘要卡。视觉基准：`功能计划书/assets/对话与通用Agent模式_UI设计图_V1.1_20260927.png`。

**当前品牌**：灵犀 LingXi。彩色叶翼统一用于登录、侧栏、首页、聊天头像和浏览器图标；等待、输出/后台运行、结束分别对应思考、运行、静止三态。品牌资源与构建说明见 `docs/04-前端实施文档.md` 〇-I。

**参数确认体验**：取数与报表参数卡在说明文字完整输出后再展示，不自动抢输入焦点，也不把正在阅读的说明滚走。

**权限随机字段**：权限表配置和事务码规则的字段映射可选「随机值」，按字段长度生成 CHAR 字符串或 NUMC 数字。代码与本地验证完成，SAP 待激活验证；部署需重贴 `ZCL_AI_AUTH_SERVICE` V1.4 并更新前端，步骤见《03》〇-J /《04》〇-K。

## 二、当前阶段——一句话版

> **全链路已在服务器跑通**（2026-09-05 实装验证）：服务器部署 ✅ → SAP 网关登录 ✅ → 应用级登录 ✅ → 聊天 ✅ → 表数据查询 ✅。
> **V13 通用 Agent 对话化（2026-09-27）**：按《功能计划书/AI对话助手_通用Agent对话化改造_开发计划_V1.1》完成——Agent 不再选类型，点击即进入与对话一致的聊天页；左侧模式按钮改为横向分段控件；Agent 回复带思考状态与阶段摘要卡；后端 AnalyzeAgent 升级为通用编排（无工具问题直接分析回答、库存工具按意图加载、summary 协议、阶段 Trace）。**代码完成、待服务器实施**（后端 4 个类覆盖粘贴，无新增 SE11/SEGW，见 `backend-abap/SAP-AI-BACKEND-AGENT-MANUAL-V1.md` §十；前端需重新构建部署）。

| 模块 | 状态 |
|---|---|
| UI 简约版 V2 对齐 + 渐变画布 + 泡泡浮动 | ✅ 完成 |
| 强制登录框 / ADMIN/USER 权限分流 / 用户管理 | ✅ 前后端完成 |
| 常连后端：config.js 事实源 + 启动探测 + 不可达降级演示模式 | ✅ 完成 |
| 表数据分析：条件取样（字段=值 / 前 N 行，50 行/16KB 护栏，V8.4 修复） | ✅ 完成 |
| ABAP V8 接口（Login/Roles/Prompts/Users/Config） | ✅ 服务器已发布 |
| 部署 | ✅ 方案 A（SAP BSP 同域）已实施，日常走增量部署 |
| **V10 代码提取管控**（模型级两开关：「源码分析」+「USER 禁看源码」，逐模型独立配置） | ✅ 代码完成，待服务器实施（docs/03 第十一章） |
| **V10 智能路由**（下拉 AUTO 按任务选模型 + 故障自动切换兜底） | ✅ 代码完成，待服务器实施 |
| **V10 超长源码分块分析**（>6000 行分段摘要级联，开关默认关） | ✅ 代码完成，待服务器实施 |
| **V10 表样例指定字段列**（「表 MARA 的 MATNR,MTART」→ SELECT 指定列） | ✅ 代码完成，待服务器实施 |
| **V10 Markdown 增强**（表格渲染 + 图片显示/lightbox；代码高亮与一键复制 V9 已有） | ✅ 完成 |
| **V10 会话管理增强**（重命名 / 置顶 / 搜索；删除 V4 已有） | ✅ 代码完成，待服务器实施 |
| **V11 库存分析 Agent**（AnalyzeAgent 受限循环：白名单 4 工具 + JSON 协议 guard + 领域知识卡 + 审计 + 前端 Trace 折叠区） | ✅ 代码完成，待服务器实施 |
| **V12 对话/Agent 模式分离**（左侧模式导航 · 会话级 Mode/AgentType/Status · 接口双向模式校验 · Agent 类型卡片 + 任务状态徽标 · sendByMode 统一入口） | ✅ 代码完成，待服务器实施 |
| **V13 通用 Agent 对话化**（横向分段模式控件 · Agent 免选类型直接聊天 · 思考状态 + "已思考 N 秒"阶段摘要卡 · 后端通用编排/按需工具域/summary 协议/阶段 Trace） | ✅ 代码完成，待服务器实施 |

## 三、你（SAP 端）接下来要做什么

**V13 通用 Agent 升级待实施（2026-09-27）**：**无新增 SE11/SEGW 改动**——SE24 覆盖粘贴 4 个类（`ZCL_AI_TOOL_REGISTRY`→`ZCL_AI_DOMAIN_CARDS`→`ZCL_AI_AGENT_GUARD`→`ZCL_AI_AGENT_SERVICE`）→ 前端 `npm run build` 增量上传。步骤见 `backend-abap/SAP-AI-BACKEND-AGENT-MANUAL-V1.md` §十。

**V12 模式分离升级待实施（2026-09-27，V16 保留字修正）**：SE11 给 `ZAI_CHAT_SESS` 追加 `SESSION_MODE/AGENT_TYPE/STATUS/PARENT_SESSION_ID`（⚠️ 字段名不能叫 MODE/DDIC 保留字，`ZAI_AGENT_RUN.ROUTE_DOMAIN`、`ZAI_AGENT_STEP.ROW_CNT` 同理）→ SEGW 给 Sessions 实体加 `Mode/AgentType/Status` 属性（Mode 映射 ABAP 字段 SESSION_MODE）并重新生成运行时 → SE24 覆盖 `ZCL_AI_CHAT_SERVICE`/`ZCL_AI_AGENT_SERVICE`/`ZCL_ZAI_CHAT_DPC_EXT`。见同一手册 §五/§九（V13 在其上叠加，一次实施可同时到位）。

**V11 Agent 升级待实施（2026-09-26）**：SE11 建 `ZAI_AGENT_RUN`/`ZAI_AGENT_STEP` 两张审计表 → SE24 贴 5 个新类 → SEGW 加 `AgentResult` ComplexType + `AnalyzeAgent` 函数导入。见同一手册 §一~§四。

**V10 升级待实施（2026-09-10）**：先 SE11 给 `ZAI_MODEL_CFG` 加 `SKIP_SOURCE`、`ZAI_CHAT_SESS` 加 `PINNED` → SE24 贴三个类（`ZCL_AI_CODE_PROVIDER`/`ZCL_AI_CHAT_SERVICE`/`ZCL_ZAI_CHAT_DPC_EXT`）→ SEGW 加属性与 `UpdateSession` FI → 前端构建增量上传。手把手步骤见 `docs/03-后端实施文档.md` 第十一章。

其余改动按类型走对应流程：

- 改前端 → `docs/04-前端实施文档.md`（构建 → 增量 zip → SE38 上传 → preload 标记校验）；
- 改后端 → SE24 整类重贴激活 + `/IWFND/GW_CLIENT` 回归（`docs/03-后端实施文档.md` 第七章）；
- 新环境（测试/生产库）发布 → 后端 03 第九章 + 前端 04 第五章各走一遍；
- 功能待办（tcode 参数事务、表样例指定字段列、RAW 授权模式等）见 `docs/01-后端开发文档.md` §7.3。

## 四、认证与权限模型（V8 核心）

- **登录账号 = SU01 用户，密码 = 网关密码**。前端登录框把账密以 Basic 打 `/Login`，
  网关验密（SU01 策略：锁定/复杂度/改密周期全部继承），业务侧只查授权表 `ZAI_CHAT_USER`。
- 同一账密自动注入后续 OData 请求 → **不再弹 SAP 账密框**。
- 两级角色：`ADMIN`（泡泡/角色/模型/用户/后端地址全部可维护）、`USER`（只读使用）。
  前端隐藏 + 后端 `v8_require_admin` 硬校验双保险。
- 本地初始管理员 `admin/123456`：仅"后端未配置（INITIALIZED≠X）"窗口可用，
首次登录强制改密；后端地址配置成功后**永久失效**。完整风险评估已并入
[docs/01-后端开发文档.md](docs/01-后端开发文档.md)（V8 权限体系设计一节）。

## 五、文档地图（2026-09-06 整理版）

> **当前正式文档只有五篇**（`docs/` 目录），按编号阅读。历史版本（V1.0~V2.1 各版手册、
> 设计文档与快照）已全部并入这五篇并于 2026-09-06 清理删除；版本沿革流水保留在
> [CHANGE-HIGHLIGHTS.md](CHANGE-HIGHLIGHTS.md)。

| 文档 | 用途 |
|---|---|
| `docs/00-项目说明文档.md` | **从这里开始**：项目介绍、架构全景、功能清单、与纯 ABAP Tcode 对话框方案的差异、版本演进史 |
| `docs/01-后端开发文档.md` | 后端设计与代码结构：7 表/12 接口/4 类、analyze 主流程、协议细节、坑档案、扩展指南 |
| `docs/02-前端开发文档.md` | 前端工程与代码结构：启动链路、服务层/控制器方法地图、V8.1~V8.3 联调补丁、构建机制 |
| `docs/03-后端实施文档.md` | 后端从零安装：SE11→SEGW→SE24→SM59→SICF→验证清单→传输发布（手把手） |
| `docs/04-前端实施文档.md` | 前端构建部署：构建自检→打 zip→SE38 上传（全量/增量）→SICF→验证→回滚（手把手） |
| `BACKEND-DEBUG-NOTES.md` | 联调排查方法论与现行注意事项（现行版，保留根目录） |
| `CHANGE-HIGHLIGHTS.md` | 全版本改动流水（存档） |
| `backend-abap/*.abap` | 后端全量源码（V11 起 9 个类：原 4 类 + Agent 5 新类；ZAI_CHAT_V8_ADMIN 为已并入的存档说明） |
| `backend-abap/SAP-AI-BACKEND-AGENT-MANUAL-V1.md` | **V11 Agent 后端实施手册**：审计表建表、SEGW 契约、安装顺序、安全与验收对照 |
| `功能计划书/AI对话助手_库存场景走查与Agent工具借鉴_20260921_草稿V1.md` | Agent 方案唯一事实源（工具边界/权限/验收口径） |

## 六、本地运行

```bash
npm install        # 首次
npm start          # http://localhost:8080（V9.4 起 UI5 与 highlight.js 均随包本地加载，离线可用）
```

- **演示模式（mock）**：不请求任何服务；会话/角色/泡泡落浏览器 localStorage；登录框走本地校验（admin/123456 或"演示身份进入"）。
- **后端模式**：默认。启动时按 `webapp/config.js` 探测后端：可达→真实登录；不可达→**自动降级演示模式**（提示条说明），保证任何时候打开都能看到界面。
- **环境切换**：改 `webapp/config.js` 的 host/path 后重新部署；设置对话框的修改仅本次会话有效。
- 构建发布：`npm run build`（产物在 `dist/`）。

## 七、V8 前端行为速查（调试用）

- 登录态：`localStorage["zaiChat-appUser"]`；初始管理员改密 hash：`zaiChat.adminPwdHash`
- 登录失败锁定：`zaiChat.loginLockTs`（5 次失败锁 60 秒）
- 权限判定：`ChatService.isAdmin()` → 控制器 `_syncAdminUi()` 统一刷新可见性
- 角色数据：`chat>/roles`；泡泡数据：`chat>/quickPrompts`（均经 ChatService 读写后端/mock）
- 后端 Function Import 契约：统一返回 `{ d: { Success, Message, Json } }`，列表数据是 Json 文本；POST 参数为 form-urlencoded
