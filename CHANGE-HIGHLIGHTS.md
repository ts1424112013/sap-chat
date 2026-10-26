# 侧栏会话滚动条优化（2026-10-26）

- 会话列表改为 6px 细滚动条和透明轨道，亮暗主题各用低对比度滑块，鼠标悬停或键盘进入列表时加深。
- 覆盖 UI5 Horizon 继承的滚动条颜色与边框，避免深色侧栏出现宽白底。保持原生滚动和固定预留宽度，列表增多时不挤动内容。
- 实际构建页面用 36 条会话验证亮暗主题、滚轮、拖动、搜索和会话切换通过，无脚本异常；仅更新前端样式。

# 参数卡呈现顺序调整（2026-10-26）

- 参数卡先到、消息重建或报表参数定义异步补齐时，统一等待说明文字结束再展示；等待、请求未完成或手动停止时不提前弹出。
- 取消取数 / 报表参数卡的自动聚焦，卡片出现与参数补齐时保留阅读位置，避免说明文字被大表单滚走。
- 保留原有默认值、草稿、确认提交和历史恢复。相关回归：会话 19 项、Fiori 118 项、结果恢复 18 项通过；构建后的实际页面验证顺序、焦点、滚动和提交。

# 灵犀 LingXi 品牌接入（2026-10-26）

- 将 Momo 品牌更新为灵犀 LingXi，统一登录、首页、侧栏、聊天头像、欢迎提示、浏览器图标与导出文案。
- 彩色叶翼使用正式 SVG 控件，运行时展开幅度更明显；等待后端时较慢，正文输出与后台报表执行时加快，结束后柔和回位。
- 图形源统一为 `LingXiArtwork.js`；构建前自动生成静态图标。多个实例的渐变互不冲突，重复状态不重启动画，支持减少动态效果与页面隐藏暂停。
- 本次只改前端；后端接口、应用命名空间和会话存储键不变。实施见 `docs/04-前端实施文档.md` 〇-I。

> **📌 当前进度速览（新会话先读这里，再看 README.md）**
> - 项目阶段：**V9 + V1.8 后端**。前端全部完成；部署方案已定（推荐 SAP BSP 同域，见部署文档）。
> - V1.8（后端）：表名说法增强 ——「表结构 MARC」「MARC 表」「MARC表」等口语均可识别；
>   显式提到的表名即使不存在也进入分析流程（模型如实告知"系统里没有"）。
> - V1.7（后端）：事务代码识别 —— Z/Y 候选词先查 TSTC（如 ZAPP0018 → ZAPP_IDP_0018），
>   命中即分析其主报表，meta 提示定位过程。
> - SAP 端待办：重贴 `ZCL_AI_CODE_PROVIDER` + `ZCL_AI_CHAT_SERVICE` 两个类；
>   部署前端按《docs/DEPLOYMENT-PLAN.md》。

# V9.2 · 表名说法增强（后端 V1.8，2026-09-03）

> 用户追问「如果我说分析一下表结构呢」—— 排查发现原实现只认「表+名字」
> 顺序写法，且「表结构 MARC」「MARC 表」等日常说法识别不到。

- **detect_program 表名识别增强**（`ZCL_AI_CHAT_SERVICE.abap`）：
  ① 新增「表结构 XXX」变体（标记词正则改为 `(表结构|表|TABLE)`，长词优先）
  ② 新增「XXX 表 / XXX表」名字在前的写法（第二正则）
  ③ 显式提到表名时**不再要求对象存在**：不存在也返回该名字 → get_source
     失败 → 走 V1.5 降级注入"系统中不存在"事实 → 模型如实告知（对齐用户
     最初"表查不到就告诉模型"的需求，原来这种情况会静默走纯对话）
- 「分析一下表结构」（不带表名）依然安全：两个正则都匹配不上 → 纯对话，
  模型反问哪张表
- 已知取舍：「导出到 EXCEL 表」这类"英文词+表"会误判为表名 EXCEL，
  但结果是模型收到"对象不存在"的说明并照常回答，无功能损害
- 同步：后端手册 6.1 更新并重新生成 docx（postcheck 0 错误）


> **📌 当前进度速览（新会话先读这里，再看 README.md）**
> - 项目阶段：**V9 + V1.7 后端**。前端全部完成；部署方案已定（推荐 SAP BSP 同域，见部署文档）。
> - V1.7（后端）：事务代码识别 —— 提问里的 Z/Y 候选词先查 TSTC（如 ZAPP0018 →
>   ZAPP_IDP_0018），命中即分析其主报表，meta 提示定位过程；涉及
>   ZCL_AI_CODE_PROVIDER（新增 resolve_tcode）与 ZCL_AI_CHAT_SERVICE（detect_program
>   加 ev_tcode 参数），**两个类需重贴激活**。
> - V9：config.js 事实源 + 探测降级；V1.6 表数据分析；部署文档与离线手册。
> - SAP 端待办：重贴两个类 + 部署前端按《docs/DEPLOYMENT-PLAN.md》。

# V9.1 · 事务代码识别（后端 V1.7，2026-09-03）

> 用户需求：日常都用 tcode 打开自定义程序（如 ZAPP0018 就是 ZAPP_IDP_0018 的 tcode），
> 希望在输入框直接说「分析一下 zapp0018」也能取出代码交给模型分析。

- **ZCL_AI_CODE_PROVIDER** 新增 `resolve_tcode`：SELECT TSTC 单表查询，
  tcode 命中且 PGMNA 非空 → 返回其主报表程序；OO/类事务（PGMNA 空）返回空不处理
- **ZCL_AI_CHAT_SERVICE.detect_program** 签名加 `EXPORTING ev_tcode`：
  Z/Y 候选词在 TADIR 校验前先走 TSTC 解析，命中即返回主报表并带回 tcode；
  未命中照旧走对象名校验（原逻辑零改动）
- **analyze** 调用处捕获 tcode，meta 行提示「已通过事务代码 X 定位到程序 Y」
- 仍限 Z/Y 开头词元（避免把 ME21N 等标准事务的几百行标准代码误拉进上下文）；
  消息照常落库，meta 可追溯
- 前端零改动；后端手册 6.1 已同步更新并重新生成 docx


# V9 · 常连后端 + 掉线降级 + 表数据分析 + 部署方案（2026-09-03）

> 背景：用户实际配置 ABAP 后端后发现"刚部署读不到后端地址"的设计缺陷；
> 在家无法连 SAP 时也想看页面；新增表数据分析需求。

- **常连后端（修复设计缺陷）**：新增 `webapp/config.js`（mode/host/path/probeTimeoutMs，
  UI5 引导前加载）——部署环境的**唯一事实源**；设置对话框修改仅本次会话有效，刷新回配置值。
  测试/生产切换 = 改 config.js 后重新部署（BSP 场景 host 留空走同源）
- **启动探测 + 降级**：`_probeBackend()` 探测 `$metadata`（200/401/403=可达，
  网络错/404/5xx=不可达，4s 超时）；不可达→自动切 mock + 提示条 + 徽标"演示模式"，
  本地 admin/123456 或演示身份可登录查看全部界面
- **V1.6 表数据分析（ABAP ZCL_AI_CHAT_SERVICE）**：
  ① `detect_program` 新增第一优先级：`表 XXX`/`TABLE XXX` 写法不限 Z/Y（标准表 MARC 亦可），
     存在性校验后认定（正则用双捕获组，POSIX 不支持非捕获组——V1.3 `\b` 同类教训）；
  ② 新增 `get_table_sample`：动态建内表 `SELECT UP TO 10 ROWS`，RTTI 序列化
     `字段=值; …`，单元格>50 截断、总量≤4KB；无权限/空表经 ev_note 说明不抛错；
  ③ 对象是 TABL/VIEW → 提示词在字段结构后追加样例数据段；
     对象不存在 → 系统事实作为附加 **system 消息**注入（模型明确告知"SAP 里没有"）；
  ④ 大数据量演进路线（聚合统计/条件取样/超长字段排除）写在指南第五步
- **部署方案文档**：`docs/DEPLOYMENT-PLAN.md` —— 方案 A（SAP BSP 同域，推荐）vs
  方案 B（nginx+反代）；Basis 配合清单 A/B 两张；依赖答疑（Node 仅构建时、UI5 运行时、
  CDN 内网化）；三周实施节奏与上线检查清单
- **实测**：config=backend + 代理不可达 → 降级演示模式 + 登录框 + 演示身份进入全界面 ✅；
  `node --check` ✅

# V8 · 强制登录 + 权限体系 + 角色/泡泡后端化（前后端）

> 详细设计/接口契约/发布步骤见 **docs/V8-ACCESS-DESIGN.md**（含初始管理员
> admin/123456 的完整风险评估——结论：仅"后端未配置"窗口可用 + 首次登录强制改密，
> 后端地址联调通过后该账号永久失效，比单一失效条件更稳）。

- **强制登录**：应用层登录框（品牌徽标/账密/错误条/演示入口，5 次失败锁 60 秒）；
  登录账号 = SU01 用户，密码即网关 Basic 凭据（登录后自动注入 OData 请求），
  **彻底取代 SAP 账密弹窗**；旧 sapLogin 代码保留、入口移除
- **初始管理员**：admin/123456 仅后端未配置窗口可用，首次登录强制改密（SHA-256 落本浏览器）
- **权限分流**：ADMIN 可增删泡泡/角色/模型、配后端地址、用户管理；USER 只读使用
  （＋泡泡不渲染、角色管理只读、设置页字段 editable=false、模型维护不可见）
- **角色/泡泡后端化**：存 ZAI_CHAT_ROLE / ZAI_CHAT_PROMPT，多会话/多端/多人共享；
  mock 模式落 localStorage（键兼容旧版）
- **用户管理页签**（仅管理员）：从 SU01 用户赋权开通（不存密码），启用/停用
- **V1.5 后端优化**：提问带 Z/Y 对象名但对象不存在时，**降级为纯对话**不再报错
  （meta 提示"对象 X 不存在，已按普通对话处理"），ZCL_AI_CHAT_SERVICE 已改
- **弹窗底色修复**：Horizon 不在 .sapMDialog 根/标题画底色 → 自定义头部弹窗
  （管理角色）透出底层内容；显式 var(--surface) 兜底，全部弹窗受益
- 新增文件：`backend-abap/ZAI_CHAT_V8_ADMIN.abap`（4 张表 + SEGW Function Import
  清单 + execute_action 分发实现）；前端验证：admin 登录→改密→管理员视角，
  演示身份→USER 视角，截图实测通过

# V7 · 对齐《V2 简约版设计图》+ 泡泡浮动恢复（纯 UI，零功能回退）

> 基准：`V2 SAP AI 对话助手 · 简约版设计图（V2）.html`（用户 09-02 设计）。
> token 与结构样式对齐设计图，并按用户要求恢复首页泡泡常驻漂浮动画。

## 一、Token 对齐（亮/暗）
- 用户胶囊：纯蓝白字 → **浅蓝实底 #e6f0f8 + 深字**（V2 `--user-bub`）；暗色 #22323e
- 代码块：深色墨块 → **浅灰 #f4f6f9 + 发丝边**（V2 `.codeblock`）；暗色仍为深底 #101318
- 当前会话高亮：白卡+投影 → **accent-soft 浅蓝底**（V2 `.hist-item.active`）
- 暗色全套 token 换为 V2 值（bg #14171c / surface #1d2128 / side #191d23 / line #2a2f38 / accent #5aabdd…）
- 新增 `--content-max: 760px`（V2 chat-inner）：消息列 / 输入卡 / Hero 卡同宽对齐（原 1200px）
- 字体栈对齐 V2（SF Pro Text / PingFang SC / Microsoft YaHei）

## 二、结构样式对齐
- 新对话按钮：胶囊 999px → **10px 圆角**，hover 边框变主色（V2 `.newchat`）
- 会话条目圆角 12px → 9px；AI 头像 28px 圆形 ✦ → **26px 圆角方块「AI」粗体**（controller 同步改文案）
- Logo/登录徽标：渐变+辉光 → **纯平主色**（V2 零渐变）；Hero 徽标 52px/14px 圆角、文案 ✦
- 顶栏：发丝线**常驻**（原滚动后才出现）；模型下拉亮色同款纯平胶囊（V2 `.model-pill`）
- 用户气泡统一 14px 圆角；正文 14.5px/1.65，AI 正文 14.5px/1.75（V2 排版）
- 行内代码：accent-soft 底 + 主色字（V2 `.tag`）；消息入场 8px/.3s 上浮（V2 `@keyframes up`）
- 思考三点动画对齐 V2 `.typing`（5px 小点、-3px 上浮）
- Hero 新增副标题 `heroSub`（view + i18n 对齐 V2 文案「与 SAP AI 探索 ABAP 开发…」）

## 三、泡泡浮动效果（用户点名保留）
- 恢复 V6.1 关闭的常驻漂浮：`bubFloat 5.5s alternate` + bubD0~3 错拍（仅 translateY，GPU 友好）
- 泡泡外观同步 V2：白卡实底 + 发丝线 + 中性浅投影，**去 backdrop-filter 毛玻璃**；
  点击淡出态 `bubOut` 优先级高于漂浮动画，消耗交互不受影响

## 四、亮色代码高亮重映射（配套代码块改浅底）
- index.html 加载的 hljs 主题为 github-dark-dimmed（暗底配色），浅底下不可读
- 新增 `[data-theme="light"]` 层：kw=主色加粗 / str=#3f9d63 / cmt=sub / number=#B36539；
  hljs 未加载时自然退化为正文色；暗色主题不受影响

## 五、V7.1 · 用户圈注修正（顶栏图标 / 角色区 / 侧栏底部）
- **顶栏图标按钮统一**（V2 `.icon-btn`）：16px 中性灰（原 Horizon 蓝/深蓝杂色、偏大），
  hover 浅底；折叠侧栏/主题/导出/设置四个按钮一致
- **角色下拉 ghost 化**（V2 `.role`）：剥 Horizon 原生边框（含 wrapper 伪元素），透明底 +
  hover 浅底；占位符斜体 → 正体（ComboBox 占位是原生 `::placeholder`，需打伪元素）
- **侧栏底部**：「演示模式」对齐 V2 `.mode` —— 12px 主色 + 6px 圆点；齿轮弱化 sub 灰、hover 主色
- ★ 类名坑：UI5 1.130 Horizon 的 ObjectStatus 类为 `sapMObjStatusText`，
  旧规则写的 `sapMObjectStatusText` 从未命中（本版修正）
- 输入框占位符斜体 → 正体（TextArea 占位 overlay 与 ::placeholder 两处）
- 会话悬浮删除键弱化灰、hover 危险色；侧栏空提示左对齐
- **V7.2 · 顶栏图标垂直居中**：Horizon 的 `.sapMBtnInner` 是 flex 但
  `align-items:normal`，固定高度图标 span 按 flex-start 顶在上沿（实测图标盒中心
  比 ComboBox 中心高约 9px）；显式 `align-items:center` + 图标 `align-self:center`
  修正，实测四个图标中心 24.4px = 输入框中心 24.4px，像素级对齐

## 九、V7.3/V7.4 · 渐变画布 + 样例二次对齐（用户追加需求）

### 渐变背景（用户点名"渐变色的背景色"）
- token `--bg-gradient`（亮/暗）：两角轻主色晕染（radial，主色 α≈.10/.07）+ 纵向微渐变，
  保住 V2 的干净感不做浓渐变；body 直绘 + `background-attachment:fixed`
- 配套去阻挡：`.mainCol`/页面根节点早已透明；`.topBar.scrolled` 改回透明
  （渐变上实底色带会割裂渐变）；`.inputDock` 去掉实底渐隐带（纯装饰，渐变上成色带）

### 样例二次对齐
- 输入卡圆角 26px → **16px**（V2 `.dock`）
- 角色下拉展开态彻底 ghost 化：★ Horizon 把按压高亮画在**图标 span 的
  `inset box-shadow`** 上（`rgba(79,160,255,.5) 0 0 0 1px inset`，elementFromPoint 实测），
  与容器无关；连同 `.sapMInputBaseIconContainer` 各状态一并剥离
- 下拉选项列表统一圆角面板风：★ UI5 1.130 真实弹层类是 **`.sapMComboBoxBasePicker`**、
  条目是 `.sapMLIB`——旧规则写的 `.sapMComboBoxPicker(-Item)` 是过时类名从未命中
  （暗色那段同样修复），12px 圆角 + 发丝边 + 轻投影 + accent-soft 悬停/选中

### V7.4 · 侧栏与主区分层（用户："侧边框和主页面大概分一下"）
- 侧栏从全透明改为半透明底 token `--side-tint`（亮 `rgba(233,238,245,.95)` /
  暗 `rgba(16,19,24,.95)`，透一点渐变但明显成块）+ 发丝线 + 右缘极轻投影
  `6px 0 24px rgba(20,30,50,.05)`；色阶差约 5%，强于 Notion/ChatGPT 侧栏分层

### 验证
- 亮/暗两态渐变 + 侧栏分层截图 ✅；角色下拉展开态（无蓝框箭头 + 圆角列表）✅；
  「演示模式」暗色放大复核无伪影 ✅

## 六、实测发现并修复的老问题
- **暗色主题消息正文/输入框文字不可读**：UI5 Horizon 正文色为固定深色值，不随暗色画布变化。
  已显式挂 token 色（`.bubbleBody`、暗色下 textarea / 角色下拉文字）

## 七、验证记录（真实浏览器 GUI 实测）
| 检查项 | 结果 |
|--------|------|
| 亮色欢迎态：泡泡白卡漂浮（computed `bubFloat 5.5s`）+ 副标题 + 760px 输入卡 | ✅ |
| 亮色对话态：浅蓝用户气泡 / AI 方块头像 / 浅底代码块+语言行 / 行内代码胶囊 / 会话高亮 | ✅ |
| 暗色对话态：正文可读（修复后）/ 深底代码块 / 会话高亮 / 输入区文字 | ✅ |
| V7.1：顶栏图标统一灰 / 角色占位正体无框 / 「● 演示模式」圆点+主色 | ✅ |
| 亮暗往返切换 + localStorage 持久化 | ✅ |
| `node --check` + XML 良构 | ✅ |

## 八、改动文件
| 文件 | 内容 |
|------|------|
| `webapp/css/style.css` | V7 token/结构/泡泡/亮色 hljs 补层；V7.1 图标与 ghost 控件统一；暗色正文可读性修复 |
| `webapp/view/App.view.xml` | Hero 副标题 heroSub、Hero 徽标文案 ✦ |
| `webapp/controller/App.controller.js` | AI 头像文案 ✦ → 「AI」（对齐 V2） |
| `webapp/i18n/i18n.properties` | heroSub 文案对齐 V2 |

> 注：内容列宽由 1200px 收窄为 760px（V2 设计图值，集中在 token `--content-max`，
> 想调宽只改这一处）。

# V5.4 · 首页泡泡指令 + 角色选择 + 对话工作区整理（纯前端，零后端改动）

> 按用户标注截图实施：①快捷指令泡泡化 ②对话态去指令行 ③会话标题溢出省略号
> ④消息列与输入卡对齐成"对话工作区" ⑤新增角色选择（可自定义增删）。
> 全部经真实浏览器 GUI 实测通过（详见验证记录）。

## 一、首页快捷指令「泡泡」化
- 指令从横排胶囊改为**散落在欢迎区四周的泡泡**：玻璃质感（半透明白 + 模糊 + 克莱因蓝描边），
  10 个预设槽位（bubSlot0~9）+ 4 档浮动错拍（bubD0~3），入场缩放动画打在内层 chip、
  漂浮动画打在外层盒，互不打架；`prefers-reduced-motion` 用户自动关闭全部动画
- **点击泡泡**：内容填入输入框并聚焦 → 泡泡淡出消失（260ms 后销毁）。消耗按 prompt 文本记忆
  （`_mConsumed`），增删/跨窗口同步导致的下标漂移不影响；**回到首页（新会话/空会话）自动重置**
- 悬浮 × 删除、**＋泡泡**新增（虚线弱化），管理能力与原胶囊一致，数据仍为 `chat>/quickPrompts`
- 实现：删除聚合绑定工厂 `quickItemFactory` 与 `onQuickPrompt`，改控制器程序化渲染
  `_renderHeroBubbles()`（挂在 _loadQuickPrompts/_saveQuickPrompts/_setChatMode(false) 三处）
- 泡泡层 `pointer-events:none` 穿透、泡泡本身可点，不挡标题/输入卡；**窗口宽 ≤920px 或高 ≤560px 整层隐藏**

## 二、对话态去掉快捷指令行
- `App.view.xml` 删除 `inputDock` 内 `quickRow quickDock` 行；CSS 清理 quickRow/quickBtn/
  quickItem/quickAddBtn/quickDock 及 V5.2e 胶囊悬浮交互全部死样式（保留 noData、chipDel 焦点清理）

## 三、会话标题溢出省略号（修复性）
- **根因**：省略号规则一直写在 `.sessionItemTitle` 上，而工厂实际打的类是 `.sessItemTitle`，
  截断从未生效。修正选择器并给 `.sessItemBox` 加 `min-width:0`（flex 子项不收缩则永远不截断）

## 四、对话工作区：消息列与输入卡对齐
- `[id$="msgList"]` 已有 860px 限宽（V4.3 引入），本轮在 1600/1920 两种宽度下实测消息列与
  输入卡 left/width **像素级一致**（502/860 与 662/860），形成统一"工作区"视觉

## 五、角色选择（新功能，可自定义增删）
- **入口**：两张输入卡（首页/对话态）底部左侧各一组「角色下拉 + 管理按钮」，
  下拉首位固定「不使用角色」；两组选中态经 `chat>/currentRole` 实时同步
- **管理对话框**：程序化构建（与快捷指令对话框同风格，customHeader × 关闭），清单增删即时生效，
  存 localStorage（`zaiChat-roles`，结构 `[{name}]`）；删除当前选中角色自动回退"不使用角色"；
  跨窗口 storage 事件同步
- **发送机制**：选中角色时 Question 前拼 `【角色：xxx】\n` 发给大模型（实测实发文本已验证）；
  **界面气泡仍显示原文**，下方 meta 行显示「角色：xxx」
- **还原链路（`_buildEntry` 统一处理）**：后端将带前缀 Question 原样存库，历史回读/导出 Markdown
  时剥离前缀还原为用户原文；会话标题（侧栏/顶栏，`_refreshSessions`/`onSessionPress`/
  `_ensureSessionEntry`）同样剥离 —— 后端零改动，显示层全部还原
- 默认角色：项目分析师 / ABAP开发专家 / 功能顾问 / 测试工程师；上次选中角色持久化（`zaiChat-role`），
  已被删除的角色自动回退

## 六、验证记录（真实浏览器 GUI 实测）

| 检查项 | 结果 |
|--------|------|
| 泡泡散落布局（1600×900 视觉审阅） | ✅ 七枚泡泡+添加泡泡自然分布，无遮挡 |
| 点击泡泡 → 输入框填入 + 泡泡消失（真实点击坐标） | ✅ |
| ＋泡泡打开新增对话框 | ✅ |
| 角色管理：添加"项目经理"/删除"功能顾问"/localStorage 落盘 | ✅ |
| 角色选中持久化 + 刷新恢复 + 双下拉同步 | ✅ |
| 发送实发文本 = `【角色：xxx】\n原文`（patch send 抓取验证） | ✅ |
| 用户气泡显示原文 + meta「角色：xxx」 | ✅ |
| 会话标题剥离前缀 + 溢出省略号 | ✅ |
| 对话态无指令行、底部有角色选择器 | ✅ |
| 消息列与输入卡同宽居中（1600/1920 双档实测） | ✅ 像素级对齐 |
| 新会话 → 泡泡全部恢复 | ✅ |
| `node --check` + XML 良构 + `ui5 build` | ✅ |

## 七、改动文件

| 文件 | 内容 |
|------|------|
| `webapp/view/App.view.xml` | hero 泡泡层容器、删对话态指令行、两处角色选择器 |
| `webapp/controller/App.controller.js` | 泡泡渲染/点击消耗、角色增删/同步/持久化、发送拼接、`_buildEntry`/标题前缀还原；删除 quickItemFactory/onQuickPrompt |
| `webapp/css/style.css` | 泡泡层/槽位/动画/角色选择器/角色对话框样式；旧胶囊与 quickDock 死样式清理；会话省略号修正；窄屏隐藏泡泡 |
| `webapp/i18n/i18n.properties` | 新增角色相关 15 个文案 key |

> 注：本次为纯前端改动，ABAP 后端与《V1.4 增补》文档不受影响。带角色的历史消息在
> 数据库存文即含前缀（后端事实源），界面显示与导出均已还原。


# V5.3b/V1.4 · 多标签页支持（前端同步 + 后端并发修复）

- **前端**：监听 storage 事件，跨窗口实时同步 登录凭据（重建模型+Toast）/快捷指令列表；连接设置变更仅 Toast 提醒不覆盖
- **后端 V1.4**：ZCL_AI_CHAT_SERVICE.append_msg 序号改 `MAX(msg_seq)+1`（旧 prev+1 在多窗口同会话并发发送时主键冲突丢消息）；SE24 重新粘贴该类即可（backend-abap 已更新）
- 详见手册"多标签页/多窗口打开"章节；跨窗口同步已双窗口实测


# V5.3 · Basic 头直填登录 + 登录框美化 + 前端文档

## 一、Basic 认证头直填（登录框二选一）
- 登录框新增 **Basic 认证头** 输入项：直接粘贴 Authorization 头完整值（`Basic dXNlcjpwYXNz`，可自动补前缀），填了则账号密码可留空——内网联调已生成 base64 串时免拆账密
- ChatService 新增 `setSapHeader/verifySapHeader/isHeaderMode`；凭据存储扩展 `{user,pass,header}`（localStorage zaiChat-sapAuth）；`getSapUser` 头模式自动解码用户名
- 格式校验：Basic 前缀/可解码 base64/含冒号分隔，错误给出针对性提示；验证仍走 $metadata 探测（12s 超时）
- 设置页登录状态区分形态显示（已登录（Basic 头）：用户名）

## 二、登录框全面美化（用户反馈"太丑"）
- 新布局：克莱因蓝渐变**锁形徽标** + 居中标题/副标题 + 小标签圆角输入框 + "—— 或者使用 Basic 认证头 ——"分隔线 + 浅红错误条 + 胶囊按钮
- 修复：构造参数 `class:` 不生效问题（统一 addStyleClass）；`sap-logo-shape` 图标无效改 `locked`
- 对话框 16px 圆角 + 柔和投影，头部仅保留 ×，底部按钮胶囊化

## 三、新增《SAP AI 前端使用与部署文档.docx》
- 8 章：概述与功能总览 / 环境与启动 / 连接后端（代理 vs 直连 + ui5.yaml 示例）/ 网关认证（两种凭据 + 安全）/ 功能使用 / 构建部署 / FAQ / 版本历史
- 7 页，视觉验收全部通过


# V5.2 · 联调认证根因修复 + 对话框样式修复（纯前端）

> 内网 OData 联调反馈的处理：401 根因定位与修复、对话框按钮样式问题修复。
> 详见《BACKEND-DEBUG-NOTES.md》问题 3。

## 一、401 根因修复（重大）
- **bug**：v2 ODataModel 构造瞬间即发 `$metadata` 请求，而凭据是构造后才 `setHeaders` 注入 → metadata 无凭据 401 → 模型缓存错误状态卡死，登录框/代理头全部"看似没生效"
- **修复**：`_getModel()` 构造参数 `headers` 直接携带 Basic 凭据（metadata/token/CRUD 首个请求起即带）+ setHeaders 双保险；`_maybeAuthFail` 补 `oError.message` 检测；`verifySapCredentials` 加 12s 超时
- **效果**：登录框方案（记住密码）完整可用，**无需再在代码里硬编码凭据**

## 二、对话框样式修复（联调 UI 反馈）
1. **底部按钮不再拉伸变形**（原"验证并连接/跳过""保存/取消"各占半行）→ Fiori 紧凑右对齐（实测 90/64/48px）
2. **四个对话框全部加右上角 × 关闭**（设置/模型编辑/登录/添加指令，`customHeader` + 标题工具栏；注意 Dialog 聚合名是 `customHeader` 不是 `headerToolbar`——后者会导致 fragment 加载失败）
3. 对话框底部按钮区加分隔线；模型表格列头加底色；快捷指令"＋"等高；设置页签分隔线

## 四、V5.2 补充修复（用户界面反馈第二轮）
- **对话态快捷指令行"溢出"感**：`.quickDock` 继承 hero 区 `.quickRow` 的 `max-width:40rem`(640px)，输入卡 858px 下右侧空 218px、内容却挤到横向滚动 → 解除限宽占满输入卡（实测 825px 全部放下、零溢出）
- **发送按钮图标溢出圆形**：UI5 Icon 默认宽高把纸飞机撑到 34px（按钮本身 2.1rem=33.6px），图标顶出圆外 → 显式锁定 16×16（hero/对话态/停止态三处同源修复，实测图标 16.0px 完整居中）

- **V5.2c（用户圈图反馈）**：① 移除快捷指令胶囊的原生 title tooltip（黑底长条贴胶囊弹出，观感差；点击即填入输入框可见全文）；② 发送按钮图标彻底居中——三层定位修复：Icon 默认 34px→锁 16×16；inner 36px→锁 2.1rem；按钮改 inline-flex+line-height:0（行盒基线曾把 inner 压低 4px）。实测图标中心偏移 x=0/y=0，视觉审阅通过；停止态图标同步收敛并覆盖旋转

- **V5.2d**：移除发送按钮 hover 上浮动效（translateY(-1px) 悬停时按钮"浮起/错位"观感差）——悬停反馈改为纯背景加深（无位移无阴影）；按压微缩（:active scale .94）保留

- **V5.2e（用户圈图反馈第二轮）**：① 侧栏"暂无历史会话…"空提示文字缩小弱化（.72rem 灰色）；② 快捷指令胶囊悬浮删除重构——× 从"绝对定位挂在胶囊外右上角"（外溢+挤压相邻胶囊+双框）改为"收进胶囊内部"（悬停时胶囊右侧平滑让出空间）；③ 双框根因清除：Horizon 内层 .sapMBtnInner 自带 0.8px 灰边被胶囊蓝边套在外面 → border:none；④ 胶囊文字留白加大（"写 ALV 报表"不再贴边）；⑤ 点击后残留的深蓝焦点框清除（内层伪元素 content:none）；⑥ 胶囊行加宽至 46rem，7 个元素一行排开

## 三、验证
- 四对话框按钮几何实测达标；构建通过；GUI 全流程通过

# V5.1 增量 · SAP 网关登录 + 品牌更名（纯前端，无后端改动）

## 一、SAP 网关登录（HTTP Basic）

> 背景：SAP GUI 要登录，网关 OData 同样需要凭据；大模型服务本身不需要 SAP 凭据，登录只用于访问网关。

- **启动自动登录**：后端模式且未保存凭据时，启动约 1 秒后弹"登录 SAP 网关"对话框（演示模式不弹；跳过后本会话不再主动弹）
- **验证并连接**：对 `$metadata` 发一次带 Basic 头的 GET 探测（12 秒超时）——成功保存凭据并重载模型/会话/历史；失败按状态码给出明确提示（401/403 用户名密码错、502 地址不通、超时/网络错误各有文案）
- **凭据生效方式**：`ODataModel.setHeaders({Authorization: Basic ...})`，随全部 OData 请求发送（含写操作的 CSRF 令牌请求）；保存/更换/清除后重建模型立即生效
- **401 自动重登录**：所有 OData 错误路径（read/callFunction/remove）挂 `_maybeAuthFail`（60 秒防抖）→ 控制器自动弹登录框（标题提示"登录已失效"）
- **记住密码**：默认勾选，存 localStorage（键 `zaiChat-sapAuth`，UTF-8 安全 base64）；密码不回显、不经过大模型服务
- **设置 → 连接 → 网关登录区块**：登录状态（已登录:用户 / 未登录红叉）+ 登录/更换账号 + 清除已保存凭据

## 二、品牌更名："AI 助手" → "SAP AI"

- `index.html` 浏览器标题、i18n `appTitle`/`brandName`（侧栏品牌）、`ai`（消息作者名）、hero 占位文案、导出 Markdown 的 AI 节标题，全部统一为 **SAP AI**

## 三、GUI 实测记录

| 检查项 | 结果 |
|--------|------|
| 演示模式启动不弹登录框 | ✅ |
| 后端模式启动自动弹框（结构完整） | ✅ |
| 空表单必填提示 | ✅ |
| 验证中提示 → 失败错误展示（假地址 502 路径） | ✅ |
| 跳过关闭 + 会话内不再主动弹 | ✅ |
| 设置页登录状态区（未登录红叉）+ 登录/更换账号 + 清除按钮 | ✅ |
| 从设置区块打开登录框（叠加在设置框之上） | ✅ |
| 品牌更名（页面 title "SAP AI"、侧栏、气泡作者） | ✅ |
| `node --check` ×2 + XML 良构 + `ui5 build` | ✅ |

## 四、改动文件

`webapp/service/ChatService.js`（凭据管理+Basic 头+verify+401 回调+超时）、`webapp/controller/App.controller.js`（登录框/401 弹框/设置区块刷新/导出标题）、`webapp/view/SettingsDialog.fragment.xml`（网关登录区块）、`webapp/i18n/i18n.properties`（新增 16 个 key + 更名）、`webapp/index.html`（title）、`webapp/css/style.css`（登录框错误文字样式）

---

# 以下为 V5.0 功能清单

# V5 实用功能升级 · 改动要点清单（前端 + 后端文档 V1.3）

> 面向公司内网私有化大模型部署的日常使用场景，前端新增 5 个实用功能、后端文档升级 V1.3。
> 前端全部经真实浏览器 GUI 冒烟测试通过（快捷指令填入/增删/持久化、发送、停止、代码块复制、导出下载、模型管理测试列）；
> 后端代码已同步更新至 `backend-abap/`，配套《V1.3增补(前端V5功能适配).docx》33 页全部视觉验收通过。

## 一、前端新功能（V5）

### 1. 快捷指令（提示词模板）
- 内置 6 个 ABAP 开发模板：**代码审查 / 性能优化 / 补充注释 / 单元测试 / 写 ALV 报表 / 表结构设计**，点击即填入输入框（可再编辑后发送）
- 空状态与对话态底部输入卡上方均有指令行；`＋` 添加、悬浮 `×` 删除，存浏览器 localStorage（键 `zaiChat-quickPrompts`）
- 实现：`quickItemFactory` 工厂（chip+删除+行尾＋号），`onAddQuickPrompt` 程序化对话框，删除按工厂写入的下标定位

### 2. 代码块单块复制
- `Formatter.markdownToHtml` 给每个围栏代码块包 `.codeWrap` + 原生 `复制` 按钮；语言角标移至代码块左上角避让
- 事件在 `document.body` 上**一次性委托**（流式期间 innerHTML 每帧重建，逐按钮挂监听不可行）；点击后按钮文案 1.2s 内显示"已复制"

### 3. 停止生成
- 响应期间发送键**保持可点**（图标变方块停止样式 + tooltip"停止生成"），点击即：中断打字机（令牌失效）→ 标记"已停止生成"（AI 标题行新增 meta 展示位）→ 解除忙碌可立即追问
- 迟到的后端响应按 `_sAbortToken` 静默丢弃（后端仍会跑完并存库，重开会话可见，符合"后端为唯一事实源"设计）
- 回车（Enter）在忙碌中仍被忽略，防连点误发

### 4. 导出会话 Markdown
- 顶栏下载按钮：当前会话导出为 `AI会话_时间戳.md`（标题 + 模型/时间/条数元信息 + 按角色分节完整原文），Blob 本地生成无后端依赖

### 5. 模型连通性测试（需后端 V1.3）
- 设置-模型管理表格新增**测试**列 → `ChatService.testModel` → OData 函数导入 `TestModel`
- 返回连接状态/往返耗时/具体失败原因（地址不通/401/404/超时等），配置新模型时一键自检

### 附：mock 演示文案更新
- 纯对话回复补充 abap 代码块示例（演示模式也能看到代码块复制效果）

## 二、后端改动（V1.3，见《V1.3增补》文档）

| 对象 | 改动 |
|------|------|
| SEGW | 新增复杂类型 **TestResult**(Success/Message/ElapsedMs) + 函数导入 **TestModel**(ModelId, POST) |
| ZCL_AI_CHAT_SERVICE | 新增 `test_model`（最小 ping 请求验证连通）、`read_model_cfg`（配置读取抽取共用）；**重写 `detect_program`**（勘误：V1.2 的 `\b` 正则 ABAP POSIX 引擎不支持，会运行时报正则异常；改为词元扫描 + 含数字/下划线/长度过滤 + **TADIR 存在性校验**，ZIP/ZOOM 等普通单词不再误触发源码提取）；TABL/VIEW 时提示词切换表结构语境 |
| ZCL_AI_CODE_PROVIDER | 新增公有 `object_exists`（TADIR 校验 PROG/CLAS/FUGR/TABL/VIEW）；新增 `read_structure`：DDIF_FIELDINFO_GET 输出**表/视图字段级清单**（字段名/键/类型/长度/数据元素/描述 + DD02T 表描述），提问提到 Z 表名即可让大模型结合表结构分析；TADIR 类型清单扩展 TABL/VIEW |
| ZCL_ZAI_CHAT_DPC_EXT | EXECUTE_ACTION 新增 `WHEN 'TESTMODEL'` 分支 |
| ZCL_AI_LLM_CLIENT | 不变（V1.2 版继续使用） |
| 三张 Z 表 / 既有实体与函数导入 | **零变更** |

## 三、改动文件

| 文件 | 内容 |
|------|------|
| `webapp/controller/App.controller.js` | 快捷指令（工厂/对话框/持久化）、停止生成、导出、测试模型、代码复制委托、AI meta 展示位 |
| `webapp/view/App.view.xml` | 快捷指令行×2（items 绑定+工厂）、顶栏导出按钮、sendBtnHero id |
| `webapp/view/SettingsDialog.fragment.xml` | 模型表格"测试"列 |
| `webapp/service/ChatService.js` | `testModel()`；契约注释补 TestModel；mock 文案加代码块 |
| `webapp/utils/Formatter.js` | 代码块 `.codeWrap` + 复制按钮 |
| `webapp/i18n/i18n.properties` | 新增 15 个 key；移除废弃的 quick1~4 |
| `webapp/css/style.css` | codeCopyBtn、quickItem/chipDel/quickAddBtn、quickDock 横滑、aiHeadMeta、testBtn |
| `backend-abap/*.abap`（3 个类更新） | 与 V1.3 文档一致 |
| `后端文档/...V1.3增补(前端V5功能适配).docx` | 新增 33 页：SEGW 步骤、勘误说明、3 个类完整源码、部署路径（全新/升级）、T11-T16 用例、排障补充 |

## 四、验证记录

| 检查项 | 结果 |
|--------|------|
| JS 语法（controller/service/formatter `node --check`） | ✅ |
| XML 良构（view/fragments）+ manifest JSON | ✅ |
| `ui5 build` 全量构建 ×2（改造后） | ✅ 成功 |
| GUI：快捷指令点击填入 | ✅ |
| GUI：发送→打字机→代码块渲染+abap 标签 | ✅ |
| GUI：代码块复制按钮"已复制"反馈 | ✅ |
| GUI：停止生成（stop 样式→点击→中断→"已停止生成"显示→忙碌解除） | ✅（修复了 AI 分支无 meta 展示位的问题） |
| GUI：添加指令（对话框→保存→新 chip→reload 持久化） | ✅ |
| GUI：删除指令（悬浮×→chip 消失） | ✅ |
| GUI：模型管理"测试"列渲染（mock 空表符合设计） | ✅ |
| GUI：导出触发浏览器下载事件 | ✅ |
| 视觉：V1.3 文档 33 页全部分析通过（表格无断词、代码无溢出乱码、末页干净收尾） | ✅ |
| postcheck（docx 自动检查） | ✅ 0 错误 0 警告 |

---

# 以下为 V4.0 历史清单

## 一、整体风格（DeepSeek 官网同款）
- **配色体系**：纯白画布 `#FFFFFF` + 浅灰蓝侧栏 `#F7F9FC` + 克莱因蓝 `#4D6BFE` 点缀；边框统一冷灰蓝 `#E2E6EF`
- **左侧栏**：浅灰蓝背景；会话列表灰字（`#575D6E`）、hover 浅灰、选中项浅蓝圆角高亮（`#EBF0FF` + 蓝字加粗），去掉了原来的橙色左侧圆条
- **空状态 Hero**：大号居中欢迎语"有什么我能帮你的吗？"（2rem，去衬线体），logo 方片改蓝渐变
- **输入卡片**：26px 大圆角白卡 + 聚焦蓝色光环；结构改为「输入区 + 底部功能行」，左下角新增两枚浅蓝功能小胶囊（深度思考 / 联网搜索，占位样式）、右下角圆形蓝色发送按钮

## 二、细节修复
1. **发送按钮**：由突兀的黑圆/纸飞机改为 **2.1rem 圆形克莱因蓝按钮 + 白色 ↑ 图标**（`sap-icon://slim-arrow-up`），hover 加深、按下微缩，与 DeepSeek 一致；禁用态浅灰
2. **"开启新对话"按钮**：改为**白底胶囊形**（999px 圆角、灰色发丝边），hover 浅灰底（`#F1F4F9`），与侧栏整体协调
3. 用户消息胶囊改浅蓝底深字；AI 头像、思考 shimmer、打字光标、快捷提问 hover 均改蓝色系

## 三、功能简化（prompt 只含用户输入）
- 删除 `_detectProgram` 关键词自动识别逻辑：不再从输入中提取 `ZAPP_...` 对象名
- `ChatService.send` 的 `programName` 参数**恒传空串**（保留参数位，API 兼容不变）→ 后端收到的 `Question` 仅为用户原文，不会附带"分析对象"
- 删除 `_buildMeta` 及消息气泡上的"已附带分析对象 XXX""对象 XXX（N 行）"等元信息展示（meta 恒为空，CSS `:empty` 自动隐藏）
- 清理 i18n 过时文案：`analysisTarget`、`toastProgramDetected` 删除；`welcomeSub` 去掉"自动提取源码"说明
- ⚠️ 注意：若 ABAP 后端 `ZAI_CHAT_SRV` 在组装 prompt 时仍拼接"分析对象/如期时间"等字段（`如期时间` 前端从未发送过，应来自后端模板），需在后端同步调整 prompt 模板

## 四、未受影响的功能
模型管理（新增/编辑/启停）、设置（连接/模式切换）、i18n、流式打字机输出、滚动修复（min-height:0 / Flex 收缩）、会话历史（本地 + 后端）逻辑全部保留，零改动。

## 五、改动文件
| 文件 | 改动 |
|------|------|
| `webapp/css/style.css` | 整体重写为 DeepSeek 配色；新增 `.inputFoot`/`.pillRow`/`.pillChip` 样式 |
| `webapp/view/App.view.xml` | 输入卡片结构重排；发送键图标改 ↑；移除 heroSub |
| `webapp/controller/App.controller.js` | 删除 `_detectProgram`/`_buildMeta`；onSend 简化；programName 恒空 |
| `webapp/i18n/i18n.properties` | heroTitle 改欢迎语；新增胶囊文案；清理过时 key |
| `README.md` | 补充 V4.0 更新说明 |

校验：App.view.xml / 两个 fragment XML 良构检查通过；App.controller.js / ChatService.js / Formatter.js `node --check` 通过。
