sap.ui.define([
        "sap/base/Log",
        "sap/ui/model/odata/v2/ODataModel",
        "sap/ui/model/Filter",
        "sap/ui/model/FilterOperator",
        "sap/ui/model/Sorter",
        "zai/chat/service/TraceService",
        "zai/chat/service/MockBackend",
        "zai/chat/service/AuthMockBackend",
        "zai/chat/service/FioriMockBackend",
        "zai/chat/service/SkillService"
], function (Log, ODataModel, Filter, FilterOperator, Sorter, TraceService, MockBackend, AuthMockBackend, FioriMockBackend, SkillService) {
        "use strict";

        /**
         * =====================================================================
         * 聊天服务层（唯一与"外部世界"打交道的地方）
         * =====================================================================
         * 两种工作模式：
         *   1. mock    演示模式 —— 不请求任何服务，内置示例数据（后端未就绪时可用）
         *   2. backend 后端模式 —— 调用 ABAP 网关 OData 服务 ZAI_CHAT_SRV
         *
         * 后端契约（与《后端实施文档》严格一致）：
         *   GET  /Models                             → 模型列表
         *   GET  /Messages?$filter=SessionId eq 'xx' → 会话历史
         *   GET  /Sessions                           → 会话列表（左侧历史栏）
         *   DELETE /Sessions('id')                   → 删除会话
         *   POST /AnalyzeCode(SessionId,Question,ModelId,ProgramName) → 代码分析/对话
                 *   POST /AnalyzeAgent(SessionId,Question,ModelId) → 通用 Agent/数据分析
                 *        受限工具循环(返回 AgentResult, 含 TraceJson/AnalysisJson)
                 *        AnalysisJson(可选): {summary,findings[],charts[],datasets[]}
                 *        —— 数据分析统一数据集与图表配置(后端已校验, 前端仅复核)
                 *   GET  /AgentCapabilities                  → 数据分析能力目录(V1.3)
                 *   POST /SaveModelCfg(...)                  → 模型配置维护
         *   POST /TestModel(ModelId)                 → V1.3 模型连通性测试
         * =====================================================================
         */
        var Service = {

                _sConfig: {
                        mode: "mock",       // "mock" | "backend"
                        host: "",           // 如 http://s4hana.example.com:8000，留空=同源（走本地代理）
                        path: "/sap/opu/odata/sap/ZAI_CHAT_SRV/"
                },
                _oODataModel: null,

                /** V5.1：SAP 网关登录凭据（HTTP Basic）——内存 + sessionStorage（zaiChat-sapAuth） */
                _sSapUser: "",
                _sSapPass: "",
                _sSapHeader: "", // V5.3：Basic 认证头直填模式（"Basic xxx"，优先于账密）
                _oAuthStore: { loaded: false },

                /** V5.1：401 回调（控制器注册，用于自动弹登录框） */
                onAuthFailed: null,
                _iLastAuthFailTs: 0,

                /** 注入配置（控制器在初始化/设置变更时调用） */
                setConfig: function (oConfig) {
                        var bModeChanged = this._sConfig.mode !== oConfig.mode;
                        this._sConfig = jQuery.extend(true, {}, this._sConfig, oConfig);
                        if (bModeChanged) {
                                this._oODataModel = null; // 模式切换后重建 OData 模型
                        }
                },

                getConfig: function () {
                        return jQuery.extend(true, {}, this._sConfig);
                },

                getMode: function () {
                        return this._sConfig.mode;
                },

                /** 惰性创建 v2 OData 模型（后端模式专用） */
                _getModel: function () {
                        if (!this._oODataModel) {
                                var sUrl = this._sConfig.host + this._sConfig.path;
                                // V5.2 联调修复：凭据必须在【构造参数】里传入 ——
                                // v2 ODataModel 构造瞬间就会异步请求 $metadata，
                                // 构造后再 setHeaders 时 metadata 请求已经发出（不带凭据 → 401，
                                // 且模型缓存该错误状态，后续请求全部失败）。
                                // 根因见《前后端联调问题排查手册》问题 3。
                                var sBasic = this._basicHeader();
                                this._oODataModel = new ODataModel({
                                        serviceUrl: sUrl,
                                        json: true,
                                        useBatch: false,
                                        defaultCountMode: "None",
                                        headers: sBasic ? { "Authorization": sBasic } : undefined
                                });
                                // 双保险：显式 setHeaders（覆盖 metadata/token/CRUD 全部请求）
                                if (sBasic) {
                                        this._oODataModel.setHeaders({ "Authorization": sBasic });
                                }
                                // 本地大模型响应较慢，禁用浏览器默认超时由网关控制
                        }
                        return this._oODataModel;
                },

                // =================================================================
                // V5.1/V5.3：SAP 网关凭据（HTTP Basic）
                // V8 起凭据只来自应用层登录（appLogin → setSapCredentials）；
                // 旧版"Basic 头直填"登录框已退役，_sSapHeader 仅保留读兼容
                // =================================================================

                /** 生成 Basic 头（凭据未保存时返回 null）；Basic 头直填模式优先 */
                _basicHeader: function () {
                        this._loadAuthStore();
                        if (this._sSapHeader) {
                                return this._sSapHeader;
                        }
                        if (!this._sSapUser) {
                                return null;
                        }
                        var sRaw = this._sSapUser + ":" + (this._sSapPass || "");
                        // SAP 密码可含非 ASCII 字符，先按 UTF-8 编码再 base64
                        return "Basic " + btoa(unescape(encodeURIComponent(sRaw)));
                },

                /** 首次使用时从 sessionStorage 恢复凭据；兼容清理旧 localStorage 凭据 */
                _loadAuthStore: function () {
                        if (this._oAuthStore.loaded) {
                                return;
                        }
                        this._oAuthStore.loaded = true;
                        try {
                                var sRaw = window.sessionStorage.getItem("zaiChat-sapAuth");
                                // 旧版本可能把密码留在 localStorage，升级时主动删除，不迁移密码。
                                try { window.localStorage.removeItem("zaiChat-sapAuth"); } catch (e0) { /* 忽略 */ }
                                var o = sRaw ? JSON.parse(sRaw) : null;
                                if (o) {
                                        this._sSapUser = o.user || "";
                                        this._sSapPass = o.pass || "";
                                        this._sSapHeader = o.header || "";
                                }
                        } catch (e) { /* 忽略 */ }
                },

                /**
                 * 保存网关凭据（用户名+密码形态）并使其立即生效（重建 OData 模型）
                 * @param {string} sUser 用户名
                 * @param {string} sPass 密码
                 * @param {boolean} bRemember true=写入本次浏览器会话；false=仅内存
                 */
                setSapCredentials: function (sUser, sPass, bRemember) {
                        this._oAuthStore.loaded = true;
                        this._sSapUser = sUser || "";
                        this._sSapPass = sPass || "";
                        this._sSapHeader = ""; // 账密模式覆盖 Basic 头模式
                        this._persistAuth(bRemember);
                        this._oODataModel = null; // 重建以应用新 Basic 头并重新取 metadata/token
                },

                /** 凭据写入 sessionStorage（仅 bRemember 时） */
                _persistAuth: function (bRemember) {
                        try {
                                if (bRemember && (this._sSapUser || this._sSapHeader)) {
                                        window.sessionStorage.setItem("zaiChat-sapAuth", JSON.stringify({
                                                user: this._sSapUser,
                                                pass: this._sSapPass,
                                                header: this._sSapHeader
                                        }));
                                } else {
                                        window.sessionStorage.removeItem("zaiChat-sapAuth");
                                }
                        } catch (e) { /* 忽略 */ }
                },

                /** 清除网关凭据（内存 + sessionStorage） */
                clearSapCredentials: function () {
                        this._sSapUser = "";
                        this._sSapPass = "";
                        this._sSapHeader = "";
                        try { window.sessionStorage.removeItem("zaiChat-sapAuth"); } catch (e) { /* 忽略 */ }
                        this._oODataModel = null;
                },

                /**
                 * V5.3：多标签页同步 —— 其他窗口登录/清除凭据后调用本方法，
                 * 强制丢弃内存凭据缓存并从 sessionStorage 重读，重建 OData 模型。
                 * （storage 事件由控制器监听，见 App.controller onInit）
                 */
                reloadAuth: function () {
                        this._oAuthStore.loaded = false;
                        this._sSapUser = "";
                        this._sSapPass = "";
                        this._sSapHeader = "";
                        this._loadAuthStore();
                        this._oODataModel = null;
                },

                /** OData 请求返回 401 时触发 onAuthFailed 回调（60 秒防抖） */
                _maybeAuthFail: function (oError) {
                        var iCode = oError && oError.statusCode;
                        // metadata/token 失败时状态码可能只在 message 文本里（v2 模型包装后的错误）
                        var sBody = ((oError && oError.responseText) || "") + " " + ((oError && oError.message) || "");
                        var b401 = iCode === 401 || /HTTP 401|"code":401|401[^0-9].{0,20}(Unauthorized|unauthorized)|Unauthorized/i.test(sBody);
                        if (!b401 || !this.onAuthFailed) {
                                return;
                        }
                        var iNow = Date.now();
                        if (iNow - this._iLastAuthFailTs < 60000) {
                                return;
                        }
                        this._iLastAuthFailTs = iNow;
                        try { this.onAuthFailed(); } catch (e) { /* 忽略 */ }
                },

                /** Promise 化 ODataModel.read */
                _read: function (sPath, oOptions) {
                        var oModel = this._getModel();
                        var that = this;
                        return new Promise(function (fnResolve, fnReject) {
                                oModel.read(sPath, jQuery.extend({
                                        success: function (oData) { fnResolve(oData); },
                                        error: function (oError) {
                                                that._maybeAuthFail(oError);
                                                fnReject(Service._fmtError(oError));
                                        }
                                }, oOptions || {}));
                        });
                },

                /** 统一错误信息提取 */
                _fmtError: function (oError) {
                        // V15.0.1: 原 !sMsg 恒 false 吞掉真实错误(HTTP 400 只显示"未知错误")
                        var sMsg = "";
                        try {
                                if (oError && oError.responseText) {
                                        var oBody = JSON.parse(oError.responseText);
                                        if (oBody && oBody.error && oBody.error.message) {
                                                sMsg = oBody.error.message.value || oBody.error.message;
                                        }
                                }
                                if (!sMsg && oError && oError.message) {
                                        sMsg = oError.message;
                                }
                                if (oError && oError.statusCode) {
                                        sMsg = "HTTP " + oError.statusCode + " - " + sMsg;
                                }
                        } catch (e) {
                                sMsg = (oError && oError.message) || String(oError);
                        }
                        Log.error("ChatService: " + sMsg);
                        return sMsg;
                },

                // =================================================================
                // 对外 API：getModels / getHistory / send / saveModelCfg
                // =================================================================

                /**
                 * 获取模型列表 → Promise<[{ModelId,ModelName,ModelDesc,ModelType,IsActive,ApiKeySet,...}]>
                 */
                getModels: function () {
                        if (this._sConfig.mode === "mock") {
                                return this._mockModels();
                        }
                        return this._read("/Models", {}).then(function (oData) {
                                return (oData && oData.results) || [];
                        });
                },

                /**
                 * 获取会话历史 → Promise<[{SessionId,MsgSeq,Role,Content,...}]>
                 */
                getHistory: function (sSessionId) {
                        if (this._sConfig.mode === "mock") {
                                return Promise.resolve(Service._mockStore().messages[sSessionId] || []);
                        }
                        return this._read("/Messages", {
                                filters: [new Filter("SessionId", FilterOperator.EQ, sSessionId)],
                                sorters: [new Sorter("MsgSeq", true)], // 降序取最新，取回后反转
                                urlParameters: { "$top": "200" }
                        }).then(function (oData) {
                                var aRows = (oData && oData.results) || [];
                                return Service._skillHistory(sSessionId, aRows.reverse());
                        });
                },

                /**
                  * 获取会话列表 → Promise<[{SessionId,Title,ModelId,MsgCount,CreatedAt,ChangedAt,Pinned,Mode,AgentType,Status}]>
                  * 后端模式: GET /Sessions（读 ZAI_CHAT_SESS，仅当前用户，置顶优先 + 最近修改）
                  * V12: Mode 统一规范化（空/缺省 → CHAT，老会话无需迁移即可打开）
                  * 20261011（BE-09）：分页与服务端搜索 ——
                  *   $top/$skip + $filter=Mode eq 'CHAT'|'AGENT' + search=<标题关键字>
                  *   （CHAT_SERVICE V2.4 / DPC_EXT V15.3 起生效）。旧后端忽略这些参数、
                  *   固定返回前 100 条混合列表，这里再按模式/关键字过滤一遍，行为不退化
                  * @param {object} [oOpt] {mode, top, skip, search}
                  */
                getSessions: function (oOpt) {
                        var o = oOpt || {};
                        var sMode = o.mode === "AGENT" || o.mode === "CHAT" ? o.mode : "";
                        var iTop = parseInt(o.top, 10) > 0 ? parseInt(o.top, 10) : 100;
                        var iSkip = parseInt(o.skip, 10) > 0 ? parseInt(o.skip, 10) : 0;
                        var sQ = String(o.search || "").trim();
                        var sQLow = sQ.toLowerCase();
                        var fnNorm = function (s) {
                                s = s || {};
                                s.Mode = s.Mode === "AGENT" ? "AGENT" : "CHAT";
                                s.AgentType = s.AgentType || "";
                                s.Status = s.Status || "IDLE";
                                return s;
                        };
                        var fnKeep = function (s) {
                                return (!sMode || s.Mode === sMode) &&
                                        (!sQLow || String(s.Title || "").toLowerCase().indexOf(sQLow) >= 0);
                        };
                        if (this._sConfig.mode === "mock") {
                                var a = Service._mockStore().sessions.slice().map(fnNorm).filter(fnKeep);
                                a.sort(function (x, y) {
                                        var pX = x.Pinned === "X" ? 1 : 0, pY = y.Pinned === "X" ? 1 : 0;
                                        return pX !== pY ? pY - pX : (y.ChangedAt || "").localeCompare(x.ChangedAt || "");
                                });
                                return Promise.resolve(a.slice(iSkip, iSkip + iTop));
                        }
                        var mUrl = { "$top": String(iTop) };
                        if (iSkip) {
                                mUrl.$skip = String(iSkip);
                        }
                        if (sQ) {
                                mUrl.search = sQ;
                        }
                        return this._read("/Sessions", {
                                filters: sMode ? [new Filter("Mode", FilterOperator.EQ, sMode)] : [],
                                urlParameters: mUrl
                        }).then(function (oData) {
                                return ((oData && oData.results) || []).map(fnNorm).filter(fnKeep);
                        });
                },

                /**
                 * 删除会话（后端连带删除全部消息）
                 */
                deleteSession: function (sSessionId) {
                        if (this._sConfig.mode === "mock") {
                                var oStore = Service._mockStore();
                                oStore.sessions = oStore.sessions.filter(function (s) { return s.SessionId !== sSessionId; });
                                delete oStore.messages[sSessionId];
                                Service._mockSave(oStore);
                                return Promise.resolve(true);
                        }
                        var that = this;
                        return new Promise(function (fnResolve, fnReject) {
                                that._getModel().remove("/Sessions('" + encodeURIComponent(sSessionId) + "')", {
                                        success: function () { fnResolve(true); },
                                        error: function (oError) {
                                                that._maybeAuthFail(oError);
                                                fnReject(new Error(Service._fmtError(oError)));
                                        }
                                });
                        });
                },

                /**
                 * 发送消息（对话或代码分析）
                 * @param {object} oPayload {sessionId, question, modelId, programName}
                 * @returns {Promise<{answer, status, elapsedMs, codeLines, message, modelId}>}
                 */
                send: function (oPayload) {
                        if (this._sConfig.mode === "mock") {
                                return this._mockSend(oPayload);
                        }
                        var that = this;
                        var oModel = this._getModel();
                        // 20261021：问题太长时先走长文本通道（见 _prepareQuestion），否则网关 414
                        return this._prepareQuestion(oPayload.question).then(function (sQuestion) {
                          return new Promise(function (fnResolve, fnReject) {
                                oModel.callFunction("/AnalyzeCode", {
                                        method: "POST",
                                        urlParameters: {
                                                SessionId: oPayload.sessionId,
                                                Question: sQuestion,
                                                ModelId: oPayload.modelId || "",
                                                ProgramName: oPayload.programName || ""
                                        },
                                        success: function (oData) {
                                                // V2 callFunction 返回结构做兼容解包：d.AnalyzeCode 或直接对象
                                                var res = oData && (oData.AnalyzeCode || oData) || {};
                                                fnResolve({
                                                        answer: res.Answer || "",
                                                        status: res.Status || "OK",
                                                        elapsedMs: parseInt(res.ElapsedMs || "0", 10) || 0,
                                                        codeLines: parseInt(res.CodeLines || "0", 10) || 0,
                                                        message: res.Message || "",
                                                        modelId: res.ModelId || oPayload.modelId || ""
                                                });
                                        },
                                        error: function (oError) {
                                                that._maybeAuthFail(oError);
                                                fnReject(new Error(that._fmtError(oError)));
                                        }
                                });
                          });
                        });
                },

                /**
                  * V11→V13：Agent 模式发送（通用 Agent 编排，后端 AnalyzeAgent）
                  * 任何问题都经过 理解→规划→工具判断→执行→整理 的编排流程；
                  * 工具按需调用（库存工具仅是可选工具之一），TraceJson 承载
                  * 阶段过程摘要（phase/label/status/elapsedMs）。
                  * V1.3：AnalysisJson 承载数据分析结构化结果（summary/findings/
                  * charts/datasets），解析失败或字段非法时降级为 null（表格/图表
                  * 不渲染，不影响文字回答）——前端校验仅用于展示防御，最终权限
                  * 与白名单一律以后端为准。
                  * @param {object} oPayload {sessionId, question, modelId}
                  * @returns {Promise<{answer, status, elapsedMs, rounds, message, modelId, trace, analysis}>}
                  */
                sendAgent: function (oPayload) {
                        if (oPayload.skillId && oPayload.skillId !== "NONE") {
                                return Promise.reject(new Error("技能请求必须使用 AnalyzeTask，不能降级到旧 Agent 接口"));
                        }
                        if (this._sConfig.mode === "mock") {
                                return this._mockSendAgent(oPayload);
                        }
                        var that = this;
                        var oModel = this._getModel();
                        return this._prepareQuestion(oPayload.question).then(function (sQuestion) {
                          return new Promise(function (fnResolve, fnReject) {
                                oModel.callFunction("/AnalyzeAgent", {
                                        method: "POST",
                                        urlParameters: {
                                                SessionId: oPayload.sessionId,
                                                Question: sQuestion,
                                                ModelId: oPayload.modelId || ""
                                        },
                                        success: function (oData) {
                                                // AGENT_TRACE_FINISH_V1：统一解包与统计转换，坏 Trace 不影响正文。
                                                var res = TraceService.normalizeResult(oData, oPayload.modelId);
                                                // V1.3：结构化数据分析结果（可选字段，旧后端无此字段）
                                                var oAnalysis = null;
                                                if (res.analysisJson) {
                                                        try {
                                                                oAnalysis = Service._sanitizeAnalysis(
                                                                        JSON.parse(res.analysisJson));
                                                        } catch (e) {
                                                                oAnalysis = null;   // 仅影响表格/图表渲染
                                                        }
                                                }
                                                res.analysis = oAnalysis;
                                                delete res.analysisJson;
                                                fnResolve(res);
                                        },
                                        error: function (oError) {
                                                that._maybeAuthFail(oError);
                                                fnReject(new Error(that._fmtError(oError)));
                                        }
                                });
                          });
                        });
                },

                /**
                  * V1.3：读取数据分析能力目录（GET /AgentCapabilities）。
                  * 前端仅用于即时提示/展示；未注册实体等最终由后端拒绝。
                  * 结果按连接缓存（Promise 记忆化），失败返回空数组不抛错
                  * （如网关尚未激活 SEGW 变更时不阻断前端使用）。
                  * @returns {Promise<[{}]>} [{Entity,Label,Dimensions,Metrics,Operations,MaxRows,TimeoutSec,Permission,SensitiveFields}]
                  */
                getAgentCapabilities: function () {
                        if (this._sConfig.mode === "mock") {
                                return Promise.resolve([Service._mockCapability()]);
                        }
                        if (this._pCaps) {
                                return this._pCaps;
                        }
                        this._pCaps = this._read("/AgentCapabilities", {}).then(function (oData) {
                                return (oData && oData.results) || [];
                        }).catch(function () {
                                Service._pCaps = null;
                                return [];
                        });
                        return this._pCaps;
                },

                // =================================================================
                // V15：多业务任务与报表（AnalyzeTask 并行接入 + 能力探测回退）
                // 后端是事实源：权限/白名单/报表存在性/运行结果一律以后端返回为准；
                // SEGW 未配置新函数导入时（metadata 层 404），自动回退旧 AnalyzeAgent
                // =================================================================

                /** AnalyzeTask 可用性缓存（null=未探测；false=后端无新接口，走旧链路） */
                _taskApiAvailable: null,

                /**
                  * 任务化 Agent 发送。优先 /AnalyzeTask（携带 TaskId/ClientRequestId）；
                  * 后端无该函数导入时永久回退 /AnalyzeAgent（旧链路），前端无感。
                  * @param {object} oPayload {sessionId, question, modelId, taskId, clientRequestId, focusedArtifactId}
                  * @returns {Promise} sendAgent 的返回 + 可选任务字段
                  *                   {taskId, taskModule, taskStatus, needsInput, pendingParamsJson, artifactRefsJson}
                  */
                sendTask: function (oPayload) {
                        if (this._sConfig.mode === "mock") {
                                return this._mockSendSkillTask(oPayload);
                        }
                        if (this._taskApiAvailable === false) {
                                if (oPayload.skillId && oPayload.skillId !== "NONE") {
                                        return Promise.reject(new Error("后端尚未部署技能接口，请取消技能后重试"));
                                }
                                return this.sendAgent(oPayload);
                        }
                        var that = this;
                        var oModel = this._getModel();
                        var mParams = {
                                SessionId: oPayload.sessionId,
                                Question: oPayload.question,
                                ModelId: oPayload.modelId || "",
                                TaskId: oPayload.taskId || "",
                                ClientRequestId: oPayload.clientRequestId || "",
                                FocusedArtifactId: oPayload.focusedArtifactId || ""
                        };
                        // 20261011：会话场景（SEGW 给 AnalyzeTask 加了 Scene 参数后才发送；
                        // 未加时不发，后端按"自动"处理，不会因多余参数报错）
                        if (oPayload.scene && this._fiHasParam("AnalyzeTask", "Scene")) {
                                mParams.Scene = oPayload.scene;
                        }
                        if (this._fiHasParam("AnalyzeTask", "SkillId")) {
                                mParams.SkillId = oPayload.skillId || "";
                        } else if (oPayload.skillId && oPayload.skillId !== "NONE") {
                                return Promise.reject(new Error("后端不支持技能，请取消技能后重试"));
                        }
                        return this._prepareQuestion(oPayload.question).then(function (sQuestion) {
                          mParams.Question = sQuestion;
                          return new Promise(function (fnResolve, fnReject) {
                                oModel.callFunction("/AnalyzeTask", {
                                        method: "POST",
                                        urlParameters: mParams,
                                        success: function (oData) {
                                                that._taskApiAvailable = true;
                                                var res = TraceService.normalizeResult(oData, oPayload.modelId);
                                                // V1.3 结构化分析（与 sendAgent 一致）
                                                if (res.analysisJson) {
                                                        try {
                                                                res.analysis = Service._sanitizeAnalysis(
                                                                        JSON.parse(res.analysisJson));
                                                        } catch (e) {
                                                                res.analysis = null;  // 仅影响表格/图表渲染
                                                        }
                                                }
                                                delete res.analysisJson;
                                                // V15 任务字段（SEGW 未加属性时后端投影忽略 → 为空，不影响渲染）
                                                var oRoot = (oData && (oData.d || oData)) || {};
                                                var o = (oRoot.AnalyzeTask && typeof oRoot.AnalyzeTask === "object")
                                                        ? oRoot.AnalyzeTask : oRoot;
                                                res.taskId = TraceService._field(o, "TaskId") || "";
                                                res.taskModule = TraceService._field(o, "TaskModule") || "";
                                                res.taskStatus = TraceService._field(o, "TaskStatus") || "";
                                                res.needsInput = String(TraceService._field(o, "NeedsInput") || "") === "X";
                                                res.pendingParamsJson = TraceService._field(o, "PendingParamsJson") || "";
                                                res.artifactRefsJson = TraceService._field(o, "ArtifactRefsJson") || "";
                                                fnResolve(res);
                                        },
                                        error: function (oError) {
                                                // 能力探测：新函数导入未配置（404/未知函数导入）→ 永久回退旧链路
                                                var sMsg = that._fmtError(oError);
                                                var bNotFound = (oError && oError.statusCode === 404) ||
                                                        /未知.*函数导入|not found|HTTP 404/i.test(sMsg);
                                                if (bNotFound && that._taskApiAvailable !== true &&
                                                        (!oPayload.skillId || oPayload.skillId === "NONE")) {
                                                        that._taskApiAvailable = false;
                                                        // 已暂存过的长文本直接用引用，不再存一次
                                                        that.sendAgent(Object.assign({}, oPayload, { question: sQuestion })).then(fnResolve, fnReject);
                                                        return;
                                                }
                                                that._maybeAuthFail(oError);
                                                fnReject(new Error(sMsg));
                                        }
                                });
                          });
                        });
                },

                /**
                  * V15：结构化任务/报表接口统一调用（GenericResult 契约：
                  * {Success, Message, ResultJson}）。返回
                  * {success, message, result}（result = ResultJson 解析对象，空为 null）。
                  * 后端未配置新函数导入时 result 为 null 且 success=false（不抛错，
                  * 由调用方按能力降级）。
                  */
                _taskCall: function (sAction, oParams, bPost) {
                        if (this._sConfig.mode === "mock") {
                                return Promise.resolve({ success: false, message: "演示模式无任务后端", result: null });
                        }
                        return this._fiCall(sAction, oParams, bPost).then(function (d) {
                                var sJson = d.ResultJson || "";
                                var oResult = null;
                                if (sJson) {
                                        try {
                                                oResult = JSON.parse(sJson);
                                        } catch (e) {
                                                oResult = null;
                                        }
                                }
                                return {
                                        success: d.Success === "X",
                                        message: d.Message || "",
                                        result: oResult
                                };
                        }).catch(function (e) {
                                return { success: false, message: Service._fmtError(e), result: null };
                        });
                },

                /**
                  * 20261019（改进清单 FE-01 / FE-08）：Function Import 统一通道，_taskCall 与 _v8Call 共用。
                  *  · 参数一律放 URL 查询串（GET / POST 相同）：GW 的 OData V2 FI 只解析 URL 参数，
                  *    form 正文不解析（V15.0.1 20261008 实锤）；V8 写操作原来走 form 正文，改到这里
                  *  · URL 在调用开始时拼好一次，换牌重试复用同一个 URL（FE-01：原 fnBuild 每次都往
                  *    闭包变量上追加查询串，重试时变成 "?a=1?a=1"）
                  *  · POST 带 CSRF 令牌；403 时刷新令牌重试一次。GET 不需要令牌，403 直接报错
                  *  · HTTP 非 2xx 抛 Error("HTTP <码> - <响应体前 300 字>")，附 statusCode / responseText
                  * @returns {Promise<object>} 已剥掉函数名包装的返回对象 d（{Success, Message, Json | ResultJson, …}）
                  */
                _fiCall: function (sAction, oParams, bPost) {
                        var that = this;
                        var sBasic = this._basicHeader();
                        var sUrl = this._sConfig.host + this._sConfig.path + sAction + Service._fiQuery(oParams);
                        var fnSend = function (sToken) {
                                // V8.2：GW 默认返回 Atom XML，必须声明 JSON 才能被 oResp.json() 解析
                                var oHeaders = { "Accept": "application/json" };
                                if (sBasic) {
                                        oHeaders.Authorization = sBasic;
                                }
                                if (bPost && sToken) {
                                        oHeaders["x-csrf-token"] = sToken;
                                }
                                return fetch(sUrl, {
                                        method: bPost ? "POST" : "GET",
                                        headers: oHeaders,
                                        credentials: "same-origin"
                                }).then(function (oResp) {
                                        if (!oResp.ok) {
                                                // V15.0.1: 带回响应体, GW 错误原因(XML)可解析展示
                                                return oResp.text().then(function (t) {
                                                        var e = new Error("HTTP " + oResp.status + (t ? " - " + t.substring(0, 300) : ""));
                                                        e.statusCode = oResp.status;
                                                        e.responseText = t;
                                                        throw e;
                                                });
                                        }
                                        return oResp.json();
                                }).then(function (oJson) {
                                        // V8.3：GW 把 FI 返回包在函数导入名下（d.AnalyzeCode 等），先剥壳
                                        var oRoot = (oJson && oJson.d) || oJson || {};
                                        return (oRoot && typeof oRoot[sAction] === "object" && oRoot[sAction] !== null)
                                                ? oRoot[sAction] : oRoot;
                                });
                        };
                        if (!bPost) {
                                return fnSend("");
                        }
                        var fnTry = function (sToken) {
                                return fnSend(sToken).catch(function (e) {
                                        // 20261011: 错误消息自 V15.0.1 起带响应体（"HTTP 403 - …"），用 _isCsrfFail 识别
                                        if (Service._isCsrfFail(e)) {
                                                return that._fetchCsrf(sBasic).then(function (sNew) {
                                                        that._sCsrfToken = sNew;
                                                        return fnSend(sNew);
                                                });
                                        }
                                        throw e;
                                });
                        };
                        if (this._sCsrfToken) {
                                return fnTry(this._sCsrfToken);
                        }
                        return this._fetchCsrf(sBasic).then(function (sNew) {
                                that._sCsrfToken = sNew;
                                return fnTry(sNew);
                        });
                },

                /**
                  * 20261019：FI 参数 → URL 查询串。参数是 OData 字符串字面量，值里的单引号写成两个
                  * （O'Brien → 'O''Brien'，与 UI5 ODataModel.callFunction 的 formatValue 同口径），再 URL 编码
                  * @returns {string} "?K1='v1'&K2='v2'"；无参数返回 ""
                  */
                _fiQuery: function (oParams) {
                        var aQ = Object.keys(oParams || {}).map(function (k) {
                                var sVal = oParams[k] === undefined || oParams[k] === null ? "" : String(oParams[k]);
                                return k + "='" + encodeURIComponent(sVal.replace(/'/g, "''")) + "'";
                        });
                        return aQ.length ? "?" + aQ.join("&") : "";
                },

                /**
                  * 20261020：事务码权限自助申请的 9 个 FI（设计：功能计划书/权限自助申请/01-方案与开发计划_V1.4）。
                  * 都走 _taskCall（GenericResult 契约、POST 参数放 URL、带 CSRF）；成功时返回已解析的 ResultJson
                  * （字段是 camelCase：reqId / targetUser / statusText 由界面层再加），失败抛 Error(后端原话)。
                  * 演示模式走 AuthMockBackend（语义与后端一一对应）。
                  */
                _authCall: function (sAction, oParams, bPost) {
                        if (this._sConfig.mode === "mock") {
                                return this._mockAuthCall(sAction, oParams || {});
                        }
                        // 20261021：后端 SEGW 的 FI 参数未设 Nullable（全部必填），URL 里只要缺一个参数，
                        // 网关就 404 "Invalid Function Import Parameter '<参数名>'"（$metadata 看不出必填性）。
                        // 对策：权限系 FI 恒定全参数发送——调用方没给的键补空串（后端空串语义 = 不过滤/默认值，
                        // AUTH_SERVICE.list_requests 实测兼容）。参数清单必须与模型声明严格一致；
                        // 清单之外的调用方键一律丢弃，顺带防拼错键名。
                        var mAuthParams = {
                                AuthSubmit:        ["Tcode", "WerksList", "Reason"],
                                AuthBatchAdd:      ["Users", "Tcode", "WerksList", "Reason"],
                                AuthDecide:        ["ReqId", "Approve", "Message"],
                                AuthRevoke:        ["ReqId", "Message"],
                                AuthTableSave:     ["Tabname", "Descr", "Discover", "Active", "FmapJson"],
                                AuthRuleSave:      ["TcodePat", "Tabname", "RuleMode", "AllowAll", "Active", "Delete", "FmapJson"],   // FmapJson：20261023 规则字段映射（SEGW 需同步加参数）
                                AuthList:          ["Status", "User", "Tcode", "Top", "Skip"],
                                AuthTableDescribe: ["Tabname"]
                        };
                        var aKeys = mAuthParams[sAction] || [];
                        var oFull = {};
                        for (var i = 0; i < aKeys.length; i++) {
                                var v = oParams ? oParams[aKeys[i]] : undefined;
                                oFull[aKeys[i]] = (v === undefined || v === null) ? "" : v;
                        }
                        return this._taskCall(sAction, oFull, bPost).then(function (oRes) {
                                if (!oRes.success) {
                                        throw new Error(oRes.message || "权限服务调用失败");
                                }
                                return oRes.result || {};
                        });
                },
                authSubmit: function (o) { return this._authCall("AuthSubmit", o, true); },
                authBatchAdd: function (o) { return this._authCall("AuthBatchAdd", o, true); },
                authDecide: function (o) { return this._authCall("AuthDecide", o, true); },
                authRevoke: function (o) { return this._authCall("AuthRevoke", o, true); },
                authTableSave: function (o) { return this._authCall("AuthTableSave", o, true); },
                authRuleSave: function (o) { return this._authCall("AuthRuleSave", o, true); },
                authList: function (o) { return this._authCall("AuthList", o, false); },
                authTableDescribe: function (o) { return this._authCall("AuthTableDescribe", o, false); },
                authConfig: function () { return this._authCall("AuthConfig", {}, false); },

                /** 会话任务列表 → Promise<[TaskItem]>（能力未开/失败 → []） */
                getTasks: function (sSessionId) {
                        if (this._sConfig.mode === "mock") {
                                return Promise.resolve([]);
                        }
                        return this._taskCall("Tasks", { SessionId: sSessionId }, false)
                                .then(function (o) { return (o.success && o.result) || []; });
                },

                /** 任务上下文（摘要/待办/结果索引）→ Promise<object|null> */
                getTaskContext: function (sSessionId, sTaskId) {
                        return this._taskCall("TaskContext", { SessionId: sSessionId, TaskId: sTaskId }, false)
                                .then(function (o) { return o.result; });
                },

                /** 登记报表与参数 Schema → Promise<[Definition]>（能力未开 → []） */
                getReportDefinitions: function () {
                        if (this._sConfig.mode === "mock") {
                                return this._mockReportDefs().then(function (o) { return o.defs; });
                        }
                        return this._taskCall("ReportDefinitions", {}, false)
                                .then(function (o) { return (o.success && o.result) || []; });
                },

                /**
                  * 20261020：「报表执行」场景的报表目录 → Promise<{defs, message}>。
                  * 与 getReportDefinitions 同一个接口，但带回后端说明（如"报表读取能力未开启"），接口失败时抛错
                  * （目录显示原因 + 重试）。注意 ReportDefinitions 的 ResultJson 没设 pretty_name，键是大写
                  * （REPORT_ID / TCODE / NAME / EXEC_ENABLED / PARAMS），目录按大小写都认。
                  */
                getReportCatalog: function () {
                        if (this._sConfig.mode === "mock") {
                                return this._mockReportDefs();
                        }
                        return this._taskCall("ReportDefinitions", {}, false).then(function (o) {
                                if (!o.success) {
                                        throw new Error(o.message || "报表目录加载失败");
                                }
                                return { defs: Array.isArray(o.result) ? o.result : [], message: o.message || "" };
                        });
                },

                /**
                  * 20261020：Fiori 报表（设计：功能计划书/Fiori报表分析/01-方案与开发计划）。三个 FI 都走 _taskCall
                  * （GenericResult 契约、POST 参数放 URL、带 CSRF），ResultJson 是 camelCase；失败抛后端原话。
                  * 演示模式走 FioriMockBackend（语义与 ZCL_AI_FIORI_REPORT_SERVICE 对应）。
                  */
                _fioriCall: function (sAction, oParams, bPost) {
                        if (this._sConfig.mode === "mock") {
                                return this._mockFioriCall(sAction, oParams || {});
                        }
                        return this._taskCall(sAction, oParams || {}, bPost).then(function (o) {
                                if (!o.success) {
                                        throw new Error(o.message || "Fiori 报表服务调用失败");
                                }
                                var r = o.result || {};
                                if (!r.message && o.message) {
                                        r.message = o.message;
                                }
                                return r;
                        });
                },

                /** Fiori 报表目录 → Promise<{defs, message}>（FIORI_ENABLED 未开：defs 为空 + 说明） */
                getFioriReportDefs: function () {
                        return this._fioriCall("FioriReportDefs", {}, false).then(function (r) {
                                return { defs: r.reports || [], message: r.message || "" };
                        });
                },

                /**
                  * 同步取数（幂等：同一 ClientRequestId 返回同一结果）
                  * @param {object} o {sessionId, taskId, reportId, paramsJson, clientRequestId}
                  * @returns {Promise<{artifactId, runId, reportId, label, schemaJson, rowsJson, rowCount, truncated,
                  *          elapsedMs, analyzeEnabled, analyzed, message}>}
                  */
                runFioriReport: function (o) {
                        return this._fioriCall("RunFioriReport", {
                                SessionId: o.sessionId,
                                TaskId: o.taskId || "",
                                ReportId: o.reportId,
                                ParamsJson: o.paramsJson || "{}",
                                ClientRequestId: o.clientRequestId
                        }, true);
                },

                /** 重新读取历史结果（结构同 runFioriReport） */
                getFioriReportResult: function (sArtifactId) {
                        return this._fioriCall("FioriReportResult", { ArtifactId: sArtifactId }, false);
                },

                /**
                  * 幂等启动报表运行（后端 REPORT_EXEC_ENABLED 默认关闭）。
                  * @param {object} o {sessionId, taskId, reportId, paramsJson, clientRequestId}
                  * @returns {Promise<{created, rejected, needsInput, status, reportRunId, shortId, message}>}
                  */
                startReportRun: function (o) {
                        return this._taskCall("StartReportRun", {
                                SessionId: o.sessionId,
                                TaskId: o.taskId,
                                ReportId: o.reportId,
                                ParamsJson: o.paramsJson || "{}",
                                ClientRequestId: o.clientRequestId
                        }, true).then(function (r) {
                                return (r && r.result) || {
                                        rejected: true, needsInput: false,
                                        message: (r && r.message) || "启动失败"
                                };
                        });
                },

                /**
                  * 运行状态轮询 → Promise<{status, artifactId, artifactShort, rowCount, message}>
                  * V16：ResultJson 为空时仍返回 {message}（GenericResult.Message 即后端真实原因），
                  * 由界面展示，不再笼统显示"运行状态查询失败"
                  */
                getReportRunStatus: function (sReportRunId) {
                        return this._taskCall("ReportRunStatus", { ReportRunId: sReportRunId }, false)
                                .then(function (o) {
                                        var r = o.result || {};
                                        if (!r.message && o.message) {
                                                r.message = o.message;
                                        }
                                        return r;
                                });
                },

                /** 结果读取 → Promise<{schemaJson, rowsJson, rowCount, summaryJson, label, message}>（V16：同上透传 message） */
                getReportResult: function (sArtifactId) {
                        return this._taskCall("ReportResult", { ArtifactId: sArtifactId }, false)
                                .then(function (o) {
                                        var r = o.result || {};
                                        if (!r.message && o.message) {
                                                r.message = o.message;
                                        }
                                        return r;
                                });
                },

                /**
                  * 任务动作（白名单 VIEW/PAUSE/RESUME/REANALYZE；重跑走 startReportRun）
                  * @returns {Promise<{success, message, result}>}
                  */
                taskAction: function (sSessionId, sTaskId, sAction) {
                        return this._taskCall("TaskAction", {
                                SessionId: sSessionId, TaskId: sTaskId, Action: sAction
                        }, true);
                },

                /**
                  * V1.3：结构化分析结果白名单复核（防御性，计划 §10）：
                  * - datasets ≤4；columns/rows 归一化
                  * - charts 仅 bar/line/pie，dataset 必须存在且成功返回、
                  *   x/y 必须是该数据集的列（与后端 GUARD 校验口径一致）
                  * - summary/findings 字符串仅透传（渲染前统一 escapeHtml）
                  * @param {object} oRaw 后端 AnalysisJson 解析对象
                  * @returns {object|null} 规整后的分析对象；无有效数据时 null
                  */
                _sanitizeAnalysis: function (oRaw) {
                        if (!oRaw || typeof oRaw !== "object") {
                                return null;
                        }
                        var aDs = [];
                        var aDsIn = Array.isArray(oRaw.datasets) ? oRaw.datasets : [];
                        aDsIn.slice(0, 4).forEach(function (d) {
                                if (!d || typeof d !== "object") {
                                        return;
                                }
                                var oDs = {
                                        name: String(d.name || "未命名查询").substring(0, 60),
                                        status: d.status === "OK" ? "OK" : String(d.status || "ERROR"),
                                        error: d.error ? String(d.error).substring(0, 200) : "",
                                        columns: [],
                                        rows: [],
                                        totalRows: parseInt(d.total_rows, 10) || 0,
                                        truncated: d.truncated === true,
                                        elapsedMs: parseInt(d.elapsed_ms, 10) || 0,
                                        source: String(d.source || "")
                                };
                                (Array.isArray(d.columns) ? d.columns : []).slice(0, 12).forEach(function (c) {
                                        if (c && c.name) {
                                                oDs.columns.push({
                                                        name: String(c.name),
                                                        label: String(c.label || c.name),
                                                        numeric: c.numeric === true
                                                });
                                        }
                                });
                                (Array.isArray(d.rows) ? d.rows : []).slice(0, 2000).forEach(function (r) {
                                        if (Array.isArray(r)) {
                                                oDs.rows.push(r.map(function (v) {
                                                        return v === null || v === undefined ? "" : v;
                                                }));
                                        }
                                });
                                aDs.push(oDs);
                        });

                        var oOut = {
                                summary: typeof oRaw.summary === "string" ? oRaw.summary : "",
                                findings: [],
                                charts: [],
                                datasets: aDs
                        };
                        (Array.isArray(oRaw.findings) ? oRaw.findings : []).slice(0, 4).forEach(function (f) {
                                if (f && typeof f === "object" && f.title) {
                                        oOut.findings.push({
                                                title: String(f.title),
                                                detail: typeof f.detail === "string" ? f.detail : "",
                                                severity: ["info", "warn", "error"].indexOf(f.severity) >= 0
                                                        ? f.severity : "info"
                                        });
                                }
                        });
                        // 图表引用复核：数据集存在 + 成功 + 有数据 + x/y 是列名
                        (Array.isArray(oRaw.charts) ? oRaw.charts : []).slice(0, 4).forEach(function (c) {
                                if (!c || typeof c !== "object") {
                                        return;
                                }
                                if (["bar", "line", "pie"].indexOf(c.type) < 0) {
                                        return;
                                }
                                var oHit = null;
                                aDs.forEach(function (d) {
                                        if (d.name === c.dataset) {
                                                oHit = d;
                                        }
                                });
                                if (!oHit || oHit.status !== "OK" || !oHit.rows.length) {
                                        return;
                                }
                                var bX = false, bY = false;
                                oHit.columns.forEach(function (col) {
                                        if (col.name === c.x) { bX = true; }
                                        if (col.name === c.y) { bY = true; }
                                });
                                if (bX && bY) {
                                        oOut.charts.push({
                                                type: c.type,
                                                title: String(c.title || ""),
                                                dataset: c.dataset,
                                                x: c.x,
                                                y: c.y
                                        });
                                }
                        });

                        if (!oOut.datasets.length && !oOut.charts.length && !oOut.findings.length
                                && !oOut.summary) {
                                return null;
                        }
                        return oOut;
                },

                /**
                  * V12：按会话模式统一发送入口 —— 控制器只认这个方法，
                  * 后续新增 Agent 类型时仅在此扩展路由，调用方不改
                  * V15：AGENT 模式改走 sendTask（AnalyzeTask 优先 + 能力回退），
                  * 携带当前 TaskId 与本轮 ClientRequestId
                  * @param {object} oPayload {mode:"CHAT"|"AGENT", sessionId, question, modelId, taskId, clientRequestId}
                  * @returns {Promise} send/sendTask 的原生返回结构
                  */
                sendByMode: function (oPayload) {
                        var o = oPayload || {};
                        if (o.mode === "AGENT") {
                                return this.sendTask({
                                        sessionId: o.sessionId,
                                        question: o.question,
                                        modelId: o.modelId,
                                        taskId: o.taskId || "",
                                        clientRequestId: o.clientRequestId || "",
                                        // 20261011：会话中正在看的报表结果（"分析一下这个结果"），后端校验归属
                                        focusedArtifactId: o.focusedArtifactId || "",
                                        // 20261011：会话场景（仅新会话首条消息生效，后端以库内为准）
                                        scene: o.scene || "",
                                        skillId: o.skillId || ""
                                });
                        }
                        return this.send({
                                sessionId: o.sessionId,
                                question: o.question,
                                modelId: o.modelId,
                                programName: ""    // V4 起 prompt 保持纯用户输入
                        });
                },

                /**
                  * 保存模型配置（upsert 到 ZAI_MODEL_CFG）
                 * @param {object} oCfg 字段与实体 Model 一致（ApiKey 仅在用户输入新值时传递）
                 */
                saveModelCfg: function (oCfg) {
                        if (this._sConfig.mode === "mock") {
                                return Promise.reject("演示模式下不可维护模型配置");
                        }
                        var oModel = this._getModel();
                        return new Promise(function (fnResolve, fnReject) {
                                oModel.callFunction("/SaveModelCfg", {
                                        method: "POST",
                                        urlParameters: {
                                                ModelId: oCfg.ModelId || "",
                                                ModelName: oCfg.ModelName || "",
                                                ModelDesc: oCfg.ModelDesc || "",
                                                ModelType: oCfg.ModelType || "",
                                                EndpointUrl: oCfg.EndpointUrl || "",
                                                Destination: oCfg.Destination || "",
                                                ApiModel: oCfg.ApiModel || "",
                                                ApiKey: oCfg.ApiKey || "",
                                                AuthType: oCfg.AuthType || "NONE",
                                                Temperature: oCfg.Temperature || "",
                                                MaxTokens: oCfg.MaxTokens || "",
                                                TimeoutSec: oCfg.TimeoutSec || "",
                                                IsActive: oCfg.IsActive || "X",
                                                // V10：模型级开关（X = 该模型不做源码解析）
                                                SkipSource: oCfg.SkipSource || "",
                                                // V10：模型级代码权限（X = USER 角色用此模型不下发源码）
                                                UserHideSrc: oCfg.UserHideSrc || ""
                                        },
                                        success: function (oData) {
                                                var res = oData && (oData.SaveModelCfg || oData) || {};
                                                if (res.Success === "X") {
                                                        fnResolve(res.Message || "保存成功");
                                                } else {
                                                        fnReject(new Error(res.Message || "保存失败"));
                                                }
                                        },
                                        error: function (oError) {
                                                Service._maybeAuthFail(oError);
                                                fnReject(new Error(Service._fmtError(oError)));
                                        }
                                });
                        });
                },

                /**
                 * V1.3：测试模型连通性（后端发最小请求，返回耗时/错误原因）
                 * @param {string} sModelId 已保存的模型 ID
                 * @returns {Promise<{success, message, elapsedMs}>}
                 */
                testModel: function (sModelId) {
                        if (this._sConfig.mode === "mock") {
                                return Promise.reject(new Error("演示模式不可测试，请在设置中切换到后端模式"));
                        }
                        return new Promise(function (fnResolve, fnReject) {
                                Service._getModel().callFunction("/TestModel", {
                                        method: "POST",
                                        urlParameters: { ModelId: sModelId || "" },
                                        success: function (oData) {
                                                var res = oData && (oData.TestModel || oData) || {};
                                                fnResolve({
                                                        success: res.Success === "X",
                                                        message: res.Message || "",
                                                        elapsedMs: parseInt(res.ElapsedMs || "0", 10) || 0
                                                });
                                        },
                                        error: function (oError) {
                                                Service._maybeAuthFail(oError);
                                                fnReject(new Error(Service._fmtError(oError)));
                                        }
                                });
                        });
                },

                // =================================================================
                // V10：全局开关配置（CODE_ACL / LONG_SRC_CHUNK，存 ZAI_CHAT_CFG）
                // =================================================================
                /**
                 * 读全局配置值 → Promise<string>（不存在返回 ""）
                 * @param {string} sKey 配置键，如 CODE_ACL / LONG_SRC_CHUNK
                 */
                getConfigValue: function (sKey) {
                        if (this._sConfig.mode === "mock") {
                                try {
                                        return Promise.resolve(window.localStorage.getItem("zaiChat.cfg." + sKey) || "");
                                } catch (e) {
                                        return Promise.resolve("");
                                }
                        }
                        return this._v8Call("GetConfig", { ConfigKey: sKey }).then(function (sVal) {
                                return sVal || "";
                        });
                },

                /**
                 * 写全局配置值（后端仅 ADMIN）
                 * @param {string} sKey 配置键
                 * @param {string} sVal 配置值（"X"/""）
                 * @returns {Promise}
                 */
                saveConfigValue: function (sKey, sVal) {
                        if (this._sConfig.mode === "mock") {
                                try {
                                        if (sVal) {
                                                window.localStorage.setItem("zaiChat.cfg." + sKey, sVal);
                                        } else {
                                                window.localStorage.removeItem("zaiChat.cfg." + sKey);
                                        }
                                } catch (e) { /* 忽略 */ }
                                return Promise.resolve(true);
                        }
                        return this._v8Call("SaveConfig", { ConfigKey: sKey, ConfigValue: sVal || "" }, true).then(function (sMsg) {
                                return sMsg || "保存成功";
                        });
                },

                /**
                  * 20261011：Agent 可用模型白名单（ZAI_CHAT_CFG；后端同口径强制校验）
                  * 键：ALL=AGENT_MODELS（全部场景）/ REPORT / FIORI / DATA / INVENTORY / CODE（场景专属，优先；
                  * 20261020 加 FIORI = AGENT_MODELS_FIORI）
                  * @returns {Promise<object>} {ALL:[ids], REPORT:[ids], ...}；空数组 = 不限制
                  */
                AGENT_MODEL_KEYS: {
                        ALL: "AGENT_MODELS", REPORT: "AGENT_MODELS_RPT", FIORI: "AGENT_MODELS_FIORI", DATA: "AGENT_MODELS_DATA",
                        INVENTORY: "AGENT_MODELS_INV", CODE: "AGENT_MODELS_CODE"
                },

                getAgentModelRules: function () {
                        var that = this;
                        var aScenes = Object.keys(this.AGENT_MODEL_KEYS);
                        return Promise.all(aScenes.map(function (k) {
                                return that.getConfigValue(that.AGENT_MODEL_KEYS[k]).catch(function () { return ""; });
                        })).then(function (aVals) {
                                var mOut = {};
                                aScenes.forEach(function (k, i) {
                                        mOut[k] = String(aVals[i] || "").toUpperCase().split(/[\s,|;，、]+/).filter(Boolean);
                                });
                                return mOut;
                        });
                },

                /** 保存白名单（管理员；空数组 = 清空该键 = 不限制） */
                saveAgentModelRules: function (mRules) {
                        var that = this;
                        return Promise.all(Object.keys(this.AGENT_MODEL_KEYS).map(function (k) {
                                return that.saveConfigValue(that.AGENT_MODEL_KEYS[k], ((mRules || {})[k] || []).join(","));
                        }));
                },

                /**
                 * V10：更新会话（重命名 / 置顶切换，后端仅限本人会话）
                 * 20261011：Pinned 三态 —— "X" 置顶 / "N" 取消置顶 / 空 = 不改（重命名时
                 * 不再把置顶清掉；CHAT_SERVICE V2.4 起生效，旧后端把 "N" 当取消置顶，兼容）
                 * @param {object} oUpd {sessionId, title, pinned} title 可选；pinned: true/false 或省略
                 * @returns {Promise<string>} 后端 Message
                 */
                updateSession: function (oUpd) {
                        var sPinned = oUpd.pinned === undefined ? "" : (oUpd.pinned ? "X" : "N");
                        if (this._sConfig.mode === "mock") {
                                var oStore = Service._mockStore();
                                var oSess = oStore.sessions.filter(function (s) {
                                        return s.SessionId === oUpd.sessionId;
                                })[0];
                                if (!oSess) {
                                        return Promise.reject(new Error("会话不存在"));
                                }
                                if (oUpd.title) {
                                        oSess.Title = oUpd.title;
                                }
                                if (sPinned) {
                                        oSess.Pinned = sPinned === "X" ? "X" : "";
                                }
                                Service._mockSave(oStore);
                                return Promise.resolve("已更新");
                        }
                        return this._v8Call("UpdateSession", {
                                SessionId: oUpd.sessionId || "",
                                Title: oUpd.title || "",
                                Pinned: sPinned
                        }, true).then(function (sMsg) {
                                return sMsg || "已更新";
                        });
                },

                // ================================================================
                // V8：应用层强制登录 / 权限 / 角色·泡泡·用户·后端配置数据
                // 设计要点（详见 docs/V8-权限与登录设计说明.md）：
                //   · 登录账号 = SAP 用户（管理员从 SU01 赋权开通），密码即网关
                //     Basic 凭据 —— 登录成功后同一账密直连 OData，不再弹 SAP 登录框
                //   · 初始管理员 admin/123456 仅在"后端未完成配置"的初始化窗口可用，
                //     后端地址联调通过（INIT 置位）后该账号永久失效
                //   · 角色/泡泡提示词后端化存储，多会话/多端共享；mock 落 localStorage
                // ================================================================

                /** 当前应用登录用户 { userId, userName, role: "ADMIN"|"USER", mustChangePwd }；未登录 null */
                getAppUser: function () {
                        if (this._sAppUser) {
                                return jQuery.extend(true, {}, this._sAppUser);
                        }
                        try {
                                var sRaw = window.localStorage.getItem("zaiChat-appUser");
                                if (sRaw) {
                                        this._sAppUser = JSON.parse(sRaw);
                                        return jQuery.extend(true, {}, this._sAppUser);
                                }
                        } catch (e) { /* 忽略 */ }
                        return null;
                },

                /** 写入/清除应用登录用户（内存 + localStorage） */
                _setAppUser: function (oUser) {
                        this._sAppUser = oUser ? jQuery.extend(true, {}, oUser) : null;
                        try {
                                if (oUser) {
                                        window.localStorage.setItem("zaiChat-appUser", JSON.stringify(oUser));
                                } else {
                                        window.localStorage.removeItem("zaiChat-appUser");
                                }
                        } catch (e) { /* 忽略 */ }
                },

                isAdmin: function () {
                        var oUser = this.getAppUser();
                        return !!oUser && oUser.role === "ADMIN";
                },

                /** SHA-256 摘要（本地初始管理员改密用，十六进制小写） */
                _sha256: function (sText) {
                        var enc = new TextEncoder();
                        return crypto.subtle.digest("SHA-256", enc.encode(sText)).then(function (buf) {
                                return Array.prototype.map.call(new Uint8Array(buf), function (b) {
                                        return ("0" + b.toString(16)).slice(-2);
                                }).join("");
                        });
                },

                /** V8.1：CSRF token 获取（同凭据 GET $metadata，x-csrf-token: fetch） */
                _fetchCsrf: function (sBasic) {
                        var sUrl = this._sConfig.host + this._sConfig.path + "$metadata";
                        var oHeaders = {};
                        if (sBasic) {
                                oHeaders.Authorization = sBasic;
                        }
                        oHeaders["x-csrf-token"] = "fetch";
                        return fetch(sUrl, {
                                method: "GET",
                                headers: oHeaders,
                                credentials: "same-origin"
                        }).then(function (oResp) {
                                if (!oResp.ok) {
                                        throw new Error(oResp.status === 401 ? "bad" : "HTTP " + oResp.status);
                                }
                                return oResp.headers.get("x-csrf-token") || "";
                        });
                },

                /** 20261011：服务 metadata 里某函数导入是否声明了某参数（SEGW 未改时不发新参数） */
                _fiHasParam: function (sFi, sParam) {
                        var oMeta = null;
                        try { oMeta = this._getModel().getServiceMetadata(); } catch (e) { oMeta = null; }
                        var bHit = false;
                        ((oMeta && oMeta.dataServices && oMeta.dataServices.schema) || []).forEach(function (oSchema) {
                                (oSchema.entityContainer || []).forEach(function (oEc) {
                                        (oEc.functionImport || []).forEach(function (oFi) {
                                                if (oFi.name === sFi) {
                                                        (oFi.parameter || []).forEach(function (p) {
                                                                if (p.name === sParam) { bHit = true; }
                                                        });
                                                }
                                        });
                                });
                        });
                        return bHit;
                },

                /* =================================================================
                 * 20261021：长文本通道（AnalyzeCode 414）
                 * OData V2 函数导入的参数全在 URL 查询串里，问题（尤其贴代码 / 附件）URL 编码后
                 * 中文 ×9、空格换行引号 ×3，几百行代码就超过网关 / ICM 的 URL 上限 → HTTP 414。
                 * 编码后超过 LONG_Q_LIMIT 时：先把正文 POST 到实体集 ChatTexts（请求体不受 URL 长度
                 * 限制）拿回 TextId，再用 "@@ZAI_TEXT:<TextId>" 作为 Question 调原来的函数导入；
                 * DPC_EXT V15.6 解析参数时换回原文（只认本人存的、用一次即删）。
                 * 后端没有 ChatTexts（还没部署）时直接给可读提示，不再发出去换一个 414。
                 * ================================================================= */
                LONG_Q_LIMIT: 3000,
                LONG_Q_PREFIX: "@@ZAI_TEXT:",

                /** → Promise<string>：短问题原样；长问题暂存后返回引用 */
                _prepareQuestion: function (sQuestion) {
                        var s = sQuestion || "";
                        if (encodeURIComponent(s).length <= this.LONG_Q_LIMIT) {
                                return Promise.resolve(s);
                        }
                        var that = this;
                        var oModel = this._getModel();
                        return Promise.resolve(oModel.metadataLoaded ? oModel.metadataLoaded(true) : null).then(function () {
                                if (!that._hasEntitySet("ChatTexts")) {
                                        throw new Error("内容太长（超过网关 URL 长度上限），后端还没有部署长文本通道（ChatTexts），请缩短或分段发送");
                                }
                                return new Promise(function (fnResolve, fnReject) {
                                        oModel.create("/ChatTexts", { TextId: "", Content: s }, {
                                                success: function (oData) {
                                                        var oRoot = (oData && oData.d) || oData || {};
                                                        if (!oRoot.TextId) {
                                                                fnReject(new Error("长文本暂存失败：后端没有返回编号"));
                                                                return;
                                                        }
                                                        fnResolve(that.LONG_Q_PREFIX + oRoot.TextId);
                                                },
                                                error: function (oError) {
                                                        that._maybeAuthFail(oError);
                                                        fnReject(new Error("长文本暂存失败：" + that._fmtError(oError)));
                                                }
                                        });
                                });
                        });
                },

                /** 服务 metadata 里有没有某个实体集 */
                _hasEntitySet: function (sName) {
                        var oMeta = null;
                        try { oMeta = this._getModel().getServiceMetadata(); } catch (e) { oMeta = null; }
                        return ((oMeta && oMeta.dataServices && oMeta.dataServices.schema) || []).some(function (oSchema) {
                                return (oSchema.entityContainer || []).some(function (oEc) {
                                        return (oEc.entitySet || []).some(function (oEs) { return oEs.name === sName; });
                                });
                        });
                },

                /** 20261011：是否 403（CSRF 失效）—— 兼容 "HTTP 403" 与 "HTTP 403 - <响应体>" 两种错误格式 */
                _isCsrfFail: function (e) {
                        return !!e && (e.statusCode === 403 || /^HTTP 403\b/.test(e.message || ""));
                },

                /** V8：调用后端 Function Import（返回契约：{ d: { Success, Message, Json } }，Json 承载列表/对象数据）
                 *  20261019（FE-08）：改走 _fiCall —— POST 参数从 form 正文移到 URL（GW 不解析 form 正文），
                 *  CSRF / 403 重试与 _taskCall 共用一份
                 *  20261019（FE-02）：带 Success 字段且不是 "X" 即失败（后端失败返回空串，原判断
                 *  `d.Success && …` 对空串不成立 → 失败被当成功）；没有 Success 字段的旧后端照旧放行 */
                _v8Call: function (sAction, oParams, bPost) {
                        return this._fiCall(sAction, oParams, bPost).catch(function (e) {
                                // 保持 V8 原有错误文案（"HTTP 500" 等，不带响应体）
                                if (e && e.statusCode) {
                                        throw new Error("HTTP " + e.statusCode);
                                }
                                throw e;
                        }).then(function (d) {
                                if (d.Success !== undefined && d.Success !== null && d.Success !== "X") {
                                        throw new Error(d.Message || "调用失败");
                                }
                                return d.Json || "";
                        });
                },

                /** 应用层登录。成功后：网关 Basic 同步生效 + 写入本地登录态 */
                appLogin: function (sUser, sPass) {
                        var that = this;
                        sUser = (sUser || "").trim();
                        if (this._sConfig.mode === "mock") {
                                return this._mockAppLogin(sUser, sPass).then(function (oUser) {
                                        that._setAppUser(oUser);
                                        return jQuery.extend(true, {}, oUser);
                                });
                        }
                        // 后端模式：Basic 头直接打 Login function import；网关校验即真伪
                        var sBasic = "Basic " + btoa(unescape(encodeURIComponent(sUser + ":" + sPass)));
                        var sBase = this._sConfig.host + this._sConfig.path;
                        // V8.1：GW 对 POST 强制 CSRF —— 先用同凭据换 token，再打 Login
                        return this._fetchCsrf(sBasic).catch(function (e) {
                                throw new Error(e.message === "bad" ? "bad" : "noService");
                        }).then(function (sToken) {
                                return fetch(sBase + "Login", {
                                        method: "POST",
                                        headers: {
                                                "Accept": "application/json",
                                                "Authorization": sBasic,
                                                "x-csrf-token": sToken,
                                                "Content-Type": "application/x-www-form-urlencoded"
                                        },
                                        credentials: "same-origin"
                                });
                        }).then(function (oResp) {
                                if (!oResp.ok) {
                                        throw new Error(oResp.status === 401 || oResp.status === 403
                                                ? "bad" : "noService");
                                }
                                return oResp.json();
                        }).then(function (oJson) {
                                // V8.3：GW 把 FI 返回包在函数导入名下（d.Login），先剥壳
                                var oRoot = (oJson && oJson.d) || oJson || {};
                                var d = (oRoot && typeof oRoot.Login === "object" && oRoot.Login !== null)
                                        ? oRoot.Login : oRoot;
                                if ((d.Success || "") !== "X") {
                                        // 未开通权限等业务拒绝：透传后端原话给界面
                                        throw new Error("srv:" + (d.Message || "该账号未开通 Momo 使用权限，请联系管理员"));
                                }
                                var oInfo = {};
                                try { oInfo = JSON.parse(d.Json || "{}"); } catch (e) { oInfo = {}; }
                                // 网关凭据同步生效（聊天数据 OData 请求自动携带，不再弹 SAP 登录框）
                                // 不再强制持久化凭据；登录页的“记住我”由调用方决定。
                                that.setSapCredentials(sUser, sPass, false);
                                var oUser = {
                                        userId: oInfo.UserId || sUser,
                                        userName: oInfo.UserName || sUser,
                                        role: oInfo.Role || "USER",
                                        mustChangePwd: false
                                };
                                that._setAppUser(oUser);
                                return jQuery.extend(true, {}, oUser);
                        }).catch(function (e) {
                                if (e.message && e.message.indexOf("srv:") === 0) {
                                        throw e;
                                }
                                throw new Error(e.message === "bad" ? "bad"
                                        : e.message === "initGone" ? "initGone" : "noService");
                        });
                },

                /** 退出登录（清除本地登录态 + 网关凭据） */
                appLogout: function () {
                        this._setAppUser(null);
                        this.clearSapCredentials();
                },

                /** 后端是否已完成初始化（管理员已配置并联调通过后端地址）
                 *  mock：localStorage zaiChat.cfgBackendUrl 非空
                 *  backend：GetConfig('BACKEND_URL') 有值（接口未发布时视为未初始化） */
                isBackendInitialized: function () {
                        if (this._sConfig.mode === "mock") {
                                var s = null;
                                try { s = window.localStorage.getItem("zaiChat.cfgBackendUrl"); } catch (e) { /* 忽略 */ }
                                return Promise.resolve(!!s);
                        }
                        return this._v8Call("GetConfig", { ConfigKey: "BACKEND_URL" }, false)
                                .then(function (sJson) { return !!sJson; })
                                .catch(function () { return false; });
                },

                /** 保存后端地址（管理员）：本地初始化窗口 = 触发"初始管理员失效"的开关 */
                saveBackendConfig: function (sHost, sPath) {
                        if (this._sConfig.mode === "mock") {
                                try { window.localStorage.setItem("zaiChat.cfgBackendUrl", sHost || "configured"); } catch (e) { /* 忽略 */ }
                                return Promise.resolve(true);
                        }
                        return this._v8Call("SaveConfig", {
                                ConfigKey: "BACKEND_URL",
                                ConfigValue: (sHost || "") + "|" + (sPath || "")
                        }, true).then(function () { return true; }).catch(function () { return false; });
                },

                getUsersData: function () {
                        if (this._sConfig.mode === "mock") {
                                var a = this._mockUsers().map(function (u) { return jQuery.extend({}, u, { PwdHash: "" }); });
                                // 20261021：演示模式的内置管理员写死在登录逻辑里、不在 mock 用户表，
                                // 列表补一行只读的（BuiltIn），否则开通前一直显示"暂无用户"
                                var bHasAdmin = a.some(function (u) { return String(u.UserId || "").toUpperCase() === "ADMIN"; });
                                if (!bHasAdmin) {
                                        a.unshift({ UserId: "ADMIN", UserName: "管理员", Role: "ADMIN", Active: "X", BuiltIn: true });
                                }
                                return Promise.resolve(a);
                        }
                        return this._v8Call("UsersList", null, false).then(function (sJson) {
                                var a;
                                try { a = JSON.parse(sJson || "[]"); } catch (e) { a = []; }
                                // 20261021：后端 /ui2/cl_json 默认保留 ABAP 字段名 [{USERID,USERNAME,ROLE,ACTIVE}]，
                                // 原来直接按 UserId 读，SAP 上账号/姓名全空、人人显示 USER + 停用。统一成驼峰。
                                return (Array.isArray(a) ? a : []).map(function (u) {
                                        return {
                                                UserId: u.UserId || u.USERID || "",
                                                UserName: u.UserName || u.USERNAME || "",
                                                Role: u.Role || u.ROLE || "USER",
                                                Active: u.Active !== undefined ? u.Active : (u.ACTIVE || "")
                                        };
                                });
                        });
                },

                /** 开通用户（管理员）：mock 存本地；backend POST SaveUser */
                saveUserData: function (oUser) {
                        if (this._sConfig.mode === "mock") {
                                var a = this._mockUsers();
                                var i = -1;
                                for (var k = 0; k < a.length; k++) { if (a[k].UserId.toUpperCase() === oUser.UserId.toUpperCase()) { i = k; break; } }
                                var oRow = {
                                        UserId: oUser.UserId, UserName: oUser.UserName || "", Role: oUser.Role || "USER",
                                        Active: oUser.Active === undefined ? "X" : oUser.Active, PwdHash: this._sha256Sync("zai#" + (oUser.Password || "123456"))
                                };
                                if (i >= 0) { a[i] = oRow; } else { a.push(oRow); }
                                this._mockSaveUsers();
                                return Promise.resolve(true);
                        }
                        return this._v8Call("SaveUser", {
                                UserId: oUser.UserId || "",
                                UserName: oUser.UserName || "",
                                Role: oUser.Role || "USER",
                                // 20261019：停用传空串，原 `|| "X"` 把空串改回 "X"，停用从未生效
                                Active: oUser.Active === undefined ? "X" : oUser.Active
                        }, true).then(function () { return true; });
                },

                /** 角色：读（mock 读 zaiChat-roles，与旧 localStorage 格式兼容；backend RolesList） */
                getRolesData: function () {
                        if (this._sConfig.mode === "mock") {
                                var a = null;
                                try { a = JSON.parse(window.localStorage.getItem("zaiChat-roles") || "null"); } catch (e) { a = null; }
                                if (!a) {
                                        a = [{ name: "项目分析师" }, { name: "ABAP开发专家" }, { name: "功能顾问" }, { name: "测试工程师" }];
                                }
                                return Promise.resolve(a);
                        }
                        return this._v8Call("RolesList", null, false).then(function (sJson) {
                                var a = [];
                                try { a = JSON.parse(sJson || "[]"); } catch (e) { a = []; }
                                // 后端返回 [{NAME:...}]，统一为前端 {name:...}
                                return a.map(function (r) { return { name: r.name || r.NAME || r.Name }; });
                        }).catch(function () { return []; });
                },

                /** 角色保存（管理员全量覆盖：mock 写 zaiChat-roles；backend SaveRoles） */
                saveRolesData: function (aRoles) {
                        if (this._sConfig.mode === "mock") {
                                try { window.localStorage.setItem("zaiChat-roles", JSON.stringify(aRoles || [])); } catch (e) { /* 忽略 */ }
                                return Promise.resolve(true);
                        }
                        var aNames = (aRoles || []).map(function (r) { return r.name; });
                        // 20261019（FE-02）：失败不再吞成 false，抛出后端原因（BE-08 的拒绝理由要能被看到）
                        return this._v8Call("SaveRoles", { Roles: JSON.stringify(aNames) }, true)
                                .then(function () { return true; });
                },

                /** 泡泡提示词：读（mock 读 zaiChat-quickPrompts；backend PromptsList） */
                getPromptsData: function () {
                        if (this._sConfig.mode === "mock") {
                                var a = null;
                                try { a = JSON.parse(window.localStorage.getItem("zaiChat-quickPrompts") || "null"); } catch (e) { a = null; }
                                if (!a) {
                                        a = [
                                                { title: "写 ALV 报表", prompt: "请帮我写一个 ALV 报表…" },
                                                { title: "代码审查", prompt: "请对以下 ABAP 代码做代码审查…" },
                                                { title: "补充注释", prompt: "请为以下 ABAP 代码补充注释…" },
                                                { title: "单元测试", prompt: "请为以下 ABAP 代码编写 ABAP Unit 测试…" },
                                                { title: "性能优化", prompt: "请分析以下 ABAP 代码的性能问题…" },
                                                { title: "表结构设计", prompt: "我要设计一张 Z 开头的自定义表，用途如下…" }
                                        ];
                                }
                                return Promise.resolve(a);
                        }
                        return this._v8Call("PromptsList", null, false).then(function (sJson) {
                                var a = [];
                                try { a = JSON.parse(sJson || "[]"); } catch (e) { a = []; }
                                // 后端字段 PROMPTID/TITLE/CONTENT/SORTNO → 前端 {title, prompt}
                                return a.map(function (p) {
                                        return { title: p.title || p.TITLE, prompt: p.prompt || p.CONTENT || p.PROMPT };
                                });
                        }).catch(function () { return []; });
                },

                /** 泡泡提示词保存（管理员）：格式同角色 */
                savePromptsData: function (aPrompts) {
                        if (this._sConfig.mode === "mock") {
                                try { window.localStorage.setItem("zaiChat-quickPrompts", JSON.stringify(aPrompts || [])); } catch (e) { /* 忽略 */ }
                                return Promise.resolve(true);
                        }
                        var aOut = (aPrompts || []).map(function (p) { return { title: p.title, prompt: p.prompt }; });
                        // 20261019（FE-02）：同 saveRolesData，失败抛出后端原因
                        return this._v8Call("SavePrompts", { Prompts: JSON.stringify(aOut) }, true)
                                .then(function () { return true; });
                }
        };

        // 20261011（FE-09）：演示模式实现在 service/MockBackend（mixin，_mock* 等方法）
        Object.assign(Service, MockBackend, AuthMockBackend, FioriMockBackend, SkillService);

        return Service;
});
