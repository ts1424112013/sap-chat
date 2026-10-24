sap.ui.define([], function () {
        "use strict";

        /**
         * =====================================================================
         * ChatService 拆分块：演示模式（mock）后端
         * =====================================================================
         * 本地存储的会话/消息、模型列表、对话与 Agent 的示例回复、能力目录样例、
         * 本地初始管理员与 mock 用户表。以 mixin 方式并入 ChatService
         * （方法里的 this 就是 ChatService），各接口里的 mode === "mock" 分支调用这里。
         * 20261011（改进清单 FE-09）从 ChatService.js 原样搬出，逻辑未改；
         * 原来直接引用模块内变量 Service 的方法改为 var Service = this。
         * =====================================================================
         */
        return {

                /** V1.3：演示模式能力目录样例（MARA，与后端 P0 注册一致） */
                _mockCapability: function () {
                        return {
                                Entity: "MARA",
                                Label: "物料主档",
                                Dimensions: "MATNR,MTART,MATKL,ERSDA,MEINS",
                                Metrics: "count",
                                Operations: "detail,group,trend",
                                MaxRows: "1000",
                                TimeoutSec: "30",
                                Permission: "S_TABU_DIS/S_TABU_NAM(需SAP端确认)",
                                SensitiveFields: ""
                        };
                },

                // =================================================================
                // Mock 实现（演示模式）
                // =================================================================
                /**
                 * Mock 本地持久化存储：{ sessions:[], messages:{sid:[rows]} }
                 * 演示模式下会话/消息保存在浏览器 localStorage，体验与后端模式一致
                 */
                _mockStore: function () {
                        var Service = this;   // 混入 ChatService 后 this 即服务对象
                        if (!Service._oMockStore) {
                                var sRaw = "{}";
                                try { sRaw = window.localStorage.getItem("zaiChat.mockData") || "{}"; } catch (e) { /* 忽略 */ }
                                var oStore = {};
                                try { oStore = JSON.parse(sRaw) || {}; } catch (e) { oStore = {}; }
                                oStore.sessions = oStore.sessions || [];
                                oStore.messages = oStore.messages || {};
                                Service._oMockStore = oStore;
                        }
                        return Service._oMockStore;
                },

                _mockSave: function (oStore) {
                        try { window.localStorage.setItem("zaiChat.mockData", JSON.stringify(oStore)); } catch (e) { /* 忽略 */ }
                },

                _mockModels: function () {
                        return new Promise(function (fnResolve) {
                                setTimeout(function () {
                                        fnResolve([
                                                { ModelId: "MOCK_OLLAMA_QWEN", ModelName: "本地 Ollama - Qwen2.5:14B", ModelDesc: "演示：本地私有化模型", ModelType: "OLLAMA", EndpointUrl: "http://192.168.1.50:11434/api/chat", IsActive: "X", ApiKeySet: "" },
                                                { ModelId: "MOCK_DEEPSEEK", ModelName: "DeepSeek Chat API", ModelDesc: "演示：云端模型", ModelType: "OPENAI", EndpointUrl: "https://api.deepseek.com/v1/chat/completions", IsActive: "X", ApiKeySet: "X" },
                                                { ModelId: "MOCK_VLLM", ModelName: "vLLM 私有服务 - Llama3.1:8B", ModelDesc: "演示：OpenAI 兼容私有服务", ModelType: "OPENAI", EndpointUrl: "http://192.168.1.60:8000/v1/chat/completions", IsActive: "X", ApiKeySet: "" }
                                        ]);
                                }, 300);
                        });
                },

                _mockSend: function (oPayload) {
                        var Service = this;   // 混入 ChatService 后 this 即服务对象
                        return new Promise(function (fnResolve) {
                                setTimeout(function () {
                                        var bHasCode = !!oPayload.programName;
                                        var sAnswer = bHasCode
                                                ? [
                                                        "### 【演示模式】代码分析示例 - " + oPayload.programName,
                                                        "",
                                                        "当前为**演示模式**，未读取真实 SAP 代码。完成《后端实施文档》配置后，此处将显示基于 `READ REPORT` 提取源码的真实大模型分析结果。典型分析输出如下：",
                                                        "",
                                                        "#### 1. 代码结构",
                                                        "- 报表主程序 + 包含程序结构清晰",
                                                        "- 建议将业务逻辑下沉到全局类，提升可测试性",
                                                        "",
                                                        "#### 2. 性能建议",
                                                        "- 避免 `SELECT *`，仅选取所需字段",
                                                        "- 内表操作前排序 + 二分查找，替代嵌套 LOOP",
                                                        "",
                                                        "```abap",
                                                        "\" 优化示例：使用字段清单 + 二分查找",
                                                        "SELECT matnr, werks, lgort FROM marc",
                                                        "  INTO TABLE @DATA(lt_marc)",
                                                        "  WHERE matnr = @lv_matnr.",
                                                        "",
                                                        "SORT lt_marc BY werks.",
                                                        "READ TABLE lt_marc INTO DATA(ls_marc) WITH KEY werks = '1000' BINARY SEARCH.",
                                                        "```",
                                                        "",
                                                        "> 耗时约 " + (600 + Math.floor(Math.random() * 900)) + " ms（模拟）"
                                                ].join("\n")
                                                : [
                                                        "【演示模式】你好！我还没有连接真实的大模型。",
                                                        "",
                                                        "1. 打开右上角 **设置** → **连接**，切换到 *后端模式*",
                                                        "2. 按《ABAP 后端实施文档》在 SAP 端创建 ZAI_CHAT_SRV 服务",
                                                        "3. 在 **设置 → 模型管理** 中维护你的本地私有化大模型",
                                                        "",
                                                        "对话模式是纯 AI 问答，不读取 SAP 系统数据；要解读系统里的程序 / 查表 / 跑报表，请切到 Agent 选择对应场景。回复中的代码块可一键复制：",
                                                        "",
                                                        "```abap",
                                                        "\" 连接真实后端后的典型分析回复示例",
                                                        "SELECT matnr, werks FROM marc",
                                                        "  INTO TABLE @DATA(lt_marc)",
                                                        "  WHERE werks = @lv_werks.",
                                                        "```",
                                                        "",
                                                        "> 当前耗时与回复均为模拟数据。"
                                                ].join("\n");
                                        var iElapsed = 600 + Math.floor(Math.random() * 900);

                                        // 记录到内存历史，模拟多轮对话
                                        var oStore = Service._mockStore();
                                        var aHist = oStore.messages[oPayload.sessionId] = oStore.messages[oPayload.sessionId] || [];
                                        var sNow = Service._mockTime();
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "user", Content: oPayload.question, ProgramName: oPayload.programName || "", CreatedAt: sNow, Status: "OK" });
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "assistant", Content: sAnswer, ProgramName: oPayload.programName || "", CreatedAt: sNow, Status: "OK" });

                                        // 会话列表 upsert（标题取首条提问，与后端 ZAI_CHAT_SESS 行为一致）
                                        var oSess = oStore.sessions.filter(function (s) { return s.SessionId === oPayload.sessionId; })[0];
                                        if (!oSess) {
                                                oStore.sessions.unshift({
                                                        SessionId: oPayload.sessionId,
                                                        Title: oPayload.question.length > 24 ? oPayload.question.substring(0, 24) + "…" : oPayload.question,
                                                        ModelId: oPayload.modelId || "",
                                                        MsgCount: "2",
                                                        CreatedAt: sNow,
                                                        ChangedAt: sNow,
                                                        Mode: "CHAT",      // V12：普通对话会话
                                                        AgentType: "",
                                                        Status: "IDLE"
                                                });
                                        } else {
                                                oSess.ChangedAt = sNow;
                                                oSess.MsgCount = String((parseInt(oSess.MsgCount || "0", 10) || 0) + 2);
                                        }
                                        Service._mockSave(oStore);

                                        fnResolve({
                                                answer: sAnswer,
                                                status: "OK",
                                                elapsedMs: iElapsed,
                                                codeLines: bHasCode ? 128 + Math.floor(Math.random() * 800) : 0,
                                                message: "",
                                                modelId: oPayload.modelId
                                        });
                                }, 900);
                        });
                },

                _mockTime: function () {
                        var d = new Date();
                        var p = function (n) { return (n < 10 ? "0" : "") + n; };
                        return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
                },

                /**
                  * V13：通用 Agent 演示实现 —— 任意问题都返回思考阶段摘要
                  * （UNDERSTANDING/PLANNING/TOOL_DECISION/COMPOSING）；
                  * 仅库存类问题模拟 EXECUTING 工具步骤（通用规则：无匹配工具
                  * 不虚构执行，直接分析后回答）。
                  * V1.3：统计/物料主档类问题模拟数据分析路径 —— 返回带 datasets
                  * （统一数据集）+ charts（bar/line/pie）+ findings 的 AnalysisJson，
                  * 用于本地验证表格与 SVG 图表渲染（与后端契约同构）。
                  */
                _mockSendAgent: function (oPayload) {
                        var Service = this;   // 混入 ChatService 后 this 即服务对象
                        // 20261020：「Fiori 报表」会话走 FioriMockBackend（选报表 → 参数卡 → 分析闸门）
                        var oKnown = Service._mockStore().sessions.filter(function (s) { return s.SessionId === oPayload.sessionId; })[0];
                        var sSceneNow = String((oKnown && oKnown.AgentType) || oPayload.scene || "").toUpperCase();
                        if (sSceneNow === "FIORI" && Service._mockFioriAgent) {
                                return Service._mockFioriAgent(oPayload);
                        }
                        // 20261024：「报表执行」会话里的「执行 <TCode>」→ 演示参数卡（其余问题照旧走通用演示）
                        var pReport = sSceneNow === "REPORT" && Service._mockReportAgent ? Service._mockReportAgent(oPayload) : null;
                        if (pReport) {
                                return pReport;
                        }
                        return new Promise(function (fnResolve) {
                                setTimeout(function () {
                                        var sQ = (oPayload.question || "").toLowerCase();
                                        // V1.3：统计意图优先（且不含库存专有词）→ 数据分析演示；
                                        // 其余含库存词的问题仍走库存工具演示
                                        var bData = /统计|汇总|趋势|分布|占比|分析|多少|排名|mara|主档/.test(sQ)
                                                && !/库存|收发|收货|发料|盘点|库位|批次/.test(sQ);
                                        var bInv = !bData && /库存|在库|收发|收货|发料|盘点|库位|批次|料号|物料/.test(sQ);
                                        var iElapsed = 2100 + Math.floor(Math.random() * 900);
                                        var aTrace = [
                                                { phase: "UNDERSTANDING", label: "理解问题", status: "OK", elapsedMs: 420 },
                                                { phase: "PLANNING", label: "制定计划", status: "OK", elapsedMs: 380 },
                                                { phase: "TOOL_DECISION", label: "检查可用工具", status: "OK", elapsedMs: 160 }
                                        ];
                                        var sAnswer;
                                        var oAnalysis = null;
                                        if (bInv) {
                                                aTrace.push({ phase: "EXECUTING", tool: "get_stock_snapshot", label: "查询库存快照（MARD 0001/A001，演示）", status: "OK", elapsedMs: 580, rows: 2 });
                                                aTrace.push({ phase: "EXECUTING", tool: "get_daily_movement", label: "查询当天收发（MSEG 过账日汇总，演示）", status: "OK", elapsedMs: 710, rows: 2 });
                                                aTrace.push({ phase: "COMPOSING", label: "整理回答", status: "OK", elapsedMs: 1200 });
                                                sAnswer = [
                                                        "【A001 在 0001 工厂的库存分析】(单位: PC)",
                                                        "",
                                                        "◆ 当前库存合计 120（非限制 100 / 质检 20 / 退货 0）",
                                                        "  - 库位 1001: 80 ｜ 库位 1002: 40",
                                                        "◆ 当天收发: 收 50（101 入库），发 30（261 生产领料），净增 20",
                                                        "",
                                                        "> 【演示模式】以上数字为内置示例。切换后端模式后，Agent 将按需调用",
                                                        "> 库存只读工具实时查询，并在「已思考」卡中展示真实阶段摘要。"
                                                ].join("\n");
                                        } else if (bData) {
                                                // V1.3：数据分析演示（与后端统一数据集契约同构）
                                                var oDsGroup = {
                                                        name: "按物料类型统计",
                                                        status: "OK",
                                                        columns: [
                                                                { name: "MTART", label: "物料类型", numeric: false },
                                                                { name: "COUNT", label: "数量", numeric: true }
                                                        ],
                                                        rows: [["FERT", 128], ["ROH", 86], ["HALB", 52], ["HAWA", 35], ["VERP", 18]],
                                                        total_rows: 5,
                                                        truncated: false,
                                                        elapsed_ms: 34,
                                                        source: "SAP ABAP Service"
                                                };
                                                var oDsTrend = {
                                                        name: "按创建月份趋势",
                                                        status: "OK",
                                                        columns: [
                                                                { name: "ERSDA", label: "创建月份", numeric: false },
                                                                { name: "COUNT", label: "数量", numeric: true }
                                                        ],
                                                        rows: [["2026-04", 42], ["2026-05", 58], ["2026-06", 61], ["2026-07", 49], ["2026-08", 73], ["2026-09", 88]],
                                                        total_rows: 6,
                                                        truncated: false,
                                                        elapsed_ms: 28,
                                                        source: "SAP ABAP Service"
                                                };
                                                oAnalysis = {
                                                        summary: "共统计 319 条物料，以 FERT(成品) 和 ROH(原材料) 为主；近半年创建量整体上升。",
                                                        findings: [
                                                                { title: "类型分布", detail: "FERT 128 条占比最高(40%)，其次 ROH 86 条(27%)。", severity: "info" },
                                                                { title: "创建趋势", detail: "2026-09 新建 88 条，为近半年峰值，环比 +21%。", severity: "info" },
                                                                { title: "长尾类型", detail: "VERP(包装) 仅 18 条，维护关注度较低。", severity: "warn" }
                                                        ],
                                                        charts: [
                                                                { type: "bar", title: "各物料类型数量", dataset: "按物料类型统计", x: "MTART", y: "COUNT" },
                                                                { type: "pie", title: "物料类型占比", dataset: "按物料类型统计", x: "MTART", y: "COUNT" },
                                                                { type: "line", title: "近半年创建趋势", dataset: "按创建月份趋势", x: "ERSDA", y: "COUNT" }
                                                        ],
                                                        datasets: [oDsGroup, oDsTrend]
                                                };
                                                aTrace.push({ phase: "EXECUTING", tool: "sap_data_analysis", label: "数据分析查询: 按物料类型统计, 5 行", status: "OK", elapsedMs: 640, rows: 5 });
                                                aTrace.push({ phase: "EXECUTING", tool: "sap_data_analysis", label: "数据分析查询: 按创建月份趋势, 6 行", status: "OK", elapsedMs: 520, rows: 6 });
                                                aTrace.push({ phase: "COMPOSING", label: "生成结构化分析", status: "OK", elapsedMs: 860 });
                                                sAnswer = [
                                                        "【物料主档分析】",
                                                        "",
                                                        "◆ 共 319 条物料，按类型分组：FERT 128、ROH 86、HALB 52、HAWA 35、VERP 18；",
                                                        "◆ 近半年创建量整体上升，2026-09 达到峰值 88 条。",
                                                        "",
                                                        "> 【演示模式】数据集与图表为内置示例，切换后端模式后由",
                                                        "> sap_data_analysis 工具按能力目录真实取数（MARA detail/group/trend）。"
                                                ].join("\n");
                                        } else {
                                                aTrace.push({ phase: "COMPOSING", label: "整理回答", status: "OK", elapsedMs: 1600 });
                                                sAnswer = [
                                                        "我按以下思路处理了你的问题：先理解目标与上下文，再检查可用工具，",
                                                        "最后整理回答。当前为**演示模式**，未连接真实模型与 SAP 工具。",
                                                        "",
                                                        "- 若问题需要库存等系统数据，后端模式下的 Agent 会自动选择并调用",
                                                        "  已注册的只读工具，回答中的数字均可溯源到具体查询；",
                                                        "- 若不需要工具（如解释、写作、方案设计），Agent 会直接基于分析回答，",
                                                        "  不会虚构「已查询系统」。",
                                                        "",
                                                        "你可以在 Agent 模式直接继续追问，我会沿用当前会话上下文。"
                                                ].join("\n");
                                        }

                                        // 与 _mockSend 相同的本地持久化（20261011：与后端一致 —— 新会话写入场景，之后固定）
                                        var oStore = Service._mockStore();
                                        var aHist = oStore.messages[oPayload.sessionId] = oStore.messages[oPayload.sessionId] || [];
                                        var sNow = Service._mockTime();
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "user", Content: oPayload.question, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "assistant", Content: sAnswer, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        var oSess = oStore.sessions.filter(function (s) { return s.SessionId === oPayload.sessionId; })[0];
                                        if (!oSess) {
                                                oStore.sessions.unshift({
                                                        SessionId: oPayload.sessionId,
                                                        Title: oPayload.question.length > 24 ? oPayload.question.substring(0, 24) + "…" : oPayload.question,
                                                        ModelId: oPayload.modelId || "",
                                                        MsgCount: "2",
                                                        CreatedAt: sNow,
                                                        ChangedAt: sNow,
                                                        Mode: "AGENT",                    // V13：通用 Agent 会话
                                                        AgentType: /^(REPORT|FIORI|DATA|INVENTORY|CODE)$/.test(String(oPayload.scene || "").toUpperCase())
                                                                ? String(oPayload.scene).toUpperCase() : "GENERAL",
                                                        Status: "COMPLETED"
                                                });
                                        } else {
                                                oSess.ChangedAt = sNow;
                                                oSess.MsgCount = String((parseInt(oSess.MsgCount || "0", 10) || 0) + 2);
                                                oSess.Mode = "AGENT";
                                                oSess.AgentType = oSess.AgentType || "GENERAL";   // 场景固定，不改写
                                                oSess.Status = "COMPLETED";
                                        }
                                        Service._mockSave(oStore);

                                        fnResolve({
                                                answer: sAnswer,
                                                status: "OK",
                                                elapsedMs: iElapsed,
                                                rounds: 3,
                                                message: "",
                                                modelId: oPayload.modelId || "AUTO",
                                                trace: aTrace,
                                                analysis: Service._sanitizeAnalysis(oAnalysis)
                                        });
                                }, 1800);
                        });
                },

                /** 本地初始管理员校验（mock / 后端未初始化窗口期）
                 *  密码存 localStorage hash：初始 123456；管理员改密后覆盖；
                 *  后端初始化完成后本路径永久拒绝（isBackendInitialized=true） */
                _mockAppLogin: function (sUser, sPass) {
                        var that = this;
                        return this.isBackendInitialized().then(function (bInit) {
                                if (sUser.toUpperCase() === "ADMIN") {
                                        if (bInit) {
                                                throw new Error("initGone");
                                        }
                                        var sStored = null;
                                        try { sStored = window.localStorage.getItem("zaiChat.adminPwdHash"); } catch (e) { /* 忽略 */ }
                                        // 初始密码与已改密码统一走异步 SHA-256 比对
                                        var pExpect = sStored ? Promise.resolve(sStored) : that._sha256("zai#123456");
                                        return Promise.all([that._sha256("zai#" + sPass), pExpect]).then(function (a) {
                                                if (a[0] !== a[1]) {
                                                        throw new Error("bad");
                                                }
                                                return {
                                                        userId: "ADMIN",
                                                        userName: "管理员",
                                                        role: "ADMIN",
                                                        mustChangePwd: !sStored   // 仍在用初始密码 → 强制修改
                                                };
                                        });
                                }
                                // 普通用户：mock 用户表（模拟管理员开通的 SAP 用户）
                                var aUsers = that._mockUsers();
                                var oHit = aUsers.filter(function (u) { return u.UserId.toUpperCase() === sUser.toUpperCase(); })[0];
                                if (!oHit || oHit.Active !== "X" || oHit.PwdHash !== that._sha256Sync("zai#" + sPass)) {
                                        throw new Error("bad");
                                }
                                return { userId: oHit.UserId, userName: oHit.UserName || oHit.UserId, role: oHit.Role, mustChangePwd: false };
                        });
                },

                /** 同步摘要仅用于 mock 种子数据的比对（真实校验走异步 _sha256） */
                _sha256Sync: function (sText) {
                        // 32 位简易摘要：mock 环境防明文即可，真实环境由后端校验
                        var h = 5381, i = sText.length;
                        while (i) { h = (h * 33) ^ sText.charCodeAt(--i); }
                        return "m" + (h >>> 0).toString(16);
                },

                /** mock 用户表（模拟后端 ZAI_CHAT_USER）：管理员开通的 SAP 用户 */
                _mockUsers: function () {
                        if (!this._oMockUsers) {
                                var sRaw = "[]";
                                try { sRaw = window.localStorage.getItem("zaiChat.mockUsers") || "[]"; } catch (e) { /* 忽略 */ }
                                try { this._oMockUsers = JSON.parse(sRaw) || []; } catch (e) { this._oMockUsers = []; }
                        }
                        return this._oMockUsers;
                },

                _mockSaveUsers: function () {
                        try { window.localStorage.setItem("zaiChat.mockUsers", JSON.stringify(this._oMockUsers || [])); } catch (e) { /* 忽略 */ }
                }
        };
});
