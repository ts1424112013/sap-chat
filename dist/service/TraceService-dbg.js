sap.ui.define([], function () {
        "use strict";

        // AGENT_TRACE_FINISH_V1: HTTP 返回即终态，不依赖后端追加 COMPLETED。
        var TraceService = {
                fixMarker: "AGENT_TRACE_FINISH_V1",
                /** ABAP 数字字符串转整数；缺失/非法值保留为 null，展示时用 --。 */
                parseCount: function (v) {
                        if ((typeof v !== "string" && typeof v !== "number") || String(v).trim() === "") {
                                return null;
                        }
                        var n = Number(v);
                        return isFinite(n) && n >= 0 ? Math.trunc(n) : null;
                },

                /** 兼容 SEGW 属性名和 ABAP JSON 的 camel_case/下划线命名。 */
                _field: function (o, sName) {
                        var sKey = sName.replace(/_/g, "").toLowerCase();
                        var aKeys = Object.keys(o || {});
                        for (var i = 0; i < aKeys.length; i++) {
                                if (aKeys[i].replace(/_/g, "").toLowerCase() === sKey) {
                                        return o[aKeys[i]];
                                }
                        }
                        return undefined;
                },

                parseTrace: function (v) {
                        var a;
                        try {
                                a = typeof v === "string" ? JSON.parse(v) : v;
                        } catch (e) {
                                return { trace: [], valid: false };
                        }
                        if (!Array.isArray(a) || a.some(function (t) {
                                return !t || typeof t !== "object" || Array.isArray(t);
                        })) {
                                return { trace: [], valid: false };
                        }
                        var that = this;
                        return {
                                valid: true,
                                trace: a.map(function (t) {
                                        var sTool = that._field(t, "tool");
                                        return {
                                                phase: String(that._field(t, "phase") || "").toUpperCase(),
                                                label: String(that._field(t, "label") || that._field(t, "summary") || ""),
                                                tool: typeof sTool === "string" ? sTool.trim() : "",
                                                status: String(that._field(t, "status") || "OK").toUpperCase(),
                                                elapsedMs: that.parseCount(that._field(t, "elapsedMs")),
                                                rows: that.parseCount(that._field(t, "rows")),
                                                detail: String(that._field(t, "detail") || "")
                                        };
                                })
                        };
                },

                /** OData V2 可返回直接 ComplexType、函数名包装，或原始 d 包装。 */
                normalizeResult: function (oData, sModelId) {
                        var o = oData && (oData.d || oData) || {};
                        o = o.AnalyzeAgent || o.AgentResult || o;
                        var oTrace = this.parseTrace(this._field(o, "TraceJson"));
                        return {
                                sessionId: this._field(o, "SessionId") || "",
                                answer: this._field(o, "Answer") || "",
                                status: String(this._field(o, "Status") || "OK").toUpperCase(),
                                elapsedMs: this.parseCount(this._field(o, "ElapsedMs")),
                                rounds: this.parseCount(this._field(o, "Rounds")),
                                message: this._field(o, "Message") || "",
                                modelId: this._field(o, "ModelId") || sModelId || "",
                                trace: oTrace.trace,
                                traceValid: oTrace.valid,
                                analysisJson: this._field(o, "AnalysisJson")
                        };
                },

                /** 每条回复独立收口：空/坏 Trace 同样完成，工具按非空 tool 计数。 */
                finish: function (oResult) {
                        var o = oResult || {};
                        var oTrace = this.parseTrace(o.trace);
                        var bValid = o.traceValid !== false && oTrace.valid;
                        return {
                                pending: false,
                                status: String(o.status || "OK").toUpperCase(),
                                rounds: this.parseCount(o.rounds),
                                elapsedMs: this.parseCount(o.elapsedMs),
                                toolCount: bValid ? oTrace.trace.filter(function (t) { return !!t.tool; }).length : null,
                                phases: oTrace.trace
                        };
                },

                stats: function (oFinished) {
                        var o = oFinished || {};
                        return [
                                o.rounds === null || o.rounds === undefined ? "--" : o.rounds,
                                o.toolCount === null || o.toolCount === undefined ? "--" : o.toolCount,
                                o.elapsedMs === null || o.elapsedMs === undefined ? "--" : (o.elapsedMs / 1000).toFixed(1) + "s"
                        ];
                }
        };
        return TraceService;
});
