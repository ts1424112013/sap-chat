sap.ui.define([
        "sap/base/Log",
        "sap/ui/model/odata/v2/ODataModel",
        "sap/ui/model/Filter",
        "sap/ui/model/FilterOperator",
        "sap/ui/model/Sorter"
], function (Log, ODataModel, Filter, FilterOperator, Sorter) {
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

                /** V5.1：SAP 网关登录凭据（HTTP Basic）——内存 + localStorage（zaiChat-sapAuth） */
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
                // V5.1/V5.3：SAP 网关登录（HTTP Basic）
                // 两种凭据形态：① 用户名+密码（自动编码） ② 直接粘贴 Basic 认证头
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

                /** 首次使用时从 localStorage 恢复凭据 */
                _loadAuthStore: function () {
                        if (this._oAuthStore.loaded) {
                                return;
                        }
                        this._oAuthStore.loaded = true;
                        try {
                                var sRaw = window.localStorage.getItem("zaiChat-sapAuth");
                                var o = sRaw ? JSON.parse(sRaw) : null;
                                if (o) {
                                        this._sSapUser = o.user || "";
                                        this._sSapPass = o.pass || "";
                                        this._sSapHeader = o.header || "";
                                }
                        } catch (e) { /* 忽略 */ }
                },

                /** 是否已有网关凭据（Basic 头或用户名，内存或 localStorage） */
                hasSapCredentials: function () {
                        this._loadAuthStore();
                        return !!(this._sSapUser || this._sSapHeader);
                },

                /** 当前登录用户名；Basic 头模式尝试解码出用户名（失败显示"Basic 头"） */
                getSapUser: function () {
                        this._loadAuthStore();
                        if (!this._sSapUser && this._sSapHeader) {
                                try {
                                        var sPayload = this._sSapHeader.replace(/^Basic\s+/i, "");
                                        var sDecoded = decodeURIComponent(escape(atob(sPayload)));
                                        return sDecoded.split(":")[0] || "Basic 头";
                                } catch (e) {
                                        return "Basic 头";
                                }
                        }
                        return this._sSapUser;
                },

                /** 是否为 Basic 头直填模式 */
                isHeaderMode: function () {
                        this._loadAuthStore();
                        return !!this._sSapHeader && !this._sSapUser;
                },

                /**
                 * V5.3：直接保存 Basic 认证头（如 "Basic dXNlcjpwYXNz"）
                 * @param {string} sHeader 完整 Authorization 头值；缺 "Basic " 前缀时自动补
                 * @param {boolean} bRemember true=写入本浏览器 localStorage
                 */
                setSapHeader: function (sHeader, bRemember) {
                        this._oAuthStore.loaded = true;
                        var sVal = (sHeader || "").trim();
                        if (sVal && !/^Basic\s/i.test(sVal)) {
                                sVal = "Basic " + sVal;
                        }
                        this._sSapHeader = sVal;
                        this._sSapUser = "";
                        this._sSapPass = "";
                        this._persistAuth(bRemember);
                        this._oODataModel = null;
                },

                /**
                 * 保存网关凭据（用户名+密码形态）并使其立即生效（重建 OData 模型）
                 * @param {string} sUser 用户名
                 * @param {string} sPass 密码
                 * @param {boolean} bRemember true=写入本浏览器 localStorage；false=仅本次会话（内存）
                 */
                setSapCredentials: function (sUser, sPass, bRemember) {
                        this._oAuthStore.loaded = true;
                        this._sSapUser = sUser || "";
                        this._sSapPass = sPass || "";
                        this._sSapHeader = ""; // 账密模式覆盖 Basic 头模式
                        this._persistAuth(bRemember);
                        this._oODataModel = null; // 重建以应用新 Basic 头并重新取 metadata/token
                },

                /** 凭据写入 localStorage（仅 bRemember 时） */
                _persistAuth: function (bRemember) {
                        try {
                                if (bRemember && (this._sSapUser || this._sSapHeader)) {
                                        window.localStorage.setItem("zaiChat-sapAuth", JSON.stringify({
                                                user: this._sSapUser,
                                                pass: this._sSapPass,
                                                header: this._sSapHeader
                                        }));
                                } else {
                                        window.localStorage.removeItem("zaiChat-sapAuth");
                                }
                        } catch (e) { /* 忽略 */ }
                },

                /** 清除网关凭据（内存 + localStorage） */
                clearSapCredentials: function () {
                        this._sSapUser = "";
                        this._sSapPass = "";
                        this._sSapHeader = "";
                        try { window.localStorage.removeItem("zaiChat-sapAuth"); } catch (e) { /* 忽略 */ }
                        this._oODataModel = null;
                },

                /**
                 * V5.3：多标签页同步 —— 其他窗口登录/清除凭据后调用本方法，
                 * 强制丢弃内存凭据缓存并从 localStorage 重读，重建 OData 模型。
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

                /** V5.3：格式校验 Basic 头（Basic 前缀 + 可解码的 base64 载荷） */
                _validateBasicHeader: function (sHeader) {
                        var sVal = (sHeader || "").trim();
                        if (!sVal) {
                                return { ok: false, message: "Basic 认证头为空" };
                        }
                        var sPayload = sVal.replace(/^Basic\s+/i, "");
                        if (!sPayload) {
                                return { ok: false, message: "缺少 base64 凭据载荷（应形如 Basic dXNlcjpwYXNz）" };
                        }
                        try {
                                var sDecoded = decodeURIComponent(escape(atob(sPayload)));
                                if (sDecoded.indexOf(":") < 0) {
                                        return { ok: false, message: "base64 解码后缺少冒号分隔（应为 用户:密码 的编码）" };
                                }
                        } catch (e) {
                                return { ok: false, message: "base64 载荷无法解码，请检查字符串是否完整（注意不要混入换行/空格）" };
                        }
                        return { ok: true };
                },

                /**
                 * V5.3：验证 Basic 认证头：对 $metadata 发一次带该头的 GET
                 * @param {string} sHeader 完整头值（自动补 Basic 前缀）
                 * @returns {Promise<{ok, status, message}>} 永远 resolve，不 reject
                 */
                verifySapHeader: function (sHeader) {
                        var that = this;
                        var sVal = (sHeader || "").trim();
                        if (sVal && !/^Basic\s/i.test(sVal)) {
                                sVal = "Basic " + sVal;
                        }
                        var oFmt = that._validateBasicHeader(sVal);
                        if (!oFmt.ok) {
                                return Promise.resolve({ ok: false, status: 0, message: oFmt.message });
                        }
                        var sUrl = this._sConfig.host + this._sConfig.path + "$metadata";
                        // 12 秒超时：地址不通（DNS 挂起）时避免验证请求无限等待
                        var oAbort = new AbortController();
                        var iTimer = setTimeout(function () { oAbort.abort(); }, 12000);
                        return fetch(sUrl, {
                                method: "GET",
                                headers: { "Authorization": sVal },
                                credentials: "omit",
                                signal: oAbort.signal
                        }).then(function (oResp) {
                                clearTimeout(iTimer);
                                if (oResp.ok) {
                                        return { ok: true, status: oResp.status, message: "" };
                                }
                                if (oResp.status === 401 || oResp.status === 403) {
                                        return {
                                                ok: false, status: oResp.status,
                                                message: "网关拒绝（HTTP " + oResp.status + "）：base64 串与账号密码不匹配，或账号被锁"
                                        };
                                }
                                return {
                                        ok: false, status: oResp.status,
                                        message: "网关返回 HTTP " + oResp.status + "，服务可能未就绪或地址有误。"
                                };
                        }).catch(function () {
                                clearTimeout(iTimer);
                                return {
                                        ok: false, status: 0,
                                        message: "无法连接网关（或连接超时）：请检查 ui5.yaml 代理 baseUri / 网络连通性 / 后端地址。"
                                };
                        });
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
                        var sMsg = "未知错误";
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
                                return aRows.reverse();
                        });
                },

                /**
                  * 获取会话列表 → Promise<[{SessionId,Title,ModelId,MsgCount,CreatedAt,ChangedAt,Mode,AgentType,Status}]>
                  * 后端模式: GET /Sessions（读 ZAI_CHAT_SESS，仅当前用户）
                  * V12: Mode 统一规范化（空/缺省 → CHAT，老会话无需迁移即可打开）
                  */
                getSessions: function () {
                        var fnNorm = function (s) {
                                s = s || {};
                                s.Mode = s.Mode === "AGENT" ? "AGENT" : "CHAT";
                                s.AgentType = s.AgentType || "";
                                s.Status = s.Status || "IDLE";
                                return s;
                        };
                        if (this._sConfig.mode === "mock") {
                                var a = Service._mockStore().sessions.slice().map(fnNorm);
                                a.sort(function (x, y) { return (y.ChangedAt || "").localeCompare(x.ChangedAt || ""); });
                                return Promise.resolve(a);
                        }
                        return this._read("/Sessions", { urlParameters: { "$top": "100" } }).then(function (oData) {
                                return ((oData && oData.results) || []).map(fnNorm);
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
                        return new Promise(function (fnResolve, fnReject) {
                                oModel.callFunction("/AnalyzeCode", {
                                        method: "POST",
                                        urlParameters: {
                                                SessionId: oPayload.sessionId,
                                                Question: oPayload.question,
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
                        if (this._sConfig.mode === "mock") {
                                return this._mockSendAgent(oPayload);
                        }
                        var that = this;
                        var oModel = this._getModel();
                        return new Promise(function (fnResolve, fnReject) {
                                oModel.callFunction("/AnalyzeAgent", {
                                        method: "POST",
                                        urlParameters: {
                                                SessionId: oPayload.sessionId,
                                                Question: oPayload.question,
                                                ModelId: oPayload.modelId || ""
                                        },
                                        success: function (oData) {
                                                // 与 send 相同的解包兼容：d.AnalyzeAgent 或直接对象
                                                var res = oData && (oData.AnalyzeAgent || oData) || {};
                                                var aTrace = [];
                                                try {
                                                        aTrace = JSON.parse(res.TraceJson || "[]") || [];
                                                } catch (e) {
                                                        aTrace = [];   // Trace 仅用于展示，解析失败不阻断回答
                                                }
                                                // V1.3：结构化数据分析结果（可选字段，旧后端无此字段）
                                                var oAnalysis = null;
                                                if (res.AnalysisJson) {
                                                        try {
                                                                oAnalysis = Service._sanitizeAnalysis(
                                                                        JSON.parse(res.AnalysisJson));
                                                        } catch (e) {
                                                                oAnalysis = null;   // 仅影响表格/图表渲染
                                                        }
                                                }
                                                fnResolve({
                                                        answer: res.Answer || "",
                                                        status: res.Status || "OK",
                                                        elapsedMs: parseInt(res.ElapsedMs || "0", 10) || 0,
                                                        rounds: parseInt(res.Rounds || "0", 10) || 0,
                                                        message: res.Message || "",
                                                        modelId: res.ModelId || oPayload.modelId || "",
                                                        trace: aTrace,
                                                        analysis: oAnalysis
                                                });
                                        },
                                        error: function (oError) {
                                                that._maybeAuthFail(oError);
                                                fnReject(new Error(that._fmtError(oError)));
                                        }
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

                /**
                  * V12：按会话模式统一发送入口 —— 控制器只认这个方法，
                  * 后续新增 Agent 类型时仅在此扩展路由，调用方不改
                  * @param {object} oPayload {mode:"CHAT"|"AGENT", sessionId, question, modelId}
                  * @returns {Promise} send/sendAgent 的原生返回结构
                  */
                sendByMode: function (oPayload) {
                        var o = oPayload || {};
                        if (o.mode === "AGENT") {
                                return this.sendAgent({
                                        sessionId: o.sessionId,
                                        question: o.question,
                                        modelId: o.modelId
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
                 * V10：更新会话（重命名 / 置顶切换，后端仅限本人会话）
                 * @param {object} oUpd {sessionId, title, pinned} title/pinned 可选
                 * @returns {Promise<string>} 后端 Message
                 */
                updateSession: function (oUpd) {
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
                                oSess.Pinned = oUpd.pinned === "X" ? "X" : "";
                                Service._mockSave(oStore);
                                return Promise.resolve("已更新");
                        }
                        return this._v8Call("UpdateSession", {
                                SessionId: oUpd.sessionId || "",
                                Title: oUpd.title || "",
                                Pinned: oUpd.pinned === "X" ? "X" : ""
                        }, true).then(function (sMsg) {
                                return sMsg || "已更新";
                        });
                },

                // =================================================================
                // Mock 实现（演示模式）
                // =================================================================
                /**
                 * Mock 本地持久化存储：{ sessions:[], messages:{sid:[rows]} }
                 * 演示模式下会话/消息保存在浏览器 localStorage，体验与后端模式一致
                 */
                _mockStore: function () {
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
                                                        "连接后提问中带上 Z/Y 开头的对象名（如 `ZAPP_IDP_0018`），后端会自动提取源码交给大模型分析，回复中的代码块可一键复制：",
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
                                                aTrace.push({ phase: "EXECUTING", label: "查询库存快照（MARD 0001/A001，演示）", status: "OK", elapsedMs: 580, rows: 2 });
                                                aTrace.push({ phase: "EXECUTING", label: "查询当天收发（MSEG 过账日汇总，演示）", status: "OK", elapsedMs: 710, rows: 2 });
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
                                                aTrace.push({ phase: "EXECUTING", label: "数据分析查询: 按物料类型统计, 5 行", status: "OK", elapsedMs: 640, rows: 5 });
                                                aTrace.push({ phase: "EXECUTING", label: "数据分析查询: 按创建月份趋势, 6 行", status: "OK", elapsedMs: 520, rows: 6 });
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

                                        // 与 _mockSend 相同的本地持久化（通用 Agent 会话，AgentType=GENERAL）
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
                                                        AgentType: "GENERAL",
                                                        Status: "COMPLETED"
                                                });
                                        } else {
                                                oSess.ChangedAt = sNow;
                                                oSess.MsgCount = String((parseInt(oSess.MsgCount || "0", 10) || 0) + 2);
                                                oSess.Mode = "AGENT";
                                                oSess.AgentType = "GENERAL";
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

                /** V8：调用后端 Function Import 的统一通道
                 *  返回契约：{ d: { Success, Message, Json } }（Json 承载列表/对象数据）
                 *  POST 参数走 OData V2 FI 标准的 form-urlencoded
                 *  V8.1：POST 自动携带 CSRF token；遇 403 自动刷新 token 重试一次 */
                _v8Call: function (sAction, oParams, bPost) {
                        var that = this;
                        var sUrl = this._sConfig.host + this._sConfig.path + sAction;
                        var sBasic = this._basicHeader();
                        var fnBuild = function (sToken) {
                                // V8.2：GW 默认返回 Atom XML，必须声明 JSON 才能被 oResp.json() 解析
                                var oHeaders = { "Accept": "application/json" };
                                if (sBasic) {
                                        oHeaders.Authorization = sBasic;
                                }
                                var oInit = { method: bPost ? "POST" : "GET", headers: oHeaders, credentials: "same-origin" };
                                if (bPost) {
                                        if (sToken) {
                                                oHeaders["x-csrf-token"] = sToken;
                                        }
                                        oHeaders["Content-Type"] = "application/x-www-form-urlencoded";
                                        var oBody = new URLSearchParams();
                                        Object.keys(oParams || {}).forEach(function (k) {
                                                oBody.append(k, oParams[k]);
                                        });
                                        oInit.body = oBody.toString();
                                } else if (oParams && Object.keys(oParams).length) {
                                        var aQ = Object.keys(oParams).map(function (k) {
                                                return k + "='" + encodeURIComponent(oParams[k]) + "'";
                                        });
                                        sUrl += "?" + aQ.join("&");
                                }
                                return oInit;
                        };
                        var fnSend = function (oInit) {
                                return fetch(sUrl, oInit).then(function (oResp) {
                                        if (!oResp.ok) {
                                                throw new Error("HTTP " + oResp.status);
                                        }
                                        return oResp.json();
                                }).then(function (oJson) {
                                        // V8.3：GW 把 FI 返回包在函数导入名下（d.AnalyzeCode 等），先剥壳
                                        var oRoot = (oJson && oJson.d) || oJson || {};
                                        var d = (oRoot && typeof oRoot[sAction] === "object" && oRoot[sAction] !== null)
                                                ? oRoot[sAction] : oRoot;
                                        if (d.Success && d.Success !== "X") {
                                                throw new Error(d.Message || "调用失败");
                                        }
                                        return d.Json || "";
                                });
                        };
                        if (!bPost) {
                                return fnSend(fnBuild(""));
                        }
                        // POST：带缓存 token；403 时刷新 token 重试一次
                        var fnTry = function (sToken) {
                                return fnSend(fnBuild(sToken)).catch(function (e) {
                                        if (e.message === "HTTP 403") {
                                                return that._fetchCsrf(sBasic).then(function (sNew) {
                                                        that._sCsrfToken = sNew;
                                                        return fnSend(fnBuild(sNew));
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
                                        throw new Error("srv:" + (d.Message || "该账号未开通 SAP Compass 使用权限，请联系管理员"));
                                }
                                var oInfo = {};
                                try { oInfo = JSON.parse(d.Json || "{}"); } catch (e) { oInfo = {}; }
                                // 网关凭据同步生效（聊天数据 OData 请求自动携带，不再弹 SAP 登录框）
                                that.setSapCredentials(sUser, sPass, true);
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
                },

                getUsersData: function () {
                        if (this._sConfig.mode === "mock") {
                                var a = this._mockUsers().map(function (u) { return jQuery.extend({}, u, { PwdHash: "" }); });
                                return Promise.resolve(a);
                        }
                        return this._v8Call("UsersList", null, false).then(function (sJson) {
                                try { return JSON.parse(sJson || "[]"); } catch (e) { return []; }
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
                                        Active: oUser.Active || "X", PwdHash: this._sha256Sync("zai#" + (oUser.Password || "123456"))
                                };
                                if (i >= 0) { a[i] = oRow; } else { a.push(oRow); }
                                this._mockSaveUsers();
                                return Promise.resolve(true);
                        }
                        return this._v8Call("SaveUser", {
                                UserId: oUser.UserId || "",
                                UserName: oUser.UserName || "",
                                Role: oUser.Role || "USER",
                                Active: oUser.Active || "X"
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
                        return this._v8Call("SaveRoles", { Roles: JSON.stringify(aNames) }, true)
                                .then(function () { return true; }).catch(function () { return false; });
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
                        return this._v8Call("SavePrompts", { Prompts: JSON.stringify(aOut) }, true)
                                .then(function () { return true; }).catch(function () { return false; });
                }
        };

        return Service;
});
