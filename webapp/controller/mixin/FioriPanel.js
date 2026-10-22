sap.ui.define([
        "sap/m/MessageToast",
        "zai/chat/service/ChatService",
        "zai/chat/utils/Formatter",
        "zai/chat/utils/AskCard"
], function (MessageToast, ChatService, Formatter, AskCard) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：Fiori 报表取数、结果展示与分析闸门
         * =====================================================================
         * 设计：功能计划书/Fiori报表分析/01-方案与开发计划 §3.3、§3.4、§6。
         *  · 参数卡（kind = FIORI 的待填参数）点「取数」→ RunFioriReport（同步）→ 结果作为新回复插入
         *    （表格 / 图表 / 导出沿用 _pushReportResult）
         *  · 结果下方是分析闸门：提示"模型只知道行数和列名"，点「交给模型分析」才发 AnalyzeTask
         *    （问题 = i18n fioriAnalyzeAsk，FocusedArtifactId = 这份结果）；报表未开放分析时不显示按钮
         *  · 与报表执行（StartReportRun / 轮询）完全分开，互不调用
         * 以 mixin 方式并入 zai.chat.controller.App（方法里的 this 就是控制器）；方法名统一 _fiori 前缀。
         * =====================================================================
         */
        return {

                /** 参数卡「取数」（由 _submitReportFromCard 在 oAsk.fiori 时转过来） */
                _fioriSubmit: function (sUid, oAsk, oPick) {
                        var that = this;
                        var oRB = this._rb();
                        var oState = this._sessionMessageState(oAsk.sessionId);
                        if (oPick.missing && oPick.missing.length) {
                                oAsk.error = oRB.getText("askMissing", [oPick.missing.join(oRB.getText("listSep"))]);
                                this._renderAsk(sUid);
                                return;
                        }
                        oAsk.state = "busy";
                        oAsk.error = "";
                        oAsk.busyText = oRB.getText("fioriFetching");
                        this._renderAsk(sUid);
                        ChatService.runFioriReport({
                                sessionId: oAsk.sessionId,
                                taskId: oAsk.taskId,
                                reportId: oAsk.reportId,
                                paramsJson: JSON.stringify(oPick.values || {}),
                                clientRequestId: this._newSessionId()
                        }).then(function (oRes) {
                                if (!oState || that._sessionMessageState(oAsk.sessionId) !== oState) { return; }
                                var aSum = (oAsk.params || []).map(function (p) {
                                        var v = (oPick.values || {})[p.param_id];
                                        return v ? (p.label || p.param_id) + " " + AskCard.valueDisplay(p, v) : "";
                                }).filter(Boolean);
                                oAsk.state = "done";
                                oAsk.resultText = aSum.length
                                        ? oRB.getText("fioriFetchedWith", [aSum.join(oRB.getText("listSepComma"))])
                                        : oRB.getText("fioriFetched");
                                that._renderAsk(sUid);
                                // 结果登记成功时后端已把任务置为完成 → 顶栏徽标同步
                                var oCur = oState.currentTask;
                                if (oRes.artifactId && oCur && oCur.taskId === oAsk.taskId) {
                                        oCur.status = "COMPLETED";
                                        oCur.needsInput = false;
                                        that._setTaskBadge(oCur.module || "FIORI", "COMPLETED", oCur.taskId, oAsk.sessionId);
                                }
                                that._fioriPushResult(oRes, oAsk.sessionId);
                        }).catch(function (oErr) {
                                oAsk.state = "open";
                                oAsk.error = (oErr && oErr.message) || String(oErr);
                                that._renderAsk(sUid);
                        });
                },

                /** 结果 → 新一条回复（表格 + 分析闸门）；记为本会话聚焦结果 */
                _fioriPushResult: function (oRes, sSessionId) {
                        var that = this;
                        var oRB = this._rb();
                        var oEntry = this._pushReportResult(oRes, oRes.runId, {
                                sessionId: sSessionId,
                                text: function (iTotal, oDs) {
                                        return oRB.getText("fioriResultText", [oRes.label || oRes.reportId || "", iTotal,
                                                oDs.truncated ? oRB.getText("runResultSample", [oDs.rows.length]) : "",
                                                ((parseInt(oRes.elapsedMs, 10) || 0) / 1000).toFixed(1)]) +
                                                (oRes.truncated === true || oRes.truncated === "X" ? "\n\n" + oRB.getText("fioriTruncated") : "") +
                                                (iTotal === 0 ? "\n\n" + oRB.getText("fioriZero") : "");
                                },
                                decorate: function (oE, oDs, iTotal) {
                                        oE.fiori = {
                                                artifactId: oRes.artifactId || "",
                                                sessionId: sSessionId,
                                                analyzable: (oRes.analyzeEnabled === "X" || oRes.analyzeEnabled === true) && iTotal > 0 && !!oRes.artifactId,
                                                state: (oRes.analyzed === "X" || oRes.analyzed === true) ? "sent" : "locked"
                                        };
                                        oE.runHtml = that._fioriGateHtml(oE);
                                }
                        });
                        if (oEntry && oRes.artifactId) {
                                this._mFocusArt = this._mFocusArt || {};
                                this._mFocusArt[sSessionId] = oRes.artifactId;
                        }
                        return oEntry;
                },

                /** 分析闸门 HTML（写在结果那条回复的 runHtml；点击走 _onDataAction 的 data-act 委托） */
                _fioriGateHtml: function (oEntry) {
                        var f = oEntry.fiori || {};
                        var esc = Formatter.escapeHtml;
                        var oRB = this._rb();
                        if (!f.analyzable) {
                                return '<div class="fioriGate fgOff" data-uid="' + oEntry.uid + '"><span class="fgLock">' +
                                        esc(oRB.getText(f.artifactId ? "fioriGateOff" : "fioriGateNoArtifact")) + "</span></div>";
                        }
                        if (f.state === "sent") {
                                return '<div class="fioriGate fgSent" data-uid="' + oEntry.uid + '"><span class="fgLock">' +
                                        esc(oRB.getText("fioriGateSent")) + "</span></div>";
                        }
                        return '<div class="fioriGate" data-uid="' + oEntry.uid + '">' +
                                '<span class="fgLock">' + esc(oRB.getText("fioriGateLocked")) + "</span>" +
                                '<button type="button" class="dtBtn dtPrimary" data-act="fiori-analyze">' + esc(oRB.getText("fioriAnalyzeBtn")) + "</button>" +
                                '<span class="fgHint">' + esc(oRB.getText("fioriGateHint")) + "</span></div>";
                },

                /** 「交给模型分析」：标记闸门已发出 → 以这份结果为聚焦结果发出分析请求 */
                _fioriAnalyze: function (oEntry) {
                        var oChat = this.getView().getModel("chat");
                        var f = oEntry.fiori;
                        if (!f || !f.analyzable || f.state === "sent") {
                                return;
                        }
                        if (oChat.getProperty("/busy")) {
                                MessageToast.show(this._rb().getText("busyWait"));
                                return;
                        }
                        var oNow = oChat.getProperty("/currentSession") || {};
                        if ((oNow.id || "") !== f.sessionId) {
                                return;
                        }
                        f.state = "sent";
                        var oHit = this._entryByUid(oEntry.uid);
                        if (oHit) {
                                oChat.setProperty("/messages/" + oHit.index + "/runHtml", this._fioriGateHtml(oEntry));
                        }
                        this._mFocusArt = this._mFocusArt || {};
                        this._mFocusArt[f.sessionId] = f.artifactId;
                        var sAsk = this._rb().getText("fioriAnalyzeAsk");
                        this._executeSend({
                                mode: "AGENT",
                                agentType: oNow.agentType || "FIORI",
                                displayText: sAsk,
                                meta: "",
                                question: sAsk,
                                keepInput: true
                        });
                }
        };
});
