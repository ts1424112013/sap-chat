/* ============================================================
 * V9 · 部署配置（本文件是部署环境的唯一事实源）
 * ------------------------------------------------------------
 * 前端启动时【始终】以本文件连接后端 —— 解决"刚部署读不到后端
 * 地址"的问题。测试库/生产库切换 = 修改本文件后重新部署（或直接
 * 改 dist/config.js 后刷新）。
 *
 * 设置对话框里管理员改的连接配置【仅本次会话有效】，刷新后回到
 * 本文件的值（部署配置优先，避免环境漂移）。
 * ============================================================ */
window.ZAI_CONFIG = {
        /* 后端模式：backend = 请求 OData；mock = 演示模式（不请求服务）
         * 启动时会探测后端：探测失败（网络不通/服务未就绪）自动降级为
         * mock + 本地管理员 admin/123456，保证任何时候都能打开页面 */
        mode: "backend",

        /* 后端地址：
         *  - 部署在 SAP 同域（BSP/UI5 仓库）或经反代时留空 ""（同源，推荐，无 CORS 问题）
         *  - 跨域直连网关时填完整前缀，如 "https://sapgls4dev.corp.local:44300"（网关需放行 CORS） */
        host: "",

        /* OData 服务路径（与 SEGW 发布的服务一致） */
        path: "/sap/opu/odata/sap/ZAI_CHAT_SRV/",

        /* 启动探测超时（毫秒）。20261019（FE-10）：4000 → 12000，网关冷启动时首个
           $metadata 可能超过 4 秒，原值会误判为后端不可用而降级成演示模式 */
        probeTimeoutMs: 12000,

        /* ── UI5 框架来源与主题（内网部署关键项）────────────────────
         * ui5Src 三选一：
         * ① 缺省 "" = OpenUI5 公网 CDN 1.130（开发机可上外网时用）
         * ② 服务器自带运行时（版本偏低，760 老系统）:
         *    "/sap/public/bc/ui5_ui5/common/resources/sap-ui-core.js"
         * ③ ★当前采用·随包自带: "./resources/sap-ui-core.js"
         *    （ui5.yaml 已声明 framework，npm run build 会把 UI5 1.130
         *      运行时打进 dist —— 不依赖公网、不依赖服务器版本；
         *      本地开发 ui5 serve 亦从本地框架缓存提供 /resources，同样离线可用）
         * ui5Theme：服务器只有旧主题库时改 "sap_fiori_3"；
         *           npm run build 的完整 dist 同时打包 horizon/fiori_3 两套主题库；
         *           部署精简包（npm run build:deploy）只保留这里写的主题，
         *           改主题后要重新生成精简包 */
        ui5Src: "./resources/sap-ui-core.js",
        ui5Theme: "sap_horizon",

        /* 20261107：浏览器 Agent 引擎（Deep Agents 浏览器版）
         *  enabled：false = 完全隐藏「新引擎」开关（一切照旧走原 Agent）
         *  path：SAP 上的 Agent 服务（SICF 节点，处理类 ZCL_AI_AGENT_HTTP）
         * 需要 HTTPS 打开页面；用户在输入框下自己打开开关，是否允许使用由 SAP 端判断 */
        browserAgent: {
                enabled: true,
                path: "/sap/bc/zai_agent",
                /* 20261108：Agent 只用新引擎（覆盖原引擎）；浏览器跑不了新引擎时（非 HTTPS 等）才退回原 Agent。
                 * 改成 false 恢复「设置里开关、默认用 defaultOn」的做法 */
                only: true,
                /* only = false 时：用户没在设置里开 / 关过时的默认值 */
                defaultOn: false,
                /* 20261108：「新引擎」开关放在输入框下（true）还是只在设置里（false，默认） */
                toggleInInput: false
        }
};
