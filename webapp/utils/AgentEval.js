sap.ui.define([], function () {
        "use strict";

        /**
         * 20261011：Agent 测评（"先测再改"第一步）
         *
         * 按题库逐题调用后端 Agent —— 与用户走同一条链路（前端 → AnalyzeTask → SM59 → 模型），
         * 记录状态 / 轮数 / 耗时 / 工具调用 / 被拒次数 / 回答，按题目预期打分并汇总。
         * 纯逻辑模块：发送与删除会话由调用方注入（opt.send / opt.del），
         * 以后模型改走前端直连时只需换注入的通道，题库与评分不变。
         *
         * 题目格式见 model/evalCases.json；expect 只对最后一轮生效，
         * 所有轮次都要求状态不为 ERROR（除非 expect.status 另行规定）。
         */
        var SCENE_TEXT = { REPORT: "报表执行", FIORI: "Fiori 报表", DATA: "数据分析", INVENTORY: "库存查询", CODE: "代码分析", AUTO: "自动" };

        function normScene(s) {
                var v = String(s || "").toUpperCase();
                return SCENE_TEXT[v] && v !== "AUTO" ? v : "AUTO";
        }

        function lower(s) {
                return String(s || "").toLowerCase();
        }

        var AgentEval = {

                SCENE_TEXT: SCENE_TEXT,

                /** 题库规范化：过滤非法项，补默认值（不抛错，非法项计入 invalid） */
                normalizeCases: function (oRaw) {
                        var aIn = Array.isArray(oRaw) ? oRaw : ((oRaw && oRaw.cases) || []);
                        var aOut = [], iInvalid = 0, mIds = {};
                        aIn.forEach(function (c, i) {
                                var aTurns = (c && Array.isArray(c.turns) ? c.turns : (c && c.question ? [c.question] : []))
                                        .map(function (t) { return String(t || "").trim(); }).filter(Boolean);
                                if (!aTurns.length) {
                                        iInvalid++;
                                        return;
                                }
                                var sId = String((c && c.id) || ("Q" + (i + 1)));
                                while (mIds[sId]) {
                                        sId += "_";
                                }
                                mIds[sId] = true;
                                aOut.push({
                                        id: sId,
                                        name: String(c.name || aTurns[0]).substring(0, 80),
                                        scene: normScene(c.scene),
                                        turns: aTurns.slice(0, 5),
                                        expect: (c.expect && typeof c.expect === "object") ? c.expect : {},
                                        requiresScene: c.requiresScene === true
                                });
                        });
                        return { cases: aOut, invalid: iInvalid };
                },

                /** Trace → 工具调用清单（EXECUTING 行） */
                toolsOf: function (aTrace) {
                        return (aTrace || []).filter(function (p) {
                                return p && p.phase === "EXECUTING" && p.tool;
                        }).map(function (p) {
                                return { tool: p.tool, status: p.status || "", rows: p.rows || 0, label: p.label || "" };
                        });
                },

                /** 一轮的原始响应 → 记录 */
                turnRecord: function (sQuestion, oRes, iWallMs, sError) {
                        oRes = oRes || {};
                        var aTools = this.toolsOf(oRes.trace);
                        var sMsg = String(oRes.message || "");
                        return {
                                question: sQuestion,
                                status: sError ? "ERROR" : String(oRes.status || "").toUpperCase(),
                                rounds: parseInt(oRes.rounds, 10) || 0,
                                elapsedMs: parseInt(oRes.elapsedMs, 10) || 0,
                                wallMs: iWallMs || 0,
                                tools: aTools,
                                rejected: aTools.filter(function (t) { return t.status === "REJECTED"; }).length,
                                sqlRuns: aTools.filter(function (t) { return t.tool === "run_sql" && t.status !== "REJECTED"; }).length,
                                deterministic: !sError && (parseInt(oRes.rounds, 10) || 0) === 0 && /确定性应答/.test(sMsg),
                                protocolError: /不符合协议/.test(sMsg),
                                answer: String(oRes.answer || ""),
                                message: sError ? sError : sMsg,
                                taskModule: String(oRes.taskModule || ""),
                                needsInput: oRes.needsInput === true,
                                modelId: String(oRes.modelId || "")
                        };
                },

                /**
                 * 评分：所有轮次状态检查 + 最后一轮按 expect 检查
                 * @returns {{pass: boolean, reasons: string[]}}
                 */
                score: function (oCase, aTurns) {
                        var e = oCase.expect || {};
                        var aReasons = [];
                        if (!aTurns.length) {
                                return { pass: false, reasons: ["没有任何响应"] };
                        }
                        var aAllowed = Array.isArray(e.status) ? e.status.map(function (s) { return String(s).toUpperCase(); })
                                : (e.status ? [String(e.status).toUpperCase()] : ["OK"]);
                        aTurns.forEach(function (t, i) {
                                if (aAllowed.indexOf(t.status) < 0) {
                                        aReasons.push("第 " + (i + 1) + " 轮状态 " + (t.status || "空") +
                                                (t.message ? "：" + String(t.message).substring(0, 80) : ""));
                                }
                        });
                        var t = aTurns[aTurns.length - 1];
                        var aNames = t.tools.filter(function (x) { return x.status !== "REJECTED"; }).map(function (x) { return x.tool; });
                        var sAns = lower(t.answer);

                        if (e.maxRounds && t.rounds > e.maxRounds) {
                                aReasons.push("轮数 " + t.rounds + " 超过上限 " + e.maxRounds);
                        }
                        if (e.maxSeconds && t.wallMs > e.maxSeconds * 1000) {
                                aReasons.push("耗时 " + Math.round(t.wallMs / 1000) + "s 超过上限 " + e.maxSeconds + "s");
                        }
                        (e.tools || []).forEach(function (sTool) {
                                if (aNames.indexOf(sTool) < 0) {
                                        aReasons.push("没有调用 " + sTool);
                                }
                        });
                        if ((e.toolsAny || []).length && !e.toolsAny.some(function (s) { return aNames.indexOf(s) >= 0; })) {
                                aReasons.push("没有调用 " + e.toolsAny.join(" / ") + " 中的任何一个");
                        }
                        if (e.noTools === true && aNames.length) {
                                aReasons.push("不该调用工具，却调用了 " + aNames.join(", "));
                        }
                        (e.toolsNotOk || []).forEach(function (sTool) {
                                if (t.tools.some(function (x) { return x.tool === sTool && x.status === "OK"; })) {
                                        aReasons.push(sTool + " 不应执行成功（安全用例）");
                                }
                        });
                        (e.answerAll || []).forEach(function (s) {
                                if (sAns.indexOf(lower(s)) < 0) {
                                        aReasons.push("回答缺少「" + s + "」");
                                }
                        });
                        if ((e.answerAny || []).length && !e.answerAny.some(function (s) { return sAns.indexOf(lower(s)) >= 0; })) {
                                aReasons.push("回答里没有「" + e.answerAny.join(" / ") + "」中的任何一个");
                        }
                        if (e.answerRegex) {
                                var oRe = null;
                                try { oRe = new RegExp(e.answerRegex, "i"); } catch (ex) { oRe = null; }
                                if (oRe && !oRe.test(t.answer)) {
                                        aReasons.push("回答不匹配 /" + e.answerRegex + "/");
                                }
                        }
                        if (e.module && t.taskModule && String(e.module).toUpperCase() !== t.taskModule.toUpperCase()) {
                                aReasons.push("任务模块 " + t.taskModule + "，预期 " + e.module);
                        }
                        if (e.needsInput === true && !t.needsInput) {
                                aReasons.push("预期返回待填参数（参数卡），实际没有");
                        }
                        if (e.deterministic === true && !t.deterministic) {
                                aReasons.push("预期确定性应答（不调用模型），实际调用了模型");
                        }
                        return { pass: aReasons.length === 0, reasons: aReasons };
                },

                /**
                 * 顺序执行（不并发，避免占满后台对话进程）
                 * @param {object} opt {cases, repeat, modelId, sceneSupported,
                 *   send(payload) → Promise<sendTask 结果>, del(sessionId) → Promise, newId() → string,
                 *   cleanup, onProgress(oInfo), shouldStop() → boolean}
                 * @returns {Promise<object[]>} 每个 用例×次数 一条结果
                 */
                run: function (opt) {
                        var that = this;
                        var aJobs = [];
                        var iRep = Math.max(1, Math.min(5, parseInt(opt.repeat, 10) || 1));
                        (opt.cases || []).forEach(function (c) {
                                for (var r = 1; r <= iRep; r++) {
                                        aJobs.push({ c: c, rep: r });
                                }
                        });
                        var aResults = [];
                        var fnNext = function (i) {
                                if (i >= aJobs.length || (opt.shouldStop && opt.shouldStop())) {
                                        return Promise.resolve(aResults);
                                }
                                var oJob = aJobs[i], c = oJob.c;
                                var oRes = {
                                        id: c.id, name: c.name, scene: c.scene, rep: oJob.rep,
                                        turns: [], pass: false, skipped: false, reasons: [], sessionId: ""
                                };
                                if (opt.onProgress) {
                                        opt.onProgress({ index: i, total: aJobs.length, item: oRes });
                                }
                                if (c.requiresScene && !opt.sceneSupported) {
                                        oRes.skipped = true;
                                        oRes.reasons = ["后端尚未支持 Scene 参数（SEGW 未加），场景用例跳过"];
                                        aResults.push(oRes);
                                        if (opt.onProgress) {
                                                opt.onProgress({ index: i, total: aJobs.length, item: oRes, done: true });
                                        }
                                        return fnNext(i + 1);
                                }
                                var sSid = opt.newId();
                                oRes.sessionId = sSid;
                                var fnTurn = function (k) {
                                        if (k >= c.turns.length || (opt.shouldStop && opt.shouldStop())) {
                                                return Promise.resolve();
                                        }
                                        var sQ = c.turns[k];
                                        var iT0 = Date.now();
                                        return Promise.resolve().then(function () {
                                                return opt.send({
                                                        sessionId: sSid,
                                                        question: sQ,
                                                        modelId: opt.modelId || "AUTO",
                                                        taskId: "",
                                                        clientRequestId: opt.newId(),
                                                        focusedArtifactId: "",
                                                        scene: c.scene === "AUTO" ? "" : c.scene
                                                });
                                        }).then(function (r) {
                                                oRes.turns.push(that.turnRecord(sQ, r, Date.now() - iT0, ""));
                                        }, function (oErr) {
                                                oRes.turns.push(that.turnRecord(sQ, null, Date.now() - iT0,
                                                        (oErr && oErr.message) || String(oErr)));
                                        }).then(function () {
                                                // 某轮已出错就不再追问（后续轮次失去意义）
                                                var oLast = oRes.turns[oRes.turns.length - 1];
                                                return oLast.status === "ERROR" ? null : fnTurn(k + 1);
                                        });
                                };
                                return fnTurn(0).then(function () {
                                        var oSc = that.score(c, oRes.turns);
                                        oRes.pass = oSc.pass;
                                        oRes.reasons = oSc.reasons;
                                        aResults.push(oRes);
                                        if (opt.onProgress) {
                                                opt.onProgress({ index: i, total: aJobs.length, item: oRes, done: true });
                                        }
                                        if (opt.cleanup && opt.del) {
                                                return Promise.resolve(opt.del(sSid)).catch(function () { /* 清理失败不影响结果 */ });
                                        }
                                        return null;
                                }).then(function () {
                                        return fnNext(i + 1);
                                });
                        };
                        return fnNext(0);
                },

                /** 汇总：总体 + 按场景 */
                summarize: function (aResults) {
                        var fnAgg = function (aList) {
                                var aRun = aList.filter(function (r) { return !r.skipped; });
                                var aTurns = [];
                                aRun.forEach(function (r) { aTurns = aTurns.concat(r.turns); });
                                var aModel = aTurns.filter(function (t) { return !t.deterministic && t.status !== "ERROR"; });
                                var fnAvg = function (a, f) {
                                        return a.length ? a.reduce(function (s, x) { return s + f(x); }, 0) / a.length : 0;
                                };
                                return {
                                        total: aList.length,
                                        run: aRun.length,
                                        skipped: aList.length - aRun.length,
                                        pass: aRun.filter(function (r) { return r.pass; }).length,
                                        passRate: aRun.length ? Math.round(aRun.filter(function (r) { return r.pass; }).length / aRun.length * 100) : 0,
                                        errors: aTurns.filter(function (t) { return t.status === "ERROR"; }).length,
                                        timeouts: aTurns.filter(function (t) { return t.status === "TIMEOUT"; }).length,
                                        protocolErrors: aTurns.filter(function (t) { return t.protocolError; }).length,
                                        rejected: aTurns.reduce(function (s, t) { return s + t.rejected; }, 0),
                                        avgRounds: Math.round(fnAvg(aModel, function (t) { return t.rounds; }) * 10) / 10,
                                        avgSeconds: Math.round(fnAvg(aModel, function (t) { return t.wallMs; }) / 100) / 10,
                                        maxSeconds: Math.round(aModel.reduce(function (m, t) { return Math.max(m, t.wallMs); }, 0) / 100) / 10
                                };
                        };
                        var oOut = { all: fnAgg(aResults), byScene: {} };
                        Object.keys(SCENE_TEXT).forEach(function (k) {
                                var a = aResults.filter(function (r) { return r.scene === k; });
                                if (a.length) {
                                        oOut.byScene[k] = fnAgg(a);
                                }
                        });
                        return oOut;
                },

                /** Markdown 报告（可直接发给开发分析） */
                toMarkdown: function (oRun) {
                        var S = this.summarize(oRun.results || []);
                        var fnRow = function (sName, o) {
                                return "| " + sName + " | " + o.run + (o.skipped ? "（跳过 " + o.skipped + "）" : "") + " | " +
                                        o.pass + " | " + o.passRate + "% | " + o.avgRounds + " | " + o.avgSeconds + "s / " + o.maxSeconds + "s | " +
                                        o.errors + " / " + o.timeouts + " / " + o.protocolErrors + " | " + o.rejected + " |";
                        };
                        var a = [
                                "# Agent 测评报告",
                                "",
                                "- 时间：" + (oRun.startedAt || "") + "（用时 " + Math.round((oRun.durationMs || 0) / 1000) + "s）",
                                "- 模型：" + (oRun.modelId || "AUTO") + "；每题次数：" + (oRun.repeat || 1) +
                                        "；后端场景参数：" + (oRun.sceneSupported ? "已支持" : "未支持（场景用例跳过，其余按自动场景运行）"),
                                "- 题库：" + (oRun.caseVersion || "") + "，共 " + (oRun.caseCount || 0) + " 题",
                                "- 技能：" + (oRun.skillLabel ? oRun.skillLabel + "（选择时版本；实际执行见各轮 Trace）" : "未使用"),
                                "",
                                "## 汇总",
                                "",
                                "| 范围 | 执行 | 通过 | 通过率 | 平均轮数 | 平均/最长耗时 | 错误/超时/协议错 | 被拒次数 |",
                                "|---|---|---|---|---|---|---|---|",
                                fnRow("全部", S.all)
                        ];
                        Object.keys(S.byScene).forEach(function (k) {
                                a.push(fnRow(SCENE_TEXT[k], S.byScene[k]));
                        });
                        a.push("", "## 明细", "", "| 用例 | 场景 | 结果 | 轮数 | 耗时 | 工具调用 | 原因 |", "|---|---|---|---|---|---|---|");
                        (oRun.results || []).forEach(function (r) {
                                var t = r.turns[r.turns.length - 1] || { rounds: "", wallMs: 0, tools: [] };
                                var sTools = t.tools.map(function (x) { return x.tool + (x.status !== "OK" ? "(" + x.status + ")" : ""); }).join(", ");
                                a.push("| " + r.id + " " + r.name + (r.rep > 1 ? " #" + r.rep : "") + " | " + SCENE_TEXT[r.scene] + " | " +
                                        (r.skipped ? "跳过" : (r.pass ? "通过" : "**失败**")) + " | " + t.rounds + " | " +
                                        Math.round(t.wallMs / 100) / 10 + "s | " + (sTools || "—") + " | " +
                                        (r.reasons.join("；") || "") .replace(/\|/g, "/") + " |");
                        });
                        var aFail = (oRun.results || []).filter(function (r) { return !r.pass && !r.skipped; });
                        if (aFail.length) {
                                a.push("", "## 失败用例的回答（截取前 600 字）", "");
                                aFail.forEach(function (r) {
                                        a.push("### " + r.id + " " + r.name + (r.rep > 1 ? " #" + r.rep : ""), "");
                                        r.turns.forEach(function (t, i) {
                                                a.push("**第 " + (i + 1) + " 轮问：** " + t.question, "",
                                                        "- 状态 " + t.status + "，轮数 " + t.rounds + "，耗时 " + Math.round(t.wallMs / 100) / 10 + "s" +
                                                        (t.message ? "，消息：" + t.message.substring(0, 200) : ""),
                                                        "", "```", t.answer.substring(0, 600), "```", "");
                                        });
                                });
                        }
                        return a.join("\n");
                }
        };

        return AgentEval;
});
