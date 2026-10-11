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
                                MessageToast.show(this._rb().getText("evalBusyClose"));
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
                                        that._setEvalCases(oRaw, that._rb().getText("evalSrcBuiltin"));
                                        return that._oEvalCases;
                                }).catch(function (e) {
                                        that._oEvalCases = { version: "", raw: { cases: [] }, cases: [], invalid: 0, source: that._rb().getText("evalSrcBuiltin") };
                                        MessageToast.show(that._rb().getText("evalCasesLoadFail", [(e && e.message) || e]));
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
                        var oRB = this._rb();
                        this._oEvalModel.setProperty("/statusText",
                                oRB.getText("evalIdle", [oC.source + (oC.version ? " " + oC.version : ""), oC.cases.length, aParts.join(" / ")]) +
                                (oC.invalid ? oRB.getText("evalIdleInvalid", [oC.invalid]) : "") + oRB.getText("sentenceEnd") +
                                (bScene ? "" : oRB.getText("evalIdleNoScene", [iNeed])) +
                                (ChatService.getMode() === "mock" ? " " + oRB.getText("evalIdleMock") : ""));
                },

                onEvalRun: function () {
                        var that = this;
                        var oM = this._oEvalModel;
                        if (oM.getProperty("/running")) {
                                return;
                        }
                        if (this.getView().getModel("chat").getProperty("/busy")) {
                                MessageToast.show(this._rb().getText("evalChatBusy"));
                                return;
                        }
                        var sScene = oM.getProperty("/scene");
                        var aCases = ((this._oEvalCases && this._oEvalCases.cases) || []).filter(function (c) {
                                return sScene === "ALL" || c.scene === sScene;
                        });
                        if (!aCases.length) {
                                MessageToast.show(this._rb().getText("evalNoCases"));
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
                                MessageToast.show(that._rb().getText("evalAborted", [(e && e.message) || e]));
                        });
                },

                onEvalStop: function () {
                        this._bEvalStop = true;
                        this._oEvalModel.setProperty("/statusText", this._rb().getText("evalStopping"));
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
                                oM.setProperty("/statusText", this._rb().getText("evalRunning", [o.index + 1, o.total,
                                        o.item.id + " " + o.item.name + (o.item.rep > 1 ? " #" + o.item.rep : "")]));
                        }
                },

                /** 结果表 + 汇总（bFinal = 跑完） */
                _evalRender: function (bFinal) {
                        var oM = this._oEvalModel;
                        var oRB = this._rb();
                        var aRes = (this._oEvalRun && this._oEvalRun.results) || [];
                        oM.setProperty("/rows", aRes.map(function (r) {
                                var t = r.turns[r.turns.length - 1];
                                return {
                                        key: r.id + "#" + r.rep,
                                        label: r.id + " " + r.name + (r.rep > 1 ? " #" + r.rep : "") + (r.turns.length > 1 ? oRB.getText("evalTurns", [r.turns.length]) : ""),
                                        sceneText: AgentEval.SCENE_TEXT[r.scene] || r.scene,
                                        resultText: oRB.getText(r.skipped ? "evalSkip" : (r.pass ? "evalPass" : "evalFail")),
                                        resultState: r.skipped ? "None" : (r.pass ? "Success" : "Error"),
                                        status: t ? t.status : "",
                                        rounds: t ? String(t.rounds) : "",
                                        seconds: t ? (t.wallMs / 1000).toFixed(1) : "",
                                        tools: t ? (t.tools.map(function (x) {
                                                return x.tool + (x.status !== "OK" ? "(" + x.status + ")" : "");
                                        }).join(", ") || (t.deterministic ? oRB.getText("evalDeterministic") : "—")) : "",
                                        reasons: r.reasons.join(oRB.getText("listSepSemi"))
                                };
                        }));
                        var S = AgentEval.summarize(aRes);
                        var fnLine = function (sName, a) {
                                return oRB.getText("evalSummaryLine", [sName, a.run,
                                        a.skipped ? oRB.getText("evalSummarySkipped", [a.skipped]) : "",
                                        a.pass, a.passRate, a.avgRounds, a.avgSeconds, a.maxSeconds,
                                        a.errors, a.timeouts, a.protocolErrors, a.rejected]);
                        };
                        var aLines = [fnLine(oRB.getText("evalAll"), S.all)];
                        Object.keys(S.byScene).forEach(function (k) {
                                aLines.push("  · " + fnLine(AgentEval.SCENE_TEXT[k], S.byScene[k]));
                        });
                        oM.setProperty("/summaryText", aLines.join("\n"));
                        if (bFinal) {
                                oM.setProperty("/statusText", oRB.getText("evalFinished", [
                                        oRB.getText(this._bEvalStop ? "evalStoppedWord" : "evalDoneWord"),
                                        Math.round((this._oEvalRun.durationMs || 0) / 1000)]));
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
                        var oRB = this._rb();
                        var a = [oRB.getText("evalDHead", [r.id + " " + r.name, AgentEval.SCENE_TEXT[r.scene] || r.scene,
                                oRB.getText(r.skipped ? "evalSkip" : (r.pass ? "evalPass" : "evalFail"))]) +
                                (r.reasons.length ? oRB.getText("evalDReasons", [r.reasons.join(oRB.getText("listSepSemi"))]) : "")];
                        r.turns.forEach(function (t, i) {
                                var aStat = [oRB.getText("evalDStatus", [t.status]), oRB.getText("evalDRounds", [t.rounds]),
                                        (t.wallMs / 1000).toFixed(1) + "s", oRB.getText("evalDModel", [t.modelId || "-"])];
                                if (t.taskModule) {
                                        aStat.push(oRB.getText("evalDModule", [t.taskModule]));
                                }
                                if (t.needsInput) {
                                        aStat.push(oRB.getText("evalDNeedsInput"));
                                }
                                a.push("", oRB.getText("evalDTurn", [i + 1]), oRB.getText("evalDQuestion", [t.question]),
                                        aStat.join(" · "),
                                        oRB.getText("evalDTools", [t.tools.map(function (x) {
                                                return x.tool + "(" + x.status + (x.rows ? ", " + oRB.getText("evalDRows", [x.rows]) : "") + ")";
                                        }).join(oRB.getText("listSepComma")) || oRB.getText("evalDNone")]),
                                        t.message ? oRB.getText("evalDMessage", [t.message]) : "", oRB.getText("evalDAnswer"),
                                        t.answer || oRB.getText("evalDEmpty"));
                        });
                        this._oEvalModel.setProperty("/detail", a.filter(function (x) { return x !== ""; }).join("\n"));
                },

                _evalStamp: function () {
                        var d = new Date();
                        var p = function (n) { return (n < 10 ? "0" : "") + n; };
                        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
                },

                onEvalExportMd: function () {
                        this._download(AgentEval.toMarkdown(this._oEvalRun || {}), this._rb().getText("evalFileReport", [this._evalStamp()]),
                                "text/markdown;charset=utf-8");
                },

                onEvalExportJson: function () {
                        this._download(JSON.stringify(this._oEvalRun || {}, null, 2), this._rb().getText("evalFileDetail", [this._evalStamp()]),
                                "application/json;charset=utf-8");
                },

                onEvalExportCases: function () {
                        var oRaw = (this._oEvalCases && this._oEvalCases.raw) || { cases: [] };
                        this._download(JSON.stringify(oRaw, null, 2), this._rb().getText("evalFileCases", [this._evalStamp()]),
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
                                        MessageToast.show(that._rb().getText("evalImportBad"));
                                        return;
                                }
                                that._setEvalCases(oRaw, that._rb().getText("evalSrcImported", [oFile.name]));
                                that._evalIdleStatus();
                                MessageToast.show(that._rb().getText("evalImported", [oN.cases.length]));
                        };
                        oReader.readAsText(oFile, "utf-8");
                        oEvent.getSource().clear();
                }
        };
});
