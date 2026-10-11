sap.ui.define([
        "sap/ui/model/json/JSONModel",
        "sap/m/MessageToast",
        "zai/chat/service/ChatService",
        "zai/chat/utils/AgentEval"
], function (JSONModel, MessageToast, ChatService, AgentEval) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：Agent 测评对话框（管理员）
         * =====================================================================
         * 题库加载/导入/导出、逐题运行与进度、结果表与汇总、报告导出；
         * 打分逻辑在 utils/AgentEval，这里只负责对话框与调用通道注入。
         * 以 mixin 方式并入 zai.chat.controller.App（方法里的 this 就是控制器）；
         * 20261011（改进清单 FE-09）从 App.controller.js 原样搬出，逻辑未改。
         * =====================================================================
         */
        return {

                /* =========================================================
                 * 20261011：Agent 测评（管理员）—— 与用户同一条链路逐题调用，
                 * 记录并打分；逻辑在 utils/AgentEval（调用通道在这里注入）
                 * ========================================================= */

                onOpenEval: function () {
                        var that = this;
                        if (this._oSettingsDialog && this._oSettingsDialog.isOpen()) {
                                this._oSettingsDialog.close();
                        }
                        if (!this._oEvalDialog) {
                                this._oEvalDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.EvalDialog", this);
                                this.getView().addDependent(this._oEvalDialog);
                                this._oEvalModel = new JSONModel({
                                        scene: "ALL", repeat: "1", modelId: "AUTO", cleanup: true,
                                        running: false, hasResults: false, rows: [], statusText: "", summaryText: "", detail: ""
                                });
                                this._oEvalDialog.setModel(this._oEvalModel, "eval");
                        }
                        this._loadEvalCases().then(function () {
                                that._evalIdleStatus();
                        });
                        this._oEvalDialog.open();
                },

                onEvalClose: function () {
                        if (this._oEvalModel && this._oEvalModel.getProperty("/running")) {
                                MessageToast.show("测评进行中，请先停止");
                                return;
                        }
                        this._oEvalDialog.close();
                },

                /** 内置题库（model/evalCases.json）；导入后以导入的为准 */
                _loadEvalCases: function () {
                        var that = this;
                        if (this._oEvalCases) {
                                return Promise.resolve(this._oEvalCases);
                        }
                        return fetch(sap.ui.require.toUrl("zai/chat/model/evalCases.json"), { cache: "no-store" })
                                .then(function (r) { return r.json(); })
                                .then(function (oRaw) {
                                        that._setEvalCases(oRaw, "内置");
                                        return that._oEvalCases;
                                }).catch(function (e) {
                                        that._oEvalCases = { version: "", raw: { cases: [] }, cases: [], invalid: 0, source: "内置" };
                                        MessageToast.show("题库加载失败：" + ((e && e.message) || e));
                                        return that._oEvalCases;
                                });
                },

                _setEvalCases: function (oRaw, sSource) {
                        var oN = AgentEval.normalizeCases(oRaw);
                        this._oEvalCases = {
                                version: (oRaw && oRaw.version) || "", raw: oRaw, cases: oN.cases,
                                invalid: oN.invalid, source: sSource
                        };
                },

                /** 后端是否已支持 Scene 参数（演示模式视为支持，便于看界面） */
                _evalSceneSupported: function () {
                        return ChatService.getMode() === "mock" ? true : ChatService._fiHasParam("AnalyzeTask", "Scene");
                },

                _evalIdleStatus: function () {
                        var oC = this._oEvalCases || { cases: [] };
                        var mCnt = {};
                        oC.cases.forEach(function (c) { mCnt[c.scene] = (mCnt[c.scene] || 0) + 1; });
                        var aParts = Object.keys(mCnt).map(function (k) { return AgentEval.SCENE_TEXT[k] + " " + mCnt[k]; });
                        var bScene = this._evalSceneSupported();
                        var iNeed = oC.cases.filter(function (c) { return c.requiresScene; }).length;
                        this._oEvalModel.setProperty("/statusText",
                                "题库（" + oC.source + (oC.version ? " " + oC.version : "") + "）：共 " + oC.cases.length + " 题（" + aParts.join(" / ") + "）" +
                                (oC.invalid ? "，无效 " + oC.invalid + " 题已忽略" : "") + "。" +
                                (bScene ? "" : "后端尚未支持 Scene 参数：标记\"需场景\"的 " + iNeed + " 题会跳过，其余按自动场景运行。") +
                                (ChatService.getMode() === "mock" ? " 当前是演示模式：回答为内置示例，不代表真实模型能力。" : ""));
                },

                onEvalRun: function () {
                        var that = this;
                        var oM = this._oEvalModel;
                        if (oM.getProperty("/running")) {
                                return;
                        }
                        if (this.getView().getModel("chat").getProperty("/busy")) {
                                MessageToast.show("对话还在进行中，请等它完成后再开始测评");
                                return;
                        }
                        var sScene = oM.getProperty("/scene");
                        var aCases = ((this._oEvalCases && this._oEvalCases.cases) || []).filter(function (c) {
                                return sScene === "ALL" || c.scene === sScene;
                        });
                        if (!aCases.length) {
                                MessageToast.show("所选场景没有题目");
                                return;
                        }
                        var bScene = this._evalSceneSupported();
                        this._bEvalStop = false;
                        this._aEvalResults = [];
                        oM.setProperty("/running", true);
                        oM.setProperty("/hasResults", false);
                        oM.setProperty("/rows", []);
                        oM.setProperty("/detail", "");
                        oM.setProperty("/summaryText", "");
                        var iT0 = Date.now();
                        this._oEvalRun = {
                                startedAt: new Date().toLocaleString(),
                                modelId: oM.getProperty("/modelId") || "AUTO",
                                repeat: parseInt(oM.getProperty("/repeat"), 10) || 1,
                                sceneSupported: bScene,
                                caseVersion: (this._oEvalCases.source || "") + " " + (this._oEvalCases.version || ""),
                                caseCount: aCases.length,
                                results: []
                        };
                        AgentEval.run({
                                cases: aCases,
                                repeat: this._oEvalRun.repeat,
                                modelId: this._oEvalRun.modelId,
                                sceneSupported: bScene,
                                // 调用通道：与用户相同（ChatService.sendTask → AnalyzeTask；后端无新接口时自动回退 AnalyzeAgent）
                                send: function (oPayload) { return ChatService.sendTask(oPayload); },
                                del: function (sSid) { return ChatService.deleteSession(sSid); },
                                newId: this._newSessionId.bind(this),
                                cleanup: oM.getProperty("/cleanup") === true,
                                shouldStop: function () { return that._bEvalStop === true; },
                                onProgress: function (o) { that._evalOnProgress(o); }
                        }).then(function (aRes) {
                                that._oEvalRun.results = aRes;
                                that._oEvalRun.durationMs = Date.now() - iT0;
                                oM.setProperty("/running", false);
                                oM.setProperty("/hasResults", aRes.length > 0);
                                that._evalRender(true);
                                that._refreshSessions();
                        }).catch(function (e) {
                                oM.setProperty("/running", false);
                                MessageToast.show("测评中断：" + ((e && e.message) || e));
                        });
                },

                onEvalStop: function () {
                        this._bEvalStop = true;
                        this._oEvalModel.setProperty("/statusText", "正在停止：等当前这一题完成后结束…");
                },

                _evalOnProgress: function (o) {
                        var oM = this._oEvalModel;
                        if (o.done || o.item.skipped) {
                                if (this._aEvalResults.indexOf(o.item) < 0) {
                                        this._aEvalResults.push(o.item);
                                }
                                this._oEvalRun.results = this._aEvalResults;
                                this._evalRender(false);
                        }
                        if (!o.done) {
                                oM.setProperty("/statusText", "正在测评 " + (o.index + 1) + "/" + o.total + "：" +
                                        o.item.id + " " + o.item.name + (o.item.rep > 1 ? " #" + o.item.rep : "") + " …");
                        }
                },

                /** 结果表 + 汇总（bFinal = 跑完） */
                _evalRender: function (bFinal) {
                        var oM = this._oEvalModel;
                        var aRes = (this._oEvalRun && this._oEvalRun.results) || [];
                        oM.setProperty("/rows", aRes.map(function (r) {
                                var t = r.turns[r.turns.length - 1];
                                return {
                                        key: r.id + "#" + r.rep,
                                        label: r.id + " " + r.name + (r.rep > 1 ? " #" + r.rep : "") + (r.turns.length > 1 ? "（" + r.turns.length + " 轮对话）" : ""),
                                        sceneText: AgentEval.SCENE_TEXT[r.scene] || r.scene,
                                        resultText: r.skipped ? "跳过" : (r.pass ? "通过" : "失败"),
                                        resultState: r.skipped ? "None" : (r.pass ? "Success" : "Error"),
                                        status: t ? t.status : "",
                                        rounds: t ? String(t.rounds) : "",
                                        seconds: t ? (t.wallMs / 1000).toFixed(1) : "",
                                        tools: t ? (t.tools.map(function (x) {
                                                return x.tool + (x.status !== "OK" ? "(" + x.status + ")" : "");
                                        }).join(", ") || (t.deterministic ? "（确定性应答）" : "—")) : "",
                                        reasons: r.reasons.join("；")
                                };
                        }));
                        var S = AgentEval.summarize(aRes);
                        var fnLine = function (sName, a) {
                                return sName + "：执行 " + a.run + (a.skipped ? "（跳过 " + a.skipped + "）" : "") +
                                        "，通过 " + a.pass + "（" + a.passRate + "%）" +
                                        "，模型平均 " + a.avgRounds + " 轮 / " + a.avgSeconds + "s（最长 " + a.maxSeconds + "s）" +
                                        "，错误 " + a.errors + "，超时 " + a.timeouts + "，协议错 " + a.protocolErrors + "，工具被拒 " + a.rejected;
                        };
                        var aLines = [fnLine("全部", S.all)];
                        Object.keys(S.byScene).forEach(function (k) {
                                aLines.push("  · " + fnLine(AgentEval.SCENE_TEXT[k], S.byScene[k]));
                        });
                        oM.setProperty("/summaryText", aLines.join("\n"));
                        if (bFinal) {
                                oM.setProperty("/statusText", (this._bEvalStop ? "已停止" : "已完成") + "，用时 " +
                                        Math.round((this._oEvalRun.durationMs || 0) / 1000) + "s。点一行查看问答详情；" +
                                        "可导出报告发给开发分析。");
                        }
                },

                onEvalRowSelect: function (oEvent) {
                        var oItem = oEvent.getParameter("listItem");
                        var oRow = oItem && oItem.getBindingContext("eval") && oItem.getBindingContext("eval").getObject();
                        var r = oRow && ((this._oEvalRun && this._oEvalRun.results) || []).filter(function (x) {
                                return x.id + "#" + x.rep === oRow.key;
                        })[0];
                        if (!r) {
                                return;
                        }
                        var a = [r.id + " " + r.name + "（" + (AgentEval.SCENE_TEXT[r.scene] || r.scene) + "）→ " +
                                (r.skipped ? "跳过" : (r.pass ? "通过" : "失败")) + (r.reasons.length ? "：" + r.reasons.join("；") : "")];
                        r.turns.forEach(function (t, i) {
                                a.push("", "—— 第 " + (i + 1) + " 轮 ——", "问：" + t.question,
                                        "状态 " + t.status + " · " + t.rounds + " 轮 · " + (t.wallMs / 1000).toFixed(1) + "s · 模型 " + (t.modelId || "-") +
                                        (t.taskModule ? " · 任务模块 " + t.taskModule : "") + (t.needsInput ? " · 待填参数" : ""),
                                        "工具：" + (t.tools.map(function (x) { return x.tool + "(" + x.status + (x.rows ? ", " + x.rows + " 行" : "") + ")"; }).join("，") || "无"),
                                        t.message ? "消息：" + t.message : "", "答：", t.answer || "（空）");
                        });
                        this._oEvalModel.setProperty("/detail", a.filter(function (x) { return x !== ""; }).join("\n"));
                },

                _evalStamp: function () {
                        var d = new Date();
                        var p = function (n) { return (n < 10 ? "0" : "") + n; };
                        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
                },

                onEvalExportMd: function () {
                        this._download(AgentEval.toMarkdown(this._oEvalRun || {}), "Agent测评_" + this._evalStamp() + ".md",
                                "text/markdown;charset=utf-8");
                },

                onEvalExportJson: function () {
                        this._download(JSON.stringify(this._oEvalRun || {}, null, 2), "Agent测评明细_" + this._evalStamp() + ".json",
                                "application/json;charset=utf-8");
                },

                onEvalExportCases: function () {
                        var oRaw = (this._oEvalCases && this._oEvalCases.raw) || { cases: [] };
                        this._download(JSON.stringify(oRaw, null, 2), "Agent测评题库_" + this._evalStamp() + ".json",
                                "application/json;charset=utf-8");
                },

                onEvalImport: function (oEvent) {
                        var that = this;
                        var aFiles = oEvent.getParameter("files");
                        var oFile = aFiles && aFiles[0];
                        if (!oFile) {
                                return;
                        }
                        var oReader = new FileReader();
                        oReader.onload = function () {
                                var oRaw = null;
                                try { oRaw = JSON.parse(String(oReader.result || "")); } catch (e) { oRaw = null; }
                                var oN = oRaw ? AgentEval.normalizeCases(oRaw) : { cases: [] };
                                if (!oN.cases.length) {
                                        MessageToast.show("文件里没有可用的题目（需要 {cases:[{scene, turns, expect}]} 格式）");
                                        return;
                                }
                                that._setEvalCases(oRaw, "导入 " + oFile.name);
                                that._evalIdleStatus();
                                MessageToast.show("已导入 " + oN.cases.length + " 题");
                        };
                        oReader.readAsText(oFile, "utf-8");
                        oEvent.getSource().clear();
                }
        };
});
