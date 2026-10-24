sap.ui.define([
        "zai/chat/service/ChatService",
        "zai/chat/utils/Formatter"
], function (ChatService, Formatter) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：报表运行跟踪（步骤条）
         * =====================================================================
         * 提交后按 runId 轮询运行状态、渲染步骤条、READY 后读取结果并作为新回复插入；
         * 轮询独立于聊天 busy，结果只写回发起时的会话。
         * 以 mixin 方式并入 zai.chat.controller.App（方法里的 this 就是控制器）；
         * 20261011（改进清单 FE-09）从 App.controller.js 原样搬出，逻辑未改。
         * =====================================================================
         */
        return {

                /* ---------------------------------------------------------
                 * V16：报表运行步骤条（提交 → 执行中 → 结果就绪/失败）
                 * 轮询独立于聊天 busy；结果只写回发起时的会话；
                 * TIMEOUT/UNKNOWN 继续查询（不等于作业停止），上限后提示人工核对，不伪造结果
                 * --------------------------------------------------------- */

                _trackRun: function (sUid, sRunId, sSessionId, sShort) {
                        if (!this._sessionMessageState(sSessionId)) { return; }
                        this._mRuns = this._mRuns || Object.create(null);
                        if (this._mRuns[sRunId]) { return; }
                        var oRun = this._mRuns[sRunId] = {
                                uid: sUid, runId: sRunId, sessionId: sSessionId,
                                shortId: sShort || String(sRunId || "").substring(0, 8),
                                start: Date.now(), count: 0, empty: 0,
                                status: "SUBMITTED", phase: "active", message: ""
                        };
                        this._resumeRun(oRun);
                },

                _runByUid: function (sUid) {
                        var aRuns = Object.keys(this._mRuns || {}).map(function (k) { return this._mRuns[k]; }, this);
                        return aRuns.filter(function (o) { return o.uid === sUid; }).pop() || null;
                },

                /** 20261019（改进清单 FE-10）：轮询改退避 —— 前 10 次每 3 秒，之后每次 ×1.3、最长 15 秒一次；
                  * 上限 RUN_POLL_MAX 次（约 12 分钟）。原来固定 3 秒 × 100 次（约 5 分钟）：请求多、等得短 */
                RUN_POLL_MAX: 60,

                /** 第 iCount 次查询之后到下一次查询的间隔（毫秒） */
                _runPollDelay: function (iCount) {
                        return iCount < 10 ? 3000 : Math.min(15000, Math.round(3000 * Math.pow(1.3, iCount - 9)));
                },

                /** 排下一次查询（仅当该运行仍在跟踪中） */
                _scheduleRunPoll: function (o) {
                        var that = this;
                        if (!this._mRuns || this._mRuns[o.runId] !== o || !o.timer) {
                                return;
                        }
                        window.clearTimeout(o.timer);
                        o.timer = window.setTimeout(function () { that._pollRun(o); }, this._runPollDelay(o.count));
                },

                /** 开始 / 恢复轮询（首轮立即查询，之后按退避间隔续排） */
                _resumeRun: function (o) {
                        if (!o) {
                                return;
                        }
                        window.clearTimeout(o.timer);
                        o.phase = "active";
                        o.count = 0;
                        o.empty = 0;
                        o.timer = -1;   // 非空 = 跟踪中；真正的定时器由 _scheduleRunPoll 在每次查询后设置
                        this._syncActivity();
                        this._pollRun(o);
                },

                _stopRun: function (sPhase, o) {
                        if (!o) {
                                return;
                        }
                        if (o.timer) {
                                window.clearTimeout(o.timer);
                                o.timer = null;
                        }
                        o.phase = sPhase;
                        this._renderRun(o);
                        this._syncActivity();
                },

                _pollRun: function (o) {
                        var that = this;
                        if (!o || !o.timer || o.inFlight) {
                                return;
                        }
                        window.clearTimeout(o.timer);   // "立即刷新"时取消已排的下一次，查完再重排
                        o.inFlight = true;
                        o.count++;
                        ChatService.getReportRunStatus(o.runId).then(function (oSts) {
                                o.inFlight = false;
                                if (!that._mRuns || that._mRuns[o.runId] !== o || !o.timer) {
                                        return;
                                }
                                oSts = oSts || {};
                                o.message = oSts.message || oSts.errorMessage || "";
                                if (oSts.shortId) {
                                        o.shortId = oSts.shortId;
                                }
                                if (!oSts.status) {
                                        // 后端未给状态：展示其 message（真实原因），继续查询，连续 5 次后停下等用户刷新
                                        o.status = "UNKNOWN";
                                        if (++o.empty >= 5) {
                                                that._stopRun("stalled", o);
                                                return;
                                        }
                                } else {
                                        o.empty = 0;
                                        o.status = oSts.status;
                                }
                                if (o.status === "FAILED") {
                                        that._stopRun("failed", o);
                                        return;
                                }
                                if (o.status === "READY") {
                                        o.artifactId = oSts.artifactId;
                                        that._stopRun("ready", o);
                                        that._loadRunResult(o);
                                        return;
                                }
                                if (o.count >= that.RUN_POLL_MAX) {
                                        that._stopRun("stalled", o);
                                        return;
                                }
                                that._renderRun(o);
                                that._scheduleRunPoll(o);
                        }).catch(function (e) {
                                // 单次查询失败（网络抖动）不终止轮询，计入次数
                                o.inFlight = false;
                                if (!that._mRuns || that._mRuns[o.runId] !== o || !o.timer) {
                                        return;
                                }
                                o.message = (e && e.message) || "";
                                if (o.count >= that.RUN_POLL_MAX) {
                                        that._stopRun("stalled", o);
                                } else {
                                        that._renderRun(o);
                                        that._scheduleRunPoll(o);
                                }
                        });
                },

                /** READY：结果始终写回发起会话；切走时写入该会话的消息缓存。 */
                _loadRunResult: function (o) {
                        var that = this;
                        var oState = this._sessionMessageState(o.sessionId);
                        if (o.resultLoaded || o.loadingResult || !oState) { return; }
                        if (!o.artifactId || o.artifactId === "undefined") {
                                // 20261011：READY 但结果索引未登记（后端 compress 丢空值键）——不拼 ArtifactId=undefined 去查
                                o.phase = "failed";
                                o.message = o.message || this._rb().getText("runNoArtifact");
                                this._renderRun(o);
                                return;
                        }
                        o.loadingResult = true;
                        return ChatService.getReportResult(o.artifactId).then(function (oRes) {
                                o.loadingResult = false;
                                if (that._sessionMessageState(o.sessionId) !== oState) { return; }
                                if (!oRes || (!oRes.rowsJson && !oRes.schemaJson && !oRes.rowCount)) {
                                        o.phase = "failed";
                                        o.message = (oRes && oRes.message) || that._rb().getText("runResultReadFail");
                                        that._renderRun(o);
                                        return;
                                }
                                that._pushReportResult(oRes, o.runId, { sessionId: o.sessionId });
                                o.resultLoaded = true;
                                // 20261011：记为本会话聚焦结果，之后"分析一下这个结果"带给后端
                                that._mFocusArt = that._mFocusArt || {};
                                that._mFocusArt[o.sessionId] = o.artifactId;
                        }).catch(function (oErr) {
                                o.loadingResult = false;
                                if (that._sessionMessageState(o.sessionId) !== oState) { return; }
                                o.phase = "failed";
                                o.message = (oErr && oErr.message) || that._rb().getText("runResultReadFail");
                                that._renderRun(o);
                        });
                },

                /** 步骤条 HTML（写入发起提交那条回复的 runHtml） */
                _renderRun: function (o) {
                        if (!o) {
                                return;
                        }
                        var oHit = this._entryByUid(o.uid, o.sessionId);
                        if (!oHit) {
                                return;
                        }
                        var esc = Formatter.escapeHtml;
                        var oRB = this._rb();
                        var iSec = Math.round((Date.now() - o.start) / 1000);
                        var bFail = o.phase === "failed";
                        var bReady = o.phase === "ready";
                        var sMid = bReady || bFail ? "done" : (o.phase === "active" ? "on" : "warn");
                        var aSteps = [
                                { st: "done", text: oRB.getText("runStepSubmitted") },
                                { st: sMid, text: o.phase === "active" ? this._taskStatusText(o.status === "SUBMITTED" ? "QUEUED" : o.status) : oRB.getText("runStepExec") },
                                { st: bReady ? "done" : (bFail ? "fail" : "todo"), text: oRB.getText(bFail ? "runStepFailed" : "runStepReady") }
                        ];
                        if (o.status === "UNKNOWN" && o.phase === "active") {
                                aSteps[1].text = oRB.getText("runStepChecking");
                        }
                        var sMsg = o.message;
                        if (o.phase === "active" && o.count > 0) {
                                // 20261011：轮询进度可见（20261019：上限 RUN_POLL_MAX 次，退避后约 12 分钟）
                                sMsg = (sMsg ? sMsg + " · " : "") + oRB.getText("runPollCount", [o.count, this.RUN_POLL_MAX]);
                        }
                        if (o.phase === "stalled") {
                                sMsg = (sMsg ? sMsg + " · " : "") + oRB.getText("runStalled");
                        } else if (o.phase === "stopped") {
                                sMsg = oRB.getText("runStopped");
                        } else if (bReady) {
                                sMsg = sMsg || oRB.getText("runReadyMsg");
                        }
                        var s = '<div class="runCard run-' + o.phase + '" data-uid="' + o.uid + '">' +
                                '<div class="runHead"><span class="runTitle">' + esc(oRB.getText("runTitle", [o.shortId])) + "</span>" +
                                '<span class="runTime">' + esc(oRB.getText("runSeconds", [iSec])) + "</span></div>" +
                                '<div class="runSteps">' + aSteps.map(function (st, i) {
                                        return (i ? '<span class="runLine' + (st.st !== "todo" ? " on" : "") + '"></span>' : "") +
                                                '<span class="runStep st-' + st.st + '"><i></i>' + esc(st.text) + "</span>";
                                }).join("") + "</div>" +
                                (sMsg ? '<div class="runMsg">' + esc(sMsg) + "</div>" : "") +
                                '<div class="runActs">' +
                                (o.phase === "active"
                                        ? '<button type="button" class="dtBtn" data-act="run-refresh">' + esc(oRB.getText("runRefreshNow")) + "</button>" +
                                          '<button type="button" class="dtBtn" data-act="run-stop">' + esc(oRB.getText("runStopTrack")) + "</button>"
                                        : (o.phase === "stalled" || o.phase === "stopped"
                                                ? '<button type="button" class="dtBtn dtPrimary" data-act="run-refresh">' + esc(oRB.getText("runRefresh")) + "</button>" : "")) +
                                "</div></div>";
                        oHit.entry.runHtml = s;
                        if (this._sMessagesSession === o.sessionId) {
                                this.getView().getModel("chat").setProperty("/messages/" + oHit.index + "/runHtml", s);
                        }
                },

                /** READY 结果 → 新一条回复（数据表 + 工具条；用户可自行生成图表）
                  * 20261020：可选 oOpt（Fiori 报表结果复用同一套表格逻辑）——
                  * oOpt.text(iTotal, oDs) 换正文；oOpt.decorate(oEntry, oDs, iTotal) 推入前补字段（如分析闸门 runHtml）
                  * @returns {object} 推入的消息条目 */
                _pushReportResult: function (oRes, sRunId, oOpt) {
                        var oRB = this._rb();
                        var sSid = (oOpt && oOpt.sessionId) || this._sMessagesSession;
                        var oState = this._sessionMessageState(sSid);
                        if (!oState) { return null; }
                        var aCols = [], aRaw = [];
                        try {
                                // 20261011：兼容 {"columns":[…]}（MOCK/EXEC_SAP V1.0e）与旧版纯数组 […]（EXEC_SAP V1.0d）
                                var oSchema = JSON.parse(oRes.schemaJson || "{}");
                                aCols = (Array.isArray(oSchema) ? oSchema : oSchema && oSchema.columns) || [];
                        } catch (e) { aCols = []; }
                        try { aRaw = JSON.parse(oRes.rowsJson || "[]") || []; } catch (e) { aRaw = []; }
                        if (!aCols.length && aRaw.length && !Array.isArray(aRaw[0])) {
                                aCols = Object.keys(aRaw[0]).map(function (k) { return { name: k, label: k }; });
                        }
                        var oDs = {
                                name: oRes.label || oRB.getText("runResultName", [String(sRunId || "").substring(0, 8)]),
                                status: "OK", error: "", truncated: false, elapsedMs: 0,
                                columns: aCols.map(function (c) {
                                        return { name: c.name, label: c.label || c.name, numeric: c.numeric === true ? true : undefined };
                                }),
                                rows: aRaw.slice(0, 2000).map(function (r) {
                                        return Array.isArray(r) ? r : aCols.map(function (c) {
                                                return r[c.name] === undefined || r[c.name] === null ? "" : r[c.name];
                                        });
                                })
                        };
                        var iTotal = parseInt(oRes.rowCount, 10) || oDs.rows.length;
                        oDs.truncated = iTotal > oDs.rows.length;
                        oDs.total = iTotal;   // 20261024：分页查看器标明「后端共 N 行，这里是已取回的部分」
                        var sText = (oOpt && oOpt.text) ? oOpt.text(iTotal, oDs) :
                                oRB.getText("runResultText", [String(sRunId || "").substring(0, 8), iTotal,
                                        oDs.truncated ? oRB.getText("runResultSample", [oDs.rows.length]) : ""]) +
                                (iTotal === 0 ? "\n\n" + oRB.getText("runResultZero") : "");
                        var oEntry = this._buildEntry("assistant", sText, "", "");
                        oEntry.localResult = true;
                        if (oState.mode === "AGENT") {
                                oEntry.sender = this._rb().getText("agentSender");
                        }
                        if (aCols.length && oDs.rows.length) {
                                oEntry.analysis = { summary: "", findings: [], charts: [], datasets: [oDs] };
                                oEntry.extraHtml = this._extraHtml(oEntry);
                        }
                        if (oOpt && oOpt.decorate) {
                                oOpt.decorate(oEntry, oDs, iTotal);
                        }
                        this._appendSessionEntry(sSid, oEntry);
                        return oEntry;
                }
        };
});
