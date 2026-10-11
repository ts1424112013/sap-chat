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
                SCENES: [
                        { key: "REPORT", text: "报表执行", icon: "sap-icon://document-text",
                          sub: "选报表、填参数、后台执行；结果出来后可以直接追问分析",
                          ph: "说「执行 ZDPMM702」，或对已出的报表结果提问…",
                          chips: ["执行 ZDPMM702", "分析一下这个结果", "哪个工厂的 MIH 需求最大"] },
                        { key: "DATA", text: "数据分析", icon: "sap-icon://database",
                          sub: "按表 / SQL 只读取数与统计分析，不会触发任何报表执行",
                          ph: "说要分析哪张表、看什么维度，例如「按工厂统计 ZIDPMM455」…",
                          chips: ["按工厂统计 ZIDPMM455 的记录数", "ZIDPPP099 表的数据", "MARA 按物料类型统计数量"] },
                        { key: "INVENTORY", text: "库存查询", icon: "sap-icon://product",
                          sub: "用库存专用工具查询库存快照、当天收发与批次库存",
                          ph: "说物料与工厂，例如「A001 在 0001 工厂的库存」…",
                          chips: ["物料 A001 在 0001 工厂的库存", "A001 今天的收发", "A001 在 0001 的批次库存"] },
                        { key: "CODE", text: "代码分析", icon: "sap-icon://syntax",
                          sub: "读取自开发程序源码与表结构，解读逻辑、审查代码",
                          ph: "说要看哪个程序 / 事务码 / 类，例如「解释 ZDPMM702 的程序逻辑」…",
                          chips: ["解释 ZDPMM702 的程序逻辑", "审查 ZRMM_IDP_0702 的性能问题", "ZIDPMM455 表结构"] },
                        { key: "AUTO", text: "自动", icon: "sap-icon://lightbulb",
                          sub: "按每句话自动判断用哪类工具（混合场景，适合熟悉的用户）",
                          ph: "", chips: [] }
                ],

                _normScene: function (s) {
                        var v = String(s || "").toUpperCase();
                        return ["REPORT", "DATA", "INVENTORY", "CODE"].indexOf(v) >= 0 ? v : "AUTO";
                },

                _sceneDef: function (sKey) {
                        var k = this._normScene(sKey);
                        return this.SCENES.filter(function (d) { return d.key === k; })[0];
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
                        this.SCENES.forEach(function (d) {
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
                                MessageToast.show("已开始的会话不能更换场景，请新建任务");
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
                                MessageToast.show("上一条请求仍在处理中，请稍候");
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
                                MessageToast.show("Agent 可用模型已保存");
                        }).catch(function (oErr) {
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                        });
                }
        };
});
