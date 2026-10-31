sap.ui.define(["zai/chat/utils/ComboData"], function (ComboData) {
        "use strict";

        /**
         * =====================================================================
         * ChatService 拆分块：组合分析二期的演示模式（mock）后端（20261031）
         * =====================================================================
         * 与 ZCL_AI_COMBO_SERVICE 的语义对应（设计：功能计划书/组合分析/01-二期方案 V1.1）：
         *  · ComboCreate：逐份核对来源（演示里只有 Fiori 结果；未开放分析的报表拒绝）→ 用来源的
         *    全部存储行组合（ComboData.combineBySpec，与后端同口径）→ 统计 + 分组汇总 + 明细举例 →
         *    登记成 COMBO_RESULT（幂等：同一 ClientRequestId 返回同一结果）
         *  · ComboResult：按结果号重读；会话恢复（getSessionResults）也能列出组合结果
         *  · 「组合分析」会话的演示回答（_mockComboAgent）：只复述后端统计与汇总里的数字
         * 开关：localStorage zaiChat.cfg.COMBO_ENABLED（未设 = 开），用来演示"能力未开启"。
         * 以 mixin 方式并入 ChatService（方法里的 this 就是 ChatService）；方法名统一 _mockCombo 前缀。
         * =====================================================================
         */

        var KEY = "zaiChat.mockCombo.v1";
        var KEEP = 20;
        var MODEL_ROWS = 200, MODEL_GROUPS = 50, MODEL_EDGE = 10;

        function toObjRows(oDs) {
                return oDs.rows.map(function (r) {
                        var o = {};
                        oDs.columns.forEach(function (c, i) {
                                var v = r[i] === undefined || r[i] === null ? "" : r[i];
                                o[c.name] = c.numeric && v !== "" && !isNaN(Number(v)) ? Number(v) : v;
                        });
                        return o;
                });
        }

        return {

                _mockComboState: function () {
                        if (!this._oComboMock) {
                                var o = null;
                                try { o = JSON.parse(window.localStorage.getItem(KEY) || "null"); } catch (e) { o = null; }
                                this._oComboMock = o && o.runs ? o : { runs: {}, byRequest: {}, seq: 0 };
                        }
                        return this._oComboMock;
                },

                _mockComboSave: function () {
                        var st = this._oComboMock;
                        if (!st) { return; }
                        var aKeep = Object.keys(st.runs).sort(function (a, b) {
                                return String(st.runs[a].createdAt).localeCompare(String(st.runs[b].createdAt));
                        }).slice(-KEEP);
                        var o = { seq: st.seq, runs: {}, byRequest: {} };
                        aKeep.forEach(function (k) { o.runs[k] = st.runs[k]; });
                        Object.keys(st.byRequest).forEach(function (r) {
                                if (o.runs[st.byRequest[r]]) { o.byRequest[r] = st.byRequest[r]; }
                        });
                        try { window.localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* 存不下：只影响刷新后的演示恢复 */ }
                },

                _mockComboEnabled: function () {
                        var s = null;
                        try { s = window.localStorage.getItem("zaiChat.cfg.COMBO_ENABLED"); } catch (e) { s = null; }
                        return s === null || s === "X";
                },

                /** 会话里登记过的组合结果（getSessionResults 的演示实现） */
                _mockComboArtifacts: function (sSessionId) {
                        var st = this._mockComboState();
                        return Object.keys(st.runs).filter(function (k) { return st.runs[k].sessionId === sSessionId; }).map(function (k) {
                                var r = st.runs[k];
                                return {
                                        artifactId: k, type: "COMBO_RESULT", taskId: "", label: r.result.label,
                                        rowCount: r.result.rowCount, createdAt: r.createdAt, runId: r.result.comboId
                                };
                        });
                },

                /** 一份来源：核对 + 取全部存储行（演示里只有 Fiori 结果） */
                _mockComboSource: function (oSrc, k) {
                        var sName = oSrc.name || ("第 " + (k + 1) + " 份");
                        if (!oSrc.artifactId) {
                                throw new Error("第 " + (k + 1) + " 份「" + sName + "」没有结果号，不能交给模型（数据分析的表、回答里的表格不支持）");
                        }
                        var oRun = this._mockFioriState ? this._mockFioriState().runs[oSrc.artifactId] : null;
                        if (!oRun) {
                                throw new Error("第 " + (k + 1) + " 份「" + sName + "」不能使用：" +
                                        (oSrc.type === "REPORT_RESULT" ? "演示模式没有报表执行的结果" : "结果不存在或已过期"));
                        }
                        if (oRun.def.analyzeEnabled !== "X") {
                                throw new Error("第 " + (k + 1) + " 份「" + sName + "」不能使用：Fiori 报表 " + oRun.def.reportId +
                                        " 未开放模型分析（登记 ANALYZE_ENABLED 为空）");
                        }
                        // 演示状态里的行是按列名作键的对象（同后端 ZAI_FRPT_DATA 的 row_json），这里转成按列顺序的数组
                        var aCols = oRun.ds.columns.map(function (c) {
                                return { name: c.name, label: c.label || c.name, numeric: c.numeric === true };
                        });
                        var oDs = { name: sName, columns: aCols, rows: oRun.ds.rows.map(function (r) {
                                return Array.isArray(r) ? r.slice() : aCols.map(function (c) {
                                        return r[c.name] === undefined || r[c.name] === null ? "" : r[c.name];
                                });
                        }) };
                        oDs.total = oDs.rows.length;
                        return {
                                ds: oDs,
                                info: {
                                        artifactId: oSrc.artifactId, type: "FIORI_RESULT", name: sName, reportId: oRun.def.reportId,
                                        sessionId: oRun.sessionId, stored: oDs.rows.length, total: oDs.rows.length, truncated: false, aggregated: false
                                }
                        };
                },

                _mockComboCreate: function (o) {
                        var Service = this;
                        var st = this._mockComboState();
                        if (o.ClientRequestId && st.byRequest[o.ClientRequestId]) {
                                return st.runs[st.byRequest[o.ClientRequestId]].result;
                        }
                        var oSpec;
                        try { oSpec = JSON.parse(o.SpecJson || "{}"); } catch (e) { throw new Error("组合说明格式不正确"); }
                        var sMode = String(oSpec.mode || "").toUpperCase();
                        if (["APPEND", "JOIN", "SIDE"].indexOf(sMode) < 0) {
                                throw new Error("不认识的组合方式 " + sMode);
                        }
                        var aSrc = oSpec.sources || [];
                        if (aSrc.length < 2) {
                                throw new Error("至少要两份结果才能组合");
                        }
                        var aRead = aSrc.map(function (s, k) { return Service._mockComboSource(s, k); });
                        var aDs = aRead.map(function (x) { return x.ds; });
                        var aNames = aRead.map(function (x) { return x.info.name; });
                        var oComb = ComboData.combineBySpec(aDs, aNames, { mode: sMode === "JOIN" ? "join" : "append", inner: !!oSpec.inner, keys: oSpec.keys || [] });
                        if (sMode === "JOIN" && /已先汇总/.test(oComb.note || "")) {
                                aRead.slice(1).forEach(function (x) {
                                        if (oComb.note.indexOf(x.info.name) >= 0) { x.info.aggregated = true; }
                                });
                        }
                        // 汇总列：指定的列名 → 下标；没有就自动；并排时「来源」放第一个
                        var aBy = (oSpec.groupBy || []).map(function (n) {
                                for (var i = 0; i < oComb.columns.length; i++) {
                                        if (String(oComb.columns[i].name).toUpperCase() === String(n).toUpperCase()) { return i; }
                                }
                                return -1;
                        }).filter(function (i) { return i >= 0; }).slice(0, 2);
                        var aKeyIdx = [];
                        if (sMode === "JOIN") {
                                (oSpec.keys || []).forEach(function (aK) {
                                        (aK || []).forEach(function (p) {
                                                for (var i = 0; i < oComb.columns.length; i++) {
                                                        if (oComb.columns[i].name === p.a && aKeyIdx.indexOf(i) < 0) { aKeyIdx.push(i); }
                                                }
                                        });
                                });
                        }
                        if (!aBy.length) {
                                aBy = ComboData.autoGroup(oComb, sMode === "JOIN" ? aKeyIdx : [0]);
                        }
                        if (sMode === "SIDE") {
                                aBy = [0].concat(aBy.filter(function (i) { return i !== 0; })).slice(0, 2);
                        }
                        // 数值列：与后端 ZCL_AI_ODATA_SHAPER=>is_col_number 同口径（完整数值形态且无前导零，防单据号）
                        var fnNumLike = function (v) {
                                var t = String(v).replace(/,/g, "").trim();
                                return /^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t);
                        };
                        oComb.columns.forEach(function (c, ci) {
                                if (c.numeric === true) { return; }
                                var aVals = oComb.rows.map(function (r) { return r[ci]; }).filter(function (v) { return v !== "" && v !== null && v !== undefined; });
                                c.numeric = aVals.length > 0 && aVals.every(fnNumLike);
                        });
                        var oSum = {
                                stats: this._fioriStats ? this._fioriStats({ columns: oComb.columns, rows: toObjRows(oComb) }) : null,
                                group: ComboData.groupSummary(oComb, aBy, MODEL_GROUPS, aKeyIdx),
                                edge: ComboData.edgeRows(oComb, MODEL_EDGE, MODEL_ROWS),
                                matched: oComb.matched || 0,
                                rowsAll: oComb.rows.length,
                                note: (sMode === "SIDE" ? aDs.length + " 份结果并排（按追加存储，「来源」列区分）成 " + oComb.rows.length + " 行" : oComb.note) || ""
                        };
                        // 明细举例存成行对象（同后端 row_json）
                        var fnObj = function (aRows) { return toObjRows({ columns: oComb.columns, rows: aRows }); };
                        oSum.edge = { all: oSum.edge.all, by: oSum.edge.by, top: fnObj(oSum.edge.top), bottom: fnObj(oSum.edge.bottom) };
                        st.seq++;
                        var sArt = "CART" + ("0000" + st.seq).slice(-4) + "000000000000000000000000";
                        var sNow = Service._mockTime ? Service._mockTime() : "";
                        var oRes = {
                                artifactId: sArt, comboId: "COMBO" + st.seq, sessionId: o.SessionId,
                                label: oSpec.title || ("组合分析：" + aNames.join(sMode === "JOIN" ? " × " : " + ")),
                                mode: sMode,
                                schemaJson: JSON.stringify({ columns: oComb.columns.map(function (c) { return { name: c.name, label: c.label, numeric: !!c.numeric }; }) }),
                                rowsJson: JSON.stringify(toObjRows({ columns: oComb.columns, rows: oComb.rows.slice(0, 2000) })),
                                rowCount: oComb.rows.length,
                                truncated: aRead.some(function (x) { return x.info.truncated; }) ? "X" : "",
                                summaryJson: JSON.stringify(oSum),
                                sourcesJson: JSON.stringify(aRead.map(function (x) { return x.info; })),
                                specJson: o.SpecJson, elapsedMs: 120 + aDs.length * 40, createdAt: sNow,
                                message: ""
                        };
                        st.runs[sArt] = { result: oRes, sessionId: o.SessionId, createdAt: sNow };
                        if (o.ClientRequestId) { st.byRequest[o.ClientRequestId] = sArt; }
                        this._mockComboSave();
                        return oRes;
                },

                _mockComboCall: function (sAction, o) {
                        var Service = this;
                        return new Promise(function (fnResolve, fnReject) {
                                setTimeout(function () {
                                        try {
                                                if (!Service._mockComboEnabled()) {
                                                        throw new Error("组合分析交给模型的能力未开启(COMBO_ENABLED)，请联系管理员");
                                                }
                                                if (sAction === "ComboCreate") {
                                                        fnResolve(JSON.parse(JSON.stringify(Service._mockComboCreate(o))));
                                                } else if (sAction === "ComboResult") {
                                                        var r = Service._mockComboState().runs[o.ArtifactId];
                                                        if (!r) { throw new Error("组合结果不存在或不属于当前用户"); }
                                                        fnResolve(JSON.parse(JSON.stringify(r.result)));
                                                } else {
                                                        throw new Error("未知的函数导入 " + sAction);
                                                }
                                        } catch (e) {
                                                fnReject(e);
                                        }
                                }, 400);
                        });
                },

                /** 这一轮聚焦的是本会话的组合结果？（_mockSendAgent 用） */
                _mockComboFocused: function (oPayload) {
                        var r = this._mockComboState().runs[oPayload.focusedArtifactId || ""];
                        return r && r.sessionId === oPayload.sessionId ? r : null;
                },

                /** 演示的"模型分析"：只复述后端统计与分组汇总里的数字 */
                _mockComboAnswer: function (oRun, sQ) {
                        var r = oRun.result;
                        var oSum = {}, aSrc = [];
                        try { oSum = JSON.parse(r.summaryJson || "{}"); } catch (e) { oSum = {}; }
                        try { aSrc = JSON.parse(r.sourcesJson || "[]"); } catch (e) { aSrc = []; }
                        var a = ["【演示模式】以下解读只用了后端统计和分组汇总（真实环境由模型基于这些内容回答）：", ""];
                        a.push("◆ 「" + r.label + "」由 " + aSrc.length + " 份结果" + ({ JOIN: "关联", APPEND: "追加", SIDE: "并排" }[r.mode] || "") +
                                "而成，共 " + r.rowCount + " 行。" + (oSum.note ? oSum.note + "。" : ""));
                        var s = oSum.stats;
                        (s && s.numeric || []).slice(-3).forEach(function (n) {
                                a.push("◆ " + n.label + "：合计 " + n.sum + "，最大 " + n.max + (n.maxAt ? "（" + n.maxAt + "）" : "") + "。");
                        });
                        var g = oSum.group;
                        if (g && g.groups && g.groups.length && g.measures.length) {
                                a.push("◆ 按「" + g.by.join(" / ") + "」汇总（共 " + g.groupCount + " 组），" + g.measures[0] + " 前几组：" +
                                        g.groups.slice(0, 3).map(function (x) { return x.key.join(" / ") + " " + x.sums[0]; }).join("、") + "。");
                        }
                        if (!/分析|解读|总结|洞察/.test(sQ)) {
                                a.push("", "（针对你的追问「" + sQ + "」：演示模式不调用模型，只回显上面的统计。）");
                        }
                        return a.join("\n");
                },

                _mockComboAgent: function (oPayload, oRun) {
                        var Service = this;
                        return new Promise(function (fnResolve) {
                                setTimeout(function () {
                                        var sAnswer = Service._mockComboAnswer(oRun, String(oPayload.question || ""));
                                        var oStore = Service._mockStore();
                                        var aHist = oStore.messages[oPayload.sessionId] = oStore.messages[oPayload.sessionId] || [];
                                        var sNow = Service._mockTime();
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "user", Content: oPayload.question, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "assistant", Content: sAnswer, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        var oSess = oStore.sessions.filter(function (x) { return x.SessionId === oPayload.sessionId; })[0];
                                        if (!oSess) {
                                                oStore.sessions.unshift({
                                                        SessionId: oPayload.sessionId, Title: oRun.result.label, ModelId: oPayload.modelId || "",
                                                        MsgCount: "2", CreatedAt: sNow, ChangedAt: sNow, Mode: "AGENT", AgentType: "AUTO", Status: "COMPLETED"
                                                });
                                        } else {
                                                oSess.ChangedAt = sNow;
                                                oSess.MsgCount = String((parseInt(oSess.MsgCount || "0", 10) || 0) + 2);
                                                oSess.Status = "COMPLETED";
                                        }
                                        Service._mockSave(oStore);
                                        fnResolve({
                                                answer: sAnswer, status: "OK", elapsedMs: 1400, rounds: 1, message: "",
                                                modelId: oPayload.modelId || "AUTO",
                                                trace: [
                                                        { phase: "UNDERSTANDING", label: "理解问题", status: "OK", elapsedMs: 0 },
                                                        { phase: "COMPOSING", label: "分析组合结果（用户已同意）", status: "OK", elapsedMs: 900 }
                                                ],
                                                analysis: null, taskId: "CTASK" + String(oPayload.sessionId || "").substring(0, 8),
                                                taskModule: "COMBO", taskStatus: "COMPLETED", needsInput: false, pendingParamsJson: "", artifactRefsJson: ""
                                        });
                                }, 600);
                        });
                }
        };
});
