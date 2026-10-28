sap.ui.define([
        "sap/ui/core/mvc/Controller",
        "sap/ui/model/json/JSONModel",
        "sap/ui/core/Item",
        "zai/chat/utils/Toast",
        "sap/m/MessageBox",
        "sap/m/CustomListItem",
        "sap/m/HBox",
        "sap/m/VBox",
        "sap/m/Text",
        "sap/m/Button",
        "sap/m/FlexItemData",
        "sap/m/Dialog",
        "sap/m/Input",
        "sap/m/InstanceManager",
        "sap/ui/core/HTML",
        "sap/ui/util/Storage",
        "zai/chat/service/ChatService",
        "zai/chat/service/TraceService",
        "zai/chat/utils/Formatter",
        "zai/chat/utils/ChartRenderer",
        "zai/chat/utils/ChartBuilder",
        "zai/chat/utils/ChartFx",
        "zai/chat/utils/AskCard",
        "zai/chat/utils/DataGrid",
        "zai/chat/control/LingXiMark",
        "zai/chat/utils/LingXiState",
        "zai/chat/utils/OfflineNotice",
        "zai/chat/utils/WelcomeToast",
        "zai/chat/utils/HeroGreeting",
        "zai/chat/utils/UndoToast",
        "zai/chat/controller/mixin/SceneModels",
        "zai/chat/controller/mixin/SettingsPanel",
        "zai/chat/controller/mixin/EvalPanel",
        "zai/chat/controller/mixin/RunTracker",
        "zai/chat/controller/mixin/AuthPanel",
        "zai/chat/controller/mixin/AuthApprove",
        "zai/chat/controller/mixin/CatalogPanel",
        "zai/chat/controller/mixin/FioriPanel",
        "zai/chat/controller/mixin/SessionMessages",
        "zai/chat/controller/mixin/SkillPanel",
        "zai/chat/controller/mixin/ResultRestore"
], function (Controller, JSONModel, Item, MessageToast, MessageBox, CustomListItem, HBox, VBox, Text, Button, FlexItemData, Dialog, Input, InstanceManager, HTML, Storage, ChatService, TraceService, Formatter, ChartRenderer, ChartBuilder, ChartFx, AskCard, DataGrid, LingXiMark, LingXiState, OfflineNotice, WelcomeToast, HeroGreeting, UndoToast, SceneModels, SettingsPanel, EvalPanel, RunTracker, AuthPanel, AuthApprove, CatalogPanel, FioriPanel, SessionMessages, SkillPanel, ResultRestore) {
        "use strict";

        /**
         * =====================================================================
         * 主控制器：聊天界面交互逻辑
         * =====================================================================
         * 职责：
         *   1. 维护聊天/设置两个 JSONModel
         *   2. 调用 ChatService 发送消息、加载模型与历史
         *   3. 设置对话框 / 模型管理（新增、编辑大模型）
         *
         * V4（DeepSeek 风格）：发送给模型的 prompt 仅包含用户输入文本，
         * 不再自动识别 ABAP 对象名，不再附带"分析对象"等附加字段
         *
         * V5.4：① 首页快捷指令泡泡化（散落布局，点击填入输入框后消失；
         *      ② 对话态不再显示快捷指令行；③ 角色选择（可自定义增删，
         *      发送时以「【角色：xxx】」前缀拼进 Question，界面气泡显示
         *      原文、_buildEntry 统一剥离前缀还原，后端存文为发送原文）
         *
         * 20261011（FE-09）：四个自包含块拆到 controller/mixin/，以 mixin 并入
         * 本控制器（this 不变，视图里的 .onXxx 照常解析）：
         *   SceneModels   Agent 会话场景 / 模型白名单
         *   SettingsPanel 设置对话框 / 模型管理
         *   EvalPanel     Agent 测评对话框
         *   RunTracker    报表运行跟踪（步骤条）
         *   AuthPanel     事务码权限自助申请（20261020）
         *   AuthApprove   侧栏「权限审批」对话框（20261020）
         *   CatalogPanel  「报表执行」/「Fiori 报表」场景首页的报表目录（20261020）
         *   FioriPanel    Fiori 报表取数、结果与「交给模型分析」（20261020）
         *   SessionMessages 会话消息缓存与历史恢复
         * 新增方法前先看是否属于这几块；方法名不能与 mixin 重复（后者会覆盖）。
         * =====================================================================
         */
        return Controller.extend("zai.chat.controller.App", Object.assign({

                /** localStorage 存储（保存连接配置与当前会话） */
                _oStorage: new Storage(Storage.Type.local, "zaiChat"),

                /** 当前正在编辑的模型 ID（新增时为 null） */
                _sEditingModelId: null,

                /** 流式输出令牌：会话切换/新建时置空，用于中断进行中的打字机动画 */
                _sStreamToken: "",

                /* =========================================================
                 * 初始化
                 * ========================================================= */

                onInit: function () {
                        var that = this;

                        // ---------- 聊天数据模型 ----------
                        var oChatModel = new JSONModel({
                                sessionId: "",
                                input: "",
                                currentModel: "",
                                currentModelName: "",           // 20261020：输入框模型胶囊上的文字（SceneModels._syncModelLabel）
                                busy: false,
                                models: [],
                                messages: [],
                                quickPrompts: [],  // V5：快捷指令（localStorage 持久化，可增删）
                                roles: [],          // V5.4：角色清单（{name}，localStorage 持久化，可增删）
                                currentRole: "",    // V5.4：当前选中角色（空 = 不使用角色）
                                heroVisible: true,   // 空状态：居中大输入框（DeepSeek 主页风格）
                                listVisible: false,  // 对话态：消息列表 + 底部输入
                                // ---- V12/V13：对话 / Agent 两种工作模式 ----
                                // 模式是会话级属性：workspaceMode 只是"正在浏览的工作区"，
                                // 发送分流的最终依据永远是 currentSession.mode。
                                // V13：Agent 为通用对话化编排（无类型卡片），agentType 仅留兼容
                                workspaceMode: "CHAT",          // "CHAT" | "AGENT"
                                currentSession: {
                                        id: "",
                                        mode: "CHAT",           // CHAT / AGENT（会话自身）
                                        agentType: "",          // 兼容字段：新建通用 Agent 会话为空
                                        status: "IDLE"          // 最近一轮运行状态
                                },
                                agentInfoVisible: false,        // 顶栏"任务信息"入口
                                modeLabel: "",                  // 顶栏模式徽标文案（仅 对话 / Agent）
                                newBtnLabel: "",                // 新建按钮文案（随模式）
                                histLabel: "",                  // 历史区标题文案（随模式）
                                heroTitle: "",                  // 空状态问候（按时段 + 随机暖心话）
                                heroSub: "",                    // 和问候成对的副标题
                                heroModeHint: "",               // 输入卡下方保留当前模式 / 场景说明
                                heroPh: "",                     // 输入占位文案（随模式）
                                inputPh: "",
                                // ---- V15：多业务任务（只展示后端确认的状态） ----
                                // V16：参数表单/运行状态改为对话内联卡片（见 AskCard / _trackRun）
                                currentTask: null,              // {taskId,module,status,shortId,needsInput,reportId,tcode}
                                taskBadge: "",                  // 顶栏任务徽标（模块 · 状态）
                                taskBadgeState: "None",         // 徽标状态色
                                taskBadgeTip: "",               // 徽标悬浮提示（任务短编号）
                                // ---- V16：运行状态可视化 ----
                                activityText: "",               // 顶栏运行指示（生成中 / Agent 运行中 / 报表执行中）
                                logoState: "idle",              // 灵犀：等待思考 / 正文输出或后台运行 / 空闲
                                jumpVisible: false              // "回到底部"浮钮
                        });
                        this.getView().setModel(oChatModel, "chat");

                        // ---------- 会话列表模型（左侧历史栏） ----------
                        this.getView().setModel(new JSONModel({
                                sessions: [],
                                currentId: "",
                                title: ""
                        }), "session");

                        // ---------- 设置数据模型（V9：部署配置 config.js 为最高优先） ----------
                        // mode/host/path 每次启动都取自 config.js（部署环境事实源，
                        // 解决"刚部署读不到后端地址"）；设置对话框的修改仅本次会话有效
                    var oCfg = window.ZAI_CONFIG || {};
                    var oSaved = this._oStorage.get("settings") || {};   // 用于恢复会话与工作模式
                    var oSettingsModel = new JSONModel({
                                mode: oCfg.mode || "backend",
                                host: oCfg.host || "",
                                path: oCfg.path || "/sap/opu/odata/sap/ZAI_CHAT_SRV/",
                                sessionId: "",
                                agentSessionId: oSaved.agentSessionId || "",   // V12：Agent 当前任务
                                workspaceMode: oSaved.workspaceMode || "CHAT", // V12：上次工作模式
                                modelList: [],
                                isAdmin: false,         // 登录后由 _syncAdminUi 设置
                                authPending: 0,         // 20261020：侧栏「权限审批」角标（待审批条数）
                                authPendingTip: ""
                        });
                        this.getView().setModel(oSettingsModel, "settings");

                        // ---------- 会话恢复 / 新建 ----------
                        var sSession = oSaved.sessionId;
                        if (!sSession) {
                                sSession = this._newSessionId();
                        }
                        oSettingsModel.setProperty("/sessionId", sSession);
                        // V4.1：同步「当前对话」ID —— 恢复的会话若在左侧列表中，
                        // 启动即以浅蓝底高亮显示（后续由 onNewSession/onSessionPress 维护）
                        this.getView().getModel("session").setProperty("/currentId", sSession);

                        // V12：按模式记忆当前会话（切换工作区互不干扰）
                        this._mModeSession = { CHAT: sSession, AGENT: oSaved.agentSessionId || "" };
                        this._sStartupWorkspace = oSaved.workspaceMode === "AGENT" ? "AGENT" : "CHAT";
                        this._sSessQuery = "";   // 会话搜索（当前模式内）

                        // ---------- 注入服务配置并加载 ----------
                        ChatService.setConfig({
                                mode: oSettingsModel.getProperty("/mode"),
                                host: oSettingsModel.getProperty("/host"),
                                path: oSettingsModel.getProperty("/path")
                        });
                        oChatModel.setProperty("/sessionId", sSession);

                        // ---------- V9：启动探测后端，再决定登录路径 ----------
                        // 可达（200/401/403）→ 正常后端登录；
                        // 不可达（网络不通/404/5xx，如在家无 VPN、服务未发布）→
                        // 自动降级演示模式，本地管理员 admin/123456 也能登录看页面
                        this._probeBackend(function (bOk) {
                                if (!bOk) {
                                        oSettingsModel.setProperty("/mode", "mock");
                                        ChatService.setConfig({
                                                mode: "mock",
                                                host: "",
                                                path: oSettingsModel.getProperty("/path")
                                        });
                                        that._bOfflineFallback = true;
                                        that._updateModeBadge();
                                }
                                // 数据加载统一收敛到登录成功后（_afterAppLogin）
                                // 20261025：降级提示 —— 已登录弹顶部卡片；未登录则嵌进登录卡片（_openAppLogin）
                                if (ChatService.getAppUser()) {
                                        that._afterAppLogin();
                                        if (!bOk) {
                                                that._showOfflineNotice();
                                        }
                                } else {
                                        that._openAppLogin();
                                }
                        });

                        // ---------- 输入框回车发送（居中大输入框 + 底部输入框共用，Shift+Enter 换行） ----------
                        var fnEnter = function (oEvent) {
                                if (that._skillPopover && that._skillPopover.isOpen()) { return; }
                                // 229 = 输入法组合中；isComposing 防止拼音回车误发送
                                if (oEvent.isComposing || oEvent.keyCode === 229) {
                                        return;
                                }
                                if (oEvent.key === "Enter" && !oEvent.shiftKey) {
                                        oEvent.preventDefault();
                                        that.onSend();
                                }
                        };
                        this.byId("msgInput").addEventDelegate({ onkeydown: fnEnter });
                        this.byId("heroInput").addEventDelegate({ onkeydown: fnEnter });
                        this._bindFileDrop();   // 20261025：拖文件进窗口 = 添加附件
                        ChartFx.bind();         // 20261025：图表出场动画（只播一次）+ 悬停聚焦与数值提示卡

                        // ---------- V8：网关认证由应用层登录承担 ----------
                        // 登录成功后同一账密即网关 Basic 凭据，不再弹 SAP 账密框；
                        // 任意 OData 请求 401 → 重新拉起应用层登录框（60 秒防抖在服务层）
                        ChatService.onAuthFailed = function () {
                                that._openAppLogin(true);
                        };

                        // ---------- V5.3：多标签页同步（storage 事件仅"其他窗口"触发） ----------
                        window.addEventListener("storage", function (oEv) {
                                if (!oEv.key) {
                                        return; // 清空存储等场景，忽略
                                }
                                if (oEv.key === "zaiChat-sapAuth") {
                                        // 其他窗口登录/更换/清除凭据 → 本窗口同步并重建模型
                                        ChatService.reloadAuth();
                                        that._clearSessionMessages();
                                        if (that.getView().getModel("settings").getProperty("/mode") === "backend") {
                                                that._loadModels();
                                                that._refreshSessions();
                                                that._loadHistory();
                                                MessageToast.show(that._rb().getText("toastAuthSynced"));
                                        }
                                } else if (oEv.key === "zaiChat-settings") {
                                        // 其他窗口更改了连接模式/后端地址 → 仅提示，不强制覆盖本窗口
                                        MessageToast.show(that._rb().getText("toastSettingsSynced"));
                                } else if (oEv.key === "zaiChat-quickPrompts") {
                                        // 其他窗口增删了快捷指令 → 本窗口同步显示（含泡泡重渲染）
                                        that._loadQuickPrompts();
                                } else if (oEv.key === "zaiChat-roles") {
                                        // 其他窗口增删了角色 → 本窗口同步（V5.4）
                                        that._loadRoles();
                                }
                        });

                        // ---------- V6.0：主题按钮状态同步（图标/悬浮提示随主题走） ----------
                        this._syncThemeToggle();

                        // ---------- V12：初始会话上下文与模式外观（启动恢复在 _refreshSessions 后） ----------
                        this._setSessionContext({ id: sSession, mode: "CHAT", agentType: "", status: "IDLE" });
                        this._applyWorkspaceChrome();
                },

                /* =========================================================
                 * V9.3：文本附件上传（第一阶段：前端直读，拼入发送文本）
                 * 支持：txt/log/abap/csv/json/xml/yaml/md/html/sql 等纯文本
                 * 限制：单文件 ≤5MB；送入模型内容截断至 30K 字符（meta 注明）
                 * 编码：UTF-8 优先，失败自动按 GBK 解码（中文 Windows 常见）
                 * ========================================================= */

                _aAttachExt: ["txt", "log", "text", "abap", "csv", "json", "xml", "yaml", "yml",
                        "md", "html", "htm", "sql", "py", "java", "js", "css", "ts",
                        "ini", "cfg", "conf", "properties", "xslt", "wsdl"],
                _iAttachMaxBytes: 5 * 1024 * 1024,
                _iAttachMaxChars: 30000,

                onFileChosen: function (oEvent) {
                        var aFiles = oEvent.getParameter("files");
                        var oFile = aFiles && aFiles[0];
                        oEvent.getSource().setValue(""); // 允许重复选择同一文件
                        if (oFile) {
                                this._readAttachFile(oFile);
                        }
                },

                /** 读入一个附件文件（点回形针选的、拖进来的共用）：校验类型 / 大小 → 解码 → 挂到输入卡 */
                _readAttachFile: function (oFile) {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var sName = oFile.name || oRB.getText("attachDefaultName");
                        var iBytes = oFile.size || 0;
                        var sExt = (sName.split(".").pop() || "").toLowerCase();
                        var bKnown = sName.indexOf(".") >= 0;

                        if (bKnown && this._aAttachExt.indexOf(sExt) < 0) {
                                MessageToast.show(oRB.getText("attachBadType") + " " + sName);
                                return;
                        }
                        if (iBytes > this._iAttachMaxBytes) {
                                MessageToast.show(oRB.getText("attachTooBig") + " " + sName);
                                return;
                        }

                        // ArrayBuffer → UTF-8（严格模式）失败转 GBK → 再兜底宽松 UTF-8
                        oFile.arrayBuffer().then(function (aBuf) {
                                var sText = "";
                                try {
                                        sText = new TextDecoder("utf-8", { fatal: true }).decode(aBuf);
                                } catch (e1) {
                                        try {
                                                sText = new TextDecoder("gbk").decode(aBuf);
                                        } catch (e2) {
                                                sText = new TextDecoder("utf-8").decode(aBuf);
                                        }
                                }
                                if (!sText || !sText.replace(/\s/g, "")) {
                                        MessageToast.show(oRB.getText("attachReadFail") + " " + sName);
                                        return;
                                }
                                that._applyAttachment(sName, iBytes, sText);
                        }).catch(function () {
                                MessageToast.show(oRB.getText("attachReadFail") + " " + sName);
                        });
                },

                /** 设置附件并刷新两张输入卡的回显行（首页/对话态共用一份状态）
                 *  V12：Agent 模式下不显示附件行（附件仅对话模式使用） */
                _applyAttachment: function (sName, iBytes, sText) {
                        var oRB = this._rb();
                        var iLines = sText.split("\n").length;
                        var bTrunc = sText.length > this._iAttachMaxChars;
                        if (bTrunc) {
                                sText = sText.slice(0, this._iAttachMaxChars);
                        }
                        var sSize = Math.max(1, Math.round(iBytes / 1024)) + "KB";
                        // 发送文本的附件块：模型可见，界面气泡不显示
                        var sBlock = "\n\n以下是附件 " + sName + " 的内容（" + sSize +
                                (bTrunc ? oRB.getText("attachTruncated", [this._iAttachMaxChars]) : "") + "）：\n" +
                                "```text\n" + sText + "\n```";
                        this._oAttachment = {
                                name: sName,
                                sizeText: sSize,
                                lines: iLines,
                                block: sBlock
                        };
                        // 20261025：文件小卡片 —— 类型图标 + 文件名 + 「大小 · 行数」
                        var sMeta = oRB.getText(bTrunc ? "attachChipMetaTrunc" : "attachChipMeta", [sSize, iLines]);
                        var sIcon = this._attachIcon(sName);
                        ["Hero", "Dock"].forEach(function (sSuf) {
                                this.byId("attachName" + sSuf).setText(sName);
                                this.byId("attachMeta" + sSuf).setText(sMeta);
                                this.byId("attachIco" + sSuf).setSrc(sIcon);
                                this.byId("attachRow" + sSuf).setTooltip(sName);
                        }, this);
                        this._syncAttachRowVisibility();
                        // 换了附件（卡片本来就在）也弹一下
                        var that = this;
                        setTimeout(function () {
                                ["attachRowHero", "attachRowDock"].forEach(function (sId) {
                                        var oDom = that.byId(sId) && that.byId(sId).getDomRef();
                                        if (oDom) {
                                                oDom.classList.remove("attachPop");
                                                void oDom.offsetWidth;
                                                oDom.classList.add("attachPop");
                                        }
                                });
                        }, 0);
                },

                /** 附件卡片的类型图标：表格 / 代码 / 其他文本 */
                _attachIcon: function (sName) {
                        var sExt = (String(sName).split(".").pop() || "").toLowerCase();
                        if (sExt === "csv") {
                                return "sap-icon://table-view";
                        }
                        if (["abap", "json", "xml", "yaml", "yml", "html", "htm", "sql", "py", "java", "js", "css", "ts", "xslt", "wsdl"].indexOf(sExt) >= 0) {
                                return "sap-icon://source-code";
                        }
                        return "sap-icon://document-text";
                },

                /**
                 * 20261025：把文件拖进窗口 → 输入卡变蓝色虚线框、提示「松开即可添加」；松开 = 和点回形针选文件一样。
                 * 整个窗口都接（不用瞄准输入框）；有弹窗 / 弹出层开着时不接。不管接不接，都不让浏览器把文件直接打开。
                 */
                _bindFileDrop: function () {
                        if (this._bFileDropBound || typeof document === "undefined") {
                                return;
                        }
                        this._bFileDropBound = true;
                        var that = this;
                        var iDepth = 0;
                        var fnHasFiles = function (e) {
                                var t = e.dataTransfer && e.dataTransfer.types;
                                return !!t && Array.prototype.indexOf.call(t, "Files") >= 0;
                        };
                        var fnCanDrop = function () {
                                // MessageToast 也登记在弹出层里（类型是 sap.ui.core.Popup），提示还在时不能因此拒收
                                var aPop = (InstanceManager.getOpenPopovers() || []).filter(function (p) {
                                        return !(p && p.getMetadata && p.getMetadata().getName() === "sap.ui.core.Popup");
                                });
                                return !!ChatService.getAppUser() && !InstanceManager.hasOpenDialog() && !aPop.length;
                        };
                        var fnSet = function (bOn) {
                                Array.prototype.forEach.call(document.querySelectorAll(".inputCard"), function (oCard) {
                                        oCard.classList.toggle("fileDragOver", bOn);
                                        if (bOn && !oCard.querySelector(":scope > .dropHint")) {
                                                var oHint = document.createElement("div");
                                                oHint.className = "dropHint";
                                                oHint.setAttribute("aria-hidden", "true");
                                                oHint.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
                                                        'stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/></svg>' +
                                                        "<span></span>";
                                                oHint.querySelector("span").textContent = that._rb().getText("dropHint");
                                                oCard.appendChild(oHint);
                                        }
                                });
                        };
                        document.addEventListener("dragenter", function (e) {
                                if (!fnHasFiles(e)) {
                                        return;
                                }
                                e.preventDefault();
                                iDepth++;
                                if (fnCanDrop()) {
                                        fnSet(true);
                                }
                        });
                        document.addEventListener("dragover", function (e) {
                                if (!fnHasFiles(e)) {
                                        return;
                                }
                                e.preventDefault();
                                e.dataTransfer.dropEffect = fnCanDrop() ? "copy" : "none";
                        });
                        document.addEventListener("dragleave", function (e) {
                                if (!fnHasFiles(e)) {
                                        return;
                                }
                                iDepth = Math.max(0, iDepth - 1);
                                if (!iDepth || !e.relatedTarget) {   // 拖出窗口时 relatedTarget 为空
                                        iDepth = 0;
                                        fnSet(false);
                                }
                        });
                        document.addEventListener("drop", function (e) {
                                if (!fnHasFiles(e)) {
                                        return;
                                }
                                e.preventDefault();
                                iDepth = 0;
                                fnSet(false);
                                var aFiles = e.dataTransfer.files;
                                if (!fnCanDrop() || !aFiles || !aFiles.length) {
                                        return;
                                }
                                if (aFiles.length > 1) {
                                        MessageToast.show(that._rb().getText("dropOneFile"));
                                }
                                that._readAttachFile(aFiles[0]);
                                var oInput = that.byId(that.getView().getModel("chat").getProperty("/heroVisible") ? "heroInput" : "msgInput");
                                if (oInput) {
                                        oInput.focus();
                                }
                        });
                },

                onAttachRemove: function () {
                        this._clearAttachment();
                },

                _clearAttachment: function () {
                        this._oAttachment = null;
                        this._syncAttachRowVisibility();
                },

                /** V13：附件回显行可见性 = 已选附件（对话与 Agent 均支持，Agent 作为任务上下文） */
                _syncAttachRowVisibility: function () {
                        var bShow = !!this._oAttachment;
                        this.byId("attachRowHero").setVisible(bShow);
                        this.byId("attachRowDock").setVisible(bShow);
                },

                /* 20261025：降级演示模式提示（utils/OfflineNotice.js）——「重新连接」再探测一次，通了就刷新页面 */
                _offlineNoticeTexts: function (bCompact) {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        return {
                                title: oRB.getText(bCompact ? "offlineLoginTitle" : "offlineTitle"),
                                body: oRB.getText("offlineBody"),
                                credUserLabel: oRB.getText("offlineCredUser"),
                                credUser: "admin",
                                credPassLabel: oRB.getText("offlineCredPass"),
                                credPass: "123456",
                                retryText: oRB.getText(bCompact ? "offlineRetryShort" : "offlineRetry"),
                                retryingText: oRB.getText("offlineRetrying"),
                                retryFailText: oRB.getText("offlineRetryFail"),
                                closeText: oRB.getText("offlineClose"),
                                onRetry: function (fnDone) { that._probeBackend(fnDone); }
                        };
                },

                _showOfflineNotice: function () {
                        OfflineNotice.show(this._offlineNoticeTexts(false));
                },

                /* =========================================================
                 * V9：后端可达性探测
                 * $metadata 的状态码语义：200=可用；401/403=服务在、待认证；
                 * 其余（网络异常/404/5xx）=不可达或未就绪 → 降级演示模式
                 * ========================================================= */
                _probeBackend: function (fnDone) {
                        var oCfg = window.ZAI_CONFIG || {};
                        var oSettings = this.getView().getModel("settings");
                        var sUrl = (oCfg.host || oSettings.getProperty("/host") || "") +
                                (oCfg.path || oSettings.getProperty("/path") || "/sap/opu/odata/sap/ZAI_CHAT_SRV/") +
                                "$metadata";
                        var oAbort = new AbortController();
                        var iTimer = setTimeout(function () { oAbort.abort(); }, oCfg.probeTimeoutMs || 12000);
                        fetch(sUrl, { method: "GET", credentials: "omit", signal: oAbort.signal })
                                .then(function (oResp) {
                                        clearTimeout(iTimer);
                                        fnDone(oResp.status === 200 || oResp.status === 401 || oResp.status === 403);
                                })
                                .catch(function () {
                                        clearTimeout(iTimer);
                                        fnDone(false);
                                });
                },

                /* =========================================================
                 * V8：应用层强制登录 / 权限分流
                 * 设计：账号 = 管理员从 SAP(SU01) 赋权开通的用户，密码即网关
                 * Basic 凭据（登录成功后同一账密直连 OData，不再弹 SAP 登录框）；
                 * 初始管理员 admin/123456 仅在"后端未配置"的初始化窗口可用，
                 * 且首次登录强制改密；后端配置完成后初始账号永久失效。
                 * ========================================================= */

                /** 登录成功（或已有登录态）后统一初始化：数据加载 + 权限分流 */
                _afterAppLogin: function () {
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        // V5：快捷指令（V8 起经服务层：后端模式存后端，多会话/多端共享）
                        this._loadQuickPrompts();
                        // V5.4/V8：角色清单（同上）
                        this._loadRoles();
                        // 模型列表 + 历史 + 会话列表
                        this._loadModels();
                        this._loadHistory();
                        // V4.1：列表更新完成后强制同步「当前对话」高亮（异步绑定重建后触发）
                        this.byId("sessionList").attachUpdateFinished(this._syncSessionHighlight, this);
                        this._refreshSessions();
                        this._updateModeBadge();
                        // V8：权限分流（按钮可见性/设置页编辑能力）
                        this._syncAdminUi();
                        // 20261020：会话级模型按账号记在本地 —— 登录后按这个账号重新取当前会话的模型
                        this._applySessionModel();
                        // 20261020：侧栏「权限审批」待审批角标（仅 ADMIN 实际查询）
                        this._authWatchStart();
                        var oUser = ChatService.getAppUser();
                        // V16：侧栏底部用户信息（头像缩写取账号，SAP 账号均为拉丁字母）
                        var oSettings = this.getView().getModel("settings");
                        oSettings.setProperty("/userName", oUser ? (oUser.userName || oUser.userId) : "");
                        oSettings.setProperty("/userInitials", oUser ? String(oUser.userId || "").substring(0, 2).toUpperCase() : "");
                        if (oUser) {
                                // 20261025：顶部欢迎卡片（按时段问候 + Lynx 动效），替换原 MessageToast
                                WelcomeToast.show({
                                        title: oRB.getText("welcomeTitle", [oRB.getText(WelcomeToast.greetingKey()), oUser.userName || oUser.userId]),
                                        sub: oRB.getText("welcomeSub")
                                });
                        }
                },

                /** 权限分流：管理员可维护，普通用户只读使用 */
                _syncAdminUi: function () {
                        var bAdmin = ChatService.isAdmin();
                        var oSettings = this.getView().getModel("settings");
                        oSettings.setProperty("/isAdmin", bAdmin);
                        // 角色管理入口仅管理员可见；泡泡的「＋新增」仅管理员可加
                        this.byId("roleMngHero").setVisible(bAdmin);
                        this.byId("roleMngDock").setVisible(bAdmin);
                        this._renderHeroBubbles();
                },

                /** 应用层登录框（丝滑版）：品牌徽标 + 账密 + 错误条 + 演示入口 */
                _openAppLogin: function (bExpired) {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        if (this._oAppLoginDialog) {
                                return;
                        }
                        this._iLoginFails = this._iLoginFails || 0;

                        var oUser = new sap.m.Input({
                                placeholder: oRB.getText("appLoginUserPh"),
                                maxLength: 60
                        }).addStyleClass("loginInput");
                        var oPass = new sap.m.Input({
                                placeholder: "••••••••",
                                type: "Password",
                                maxLength: 60
                        }).addStyleClass("loginInput");
                        var oErr = new sap.m.Text({ text: bExpired ? oRB.getText("loginExpired") : "", wrapping: true })
                                .addStyleClass("loginErr");

                        var fnSubmit = function () {
                                var sUser = (oUser.getValue() || "").trim();
                                var sPass = oPass.getValue() || "";
                                if (!sUser || !sPass) {
                                        oErr.setText(oRB.getText("loginErrEmpty"));
                                        return;
                                }
                                // 失败锁定（前端限速：5 次失败锁 60 秒，防弱口令撞库）
                                var iLockUntil = parseInt(window.localStorage.getItem("zaiChat.loginLockTs") || "0", 10);
                                if (Date.now() < iLockUntil) {
                                        oErr.setText(oRB.getText("loginErrLocked"));
                                        return;
                                }
                                oErr.setText("");
                                ChatService.appLogin(sUser, sPass).then(function (oUser2) {
                                        that._oAppLoginDialog.close();
                                        that._iLoginFails = 0;
                                        window.localStorage.removeItem("zaiChat.loginLockTs");
                                        if (oUser2.mustChangePwd) {
                                                that._forceChangePwd(oUser2);
                                        }
                                        that._afterAppLogin();
                                }).catch(function (e) {
                                        that._iLoginFails++;
                                        if (that._iLoginFails >= 5) {
                                                window.localStorage.setItem("zaiChat.loginLockTs", String(Date.now() + 60000));
                                                oErr.setText(oRB.getText("loginErrLocked"));
                                                return;
                                        }
                                        var sMsg = e.message === "bad" ? oRB.getText("loginErrBad")
                                                : e.message === "initGone" ? oRB.getText("loginErrInitGone")
                                                : (e.message && e.message.indexOf("srv:") === 0)
                                                        ? e.message.substring(4)
                                                        : oRB.getText("loginErrNoService");
                                        oErr.setText(sMsg);
                                });
                        };
                        oUser.attachChange(function () { oErr.setText(""); });
                        oPass.attachChange(function () { oErr.setText(""); });
                        oUser.onsapenter = fnSubmit;
                        oPass.onsapenter = fnSubmit;

                        var oVBox = new sap.m.VBox().addStyleClass("appLoginBody")
                                .addItem(new sap.m.HBox({ justifyContent: "Center" }).addStyleClass("appLoginChip")
                                        .addItem(new LingXiMark({ size: "56px" })))
                                .addItem(new sap.m.Title({
                                        level: "H2", text: oRB.getText("appLoginTitle"),
                                        textAlign: "Center", width: "100%"
                                }).addStyleClass("appLoginTitle"))
                                .addItem(new sap.m.Text({
                                        text: oRB.getText("appLoginSub"), wrapping: true,
                                        textAlign: "Center", width: "100%"
                                }).addStyleClass("appLoginSub"));
                        // 20261025：启动探测失败降级时，提示条放在登录卡片里（替代压在页面上的吐司）
                        if (this._bOfflineFallback) {
                                var oNotice = OfflineNotice.createInline(this._offlineNoticeTexts(true));
                                var oNoticeHost = new HTML({ content: '<div class="appLoginOffline"></div>', sanitizeContent: false });
                                oNoticeHost.addEventDelegate({
                                        onAfterRendering: function () {
                                                var oRef = oNoticeHost.getDomRef();
                                                if (oRef && oNotice.parentNode !== oRef) { oRef.appendChild(oNotice); }
                                        }
                                });
                                oVBox.addItem(oNoticeHost);
                        }
                        oVBox
                                .addItem(new sap.m.Label({ text: oRB.getText("appLoginUser") }).addStyleClass("loginLabel"))
                                .addItem(oUser)
                                .addItem(new sap.m.Label({ text: oRB.getText("appLoginPass") }).addStyleClass("loginLabel").addStyleClass("sapUiTinyMarginTop"))
                                .addItem(oPass)
                                .addItem(oErr)
                                .addItem(new sap.m.Button({
                                        text: oRB.getText("appLoginBtn"),
                                        type: "Emphasized",
                                        press: fnSubmit
                                }).addStyleClass("appLoginBtn"));

                        // 演示模式提供"演示身份进入"（USER 权限，仅本地体验用）
                        if (ChatService.getMode() === "mock") {
                                oVBox.addItem(new sap.m.HBox({ justifyContent: "Center" }).addStyleClass("appLoginDemo")
                                        .addItem(new sap.m.Button({
                                                text: oRB.getText("appLoginDemoLink"),
                                                type: "Transparent",
                                                press: function () {
                                                        ChatService._setAppUser({ userId: "DEMO", userName: oRB.getText("demoUserName"), role: "USER", mustChangePwd: false });
                                                        that._oAppLoginDialog.close();
                                                        that._afterAppLogin();
                                                }
                                        })));
                        }

                        // V16：不设对话框标题（品牌标题已在卡片内，原先头部与正文重复显示）
                        this._oAppLoginDialog = new sap.m.Dialog({
                                showHeader: false,   // 20261025：无标题时 UI5 仍画一条空标题栏，收掉
                                contentWidth: "22rem",
                                content: oVBox,
                                afterClose: function () { that._oAppLoginDialog.destroy(); that._oAppLoginDialog = null; }
                        }).addStyleClass("sapLoginDialog");
                        this._oAppLoginDialog.open();
                        setTimeout(function () { oUser.focus(); }, 400);
                },

                /** 初始管理员强制改密（仅本地初始化窗口；新密码 hash 存本浏览器） */
                _forceChangePwd: function (oUser) {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var oNew = new sap.m.Input({ type: "Password", placeholder: "••••••••" }).addStyleClass("loginInput");
                        var oAgain = new sap.m.Input({ type: "Password", placeholder: "••••••••" }).addStyleClass("loginInput");
                        var oErr = new sap.m.Text({ text: "", wrapping: true }).addStyleClass("loginErr");
                        var oDlg = new sap.m.Dialog({
                                title: oRB.getText("pwdChangeTitle"),
                                contentWidth: "20rem",
                                content: new sap.m.VBox().addStyleClass("appLoginBody")
                                        .addItem(new sap.m.Text({ text: oRB.getText("pwdChangeHint"), wrapping: true }).addStyleClass("hintText"))
                                        .addItem(new sap.m.Label({ text: oRB.getText("pwdChangeNew") }).addStyleClass("loginLabel"))
                                        .addItem(oNew)
                                        .addItem(new sap.m.Label({ text: oRB.getText("pwdChangeAgain") }).addStyleClass("loginLabel").addStyleClass("sapUiTinyMarginTop"))
                                        .addItem(oAgain)
                                        .addItem(oErr),
                                beginButton: new sap.m.Button({
                                        text: oRB.getText("save"),
                                        type: "Emphasized",
                                        press: function () {
                                                var s1 = oNew.getValue() || "", s2 = oAgain.getValue() || "";
                                                if (s1.length < 6) { oErr.setText(oRB.getText("pwdTooShort")); return; }
                                                if (s1 !== s2) { oErr.setText(oRB.getText("pwdMismatch")); return; }
                                                ChatService._sha256("zai#" + s1).then(function (sHash) {
                                                        window.localStorage.setItem("zaiChat.adminPwdHash", sHash);
                                                        oUser.mustChangePwd = false;
                                                        ChatService._setAppUser(oUser);
                                                        oDlg.close();
                                                        MessageToast.show(oRB.getText("pwdChangeOk"));
                                                });
                                        }
                                }),
                                afterClose: function () { oDlg.destroy(); }
                        });
                        oDlg.open();
                },

                /**
                 * 首次渲染后尝试绑定消息区滚动监听：
                 * 滚动超过 8px 时给顶栏加 .scrolled（毛玻璃 + 发丝线浮现）。
                 * 注意：hero 态下 chatScroll visible=false 无 DOM，
                 * 因此绑定必须支持重试（_scrollToBottom 内会再次调用）
                 */
                onAfterRendering: function () {
                        this._bindTopBarScroll();
                        this._bindCodeCopy();
                        this._bindImageActions();
                        this._bindDataActions();
                },

                /**
                 * V10：模型返回图片的事件委托（document 级，模式同 _bindCodeCopy）。
                 * ① 点击 .mdImg → 全屏 lightbox 查看，点击遮罩关闭；
                 * ② 图片加载完成（流式完成后 img 才真正发请求）自动滚到底部，
                 *    避免大图撑高后视窗停在半截。
                 */
                _bindImageActions: function () {
                        if (this._bImgActionsBound) {
                                return;
                        }
                        this._bImgActionsBound = true;
                        var that = this;
                        document.body.addEventListener("click", function (oEvent) {
                                // lightbox 打开态：点遮罩关闭
                                var oLb = document.querySelector(".imgLightbox");
                                if (oLb) {
                                        oLb.parentNode.removeChild(oLb);
                                        if (oEvent.target.closest(".imgLightbox")) {
                                                return;
                                        }
                                }
                                var oImg = oEvent.target && oEvent.target.closest ? oEvent.target.closest(".mdImg") : null;
                                if (oImg) {
                                        var oNew = document.createElement("div");
                                        oNew.className = "imgLightbox";
                                        var oClone = document.createElement("img");
                                        oClone.src = oImg.src;
                                        oNew.appendChild(oClone);
                                        document.body.appendChild(oNew);
                                }
                        }, true);
                        // 图片 load 不冒泡，用捕获阶段委托
                        document.addEventListener("load", function (oEvent) {
                                var oT = oEvent.target;
                                if (oT && oT.tagName === "IMG" && oT.classList && oT.classList.contains("mdImg")) {
                                        that._scrollToBottom();
                                }
                        }, true);
                },

                /**
                 * V5：代码块复制按钮的事件委托。
                 * Formatter 生成的每个代码块带原生 <button class="codeCopyBtn">，
                 * 流式期间 innerHTML 每帧重建，逐按钮挂监听不可行，故在 document 上统一委托。
                 */
                _bindCodeCopy: function () {
                        if (this._bCodeCopyBound) {
                                return;
                        }
                        this._bCodeCopyBound = true;
                        var that = this;
                        document.body.addEventListener("click", function (oEvent) {
                                var oBtn = oEvent.target && oEvent.target.closest ? oEvent.target.closest(".codeCopyBtn") : null;
                                if (!oBtn) {
                                        return;
                                }
                                var oWrap = oBtn.closest(".codeWrap");
                                var oCode = oWrap && oWrap.querySelector("pre code");
                                var sCode = (oCode ? (oCode.textContent || "") : "").replace(/\n+$/, "");
                                var fnDone = function () {
                                        oBtn.textContent = that._rb().getText("codeCopied");
                                        setTimeout(function () { oBtn.textContent = that._rb().getText("copy"); }, 1200);
                                };
                                if (navigator.clipboard && navigator.clipboard.writeText) {
                                        navigator.clipboard.writeText(sCode).then(fnDone).catch(function () {
                                                that._copyFallback(sCode, that.getView().getModel("i18n").getResourceBundle());
                                                fnDone();
                                        });
                                } else {
                                        that._copyFallback(sCode, that.getView().getModel("i18n").getResourceBundle());
                                        fnDone();
                                }
                        });
                },

                /**
                  * 绑定消息区 scroll → 顶栏 .scrolled + "回到底部"浮钮。
                  * V16 修复：hero ↔ 对话态切换会重建 chatScroll 的 DOM 节点，
                  * 旧实现用一次性 flag 绑定，节点重建后监听静默失效（顶栏
                  * 效果与浮钮双双失灵）；改为记录已绑定节点，节点变化即重绑。
                  */
                _bindTopBarScroll: function () {
                        var oScroll = this.byId("chatScroll");
                        var oDom = oScroll && oScroll.getDomRef();
                        if (!oDom || oDom === this._oScrollDom) {
                                return;
                        }
                        var oBar = this.getView().getDomRef().querySelector(".topBar");
                        if (!oBar) {
                                return;
                        }
                        this._oScrollDom = oDom;
                        var oChat = this.getView().getModel("chat");
                        oDom.addEventListener("scroll", function () {
                                oBar.classList.toggle("scrolled", oDom.scrollTop > 8);
                                // "回到底部"浮钮：离底部超过 320px 时出现（仅状态变化时写模型）
                                var bJump = oDom.scrollHeight - oDom.scrollTop - oDom.clientHeight > 320;
                                if (bJump !== oChat.getProperty("/jumpVisible")) {
                                        oChat.setProperty("/jumpVisible", bJump);
                                }
                        }, { passive: true });
                },

                /** V16：回到底部（平滑滚动） */
                onJumpBottom: function () {
                        var oScroll = this.byId("chatScroll");
                        var oDom = oScroll && oScroll.getDomRef();
                        if (oDom) {
                                oDom.scrollTo({ top: oDom.scrollHeight, behavior: "smooth" });
                        }
                },

                /** 生成 32 位会话 ID */
                _newSessionId: function () {
                        var sUuid = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, function () {
                                return Math.floor(Math.random() * 16).toString(16);
                        });
                        return sUuid;
                },

                /* =========================================================
                 * 模型列表 / 会话历史加载
                 * ========================================================= */

                _loadModels: function () {
                        var that = this;
                        var oChatModel = this.getView().getModel("chat");

                        ChatService.getModels().then(function (aModels) {
                                // 只使用管理员配置并启用的模型，不再注入 AUTO 虚拟项。
                                var aList = (aModels || []).filter(function (m) {
                                        return m.ModelId && m.ModelId.toUpperCase() !== "AUTO" && m.IsActive === "X";
                                }).map(function (m) {
                                        m.pickDesc = m.ModelDesc || m.ModelType || "";
                                        return m;
                                });
                                oChatModel.setProperty("/models", aList);
                                that._applySessionModel();
                                that._loadAgentModelRules();
                        }).catch(function (sErr) {
                                MessageToast.show(Formatter.escapeHtml(sErr || that._rb().getText("modelsLoadFail")));
                        });
                },

                /** 加载当前会话历史（后端模式从 OData 读取） */
                _loadHistory: function () {
                        var oCtx = this.getView().getModel("chat").getProperty("/currentSession") || {};
                        if (!oCtx.id) { return; }
                        return this._readSessionHistory(oCtx.id, oCtx.mode === "AGENT").catch(function (sErr) {
                                console.warn("[ChatService] 历史加载失败: " + sErr);
                        });
                },

                /* =========================================================
                 * 发送消息（V12：按会话模式分流）
                 * ========================================================= */

                /**
                  * 发送按钮 / 回车
                  * V12：onSend 只负责收集输入、判断当前会话类型并调用分流方法
                  * （_sendChatMessage / _sendAgentTask）；会话 Mode 是最终依据，
                  * 不再用一个布尔开关承担全部模式逻辑。
                  * V5：响应期间发送键保持可点 —— 点击 = 停止生成；回车防抖
                  */
                onSend: function (oEvent) {
                        var oChatModel = this.getView().getModel("chat");
                        var sText = (oChatModel.getProperty("/input") || "").trim();

                        // ---------- V5：忙碌中的发送键点击 = 停止生成（回车不触发） ----------
                        if (oChatModel.getProperty("/busy")) {
                                var oSrc = oEvent && oEvent.getSource && oEvent.getSource();
                                if (oSrc && oSrc === this.byId("sendBtn")) {
                                        this.onStopGenerate();
                                }
                                return;
                        }

                        if (!sText) {
                                return;
                        }

                        // ---------- V12/V13：按当前会话模式分流 ----------
                        var oCtx = oChatModel.getProperty("/currentSession") || {};
                        if (oCtx.mode === "AGENT") {
                                if (!this._skillSendReady()) { return; }
                                if (/^\/[^\n]*$/.test(sText) && this._skillModel().getProperty("/canPick")) {
                                        this._openSkills(this.byId(oChatModel.getProperty("/heroVisible") ? "heroInput" : "msgInput"), true);
                                        return;
                                }
                                this._flySendPlane();
                                this._sendAgentMessage(sText);
                        } else {
                                this._flySendPlane();
                                this._sendChatMessage(sText);
                        }
                },

                /**
                 * 20261025：发送时纸飞机从发送键飞出去。飞的是浮在页面最上层的一架"影子"飞机
                 * （复制发送键的图标），按钮本身照常切成停止键；回复结束时飞机再落回按钮（_setSendBtnBusy）
                 */
                _flySendPlane: function () {
                        if (typeof document === "undefined") {
                                return;
                        }
                        var bHero = this.getView().getModel("chat").getProperty("/heroVisible");
                        var oBtn = this.byId(bHero ? "sendBtnHero" : "sendBtn");
                        var oIcon = oBtn && oBtn.getDomRef() && oBtn.getDomRef().querySelector(".sapMBtnIcon");
                        var r = oIcon && oIcon.getBoundingClientRect();
                        if (!r || !r.width) {
                                return;
                        }
                        var oGhost = oIcon.cloneNode(true);
                        oGhost.removeAttribute("id");
                        oGhost.setAttribute("aria-hidden", "true");
                        oGhost.classList.add("sendPlaneGhost");
                        oGhost.style.left = r.left + "px";
                        oGhost.style.top = r.top + "px";
                        oGhost.style.width = r.width + "px";
                        oGhost.style.height = r.height + "px";
                        oGhost.style.fontSize = window.getComputedStyle(oIcon).fontSize;
                        document.body.appendChild(oGhost);
                        setTimeout(function () {
                                if (oGhost.parentNode) {
                                        oGhost.parentNode.removeChild(oGhost);
                                }
                        }, 800);
                },

                /**
                  * V12：对话模式发送 —— 角色前缀与附件块拼入提问（原有行为），
                  * 后端走 AnalyzeCode
                  */
                _sendChatMessage: function (sText) {
                        var oChatModel = this.getView().getModel("chat");
                        var oRB = this._rb();
                        var sRole = oChatModel.getProperty("/currentRole") || "";
                        var sMeta = sRole ? oRB.getText("rolePrefix") + sRole : "";
                        var oAtt = this._oAttachment;
                        if (oAtt) {
                                sMeta = (sMeta ? sMeta + " · " : "") +
                                        oRB.getText("attachMeta", [oAtt.name, oAtt.sizeText]);
                        }
                        this._executeSend({
                                mode: "CHAT",
                                displayText: sText,
                                meta: sMeta,
                                // V5.4：角色前缀；V9.3：附件内容块（模型可见，气泡显示原文）
                                question: (sRole ? "【角色：" + sRole + "】\n" + sText : sText) +
                                        (oAtt ? oAtt.block : "")
                        });
                },

                /**
                  * V13：Agent 消息发送 —— 连续对话语义（不再是单次任务）。
                  * 不携带角色前缀；文本附件作为任务上下文拼入提问（不是工具指令）
                  */
                _sendAgentMessage: function (sText) {
                        var oChatModel = this.getView().getModel("chat");
                        var oRB = this._rb();
                        var oCtx = oChatModel.getProperty("/currentSession") || {};
                        var oAtt = this._oAttachment;
                        var sMeta = "";
                        if (oAtt) {
                                sMeta = oRB.getText("attachMeta", [oAtt.name, oAtt.sizeText]);
                        }
                        var oSkill = this._skillModel().getProperty("/selected");
                        if (oSkill) { sMeta = (sMeta ? sMeta + " · " : "") + "技能：" + oSkill.name + " v" + oSkill.version; }
                        this._executeSend({
                                mode: "AGENT",
                                agentType: oCtx.agentType || "",
                                displayText: sText,
                                meta: sMeta,
                                question: sText + (oAtt ? oAtt.block : "")
                        });
                },

                /**
                  * V12：两种模式共用的发送执行体（原 onSend 主体）：
                  * 用户气泡 → 占位 → ChatService.sendByMode → 流式渲染 →
                  * Agent 附 Trace 与任务状态回写
                  * @param {object} oCfg {mode, agentType, displayText, meta, question}
                  */
                _executeSend: function (oCfg) {
                        var oChatModel = this.getView().getModel("chat");
                        var oRB = this._rb();
                        var bAgent = oCfg.mode === "AGENT";
                        var that = this;

                        // ---------- 会话上下文兜底（正常路径已在创建/恢复时建立） ----------
                        var oCtx = oChatModel.getProperty("/currentSession") || {};
                        var sSessionId = oCtx.id;
                        if (!sSessionId) {
                                sSessionId = this._newSessionId();
                                this._setSessionContext({
                                        id: sSessionId,
                                        mode: oCfg.mode,
                                        agentType: oCfg.agentType || "",
                                        status: bAgent ? "RUNNING" : "IDLE"
                                });
                        }

                        // 空模型 ID 同样会触发后端自动路由，必须先确定具体模型再提交。
                        this._syncModelList();
                        var sModelId = oChatModel.getProperty("/currentModel");
                        if (!sModelId) {
                                MessageToast.show(oRB.getText("modelPickEmpty"));
                                return;
                        }

                        var sText = oCfg.displayText;
                        this._rememberSessionModel(sSessionId, sModelId);   // 20261020：这个会话以后打开还用这个模型

                        // 确保左侧历史列表出现当前会话（Agent 任务置进行中）
                        this._ensureSessionEntry(sSessionId, sText, oCfg.mode,
                                oCfg.agentType, bAgent ? "RUNNING" : "IDLE");

                        // ---------- 空状态 → 对话/任务态 ----------
                        this._setViewLayout(true);

                        // ---------- 推入用户消息（V13：Agent 也是普通聊天气泡，不标任务目标） ----------
                        // 20261025：记下发给后端的原文（「重新生成」用）和发送时刻（新气泡升起动效用）
                        var oUserEntry = this._buildEntry("user", sText, "", oCfg.meta);
                        oUserEntry.question = oCfg.question;
                        oUserEntry.sentAt = Date.now();
                        oChatModel.getProperty("/messages").push(oUserEntry);
                        // V16：卡片联动的后续消息（选项/自由输入）不清空用户正在写的草稿
                        if (!oCfg.keepInput) {
                                oChatModel.setProperty("/input", "");
                                this._clearAttachment();   // 附件已拼入本次提问（两模式均消费）
                        }
                        this._refreshMessages();
                        this._scrollToBottom();

                        // ---------- 推入 AI 占位气泡 ----------
                        // CHAT：标题行 headThinking 动画；AGENT：正文区先渲染思考状态卡
                        // （同步接口无法推送阶段事件，等待期轮换展示阶段文案；响应到达后
                        //   用后端返回的真实阶段摘要替换 —— 计划 §6.4 首期方案）
                        var oPending = this._buildEntry("assistant", "", "", "");
                        oPending.time = "";
                        oPending.html = "";
                        oPending.streaming = true;
                        oPending.waiting = true;          // V16：等待计时（两模式通用）
                        oPending.elapsedText = "";
                        if (bAgent) {
                                oPending.sender = oRB.getText("agentSender");
                                oPending.agentThinking = true;
                                oPending.requestPending = true;
                                oPending.thinkingLabel = oRB.getText("agentPhaseUnderstand");
                        }
                        var iAssistantIdx = oChatModel.getProperty("/messages").length;
                        oChatModel.getProperty("/messages").push(oPending);
                        this._refreshMessages();
                        this._scrollToBottom();

                        // V13/V16：等待期计时 + 阶段文案轮换（仅视觉状态，不代表已执行；
                        // 真实过程以后端 TraceJson 为准）
                        this._startThinkingTicker(iAssistantIdx, bAgent);

                        // ---------- 调用服务（V12 统一入口，按模式路由） ----------
                        oChatModel.setProperty("/busy", true);
                        this._setSendBtnBusy(true);
                        this._syncActivity();

                        // V5：本轮发送令牌 —— 停止生成时记录到 _sAbortToken，
                        // 迟到的后端响应据此丢弃（后端仍会存库，列表照常刷新）
                        var sSendToken = this._newSessionId();
                        this._sStreamToken = sSendToken;
                        this._sAbortToken = "";

                        // 本轮拥有当前消息和动画时才允许收尾，迟到响应不能影响下一轮。
                        var fnIsCurrent = function () {
                                var oNow = oChatModel.getProperty("/currentSession") || {};
                                return that._sStreamToken === sSendToken && oNow.id === sSessionId;
                        };

                        /** 出错：移除占位气泡，替换为错误消息 */
                        var fnSetError = function (sMsg) {
                                var aMsgs = oChatModel.getProperty("/messages");
                                if (bAgent && aMsgs[iAssistantIdx]) {
                                        var sPath = "/messages/" + iAssistantIdx;
                                        var oErrorEntry = that._buildEntry("assistant", sMsg, "", "");
                                        oChatModel.setProperty(sPath + "/raw", oErrorEntry.raw);
                                        oChatModel.setProperty(sPath + "/html", oErrorEntry.html);
                                        oChatModel.setProperty(sPath + "/time", oErrorEntry.time);
                                        oChatModel.setProperty(sPath + "/streaming", false);
                                        oChatModel.setProperty(sPath + "/waiting", false);
                                        that._attachAgentProcess(iAssistantIdx, { status: "ERROR", traceValid: false });
                                        // 正文 HTML 与普通流式渲染一样直接同步到已有控件。
                                        var oBody = that._findMsgBodyCtrl(iAssistantIdx);
                                        if (oBody) {
                                                oBody.setContent('<div class="bubbleBody" data-uid="' + aMsgs[iAssistantIdx].uid + '">' +
                                                        oErrorEntry.html + "</div>");
                                        }
                                        return;
                                }
                                if (aMsgs[iAssistantIdx] && aMsgs[iAssistantIdx].streaming) {
                                        aMsgs.splice(iAssistantIdx, 1);
                                        that._pushEntry("error", sMsg, "");
                                        that._refreshMessages();
                                }
                        };

                        /** 收尾：解除忙碌、吸底、刷新会话列表 */
                        var fnFinish = function () {
                                if (!fnIsCurrent()) {
                                        return;
                                }
                                that._stopThinkingTicker();
                                oChatModel.setProperty("/busy", false);
                                that._setSendBtnBusy(false);
                                that._syncActivity();
                                that._refreshMessages();
                                // 参数卡接在已完成的说明后面，保留阅读位置，避免大表单把正文顶走。
                                var oFinishedEntry = (oChatModel.getProperty("/messages") || [])[iAssistantIdx];
                                if (!oFinishedEntry || !oFinishedEntry.ask || oFinishedEntry.ask.kind !== "params") {
                                        that._scrollToBottom();
                                }
                                // 历史重渲染后兜底再做一次代码高亮
                                setTimeout(function () {
                                        that._highlightCodeBlocks();
                                }, 120);
                                // 后端已记录会话头，刷新左侧列表（含消息数/时间/任务状态）
                                that._refreshSessions();
                        };

                        // V15：Agent 模式走 AnalyzeTask（携带当前 TaskId 与本轮
                        // ClientRequestId）；后端无新接口时 ChatService 内部
                        // 自动回退旧 AnalyzeAgent，调用方无感
                        var oCurTask = oChatModel.getProperty("/currentTask") || {};
                        // 20261028：本轮编号同时用来查运行进度（边跑边看，_startLive）
                        var sCid = bAgent ? this._newSessionId() : "";
                        var pReq = ChatService.sendByMode({
                                mode: oCfg.mode,
                                agentType: oCfg.agentType,
                                sessionId: sSessionId,
                                question: oCfg.question,
                                modelId: sModelId,
                                taskId: bAgent ? (oCurTask.taskId || "") : "",
                                clientRequestId: sCid,
                                // 20261011：本会话最近就绪的报表结果，供"分析一下这个结果"（后端校验归属/状态）
                                focusedArtifactId: bAgent ? ((this._mFocusArt || {})[sSessionId] || "") : "",
                                // 20261011：会话场景（新会话首条消息写入后端，之后以后端为准）
                                scene: bAgent ? this._normScene(oCfg.agentType) : "",
                                skillId: bAgent ? this._skillRequestId() : ""
                        });
                        if (bAgent) {
                                this._startLive(oPending, sCid, sSessionId);
                        }

                        return pReq.then(function (oRes) {
                                // V5：响应到达前用户已停止 → 丢弃本次回复（后端已存库）
                                if (!fnIsCurrent()) {
                                        that._refreshSessions();
                                        return;
                                }
                                that._stopThinkingTicker();
                                if (bAgent) {
                                        that._endLive(oPending.uid, oRes && oRes.status === "ERROR" ? "error" : "ok");
                                }
                                oChatModel.setProperty("/messages/" + iAssistantIdx + "/waiting", false);
                                if (!bAgent && oRes.status === "ERROR") {
                                        fnSetError(oRes.message || oRB.getText("errServiceReturned"));
                                        fnFinish();
                                } else {
                                        // V11~V13：Agent 的 TIMEOUT/DENIED/ERROR 已由后端护栏生成
                                        // 可读降级文案（不含原始堆栈），按正常回答渲染并附过程摘要
                                        // V16：对话模式也标注耗时（后端 ElapsedMs）
                                        var sDoneMeta = bAgent ? that._agentMeta(oRes)
                                                : (oRes.elapsedMs ? oRB.getText("chatElapsed", [(oRes.elapsedMs / 1000).toFixed(1)]) : "");
                                        if (bAgent) {
                                                // HTTP 已结束：立即收口，空/坏 Trace 也不能继续显示正在执行。
                                                that._attachAgentProcess(iAssistantIdx, oRes);
                                                that._updateAgentSessionStatus(sSessionId, oRes.status);
                                                // V15/V16：任务徽标回写；待填参数挂到本条回复的内联卡片
                                                that._updateTaskState(oRes, sSessionId, iAssistantIdx);
                                        }
                                        var sAnswer = oRes.answer || oRes.message || oRB.getText("emptyAnswer");
                                        return that._streamAnswer(iAssistantIdx, sAnswer, sDoneMeta, sSendToken)
                                                .then(function () {
                                                        fnFinish();
                                                        // V16：参数卡 / 意图澄清卡（流式完成后出现，与回答联动）
                                                        if (fnIsCurrent()) {
                                                                that._attachAskCard(iAssistantIdx, sAnswer, oRes, sSessionId);
                                                        }
                                                });
                                }
                        }).catch(function (oErr) {
                                if (!fnIsCurrent()) {
                                        that._refreshSessions();
                                        return;
                                }
                                that._stopThinkingTicker();
                                if (bAgent) {
                                        that._endLive(oPending.uid, "error");
                                }
                                fnSetError((oErr && oErr.message) || String(oErr));
                                if (bAgent) {
                                        that._updateAgentSessionStatus(sSessionId, "ERROR");
                                }
                                fnFinish();
                        });
                },

                /* =========================================================
                 * V13：Agent 思考状态与过程摘要
                 * 同步 OData 无法推送实时阶段事件（计划 §6.4）：等待期由
                 * _startThinkingTicker 轮换展示阶段文案；响应完成后用后端
                 * 返回的真实 TraceJson（阶段摘要）替换 —— 只展示阶段/友好
                 * 工具名/状态/耗时；动态 SQL 只在用户主动展开时展示已校验语句，
                 * 不展示思维链、Prompt 或密钥
                 * ========================================================= */

                /**
                  * 等待期计时（V16：两模式通用，每秒刷新"已用 N 秒"）；
                  * Agent 额外每 3 秒轮换阶段文案（纯视觉状态；真实过程以 TraceJson 为准）
                  */
                _startThinkingTicker: function (iIndex, bAgent) {
                        var that = this;
                        this._stopThinkingTicker();
                        var aPhases = ["agentPhaseUnderstand", "agentPhasePlan", "agentPhaseTools",
                                "agentPhaseExecute", "agentPhaseCompose"];
                        var iPos = 0, iTick = 0, iStart = Date.now();
                        var oChatModel = this.getView().getModel("chat");
                        this._iThinkTimer = window.setInterval(function () {
                                // 会话/条目已切换、已停止或首帧正文已到 → 静默终止
                                var aMsgs = oChatModel.getProperty("/messages");
                                var oE = aMsgs && aMsgs[iIndex];
                                if (!oE || !oE.waiting || (!bAgent && oE.raw)) {
                                        that._stopThinkingTicker();
                                        return;
                                }
                                var sPath = "/messages/" + iIndex;
                                oChatModel.setProperty(sPath + "/elapsedText",
                                        that._rb().getText("waitElapsed", [Math.round((Date.now() - iStart) / 1000)]));
                                // 20261028：拿到真实步骤后不再轮换固定文案（标题跟着当前步骤走，见 _applyLive）
                                if (bAgent && ++iTick % 3 === 0 && !(oE.liveSteps && oE.liveSteps.length)) {
                                        iPos = (iPos + 1) % aPhases.length;
                                        oChatModel.setProperty(sPath + "/thinkingLabel", that._rb().getText(aPhases[iPos]));
                                }
                        }, 1000);
                },

                /** V16：顶栏运行指示（对话生成 / Agent 运行 / 报表后台执行） */
                _syncActivity: function () {
                        var oChat = this.getView().getModel("chat");
                        var oRB = this._rb();
                        var s = "";
                        var bBusy = !!oChat.getProperty("/busy");
                        var bReportRunning = Object.keys(this._mRuns || {}).some(function (k) { return !!this._mRuns[k].timer; }, this);
                        var bStreaming = (oChat.getProperty("/messages") || []).some(function (m) {
                                return m.role === "assistant" && m.streaming && !m.waiting && !m.requestPending && !m.avatarStopped;
                        });
                        if (bBusy) {
                                s = oRB.getText((oChat.getProperty("/currentSession") || {}).mode === "AGENT"
                                        ? "activityAgent" : "activityChat");
                        } else if (bReportRunning) {
                                s = oRB.getText("activityReport");
                        }
                        oChat.setProperty("/activityText", s);
                        oChat.setProperty("/logoState", LingXiState.activity(bBusy, bReportRunning, bStreaming));
                },

                _stopThinkingTicker: function () {
                        if (this._iThinkTimer) {
                                window.clearInterval(this._iThinkTimer);
                                this._iThinkTimer = null;
                        }
                },

                /* =========================================================
                 * 20261028：Agent「边跑边看」—— 回复返回之前，每 0.7～1.5 秒按本轮 ClientRequestId
                 * 查一次运行进度（ChatService.getAgentProgress），把已经走完 / 正在走的步骤画进思考卡：
                 * 模型调工具前的一句话、工具和关键参数、结果行数与耗时、前几行预览、已校验 SQL。
                 * 后端还没有 AgentProgress 时不轮询，思考卡照旧显示阶段文案。
                 * 步骤画成一段 HTML（liveHtml，同 runHtml / extraHtml 的做法）；内容不变不重绘，
                 * 新出现的步骤和刚完成的步骤各播一次小动效，展开过的 SQL 重绘后保持展开。
                 * ========================================================= */

                LIVE_POLL_MS: [700, 1000, 1500],

                _startLive: function (oEntry, sCid, sSid) {
                        var that = this;
                        if (!sCid || !ChatService.supportsAgentProgress || !ChatService.supportsAgentProgress()) {
                                return;
                        }
                        this._mLive = this._mLive || {};
                        this._bindLiveToggle();
                        var oLive = this._mLive[oEntry.uid] = { cid: sCid, sid: sSid, timer: 0, stopped: false, fails: 0, n: 0, seen: {} };
                        var fnPoll = function () {
                                if (oLive.stopped) {
                                        return;
                                }
                                ChatService.getAgentProgress(sCid).then(function (o) {
                                        if (oLive.stopped) {
                                                return;
                                        }
                                        oLive.fails = 0;
                                        that._applyLive(oEntry.uid, (o && o.steps) || [], false);
                                        if (o && o.status === "DONE") {
                                                return;   // 后端已走完，等回复本身到达即可
                                        }
                                        fnNext();
                                }).catch(function () {
                                        if (++oLive.fails >= 3) {
                                                oLive.stopped = true;   // 连续失败就放弃，思考卡退回阶段文案
                                                return;
                                        }
                                        fnNext();
                                });
                        };
                        var fnNext = function () {
                                var a = that.LIVE_POLL_MS;
                                oLive.n++;
                                oLive.timer = setTimeout(fnPoll, oLive.n < 8 ? a[0] : oLive.n < 20 ? a[1] : a[2]);
                        };
                        oLive.timer = setTimeout(fnPoll, 350);
                },

                /**
                 * 回复到达 / 出错 / 停止：不再轮询；正常结束时再取一次进度补齐最后一步，
                 * 还挂着「进行中」的步骤按结局收口（完成 / 失败 / 已停止）
                 */
                _endLive: function (sUid, sHow) {
                        var that = this;
                        var oLive = this._mLive && this._mLive[sUid];
                        if (!oLive) {
                                return;
                        }
                        oLive.stopped = true;
                        clearTimeout(oLive.timer);
                        delete this._mLive[sUid];
                        var fnClose = function (aSteps) {
                                var oHit = that._entryByUid(sUid, oLive.sid);
                                var aBase = aSteps && aSteps.length ? aSteps : ((oHit && oHit.entry.liveSteps) || []);
                                if (!aBase.length) {
                                        return;
                                }
                                var sEnd = sHow === "ok" ? "OK" : sHow === "stopped" ? "STOPPED" : "ERROR";
                                that._applyLive(sUid, aBase.map(function (st) {
                                        return String(st.status || "").toUpperCase() === "RUNNING" ? Object.assign({}, st, { status: sEnd }) : st;
                                }), true, oLive);
                        };
                        if (sHow === "ok") {
                                ChatService.getAgentProgress(oLive.cid).then(function (o) {
                                        fnClose((o && o.steps) || null);
                                }).catch(function () { fnClose(null); });
                        } else {
                                fnClose(null);
                        }
                },

                /** 把一份步骤写进消息条目（当前会话直接走模型绑定；切走的会话只改缓存） */
                _applyLive: function (sUid, aSteps, bFinal, oLiveArg) {
                        var oLive = oLiveArg || (this._mLive && this._mLive[sUid]);
                        if (!oLive) {
                                return;
                        }
                        var oHit = this._entryByUid(sUid, oLive.sid);
                        if (!oHit) {
                                return;
                        }
                        var oEntry = oHit.entry;
                        var aShow = (aSteps || []).filter(function (st) { return st && st.phase !== "TOOL_DECISION"; });
                        if (!aShow.length) {
                                return;
                        }
                        var sHtml = this._liveHtml(sUid, aShow, oLive.seen);
                        aShow.forEach(function (st) { oLive.seen[String(st.seq)] = String(st.status || "RUNNING").toUpperCase(); });
                        var oRun = null;
                        aShow.forEach(function (st) {
                                if (String(st.status || "").toUpperCase() === "RUNNING") { oRun = st; }
                        });
                        var oChat = this.getView().getModel("chat");
                        var bShown = this._sMessagesSession === oLive.sid && (oChat.getProperty("/messages") || [])[oHit.index] === oEntry;
                        var bNear = bShown && this._isNearBottom();
                        oEntry.liveSteps = aShow;
                        var mSet = { liveHtml: sHtml };
                        if (!bFinal && oRun) {
                                mSet.thinkingLabel = (oRun.toolLabel ? oRun.toolLabel + " · " : "") + (oRun.label || "") + "…";
                        }
                        Object.keys(mSet).forEach(function (k) {
                                if (oEntry[k] === mSet[k]) {
                                        return;
                                }
                                if (bShown) {
                                        oChat.setProperty("/messages/" + oHit.index + "/" + k, mSet[k]);
                                } else {
                                        oEntry[k] = mSet[k];
                                }
                        });
                        if (bNear && !bFinal) {
                                this._scrollToBottom();
                        }
                },

                /** 步骤列表 HTML（所有文字先转义，标签由这里构造） */
                _liveHtml: function (sUid, aSteps, mSeen) {
                        var esc = Formatter.escapeHtml;
                        var mOpen = this._mLiveOpen || {};
                        var sCheck = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                        var sNote = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
                        var mBad = { REJECTED: "被拒，已自动调整", ERROR: "失败", DENIED: "无权限", STOPPED: "已停止" };
                        var fnSec = function (ms) {
                                return ms >= 50 ? (ms / 1000).toFixed(1) + " 秒" : "";
                        };
                        var fnNum = function (v) { return /^[-+]?[\d,]+(\.\d+)?%?$/.test(String(v).trim()); };
                        var s = '<div class="lvSteps" data-live-uid="' + esc(sUid) + '">';
                        aSteps.forEach(function (st) {
                                var sSeq = String(st.seq);
                                var sSt = String(st.status || "RUNNING").toUpperCase();
                                var bRun = sSt === "RUNNING";
                                var bBad = !!mBad[sSt];
                                var bNote = st.phase === "NOTE";
                                var bTool = st.phase === "EXECUTING";
                                var sPrev = mSeen[sSeq];
                                var sCls = "lvStep " + (bNote ? "lvNote" : bTool ? "lvTool" : "lvPhase") +
                                        (bRun ? " is-run" : sSt === "STOPPED" ? " is-stop" : bBad ? " is-bad" : " is-ok") +
                                        (sPrev === undefined ? " is-new" : sPrev === "RUNNING" && !bRun ? " is-done" : "");
                                var sDot = bNote ? sNote : bRun ? '<i class="lvSpin"></i>' : bBad ? "!" : sCheck;
                                s += '<div class="' + sCls + '" data-seq="' + esc(sSeq) + '"><span class="lvDot">' + sDot + '</span><div class="lvMain">';
                                if (bNote) {
                                        s += '<div class="lvSay">' + esc(st.label || "") + "</div></div></div>";
                                        return;
                                }
                                var aRes = [];
                                if (bRun) {
                                        aRes.push(bTool ? "进行中…" : "…");
                                } else if (bBad) {
                                        aRes.push(mBad[sSt]);
                                } else {
                                        if (bTool && st.rows !== null && st.rows !== undefined && st.rows !== "") {
                                                aRes.push(st.rows + " 行");
                                        }
                                        var sT = fnSec(parseInt(st.elapsedMs, 10) || 0);
                                        if (sT) {
                                                aRes.push(sT);
                                        }
                                }
                                s += '<div class="lvLine">' + (st.toolLabel ? '<span class="lvTn">' + esc(st.toolLabel) + "</span>" : "") +
                                        '<span class="lvLab">' + esc(st.label || "") + "</span>" +
                                        '<span class="lvRes">' + esc(aRes.join(" · ")) + "</span></div>";
                                var aArgs = Array.isArray(st.args) ? st.args : [];
                                if (aArgs.length) {
                                        s += '<div class="lvArgs">' + aArgs.slice(0, 6).map(function (kv) {
                                                var a = Array.isArray(kv) ? kv : [kv && kv.k, kv && kv.v];
                                                return '<span class="lvChip"><span class="lvChipK">' + esc(a[0] || "") + "</span>" + esc(a[1] === undefined ? "" : a[1]) + "</span>";
                                        }).join("") + "</div>";
                                }
                                var oPv = !bRun && st.preview && Array.isArray(st.preview.columns) && Array.isArray(st.preview.rows) ? st.preview : null;
                                if (oPv && oPv.rows.length) {
                                        var aCols = oPv.columns.slice(0, 5);
                                        s += '<table class="lvPrev"><thead><tr>' + aCols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") +
                                                "</tr></thead><tbody>" + oPv.rows.slice(0, 3).map(function (r) {
                                                        return "<tr>" + aCols.map(function (_, i) {
                                                                var v = Array.isArray(r) ? r[i] : "";
                                                                return "<td" + (fnNum(v) ? ' class="num"' : "") + ">" + esc(v === null || v === undefined ? "" : v) + "</td>";
                                                        }).join("") + "</tr>";
                                                }).join("") + "</tbody></table>";
                                }
                                if (!bRun && st.detail) {
                                        // 20261028：只有 SQL 才叫「查看 SQL」；模型切换、协议重写等步骤的说明叫「查看详情」
                                        var bSql = /^\s*(SELECT|WITH)\b/i.test(String(st.detail));
                                        s += '<details class="lvMore" data-seq="' + esc(sSeq) + '"' + (mOpen[sUid + ":" + sSeq] ? " open" : "") +
                                                '><summary>' + (bSql ? "查看 SQL" : "查看详情") + '</summary><pre class="lvSql">' + esc(st.detail) + "</pre></details>";
                                }
                                s += "</div></div>";
                        });
                        return s + "</div>";
                },

                /** 记住展开过的「查看 SQL」，步骤重绘后保持展开（toggle 不冒泡，用捕获） */
                _bindLiveToggle: function () {
                        if (this._bLiveToggle || typeof document === "undefined") {
                                return;
                        }
                        this._bLiveToggle = true;
                        var that = this;
                        document.addEventListener("toggle", function (e) {
                                var d = e.target;
                                if (!d || !d.classList || !d.classList.contains("lvMore")) {
                                        return;
                                }
                                var oRoot = d.closest("[data-live-uid]");
                                if (oRoot) {
                                        that._mLiveOpen = that._mLiveOpen || {};
                                        that._mLiveOpen[oRoot.getAttribute("data-live-uid") + ":" + d.getAttribute("data-seq")] = d.open;
                                }
                        }, true);
                },

                /**
                  * AGENT_TRACE_FINISH_V1：响应/错误统一收口，按消息绑定完成态。
                  * UI5 同长度列表会复用控件；更新绑定属性，不能依赖工厂重新执行。
                  * V1.3：同时携带数据分析结构化结果（analysis），由工厂渲染
                  * 数据集表格与 SVG 图表（见 _buildAnalysisHtml）。
                  * @param {int} iIndex 消息下标
                  * @param {object} oRes ChatService.sendAgent 的返回（trace/elapsedMs/analysis）
                  */
                _attachAgentProcess: function (iIndex, oRes) {
                        var oChatModel = this.getView().getModel("chat");
                        var aMsgs = oChatModel.getProperty("/messages");
                        var oOld = aMsgs && aMsgs[iIndex];
                        if (!oOld) {
                                return;
                        }
                        var oFinished = TraceService.finish(oRes);
                        oFinished.title = this._agentMeta(oRes, true);
                        oFinished.hasPhases = oFinished.phases.length > 0;
                        // V16：每步耗时条（相对本轮最长一步的占比）
                        var iMaxMs = 0;
                        oFinished.phases.forEach(function (p) { iMaxMs = Math.max(iMaxMs, p.elapsedMs || 0); });
                        oFinished.phases.forEach(function (p) {
                                p.pct = iMaxMs > 0 && p.elapsedMs ? Math.max(4, Math.round(p.elapsedMs / iMaxMs * 100)) : 0;
                        });
                        var sPath = "/messages/" + iIndex;
                        oChatModel.setProperty(sPath + "/waiting", false);
                        oChatModel.setProperty(sPath + "/agentThinking", false);
                        oChatModel.setProperty(sPath + "/requestPending", false);
                        oChatModel.setProperty(sPath + "/thinkingLabel", "");
                        oChatModel.setProperty(sPath + "/thinking", oFinished);
                        oChatModel.setProperty(sPath + "/meta", this._agentMeta(oRes));
                        oChatModel.setProperty(sPath + "/skillTag", this._skillTagOf(oFinished));
                        // V1.3：数据分析结果（ChatService._sanitizeAnalysis 已复核，
                        // 无数据分析路径时为 null，不影响普通 Agent 回答）
                        // V16：只渲染数据表 + 工具条，图表由用户点"生成图表"自行选择
                        oChatModel.setProperty(sPath + "/analysis", oRes.analysis || null);
                        oChatModel.setProperty(sPath + "/extraHtml", this._extraHtml(oOld));
                },

                /* =========================================================
                 * V1.3：数据分析结果渲染（数据集表格 + 原生 SVG 图表）
                 * 安全模型与 Formatter.markdownToHtml 相同：所有动态文本先
                 * escapeHtml，所有标签由本文件构造；图表用原生 SVG 生成，
                 * 不引入任何外部图表依赖，不执行模型返回的 HTML/JS（计划 §10/§12）
                 * ========================================================= */

                /**
                 * 构造数据分析结果 HTML（summary/findings/datasets/charts）
                 * @param {object} oAnalysis ChatService._sanitizeAnalysis 的输出
                 * @param {object} [oEntry] 消息条目（20261011：用户图表紧跟在对应数据集表格下方）
                 * @returns {string} HTML；无有效内容时返回空串
                 */
                _buildAnalysisHtml: function (oAnalysis, oEntry) {
                        if (!oAnalysis) {
                                return "";
                        }
                        var that = this;
                        var oRB = this._rb();
                        var esc = Formatter.escapeHtml;
                        var aDs = oAnalysis.datasets || [];
                        var aCharts = oAnalysis.charts || [];
                        var bAny = oAnalysis.summary ||
                                (oAnalysis.findings && oAnalysis.findings.length) ||
                                aDs.length || aCharts.length;
                        if (!bAny) {
                                return "";
                        }

                        var s = '<div class="analysisBlock">';
                        if (oAnalysis.summary) {
                                s += '<div class="analysisSummary">' + esc(oAnalysis.summary) + "</div>";
                        }

                        // 发现（severity: info/warn/error）
                        if (oAnalysis.findings && oAnalysis.findings.length) {
                                s += '<div class="analysisFindings">';
                                oAnalysis.findings.forEach(function (f) {
                                        var sSev = ["info", "warn", "error"].indexOf(f.severity) >= 0 ? f.severity : "info";
                                        var sGlyph = sSev === "error" ? "✕" : (sSev === "warn" ? "⚠" : "✓");
                                        s += '<div class="analysisFinding sev-' + sSev + '">' +
                                                '<span class="findingGlyph">' + sGlyph + "</span>" +
                                                '<span class="findingTitle">' + esc(f.title) + "</span>" +
                                                (f.detail ? '<span class="findingDetail">' + esc(f.detail) + "</span>" : "") +
                                                "</div>";
                                });
                                s += "</div>";
                        }

                        // 数据集（表格 / 查询失败 / 空数据提示）
                        aDs.forEach(function (oDs, iDs) {
                                s += '<div class="analysisDs">';
                                if (oDs.status !== "OK") {
                                        s += '<div class="analysisDsHead"><span class="dsName">' + esc(oDs.name) + "</span></div>" +
                                                '<div class="analysisDsError">⚠ ' + esc(oRB.getText("analysisDsError")) +
                                                "：" + esc(oDs.error || "") + "</div>";
                                } else {
                                        // 20261024（10.24 记录 #02）：超过 DataGrid.PREVIEW_ROWS 行只画预览，完整数据走「查看全部」分页查看器
                                        var bPreview = oDs.rows.length > DataGrid.PREVIEW_ROWS;
                                        var aMeta = [oRB.getText("analysisRowsCols", [oDs.rows.length, oDs.columns.length])];
                                        if (oDs.truncated) {
                                                aMeta.push(oDs.total > oDs.rows.length ? oRB.getText("analysisTotalRows", [oDs.total]) : oRB.getText("analysisTruncated"));
                                        }
                                        if (bPreview) {
                                                aMeta.push(oRB.getText("dgPreviewMeta", [DataGrid.PREVIEW_ROWS]));
                                        }
                                        if (oDs.elapsedMs) {
                                                aMeta.push(oDs.elapsedMs + "ms");
                                        }
                                        s += '<div class="analysisDsHead"><span class="dsName">' + esc(oDs.name) +
                                                '</span><span class="dsMeta">' + esc(aMeta.join(" · ")) + "</span></div>";
                                        if (!oDs.rows.length) {
                                                s += '<div class="analysisDsEmpty">' + esc(oRB.getText("analysisEmpty")) + "</div>";
                                        } else {
                                                s += DataGrid.tableHtml(oDs.columns, bPreview ? oDs.rows.slice(0, DataGrid.PREVIEW_ROWS) : oDs.rows,
                                                        { cls: "analysisTable" });
                                                // V16：不自动画图 —— 工具条由用户选择；后端推荐的图形仅作提示
                                                var oHint = that._chartHint(oAnalysis, oDs);
                                                s += Formatter.dataToolsHtml(iDs, oHint ? oRB.getText("chartSuggest",
                                                        [ChartRenderer.typeText(oHint.type)]) : "",
                                                        bPreview ? oRB.getText("dgShowAll", [oDs.rows.length]) : "");
                                                // 20261011：该表生成的图表就放在这张表下方
                                                s += oEntry ? that._chartDeckHtml(oEntry, "ds:" + iDs) : "";
                                        }
                                }
                                s += "</div>";
                        });

                        s += "</div>";
                        return s;
                },

                /** V16：后端推荐图形 → 图表面板初始配置（列名映射为列下标） */
                _chartHint: function (oAnalysis, oDs) {
                        var oC = ((oAnalysis && oAnalysis.charts) || []).filter(function (c) {
                                return c.dataset === oDs.name;
                        })[0];
                        if (!oC) {
                                return null;
                        }
                        var fnIdx = function (sName) {
                                for (var i = 0; i < oDs.columns.length; i++) {
                                        if (oDs.columns[i].name === sName) { return i; }
                                }
                                return -1;
                        };
                        var iX = fnIdx(oC.x), iY = fnIdx(oC.y);
                        var oOut = { type: oC.type, title: oC.title || "" };
                        if (iX >= 0) { oOut.x = iX; }
                        if (iY >= 0 && iY !== iX) { oOut.y = [iY]; }
                        return oOut;
                },

                /**
                  * V16：消息附加区 HTML（数据集表格 + 用户生成的图表卡）。
                  * 根节点带 data-uid，工具条点击经 document 委托定位到消息条目。
                  */
                _extraHtml: function (oEntry) {
                        if (!oEntry) {
                                return "";
                        }
                        var sAn = oEntry.analysis ? this._buildAnalysisHtml(oEntry.analysis, oEntry) : "";
                        var sCharts = this._chartDeckHtml(oEntry, "");   // 无锚点的图表（兜底）
                        if (!sAn && !sCharts) {
                                return "";
                        }
                        return '<div class="msgExtra" data-uid="' + oEntry.uid + '">' + sAn + sCharts + "</div>";
                },

                /**
                  * V16：用户图表卡（标题 + 类型快切 + 编辑/下载/删除 + SVG）
                  * 20261011：按锚点筛选 —— "ds:<下标>" 数据集表格 / "md:<序号>" 正文 Markdown 表格 /
                  * "" 无锚点（兜底放附加区末尾）；有锚点的紧跟在来源表格下方
                  */
                _chartDeckHtml: function (oEntry, sSrc) {
                        var aCharts = (oEntry.userCharts || []).filter(function (c) {
                                return (c.src || "") === (sSrc || "");
                        });
                        if (!aCharts.length) {
                                return "";
                        }
                        var esc = Formatter.escapeHtml;
                        var oRB = this._rb();
                        var s = '<div class="chartDeck' + (sSrc ? " chartInline" : "") + '">';
                        aCharts.forEach(function (ch) {
                                var o = ChartRenderer.render(ch.ds, ch.cfg);
                                var sTypes = ChartRenderer.TYPES.map(function (t) {
                                        return '<button type="button" class="ccType' + (t.key === ch.cfg.type ? " on" : "") +
                                                '" data-act="chart-type" data-cid="' + ch.id + '" data-type="' + t.key + '" title="' + t.text + '">' + t.short + "</button>";
                                }).join("");
                                s += '<div class="chartCard" data-cid="' + ch.id + '">' +
                                        '<div class="ccHead"><span class="ccTitle">' + esc(ch.cfg.title || ch.ds.name || oRB.getText("chartDefaultTitle")) + "</span>" +
                                        '<span class="ccTypes">' + sTypes + "</span>" +
                                        '<span class="ccActs">' +
                                        '<button type="button" class="ccAct" data-act="chart-edit" data-cid="' + ch.id + '">' + esc(oRB.getText("chartEdit")) + "</button>" +
                                        '<button type="button" class="ccAct" data-act="chart-svg" data-cid="' + ch.id + '">' + esc(oRB.getText("chartDownload")) + "</button>" +
                                        '<button type="button" class="ccAct ccDel" data-act="chart-del" data-cid="' + ch.id + '">' + esc(oRB.getText("chartRemove")) + "</button>" +
                                        "</span></div>" +
                                        '<div class="ccBody">' + (o.svg || '<div class="cbEmpty">' + esc(o.note) + "</div>") + "</div>" +
                                        (o.svg && o.note ? '<div class="ccNote">' + esc(o.note) + "</div>" : "") +
                                        "</div>";
                        });
                        return s + "</div>";
                },

                /**
                 * V5：停止生成 —— 发送键在响应期间点击触发。
                 * 1) 置空流式令牌：打字机下一帧立即终止；
                 * 2) 记录 _sAbortToken：迟到的后端响应到达后静默丢弃；
                 * 3) 立即解除忙碌态，可继续输入下一问（后端请求仍在 SAP 侧运行至完成，
                 *    其结果已入库，重新打开会话可见，属预期行为）。
                 */
                onStopGenerate: function () {
                        var oChatModel = this.getView().getModel("chat");
                        if (!oChatModel.getProperty("/busy")) {
                                return;
                        }
                        this._sAbortToken = this._sStreamToken;
                        this._sStreamToken = "";
                        this._stopThinkingTicker();   // V13：Agent 等待期思考状态一并停止

                        // 未开始打字的占位气泡标记为已停止
                        var aMsgs = oChatModel.getProperty("/messages");
                        var oLast = aMsgs && aMsgs[aMsgs.length - 1];
                        if (oLast && this._mLive && this._mLive[oLast.uid]) {
                                this._endLive(oLast.uid, "stopped");
                        }
                        if (oLast && oLast.streaming) {
                                oLast.avatarStopped = true;
                                oLast.streaming = false;
                                oLast.waiting = false;
                                if (oLast.requestPending) {
                                        this._attachAgentProcess(aMsgs.length - 1, { status: "STOPPED", traceValid: false });
                                }
                                if (!oLast.raw) {
                                        oLast.html = "";
                                }
                                oLast.meta = this.getView().getModel("i18n").getResourceBundle().getText("stopped");
                                oLast.time = Formatter.formatTime("");
                        }

                        oChatModel.setProperty("/busy", false);
                        this._setSendBtnBusy(false);
                        this._syncActivity();
                        this._refreshMessages();
                },

                /**
                 * 离开当前会话（打开另一个会话 / 新建 / 切工作区）：进行中的回复不再属于新会话 ——
                 * 作废发送令牌、停等待动画并解除忙碌。只清令牌不解忙的话，迟到的响应因 fnIsCurrent() 为假被直接丢弃，
                 * /busy 永远停在 true：新会话的发送键一直是「停止」，回车也发不出去。
                 * 后端请求照常跑完入库，重新打开原会话可见。
                 */
                _releaseBusy: function () {
                        this._sStreamToken = "";
                        this._stopThinkingTicker();
                        var oChatModel = this.getView().getModel("chat");
                        if (oChatModel.getProperty("/busy")) {
                                oChatModel.setProperty("/busy", false);
                                this._setSendBtnBusy(false);
                                this._syncActivity();
                        }
                },

                /**
                 * V4.2/V5：发送按钮 忙碌/就绪 切换
                 * 忙碌：图标变方块（停止样式）+ 柔化蓝底（.sendBtnStop），按钮【保持可点】——
                 *       点击即停止生成（见 onSend 的忙碌分支），不再禁用；
                 *       不使用 setBusy，移除其叠加在按钮上的三点 Busy 动画
                 * 就绪：恢复纸飞机图标与常规态
                 * @param {boolean} bBusy true=响应进行中
                 */
                _setSendBtnBusy: function (bBusy) {
                        var oBtn = this.byId("sendBtn");
                        if (!oBtn) {
                                return;
                        }
                        // 20261025：停止 → 纸飞机时，飞机从左下角落回按钮（发送时飞出去的那架）
                        if (!bBusy && oBtn.hasStyleClass("sendBtnStop")) {
                                oBtn.addStyleClass("sendBtnLand");
                                clearTimeout(this._iLandTimer);
                                this._iLandTimer = setTimeout(function () {
                                        if (!oBtn.isDestroyed()) {
                                                oBtn.removeStyleClass("sendBtnLand");
                                        }
                                }, 700);
                        }
                        oBtn.setEnabled(true);
                        oBtn.setIcon(bBusy ? "sap-icon://stop" : "sap-icon://paper-plane");
                        oBtn.toggleStyleClass("sendBtnStop", !!bBusy);
                        oBtn.setTooltip(bBusy
                                ? this.getView().getModel("i18n").getResourceBundle().getText("stopTip")
                                : this.getView().getModel("i18n").getResourceBundle().getText("send"));
                },

                /* =========================================================
                 * V12：工作模式（对话 CHAT / Agent AGENT）
                 * 模式是会话级属性：左侧导航只是切换"正在浏览的工作区"，
                 * 不改变任何会话自身；打开历史会话时以会话 Mode 为准恢复。
                 * Agent 模式：统一聊天入口 → 通用编排（受限工具循环 + Trace）
                 * ========================================================= */

                /** i18n 便捷读取 */
                _rb: function () {
                        return this.getView().getModel("i18n").getResourceBundle();
                },

                /** 左侧模式导航入口（对话 / Agent） */
                onSelectWorkspaceMode: function (oEvent) {
                        var sMode = (oEvent.getSource() && oEvent.getSource().data("mode")) === "AGENT"
                                ? "AGENT" : "CHAT";
                        this._confirmModeSwitchIfNeeded(sMode);
                },

                /**
                  * 模式切换规则（计划书 §6.2）：
                  * 有进行中的请求 → 拦截提示；有未发送输入 → 确认后切换；
                  * 其余直接切换。切换不清空另一模式的历史与输入。
                  */
                _confirmModeSwitchIfNeeded: function (sMode) {
                        var that = this;
                        var oChat = this.getView().getModel("chat");
                        if (oChat.getProperty("/workspaceMode") === sMode) {
                                return;
                        }
                        if (oChat.getProperty("/busy")) {
                                MessageToast.show(this._rb().getText("modeSwitchBlockBusy"), { duration: 3000 });
                                this._applyWorkspaceChrome();   // 导航选中态复位
                                return;
                        }
                        var fnGo = function () { that._switchWorkspace(sMode); };
                        if ((oChat.getProperty("/input") || "").trim()) {
                                MessageBox.confirm(this._rb().getText("modeSwitchConfirmMsg"), {
                                        title: this._rb().getText("modeSwitchConfirmTitle"),
                                        onClose: function (sAction) {
                                                if (sAction === MessageBox.Action.OK) {
                                                        fnGo();
                                                } else {
                                                        that._applyWorkspaceChrome();
                                                }
                                        }
                                });
                                return;
                        }
                        fnGo();
                },

                /**
                  * 切换工作区：目标模式有已记住的会话且有消息 → 恢复该会话；
                  * 否则进入该模式空状态（两模式共用 hero / 消息列表 / 输入框）。
                  * 另一模式的会话记忆与输入内容不受影响。
                  * V13：AGENT 无会话时直接创建空通用 Agent 会话（不再选类型）。
                  */
                _switchWorkspace: function (sMode) {
                        var oChat = this.getView().getModel("chat");
                        this._releaseBusy();   // 中断另一模式的流式输出
                        oChat.setProperty("/workspaceMode", sMode);

                        var sId = this._mModeSession[sMode];
                        var oHit = this._findSession(sId);
                        if (sId && oHit) {
                                this._loadSessionById(sId);
                                this._applyWorkspaceChrome();
                                this._applySessionFilter();
                                return;
                        }

                        // 模式空状态：CHAT 用已记住的空会话；AGENT 新建空会话（20261011：默认上次的场景）
                        var sNew = sId || this._newSessionId();
                        this._setSessionContext({ id: sNew, mode: sMode,
                                agentType: sMode === "AGENT" ? this._lastScene() : "", status: "IDLE" });
                        this.getView().getModel("session").setProperty("/currentId", sNew);
                        oChat.setProperty("/messages", []);
                        this.getView().getModel("session").setProperty("/title", "");
                        this._setViewLayout(false);
                        this._applyWorkspaceChrome();
                        this._applySessionFilter();
                },

                /**
                  * 统一维护"当前会话"上下文：chat>/currentSession、按模式记忆、
                  * settings 同步（sessionId / agentSessionId）与任务信息入口可见性
                  */
                _setSessionContext: function (oCtx) {
                        var oChat = this.getView().getModel("chat");
                        var oSettings = this.getView().getModel("settings");
                        var sMode = oCtx.mode === "AGENT" ? "AGENT" : "CHAT";
                        this._activateSessionMessages(oCtx.id || "", sMode);
                        oChat.setProperty("/currentSession", {
                                id: oCtx.id || "",
                                mode: sMode,
                                // V14：Agent 是通用对话模式；INVENTORY 仅作为旧会话兼容值，
                                // 新建/恢复为空时不再偷偷回落到库存 Agent。
                                agentType: sMode === "AGENT" ? (oCtx.agentType || "GENERAL") : "",
                                status: oCtx.status || "IDLE"
                        });
                        this._mModeSession[sMode] = oCtx.id || "";
                        if (sMode === "AGENT") {
                                oSettings.setProperty("/agentSessionId", oCtx.id || "");
                        } else {
                                oSettings.setProperty("/sessionId", oCtx.id || "");
                        }
                        oSettings.setProperty("/workspaceMode",
                                oChat.getProperty("/workspaceMode") === "AGENT" ? "AGENT" : "CHAT");
                        this._persistSettings();
                        // 空的 Agent 对话不显示任务信息入口，首次发送后再显示。
                        oChat.setProperty("/agentInfoVisible",
                                sMode === "AGENT" && !!oCtx.id && oCtx.status !== "IDLE");
                        // 20261020：模型是会话级的 —— 换成这个会话记住的模型
                        this._applySessionModel();
                },

                /** 模式外观同步：分段按钮选中态（纯 CSS）/ 顶栏徽标（仅 对话|Agent）/
                  *  新建与历史文案 / hero 标题与副标题 / 占位文案 */
                _applyWorkspaceChrome: function () {
                        var oChat = this.getView().getModel("chat");
                        var oRB = this._rb();
                        var sMode = oChat.getProperty("/workspaceMode") === "AGENT" ? "AGENT" : "CHAT";
                        // V13：选中态不再切 Emphasized（避免 UI5 强调按钮的双描边/实心底），
                        // 分段控件选中样式由 .modeNavBtn.modeNavActive 统一控制
                        var oChatNav = this.byId("chatModeNav");
                        var oAgentNav = this.byId("agentModeNav");
                        if (oChatNav) {
                                oChatNav.toggleStyleClass("modeNavActive", sMode === "CHAT");
                        }
                        if (oAgentNav) {
                                oAgentNav.toggleStyleClass("modeNavActive", sMode === "AGENT");
                        }
                        // V16：新建按钮两模式统一样式(仅文案切换)，不再做主次跳变
                        // V13：徽标只显示模式本身，不拼接 Agent 类型
                        var oScene = sMode === "AGENT" ? this._sceneDef(this._curScene()) : null;
                        var bScene = !!oScene && oScene.key !== "AUTO";
                        oChat.setProperty("/modeLabel",
                                oRB.getText(sMode === "AGENT" ? "modeLabelAgent" : "modeLabelChat") +
                                (bScene ? " · " + oScene.text : ""));
                        oChat.setProperty("/newBtnLabel",
                                oRB.getText(sMode === "AGENT" ? "newAgentSession" : "newChatBtnChat"));
                        oChat.setProperty("/histLabel",
                                oRB.getText(sMode === "AGENT" ? "histAgent" : "histChat"));
                        this._syncHeroGreeting();
                        oChat.setProperty("/heroModeHint", sMode === "AGENT"
                                ? (oScene ? oScene.sub : oRB.getText("agentHeroSub")) : oRB.getText("heroChatHint"));
                        var sAgentPh = bScene && oScene.ph ? oScene.ph : oRB.getText("agentInputPh");
                        oChat.setProperty("/heroPh",
                                sMode === "AGENT" ? sAgentPh : oRB.getText("heroPlaceholder"));
                        oChat.setProperty("/inputPh",
                                sMode === "AGENT" ? sAgentPh : oRB.getText("inputPlaceholder"));
                        // V12：附件回显行仅对话模式显示
                        this._syncAttachRowVisibility();
                        // V16：建议标签随模式切换（对话 = 快捷指令，Agent = 示例问题）
                        this._renderHeroBubbles();
                        // 20261011：场景选择条 + 按场景过滤模型下拉
                        this._renderScenePicker();
                        this._syncModelList();
                        this._syncSkills();
                },

                /** 同一首页保持文案稳定；换模式 / 新会话 / 再次进入首页时抽下一对。 */
                _syncHeroGreeting: function (bNewVisit) {
                        var oChat = this.getView().getModel("chat");
                        var oRB = this._rb();
                        var sContext = this._wsMode() + "|" + ((oChat.getProperty("/currentSession") || {}).id || "");
                        if (!this._oHeroGreeting || bNewVisit || this._sHeroGreetingContext !== sContext) {
                                this._oHeroGreeting = HeroGreeting.pick(this._oHeroGreeting && this._oHeroGreeting.key);
                                this._sHeroGreetingContext = sContext;
                        }
                        var oGreeting = this._oHeroGreeting;
                        oChat.setProperty("/heroTitle", oRB.getText("heroGreetingTitle", [
                                oRB.getText(oGreeting.greetingKey), oRB.getText(oGreeting.titleKey)
                        ]));
                        oChat.setProperty("/heroSub", oRB.getText(oGreeting.subKey));
                },

                /** 当前浏览的工作区（"CHAT" | "AGENT"） */
                _wsMode: function () {
                        return this.getView().getModel("chat").getProperty("/workspaceMode") === "AGENT" ? "AGENT" : "CHAT";
                },

                /** 已加载的会话里，属于该模式且标题含搜索词的 */
                _localSessions: function (sMode, sQ) {
                        return (this._aAllSessions || []).filter(function (s) {
                                return (s.Mode === "AGENT" ? "AGENT" : "CHAT") === sMode &&
                                        (!sQ || String(s.Title || "").toLowerCase().indexOf(sQ) >= 0);
                        });
                },

                /**
                  * 左侧列表只显示当前工作模式的会话（搜索词在模式内过滤）。
                  * 20261011（BE-09）：有搜索词时显示服务端搜索结果（含未加载的更早会话），
                  * 结果回来前先按已加载的会话即时过滤；还有更早的会话时末尾加一条"加载更多"
                  */
                _applySessionFilter: function () {
                        var sMode = this._wsMode();
                        var sQ = (this._sSessQuery || "").toLowerCase();
                        var oHits = this._oSessHits;
                        var bHits = !!sQ && !!oHits && oHits.q === sQ && oHits.mode === sMode;
                        var aList = bHits ? oHits.rows.slice() : this._localSessions(sMode, sQ);
                        // 20261025：删除后等待撤销的会话先不显示
                        var mHidden = this._mDelHidden || {};
                        aList = aList.filter(function (s) { return !mHidden[s.SessionId]; });
                        var bMore = bHits ? oHits.more : (!sQ && !!(this._mSessMore || {})[sMode]);
                        if (bMore) {
                                aList.push({ SessionId: "", Title: "", _more: true });
                        }
                        this.getView().getModel("session").setProperty("/sessions", aList);
                        this._syncSessionHighlight();
                        if (sQ && !bHits) {
                                this._searchSessions();
                        }
                },

                /** 按 ID 找会话（已加载的列表 + 当前搜索结果） */
                _findSession: function (sSid) {
                        if (!sSid) {
                                return null;
                        }
                        var fnHit = function (s) { return s.SessionId === sSid; };
                        return (this._aAllSessions || []).filter(fnHit)[0] ||
                                ((this._oSessHits && this._oSessHits.rows) || []).filter(fnHit)[0] || null;
                },

                /** V12：按会话加载（以会话自身 Mode 恢复工作模式，不全局覆盖） */
                _loadSessionById: function (sSid) {
                        if (!sSid) {
                                return;
                        }
                        var oMeta = this._findSession(sSid);
                        if (!oMeta) {
                                return;
                        }
                        this._restoreWorkspaceBySession(oMeta);
                        this._loadHistoryFor(sSid, oMeta.Mode === "AGENT");
                },

                /** 会话 → 工作模式恢复（Mode/AgentType/Status 全部以会话为准） */
                _restoreWorkspaceBySession: function (oSess) {
                        var oChat = this.getView().getModel("chat");
                        var sMode = oSess.Mode === "AGENT" ? "AGENT" : "CHAT";
                        oChat.setProperty("/workspaceMode", sMode);
                        this._setSessionContext({
                                id: oSess.SessionId,
                                mode: sMode,
                                agentType: oSess.AgentType || "",
                                status: oSess.Status || "IDLE"
                        });
                        var oSessionModel = this.getView().getModel("session");
                        oSessionModel.setProperty("/currentId", oSess.SessionId);
                        oSessionModel.setProperty("/title", this._stripRolePrefix(oSess.Title || ""));
                        this._applyWorkspaceChrome();
                        this._applySessionFilter();
                        this._syncSessionHighlight();
                },

                /**
                  * 优先恢复本页缓存；首次打开或普通回复被中断时回读后端并合并本地卡片。
                  */
                _loadHistoryFor: function (sSid, bAgentTask) {
                        this._releaseBusy();
                        return this._readSessionHistory(sSid, bAgentTask).catch(function (sErr) {
                                console.warn("[ChatService] 历史加载失败: " + sErr);
                        });
                },

                /** 启动时恢复上次工作模式（AGENT 且任务仍在 → 打开任务；否则该模式首页） */
                _restoreStartupWorkspace: function () {
                        if (this._sStartupWorkspace !== "AGENT") {
                                return;   // CHAT 沿用既有恢复路径(_afterAppLogin → _loadHistory)
                        }
                        var sId = this._mModeSession.AGENT;
                        var bHit = !!this._findSession(sId);
                        if (sId && bHit) {
                                this._loadSessionById(sId);
                        } else {
                                this._switchWorkspace("AGENT");
                        }
                },

                /** Agent 运行结束：回写最近一轮运行状态（列表徽标 + 当前会话上下文） */
                _updateAgentSessionStatus: function (sSid, sRunStatus) {
                        var sSts = sRunStatus === "OK" ? "COMPLETED"
                                : sRunStatus === "TIMEOUT" ? "PARTIAL" : "FAILED";
                        var oChat = this.getView().getModel("chat");
                        var oCtx = oChat.getProperty("/currentSession") || {};
                        if (oCtx.id === sSid) {
                                oChat.setProperty("/currentSession/status", sSts);
                        }
                        // 全量缓存与搜索结果里是各自的对象，两处都要改
                        (this._aAllSessions || []).concat((this._oSessHits && this._oSessHits.rows) || [])
                                .forEach(function (s) {
                                        if (s.SessionId === sSid) {
                                                s.Status = sSts;
                                        }
                                });
                        this._applySessionFilter();   // 重渲染列表状态徽标
                },

                /** V12/V13：Agent 任务信息（状态/模型/更新时间；不展示内部过程细节） */
                onAgentTaskInfo: function () {
                        var oRB = this._rb();
                        var oCtx = this.getView().getModel("chat").getProperty("/currentSession") || {};
                        if (oCtx.mode !== "AGENT" || !oCtx.id) {
                                return;
                        }
                        var oMeta = this._findSession(oCtx.id) || {};
                        MessageBox.information(oRB.getText("agentInfoTextV13", [
                                this._agentStatusText(oCtx.status),
                                oMeta.ModelId || "-",
                                Formatter.formatTime(oMeta.ChangedAt || ""),
                                oCtx.id
                        ]), { title: oRB.getText("agentInfoTitle") });
                },

                /** Agent 任务状态 → 展示文案 */
                _agentStatusText: function (sStatus) {
                        var sKey = sStatus === "RUNNING" ? "sessStRunning"
                                : sStatus === "COMPLETED" ? "sessStCompleted"
                                : sStatus === "PARTIAL" ? "sessStPartial"
                                : sStatus === "FAILED" ? "sessStFailed"
                                : "sessStIdle";
                        return this._rb().getText(sKey);
                },

                /** Agent 响应的 meta 摘要（轮数/工具调用数/耗时；异常态前缀可解释说明） */
                _agentMeta: function (oRes, bIncludeDone) {
                        var oRB = this._rb();
                        var oFinished = TraceService.finish(oRes);
                        var aStats = TraceService.stats(oFinished);
                        // 20261028：确定性流程（报表选择 / 参数卡，不调模型）没有轮次和工具，只显示耗时，不写「0 轮 · 0 次工具」
                        var sBase = Number(aStats[0]) || Number(aStats[1]) ? oRB.getText("agentMeta", aStats) : String(aStats[2] || "");
                        var sPrefix = bIncludeDone ? oRB.getText("sessStCompleted") : "";
                        if (oFinished.status === "TIMEOUT") {
                                sPrefix = oRB.getText("agentStTimeout");
                        } else if (oFinished.status === "DENIED") {
                                sPrefix = oRB.getText("agentStDenied");
                        } else if (oFinished.status === "ERROR") {
                                sPrefix = oRB.getText("agentStError");
                        } else if (oFinished.status === "STOPPED") {
                                return oRB.getText("stopped");
                        }
                        // 20261024：技能不再拼进 meta 文字，改由标题行的技能标签显示（_skillTagOf）
                        return sPrefix ? sPrefix + " · " + sBase : sBase;
                },

                /** 本轮 Trace 里的技能（SKILL 阶段「使用技能：名称 vN」）→ 标签文字「名称 vN」；没用技能返回空串 */
                _skillTagOf: function (oFinished) {
                        var oSkill = (oFinished.phases || []).filter(function (t) { return t.phase === "SKILL"; })[0];
                        return oSkill ? String(oSkill.label || "").replace(/^使用技能[:：]\s*/, "").replace(/（演示）$/, "").trim() : "";
                },

                /**
                 * 流式渲染：将完整回复按打字机效果逐步写入指定消息条目
                 * 通过 JSONModel 单条属性更新（/messages/i/html）实现局部刷新，
                 * 令牌校验保证会话切换/新建/停止时立即中断
                 * @param {int} iIndex 消息条目下标
                 * @param {string} sAnswer 完整回复（Markdown）
                 * @param {string} sMeta 元信息
                 * @param {string} sToken V5：由 onSend 生成的本轮令牌（停止生成即失效）
                 * @returns {Promise} 打字完成（或被中断）后 resolve
                 */
                _streamAnswer: function (iIndex, sAnswer, sMeta, sToken) {
                        var that = this;
                        var oChatModel = this.getView().getModel("chat");
                        sToken = sToken || this._newSessionId(); // 兼容旧调用
                        this._sStreamToken = sToken;
                        this._syncActivity();

                        return new Promise(function (fnResolve) {
                                var iPos = 0;
                                var iLen = sAnswer.length;
                                // 新块淡入用：记录上一帧正文块数量（新增块才触发 tokenIn 动画，
                                // 避免每帧整段重写导致的闪烁）
                                that._iPrevBlockCount = -1;
                                // 约 160 帧打完，每帧至少 2 字符（长文自动加速）
                                var iChunk = Math.max(2, Math.ceil(iLen / 160));
                                // 20261019（FE-10）：点消息区可跳过动画（_maybeSkipStream 置位，下一帧直接打完）
                                var sSkipTip = that._rb().getText("streamSkipTip");

                                var fnTick = function () {
                                        // 令牌失效 → 会话已切换/新建，立即终止
                                        if (that._sStreamToken !== sToken) {
                                                fnResolve();
                                                return;
                                        }
                                        iPos = that._sStreamSkip === sToken ? iLen : Math.min(iLen, iPos + iChunk);
                                        var bDone = iPos >= iLen;
                                        var sPart = sAnswer.substring(0, iPos);
                                        var sHtml = Formatter.markdownToHtml(sPart);
                                        // 流式光标：进行中为细竖条闪烁；完成时以淡出版本渲染，
                                        // 300ms 后透明，不再打字即自然消失
                                        sHtml += bDone
                                                ? '<span class="typeCursor typeCursorOut"></span>'
                                                : '<span class="typeCursor"></span>';

                                        // 同步数据模型（会话保存/重建列表时以此为最终状态）
                                        oChatModel.setProperty("/messages/" + iIndex + "/raw", sPart);
                                        oChatModel.setProperty("/messages/" + iIndex + "/html",
                                                sHtml.replace(/<span class="typeCursor[^"]*"><\/span>/, ""));

                                        // 渲染：直接写 HTML 控件的 DOM（content 属性静态，
                                        // 走 setProperty 不触发渲染；直写 DOM 避免整表重渲染）
                                        var oBodyCtrl = that._findMsgBodyCtrl(iIndex);
                                        if (oBodyCtrl && oBodyCtrl.getDomRef()) {
                                                var oBodyDom = oBodyCtrl.getDomRef();
                                                // Markdown 输出再次经过白名单清洗；流式光标是内部安全标记，
                                                // 清洗后仍保留在允许的 span 之外时由 CSS 正常显示。
                                                oBodyDom.innerHTML = Formatter.sanitizeHtml(sHtml);
                                                oBodyDom.title = bDone ? "" : sSkipTip;
                                                if (!bDone) {
                                                        // 新块淡入：仅当出现新的顶级块（段落/列表/代码块）时，
                                                        // 对最后一块加 tokenIn 动画；光标不算块
                                                        var iCount = oBodyDom.children.length;
                                                        if (iCount !== that._iPrevBlockCount) {
                                                                var oLast = oBodyDom.lastElementChild;
                                                                if (oLast && oLast.classList.contains("typeCursor")) {
                                                                        oLast = oLast.previousElementSibling;
                                                                }
                                                                if (oLast) {
                                                                        oLast.classList.add("tokenIn");
                                                                }
                                                                that._iPrevBlockCount = iCount;
                                                        }
                                                }
                                        }

                                        // 用户停留在底部附近时才自动吸底，避免打断手动翻阅
                                        if (that._isNearBottom()) {
                                                that._scrollToBottom(true);
                                        }

                                        if (bDone) {
                                                oChatModel.setProperty("/messages/" + iIndex + "/meta", sMeta || "");
                                                oChatModel.setProperty("/messages/" + iIndex + "/time", Formatter.formatTime(""));
                                                oChatModel.setProperty("/messages/" + iIndex + "/streaming", false);
                                                // 打字完成后对代码块做语法高亮（highlight.js 可用时）
                                                setTimeout(function () {
                                                        that._highlightCodeBlocks();
                                                }, 320);
                                                fnResolve();
                                        } else {
                                                setTimeout(fnTick, 24);
                                        }
                                };

                                // 短暂停顿让"思考中"动画可见，随后开始打字
                                setTimeout(fnTick, 200);
                        });
                },

                /** 按消息下标定位该条目的 HTML 正文控件（msgBody=1 标记；V16：行内新增了
                  * thinkBar/stepBar 等原生 HTML 控件，“第一个 HTML”不再可靠） */
                /**
                  * 20261011：正文 HTML + 正文 Markdown 表格生成的图表（插在第 N 个表格工具条之后）。
                  * 表格数变少（极少见）时，找不到锚点的图表追加在正文末尾，不丢失
                  */
                _bodyHtml: function (oEntry) {
                        var sHtml = oEntry.html || "";
                        var aMd = (oEntry.userCharts || []).filter(function (c) { return /^md:/.test(c.src || ""); });
                        if (!aMd.length) {
                                return sHtml;
                        }
                        var that = this, iN = -1, oUsed = {};
                        sHtml = sHtml.replace(/<div class="dataTools">[\s\S]*?<\/div>/g, function (sTools) {
                                iN++;
                                oUsed["md:" + iN] = true;
                                return sTools + that._chartDeckHtml(oEntry, "md:" + iN);
                        });
                        aMd.forEach(function (c) {
                                if (!oUsed[c.src]) {
                                        oUsed[c.src] = true;
                                        sHtml += that._chartDeckHtml(oEntry, c.src);
                                }
                        });
                        return sHtml;
                },

                _findMsgBodyCtrl: function (iIndex) {
                        var oList = this.byId("msgList");
                        var oItem = oList && oList.getItems()[iIndex];
                        if (!oItem) {
                                return null;
                        }
                        var aFound = oItem.findAggregatedObjects(true, function (oObj) {
                                return oObj instanceof HTML && oObj.data("msgBody") === "1";
                        });
                        return aFound.length ? aFound[0] : null;
                },

                /**
                 * 代码语法高亮：对消息列表内所有 pre>code 调用 highlight.js
                 * CDN 未加载（如内网环境）时静默跳过，不影响功能
                 */
                _highlightCodeBlocks: function () {
                        if (!window.hljs) {
                                return;
                        }
                        var oList = this.byId("msgList");
                        var oDom = oList && oList.getDomRef();
                        if (!oDom) {
                                return;
                        }
                        Array.prototype.forEach.call(oDom.querySelectorAll("pre code"), function (oCode) {
                                if (!oCode.classList.contains("hljs")) {
                                        try {
                                                window.hljs.highlightElement(oCode);
                                        } catch (e) {
                                                // 单块高亮失败不阻断渲染
                                        }
                                }
                        });
                },

                /** 消息区是否接近底部（用于流式输出时判断是否自动吸底） */
                _isNearBottom: function () {
                        var oScroll = this.byId("chatScroll");
                        var oDom = oScroll && oScroll.getDomRef();
                        if (!oDom) {
                                return true;
                        }
                        return oDom.scrollHeight - oDom.scrollTop - oDom.clientHeight < 140;
                },

                /* =========================================================
                 * 消息条目构造与渲染
                 * ========================================================= */

                /**
                 * 列表项工厂：为每条消息构建聊天气泡
                 * （不使用 XML 模板，因为 class 属性不支持绑定，样式类在此直接添加）
                 * @param {string} sId 内部 id
                 * @param {sap.ui.model.Context} oContext 消息条目上下文
                 * @returns {sap.m.CustomListItem} 列表项
                 */
                msgItemFactory: function (sId, oContext) {
                        var oEntry = oContext.getObject();
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var bIsUser = oEntry.role === "user";

                        // ★ preferDOM:false 时，HTML 控件会把 content 的根元素
                        //   直接作为自身 DOM 根节点（class 取自内容根元素，
                        //   addStyleClass 会被覆盖）。因此这里包一层 bubbleBody
                        //   作为稳定根节点，流式期间 _streamAnswer 对其
                        //   getDomRef().innerHTML 直写更新，避免整表重渲染。
                        // sanitizeContent 显式关闭是安全的：所有动态文本在 Formatter
                        // 中已先整体 HTML 转义，输出标签均由代码构造，无注入路径。
                        // V16：data-uid 供表格工具条（生成图表/复制/CSV）的事件委托定位消息
                        var oBody = new HTML({
                                content: '<div class="bubbleBody" data-uid="' + (oEntry.uid || "") + '">' + this._bodyHtml(oEntry) + "</div>",
                                preferDOM: false,
                                sanitizeContent: false
                        }).data("msgBody", "1");   // V16：打标 —— Agent 行内还有 thinkBar/stepBar 等 HTML 控件，
                                                   // 流式写入必须精确定位正文（见 _findMsgBodyCtrl）

                        var oCol = new VBox();

                        if (bIsUser) {
                                // 用户：米色胶囊靠右。
                                // V4.2：时间戳从气泡下方移到气泡上方（右对齐、
                                // 小号弱化灰），胶囊本身只包内容
                                // 20261024：用了技能时，时间左边加技能标签（同一行）
                                var oUserTop = new HBox({ alignItems: "Center", justifyContent: "End" }).addStyleClass("userTopRow");
                                oUserTop.addItem(new Text({ text: "{chat>skillTag}", visible: "{= !!${chat>skillTag} }" })
                                        .addStyleClass("skillTag"));
                                oUserTop.addItem(new Text({ text: "{chat>time}" }).addStyleClass("bubbleTime userTimeTop"));
                                oCol.addItem(oUserTop);
                                var oBubble = new VBox().addStyleClass("chatBubble userBubble");
                                oBubble.addItem(oBody);
                                oCol.addItem(oBubble);
                                oCol.addStyleClass("userCol");
                                // meta 使用模型绑定：流式结束后 setProperty
                                // 更新时，条目被复用（同长度数组不重建）也能自动刷新
                                oCol.addItem(new Text({ text: "{chat>meta}" }).addStyleClass("bubbleMeta"));
                        } else {
                                // AI：左侧圆徽标 + 画布全文（无气泡）。
                                // V4.2：时间移到正文上方，与「AI 助手」标题同行弱化展示；
                                // 等待响应时标题行显示"思考中…"扫光动画（加载态迁移，
                                // raw 属性为空时可见，首帧正文到达后自动隐藏）
                                var oHeadLeft = new HBox({ alignItems: "Center" }).addStyleClass("bubbleHeadLeft");
                                oHeadLeft.addItem(new Text({ text: oEntry.sender }).addStyleClass("bubbleSender"));
                                if (oEntry.streaming && !oEntry.agentThinking && !oEntry.thinking) {
                                        // V16：等待计时（"思考中 · 3 秒"）
                                        // 20261025：只在还在生成时显示 —— 列表条目会被复用，停止生成后这条回复
                                        // 正文仍为空，原来只看 raw 会一直挂着「思考中…」，和「已停止生成」并排
                                        oHeadLeft.addItem(new Text({
                                                text: "{= ${i18n>thinkingWait} + (${chat>elapsedText} ? ' · ' + ${chat>elapsedText} : '…') }",
                                                visible: "{= !!${chat>streaming} && ${chat>raw} === '' }"
                                        }).addStyleClass("headThinking"));
                                }
                                oHeadLeft.addItem(new Text({ text: "{chat>time}" }).addStyleClass("bubbleTime aiHeadTime"));
                                // V5：meta 展示位（如"已停止生成"），空值时 CSS :empty 隐藏
                                oHeadLeft.addItem(new Text({ text: "{chat>meta}" }).addStyleClass("bubbleMeta aiHeadMeta"));
                                // 20261024：本轮用了技能 → 标题行末尾的蓝色技能标签
                                oHeadLeft.addItem(new Text({ text: "{chat>skillTag}", visible: "{= !!${chat>skillTag} }" })
                                        .addStyleClass("skillTag aiSkillTag"));

                                var oHead = new HBox({ justifyContent: "SpaceBetween", alignItems: "Center" }).addStyleClass("bubbleHead");
                                oHead.addItem(oHeadLeft);

                                oCol.addItem(oHead);

                                // V13：Agent 思考卡（正文之上）——
                                // 运行中：动态阶段文案（_startThinkingTicker 轮换，thinkingLabel 绑定刷新）；
                                // 完成后：后端 TraceJson 的真实阶段摘要（✓ 阶段 · 耗时），可折叠。
                                // 只展示阶段/友好摘要/状态/耗时；SQL 单独折叠，不展示思维链、Prompt 或密钥
                                if (oEntry.agentThinking || oEntry.thinking) {
                                        // V16 运行中：图标 + 阶段文案 + 实时计时 + 流动进度条
                                        var oLiveHead = new HBox({ alignItems: "Center" }).addStyleClass("agentThinkingHeader");
                                        oLiveHead.addItem(new sap.ui.core.Icon({ src: "sap-icon://synchronize" }).addStyleClass("thinkIcon thinkSpin"));
                                        oLiveHead.addItem(new Text({ text: "{chat>thinkingLabel}" })
                                                .addStyleClass("agentThinkingTitle"));
                                        oLiveHead.addItem(new Text({ text: "{chat>elapsedText}" })
                                                .addStyleClass("agentThinkingPhase"));
                                        var oLiveCard = new VBox({ visible: "{chat>requestPending}" })
                                                .addStyleClass("agentThinkingCard agentThinkingLive");
                                        oLiveCard.addItem(oLiveHead);
                                        // 20261028：拿到真实步骤（AgentProgress）后，流动进度条换成步骤列表（_liveHtml）
                                        oLiveCard.addItem(new HTML({ content: '<div class="thinkBar"><i></i></div>', sanitizeContent: false,
                                                visible: "{= !${chat>liveHtml} }" }));
                                        oLiveCard.addItem(new HTML({ content: "{chat>liveHtml}", visible: "{= !!${chat>liveHtml} }",
                                                preferDOM: false, sanitizeContent: false }));
                                        oCol.addItem(oLiveCard);
                                        // 折叠由外层未绑定容器控制（避免 setVisible 回写绑定属性）
                                        var oStepsWrap = new VBox({ visible: false });
                                        var oStepsBox = new VBox({
                                                // 20261028：这一轮有实时步骤时，展开看的就是实时步骤（更全：含模型的说明、参数、预览）
                                                visible: "{= !!${chat>thinking/hasPhases} && !${chat>liveHtml} }"
                                        }).addStyleClass("agentThinkingSteps");
                                        oStepsWrap.addItem(oStepsBox);
                                        var oLiveDone = new HTML({ content: "{chat>liveHtml}", visible: "{= !!${chat>liveHtml} }",
                                                preferDOM: false, sanitizeContent: false });
                                        oStepsWrap.addItem(oLiveDone);
                                        oStepsBox.bindAggregation("items", {
                                                path: "chat>thinking/phases",
                                                templateShareable: false,
                                                factory: function (sStepId, oStepContext) {
                                                var p = oStepContext.getObject();
                                                // 20261024：「使用技能」一行单独样式（技能图标 + 蓝字，不画耗时条，设计稿 05）
                                                if (p.phase === "SKILL") {
                                                        var sSk = String(p.label || "").replace(/^使用技能[:：]\s*/, "");
                                                        var oSkRow = new HBox({ alignItems: "Center" }).addStyleClass("agentThinkingStep agentStepSkill");
                                                        oSkRow.addItem(new HTML({ content: '<span class="agentStepGlyph skStepIco" aria-hidden="true"></span>', sanitizeContent: false }));
                                                        oSkRow.addItem(new Text({ text: "使用技能" }).addStyleClass("skStepName"));
                                                        oSkRow.addItem(new Text({ text: sSk, wrapping: true }).addStyleClass("agentStepLabel skStepDetail"));
                                                        return oSkRow;
                                                }
                                                var bOk = (p.status || "OK") === "OK";
                                                var sGlyph = bOk ? "✓" : (p.status === "REJECTED" ? "⚠" : "✕");
                                                var sCost = p.elapsedMs === null ? "--" : p.elapsedMs >= 1000
                                                        ? (p.elapsedMs / 1000).toFixed(1) + "s"
                                                        : p.elapsedMs + "ms";
                                                var oStepRow = new HBox({ alignItems: "Center" })
                                                        .addStyleClass("agentThinkingStep" + (bOk ? "" : " agentThinkingStepFail"));
                                                oStepRow.addItem(new Text({ text: sGlyph }).addStyleClass("agentStepGlyph"));
                                                oStepRow.addItem(new Text({ text: p.label || p.phase || "", wrapping: true })
                                                        .addStyleClass("agentStepLabel"));
                                                // V16：耗时条（相对本轮最长一步）
                                                oStepRow.addItem(new HTML({
                                                        content: '<div class="stepBar"><i style="width:' + (parseInt(p.pct, 10) || 0) + '%"></i></div>',
                                                        sanitizeContent: false
                                                }));
                                                oStepRow.addItem(new Text({ text: sCost }).addStyleClass("agentStepTime"));
                                                // 动态 SQL 仅展示后端已校验的语句，默认折叠，避免 Trace 撑满页面。
                                                var oStepBox = new VBox();
                                                oStepBox.addItem(oStepRow);
                                                if (p.detail && p.tool === "run_sql") {
                                                        var oSqlText = new Text({ text: p.detail, wrapping: true, visible: false })
                                                                .addStyleClass("agentSqlDetail");
                                                        var oSqlBtn = new Button({ text: "SQL", type: "Transparent" })
                                                                .addStyleClass("agentSqlToggle");
                                                        oSqlBtn.attachPress(function () {
                                                                var bVisible = oSqlText.getVisible();
                                                                oSqlText.setVisible(!bVisible);
                                                                oSqlBtn.setText(bVisible ? "SQL" : oRB.getText("sqlCollapse"));
                                                        });
                                                        oStepRow.addItem(oSqlBtn);
                                                        oStepBox.addItem(oSqlText);
                                                }
                                                return oStepBox;
                                                }
                                        });
                                        // V16 完成后：一行摘要（已完成 · 轮数 · 工具 · 耗时），点击展开每步耗时
                                        var oDoneHead = new HBox({ alignItems: "Center" })
                                                .addStyleClass("agentThinkingHeader agentDoneHead");
                                        var oFoldIcon = new sap.ui.core.Icon({ src: "sap-icon://navigation-right-arrow" }).addStyleClass("thinkFold");
                                        oDoneHead.addItem(new sap.ui.core.Icon({ src: "sap-icon://process" }).addStyleClass("thinkIcon"));
                                        oDoneHead.addItem(new Text({
                                                text: "{chat>thinking/title}"
                                        }).addStyleClass("agentThinkingTitle"));
                                        oDoneHead.addItem(oFoldIcon);
                                        oDoneHead.attachBrowserEvent("click", function () {
                                                if (!oStepsBox.getVisible() && !oLiveDone.getVisible()) {
                                                        return;   // 无阶段数据时不可展开
                                                }
                                                var bOpen = !oStepsWrap.getVisible();
                                                oStepsWrap.setVisible(bOpen);
                                                oFoldIcon.setSrc(bOpen ? "sap-icon://navigation-down-arrow" : "sap-icon://navigation-right-arrow");
                                        });
                                        var oDoneCard = new VBox({
                                                visible: "{= !${chat>requestPending} }"
                                        }).addStyleClass("agentThinkingCard agentDoneCard");
                                        oDoneCard.addItem(oDoneHead);
                                        oDoneCard.addItem(oStepsWrap);
                                        oCol.addItem(oDoneCard);
                                }

                                oCol.addItem(oBody);

                                // V1.3 → V16：附加区（数据集表格 + 工具条 + 用户生成的图表卡）。
                                // 不再自动画图；全部条目统一绑定 extraHtml，改动即局部刷新。
                                // 安全模型与 markdown 正文相同：动态文本先 escapeHtml，标签均由代码构造
                                oCol.addItem(new HTML({
                                        content: "{chat>extraHtml}",
                                        visible: "{= !!${chat>extraHtml} }",
                                        preferDOM: false,
                                        sanitizeContent: false
                                }));

                                // V16：内联确认卡（报表参数 / 意图澄清），宿主按消息 uid 登记
                                var oAskHost = new VBox({ visible: false }).addStyleClass("askHost");
                                this._mAskHosts = this._mAskHosts || {};
                                this._mAskHosts[oEntry.uid] = oAskHost;
                                this._renderEntryAsk(oAskHost, oEntry);
                                oCol.addItem(oAskHost);

                                // V16：报表运行步骤条（提交 → 执行中 → 结果就绪）
                                oCol.addItem(new HTML({
                                        content: "{chat>runHtml}",
                                        visible: "{= !!${chat>runHtml} }",
                                        preferDOM: false,
                                        sanitizeContent: false
                                }));

                                // 20261025：回复操作条（原标题行右侧只有一个复制键）
                                if (oEntry.copyable) {
                                        oCol.addItem(this._buildReplyBar(oEntry));
                                }

                                oCol.addStyleClass("aiContent");
                        }

                        var oRow;
                        if (bIsUser) {
                                oRow = new HBox({ justifyContent: "End" });
                                oRow.addItem(oCol);
                        } else {
                                // 与侧栏、登录页和首页共用彩色叶翼，按消息状态切换动效。
                                var oLogo = new LingXiMark({
                                        size: "32px",
                                        state: {
                                                parts: [
                                                        { path: "chat>waiting" }, { path: "chat>streaming" },
                                                        { path: "chat>requestPending" }, { path: "chat>runPhase" },
                                                        { path: "chat>avatarStopped" }
                                                ],
                                                formatter: LingXiState.message
                                        }
                                }).addStyleClass("chatAvatar avatarAI");
                                oRow = new HBox({ alignItems: "Start" });
                                oRow.addItem(oLogo);
                                oRow.addItem(oCol);
                        }
                        oRow.addStyleClass("chatRowInner");

                        var oItem = new CustomListItem({
                                content: [oRow]
                        }).addStyleClass(oEntry.rowClass || "chatRow");
                        if (oEntry.streaming) {
                                oItem.addStyleClass("chatRowStreaming");
                        }
                        // 20261025：刚发出的提问从输入框方向升起（只在发送后 1 秒内创建的条目上播一次；
                        // 播完换成 chatRowSettled = 不再带入场动画，之后重绘也不会重播）
                        if (bIsUser && oEntry.sentAt && Date.now() - oEntry.sentAt < 1000) {
                                oItem.addStyleClass("chatRowSent");
                                setTimeout(function () {
                                        if (!oItem.isDestroyed()) {
                                                oItem.addStyleClass("chatRowSettled");
                                        }
                                }, 900);
                        }
                        return oItem;
                },

                /* =========================================================
                 * 会话历史（左侧栏）：列表 / 打开 / 删除 / 折叠
                 * ========================================================= */

                /** 20261011（BE-09）：每个模式每次多加载的会话条数 */
                SESS_PAGE: 50,

                /** 会话行显示层规整：剥离角色前缀（V5.4）+ 置顶优先排序（V10，兜底兼容旧后端/演示模式） */
                _normSessRows: function (a) {
                        var that = this;
                        var aList = (a || []).filter(Boolean).map(function (o) {
                                return Object.assign({}, o, {
                                        Title: that._stripRolePrefix(o.Title),
                                        Pinned: o.Pinned || ""
                                });
                        });
                        aList.sort(function (x, y) {
                                var pX = x.Pinned === "X" ? 1 : 0, pY = y.Pinned === "X" ? 1 : 0;
                                if (pX !== pY) {
                                        return pY - pX;
                                }
                                return String(y.ChangedAt || "").localeCompare(String(x.ChangedAt || ""));
                        });
                        return aList;
                },

                /**
                  * 刷新左侧会话列表（V12：两种模式合并缓存，按当前模式过滤渲染）。
                  * 20261011（BE-09）：原来一次取前 100 条（两模式混合），更早的会话看不到；
                  * 现在按模式各取前 N 条（多取 1 条判断是否还有更早的），"加载更多"把 N 加一页
                  */
                _refreshSessions: function () {
                        var that = this;
                        var aModes = ["CHAT", "AGENT"];
                        this._mSessN = this._mSessN || { CHAT: this.SESS_PAGE, AGENT: this.SESS_PAGE };
                        this._mSessMore = this._mSessMore || {};
                        Promise.all(aModes.map(function (sMode) {
                                return ChatService.getSessions({ mode: sMode, top: that._mSessN[sMode] + 1 });
                        })).then(function (aRes) {
                                var aAll = [], oSeen = {};
                                aModes.forEach(function (sMode, i) {
                                        var aRows = that._normSessRows(aRes[i]);
                                        that._mSessMore[sMode] = aRows.length > that._mSessN[sMode];
                                        aRows.slice(0, that._mSessN[sMode]).forEach(function (s) {
                                                if (!oSeen[s.SessionId]) {
                                                        oSeen[s.SessionId] = true;
                                                        aAll.push(s);
                                                }
                                        });
                                });
                                that._aAllSessions = aAll;        // V12：跨模式缓存
                                that._oSessHits = null;           // 列表有变化：搜索结果按最新数据重查
                                that._applySessionFilter();
                                // V12：首次加载后恢复上次工作模式（仅一次）
                                if (!that._bStartupRestored) {
                                        that._bStartupRestored = true;
                                        that._restoreStartupWorkspace();
                                }
                        }).catch(function () {
                                that._aAllSessions = [];
                                that._mSessMore = {};
                                that.getView().getModel("session").setProperty("/sessions", []);
                                that._syncSessionHighlight();
                        });
                },

                /** 列表末尾"加载更多"：无搜索词时当前模式多加载一页；有搜索词时搜索结果多取一页 */
                onMoreSessions: function () {
                        if (this._sSessQuery) {
                                this._iSearchN = (this._iSearchN || this.SESS_PAGE) + this.SESS_PAGE;
                                this._oSessHits = null;
                                this._applySessionFilter();   // → 按新条数重新搜索
                                return;
                        }
                        this._mSessN[this._wsMode()] += this.SESS_PAGE;
                        this._refreshSessions();
                },

                /**
                  * V12：会话搜索（仅当前工作模式内按标题过滤；不跨模式混排）
                  * 20261011（BE-09）：先在已加载的会话里即时过滤，再查服务端（覆盖更早的会话）
                  */
                onSearchSession: function (oEvent) {
                        this._sSessQuery = (oEvent.getSource().getValue() || "").trim().toLowerCase();
                        this._iSearchN = this.SESS_PAGE;
                        this._applySessionFilter();
                },

                /** 服务端标题搜索（防抖 300ms；搜索词或模式已变时丢弃结果；服务端失败退回本地过滤） */
                _searchSessions: function () {
                        var that = this;
                        clearTimeout(this._iSessSearchTimer);
                        this._iSessSearchTimer = setTimeout(function () {
                                var sQ = that._sSessQuery;
                                var sMode = that._wsMode();
                                var iN = that._iSearchN || that.SESS_PAGE;
                                if (!sQ) {
                                        return;
                                }
                                var fnDone = function (aRows, bMore) {
                                        if (sQ !== that._sSessQuery || sMode !== that._wsMode()) {
                                                return;
                                        }
                                        that._oSessHits = { q: sQ, mode: sMode, rows: aRows.slice(0, iN), more: bMore };
                                        that._applySessionFilter();
                                };
                                ChatService.getSessions({ mode: sMode, top: iN + 1, search: sQ }).then(function (a) {
                                        var aRows = that._normSessRows(a);
                                        fnDone(aRows, aRows.length > iN);
                                }).catch(function () {
                                        fnDone(that._localSessions(sMode, sQ), false);
                                });
                        }, 300);
                },

                /**
                 * V10：重命名会话。仅改本地标题显示层与后端 ZAI_CHAT_SESS-TITLE，不动消息。
                 * 20261025：改为就地编辑（原先弹 UI5 输入对话框）—— 见 _startInlineRename
                 */
                onRenameSession: function (oEvent) {
                        this._startInlineRename(oEvent.getSource().data("sid"));
                },

                /** 按会话 ID 找侧栏列表里的条目控件 */
                _sessItemBySid: function (sSid) {
                        var oList = this.byId("sessionList");
                        return ((oList && oList.getItems()) || []).filter(function (o) {
                                return !!sSid && o.data("sid") === sSid;
                        })[0] || null;
                },

                /** 记一个"刚发生"的标记（置顶 / 撤销删除），列表重绘时 2.5 秒内还认 */
                _isRecentMark: function (oMark, sSid) {
                        return !!oMark && oMark.sid === sSid && Date.now() - oMark.at < 2500;
                },

                /**
                 * 20261025：会话标题就地改名 —— 标题位置换成输入框，回车 / 点别处保存，Esc 取消。
                 * 先改显示，后端失败再改回来。输入框里的点击、按键不冒泡到列表项（否则会当成"打开会话"）。
                 */
                _startInlineRename: function (sSid) {
                        var that = this;
                        var oRB = this._rb();
                        var oItem = this._sessItemBySid(sSid);
                        var oDom = oItem && oItem.getDomRef();
                        var oTitle = oDom && oDom.querySelector(".sessItemRow");
                        var oMeta = this._findSession(sSid) ||
                                (this.getView().getModel("session").getProperty("/sessions") || []).filter(function (s) {
                                        return s.SessionId === sSid;
                                })[0];
                        if (!oMeta || !oTitle || oDom.querySelector(".sessRenameInput")) {
                                return;
                        }
                        var sOld = oMeta.Title || "";
                        var oInp = document.createElement("input");
                        oInp.type = "text";
                        oInp.className = "sessRenameInput";
                        oInp.maxLength = 70;
                        oInp.value = sOld;
                        oInp.setAttribute("aria-label", oRB.getText("sessRename"));
                        oTitle.appendChild(oInp);   // 浮在标题那一行上（样式 .sessRenameInput）
                        oDom.classList.add("sessRenaming");
                        ["click", "mousedown", "mouseup", "dblclick", "keyup", "keypress", "touchstart"].forEach(function (s) {
                                oInp.addEventListener(s, function (e) { e.stopPropagation(); });
                        });
                        var bDone = false;
                        var fnEnd = function (bSave) {
                                if (bDone) {
                                        return;
                                }
                                bDone = true;
                                var sNew = (oInp.value || "").trim();
                                if (oInp.parentNode) {
                                        oInp.parentNode.removeChild(oInp);
                                }
                                oDom.classList.remove("sessRenaming");
                                if (!bSave || !sNew || sNew === sOld) {
                                        return;
                                }
                                that._setSessionTitle(sSid, sNew);
                                ChatService.updateSession({ sessionId: sSid, title: sNew }).then(function () {
                                        that._flashSessItem(sSid);
                                }).catch(function (oErr) {
                                        that._setSessionTitle(sSid, sOld);
                                        MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                                });
                        };
                        oInp.addEventListener("keydown", function (e) {
                                e.stopPropagation();
                                if (e.isComposing || e.keyCode === 229) {
                                        return;   // 拼音还没上屏，回车 / Esc 归输入法
                                }
                                if (e.key === "Enter") {
                                        e.preventDefault();
                                        fnEnd(true);
                                } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        fnEnd(false);
                                }
                        });
                        oInp.addEventListener("blur", function () { fnEnd(true); });
                        oInp.focus();
                        oInp.select();
                },

                /** 改会话标题的显示层：缓存、搜索结果、侧栏条目、顶栏标题 */
                _setSessionTitle: function (sSid, sTitle) {
                        var oSessionModel = this.getView().getModel("session");
                        var aLists = [this._aAllSessions || [], (this._oSessHits && this._oSessHits.rows) || [],
                                oSessionModel.getProperty("/sessions") || []];
                        aLists.forEach(function (a) {
                                a.forEach(function (s) {
                                        if (s.SessionId === sSid) {
                                                s.Title = sTitle;
                                        }
                                });
                        });
                        var oItem = this._sessItemBySid(sSid);
                        var oText = oItem && oItem.data("titleCtrl");
                        if (oText) {
                                oText.setText(sTitle);
                        }
                        if (oSessionModel.getProperty("/currentId") === sSid) {
                                oSessionModel.setProperty("/title", sTitle);
                        }
                },

                /** 侧栏某一行轻闪一下（改名保存后） */
                _flashSessItem: function (sSid) {
                        var oItem = this._sessItemBySid(sSid);
                        var oDom = oItem && oItem.getDomRef();
                        if (!oDom) {
                                return;
                        }
                        oDom.classList.remove("sessItemFlash");
                        void oDom.offsetWidth;
                        oDom.classList.add("sessItemFlash");
                        setTimeout(function () { oDom.classList.remove("sessItemFlash"); }, 1200);
                },

                /** V10：置顶/取消置顶会话（后端 ZAI_CHAT_SESS-PINNED，仅本人会话）
                 *  20261025：不再弹"已置顶"提示 —— 列表重排后这一行轻闪、图钉弹一下 */
                onPinSession: function (oEvent) {
                        var that = this;
                        var oSrc = oEvent.getSource();
                        var sSid = oSrc.data("sid");
                        var bPinNow = oSrc.data("pinned") === "X";
                        ChatService.updateSession({
                                sessionId: sSid,
                                pinned: !bPinNow
                        }).then(function () {
                                that._oSessFlash = { sid: sSid, at: Date.now(), kind: bPinNow ? "unpin" : "pin" };
                                that._refreshSessions();
                        }).catch(function (oErr) {
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                        });
                },

                /** V5.4：剥离「【角色：xxx】」前缀（会话标题等显示层共用） */
                _stripRolePrefix: function (sText) {
                        return String(sText || "").replace(/^【角色：[^】]+】\r?\n?/, "");
                },

                /**
                 * V4.1「当前对话」高亮同步（强制器）
                 * 按 session>/currentId 在列表条目上切换 sessItemCurrent 样式类。
                 * 触发时机（四类变更点）：会话列表重绑定（updateFinished 事件，见 onInit）、
                 * 打开历史会话、新会话、发送消息后补写会话条目。
                 * （ListBase mode None 会回退 selected 属性，故用样式类而非选中态实现）
                 */
                _syncSessionHighlight: function () {
                        var oList = this.byId("sessionList");
                        if (!oList) {
                                return;
                        }
                        var sCurrent = this.getView().getModel("session").getProperty("/currentId") || "";
                        oList.getItems().forEach(function (oItem) {
                                oItem.toggleStyleClass("sessItemCurrent", !!sCurrent && oItem.data("sid") === sCurrent);
                        });
                },

                /** 会话列表项工厂：标题 + 时间 + 悬浮操作（置顶/重命名/删除，V10）
                 *  V12：Agent 会话显示模式图标与任务状态徽标 */
                sessionItemFactory: function (sId, oContext) {
                        var o = oContext.getObject();
                        var oRB = this._rb();   // V13 修复：置顶/重命名/删除按钮的 tooltip 依赖
                        // 20261011（BE-09）：列表末尾的"加载更多"占位行
                        if (o._more) {
                                return new CustomListItem({
                                        type: "Active",
                                        press: this.onMoreSessions.bind(this),
                                        content: [new Text({ text: oRB.getText("sessMore") }).addStyleClass("sessMoreText")]
                                }).addStyleClass("sessionItem sessMoreItem");
                        }
                        var bAgent = o.Mode === "AGENT";

                        var oBox = new VBox({ alignItems: "Start" }).addStyleClass("sessItemBox");

                        // V12/V13：Agent 会话标题行前置模式图标（对话会话保持原样）
                        var oTitleRow = new HBox({ alignItems: "Center" }).addStyleClass("sessTitleRow");
                        if (bAgent) {
                                oTitleRow.addItem(new sap.ui.core.Icon({
                                        src: "sap-icon://lightbulb"
                                }).addStyleClass("sessModeIcon"));
                        }
                        var oTitleText = new Text({ text: o.Title || o.SessionId, wrapping: true }).addStyleClass("sessItemTitle");
                        oTitleRow.addItem(oTitleText);
                        oBox.addItem(oTitleRow);

                        // V12：时间行；Agent 任务附带状态徽标（进行中/已完成/部分完成/失败）
                        var oTimeRow = new HBox({ alignItems: "Center" }).addStyleClass("sessTimeRow");
                        oTimeRow.addItem(new Text({ text: Formatter.formatTime(o.ChangedAt) }).addStyleClass("sessItemTime"));
                        // 20261011：Agent 会话场景标签（自动场景不显示）
                        var oSc = bAgent ? this._sceneDef(o.AgentType) : null;
                        if (oSc && oSc.key !== "AUTO") {
                                oTimeRow.addItem(new Text({ text: oSc.text }).addStyleClass("sessSceneTag scene-" + oSc.key));
                        }
                        if (bAgent) {
                                oTimeRow.addItem(new Text({
                                        text: this._agentStatusText(o.Status)
                                }).addStyleClass("agentStChip agentSt-" + (o.Status || "IDLE")));
                        }
                        oBox.addItem(oTimeRow);

                        // V10：置顶（已置顶的图钉常亮）
                        var oPin = new Button({
                                icon: "sap-icon://pushpin-off",
                                type: "Transparent",
                                tooltip: oRB.getText("sessPin"),
                                press: this.onPinSession.bind(this)
                        }).addStyleClass("sessPinBtn");
                        oPin.data("sid", o.SessionId);
                        oPin.data("pinned", o.Pinned || "");
                        if (o.Pinned === "X") {
                                oPin.setIcon("sap-icon://pushpin-on");
                                oPin.addStyleClass("pinned");
                                oPin.setTooltip(oRB.getText("sessUnpin"));
                        }

                        // V10：重命名
                        var oRename = new Button({
                                icon: "sap-icon://edit",
                                type: "Transparent",
                                tooltip: oRB.getText("sessRename"),
                                press: this.onRenameSession.bind(this)
                        });
                        oRename.data("sid", o.SessionId);

                        var oDel = new Button({
                                icon: "sap-icon://delete",
                                type: "Transparent",
                                tooltip: oRB.getText("delSess"),
                                press: this.onDeleteSession.bind(this)
                        }).addStyleClass("sessDelBtn");
                        oDel.data("sid", o.SessionId);

                        var oActions = new HBox({ alignItems: "Center" }).addStyleClass("sessActions");
                        oActions.addItem(oPin);
                        oActions.addItem(oRename);
                        oActions.addItem(oDel);

                        var oRow = new HBox({ alignItems: "Center" }).addStyleClass("sessItemRow");
                        // 注意: 新版 UI5(1.15x) 移除了 addLayoutData，统一使用 setLayoutData
                        oBox.setLayoutData(new FlexItemData({ growFactor: 1 }));
                        oRow.addItem(oBox);
                        oRow.addItem(oActions);

                        var oItem = new CustomListItem({
                                type: "Active",
                                press: this.onSessionPress.bind(this),
                                content: [oRow]
                        }).addStyleClass("sessionItem");
                        oItem.data("sid", o.SessionId);
                        oItem.data("titleCtrl", oTitleText);
                        // 20261025：双击标题就地改名（按钮区里的双击不算）
                        var that = this;
                        oItem.attachBrowserEvent("dblclick", function (oEv) {
                                if (oEv.target && oEv.target.closest && oEv.target.closest(".sessActions, .sessRenameInput")) {
                                        return;
                                }
                                that._startInlineRename(o.SessionId);
                        });
                        // V10：置顶条目加左侧竖条样式
                        if (o.Pinned === "X") {
                                oItem.addStyleClass("sessItemPinned");
                        }
                        // 20261025：刚置顶 / 撤销删除回来的那一行轻闪一下，眼睛好找；图钉弹一下
                        if (this._isRecentMark(this._oSessFlash, o.SessionId)) {
                                oItem.addStyleClass(this._oSessFlash.kind === "back" ? "sessItemBack" : "sessItemFlash");
                                if (this._oSessFlash.kind === "pin") {
                                        oPin.addStyleClass("sessPinPop");
                                }
                        }
                        // V4.1「当前对话」高亮：工厂期按 session>/currentId 打标。
                        // 说明：ListBase 在 mode None 下会强制回退条目的 selected 属性
                        // （绑定/编程式设置均不生效），故用样式类 sessItemCurrent 实现，
                        // 运行期由 _syncSessionHighlight 统一切换（见其注释）。
                        var sCurId = this.getView().getModel("session").getProperty("/currentId");
                        if (sCurId && sCurId === o.SessionId) {
                                oItem.addStyleClass("sessItemCurrent");
                        }
                        return oItem;
                },

                /** 打开历史会话（V12：以会话自身 Mode 恢复工作模式，不全局覆盖） */
                onSessionPress: function (oEvent) {
                        var sSid = oEvent.getSource().data("sid");
                        if (!sSid) {
                                return;
                        }
                        var oMeta = this._findSession(sSid);
                        if (!oMeta) {
                                return;
                        }
                        this._restoreWorkspaceBySession(oMeta);
                        this._loadHistoryFor(sSid, oMeta.Mode === "AGENT");
                },

                /** 删除会话（20261025：先收起 + 5 秒内可撤销，替换原确认框；见 _deleteWithUndo） */
                onDeleteSession: function (oEvent) {
                        var sSid = oEvent.getSource().data("sid");
                        if (sSid) {
                                this._deleteWithUndo(sSid);
                        }
                },

                /** 删除后可撤销的时长 */
                UNDO_DELETE_MS: 5000,

                /**
                 * 20261025：删除会话 = 这一行先收起、底部出「已删除 · 撤销」卡片，到时才真正调后端删除。
                 * - 期间再删别的会话，上一条立即生效（同一时间只有一条待删）；
                 * - 删的是当前会话：主区先切到空会话，撤销时再打开回来（真正删除前消息缓存都还在）；
                 * - 关闭 / 刷新页面时，待删的那条立即提交（请求可能来不及发出，最坏是会话没删掉）。
                 */
                _deleteWithUndo: function (sSid) {
                        var that = this;
                        var oRB = this._rb();
                        if (this._oPendingDel) {
                                this._oPendingDel.toast.commit();
                        }
                        var oMeta = this._findSession(sSid) || {};
                        var sTitle = this._stripRolePrefix(oMeta.Title || "");
                        var oPend = { sid: sSid, state: "pending", switched: false };
                        this._oPendingDel = oPend;
                        this._mDelHidden = this._mDelHidden || {};

                        if (!this._bUndoFlushBound && typeof window !== "undefined" && window.addEventListener) {
                                this._bUndoFlushBound = true;
                                window.addEventListener("pagehide", function () {
                                        if (that._oPendingDel) {
                                                that._oPendingDel.toast.commit();
                                        }
                                });
                        }

                        var fnHide = function () {
                                if (oPend.state === "undone") {
                                        return;
                                }
                                that._mDelHidden[sSid] = true;
                                that._applySessionFilter();
                                if (that.getView().getModel("session").getProperty("/currentId") === sSid) {
                                        oPend.switched = true;
                                        that._startNewSession();
                                }
                        };
                        // 行先收起（定住当前高度 → 0 + 淡出），再从列表里拿掉
                        var oItem = this._sessItemBySid(sSid);
                        var oDom = oItem && oItem.getDomRef();
                        if (oDom) {
                                oDom.style.height = oDom.offsetHeight + "px";
                                void oDom.offsetHeight;
                                oDom.classList.add("sessLeaving");
                                setTimeout(fnHide, 220);
                        } else {
                                fnHide();
                        }

                        oPend.toast = UndoToast.show({
                                text: sTitle ? oRB.getText("sessDeletedUndo", [sTitle]) : oRB.getText("sessDeletedPlain"),
                                actionText: oRB.getText("undo"),
                                duration: this.UNDO_DELETE_MS,
                                onAction: function () {
                                        if (oPend.state !== "pending") {
                                                return;
                                        }
                                        oPend.state = "undone";
                                        if (that._oPendingDel === oPend) {
                                                that._oPendingDel = null;
                                        }
                                        delete that._mDelHidden[sSid];
                                        that._oSessFlash = { sid: sSid, at: Date.now(), kind: "back" };
                                        that._applySessionFilter();
                                        if (oPend.switched) {
                                                that._loadSessionById(sSid);
                                        }
                                },
                                onTimeout: function () {
                                        if (oPend.state !== "pending") {
                                                return;
                                        }
                                        oPend.state = "done";
                                        if (that._oPendingDel === oPend) {
                                                that._oPendingDel = null;
                                        }
                                        ChatService.deleteSession(sSid).then(function () {
                                                delete that._mDelHidden[sSid];
                                                that._forgetSession(sSid);
                                                that._refreshSessions();
                                        }).catch(function (oErr) {
                                                // 没删成：这一行放回来
                                                delete that._mDelHidden[sSid];
                                                that._applySessionFilter();
                                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                                        });
                                }
                        });
                },

                /**
                  * 会话已删除：清掉各处对它的引用。
                  * 20261011：原先只比较 settings>/sessionId（对话会话），删除正打开的
                  * Agent 会话后界面仍停在原会话；改为以 session>/currentId 为准
                  */
                _forgetSession: function (sSid) {
                        var oSettings = this.getView().getModel("settings");
                        Object.keys(this._mRuns || {}).forEach(function (k) {
                                var oRun = this._mRuns[k];
                                if (oRun.sessionId === sSid) {
                                        this._stopRun("stopped", oRun);
                                        delete this._mRuns[k];
                                }
                        }, this);
                        if (this._mFocusArt) {
                                delete this._mFocusArt[sSid];
                        }
                        this._rrDropSession(sSid);   // DATA-01：本机记下的图表配置 / 运行号一并清掉
                        if (this.getView().getModel("session").getProperty("/currentId") === sSid) {
                                this._startNewSession();
                        }
                        if (this._mSessionMessages) { delete this._mSessionMessages[sSid]; }
                        // 另一模式记住的会话也可能就是它（列表只显示当前模式，正常不会发生）
                        ["CHAT", "AGENT"].forEach(function (sMode) {
                                if (this._mModeSession[sMode] === sSid) {
                                        this._mModeSession[sMode] = "";
                                }
                        }, this);
                        if (oSettings.getProperty("/agentSessionId") === sSid) {
                                oSettings.setProperty("/agentSessionId", "");
                                this._persistSettings();
                        }
                },

                /** 发送时确保当前会话出现在左侧列表（V12：携带模式/类型/状态） */
                _ensureSessionEntry: function (sSid, sFirstText, sMode, sAgentType, sStatus) {
                        var oSessionModel = this.getView().getModel("session");
                        var aSessions = oSessionModel.getProperty("/sessions") || [];
                        var oExist = aSessions.filter(function (s) { return s.SessionId === sSid; })[0];
                        if (!oExist) {
                                aSessions.unshift({
                                        SessionId: sSid,
                                        Title: sFirstText.length > 24 ? sFirstText.substring(0, 24) + "…" : sFirstText,
                                        ChangedAt: "",
                                        Mode: sMode === "AGENT" ? "AGENT" : "CHAT",
                                        AgentType: sMode === "AGENT" ? (sAgentType || "GENERAL") : "",
                                        Status: sStatus || "IDLE"
                                });
                                // V12：同步进全量缓存（切换模式后仍可见）
                                if (this._aAllSessions) {
                                        this._aAllSessions.unshift(Object.assign({}, aSessions[0]));
                                }
                                oSessionModel.setProperty("/sessions", aSessions);
                        } else if (sStatus) {
                                oExist.Status = sStatus;
                        }
                        oSessionModel.setProperty("/currentId", sSid);
                        this._syncSessionHighlight();
                        oSessionModel.setProperty("/title", this._stripRolePrefix((oExist && oExist.Title) || aSessions[0].Title || ""));
                },

                /**
                  * 布局状态（V13 两模式复用）：空状态(hero 居中输入) ↔ 消息列表+底部输入。
                  * hero 的标题/副标题/占位/泡泡显隐由 workspaceMode 驱动（见 _applyWorkspaceChrome）
                  */
                _setViewLayout: function (bList) {
                        var oChatModel = this.getView().getModel("chat");
                        if (!bList) {
                                this._syncHeroGreeting(!oChatModel.getProperty("/heroVisible"));
                        }
                        oChatModel.setProperty("/listVisible", !!bList);
                        oChatModel.setProperty("/heroVisible", !bList);
                        // V16：回到首页（新会话/空会话）→ 重渲染建议标签
                        if (!bList) {
                                this._renderHeroBubbles();
                        }
                },

                /** 侧栏折叠 / 展开（移动端为浮层） */
                onToggleSide: function () {
                        this.byId("sideBar").toggleStyleClass(
                                window.innerWidth <= 599 ? "sideOpen" : "sideHidden"
                        );
                },

                /**
                 * V6.0：明暗主题切换（Hermes 风格）
                 * 主题值持久化在 localStorage("zai.theme")，index.html 引导脚本
                 * 在 UI5 加载前读取并写入 <html data-theme>，避免刷新闪烁。
                 * 图标语义：当前暗色 → 显示 day-mode（点击切到亮色），反之亦然。
                 */
                onToggleTheme: function () {
                        var oRoot = document.documentElement;
                        var sNext = oRoot.getAttribute("data-theme") === "dark" ? "light" : "dark";
                        oRoot.setAttribute("data-theme", sNext);
                        try { localStorage.setItem("zai.theme", sNext); } catch (e) { /* 隐私模式忽略 */ }
                        this._syncThemeToggle();
                },

                /** V6.0：按当前主题同步切换按钮的图标与悬浮提示
                 *  图标用内联 SVG data-URI（SAP-icons v5 无日/月字形，字体图标会渲染成空），
                 *  与重设计原型的太阳/月亮造型一致 */
                _syncThemeToggle: function () {
                        var oBtn = this.byId("themeToggle");
                        if (!oBtn) { return; }
                        var bDark = document.documentElement.getAttribute("data-theme") === "dark";
                        var oI18n = this.getView().getModel("i18n").getResourceBundle();
                        oBtn.setIcon(bDark ? this._svgIcon("sun") : this._svgIcon("moon"));
                        oBtn.setTooltip(oI18n.getText(bDark ? "themeToLight" : "themeToDark"));
                },

                /** V6.0：主题切换按钮的 SVG 图标（stroke 跟随文本 token 色） */
                _svgIcon: function (sKind) {
                        var sStroke = document.documentElement.getAttribute("data-theme") === "dark"
                                ? "%23a8b4c6" : "%234a5a70";
                        var sPath = sKind === "sun"
                                ? "<circle cx='12' cy='12' r='4.4'/>" +
                                  "<path d='M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8'/>"
                                : "<path d='M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'/>";
                        var sSvg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' " +
                                "stroke='" + sStroke + "' stroke-width='1.8' stroke-linecap='round'>" + sPath + "</svg>";
                        return "data:image/svg+xml;charset=utf-8," + sSvg.replace(/#/g, "%23");
                },

                /** 顶部模式徽标 */
                _updateModeBadge: function () {
                        var sMode = this.getView().getModel("settings").getProperty("/mode");
                        var oBadge = this.byId("modeBadge");
                        if (!oBadge) {
                                return;
                        }
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        oBadge.setText(sMode === "backend" ? oRB.getText("modeBadgeBackend") : oRB.getText("modeBadgeMock"));
                        oBadge.setState(sMode === "backend" ? "Success" : "Information");
                },

                /* =========================================================
                 * V5：快捷指令（提示词模板，localStorage 持久化，可增删）
                 * ========================================================= */

                /** 内置默认快捷指令（首次进入或清空后使用） */
                _defaultQuickPrompts: function () {
                        return [
                                { title: "代码审查", prompt: "请对以下 ABAP 代码做代码审查，从性能、健壮性、安全、可读性四个维度逐条给出问题与改进建议：\n\n" },
                                { title: "性能优化", prompt: "请分析以下 ABAP 代码的性能瓶颈（SQL、内表操作、循环嵌套），并给出优化后的完整代码：\n\n" },
                                { title: "补充注释", prompt: "请为以下 ABAP 代码补充规范的中文注释（保持代码逻辑不变，输出完整代码）：\n\n" },
                                { title: "单元测试", prompt: "请为以下 ABAP 代码编写 ABAP Unit 测试（含边界场景），输出完整测试类：\n\n" },
                                { title: "写 ALV 报表", prompt: "请编写一个 ABAP ALV 报表：选择屏幕输入物料号与工厂，查询物料主数据与库存并展示，注意性能与用户体验，给出完整代码。" },
                                { title: "表结构设计", prompt: "我要设计一张 Z 开头的自定义表，用途如下（请补充）：\n请给出建议的字段清单（字段名/类型/长度/键/说明），以及数据元素与域的设计要点。" }
                        ];
                        },

                /** 从 localStorage 恢复；无记录则写入默认集（V5.4：同步重渲染首页泡泡） */
                /** V8：泡泡提示词经服务层加载（后端模式存后端 → 每次开新会话都有；
                 *  mock 模式落本浏览器，与旧格式 zaiChat-quickPrompts 兼容） */
                _loadQuickPrompts: function () {
                        var that = this;
                        ChatService.getPromptsData().then(function (aList) {
                                that.getView().getModel("chat").setProperty("/quickPrompts", (aList && aList.length) ? aList : that._defaultQuickPrompts());
                                that._renderHeroBubbles();
                        }).catch(function () {
                                that.getView().getModel("chat").setProperty("/quickPrompts", that._defaultQuickPrompts());
                                that._renderHeroBubbles();
                        });
                },

                /** 持久化泡泡（管理员改动后；同步重渲染首页泡泡） */
                _saveQuickPrompts: function () {
                        var aList = this.getView().getModel("chat").getProperty("/quickPrompts");
                        ChatService.savePromptsData(aList).catch(function (oErr) {
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                        });
                        this._renderHeroBubbles();
                },

                /**
                 * V5.5：首页快捷指令「泡泡」系统
                 * - 泡泡簇拥在欢迎标题四周（bubbleField 为绝对定位层，槽位见 style.css）
                 * - 点击泡泡：内容填入输入框 → 该泡泡淡出消失（按 prompt 文本记忆消耗，
                 *   增删/跨窗口同步导致的下标漂移不受影响）；回到首页时重置
                 * - V5.5：泡泡即点即消，移除悬浮 × 删除；＋ 泡泡新增保留，
                 *   数据源仍为 chat>/quickPrompts（localStorage）
                 */
                /**
                  * V16：首页建议标签（输入卡下方一行，替代 V5.5 漂浮泡泡 —— 泡泡遮挡标题、
                  * 矮屏/窄屏整层隐藏）。对话模式 = 快捷指令；Agent 模式 = 示例问题。
                  * 点击填入输入框并聚焦（不再消耗消失，可反复使用）；管理员保留"＋"新增。
                  */
                _renderHeroBubbles: function () {
                        var that = this;
                        var oField = this.byId("bubbleField");
                        if (!oField) {
                                return;
                        }
                        oField.destroyItems();
                        var oRB = this._rb();
                        var bAgent = this.getView().getModel("chat").getProperty("/workspaceMode") === "AGENT";
                        var oSc = bAgent ? this._sceneDef(this._curScene()) : null;
                        // 20261020：「报表执行」「Fiori 报表」首页是报表目录（CatalogPanel），不再放示例按钮
                        this._renderCatalog();
                        if (bAgent && this._skillHeroCards(oField)) { return; }
                        var aList = (bAgent && this._catScene(oSc.key)) ? [] : bAgent
                                ? ((oSc && oSc.chips.length)
                                        ? oSc.chips.map(function (s) { return { title: s, prompt: s }; })
                                        : [1, 2, 3, 4].map(function (i) {
                                                var s = oRB.getText("agentChip" + i);
                                                return { title: s, prompt: s };
                                        }))
                                : (this.getView().getModel("chat").getProperty("/quickPrompts") || []);
                        aList.slice(0, 8).forEach(function (oEntry) {
                                oField.addItem(new Button({
                                        text: oEntry.title,
                                        type: "Transparent",
                                        tooltip: oEntry.prompt.length > 40 ? oEntry.prompt.substring(0, 40) + "…" : oEntry.prompt,
                                        press: that._onBubblePress.bind(that, oEntry)
                                }).addStyleClass("heroChip"));
                        });
                        // ＋ 新增（V8：仅管理员可添加快捷指令；Agent 示例为内置）
                        if (!bAgent && ChatService.isAdmin()) {
                                oField.addItem(new Button({
                                        icon: "sap-icon://add",
                                        type: "Transparent",
                                        tooltip: oRB.getText("quickAddTitle"),
                                        press: that.onAddQuickPrompt.bind(that)
                                }).addStyleClass("heroChip heroChipAdd"));
                        }
                },

                /** 点击建议标签：填入输入框 → 聚焦（光标置末尾，可继续编辑） */
                _onBubblePress: function (oEntry) {
                        if (!oEntry || !(oEntry.prompt || "").length) {
                                return;
                        }
                        this.getView().getModel("chat").setProperty("/input", oEntry.prompt);
                        var oInput = this.byId("heroInput");
                        if (oInput && oInput.focus) {
                                oInput.focus();
                                setTimeout(function () {
                                        var oTa = oInput.getFocusDomRef();
                                        if (oTa && oTa.setSelectionRange) {
                                                oTa.setSelectionRange(oTa.value.length, oTa.value.length);
                                        }
                                }, 0);
                        }
                },

                /** 添加快捷指令：弹出小对话框（名称 + 内容），保存后立即生效 */
                onAddQuickPrompt: function () {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();

                        var oInputTitle = new sap.m.Input({ placeholder: oRB.getText("fldQpTitlePh"), maxLength: 20 });
                        var oInputPrompt = new sap.m.TextArea({
                                placeholder: oRB.getText("fldQpPromptPh"),
                                growing: true,
                                growingMaxLines: 6,
                                rows: 3,
                                width: "100%"
                        });

                        var oDialog = new sap.m.Dialog({
                                title: oRB.getText("quickAddTitle"),
                                contentWidth: "32rem",
                                // V5.2：自定义头部（标题 + 右上角 × 关闭）
                                customHeader: new sap.m.Toolbar({ design: "Transparent" })
                                        .addStyleClass("dlgHeadToolbar")
                                        .addContent(new sap.m.Title({ level: "H3", text: oRB.getText("quickAddTitle") }).addStyleClass("dlgHeadTitle"))
                                        .addContent(new sap.m.ToolbarSpacer())
                                        .addContent(new sap.m.Button({
                                                icon: "sap-icon://decline",
                                                type: "Transparent",
                                                tooltip: oRB.getText("cancel"),
                                                press: function () { oDialog.close(); }
                                        }).addStyleClass("dlgCloseBtn")),
                                content: [
                                        new sap.m.VBox({ class: "sapUiSmallMargin" }).addItem(
                                                new sap.m.Label({ text: oRB.getText("fldQpTitle"), required: true })
                                        ).addItem(oInputTitle).addItem(
                                                new sap.m.Label({ text: oRB.getText("fldQpPrompt"), required: true }).addStyleClass("sapUiSmallMarginTop")
                                        ).addItem(oInputPrompt).addItem(
                                                new sap.m.Text({ text: oRB.getText("quickAddHint"), wrapping: true }).addStyleClass("hintText")
                                        )
                                ],
                                beginButton: new sap.m.Button({
                                        text: oRB.getText("save"),
                                        type: "Emphasized",
                                        press: function () {
                                                var sTitle = (oInputTitle.getValue() || "").trim();
                                                var sPrompt = oInputPrompt.getValue() || "";
                                                if (!sTitle || !sPrompt.trim()) {
                                                        MessageToast.show(oRB.getText("qpRequired"));
                                                        return;
                                                }
                                                var oChat = that.getView().getModel("chat");
                                                var aList = oChat.getProperty("/quickPrompts") || [];
                                                aList.push({ title: sTitle, prompt: sPrompt });
                                                oChat.setProperty("/quickPrompts", aList);
                                                that._saveQuickPrompts();
                                                oDialog.close();
                                        }
                                }),
                                endButton: new sap.m.Button({
                                        text: oRB.getText("cancel"),
                                        press: function () { oDialog.close(); }
                                }),
                                afterClose: function () { oDialog.destroy(); }
                        });
                        oDialog.addStyleClass("qpDialog");
                        oDialog.open();
                },

                /* =========================================================
                 * V5.4：角色选择（可自定义增删，localStorage 持久化）
                 * 发送时以「【角色：xxx】」前缀拼进 Question 发给大模型；
                 * 界面气泡由 _buildEntry 统一剥离前缀、还原为用户原文。
                 * ========================================================= */

                /** 内置默认角色（首次进入或清空后使用；与清单一致的 {name} 结构） */
                _defaultRoles: function () {
                        return [
                                { name: "项目分析师" },
                                { name: "ABAP开发专家" },
                                { name: "功能顾问" },
                                { name: "测试工程师" }
                        ];
                },

                /** V8：角色经服务层加载（后端模式存后端 → 多会话/多端可选不同角色） */
                _loadRoles: function () {
                        var that = this;
                        var oChat = this.getView().getModel("chat");
                        ChatService.getRolesData().then(function (aSaved) {
                                oChat.setProperty("/roles", (aSaved && aSaved.length) ? aSaved : that._defaultRoles());
                                // 上次选中的角色可能已被（其他窗口/其他端）删除，失效则回退为不使用
                                var sRole = that._oStorage.get("role") || "";
                                var bAlive = (oChat.getProperty("/roles") || []).some(function (r) {
                                        return r.name === sRole;
                                });
                                oChat.setProperty("/currentRole", bAlive ? sRole : "");
                                that._refreshRoleCombos();
                        }).catch(function () {
                                oChat.setProperty("/roles", that._defaultRoles());
                                that._refreshRoleCombos();
                        });
                },

                _saveRoles: function () {
                        ChatService.saveRolesData(this.getView().getModel("chat").getProperty("/roles")).catch(function (oErr) {
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                        });
                },

                /** 首页与对话态两个下拉框统一刷新（首位固定「不使用角色」） */
                _refreshRoleCombos: function () {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var oChat = this.getView().getModel("chat");
                        ["roleSelectHero", "roleSelectDock"].forEach(function (sId) {
                                var oCombo = that.byId(sId);
                                if (!oCombo) {
                                        return;
                                }
                                oCombo.removeAllItems();
                                oCombo.addItem(new Item({ key: "", text: oRB.getText("roleNone") }));
                                (oChat.getProperty("/roles") || []).forEach(function (r) {
                                        oCombo.addItem(new Item({ key: r.name, text: r.name }));
                                });
                                oCombo.setSelectedKey(oChat.getProperty("/currentRole") || "");
                        });
                },

                /** 切换角色：持久化并提示 */
                onRoleChange: function (oEvent) {
                        var sKey = oEvent.getSource().getSelectedKey() || "";
                        this.getView().getModel("chat").setProperty("/currentRole", sKey);
                        this._oStorage.put("role", sKey);
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        MessageToast.show(sKey ? oRB.getText("roleChanged") + sKey : oRB.getText("roleCleared"));
                },

                /** 角色管理对话框：清单增删（程序化构建，保存即生效） */
                onOpenRoleManage: function () {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        // V8：管理员可增删；普通用户只读查看
                        var bAdmin = ChatService.isAdmin();

                        var oInput = new sap.m.Input({
                                placeholder: oRB.getText("roleAddPh"),
                                maxLength: 20,
                                width: "100%"
                        });
                        var oListBox = new VBox().addStyleClass("roleList");

                        var fnRefreshList = function () {
                                oListBox.destroyItems();
                                (that.getView().getModel("chat").getProperty("/roles") || []).forEach(function (r, i) {
                                        var oRow = new HBox({ alignItems: "Center" }).addStyleClass("roleRow")
                                                .addItem(new Text({ text: r.name }).addStyleClass("roleName"));
                                        if (bAdmin) {
                                                oRow.addItem(new Button({
                                                        icon: "sap-icon://decline",
                                                        type: "Transparent",
                                                        tooltip: oRB.getText("delQuick"),
                                                        press: function () {
                                                                var oChat = that.getView().getModel("chat");
                                                                var aList = oChat.getProperty("/roles") || [];
                                                                aList.splice(i, 1);
                                                                oChat.setProperty("/roles", aList);
                                                                // 删掉的正是当前选中角色 → 回退为不使用
                                                                if (oChat.getProperty("/currentRole") === r.name) {
                                                                        oChat.setProperty("/currentRole", "");
                                                                }
                                                                that._saveRoles();
                                                                that._refreshRoleCombos();
                                                                fnRefreshList();
                                                                MessageToast.show(oRB.getText("roleDeleted"));
                                                        }
                                                }).addStyleClass("chipDel"));
                                        }
                                        oListBox.addItem(oRow);
                                });
                        };
                        fnRefreshList();

                        var fnAddRole = function () {
                                var sName = (oInput.getValue() || "").trim();
                                if (!sName) {
                                        MessageToast.show(oRB.getText("roleRequired"));
                                        return;
                                }
                                var oChat = that.getView().getModel("chat");
                                var aList = oChat.getProperty("/roles") || [];
                                if (aList.some(function (r) { return r.name === sName; })) {
                                        MessageToast.show(oRB.getText("roleExists"));
                                        return;
                                }
                                aList.push({ name: sName });
                                oChat.setProperty("/roles", aList);
                                that._saveRoles();
                                that._refreshRoleCombos();
                                fnRefreshList();
                                oInput.setValue("");
                                MessageToast.show(oRB.getText("roleAdded"));
                        };

                        var oDialogContent = new sap.m.VBox({ class: "sapUiSmallMargin" })
                                .addItem(new sap.m.Text({
                                        text: bAdmin ? oRB.getText("roleManageHintAdmin") : oRB.getText("roleManageHintUser"),
                                        wrapping: true
                                }).addStyleClass("hintText"))
                                .addItem(oListBox);
                        if (bAdmin) {
                                oDialogContent.addItem(new HBox({ alignItems: "Center" }).addStyleClass("sapUiSmallMarginTop")
                                        .addItem(oInput)
                                        .addItem(new sap.m.Button({
                                                text: oRB.getText("roleAdd"),
                                                type: "Emphasized",
                                                press: fnAddRole
                                        })));
                        }

                        var oDialog = new sap.m.Dialog({
                                title: oRB.getText("roleManageTitle"),
                                contentWidth: "24rem",
                                customHeader: new sap.m.Toolbar({ design: "Transparent" })
                                        .addStyleClass("dlgHeadToolbar")
                                        .addContent(new sap.m.Title({ level: "H3", text: oRB.getText("roleManageTitle") }).addStyleClass("dlgHeadTitle"))
                                        .addContent(new sap.m.ToolbarSpacer())
                                        .addContent(new sap.m.Button({
                                                icon: "sap-icon://decline",
                                                type: "Transparent",
                                                tooltip: oRB.getText("cancel"),
                                                press: function () { oDialog.close(); }
                                        }).addStyleClass("dlgCloseBtn")),
                                content: oDialogContent,
                                beginButton: new sap.m.Button({
                                        text: oRB.getText("close"),
                                        press: function () { oDialog.close(); }
                                }),
                                afterClose: function () { oDialog.destroy(); }
                        });
                        oDialog.addStyleClass("roleDialog");
                        oDialog.open();
                },

                /**
                  * 构造气泡条目（Markdown → HTML 在此完成）
                  * @param {string} sRole user | assistant | error
                  * @param {string} sText  内容（Markdown）
                  * @param {string} sTime  ABAP 14 位时间（空取当前）
                  * @param {string} sMeta  元信息（对象/耗时）
                  * （V13：Agent 过程摘要由 _attachAgentProcess 以整条目替换方式附加，
                  *   不再经由本方法的第 5 参数）
                  */
                _buildEntry: function (sRole, sText, sTime, sMeta) {
                        var oRB = this._rb();
                        // V5.4：剥离「【角色：xxx】」前缀 —— 后端存文/历史回读均带前缀，
                        // 界面气泡与导出一律还原为用户原文，角色名转入 meta 展示位
                        if (sRole === "user") {
                                var mRole = /^【角色：([^】]+)】\r?\n?/.exec(sText || "");
                                if (mRole) {
                                        sMeta = (sMeta ? sMeta + " · " : "") + oRB.getText("rolePrefix") + mRole[1];
                                        sText = (sText || "").slice(mRole[0].length);
                                }
                        }
                        // 20261024：meta 里的「技能：名称 vN」单独取出，渲染成蓝色技能标签（设计稿 05）
                        var sSkillTag = "";
                        var mSkill = /(?:^|\s·\s)技能：([^·]+?)(?=\s·\s|$)/.exec(sMeta || "");
                        if (mSkill) {
                                sSkillTag = mSkill[1].trim();
                                sMeta = (sMeta || "").replace(mSkill[0], "").replace(/^\s·\s/, "").trim();
                        }
                        var sSender = sRole === "user" ? oRB.getText("me") : oRB.getText("ai");
                        return {
                                skillTag: sSkillTag,
                                // V16：稳定标识（数据工具条/内联卡片/运行步骤条按 uid 定位条目，不依赖下标）
                                uid: "m" + this._newSessionId().substring(0, 12),
                                extraHtml: "",
                                runHtml: "",
                                ask: null,
                                waiting: false,
                                elapsedText: "",
                                role: sRole,
                                sender: sSender,
                                time: Formatter.formatTime(sTime),
                                meta: sMeta || "",
                                raw: sText,
                                html: sRole === "user"
                                        ? "<p>" + Formatter.escapeHtml(sText).replace(/\r?\n/g, "<br/>") + "</p>"
                                        : Formatter.sanitizeHtml(Formatter.markdownToHtml(sText)),
                                state: sRole,
                                align: sRole === "user" ? "End" : "Start",
                                rowClass: "chatRow chatRow" + sRole.charAt(0).toUpperCase() + sRole.slice(1),
                                bubbleClass: "chatBubble",
                                copyable: sRole !== "user"
                        };
                },

                /** 追加一条消息 */
                _pushEntry: function (sRole, sText, sMeta) {
                        this.getView().getModel("chat").getProperty("/messages").push(
                                this._buildEntry(sRole, sText, "", sMeta)
                        );
                },

                /** 刷新消息列表绑定 */
                _refreshMessages: function () {
                        var oChatModel = this.getView().getModel("chat");
                        // 通过重新赋值触发列表刷新（数组 push 不会自动通知）
                        oChatModel.setProperty("/messages", oChatModel.getProperty("/messages").slice());
                        var oState = this._sessionMessageState(this._sMessagesSession);
                        if (oState) {
                                oState.loaded = true;
                                oState.version++;
                        }
                },

                /**
                 * 消息区滚动到底部
                 * 直接设置 scrollTop（比 scrollToElement 动画更稳，
                 * 流式输出高频调用时不会产生动画队列堆积）
                 * @param {boolean} bImmediate 立即执行（流式帧内调用时为 true）
                 */
                _scrollToBottom: function (bImmediate) {
                        var that = this;

                        // 滚动修复兜底：UI5 为 chatScroll 自动包裹的 FlexItem 层默认
                        // min-height:auto（等于内容高度），会把布局撑破导致滚动区
                        // 跑出视口、滚轮失效。CSS 已用 :has() 处理，此处对不支持的
                        // 浏览器在首次滚动时补丁（此时消息区必然已渲染出 DOM）
                        if (!this._bWrapFixed) {
                                this._bWrapFixed = true;
                                var oSC = this.byId("chatScroll");
                                var oWrap = oSC && oSC.getDomRef() && oSC.getDomRef().parentElement;
                                if (oWrap) {
                                        oWrap.style.minHeight = "0";
                                        oWrap.style.overflow = "hidden";
                                }
                        }

                        var fnScroll = function () {
                                var oScroll = that.byId("chatScroll");
                                var oDom = oScroll && oScroll.getDomRef();
                                if (oDom) {
                                        oDom.scrollTop = oDom.scrollHeight;
                                }
                                // 顺带补绑顶栏滚动监听（hero → 对话态切换后 DOM 才出现）
                                that._bindTopBarScroll();
                        };
                        if (bImmediate) {
                                fnScroll();
                        } else {
                                setTimeout(fnScroll, 80);
                        }
                },

                /* =========================================================
                 * 界面事件：复制 / 导出会话 / 停止 / 切换模型 / 新会话 / 测试模型
                 * ========================================================= */

                /**
                 * V5：导出当前会话为 Markdown 文件（浏览器本地生成，无后端依赖）。
                 * 结构：会话标题 + 元信息（模型/时间/条数）+ 按角色分节的完整原文。
                 */
                onExportSession: function () {
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var oChatModel = this.getView().getModel("chat");
                        var aMsgs = oChatModel.getProperty("/messages") || [];

                        var aValid = aMsgs.filter(function (m) {
                                return (m.role === "user" || m.role === "assistant") && (m.raw || "").trim();
                        });
                        if (!aValid.length) {
                                MessageToast.show(oRB.getText("exportEmpty"));
                                return;
                        }

                        var sTitle = this.getView().getModel("session").getProperty("/title")
                                || (aValid[0].raw || "").substring(0, 30);
                        var sModel = oChatModel.getProperty("/currentModel") || "-";
                        var d = new Date();
                        var p = function (n) { return (n < 10 ? "0" : "") + n; };
                        var sStamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());

                        var aLines = [];
                        aLines.push("# " + sTitle);
                        aLines.push("");
                        aLines.push(oRB.getText("exportMdMeta", [sModel, sStamp.replace("_", " "), aValid.length]));
                        aLines.push("");
                        aLines.push("---");
                        aLines.push("");
                        aMsgs.forEach(function (m) {
                                if (m.role === "user") {
                                        aLines.push(oRB.getText("exportMdMe"));
                                } else if (m.role === "assistant") {
                                        aLines.push("### 🤖 " + oRB.getText("ai"));
                                } else {
                                        return; // error 提示不导出
                                }
                                if (!(m.raw || "").trim()) {
                                        return;
                                }
                                aLines.push("");
                                aLines.push(m.raw);
                                aLines.push("");
                        });

                        var sMd = aLines.join("\n");
                        var oBlob = new Blob([sMd], { type: "text/markdown;charset=utf-8" });
                        var sUrl = URL.createObjectURL(oBlob);
                        var oLink = document.createElement("a");
                        oLink.href = sUrl;
                        oLink.download = oRB.getText("exportMdFile", [sStamp]);
                        document.body.appendChild(oLink);
                        oLink.click();
                        document.body.removeChild(oLink);
                        setTimeout(function () { URL.revokeObjectURL(sUrl); }, 1000);
                        MessageToast.show(oRB.getText("exportDone"));
                },

                /** 导出当前会话中动态 SQL 产生的数据集为 CSV。 */
                onExportCsv: function () {
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var aMsgs = this.getView().getModel("chat").getProperty("/messages") || [];
                        var aBlocks = [];
                        aMsgs.forEach(function (m) {
                                (m.analysis && m.analysis.datasets || []).forEach(function (d) {
                                        if (d && d.status === "OK" && d.columns && d.rows && d.rows.length) {
                                                aBlocks.push(d);
                                        }
                                });
                        });
                        if (!aBlocks.length) {
                                MessageToast.show(oRB.getText("exportCsvEmpty"));
                                return;
                        }
                        var escCsv = function (v) {
                                var s = v === null || v === undefined ? "" : String(v);
                                return /[\",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
                        };
                        var aLines = [];
                        aBlocks.forEach(function (d, idx) {
                                if (idx) { aLines.push(""); }
                                aLines.push(escCsv(oRB.getText("exportCsvDataset")) + "," + escCsv(d.name || oRB.getText("exportCsvDefaultName")));
                                aLines.push((d.columns || []).map(function (c) { return escCsv(c.label || c.name); }).join(","));
                                (d.rows || []).forEach(function (row) {
                                        aLines.push((d.columns || []).map(function (_, i) { return escCsv(row[i]); }).join(","));
                                });
                        });
                        var sStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
                        var oBlob = new Blob(["\uFEFF" + aLines.join("\r\n")], { type: "text/csv;charset=utf-8" });
                        var sUrl = URL.createObjectURL(oBlob);
                        var oLink = document.createElement("a");
                        oLink.href = sUrl;
                        oLink.download = oRB.getText("exportCsvFile", [sStamp]);
                        document.body.appendChild(oLink);
                        oLink.click();
                        document.body.removeChild(oLink);
                        setTimeout(function () { URL.revokeObjectURL(sUrl); }, 1000);
                        MessageToast.show(oRB.getText("exportCsvDone"));
                },

                /* =========================================================
                 * 20261025：回复操作条 —— 复制 / 重新生成 / 有帮助 / 没帮助
                 * 鼠标移到回复上浮出，最后一条回复常显（CSS：列表最后一项）；
                 * 「重新生成」只在最后一条回复上出现（同样由 CSS 控制），点了把上一条提问再发一次
                 * ========================================================= */

                _buildReplyBar: function (oEntry) {
                        var oRB = this._rb();
                        if (oEntry.fb === undefined) {
                                oEntry.fb = this._replyRateLoad()[this._replyRateKey(oEntry)] || "";
                        }
                        // 生成中 / 等待中不出操作条；被停止、还没出字的回复也不出
                        var oBar = new HBox({
                                alignItems: "Center",
                                visible: "{= !${chat>streaming} && !${chat>waiting} && !${chat>requestPending} && !!${chat>raw} }"
                        }).addStyleClass("replyBar" + (oEntry.fb ? " replyRated" : ""));
                        var fnBtn = function (sIcon, sTip, fnPress, sClass) {
                                return new Button({ icon: sIcon, type: "Transparent", tooltip: sTip, press: fnPress })
                                        .addStyleClass("replyBtn" + (sClass ? " " + sClass : ""));
                        };
                        oBar.addItem(fnBtn("sap-icon://copy", oRB.getText("replyCopy"), this._onReplyCopy.bind(this), "replyCopy"));
                        oBar.addItem(fnBtn("sap-icon://refresh", oRB.getText(oEntry.role === "error" ? "replyRetry" : "replyRegen"),
                                this._onReplyRegen.bind(this), "replyRegen"));
                        ["up", "down"].forEach(function (sVal) {
                                var oBtn = fnBtn("sap-icon://thumb-" + sVal, oRB.getText(sVal === "up" ? "replyGood" : "replyBad"),
                                        this._onReplyRate.bind(this, sVal), "replyRate" + (oEntry.fb === sVal ? " replyOn" : ""));
                                oBtn.data("rate", sVal);
                                oBar.addItem(oBtn);
                        }, this);
                        return oBar;
                },

                /** 操作条按钮所在的消息条目（按绑定上下文取，不依赖下标） */
                _replyEntryOf: function (oCtrl) {
                        var oCtx = oCtrl && oCtrl.getBindingContext && oCtrl.getBindingContext("chat");
                        return oCtx ? oCtx.getObject() : null;
                },

                /** 复制整条回复：图标就地变 ✓（绿色）1.4 秒，不再弹底部提示 */
                _onReplyCopy: function (oEvent) {
                        var oBtn = oEvent.getSource();
                        var oEntry = this._replyEntryOf(oBtn);
                        var sText = (oEntry && oEntry.raw) || "";
                        var oRB = this._rb();
                        var that = this;
                        var fnOk = function () {
                                clearTimeout(oBtn._iCopyTimer);
                                oBtn.setIcon("sap-icon://accept");
                                oBtn.setTooltip(oRB.getText("replyCopied"));
                                oBtn.addStyleClass("replyOk");
                                oBtn._iCopyTimer = setTimeout(function () {
                                        if (oBtn.isDestroyed()) {
                                                return;
                                        }
                                        oBtn.setIcon("sap-icon://copy");
                                        oBtn.setTooltip(oRB.getText("replyCopy"));
                                        oBtn.removeStyleClass("replyOk");
                                }, 1400);
                        };
                        // 剪贴板接口不可用 / 被拒（非 https、页面没焦点）时走旧式复制，成功同样就地打勾
                        var fnLegacy = function () {
                                if (that._copyQuiet(sText)) {
                                        fnOk();
                                } else {
                                        MessageToast.show(oRB.getText("copyFail"));
                                }
                        };
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(sText).then(fnOk).catch(fnLegacy);
                        } else {
                                fnLegacy();
                        }
                },

                /** 旧式复制（隐藏 textarea + execCommand），不弹提示；返回是否成功 */
                _copyQuiet: function (sText) {
                        var oTA = document.createElement("textarea");
                        oTA.value = sText;
                        oTA.setAttribute("readonly", "");
                        oTA.style.position = "fixed";
                        oTA.style.opacity = "0";
                        document.body.appendChild(oTA);
                        oTA.select();
                        var bOk = false;
                        try {
                                bOk = document.execCommand("copy");
                        } catch (e) {
                                bOk = false;
                        }
                        document.body.removeChild(oTA);
                        return bOk;
                },

                /**
                 * 重新生成：把这条回复之前的那条提问原样再发一次（新的一轮，带「重新生成」标记）。
                 * 只认最后一轮；生成中不响应。提问原文优先用发送时记下的 question
                 * （含角色前缀、附件内容），历史里读回来的按显示文本 + 角色还原
                 */
                _onReplyRegen: function (oEvent) {
                        var oChat = this.getView().getModel("chat");
                        if (oChat.getProperty("/busy")) {
                                return;
                        }
                        var oBtn = oEvent.getSource();
                        var oEntry = this._replyEntryOf(oBtn);
                        var aMsgs = oChat.getProperty("/messages") || [];
                        var iAt = aMsgs.indexOf(oEntry);
                        if (iAt < 0) {
                                return;
                        }
                        for (var j = iAt + 1; j < aMsgs.length; j++) {
                                if (aMsgs[j].role === "user") {
                                        return;   // 后面已经有新提问了，不是最后一轮
                                }
                        }
                        var oUser = null;
                        for (var i = iAt - 1; i >= 0; i--) {
                                if (aMsgs[i].role === "user") {
                                        oUser = aMsgs[i];
                                        break;
                                }
                        }
                        if (!oUser || !oUser.raw) {
                                return;
                        }
                        var oDom = oBtn.getDomRef();
                        if (oDom) {
                                oDom.classList.remove("replySpin");
                                void oDom.offsetWidth;
                                oDom.classList.add("replySpin");
                        }
                        var oCtx = oChat.getProperty("/currentSession") || {};
                        this._flySendPlane();
                        this._executeSend({
                                mode: oCtx.mode === "AGENT" ? "AGENT" : "CHAT",
                                agentType: oCtx.agentType || "",
                                displayText: oUser.raw,
                                meta: this._rb().getText("regenMeta"),
                                question: oUser.question || this._questionOf(oUser),
                                keepInput: true    // 不动输入框里写了一半的内容和附件
                        });
                },

                /** 历史里读回来的提问：显示文本 + meta 里的角色还原成发给后端的原文 */
                _questionOf: function (oUser) {
                        var sPrefix = this._rb().getText("rolePrefix");
                        var sMeta = oUser.meta || "";
                        var iAt = sMeta.indexOf(sPrefix);
                        if (iAt < 0) {
                                return oUser.raw;
                        }
                        var sRole = sMeta.slice(iAt + sPrefix.length).split(" · ")[0].trim();
                        return sRole ? "【角色：" + sRole + "】\n" + oUser.raw : oUser.raw;
                },

                /** 有帮助 / 没帮助：再点一次取消；只记在本机浏览器（后端暂无反馈字段） */
                _onReplyRate: function (sVal, oEvent) {
                        var oBtn = oEvent.getSource();
                        var oEntry = this._replyEntryOf(oBtn);
                        if (!oEntry) {
                                return;
                        }
                        var sNew = oEntry.fb === sVal ? "" : sVal;
                        oEntry.fb = sNew;
                        this._replyRateSave(this._replyRateKey(oEntry), sNew);
                        var oBar = oBtn.getParent();
                        oBar.toggleStyleClass("replyRated", !!sNew);
                        oBar.getItems().forEach(function (b) {
                                if (b.data("rate")) {
                                        b.toggleStyleClass("replyOn", b.data("rate") === sNew);
                                }
                        });
                        var oDom = oBtn.getDomRef();
                        if (oDom && sNew) {
                                oDom.classList.remove("replyPop");
                                void oDom.offsetWidth;
                                oDom.classList.add("replyPop");
                        }
                },

                REPLY_RATE_KEY: "zaiChat.replyRate",
                REPLY_RATE_MAX: 500,

                /** 评价按"会话 + 回复内容"记（历史回读后条目 uid 会变，内容不变） */
                _replyRateKey: function (oEntry) {
                        var s = String((oEntry && oEntry.raw) || "");
                        var h = 5381;
                        for (var i = 0; i < s.length; i++) {
                                h = ((h << 5) + h + s.charCodeAt(i)) | 0;
                        }
                        return (this._sMessagesSession || "") + "|" + (h >>> 0).toString(36) + "." + s.length;
                },

                _replyRateLoad: function () {
                        try {
                                return JSON.parse(window.localStorage.getItem(this.REPLY_RATE_KEY) || "{}") || {};
                        } catch (e) {
                                return {};
                        }
                },

                _replyRateSave: function (sKey, sVal) {
                        try {
                                var m = this._replyRateLoad();
                                if (sVal) {
                                        m[sKey] = sVal;
                                } else {
                                        delete m[sKey];
                                }
                                var aKeys = Object.keys(m);
                                if (aKeys.length > this.REPLY_RATE_MAX) {
                                        aKeys.slice(0, aKeys.length - this.REPLY_RATE_MAX).forEach(function (k) { delete m[k]; });
                                }
                                window.localStorage.setItem(this.REPLY_RATE_KEY, JSON.stringify(m));
                        } catch (e) { /* 存不了就只在本页生效 */ }
                },

                /** 剪贴板兼容降级方案 */
                _copyFallback: function (sText, oRB) {
                        var oTA = document.createElement("textarea");
                        oTA.value = sText;
                        oTA.style.position = "fixed";
                        oTA.style.opacity = "0";
                        document.body.appendChild(oTA);
                        oTA.select();
                        try {
                                document.execCommand("copy");
                                MessageToast.show(oRB.getText("toastCopied"));
                        } catch (e) {
                                MessageToast.show(oRB.getText("copyFail"));
                        }
                        document.body.removeChild(oTA);
                },

                /** 新会话（V13：随当前模式直接新建 —— CHAT=新对话；AGENT=新通用 Agent 会话） */
                onNewSession: function () {
                        this._startNewSession();
                        // 20261025：不再弹「已开始新会话」—— 画面本身就切到了空会话首页；
                        // 首页内容依次浮现，灵犀叶翼展开一次打招呼（_playHeroEnter）。
                        this._playHeroEnter();
                },

                /**
                 * 新会话首页入场：标题与输入区依次浮现，灵犀叶翼展开一次（lingxiMark--greet）。
                 * 从对话态切回首页时首页是重新渲染出来的，可能晚一拍甚至渲染两次，所以除了马上试一次，
                 * 首页渲染完成（onAfterRendering）时只要离点击不到 0.6 秒也补上
                 */
                _playHeroEnter: function () {
                        var that = this;
                        var oHero = this.byId("hero");
                        if (!oHero || typeof document === "undefined") {
                                return;
                        }
                        this._iHeroEnterAt = Date.now();
                        if (!this._bHeroEnterHooked) {
                                this._bHeroEnterHooked = true;
                                oHero.addEventDelegate({
                                        onAfterRendering: function () {
                                                if (Date.now() - (that._iHeroEnterAt || 0) < 600) {
                                                        that._applyHeroEnter();
                                                }
                                        }
                                });
                        }
                        setTimeout(this._applyHeroEnter.bind(this), 0);
                },

                _applyHeroEnter: function () {
                        var oDom = this.byId("hero") && this.byId("hero").getDomRef();
                        if (!oDom) {
                                return;
                        }
                        oDom.classList.remove("heroEnter");
                        void oDom.offsetWidth;
                        oDom.classList.add("heroEnter");
                        var oMark = oDom.querySelector(".heroMark");
                        if (oMark) {
                                oMark.classList.remove("lingxiMark--greet");
                                void oMark.offsetWidth;
                                oMark.classList.add("lingxiMark--greet");
                        }
                        clearTimeout(this._iHeroEnterTimer);
                        this._iHeroEnterTimer = setTimeout(function () {
                                oDom.classList.remove("heroEnter");
                                if (oMark) {
                                        oMark.classList.remove("lingxiMark--greet");
                                }
                        }, 3300);
                },

                /** 切到当前工作模式下的一个空会话（新建 / 删除当前会话后复位） */
                _startNewSession: function () {
                        // 中断进行中的流式输出
                        this._releaseBusy();
                        var oSession = this.getView().getModel("session");
                        var oChat = this.getView().getModel("chat");

                        var sNew = this._newSessionId();
                        var bAgentNew = oChat.getProperty("/workspaceMode") === "AGENT";
                        this._setSessionContext({
                                id: sNew,
                                mode: bAgentNew ? "AGENT" : "CHAT",
                                agentType: bAgentNew ? this._lastScene() : "",   // 20261011：新任务默认上次的场景
                                status: "IDLE"
                        });
                        oSession.setProperty("/currentId", sNew);
                        this._syncSessionHighlight();
                        oSession.setProperty("/title", "");
                        oChat.setProperty("/messages", []);
                        oChat.setProperty("/input", "");
                        // 新会话没有任务：清掉上一个会话的任务徽标（删除当前会话后也走这里）
                        oChat.setProperty("/currentTask", null);
                        oChat.setProperty("/taskBadge", "");
                        this._setViewLayout(false);
                        this._applyWorkspaceChrome();   // 20261011：场景选择条 / 文案随新会话刷新
                },

                /* =========================================================
                 * V15：多业务任务区（当前任务/参数表单/报表运行轮询）
                 * 原则：前端只展示后端确认的状态，不决定权限/白名单/
                 * 报表存在性/运行成功与否；轮询按 runId+会话归属写入，
                 * 不把结果写进其他任务；轮询独立于聊天 busy
                 * ========================================================= */

                /** 任务徽标文案（模块中文名 + 状态；i18n taskMod_<模块>，未登记的原样显示） */
                _taskModuleLabel: function (sModule) {
                        return (sModule && this._rb().getText("taskMod_" + sModule, undefined, true)) || sModule || "";
                },

                _taskStateColor: function (sSts) {
                        var aMap = {
                                COMPLETED: "Success", RUNNING: "Information", ANALYZING: "Information",
                                QUEUED: "Information", WAITING_INPUT: "Warning", PAUSED: "Warning",
                                PARTIAL: "Warning", FAILED: "Error", CANCELLED: "Error", EXPIRED: "Error"
                        };
                        return aMap[sSts] || "None";
                },

                /** V16：任务/运行状态 → 中文（徽标与卡片共用；i18n taskSt_<状态>，未登记的原样显示） */
                _taskStatusText: function (sSts) {
                        return (sSts && this._rb().getText("taskSt_" + sSts, undefined, true)) || sSts || "";
                },

                /** V16：顶栏任务徽标（模块 · 状态；短编号放悬浮提示） */
                _setTaskBadge: function (sModule, sStatus, sTaskId, sSid) {
                        var oChat = this.getView().getModel("chat");
                        var sBadge = this._taskModuleLabel(sModule) + " · " + this._taskStatusText(sStatus);
                        var sState = this._taskStateColor(sStatus);
                        var sTip = this._rb().getText("taskBadgeTip", [String(sTaskId || "").substring(0, 8)]);
                        if (sSid && sSid !== this._sMessagesSession) {
                                var oState = this._sessionMessageState(sSid);
                                if (oState) {
                                        oState.taskBadge = sBadge;
                                        oState.taskBadgeState = sState;
                                        oState.taskBadgeTip = sTip;
                                }
                                return;
                        }
                        oChat.setProperty("/taskBadge", sBadge);
                        oChat.setProperty("/taskBadgeState", sState);
                        oChat.setProperty("/taskBadgeTip", sTip);
                },

                /**
                  * Agent 应答后回写任务状态（oRes.taskId 为空 = 后端任务层未开启，
                  * 清空展示，不虚构任务状态）。
                  * V16：待填参数不再放底部任务区，而是挂到本条回复的内联确认卡上。
                  * @param {object} oRes sendTask 返回（taskId/taskModule/taskStatus/needsInput/pendingParamsJson）
                  * @param {string} sSessionId 会话
                  * @param {int} iAssistantIdx 本轮回复下标
                  */
                _updateTaskState: function (oRes, sSessionId, iAssistantIdx) {
                        var oChatModel = this.getView().getModel("chat");
                        if (!oRes || !oRes.taskId) {
                                oChatModel.setProperty("/currentTask", null);
                                oChatModel.setProperty("/taskBadge", "");
                                return;
                        }
                        var oPend = this._parsePending(oRes.pendingParamsJson);
                        var aPending = oPend.params;
                        var oPendingObj = oPend.obj;
                        var oTask = {
                                taskId: oRes.taskId,
                                shortId: (oRes.taskId || "").substring(0, 8),
                                module: oRes.taskModule || "",
                                status: oRes.taskStatus || "",
                                needsInput: oRes.needsInput === true,
                                sessionId: sSessionId,
                                reportId: (oPendingObj && oPendingObj.report_id) || "",
                                tcode: (oPendingObj && oPendingObj.tcode) || ""
                        };
                        oChatModel.setProperty("/currentTask", oTask);
                        this._adoptSkillTask();
                        this._setTaskBadge(oTask.module, oTask.status, oTask.taskId);
                        var oEntry = (oChatModel.getProperty("/messages") || [])[iAssistantIdx];
                        var oAsk = oEntry && oTask.needsInput ? this._paramAsk(oTask, oPendingObj, aPending, sSessionId) : null;
                        if (oAsk) {
                                oEntry.ask = oAsk;
                                if (!oAsk.fiori) {
                                        this._enrichReportAsk(oEntry);
                                }
                        }
                },

                /**
                  * 待填参数 JSON → {obj, params}。
                  * V15.0.2 20261008: 兼容对象 {report_id,tcode,params:[...]} 与旧数组格式; 提交 StartReportRun 需要 report_id
                  */
                _parsePending: function (sJson) {
                        var oOut = { obj: null, params: [] };
                        if (!sJson) {
                                return oOut;
                        }
                        try {
                                var oParsed = JSON.parse(sJson) || null;
                                if (oParsed && !Array.isArray(oParsed)) {
                                        oOut.obj = oParsed;
                                        oOut.params = oParsed.params || [];
                                } else {
                                        oOut.params = oParsed || [];
                                }
                        } catch (e) {
                                oOut.params = [];
                        }
                        return oOut;
                },

                /**
                  * 待填参数 → 内联参数卡（报表执行：提交执行；Fiori：取数）。没有参数返回 null。
                  * 20261025（DATA-01）：从 _updateTaskState 抽出，刷新后恢复参数卡也用它。
                  * @param {object} oTask {taskId, module, reportId, tcode}
                  */
                _paramAsk: function (oTask, oPendingObj, aPending, sSessionId) {
                        var oRB = this._rb();
                        if (!aPending || !aPending.length) {
                                return null;
                        }
                        // 20261020：Fiori 报表的待填参数（kind = FIORI）→ 同样的内联卡，按钮是「取数」，可带预填值
                        var bFiori = !!(oPendingObj && oPendingObj.kind === "FIORI");
                        if (bFiori) {
                                return {
                                        kind: "params",
                                        fiori: true,
                                        state: "open",
                                        title: oRB.getText("fioriParamsTitle"),
                                        subtitle: oPendingObj.report_name || oPendingObj.report_id || "",
                                        params: aPending,
                                        values: jQuery.extend({}, oPendingObj.values || {}),
                                        options: [
                                                { key: "submit", label: oRB.getText("fioriSubmit"), desc: oRB.getText("fioriSubmitDesc") },
                                                { key: "cancel", label: oRB.getText("fioriCancel"), desc: oRB.getText("fioriCancelDesc") }
                                        ],
                                        freePh: oRB.getText("fioriFreePh"),
                                        taskId: oTask.taskId,
                                        reportId: oPendingObj.report_id || "",
                                        module: oTask.module,
                                        sessionId: sSessionId,
                                        sel: 0,
                                        autoFocus: false
                                };
                        }
                        return {
                                kind: "params",
                                state: "open",
                                title: oRB.getText("askParamsTitle"),
                                subtitle: [oTask.tcode, oTask.reportId].filter(Boolean).join(" · "),
                                params: aPending,
                                values: {},
                                options: [
                                        { key: "submit", label: oRB.getText("askSubmit"), desc: oRB.getText("askSubmitDesc") },
                                        { key: "cancel", label: oRB.getText("askCancel"), desc: oRB.getText("askCancelDesc") }
                                ],
                                freePh: oRB.getText("askParamsFreePh"),
                                taskId: oTask.taskId,
                                reportId: oTask.reportId,
                                tcode: oTask.tcode,
                                module: oTask.module,
                                sessionId: sSessionId,
                                sel: 0,
                                autoFocus: false
                        };
                },

                /**
                  * 20261024（10.24 记录 #03a）：TCode 报表参数卡补齐单选组选项 / 复选框与单选组默认值 / 说明。
                  * Agent 的待填参数只带类型（单选组 = ENUM、复选框 = BOOL，后端 get_params 已整理），
                  * 选项与默认值在 ReportDefinitions 的参数定义里（enum_json / default_value）。
                  * 取不到定义时卡片保持原样（单选组退化成输入框，后端仍按选项校验）。
                  */
                _enrichReportAsk: function (oEntry) {
                        var that = this;
                        var oAsk = oEntry && oEntry.ask;
                        if (!oAsk || oAsk.fiori || (!oAsk.reportId && !oAsk.tcode)) {
                                return;
                        }
                        ChatService.getReportCatalog().then(function (o) {
                                var fnStr = function (d, a) {
                                        for (var i = 0; i < a.length; i++) {
                                                if (d[a[i]] !== undefined && d[a[i]] !== null) { return String(d[a[i]]); }
                                        }
                                        return "";
                                };
                                var oDef = ((o && o.defs) || []).filter(function (d) {
                                        return oAsk.reportId ? fnStr(d, ["REPORT_ID", "report_id", "reportId"]) === oAsk.reportId
                                                : fnStr(d, ["TCODE", "tcode"]) === oAsk.tcode;
                                })[0];
                                if (!oDef || oEntry.ask !== oAsk || oAsk.state !== "open") {
                                        return;
                                }
                                var oRes = AskCard.mergeParamDefs(oAsk.params, oDef.PARAMS || oDef.params || [], oAsk.values || {});
                                oAsk.params = oRes.params;
                                oAsk.values = oRes.values;
                                that._renderAsk(oEntry.uid);
                        }).catch(function () { /* 目录取不到：卡片保持原样 */ });
                },

                /** V16：按 uid 找消息条目（不依赖下标） */
                _entryByUid: function (sUid, sSid) {
                        var oState = sSid ? this._sessionMessageState(sSid) : null;
                        var aMsgs = sSid ? ((oState && oState.messages) || []) :
                                (this.getView().getModel("chat").getProperty("/messages") || []);
                        for (var i = 0; i < aMsgs.length; i++) {
                                if (aMsgs[i].uid === sUid) {
                                        return { entry: aMsgs[i], index: i };
                                }
                        }
                        return null;
                },

                /** 消息重建和异步补齐参数共用展示门槛：正文结束后，确认卡才出现。 */
                _renderEntryAsk: function (oHost, oEntry) {
                        if (!oEntry || oEntry.streaming || oEntry.waiting || oEntry.requestPending || oEntry.avatarStopped) {
                                oHost.setVisible(false);
                                return false;
                        }
                        if (oEntry.ask && oEntry.ask.kind === "params") {
                                // 先让用户读完说明，参数输入由用户点击或键盘进入，不自动抢焦点。
                                oEntry.ask.autoFocus = false;
                        }
                        AskCard.render(oHost, oEntry.ask, this._onAskAction.bind(this, oEntry.uid));
                        return !!oEntry.ask;
                },

                /** V16：重绘某条消息的内联确认卡（状态以条目 ask 为准） */
                _renderAsk: function (sUid) {
                        var oHit = this._entryByUid(sUid);
                        var oHost = this._mAskHosts && this._mAskHosts[sUid];
                        if (!oHit || !oHost || oHost.isDestroyed()) {
                                return;
                        }
                        if (!this._renderEntryAsk(oHost, oHit.entry)) {
                                return;
                        }
                        if (oHit.entry.ask.kind !== "params" && this._isNearBottom()) {
                                this._scrollToBottom();
                        }
                },

                /**
                  * V16：流式完成后挂载内联确认卡（与回答联动）：
                  * ① 报表待填参数（_updateTaskState 已写入 ask）
                  * ② 后端"多个任务需指定"→ 读会话任务列表作为选项
                  * ③ 回答末尾"提问 + 编号选项"（模型不确定意图时的追问）
                  */
                _attachAskCard: function (iIndex, sAnswer, oRes, sSessionId) {
                        var that = this;
                        var oEntry = (this.getView().getModel("chat").getProperty("/messages") || [])[iIndex];
                        if (!oEntry || oEntry.role !== "assistant") {
                                return;
                        }
                        if (oEntry.ask) {
                                this._renderAsk(oEntry.uid);
                                return;
                        }
                        var oRB = this._rb();
                        // 20261011：对话页不读 SAP —— 点名了程序/事务码/表时建议转到 Agent 对应场景
                        var oCtxNow = this.getView().getModel("chat").getProperty("/currentSession") || {};
                        if (oCtxNow.mode !== "AGENT") {
                                var sHint = this._sapSceneHint(this._prevUserText(iIndex));
                                var oHintScene = sHint ? this._sceneDef(sHint) : null;
                                if (oHintScene) {
                                        oEntry.ask = {
                                                kind: "choice", state: "open",
                                                title: oRB.getText("askSceneTitle"),
                                                options: [
                                                        { key: "scene", scene: oHintScene.key, label: oRB.getText("askSceneGo", [oHintScene.text]), desc: oHintScene.sub },
                                                        { key: "dismiss", label: oRB.getText("askSceneDismiss"), desc: oRB.getText("askSceneDismissDesc") }
                                                ],
                                                sel: 0, autoFocus: false, allowFree: false
                                        };
                                        this._renderAsk(oEntry.uid);
                                        return;
                                }
                        }
                        if (/多个.*任务.*(指定|选择|哪一个)/.test(sAnswer || "")) {
                                ChatService.getTasks(sSessionId).then(function (aTasks) {
                                        var aOpts = (aTasks || []).slice(0, 6).map(function (t) {
                                                return {
                                                        key: "task", taskId: t.task_id, module: t.module_id, status: t.status,
                                                        label: t.title || t.task_title || (that._taskModuleLabel(t.module_id) + " " + (t.short_id || String(t.task_id || "").substring(0, 8))),
                                                        desc: that._taskStatusText(t.status) + " · " + (t.short_id || String(t.task_id || "").substring(0, 8))
                                                };
                                        });
                                        if (aOpts.length < 2) {
                                                return;
                                        }
                                        oEntry.ask = {
                                                kind: "choice", state: "open", title: oRB.getText("askTaskTitle"),
                                                options: aOpts, freePh: oRB.getText("askTaskFreePh"),
                                                resend: that._prevUserText(iIndex), sel: 0, autoFocus: true
                                        };
                                        that._renderAsk(oEntry.uid);
                                });
                                return;
                        }
                        var oDet = AskCard.detectChoices(sAnswer);
                        if (oDet) {
                                oEntry.ask = {
                                        kind: "choice", state: "open", title: oDet.question,
                                        options: oDet.options, freePh: oRB.getText("askChoiceFreePh"), sel: 0, autoFocus: true
                                };
                                this._renderAsk(oEntry.uid);
                        }
                },

                /** V16：某条回复之前最近一条用户原文（澄清后按选定任务重发） */
                _prevUserText: function (iIndex) {
                        var aMsgs = this.getView().getModel("chat").getProperty("/messages") || [];
                        for (var i = iIndex - 1; i >= 0; i--) {
                                if (aMsgs[i].role === "user") {
                                        return aMsgs[i].raw || "";
                                }
                        }
                        return "";
                },

                /**
                  * V16：内联确认卡动作分发（卡片只收集，业务动作在这里执行）
                  * @param {string} sUid 消息 uid
                  * @param {object} oPick {key, text, values, missing, option}
                  */
                _onAskAction: function (sUid, oPick) {
                        var oHit = this._entryByUid(sUid);
                        var oAsk = oHit && oHit.entry.ask;
                        var oRB = this._rb();
                        if (!oAsk) {
                                return;
                        }
                        if (oPick.key === "submit") {
                                this._submitReportFromCard(sUid, oAsk, oPick);
                                return;
                        }
                        if (oPick.key === "cancel") {
                                oAsk.state = "cancelled";
                                oAsk.resultText = oRB.getText("askCancelled");
                                this._renderAsk(sUid);
                                this._rrDismissAsk(oAsk.sessionId, oAsk.taskId);   // 刷新后不再恢复成待填
                                return;
                        }
                        // 20261011：对话页"转到 Agent 场景"建议
                        if (oPick.key === "dismiss") {
                                oAsk.state = "cancelled";
                                oAsk.resultText = oRB.getText("askDismissed");
                                this._renderAsk(sUid);
                                return;
                        }
                        if (oPick.key === "scene" && oPick.option) {
                                oAsk.state = "done";
                                oAsk.resultText = oRB.getText("askSceneDone", [this._sceneDef(oPick.option.scene).text]);
                                this._renderAsk(sUid);
                                this._jumpToAgentScene(oPick.option.scene, this._prevUserText(oHit.index));
                                return;
                        }
                        if (this.getView().getModel("chat").getProperty("/busy")) {
                                oAsk.error = oRB.getText("askBusy");
                                this._renderAsk(sUid);
                                return;
                        }
                        var sSend = oPick.text;
                        var sShow = oPick.text;
                        if (oPick.key === "task" && oPick.option) {
                                var o = oPick.option;
                                this.getView().getModel("chat").setProperty("/currentTask", {
                                        taskId: o.taskId, shortId: String(o.taskId || "").substring(0, 8),
                                        module: o.module || "", status: o.status || "", needsInput: false,
                                        sessionId: (this.getView().getModel("chat").getProperty("/currentSession") || {}).id || ""
                                });
                                this._setTaskBadge(o.module, o.status, o.taskId);
                                sShow = oRB.getText("askContinueTask", [o.label]);
                                sSend = oAsk.resend || sShow;
                        }
                        oAsk.state = "done";
                        oAsk.error = "";
                        oAsk.resultText = oRB.getText(oPick.key === "free" ? "askToldAgent" : "askPicked", [sShow]);
                        this._renderAsk(sUid);
                        this._sendFollowUp(sShow, sSend);
                },

                /** V16：卡片联动的后续消息（沿用当前会话模式；不覆盖输入框草稿） */
                _sendFollowUp: function (sDisplay, sQuestion) {
                        var oCtx = this.getView().getModel("chat").getProperty("/currentSession") || {};
                        this._executeSend({
                                mode: oCtx.mode === "AGENT" ? "AGENT" : "CHAT",
                                agentType: oCtx.agentType || "",
                                displayText: sDisplay,
                                meta: "",
                                question: sQuestion || sDisplay,
                                keepInput: true
                        });
                },

                /** V16：参数卡"提交执行" → StartReportRun（每次提交 = 新 ClientRequestId；幂等由后端保证） */
                _submitReportFromCard: function (sUid, oAsk, oPick) {
                        var that = this;
                        var oRB = this._rb();
                        var oState = this._sessionMessageState(oAsk.sessionId);
                        if (oAsk.fiori) {
                                this._fioriSubmit(sUid, oAsk, oPick);   // 20261020：Fiori 报表同步取数（FioriPanel）
                                return;
                        }
                        if (oPick.missing && oPick.missing.length) {
                                oAsk.error = oRB.getText("askMissing", [oPick.missing.join(oRB.getText("listSep"))]);
                                this._renderAsk(sUid);
                                return;
                        }
                        oAsk.state = "busy";
                        oAsk.error = "";
                        oAsk.busyText = oRB.getText("askSubmitting");
                        this._renderAsk(sUid);
                        ChatService.startReportRun({
                                sessionId: oAsk.sessionId,
                                taskId: oAsk.taskId,
                                reportId: oAsk.module === "REPORT" ? (oAsk.reportId || "") : "",
                                paramsJson: JSON.stringify(oPick.values || {}),
                                clientRequestId: this._newSessionId()
                        }).then(function (oRes) {
                                if (!oState || that._sessionMessageState(oAsk.sessionId) !== oState) { return; }
                                if (!oRes || oRes.needsInput || oRes.rejected || !oRes.reportRunId) {
                                        oAsk.state = "open";
                                        oAsk.error = (oRes && oRes.message) ||
                                                oRB.getText(oRes && oRes.needsInput ? "askParamsRejected" : "askSubmitRejected");
                                        that._renderAsk(sUid);
                                        return;
                                }
                                var aSum = (oAsk.params || []).map(function (p) {
                                        var v = (oPick.values || {})[p.param_id];
                                        // 20261015：只有范围参数用 " ~ "，多值用顿号（原来多值也显示成范围）
                                        return v ? (p.label || p.param_id) + " " + AskCard.valueDisplay(p, v) : "";
                                }).filter(Boolean);
                                oAsk.state = "done";
                                oAsk.resultText = aSum.length ? oRB.getText("askSubmittedWith", [aSum.join(oRB.getText("listSepComma"))]) : oRB.getText("askSubmitted");
                                that._renderAsk(sUid);
                                that._trackRun(sUid, oRes.reportRunId, oAsk.sessionId, oRes.shortId);
                        }).catch(function (oErr) {
                                oAsk.state = "open";
                                oAsk.error = (oErr && oErr.message) || String(oErr);
                                that._renderAsk(sUid);
                        });
                },

                /* ---------------------------------------------------------
                 * V16：表格工具条 / 图表卡 / 步骤条按钮 —— document 级事件委托
                 * （innerHTML 流式重建，逐个挂监听不可行）
                 * --------------------------------------------------------- */

                _bindDataActions: function () {
                        if (this._bDataActBound) {
                                return;
                        }
                        this._bDataActBound = true;
                        var that = this;
                        document.body.addEventListener("click", function (oEv) {
                                var oBtn = oEv.target && oEv.target.closest ? oEv.target.closest("button[data-act]") : null;
                                if (!oBtn) {
                                        that._maybeSkipStream(oEv.target);
                                        return;
                                }
                                var oHost = oBtn.closest("[data-uid]");
                                if (oHost) {
                                        that._onDataAction(oBtn, oHost.getAttribute("data-uid"));
                                }
                        });
                },

                /** 20261019（FE-10）：打字动画进行中，点消息区的非交互位置 = 跳过动画，直接显示全文 */
                _maybeSkipStream: function (oTarget) {
                        if (!this._sStreamToken || !oTarget || !oTarget.closest) {
                                return;
                        }
                        var oScroll = this.byId("chatScroll");
                        var oDom = oScroll && oScroll.getDomRef();
                        if (!oDom || !oDom.contains(oTarget) || oTarget.closest("a, button, input, textarea, select")) {
                                return;
                        }
                        this._sStreamSkip = this._sStreamToken;
                },

                _onDataAction: function (oBtn, sUid) {
                        var that = this;
                        var sAct = oBtn.getAttribute("data-act");
                        var oHit = this._entryByUid(sUid);
                        if (!oHit) {
                                return;
                        }
                        var oEntry = oHit.entry;
                        if (sAct === "fiori-analyze") {
                                this._fioriAnalyze(oEntry);   // 20261020：Fiori 结果的分析闸门（FioriPanel）
                                return;
                        }
                        if (sAct === "run-refresh" || sAct === "run-stop") {
                                var oRun = this._runByUid(sUid);
                                if (!oRun) {
                                        MessageToast.show(this._rb().getText("runNotTracked"));
                                        return;
                                }
                                if (sAct === "run-stop") {
                                        this._stopRun("stopped", oRun);
                                        this._rrForgetRun(oRun);   // 用户明确停止：刷新后不再续跟
                                } else if (oRun.timer) {
                                        this._pollRun(oRun);
                                } else {
                                        this._resumeRun(oRun);
                                }
                                return;
                        }
                        if (/^chart-/.test(sAct)) {
                                var sCid = oBtn.getAttribute("data-cid");
                                var aCharts = oEntry.userCharts || [];
                                var oCh = aCharts.filter(function (c) { return c.id === sCid; })[0];
                                if (!oCh) {
                                        return;
                                }
                                // 20261025（DATA-01）：图表增删改都记下配置，刷新后套回恢复的表格
                                if (sAct === "chart-type") {
                                        oCh.cfg.type = oBtn.getAttribute("data-type");
                                        this._refreshExtra(oEntry, oCh.src);
                                        this._rrSaveCharts(oEntry);
                                } else if (sAct === "chart-edit") {
                                        ChartBuilder.open(oCh.ds, oCh.cfg, function (oCfg) {
                                                oCh.cfg = oCfg;
                                                that._refreshExtra(oEntry, oCh.src);
                                                that._rrSaveCharts(oEntry);
                                        }, { edit: true });
                                } else if (sAct === "chart-del") {
                                        oEntry.userCharts = aCharts.filter(function (c) { return c !== oCh; });
                                        this._refreshExtra(oEntry, oCh.src);
                                        this._rrSaveCharts(oEntry);
                                } else if (sAct === "chart-svg") {
                                        var oR = ChartRenderer.render(oCh.ds, oCh.cfg);
                                        if (oR.svg) {
                                                this._download(ChartRenderer.standalone(oR.svg), (oCh.cfg.title || oCh.ds.name || this._rb().getText("chartDefaultTitle")) + ".svg", "image/svg+xml");
                                        }
                                }
                                return;
                        }
                        // —— 表格工具条：分析结果带 data-ds；Markdown 表格读相邻 DOM ——
                        var oTools = oBtn.closest(".dataTools");
                        if (!oTools) {
                                return;
                        }
                        var oDs = null, oHint = null, sSrc = "";
                        var sDs = oTools.getAttribute("data-ds");
                        if (sDs !== null && oEntry.analysis) {
                                oDs = (oEntry.analysis.datasets || [])[parseInt(sDs, 10)];
                                oHint = oDs ? this._chartHint(oEntry.analysis, oDs) : null;
                                sSrc = "ds:" + parseInt(sDs, 10);
                        } else {
                                var oPrev = oTools.previousElementSibling;
                                oDs = ChartRenderer.fromTable(oPrev && oPrev.querySelector("table"));
                                // 20261011：正文第几个表格（图表插回它的下方）
                                var oBodyRoot = oTools.closest(".bubbleBody");
                                var iMd = oBodyRoot ? Array.prototype.indexOf.call(oBodyRoot.querySelectorAll(".dataTools"), oTools) : -1;
                                sSrc = iMd >= 0 ? "md:" + iMd : "";
                        }
                        if (!oDs) {
                                return;
                        }
                        if (sAct === "all") {
                                this._openDataGrid(oDs);
                        } else if (sAct === "copy") {
                                this._copyText(ChartRenderer.toDelimited(oDs, "\t"), this._rb().getText("copiedForExcel"));
                        } else if (sAct === "csv") {
                                this._download("\uFEFF" + ChartRenderer.toDelimited(oDs, ","), (oDs.name || this._rb().getText("dataDefaultName")) + ".csv", "text/csv;charset=utf-8");
                        } else if (sAct === "chart") {
                                this._openChartFor(oEntry, oDs, oHint, sSrc);
                        }
                },

                /** 20261024：「查看全部」分页查看器（复制 / 导出复用表格工具条的同一套实现，导出的是查看器当前的搜索 + 排序结果） */
                _openDataGrid: function (oDs) {
                        var that = this;
                        var oRB = this._rb();
                        var mT = {};
                        Object.keys(DataGrid.TEXTS).forEach(function (k) {
                                mT[k] = oRB.getText("dg" + k.charAt(0).toUpperCase() + k.slice(1));
                        });
                        DataGrid.open(oDs, {
                                texts: mT,
                                onCopy: function (oView) {
                                        that._copyText(ChartRenderer.toDelimited(oView, "\t"), oRB.getText("copiedForExcel"));
                                },
                                onCsv: function (oView) {
                                        that._download("\uFEFF" + ChartRenderer.toDelimited(oView, ","), (oView.name || oRB.getText("dataDefaultName")) + ".csv", "text/csv;charset=utf-8");
                                }
                        });
                },

                /** 打开图表面板；不适合出图时说明原因（不硬画）。sSrc = 来源表格锚点（图表放在其下方） */
                _openChartFor: function (oEntry, oDs, oHint, sSrc) {
                        var that = this;
                        if (oEntry.streaming && /^md:/.test(sSrc || "")) {
                                MessageToast.show(this._rb().getText("chartWhileStreaming"));
                                return;
                        }
                        var oA = ChartRenderer.analyze(oDs);
                        if (!oA.chartable) {
                                MessageToast.show(this._rb().getText("chartNotSuitable", [oA.reason]));
                                return;
                        }
                        ChartBuilder.open(oDs, oHint, function (oCfg) {
                                oEntry.userCharts = (oEntry.userCharts || []).concat([{
                                        id: "c" + that._newSessionId().substring(0, 8), ds: oDs, cfg: oCfg, src: sSrc || ""
                                }]);
                                that._refreshExtra(oEntry, sSrc);
                                that._rrSaveCharts(oEntry);
                        });
                },

                /**
                  * 附加区局部刷新（extraHtml 绑定 → HTML 控件重绘）。
                  * 20261011：sSrc 为正文表格锚点（md:）时同时重绘正文，图表才能出现在该表格下方
                  */
                _refreshExtra: function (oEntry, sSrc) {
                        var oHit = this._entryByUid(oEntry.uid);
                        if (!oHit) {
                                return;
                        }
                        this.getView().getModel("chat").setProperty("/messages/" + oHit.index + "/extraHtml", this._extraHtml(oEntry));
                        if (/^md:/.test(sSrc || "")) {
                                var oBody = this._findMsgBodyCtrl(oHit.index);
                                if (oBody) {
                                        oBody.setContent('<div class="bubbleBody" data-uid="' + oEntry.uid + '">' + this._bodyHtml(oEntry) + "</div>");
                                        setTimeout(this._highlightCodeBlocks.bind(this), 60);
                                }
                        }
                },

                _copyText: function (sText, sOkMsg) {
                        var that = this;
                        var fnOk = function () { MessageToast.show(sOkMsg || that._rb().getText("toastCopied")); };
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(sText).then(fnOk).catch(function () {
                                        that._copyFallback(sText, that._rb());
                                });
                        } else {
                                this._copyFallback(sText, this._rb());
                        }
                },

                _download: function (sContent, sName, sMime) {
                        var oBlob = new Blob([sContent], { type: sMime });
                        var sUrl = URL.createObjectURL(oBlob);
                        var oLink = document.createElement("a");
                        oLink.href = sUrl;
                        oLink.download = String(sName).replace(/[\\/:*?"<>|]+/g, "_");
                        document.body.appendChild(oLink);
                        oLink.click();
                        document.body.removeChild(oLink);
                        setTimeout(function () { URL.revokeObjectURL(sUrl); }, 1000);
                },

                /** 会话任务列表（切换/恢复：展示后端返回的任务，点击置为当前任务） */
                onTaskListPress: function () {
                        var that = this;
                        var oChatModel = this.getView().getModel("chat");
                        var oCtx = oChatModel.getProperty("/currentSession") || {};
                        var oRB = this._rb();
                        ChatService.getTasks(oCtx.id || "").then(function (aTasks) {
                                var oPop = new Dialog({
                                        title: oRB.getText("taskListTitle"),
                                        contentWidth: "26rem",
                                        content: (function () {
                                                var oVBox = new VBox();
                                                if (!aTasks || !aTasks.length) {
                                                        oVBox.addItem(new Text({ text: oRB.getText("taskListEmpty") }));
                                                }
                                                (aTasks || []).slice(0, 20).forEach(function (oT) {
                                                        oVBox.addItem(new Button({
                                                                text: that._taskModuleLabel(oT.module_id) + " · " + that._taskStatusText(oT.status) +
                                                                        " · " + (oT.short_id || (oT.task_id || "").substring(0, 8)) +
                                                                        (oT.title ? " · " + oT.title : ""),
                                                                type: "Transparent",
                                                                press: (function (oTask) {
                                                                        return function () {
                                                                                oChatModel.setProperty("/currentTask", {
                                                                                        taskId: oTask.task_id,
                                                                                        shortId: (oTask.task_id || "").substring(0, 8),
                                                                                        module: oTask.module_id || "",
                                                                                        status: oTask.status || "",
                                                                                        needsInput: false,
                                                                                        sessionId: oCtx.id || ""
                                                                                });
                                                                                that._setTaskBadge(oTask.module_id, oTask.status, oTask.task_id);
                                                                                oPop.close();
                                                                        };
                                                                })(oT)
                                                        }));
                                                });
                                                return oVBox;
                                        })(),
                                        endButton: new Button({ text: oRB.getText("close"), press: function () { oPop.close(); } })
                                });
                                oPop.open();
                        }).catch(function () {
                                MessageToast.show(oRB.getText("taskListFail"));
                        });
                },

                /* =========================================================
                 * 视图格式化辅助（XML 中以 .hasText 引用）
                 * ========================================================= */

                hasText: function (s) {
                        return !!(s && s.length);
                }
        }, SceneModels, SettingsPanel, EvalPanel, RunTracker, AuthPanel, AuthApprove, CatalogPanel, FioriPanel, SessionMessages, SkillPanel, ResultRestore));
});
