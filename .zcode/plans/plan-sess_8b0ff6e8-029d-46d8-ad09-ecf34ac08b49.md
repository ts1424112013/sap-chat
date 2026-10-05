# SAP AI 对话助手 · V10 功能升级实施计划

## 需求 → 方案总览

| # | 需求 | 落点 |
|---|---|---|
| 1a | 模型级开关：该模型不做源码解析 | ZAI_MODEL_CFG 加 `SKIP_SOURCE` 字段，模型编辑对话框加复选框，analyze 时跳过源码提取 |
| 1b | USER 不看代码、IT 看代码 | 全局开关 `CODE_ACL`（存 ZAI_CHAT_CFG），模型管理页顶部 Switch，仅 ADMIN 可改；开启后 USER 提问程式/tcode 只注入程序元信息（名称/类型/TRDIRT 标题），模型讲用途不给代码；ADMIN 不受限；TABL/VIEW 表分析不受此管控 |
| 2 | 对话框显示模型返回的图片 | Formatter 支持 `![alt](url)`（http/https/data:image），带点击放大 lightbox |
| 痛点1 | 超长源码分块分析 | 全局开关 `LONG_SRC_CHUNK`（默认关，同放模型管理页）；开启后 >6000 行源码按 2000 行/块（最多 5 块）先逐块摘要再级联作答 |
| 痛点2 | 表样例指定字段列 | 解析「表 MARA 的 MATNR,MTART」→ DD03L 白名单校验 → SELECT 指定列，样例行数提升 |
| 痛点3 | Markdown 增强 | 表格渲染（新增）+ 代码高亮/一键复制（已有，保留打磨）+ 图片（#2） |
| 痛点4 | 会话重命名/删除/搜索/置顶 | ZAI_CHAT_SESS 加 `PINNED`；新 FI `UpdateSession`；前端列表加按钮 + 搜索框 |
| 痛点5 | 多模型智能路由 | 模型下拉加「智能路由」默认项（ModelId=AUTO）：后端检测到代码/表对象选"源码分析型"模型，闲聊走默认模型；LLM 调用失败自动换下一个启用模型兜底并在回复中注明 |

---

## 一、后端改动（backend-abap/，交付可直接 SE24 粘贴的全量类源码）

### 1. DDIC 表（SE11 手工加字段，写入实施文档）
- `ZAI_MODEL_CFG` + `SKIP_SOURCE CHAR1`（X=该模型不用于源码分析）
- `ZAI_CHAT_SESS` + `PINNED CHAR1`（置顶标记）
- `ZAI_CHAT_CFG` 不动：新增两个 key：`CODE_ACL`、`LONG_SRC_CHUNK`（值 X=开启）

### 2. ZCL_AI_CODE_PROVIDER.abap
- `get_source` 加可选参数 `iv_max_lines TYPE i DEFAULT gc_max_lines`，finalize 截断改用该参数（默认行为不变，兼容现网）

### 3. ZCL_AI_CHAT_SERVICE.abap（主要改动）
- **analyze 重构**（307-484 行区域）：
  1. 对象识别 `detect_program` 提前到模型选择之前（路由需要知道任务类型）
  2. 新私有方法 `route_model(iv_model_id, iv_has_obj) RETURNING zai_model_cfg`：ModelId≠'AUTO'/' ’ → 原逻辑；AUTO+有对象 → 第一条启用且 SKIP_SOURCE≠'X'；AUTO+无对象 → 第一条启用
  3. 模型 `SKIP_SOURCE='X'` → 清空 lv_prog 跳过源码/表提取，纯对话
  4. **代码权限管控**：新方法 `v8_get_role`（从 v8_require_admin 抽取查询逻辑，原方法复用它）+ `is_cfg_on(iv_key)`；CODE_ACL='X' 且 role≠'ADMIN' 且对象是 PROG/CLAS/FUGR 时：不注入源码，改为注入程序元信息（程序名、TADIR 类型、TRDIRT 标题）+ system 提示「用户无代码查看权限，仅解释程式用途，禁止输出代码内容」；es_result-message 注明「普通用户模式：已隐藏源码，仅提供功能说明」
  5. **分块摘要级联**：新方法 `chunk_summarize(iv_prog, ls_src, ls_cfg, question) RETURNING string`：LONG_SRC_CHUNK 开启且源码 >6000 行时，按 2000 行/块（上限 5 块，超出部分注明未纳入），逐块调 LLM 出要点摘要（含关键表/FM/逻辑+行号范围），最终 prompt=「分块摘要+用户问题」；es_result-message 注明「源码超长，已按 N 块分段摘要分析」
  6. **故障自动切换**：LLM 首选模型调用返回 ev_error 时，遍历其他 IS_ACTIVE='X' 模型（跳过故障的，最多再试 2 个），成功则 answer 末尾追加引用行「> 本条由模型 {model_id} 兜底回答」
- **表样例指定字段**：新方法 `detect_fields(iv_question, iv_tabname) RETURNING tt_fields`（正则提取「表 X 的 F1,F2」逗号/顿号分隔字段，逐个查 DD03L 校验存在性，全部无效则返回空）；`get_table_sample` 加可选参数 `it_fields`，非空时 `SELECT (field_list)` 且序列化仅输出这些列，meta 注明「样例仅含指定字段」
- **会话**：`get_sessions` 返回 pinned、排序 `ORDER BY pinned DESCENDING, changed_at DESCENDING`；新公开方法 `v8_update_session(iv_session_id, iv_title, iv_pinned) RETURNING ty_v8_result`（仅 created_by=sy-uname 的会话可改；title 非空才改标题；pinned X/'' 置顶/取消）
- `get_models`/`save_model_cfg`：带 skip_source 字段（get 输出、save 落库）；顺手给 `save_model_cfg`/`test_model` 补 `v8_require_admin` 校验（现状裸奔，与文档宣称的权限模型对齐）

### 4. ZCL_ZAI_CHAT_DPC_EXT.abap
- `execute_action`：SAVEMODELCFG 参数表加 `SKIPSOURCE`；新增 `WHEN 'UPDATESESSION'`（v8_param 读 SessionId/Title/Pinned）
- `models_get_entityset` 输出 `skipsource`；`sessions_get_entityset` 输出 `pinned`

### 5. SEGW 配置（SE80 手工，写入实施文档）
- Model 实体 +`SkipSource`（Edm.String，可空）；Session 实体 +`Pinned`（Edm.String）
- 新 FI `UpdateSession`：入参 SessionId/Title/Pinned（Edm.String），返回 V8Result，POST
- 重新生成运行时工件（DPC_EXT 自定义代码不受影响），SEGW 发布

ZCL_AI_LLM_CLIENT 不改动。

---

## 二、前端改动（webapp/）

### 1. utils/Formatter.js
- 新增 Markdown **表格**解析：`_formatInline` 前拦截 `|...|` 行块（表头+`|---|` 分隔行），输出 `<table class="mdTable">`，单元格过 `_inline`；不完整表格按普通文本（流式期间友好）
- `_inline` 增加图片语法 `![alt](url)`（在链接规则之前匹配），协议白名单 `https?`/`data:image/`，输出代码构造的 `<img class="mdImg" src alt>`（转义先行，无 XSS 路径）

### 2. css/style.css
- `.mdTable`（边框/表头底色/斑马纹/横向滚动/亮暗主题）、`.mdImg`（max-width:100%、圆角、hover 阴影）、lightbox 全屏遮罩、会话置顶样式 `sessItemPinned`、搜索框间距

### 3. view/SettingsDialog.fragment.xml
- 模型管理 Tab 顶部加「代码提取管控」卡片（仅 ADMIN 可改，USER 只见说明）：
  - Switch「USER 禁看源码」→ GetConfig/SaveConfig key=`CODE_ACL`
  - Switch「超长源码分块分析（>6000 行分段摘要，较慢）」→ key=`LONG_SRC_CHUNK`
- 表格「类型」列后不加列（避免拥挤），模型的源码分析状态只在编辑框里

### 4. view/ModelEditDialog.fragment.xml
- 加 CheckBox「源码分析（该模型参与代码解析）」绑定 `me>/SkipSourceBool`

### 5. view/App.view.xml
- `modelSelect` 首项加 `AUTO · 智能路由（按任务自动选模型）`，作为默认选中
- 侧栏会话列表上方加 `SearchField`（id=sessionSearch）

### 6. controller/App.controller.js
- `_loadModels`：无 currentModel 时默认 `AUTO`；`onModelChange` Toast 文案区分 AUTO
- 设置对话框：打开时读 CODE_ACL/LONG_SRC_CHUNK 回填 Switch，改动即 SaveConfig（ADMIN）
- `onSaveModel`/`_openModelEdit`：带 SkipSource 字段
- **会话管理**：`sessionItemFactory` 加「置顶」「重命名」按钮；`onRenameSession`（程序化 InputDialog，标题回填、确认后调 ChatService.updateSession）；`onPinSession`（toggle）；列表渲染前按 Pinned 优先+ChangedAt 降序排序；`onSearchSession`（LiveChange 前端过滤 Title）
- 图片加载完成滚动到底部（document 捕获 img load 事件委托）+ 点击图片 lightbox 开/关（事件委托，模式对齐 `_bindCodeCopy`）

### 7. service/ChatService.js
- `getModels`/`saveModelCfg`：带 `SkipSource`（save 加参数 SkipSource，编辑回填 SkipSourceBool）
- 新 `getConfigValue(key)` / `saveConfigValue(key, value)`（走已有 `_v8Call` GetConfig/SaveConfig）
- 新 `updateSession({sessionId, title, pinned})`：backend 走 `_v8Call('UpdateSession')`；mock 改 localStorage `zaiChat.mockData`
- mock `_mockStore().sessions` 行兼容 Pinned/Title 修改；mock send 对 AUTO 直接用第一个启用模型

### 8. i18n/i18n.properties
- 新增文案：智能路由项、管控开关标题/说明、重命名/置顶/搜索、模型编辑「源码分析」等

---

## 三、部署与验收

**实施顺序**：SE11 加 2 个表字段 → SE24 贴 3 个类激活 → SEGW 加属性+FI 生成发布 → 前端 `npm run build` → 增量 zip 上传 → preload 标记校验（沿用 docs/04 流程）
**同步更新文档**：docs/01（新增字段/FI/analyze 流程）、02（新方法地图）、03（实施步骤）、README 待办清单（表样例指定字段列等勾销）

**验收清单**：
1. 模型 A 关闭「源码分析」→ 下拉选 A 问「分析 ZXXX」→ 回复纯对话、无源码注入；选「智能路由」→ 自动落到源码分析型模型
2. CODE_ACL 开启后：USER 问 tcode → 得到程式用途说明、回复不含代码；ADMIN 同问 → 正常源码分析；关闭后 USER 恢复
3. LONG_SRC_CHUNK 开启 + 问超长程序 → 回复引用分块摘要、message 注明块数；关闭时保持现状（6000 行截断）
4. 问「看下 表 MARA 的 MATNR,MTART 前 20 行」→ 样例只含 2 列、行数明显多于 SELECT * 时
5. 模型返回 `![...](data:image/...)` 或 http 图片 → 气泡内显示、可点击放大
6. 模型回复含 Markdown 表格 → 正常渲染表格样式
7. 会话：重命名/置顶/搜索/删除均生效，刷新后置顶仍在（后端落库）
8. 智能路由下拉默认选中；手动选具体模型则完全按手动；首选模型故障时回复末尾有兜底模型注记
9. mock 演示模式全功能可见（开关只读提示、会话管理本地可用）

**不动的东西**：现有 12 个 FI 契约、消息表结构、打字机流式、登录/权限链路、highlight.js 配置。