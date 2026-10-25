sap.ui.define([
        "zai/chat/service/ChatService",
        "zai/chat/utils/AskCard",
        "zai/chat/utils/ChartRenderer"
], function (ChatService, AskCard, ChartRenderer) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：刷新 / 重新打开会话后恢复结果表、图表与卡片（改进清单 DATA-01）
         * =====================================================================
         * 历史消息表只存文字，结果表、图表、参数卡原来只活在本页内存里，刷新就没了。现在首次打开一个会话时
         * （包括刷新页面后），在历史消息显示之后补回：
         *  ① 报表执行 / Fiori 报表的结果卡：任务接口查出本会话登记过的结果（ZAI_ARTIFACT），按 ArtifactId
         *     重新取明细（ReportResult / FioriReportResult），按登记时间插回原位置 —— 换台电脑也在；
         *  ② 用户生成的图表：本机 localStorage 只记"哪张表画了什么图"（图表配置，不存数据），套回恢复的表格；
         *  ③ 刷新前还在跑的报表：本机记下运行号，继续轮询；结果就绪后照常插入；
         *  ④ 还没提交的参数卡（任务 WAITING_INPUT 的待填参数），以及最后一条回复里的选项追问。
         * 不恢复：数据分析（SQL）的数据集 —— 后端只登记行数、不存明细，刷新后只剩文字回答。
         * 不需要改 ABAP / SE11 / SEGW；任务接口不可用时什么都不补，历史照常显示。
         * 以 mixin 方式并入 zai.chat.controller.App（方法里的 this 就是控制器）；
         * 方法名统一 _rr 前缀（result restore），避免与控制器 / 其他 mixin 重名。
         * =====================================================================
         */

        /** 本机记录：每个用户一份，按会话分组，只留最近 KEEP_SESSIONS 个会话 */
        var STORE_PREFIX = "zaiChat.extras.v1.";
        var KEEP_SESSIONS = 40;
        /** 记下的运行号超过这个时间不再自动续跟（作业早该结束；结果若已登记会走 ① 恢复） */
        var RUN_MAX_AGE_MS = 24 * 3600 * 1000;
        /** 一个会话最多恢复最近几份报表结果（每份都要单独取一次明细） */
        var MAX_RESULTS = 10;
        /** 参数卡挂到哪条回复：任务最后修改时间前后的容差（毫秒） */
        var ASK_AFTER_MS = 5000, ASK_BEFORE_MS = 10 * 60 * 1000;

        /** YYYYMMDDhhmmss → 毫秒（本地时间；格式不对返回 NaN） */
        function ts14ToMs(s) {
                var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || ""));
                if (!m) {
                        return NaN;
                }
                return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        }

        /** 正文短哈希（FNV-1a），只用来认出"同一条回复"，不需要防碰撞 */
        function hashText(s) {
                var h = 2166136261;
                s = String(s || "");
                for (var i = 0; i < s.length; i++) {
                        h ^= s.charCodeAt(i);
                        h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0;
                }
                return h.toString(36);
        }

        return {

                /* ---------------------------------------------------------
                 * 本机记录（localStorage；读写失败 = 没有记录，不影响主流程）
                 * --------------------------------------------------------- */

                _rrKey: function () {
                        return STORE_PREFIX + this._modelUserKey();
                },

                _rrRead: function () {
                        var o = null;
                        try { o = JSON.parse(window.localStorage.getItem(this._rrKey()) || "null"); } catch (e) { o = null; }
                        return o && typeof o === "object" && o.s && typeof o.s === "object" ? o : { s: {} };
                },

                _rrWrite: function (o) {
                        var aSids = Object.keys(o.s).sort(function (a, b) { return (o.s[b].t || 0) - (o.s[a].t || 0); });
                        aSids.slice(KEEP_SESSIONS).forEach(function (k) { delete o.s[k]; });
                        try { window.localStorage.setItem(this._rrKey(), JSON.stringify(o)); } catch (e) { /* 存不下：只影响刷新后的恢复 */ }
                },

                /** 取（可选新建）某个会话的记录，并刷新它的最近使用时间 */
                _rrSession: function (o, sSid, bCreate) {
                        if (!sSid) {
                                return null;
                        }
                        if (!o.s[sSid]) {
                                if (!bCreate) {
                                        return null;
                                }
                                o.s[sSid] = {};
                        }
                        o.s[sSid].t = Date.now();
                        return o.s[sSid];
                },

                /** 删除会话时一并清掉本机记录 */
                _rrDropSession: function (sSid) {
                        var o = this._rrRead();
                        if (o.s[sSid]) {
                                delete o.s[sSid];
                                this._rrWrite(o);
                        }
                },

                /**
                  * 条目的稳定锚点（跨刷新认出同一条消息）：
                  * 报表 / Fiori 结果 = "a:<ArtifactId>"；普通回复 = "h:<正文哈希>:<本会话第几条同样正文的回复>"
                  */
                _rrAnchor: function (oEntry, aMsgs) {
                        if (!oEntry) {
                                return "";
                        }
                        if (oEntry.artifactId) {
                                return "a:" + oEntry.artifactId;
                        }
                        if (oEntry.role !== "assistant" || !oEntry.raw || oEntry.streaming) {
                                return "";
                        }
                        var n = 0;
                        for (var i = 0; i < (aMsgs || []).length && aMsgs[i] !== oEntry; i++) {
                                if (aMsgs[i].role === "assistant" && !aMsgs[i].artifactId && aMsgs[i].raw === oEntry.raw) {
                                        n++;
                                }
                        }
                        return "h:" + hashText(oEntry.raw) + ":" + n;
                },

                /**
                  * 图表增删改后记下配置。只记刷新后能重新拿到数据的：结果卡上的表（ds:n，明细从后端重取）、
                  * 正文 Markdown 表格（md:n，正文在历史里）。数据分析数据集上的图（ds:n 且不是结果卡）不记。
                  */
                _rrSaveCharts: function (oEntry) {
                        var sSid = this._sMessagesSession;
                        var oState = sSid ? this._sessionMessageState(sSid) : null;
                        var sKey = oState ? this._rrAnchor(oEntry, oState.messages) : "";
                        if (!sKey) {
                                return;
                        }
                        var aKeep = (oEntry.userCharts || []).filter(function (c) {
                                return oEntry.artifactId ? /^ds:\d+$/.test(c.src || "") : /^md:\d+$/.test(c.src || "");
                        }).map(function (c) {
                                return { id: c.id, src: c.src, cfg: c.cfg };
                        });
                        var o = this._rrRead();
                        var oS = this._rrSession(o, sSid, aKeep.length > 0);
                        if (!oS) {
                                return;
                        }
                        oS.charts = oS.charts || {};
                        if (aKeep.length) {
                                oS.charts[sKey] = aKeep;
                        } else {
                                delete oS.charts[sKey];
                        }
                        this._rrWrite(o);
                },

                /** 开始跟踪报表运行时记下运行号（刷新后续跟） */
                _rrRememberRun: function (oRun) {
                        if (!oRun || !oRun.sessionId || !oRun.runId) {
                                return;
                        }
                        var o = this._rrRead();
                        var oS = this._rrSession(o, oRun.sessionId, true);
                        oS.runs = oS.runs || {};
                        oS.runs[oRun.runId] = { shortId: oRun.shortId || "", start: oRun.start || Date.now() };
                        this._rrWrite(o);
                },

                /** 运行有了结论（就绪 / 失败）或用户点了「停止跟踪」：不再续跟 */
                _rrForgetRun: function (oRun) {
                        if (!oRun || !oRun.sessionId) {
                                return;
                        }
                        var o = this._rrRead();
                        var oS = o.s[oRun.sessionId];
                        if (oS && oS.runs && oS.runs[oRun.runId]) {
                                delete oS.runs[oRun.runId];
                                this._rrWrite(o);
                        }
                },

                /** 用户取消了参数卡：刷新后不再把它恢复成待填 */
                _rrDismissAsk: function (sSid, sTaskId) {
                        if (!sSid || !sTaskId) {
                                return;
                        }
                        var o = this._rrRead();
                        var oS = this._rrSession(o, sSid, true);
                        oS.dismissed = oS.dismissed || {};
                        oS.dismissed[sTaskId] = 1;
                        this._rrWrite(o);
                },

                /* ---------------------------------------------------------
                 * 恢复（_readSessionHistory 首次读完历史后调用）
                 * --------------------------------------------------------- */

                /** 会话还在、还是这一份缓存（删除 / 重新登录后旧请求的结果直接丢弃） */
                _rrLive: function (sSid, oState) {
                        return !!(this._mSessionMessages && this._mSessionMessages[sSid] === oState);
                },

                /**
                  * @param {string} sSid 会话
                  * @param {object} oState 该会话的消息缓存（SessionMessages）
                  * @param {boolean} bAgent 是否 Agent 会话（只有 Agent 会话有报表结果 / 任务）
                  * @returns {Promise} 补完（或无事可做）后 resolve；从不 reject
                  */
                _rrRestore: function (sSid, oState, bAgent) {
                        var that = this;
                        if (!oState || oState.extrasRestored) {
                                return Promise.resolve();
                        }
                        oState.extrasRestored = true;
                        var oLocal = this._rrSession(this._rrRead(), sSid, false) || {};
                        var mCharts = oLocal.charts || {};
                        var bMd = this._rrMdCharts(oState.messages, mCharts);
                        var pRemote = bAgent
                                ? Promise.resolve().then(function () { return ChatService.getSessionResults(sSid); })
                                : Promise.resolve(null);
                        return pRemote.then(function (oRes) {
                                if (!oRes || !that._rrLive(sSid, oState)) {
                                        return null;   // 注意别返回 []：数组自带 entries 方法，下面会被当成条目列表
                                }
                                var aArts = (oRes.artifacts || []).slice(-MAX_RESULTS);
                                return Promise.all(aArts.map(function (a) {
                                        return that._rrFetchResult(a, sSid).catch(function (e) {
                                                console.warn("[DATA-01] 结果 " + a.artifactId + " 恢复失败: " + ((e && e.message) || e));
                                                return null;
                                        });
                                })).then(function (aEntries) {
                                        return { entries: aEntries.filter(Boolean), tasks: oRes.tasks || [] };
                                });
                        }).catch(function (e) {
                                console.warn("[DATA-01] 会话结果索引读取失败: " + ((e && e.message) || e));
                                return null;
                        }).then(function (oGot) {
                                if (!that._rrLive(sSid, oState)) {
                                        return;
                                }
                                var aNew = (oGot && oGot.entries) || [];
                                aNew.forEach(function (oEntry) {
                                        that._rrAttachResultCharts(oEntry, mCharts[that._rrAnchor(oEntry)]);
                                });
                                var aRuns = bAgent ? that._rrRunEntries(sSid, oLocal.runs || {}) : [];
                                that._rrApply(sSid, oState, aNew, aRuns, function () {
                                        var bAsk = that._rrPendingAsk(sSid, oState, (oGot && oGot.tasks) || [], oLocal.dismissed || {});
                                        if (!bAsk) {
                                                that._rrChoiceAsk(oState);
                                        }
                                        if (aNew.length) {
                                                that._mFocusArt = that._mFocusArt || {};
                                                if (!that._mFocusArt[sSid]) {
                                                        that._mFocusArt[sSid] = aNew[aNew.length - 1].artifactId;
                                                }
                                        }
                                        return aNew.length > 0 || aRuns.length > 0 || bMd || bAsk;
                                });
                        });
                },

                /** 取回一份结果的明细，造出结果卡条目（不插入；时间用登记时间） */
                _rrFetchResult: function (oArt, sSid) {
                        var that = this;
                        var fnMark = function (oEntry) {
                                if (oEntry) {
                                        oEntry.ts = oArt.createdAt;
                                        oEntry.artifactId = oEntry.artifactId || oArt.artifactId;
                                        oEntry.restored = true;
                                }
                                return oEntry;
                        };
                        if (oArt.type === "FIORI_RESULT") {
                                return ChatService.getFioriReportResult(oArt.artifactId).then(function (oRes) {
                                        oRes = oRes || {};
                                        oRes.artifactId = oRes.artifactId || oArt.artifactId;
                                        return fnMark(that._fioriPushResult(oRes, sSid, { noAppend: true, time: oArt.createdAt }));
                                });
                        }
                        return ChatService.getReportResult(oArt.artifactId).then(function (oRes) {
                                if (!oRes || (!oRes.rowsJson && !oRes.schemaJson && !oRes.rowCount)) {
                                        throw new Error((oRes && oRes.message) || "结果已失效");
                                }
                                oRes.artifactId = oRes.artifactId || oArt.artifactId;
                                oRes.label = oRes.label || oArt.label;
                                return fnMark(that._pushReportResult(oRes, oArt.runId, { sessionId: sSid, noAppend: true, time: oArt.createdAt }));
                        });
                },

                /** 结果卡：把记下的图表配置套回恢复的数据集 */
                _rrAttachResultCharts: function (oEntry, aSaved) {
                        var aDs = (oEntry && oEntry.analysis && oEntry.analysis.datasets) || [];
                        var aCharts = (aSaved || []).map(function (c) {
                                var m = /^ds:(\d+)$/.exec(c.src || "");
                                var oDs = m ? aDs[parseInt(m[1], 10)] : null;
                                return oDs && c.cfg ? { id: c.id, src: c.src, cfg: c.cfg, ds: oDs } : null;
                        }).filter(Boolean);
                        if (aCharts.length) {
                                oEntry.userCharts = aCharts;
                                oEntry.extraHtml = this._extraHtml(oEntry);
                        }
                },

                /** 历史回复正文里的 Markdown 表格：把记下的图表配置套回去（同步；正文在历史里） */
                _rrMdCharts: function (aMsgs, mCharts) {
                        var that = this, bAny = false;
                        if (!Object.keys(mCharts).length) {
                                return false;
                        }
                        (aMsgs || []).forEach(function (oEntry) {
                                var aSaved = mCharts[that._rrAnchor(oEntry, aMsgs)];
                                if (!aSaved || !/^h:/.test(that._rrAnchor(oEntry, aMsgs)) || (oEntry.userCharts || []).length) {
                                        return;
                                }
                                var aCharts = aSaved.map(function (c) {
                                        var m = /^md:(\d+)$/.exec(c.src || "");
                                        var oDs = m ? that._rrMdDataset(oEntry, parseInt(m[1], 10)) : null;
                                        return oDs && c.cfg ? { id: c.id, src: c.src, cfg: c.cfg, ds: oDs } : null;
                                }).filter(Boolean);
                                if (aCharts.length) {
                                        oEntry.userCharts = aCharts;
                                        bAny = true;
                                }
                        });
                        return bAny;
                },

                /** 正文第 n 个表格的数据（与表格工具条取数同一口径：工具条前一个兄弟节点里的 table） */
                _rrMdDataset: function (oEntry, n) {
                        if (typeof document === "undefined") {
                                return null;
                        }
                        var oTmp = document.createElement("div");
                        oTmp.innerHTML = oEntry.html || "";
                        var oTools = oTmp.querySelectorAll(".dataTools")[n];
                        var oPrev = oTools && oTools.previousElementSibling;
                        return ChartRenderer.fromTable(oPrev && (oPrev.tagName === "TABLE" ? oPrev : oPrev.querySelector("table")));
                },

                /** 刷新前还在跑的运行：造出"继续跟踪"的条目（插入后再开始轮询） */
                _rrRunEntries: function (sSid, mRuns) {
                        var that = this, aOut = [];
                        Object.keys(mRuns).forEach(function (sRunId) {
                                var r = mRuns[sRunId] || {};
                                if ((that._mRuns && that._mRuns[sRunId]) || !(Date.now() - (r.start || 0) < RUN_MAX_AGE_MS)) {
                                        return;
                                }
                                var sShort = r.shortId || String(sRunId).substring(0, 8);
                                var oEntry = that._buildEntry("assistant", that._rb().getText("runResumedText", [sShort]), "", "");
                                oEntry.sender = that._rb().getText("agentSender");
                                oEntry.localResult = true;
                                oEntry.resumeRun = { runId: sRunId, shortId: sShort, start: r.start };
                                aOut.push(oEntry);
                        });
                        return aOut;
                },

                /**
                  * 把恢复的条目插进消息列表并刷新界面。回复正在流式输出时整表重建会打断打字机，
                  * 等它结束再插（每 0.8 秒看一次）。fnAfter 在插入后执行（挂卡片等），返回 true 表示需要重绘。
                  */
                _rrApply: function (sSid, oState, aResults, aRuns, fnAfter) {
                        var that = this;
                        var oChat = this.getView().getModel("chat");
                        var fnGo = function () {
                                if (!that._rrLive(sSid, oState)) {
                                        return;
                                }
                                var bCurrent = that._sMessagesSession === sSid;
                                if (bCurrent && oChat.getProperty("/busy")) {
                                        setTimeout(fnGo, 800);
                                        return;
                                }
                                that._sessionMessageState(sSid);   // 先同步：本会话在显示时以界面上的数组为准
                                var aMsgs = oState.messages;
                                aResults.forEach(function (oEntry) {
                                        if (that._rrHasArtifact(aMsgs, oEntry.artifactId)) {
                                                return;
                                        }
                                        if (!oEntry.ts) {
                                                aMsgs.push(oEntry);   // 没有登记时间：放最后，不插到最前面
                                                return;
                                        }
                                        var i = 0;
                                        while (i < aMsgs.length && aMsgs[i].ts && aMsgs[i].ts <= oEntry.ts) {
                                                i++;
                                        }
                                        aMsgs.splice(i, 0, oEntry);
                                });
                                aRuns.forEach(function (oEntry) { aMsgs.push(oEntry); });
                                var bDirty = fnAfter ? fnAfter() : true;
                                if (bCurrent && (bDirty || aResults.length || aRuns.length)) {
                                        var bBottom = that._isNearBottom();
                                        oChat.setProperty("/messages", aMsgs.slice());
                                        that._setViewLayout(true);
                                        if (bBottom) {
                                                that._scrollToBottom();
                                        }
                                        setTimeout(function () { that._highlightCodeBlocks(); }, 150);
                                }
                                aRuns.forEach(function (oEntry) {
                                        var r = oEntry.resumeRun;
                                        that._trackRun(oEntry.uid, r.runId, sSid, r.shortId, r.start);
                                });
                        };
                        fnGo();
                },

                _rrHasArtifact: function (aMsgs, sArt) {
                        return !!sArt && (aMsgs || []).some(function (m) { return m.artifactId === sArt; });
                },

                /**
                  * 还没提交的参数卡：最近一个 WAITING_INPUT 且带待填参数的任务，挂到它最后修改时间之前最近的一条回复上。
                  * 同时恢复顶栏的当前任务徽标（后续用文字补参数时归到这个任务）。
                  * @returns {boolean} 是否挂上了卡片
                  */
                _rrPendingAsk: function (sSid, oState, aTasks, mDismissed) {
                        var that = this;
                        var oTask = (aTasks || []).filter(function (t) {
                                return t.status === "WAITING_INPUT" && t.pending_json && !mDismissed[t.task_id];
                        }).sort(function (a, b) {
                                return String(b.changed_at || "").localeCompare(String(a.changed_at || ""));
                        })[0];
                        if (!oTask) {
                                return false;
                        }
                        var oPend = this._parsePending(oTask.pending_json);
                        if (!oPend.params.length) {
                                return false;
                        }
                        var iAt = ts14ToMs(oTask.changed_at);
                        var aMsgs = oState.messages, oHit = null;
                        for (var i = aMsgs.length - 1; i >= 0 && !isNaN(iAt); i--) {
                                var iTs = ts14ToMs(aMsgs[i].ts);
                                if (aMsgs[i].role !== "assistant" || aMsgs[i].artifactId || isNaN(iTs) || iTs > iAt + ASK_AFTER_MS) {
                                        continue;
                                }
                                if (iTs >= iAt - ASK_BEFORE_MS && !aMsgs[i].ask) {
                                        oHit = aMsgs[i];
                                }
                                break;
                        }
                        if (!oHit) {
                                return false;
                        }
                        var oCur = {
                                taskId: oTask.task_id,
                                shortId: String(oTask.task_id || "").substring(0, 8),
                                module: oTask.module_id || "",
                                status: oTask.status,
                                needsInput: true,
                                sessionId: sSid,
                                reportId: (oPend.obj && oPend.obj.report_id) || "",
                                tcode: (oPend.obj && oPend.obj.tcode) || ""
                        };
                        var oAsk = this._paramAsk(oCur, oPend.obj, oPend.params, sSid);
                        if (!oAsk) {
                                return false;
                        }
                        oAsk.autoFocus = false;
                        oHit.ask = oAsk;
                        if (!oAsk.fiori) {
                                this._enrichReportAsk(oHit);
                        }
                        oState.currentTask = oCur;
                        if (this._sMessagesSession === sSid) {
                                this.getView().getModel("chat").setProperty("/currentTask", oCur);
                        }
                        that._setTaskBadge(oCur.module, oCur.status, oCur.taskId, sSid);
                        return true;
                },

                /** 最后一条是带编号选项的追问、且还没人回答：把选项卡挂回去（与回复结束时 _attachAskCard 同一口径） */
                _rrChoiceAsk: function (oState) {
                        var aMsgs = oState.messages;
                        var oLast = aMsgs[aMsgs.length - 1];
                        if (!oLast || oLast.role !== "assistant" || oLast.ask || oLast.localResult || oLast.artifactId) {
                                return false;
                        }
                        var oDet = AskCard.detectChoices(oLast.raw);
                        if (!oDet) {
                                return false;
                        }
                        oLast.ask = {
                                kind: "choice", state: "open", title: oDet.question,
                                options: oDet.options, freePh: this._rb().getText("askChoiceFreePh"), sel: 0, autoFocus: false
                        };
                        return true;
                }
        };
});
