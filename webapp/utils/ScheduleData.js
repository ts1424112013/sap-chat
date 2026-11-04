sap.ui.define([], function () {
        "use strict";

        /**
         * =====================================================================
         * 定时任务的纯逻辑（设计：功能计划书/定时任务/01-方案与开发计划 V1.1）
         * =====================================================================
         * 与 ZCL_AI_SCHEDULE_SERVICE 同口径：相对日期记号换算、触发文字、某天该不该跑、下次运行时间。
         * 设置框（SchedulePanel）和演示后端（ScheduleMockBackend）共用；不依赖 UI5 控件，test-server 可直接测。
         * 日期一律 YYYYMMDD 字符串，时间 HHMM；星期 0 = 周一 … 6 = 周日。
         * =====================================================================
         */

        var FREQS = [
                { key: "DAILY", text: "每天" },
                { key: "WEEKLY", text: "每周" },
                { key: "MONTHLY", text: "每月" },
                { key: "HOURLY", text: "每 N 小时" }
        ];
        var WEEK_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

        /** 相对日期选项（界面下拉）；N_DAYS 需要再填天数 */
        var DATE_MODES = [
                { key: "", text: "固定日期" },
                { key: "@TODAY", text: "今天" },
                { key: "@TODAY-1", text: "昨天" },
                { key: "N_DAYS", text: "N 天前" },
                { key: "@WEEK_START", text: "本周一" },
                { key: "@MONTH_START", text: "本月第一天" },
                { key: "@MONTH_END", text: "本月最后一天" },
                { key: "@LMONTH_START", text: "上月第一天" },
                { key: "@LMONTH_END", text: "上月最后一天" },
                { key: "@YEAR_START", text: "今年第一天" }
        ];

        function pad(n, w) {
                var s = String(n);
                while (s.length < (w || 2)) { s = "0" + s; }
                return s;
        }

        function toDate(s) {
                var m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ""));
                return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
        }

        function fromDate(d) {
                return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
        }

        function addDays(s, n) {
                var d = toDate(s);
                d.setDate(d.getDate() + n);
                return fromDate(d);
        }

        /** 0 = 周一 … 6 = 周日 */
        function weekday(s) {
                return (toDate(s).getDay() + 6) % 7;
        }

        function lastDay(s) {
                var d = toDate(s);
                return fromDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
        }

        function isToken(v) {
                return /^@/.test(String(v || "").trim());
        }

        /**
         * 记号 → YYYYMMDD；不是记号原样返回；不认识的记号返回 null
         * @param {string} v 值
         * @param {string} sToday 运行当天 YYYYMMDD
         */
        function resolveToken(v, sToday) {
                var t = String(v || "").trim().toUpperCase();
                if (!/^@/.test(t)) {
                        return String(v || "");
                }
                var d = sToday;
                switch (t) {
                case "@TODAY": return d;
                case "@WEEK_START": return addDays(d, -weekday(d));
                case "@MONTH_START": return d.substring(0, 6) + "01";
                case "@MONTH_END": return lastDay(d);
                case "@LMONTH_START": return addDays(d.substring(0, 6) + "01", -1).substring(0, 6) + "01";
                case "@LMONTH_END": return addDays(d.substring(0, 6) + "01", -1);
                case "@YEAR_START": return d.substring(0, 4) + "0101";
                default:
                        var m = /^@TODAY-(\d{1,3})$/.exec(t);
                        if (m && +m[1] >= 1 && +m[1] <= 366) {
                                return addDays(d, -(+m[1]));
                        }
                        return null;
                }
        }

        /** 参数对象里的记号逐项换算（逗号分隔的范围 / 多值逐项） */
        function resolveParams(oParams, sToday) {
                var o = {};
                Object.keys(oParams || {}).forEach(function (k) {
                        var v = String(oParams[k] === undefined || oParams[k] === null ? "" : oParams[k]);
                        o[k] = v.indexOf("@") < 0 ? v : v.split(",").map(function (x) {
                                var r = resolveToken(x, sToday);
                                return r === null ? x : r;
                        }).join(",");
                });
                return o;
        }

        /** 一个日期值 → 界面状态 {mode, n, fixed}（mode 是 DATE_MODES 的 key） */
        function dateMode(v) {
                var t = String(v || "").trim().toUpperCase();
                if (!t) { return { mode: "", n: 2, fixed: "" }; }
                if (!/^@/.test(t)) { return { mode: "", n: 2, fixed: String(v).replace(/-/g, "") }; }
                var m = /^@TODAY-(\d{1,3})$/.exec(t);
                if (m && m[1] !== "1") { return { mode: "N_DAYS", n: +m[1], fixed: "" }; }
                return { mode: t, n: 2, fixed: "" };
        }

        /** 界面状态 → 值 */
        function modeValue(sMode, n, sFixed) {
                if (!sMode) { return String(sFixed || ""); }
                if (sMode === "N_DAYS") {
                        var k = Math.max(1, Math.min(366, parseInt(n, 10) || 1));
                        return "@TODAY-" + k;
                }
                return sMode;
        }

        /** 记号的中文说明（运行记录 / 列表里显示） */
        function tokenText(v) {
                var st = dateMode(v);
                if (!st.mode) { return fmtDate(st.fixed); }
                if (st.mode === "N_DAYS") { return st.n + " 天前"; }
                var o = DATE_MODES.filter(function (x) { return x.key === st.mode; })[0];
                return o ? o.text : String(v);
        }

        function fmtDate(s) {
                var m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ""));
                return m ? m[1] + "-" + m[2] + "-" + m[3] : String(s || "");
        }

        /** 这一天该不该跑 */
        function dueOn(t, sDate) {
                switch (t.freq) {
                case "DAILY":
                case "HOURLY":
                        return true;
                case "WEEKLY":
                        return String(t.weekdays || "").charAt(weekday(sDate)) === "X";
                case "MONTHLY":
                        var sLast = lastDay(sDate);
                        var nDay = +sDate.substring(6, 8);
                        var nMd = +t.monthDay;
                        if (nMd === 99 || nMd > +sLast.substring(6, 8)) {
                                return sDate === sLast;
                        }
                        return nDay === nMd;
                default:
                        return false;
                }
        }

        /**
         * 下次运行时间（YYYYMMDDHHMMSS）
         * @param {object} t 触发 {freq, time (HHMM), weekdays, monthDay, everyHours}
         * @param {Date} [dNow] 现在
         */
        function nextRun(t, dNow) {
                var now = dNow || new Date();
                var hm = String(t.time || "").replace(":", "");
                if (!/^\d{4}$/.test(hm)) { return ""; }
                var h = +hm.substring(0, 2), mi = +hm.substring(2, 4);
                if (t.freq === "HOURLY") {
                        var step = Math.max(1, +t.everyHours || 1) * 3600000;
                        var c = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0).getTime();
                        while (c > now.getTime()) { c -= step; }
                        while (c <= now.getTime()) { c += step; }
                        var dc = new Date(c);
                        return fromDate(dc) + pad(dc.getHours()) + pad(dc.getMinutes()) + "00";
                }
                for (var k = 0; k < 62; k++) {
                        var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, h, mi, 0);
                        if (k === 0 && d.getTime() <= now.getTime()) { continue; }
                        var s = fromDate(d);
                        if (dueOn(t, s)) { return s + pad(h) + pad(mi) + "00"; }
                }
                return "";
        }

        /** 触发的中文：每天 09:00 / 工作日 09:00 / 每周一、三 09:00 / 每月 1 号 / 每月最后一天 / 每 2 小时(从 09:00 起) */
        function trigText(t) {
                var hm = String(t.time || "").replace(":", "");
                var s = /^\d{4}$/.test(hm) ? hm.substring(0, 2) + ":" + hm.substring(2) : "";
                switch (t.freq) {
                case "DAILY": return "每天 " + s;
                case "WEEKLY":
                        var w = String(t.weekdays || "");
                        if (w.replace(/\s+$/, "") === "XXXXX") { return "工作日 " + s; }
                        var a = [];
                        for (var i = 0; i < 7; i++) { if (w.charAt(i) === "X") { a.push(WEEK_NAMES[i]); } }
                        return "每周" + a.join("、") + " " + s;
                case "MONTHLY": return (+t.monthDay === 99 ? "每月最后一天 " : "每月 " + (+t.monthDay) + " 号 ") + s;
                case "HOURLY": return "每 " + (+t.everyHours || 1) + " 小时(从 " + s + " 起)";
                default: return "";
                }
        }

        /** YYYYMMDDHHMMSS → "11-05 09:00"；同年省略年份 */
        function fmtTs(s) {
                var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(s || ""));
                return m ? m[2] + "-" + m[3] + " " + m[4] + ":" + m[5] : "";
        }

        /** 触发校验（与后端 parse_triggers 同口径）→ 错误文字或 "" */
        function checkTrigger(t, i, nMinHours) {
                var n = i + 1;
                if (!/^([01]\d|2[0-3]):?[0-5]\d$/.test(String(t.time || ""))) { return "第 " + n + " 个触发的时间不对，请写成 09:00 这样"; }
                if (t.freq === "WEEKLY" && String(t.weekdays || "").indexOf("X") < 0) { return "第 " + n + " 个触发（每周）至少勾一天"; }
                if (t.freq === "MONTHLY" && !((+t.monthDay >= 1 && +t.monthDay <= 31) || +t.monthDay === 99)) { return "第 " + n + " 个触发（每月）要选几号"; }
                if (t.freq === "HOURLY" && !(+t.everyHours >= (nMinHours || 1) && +t.everyHours <= 24)) { return "每 N 小时的 N 只能是 " + (nMinHours || 1) + "-24"; }
                return "";
        }

        return {
                FREQS: FREQS, WEEK_NAMES: WEEK_NAMES, DATE_MODES: DATE_MODES,
                resolveToken: resolveToken, resolveParams: resolveParams, isToken: isToken,
                dateMode: dateMode, modeValue: modeValue, tokenText: tokenText, fmtDate: fmtDate,
                weekday: weekday, lastDay: lastDay, dueOn: dueOn, nextRun: nextRun, trigText: trigText,
                fmtTs: fmtTs, checkTrigger: checkTrigger, fromDate: fromDate
        };
});
