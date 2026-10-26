# 灵犀 LingXi 前端增量包

项目已接入确认的彩色叶翼与加强动效。等待时使用思考动效，正文输出或后台报表执行时使用运行动效，结束与停止后柔和回位。

## 侧栏滚动条优化

会话列表使用细滚动条和透明轨道，去掉深色主题中的白色粗轨道；亮暗主题自动适配，悬停或键盘进入列表时加深。用 36 条会话验证主题、滚轮、拖动、搜索和切换正常，无脚本异常。

## 参数卡呈现优化

参数卡等待说明文字完整输出后再显示，不抢焦点，不强制把阅读位置滚到表单底部。默认值、草稿与手动确认保留。最新相关检查：会话 19 项、Fiori 118 项、结果恢复 18 项通过；实际页面的顺序、焦点、滚动和提交已验证。

## 品牌接入验证

- 前端逻辑测试 86 项、会话切换测试 16 项、结果恢复测试 18 项，共 120 项通过。
- 在构建后的实际 UI5 应用中检查登录、演示登录、首页、正文输出、停止、正常完成、请求失败、后台运行、亮暗主题、多个头像渐变和减少动态效果。
- 重复设置同一状态保持原 SVG 和动画时钟；快速切换后销毁控件未产生脚本错误。
- 正式构建通过，预加载包包含新图形源、组件和状态模块，已无旧 Momo 品牌引用。

## 发布

`LingXi前端增量.zip` 第一层直接是应用文件，不含额外 dist 目录。包含新旧修改的应用资源及 Component-preload.js；保留服务器原有 config.js 与 UI5 运行时。

按 docs/04-前端实施文档.md 的 BSP 增量上传流程发布并刷新缓存。无需修改后端接口或数据表。当前已经完成本地项目修改和构建，SAP 服务器尚未上传。

## 包内文件

- Component-preload.js
- control/LingXiArtwork-dbg.js
- control/LingXiArtwork.js
- control/LingXiMark-dbg.js
- control/LingXiMark.js
- controller/App.controller.js
- css/style-gale.css
- css/style-lingxi.css
- i18n/i18n.properties
- images/lingxi-favicon.svg
- images/lingxi-mark.svg
- index.html
- manifest.json
- service/AuthMockBackend-dbg.js
- service/AuthMockBackend.js
- service/ChatService-dbg.js
- service/ChatService.js
- utils/ChartRenderer-dbg.js
- utils/ChartRenderer.js
- utils/LingXiState-dbg.js
- utils/LingXiState.js
- utils/WelcomeToast-dbg.js
- utils/WelcomeToast.js
- view/App.view.xml
