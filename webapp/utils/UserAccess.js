sap.ui.define([], function () {
        "use strict";

        /**
         * 20261101：按用户开放 Agent 场景 + 报表授权（设计：功能计划书/用户权限/01-方案）。
         * 与后端 ZCL_AI_ACCESS 同口径：
         *  · 场景串：REPORT,FIORI,DATA,CODE 的子集；空 = 四个全开；管理员永远全开
         *  · 「自动」所有人可用（20261101 下午改），但只用该用户开放的能力：
         *    没开报表执行就不能在「自动」里执行报表，没开数据分析就不带查数工具（由后端收窄）
         *  · 报表串：REPORT:<编号>,FIORI:<编号>；USERID = "*"（所有人）那一行是公共报表
         *  · 开关 RPT_ACL_ENABLED 不开 = 所有人看全部；开了 = 普通用户只看分配给自己的 + 公共的
         * 不访问网络、不碰 DOM，便于 node 测试。真正的拦截在后端，前端只是按结果显示。
         */

        var SCENES = ["REPORT", "FIORI", "DATA", "CODE"];
        var SRC = ["REPORT", "FIORI"];

        function toList(v) {
                if (Array.isArray(v)) { return v; }
                return String(v || "").replace(/，/g, ",").split(",");
        }

        /** 任意写法 → 规范场景数组（固定顺序、去重、去非法） */
        function normScenes(v) {
                var a = toList(v).map(function (s) { return String(s || "").trim().toUpperCase(); });
                return SCENES.filter(function (k) { return a.indexOf(k) >= 0; });
        }

        /** 任意写法 → 规范报表数组（REPORT:A 形式，大写、去重、去非法；保持原顺序） */
        function normReports(v) {
                var out = [];
                toList(v).forEach(function (s) {
                        var t = String(s || "").replace(/\s+/g, "").toUpperCase();
                        var i = t.indexOf(":");
                        if (i <= 0) { return; }
                        var src = t.substring(0, i), id = t.substring(i + 1);
                        if (SRC.indexOf(src) < 0 || !id || /["\\,]/.test(id)) { return; }
                        var k = src + ":" + id;
                        if (out.indexOf(k) < 0) { out.push(k); }
                });
                return out;
        }

        /** 用户实际开放的场景：管理员 / 空 = 四个全开 */
        function effectiveScenes(sRole, vScenes) {
                var a = normScenes(vScenes);
                return sRole === "ADMIN" || !a.length ? SCENES.slice() : a;
        }

        /** 场景能不能用；AUTO / GENERAL / 空 = 自动，所有人可用；INVENTORY（旧库存场景）按 DATA 判断 */
        function sceneOk(aAllowed, sScene) {
                var k = String(sScene || "").toUpperCase();
                if (!k || k === "AUTO" || k === "GENERAL") { return true; }
                if (k === "INVENTORY") { k = "DATA"; }
                if (aAllowed.length === SCENES.length) { return true; }
                return SCENES.indexOf(k) >= 0 && aAllowed.indexOf(k) >= 0;
        }

        /** 报表能不能用（aGrant = 本人 + 公共的报表串数组） */
        function reportOk(o, sSrc, sId) {
                if (!o || !o.aclOn || o.admin) { return true; }
                var src = String(sSrc || "").toUpperCase(), id = String(sId || "").toUpperCase();
                var a = o.grants || [];
                return a.indexOf(src + ":" + id) >= 0 || a.indexOf(src + ":*") >= 0;
        }

        /** 用户管理表里「可用范围」一栏的简述 */
        function summary(sRole, vScenes, vReports, oText) {
                var t = oText || {};
                var aSc = normScenes(vScenes);
                var aRp = normReports(vReports);
                var sSc = sRole === "PUBLIC" ? "" :
                        (sRole === "ADMIN" ? (t.admin || "管理员 · 全部") :
                                (!aSc.length || aSc.length === SCENES.length ? (t.allScenes || "全部场景") :
                                        (t.scenes || "场景") + " " + aSc.length + "/" + SCENES.length));
                var nR = aRp.filter(function (k) { return k.indexOf("REPORT:") === 0; }).length;
                var nF = aRp.length - nR;
                var sRp = !aRp.length ? (sRole === "ADMIN" ? "" : sRole === "PUBLIC" ? (t.noPublic || "暂无公共报表") : (t.noReports || "未分配报表")) :
                        [nR ? (t.report || "报表执行") + " " + nR : "", nF ? (t.fiori || "Fiori") + " " + nF : ""].filter(Boolean).join(" · ");
                return [sSc, sRp].filter(Boolean).join(" · ");
        }

        return {
                SCENES: SCENES,
                normScenes: normScenes,
                normReports: normReports,
                effectiveScenes: effectiveScenes,
                sceneOk: sceneOk,
                reportOk: reportOk,
                summary: summary
        };
});
