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
                        if (this._oRun && this._oRun.timer) {
                                this._stopRun("stopped");   // 同时只跟踪一个运行，旧卡片标记"已停止跟踪"
                        }
                        this._oRun = {
                                uid: sUid, runId: sRunId, sessionId: sSessionId,
                                shortId: sShort || String(sRunId || "").substring(0, 8),
                                start: Date.now(), count: 0, empty: 0,
                                status: "SUBMITTED", phase: "active", message: ""
                        };
                        this._resumeRun();
                },

                /** 开始 / 恢复轮询（3 秒一次，首轮立即查询） */
                _resumeRun: function () {
                        var that = this, o = this._oRun;
                        if (!o) {
                                return;
                        }
                        if (o.timer) {
                                window.clearInterval(o.timer);
                        }
                        o.phase = "active";
                        o.count = 0;
                        o.empty = 0;
                        o.timer = window.setInterval(function () { that._pollRun(); }, 3000);
                        this._syncActivity();
                        this._pollRun();
                },

                _stopRun: function (sPhase) {
                        var o = this._oRun;
                        if (!o) {
                                return;
                        }
                        if (o.timer) {
                                window.clearInterval(o.timer);
                                o.timer = null;
                        }
                        o.phase = sPhase;
                        this._renderRun();
                        this._syncActivity();
                },

                _pollRun: function () {
                        var that = this, o = this._oRun;
                        if (!o || !o.timer || o.inFlight) {
                                return;
                        }
                        o.inFlight = true;
                        o.count++;
                        ChatService.getReportRunStatus(o.runId).then(function (oSts) {
                                o.inFlight = false;
                                if (that._oRun !== o || !o.timer) {
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
                                                that._stopRun("stalled");
                                                return;
                                        }
                                } else {
                                        o.empty = 0;
                                        o.status = oSts.status;
                                }
                                if (o.status === "FAILED") {
                                        that._stopRun("failed");
                                        return;
                                }
                                if (o.status === "READY") {
                                        o.artifactId = oSts.artifactId;
                                        that._stopRun("ready");
                                        that._loadRunResult(o);
                                        return;
                                }
                                if (o.count >= 100) {
                                        that._stopRun("stalled");
                                        return;
                                }
                                that._renderRun();
                        }).catch(function (e) {
                                // 单次查询失败（网络抖动）不终止轮询，计入次数
                                o.inFlight = false;
                                o.message = (e && e.message) || "";
                                if (o.count >= 100) {
                                        that._stopRun("stalled");
                                } else {
                                        that._renderRun();
                                }
                        });
                },

                /** READY：读取结果，作为新一条回复插入（仅当仍在发起会话中） */
                _loadRunResult: function (o) {
                        var that = this;
                        if (!o.artifactId || o.artifactId === "undefined") {
                                // 20261011：READY 但结果索引未登记（后端 compress 丢空值键）——不拼 ArtifactId=undefined 去查
                                o.phase = "failed";
                                o.message = o.message || "运行已完成，但结果索引未登记（请在 ZAI_RPT_STEP 查看 ARTIFACT 审计行）";
                                this._renderRun();
                                return;
                        }
                        ChatService.getReportResult(o.artifactId).then(function (oRes) {
                                var oNow = that.getView().getModel("chat").getProperty("/currentSession") || {};
                                if ((oNow.id || "") !== o.sessionId) {
                                        return;   // 已切换会话：不把结果写进其他会话
                                }
                                if (!oRes || (!oRes.rowsJson && !oRes.schemaJson && !oRes.rowCount)) {
                                        o.phase = "failed";
                                        o.message = (oRes && oRes.message) || "结果读取失败";
                                        that._renderRun();
                                        return;
                                }
                                that._pushReportResult(oRes, o.runId);
                                // 20261011：记为本会话聚焦结果，之后"分析一下这个结果"带给后端
                                that._mFocusArt = that._mFocusArt || {};
                                that._mFocusArt[o.sessionId] = o.artifactId;
                        });
                },

                /** 步骤条 HTML（写入发起提交那条回复的 runHtml） */
                _renderRun: function () {
                        var o = this._oRun;
                        if (!o) {
                                return;
                        }
                        var oHit = this._entryByUid(o.uid);
                        if (!oHit) {
                                return;
                        }
                        var esc = Formatter.escapeHtml;
                        var iSec = Math.round((Date.now() - o.start) / 1000);
                        var bFail = o.phase === "failed";
                        var bReady = o.phase === "ready";
                        var sMid = bReady || bFail ? "done" : (o.phase === "active" ? "on" : "warn");
                        var aSteps = [
                                { st: "done", text: "已提交" },
                                { st: sMid, text: o.phase === "active" ? this._taskStatusText(o.status === "SUBMITTED" ? "QUEUED" : o.status) : "执行" },
                                { st: bReady ? "done" : (bFail ? "fail" : "todo"), text: bFail ? "失败" : "结果就绪" }
                        ];
                        if (o.status === "UNKNOWN" && o.phase === "active") {
                                aSteps[1].text = "确认状态中";
                        }
                        var sMsg = o.message;
                        if (o.phase === "active" && o.count > 0) {
                                // 20261011：轮询进度可见（上限 100 次，约 5 分钟）
                                sMsg = (sMsg ? sMsg + " · " : "") + "第 " + o.count + "/100 次查询";
                        }
                        if (o.phase === "stalled") {
                                sMsg = (sMsg ? sMsg + " · " : "") + "状态长时间未确认，可稍后刷新或在 SAP 中核对（不伪造结果）";
                        } else if (o.phase === "stopped") {
                                sMsg = "已停止跟踪（SAP 后台作业不受影响）";
                        } else if (bReady) {
                                sMsg = sMsg || "结果已生成，见下方回复";
                        }
                        var s = '<div class="runCard run-' + o.phase + '" data-uid="' + o.uid + '">' +
                                '<div class="runHead"><span class="runTitle">报表运行 ' + esc(o.shortId) + "</span>" +
                                '<span class="runTime">' + iSec + " 秒</span></div>" +
                                '<div class="runSteps">' + aSteps.map(function (st, i) {
                                        return (i ? '<span class="runLine' + (st.st !== "todo" ? " on" : "") + '"></span>' : "") +
                                                '<span class="runStep st-' + st.st + '"><i></i>' + esc(st.text) + "</span>";
                                }).join("") + "</div>" +
                                (sMsg ? '<div class="runMsg">' + esc(sMsg) + "</div>" : "") +
                                '<div class="runActs">' +
                                (o.phase === "active"
                                        ? '<button type="button" class="dtBtn" data-act="run-refresh">立即刷新</button>' +
                                          '<button type="button" class="dtBtn" data-act="run-stop">停止跟踪</button>'
                                        : (o.phase === "stalled" || o.phase === "stopped"
                                                ? '<button type="button" class="dtBtn dtPrimary" data-act="run-refresh">刷新状态</button>' : "")) +
                                "</div></div>";
                        this.getView().getModel("chat").setProperty("/messages/" + oHit.index + "/runHtml", s);
                },

                /** READY 结果 → 新一条回复（数据表 + 工具条；用户可自行生成图表） */
                _pushReportResult: function (oRes, sRunId) {
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
                                name: oRes.label || ("报表结果 " + String(sRunId || "").substring(0, 8)),
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
                        var sText = "**报表结果**（运行 " + String(sRunId || "").substring(0, 8) + "，共 " + iTotal + " 行" +
                                (oDs.truncated ? "，以下为受控样例 " + oDs.rows.length + " 行" : "") + "）" +
                                (iTotal === 0 ? "\n\n0 行结果是有效的业务事实，不是失败。" : "");
                        var oEntry = this._buildEntry("assistant", sText, "", "");
                        if ((this.getView().getModel("chat").getProperty("/currentSession") || {}).mode === "AGENT") {
                                oEntry.sender = this._rb().getText("agentSender");
                        }
                        if (aCols.length && oDs.rows.length) {
                                oEntry.analysis = { summary: "", findings: [], charts: [], datasets: [oDs] };
                                oEntry.extraHtml = this._extraHtml(oEntry);
                        }
                        var oChat = this.getView().getModel("chat");
                        oChat.getProperty("/messages").push(oEntry);
                        oChat.setProperty("/messages", oChat.getProperty("/messages").slice());
                        this._scrollToBottom();
                }
        };
});
