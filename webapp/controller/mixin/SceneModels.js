sap.ui.define([
        "sap/m/MessageToast",
        "sap/m/Button",
        "zai/chat/service/ChatService",
        "zai/chat/utils/Formatter"
], function (MessageToast, Button, ChatService, Formatter) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：Agent 会话场景与模型白名单
         * =====================================================================
         * 场景定义（SCENES）与选择条、按场景过滤模型下拉、Agent 可用模型白名单的
         * 读取/保存，以及对话页"转到 Agent 场景"的建议与跳转。
         * 以 mixin 方式并入 zai.chat.controller.App（方法里的 this 就是控制器）；
         * 20261011（改进清单 FE-09）从 App.controller.js 原样搬出，逻辑未改。
         * =====================================================================
         */
        return {

                /* =========================================================
                 * 20261011：Agent 会话场景 —— 一个 Agent 入口 + 会话级场景。
                 * 场景存 ZAI_CHAT_SESS.AGENT_TYPE，新会话首条消息随 Scene 发给后端，
                 * 之后固定；后端按场景收窄意图与工具（前端只是选择与展示）。
                 * 旧会话 AgentType 为空/GENERAL → 自动（原混合路由）
                 * ========================================================= */
                /** 20261011（FE-11）：文案在 i18n（scene<KEY> / scene<KEY>Sub / scene<KEY>Ph /
                  * scene<KEY>Chip1..n），由 _sceneDef 按当前语言解析 */
                SCENES: [
                        { key: "REPORT", icon: "sap-icon://document-text", chips: 3 },
                        { key: "DATA", icon: "sap-icon://database", chips: 3 },
                        { key: "INVENTORY", icon: "sap-icon://product", chips: 3 },
                        { key: "CODE", icon: "sap-icon://syntax", chips: 3 },
                        { key: "AUTO", icon: "sap-icon://lightbulb", chips: 0 }
                ],

                _normScene: function (s) {
                        var v = String(s || "").toUpperCase();
                        return ["REPORT", "DATA", "INVENTORY", "CODE"].indexOf(v) >= 0 ? v : "AUTO";
                },

                /** 场景定义（文案已解析）：{key, icon, text, sub, ph, chips[]}；AUTO 无占位与示例 */
                _sceneDef: function (sKey) {
                        var oRB = this._rb();
                        var k = this._normScene(sKey);
                        var d = this.SCENES.filter(function (o) { return o.key === k; })[0];
                        var aChips = [];
                        for (var i = 1; i <= d.chips; i++) {
                                aChips.push(oRB.getText("scene" + k + "Chip" + i));
                        }
                        return {
                                key: k,
                                icon: d.icon,
                                text: oRB.getText("scene" + k),
                                sub: oRB.getText("scene" + k + "Sub"),
                                ph: k === "AUTO" ? "" : oRB.getText("scene" + k + "Ph"),
                                chips: aChips
                        };
                },

                /** 当前 Agent 会话的场景（对话模式恒为 AUTO） */
                _curScene: function () {
                        var oCtx = this.getView().getModel("chat").getProperty("/currentSession") || {};
                        return oCtx.mode === "AGENT" ? this._normScene(oCtx.agentType) : "AUTO";
                },

                /** 新建 Agent 会话默认用上次选择的场景（首次 = 报表执行） */
                _lastScene: function () {
                        var s = "";
                        try { s = window.localStorage.getItem("zaiChat.lastScene") || ""; } catch (e) { s = ""; }
                        return s ? this._normScene(s) : "REPORT";
                },

                _setLastScene: function (sKey) {
                        try { window.localStorage.setItem("zaiChat.lastScene", this._normScene(sKey)); } catch (e) { /* 忽略 */ }
                },

                /** 场景选择条（仅 Agent 空会话首页；发出首条消息后场景固定） */
                _renderScenePicker: function () {
                        var that = this;
                        var oBox = this.byId("scenePicker");
                        if (!oBox) {
                                return;
                        }
                        oBox.destroyItems();
                        var bAgent = this.getView().getModel("chat").getProperty("/workspaceMode") === "AGENT";
                        oBox.setVisible(bAgent);
                        if (!bAgent) {
                                return;
                        }
                        var sCur = this._curScene();
                        this.SCENES.map(function (o) { return that._sceneDef(o.key); }).forEach(function (d) {
                                oBox.addItem(new Button({
                                        text: d.text,
                                        icon: d.icon,
                                        type: "Transparent",
                                        tooltip: d.sub,
                                        press: that._onScenePick.bind(that, d.key)
                                }).addStyleClass("sceneBtn" + (d.key === sCur ? " sceneOn" : "") + (d.key === "AUTO" ? " sceneAuto" : "")));
                        });
                },

                _onScenePick: function (sKey) {
                        var oChat = this.getView().getModel("chat");
                        if ((oChat.getProperty("/messages") || []).length) {
                                MessageToast.show(this._rb().getText("sceneLocked"));
                                return;
                        }
                        oChat.setProperty("/currentSession/agentType", this._normScene(sKey));
                        this._setLastScene(sKey);
                        this._applyWorkspaceChrome();
                        var oInput = this.byId("heroInput");
                        if (oInput && oInput.focus) {
                                oInput.focus();
                        }
                },

                /**
                  * 20261011：Agent 模式模型下拉只显示该场景白名单内的模型
                  * （AGENT_MODELS[_<场景>]，空 = 不限制；后端同口径强制校验）
                  */
                _syncModelList: function () {
                        var oChat = this.getView().getModel("chat");
                        var aAll = oChat.getProperty("/models") || [];
                        var aAllow = [];
                        if (oChat.getProperty("/workspaceMode") === "AGENT" && this._mAgentModelRules) {
                                var sScene = this._curScene();
                                var aScene = (sScene !== "AUTO" && this._mAgentModelRules[sScene]) || [];
                                aAllow = aScene.length ? aScene : (this._mAgentModelRules.ALL || []);
                        }
                        var aView = !aAllow.length ? aAll : aAll.filter(function (m) {
                                return m.ModelId === "AUTO" || aAllow.indexOf(String(m.ModelId || "").toUpperCase()) >= 0;
                        });
                        oChat.setProperty("/modelsView", aView);
                        var sCur = oChat.getProperty("/currentModel");
                        if (sCur && aView.length && !aView.some(function (m) { return m.ModelId === sCur; })) {
                                oChat.setProperty("/currentModel", "AUTO");
                        }
                },

                _loadAgentModelRules: function () {
                        var that = this;
                        ChatService.getAgentModelRules().then(function (m) {
                                that._mAgentModelRules = m || {};
                                that._syncModelList();
                        }).catch(function () {
                                that._mAgentModelRules = {};
                                that._syncModelList();
                        });
                },

                /**
                  * 20261011：对话页不读 SAP —— 问题里点名了程序 / 事务码 / 表时，
                  * 回答下方建议转到对应 Agent 场景（不拦截发送；粘贴代码的长问题不提示）
                  * @returns {string} 建议场景 REPORT/DATA/CODE，或 ""
                  */
                _sapSceneHint: function (sQ) {
                        var q = String(sQ || "").toUpperCase();
                        if (!q || q.length > 300 || /\n.*\n.*\n/.test(q) || q.indexOf("```") >= 0) {
                                return "";
                        }
                        var bObj = /(^|[^A-Z0-9_])[ZY][A-Z0-9_]{3,29}(?![A-Z0-9_])/.test(q);
                        var qTab = q.replace(/报表|图表|列表|表格|表单/g, "#");
                        var bTab = /表\s*[A-Z][A-Z0-9_]{2,29}|[A-Z][A-Z0-9_]{2,29}\s*表/.test(qTab);
                        if (!bObj && !bTab) {
                                return "";
                        }
                        if (bObj && /执行|运行|跑一下|跑一次|重跑/.test(q)) {
                                return "REPORT";
                        }
                        if (bTab || /数据|统计|多少|分布|记录|明细/.test(q)) {
                                return "DATA";
                        }
                        return "CODE";
                },

                /** 带着原问题转到 Agent 的指定场景（新会话 + 自动发送） */
                _jumpToAgentScene: function (sScene, sQuestion) {
                        var oChat = this.getView().getModel("chat");
                        if (oChat.getProperty("/busy")) {
                                MessageToast.show(this._rb().getText("busyWait"));
                                return;
                        }
                        var sKey = this._normScene(sScene);
                        this._setLastScene(sKey);
                        this._sStreamToken = "";
                        oChat.setProperty("/workspaceMode", "AGENT");
                        var sNew = this._newSessionId();
                        this._setSessionContext({ id: sNew, mode: "AGENT", agentType: sKey, status: "IDLE" });
                        this.getView().getModel("session").setProperty("/currentId", sNew);
                        this.getView().getModel("session").setProperty("/title", "");
                        oChat.setProperty("/messages", []);
                        this._setViewLayout(false);
                        this._applyWorkspaceChrome();
                        this._applySessionFilter();
                        if (sQuestion) {
                                this._executeSend({
                                        mode: "AGENT", agentType: sKey, displayText: sQuestion,
                                        meta: "", question: sQuestion, keepInput: true
                                });
                        }
                },

                /** 20261011：保存 Agent 可用模型白名单（全部场景 + 各场景覆盖） */
                onSaveAgentModelRules: function () {
                        var that = this;
                        var oSettings = this.getView().getModel("settings");
                        var mRules = oSettings.getProperty("/agentRules") || {};
                        ChatService.saveAgentModelRules(mRules).then(function () {
                                that._mAgentModelRules = jQuery.extend(true, {}, mRules);
                                that._syncModelList();
                                MessageToast.show(that._rb().getText("agentModelsSaved"));
                        }).catch(function (oErr) {
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                        });
                }
        };
});
