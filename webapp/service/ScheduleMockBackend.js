sap.ui.define(["zai/chat/utils/ScheduleData"], function (ScheduleData) {
        "use strict";

        /**
         * =====================================================================
         * ChatService 拆分块：定时任务的演示模式（mock）后端（20261104）
         * =====================================================================
         * 与 ZCL_AI_SCHEDULE_SERVICE 的语义对应（设计：功能计划书/定时任务/01-方案 V1.1）：
         *  · ScheduleSave：校验（名称 / 指令或数据来源 / 场景 / 触发）→ 新建或修改；数据来源只能来自结果号，
         *    参数里只有日期能改（值必须是日期或认识的相对日期记号）
         *  · ScheduleList / ScheduleRuns / ScheduleAction（PAUSE / RESUME / DELETE / RUNNOW / SEEN / PREFILL）
         *  · RUNNOW：演示里不真跑报表，只写一条运行记录（参数按今天换算）并置未读
         * 数据存 localStorage zaiChat.mockSched.v1；方法名统一 _mockSched 前缀。
         * =====================================================================
         */

        var KEY = "zaiChat.mockSched.v1";
        var MAX_PER_USER = 10;
        var KEEP_RUNS = 30;

        function now14() {
                var d = new Date();
                var p = function (n) { return (n < 10 ? "0" : "") + n; };
                return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        }

        function today() {
                return now14().substring(0, 8);
        }

        /** 演示用的数据来源（PREFILL）：一张报表执行 + 一张 Fiori */
        function demoSource(sArt) {
                var bFiori = /FIORI|^F/i.test(String(sArt || ""));
                var t = today();
                return bFiori ? {
                        srcType: "FIORI", reportId: "SHIPMENT", reportName: "出货明细（演示）",
                        params: [
                                { paramId: "Werks", label: "工厂", dataType: "STRING", isRange: "", isMulti: "", value: "1000" },
                                { paramId: "Wadat", label: "出货日期", dataType: "DATE", isRange: "X", isMulti: "", value: ScheduleData.resolveToken("@TODAY-7", t) + "," + t }
                        ]
                } : {
                        srcType: "REPORT", reportId: "ZDPSD021", reportName: "成品可用庫存報表（演示）",
                        params: [
                                { paramId: "p_werks", label: "工廠", dataType: "CHAR", isRange: "", isMulti: "", value: "ABZ1" },
                                { paramId: "s_lgort", label: "倉碼", dataType: "CHAR", isRange: "", isMulti: "X", value: "S33F" },
                                { paramId: "p_budat", label: "截止日期", dataType: "DATE", isRange: "", isMulti: "", value: t }
                        ]
                };
        }

        function paramsJson(aParams) {
                var o = {};
                (aParams || []).forEach(function (p) { o[p.paramId] = p.value; });
                return JSON.stringify(o);
        }

        return {

                _mockSchedState: function () {
                        if (!this._oSchedMock) {
                                var o = null;
                                try { o = JSON.parse(window.localStorage.getItem(KEY) || "null"); } catch (e) { o = null; }
                                this._oSchedMock = o && o.items ? o : { items: [], runs: {} };
                        }
                        return this._oSchedMock;
                },

                _mockSchedSave: function () {
                        try { window.localStorage.setItem(KEY, JSON.stringify(this._oSchedMock)); } catch (e) { /* 忽略 */ }
                },

                /** 列表行（补下次运行 / 未读 / 触发文字） */
                _mockSchedView: function (o) {
                        var v = JSON.parse(JSON.stringify(o));
                        v.unread = v.lastRunAt && v.lastRunAt > (v.lastSeenAt || "") ? "X" : "";
                        v.nextRun = "";
                        (v.triggers || []).forEach(function (t, i) {
                                t.trigNo = i + 1;
                                t.text = ScheduleData.trigText(t);
                                t.nextRun = v.status === "ACTIVE" ? ScheduleData.nextRun(t) : "";
                                if (t.nextRun && (!v.nextRun || t.nextRun < v.nextRun)) { v.nextRun = t.nextRun; }
                        });
                        return v;
                },

                _mockSchedCall: function (sAction, o) {
                        var that = this;
                        var st = this._mockSchedState();
                        var sUser = ((this.getAppUser && this.getAppUser()) || {}).userId || "DEMO";
                        var fnFind = function (sId) {
                                return st.items.filter(function (x) { return x.schedId === sId; })[0];
                        };
                        return new Promise(function (resolve, reject) {
                                window.setTimeout(function () {
                                        try {
                                                resolve(that._mockSchedDo(sAction, o, st, sUser, fnFind));
                                        } catch (e) {
                                                reject(e);
                                        }
                                }, 250);
                        });
                },

                _mockSchedDo: function (sAction, o, st, sUser, fnFind) {
                        var that = this;
                        if (sAction === "ScheduleList") {
                                var bAll = String(o.Scope || "").toUpperCase() === "ALL";
                                return {
                                        isAdmin: "X",
                                        items: st.items.filter(function (x) { return bAll || x.owner === sUser; }).map(function (x) { return that._mockSchedView(x); })
                                };
                        }
                        if (sAction === "ScheduleRuns") {
                                return { runs: (st.runs[o.ScheduleId] || []).slice() };
                        }
                        if (sAction === "ScheduleSave") {
                                var s = JSON.parse(o.ScheduleJson || "{}");
                                var sName = String(s.name || "").trim();
                                var sInstr = String(s.instruction || "").trim();
                                if (!sName) { throw new Error("请填写名称"); }
                                if (sInstr.length > 4000) { throw new Error("指令最多 4000 字"); }
                                var aTrig = s.triggers || [];
                                if (!aTrig.length) { throw new Error("至少要有一个触发时间"); }
                                if (aTrig.length > 3) { throw new Error("触发最多 3 个"); }
                                aTrig.forEach(function (t, i) {
                                        var sErr = ScheduleData.checkTrigger(t, i, 1);
                                        if (sErr) { throw new Error(sErr); }
                                        t.time = String(t.time).replace(":", "");
                                });
                                var oItem = s.schedId ? fnFind(s.schedId) : null;
                                var oSrc = null;
                                if (s.schedId) {
                                        if (!oItem || oItem.owner !== sUser) { throw new Error("定时任务不存在或不属于你"); }
                                        if (oItem.status === "ADMIN_STOP") { throw new Error("这个定时任务已被管理员停用, 不能修改"); }
                                } else {
                                        if (st.items.filter(function (x) { return x.owner === sUser; }).length >= MAX_PER_USER) {
                                                throw new Error("每人最多 " + MAX_PER_USER + " 个定时任务, 先删掉不用的");
                                        }
                                        if (s.fromArtifactId) { oSrc = demoSource(s.fromArtifactId); }
                                }
                                var sSrcType = oItem ? oItem.srcType : (oSrc ? oSrc.srcType : "");
                                if (!sInstr && !sSrcType) { throw new Error("指令和数据来源至少要有一个"); }
                                var sScene = sSrcType || String(s.scene || "AUTO").toUpperCase();
                                if (!sSrcType && ["AUTO", "DATA", "CODE"].indexOf(sScene) < 0) {
                                        throw new Error("没有数据来源时, 场景只能选 自动 / 数据分析 / 代码分析");
                                }
                                var aParams = oItem ? oItem.params : (oSrc ? oSrc.params : []);
                                aParams = JSON.parse(JSON.stringify(aParams || []));
                                var oNew = s.params || {};
                                aParams.forEach(function (p) {
                                        if (oNew[p.paramId] === undefined || oNew[p.paramId] === p.value) { return; }
                                        if (p.dataType !== "DATE") { throw new Error("参数「" + p.label + "」不能在这里修改; 要换参数值请重新执行一次报表, 再在结果卡上设为定时"); }
                                        String(oNew[p.paramId]).split(",").forEach(function (x) {
                                                var r = ScheduleData.resolveToken(x, today());
                                                if (r === null || (!ScheduleData.isToken(x) && x && !/^\d{8}$/.test(x.replace(/-/g, "")))) {
                                                        throw new Error("「" + p.label + "」: 日期或相对日期不对: " + x);
                                                }
                                        });
                                        p.value = String(oNew[p.paramId]).split(",").map(function (x) {
                                                x = x.trim();
                                                return ScheduleData.isToken(x) ? x.toUpperCase() : x.replace(/-/g, "");
                                        }).join(",");
                                });
                                var o2 = oItem || {
                                        schedId: "S" + Date.now().toString(16).toUpperCase(),
                                        owner: sUser, status: "ACTIVE", createdAt: now14(),
                                        srcType: sSrcType, reportId: oSrc ? oSrc.reportId : "", reportName: oSrc ? oSrc.reportName : "",
                                        sessionId: "", lastRunAt: "", lastRunSts: "", lastSeenAt: ""
                                };
                                o2.name = sName;
                                o2.instruction = sInstr;
                                o2.scene = sScene;
                                o2.modelId = String(s.modelId || "").toUpperCase();
                                o2.params = aParams;
                                o2.paramsJson = paramsJson(aParams);
                                o2.triggers = aTrig;
                                o2.changedAt = now14();
                                if (!oItem) { st.items.push(o2); }
                                this._mockSchedSave();
                                return { item: this._mockSchedView(o2), message: oItem ? "定时任务已保存" : "定时任务已创建" };
                        }
                        if (sAction === "ScheduleAction") {
                                var sAct = String(o.Action || "").toUpperCase();
                                if (sAct === "PREFILL") {
                                        var oS = demoSource(o.Note);
                                        return {
                                                item: {
                                                        srcType: oS.srcType, reportId: oS.reportId, reportName: oS.reportName, scene: oS.srcType,
                                                        params: oS.params, paramsJson: paramsJson(oS.params), fromArtifact: o.Note || "",
                                                        name: oS.reportName.replace(/（演示）$/, "") + " · 每天 09:00"
                                                }
                                        };
                                }
                                var it = fnFind(o.ScheduleId);
                                if (!it) { throw new Error("定时任务不存在"); }
                                var sMsg = "";
                                switch (sAct) {
                                case "PAUSE": it.status = "PAUSED"; sMsg = "已暂停"; break;
                                case "RESUME":
                                        if (it.status === "ADMIN_STOP") { throw new Error("这个定时任务已被管理员停用, 请联系管理员恢复"); }
                                        it.status = "ACTIVE"; it.stopNote = ""; sMsg = "已恢复"; break;
                                case "DELETE":
                                        st.items.splice(st.items.indexOf(it), 1);
                                        delete st.runs[it.schedId];
                                        this._mockSchedSave();
                                        return { message: "已删除(专属会话和已有结果保留)" };
                                case "RUNNOW":
                                        if (it.status === "ADMIN_STOP") { throw new Error("这个定时任务已被管理员停用"); }
                                        var oP = {};
                                        (it.params || []).forEach(function (p) { oP[p.paramId] = p.value; });
                                        var aRuns = st.runs[it.schedId] = st.runs[it.schedId] || [];
                                        aRuns.unshift({
                                                startedAt: now14(), trigNo: 0, status: "OK",
                                                paramsUsed: JSON.stringify(ScheduleData.resolveParams(oP, today())),
                                                rowCount: it.srcType ? 42 : 0, elapsedMs: 3200,
                                                message: "演示模式：没有真正运行" + (it.srcType ? "报表" : "") + "，只记了一条运行记录"
                                        });
                                        aRuns.length = Math.min(aRuns.length, KEEP_RUNS);
                                        it.lastRunAt = now14();
                                        it.lastRunSts = "OK";
                                        sMsg = "已开始运行, 完成后结果会出现在专属会话里";
                                        break;
                                case "SEEN": it.lastSeenAt = now14(); sMsg = "OK"; break;
                                case "ADMIN_STOP": it.status = "ADMIN_STOP"; it.stopNote = o.Note || ""; sMsg = "已停用(作业到点会直接结束)"; break;
                                case "ADMIN_RESUME": it.status = "ACTIVE"; it.stopNote = ""; sMsg = "已恢复"; break;
                                default: throw new Error("不认识的操作 " + sAct);
                                }
                                it.changedAt = now14();
                                this._mockSchedSave();
                                return { item: this._mockSchedView(it), message: sMsg };
                        }
                        throw new Error("演示模式不支持 " + sAction);
                }
        };
});
