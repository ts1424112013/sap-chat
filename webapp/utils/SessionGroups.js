sap.ui.define([], function () {
	"use strict";

	/**
	 * 20261108 侧栏改版：会话按「已固定 / 今天 / 昨天 / 本周 / 本月 / 更早」分组，每行左边的类型小图标、右边的短时间。
	 * 时间是后端的 14 位 YYYYMMDDhhmmss（ChangedAt）；空 = 刚建的会话，算今天。
	 */
	function parse(s) {
		s = String(s || "");
		if (!/^\d{14}$/.test(s)) {
			return null;
		}
		return new Date(+s.substr(0, 4), +s.substr(4, 2) - 1, +s.substr(6, 2), +s.substr(8, 2), +s.substr(10, 2));
	}
	function dayStart(d) {
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	}
	var DAY = 86400000;
	var WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

	/** 分组键：today / yesterday / week / month / older */
	function bucket(sTime, oNow) {
		var d = parse(sTime);
		if (!d) {
			return "today";
		}
		var t0 = dayStart(oNow);
		var t = dayStart(d);
		if (t >= t0) {
			return "today";
		}
		if (t >= t0 - DAY) {
			return "yesterday";
		}
		// 本周从周一算
		var iDow = (oNow.getDay() + 6) % 7;
		if (t >= t0 - iDow * DAY) {
			return "week";
		}
		if (d.getFullYear() === oNow.getFullYear() && d.getMonth() === oNow.getMonth()) {
			return "month";
		}
		return "older";
	}

	var LABEL = { pinned: "已固定", today: "今天", yesterday: "昨天", week: "本周", month: "本月", older: "更早" };

	return {
		LABEL: LABEL,
		bucket: bucket,

		/**
		 * 在会话列表里插入分组标题行（{ _group: "今天", SessionId: "" }）。
		 * 置顶的放最前「已固定」；其余保持原顺序（后端已按时间倒序），按时间分组。
		 */
		group: function (aList, oNow) {
			oNow = oNow || new Date();
			var aPinned = [];
			var mBy = {};
			var aOrder = ["today", "yesterday", "week", "month", "older"];
			(aList || []).forEach(function (s) {
				if (s._more || s._group) {
					return;
				}
				if (s.Pinned === "X") {
					aPinned.push(s);
					return;
				}
				var k = bucket(s.ChangedAt, oNow);
				(mBy[k] = mBy[k] || []).push(s);
			});
			var aOut = [];
			if (aPinned.length) {
				aOut.push({ SessionId: "", _group: LABEL.pinned, _gkey: "pinned" });
				aOut = aOut.concat(aPinned);
			}
			aOrder.forEach(function (k) {
				if (mBy[k] && mBy[k].length) {
					aOut.push({ SessionId: "", _group: LABEL[k], _gkey: k });
					aOut = aOut.concat(mBy[k]);
				}
			});
			return aOut;
		},

		/** 行右边的短时间：今天 20:31 / 昨天 / 周一 / 11-05 / 2025-12-30 */
		shortTime: function (sTime, oNow) {
			oNow = oNow || new Date();
			var d = parse(sTime);
			if (!d) {
				return "";
			}
			var p = function (n) { return (n < 10 ? "0" : "") + n; };
			var k = bucket(sTime, oNow);
			if (k === "today") {
				return p(d.getHours()) + ":" + p(d.getMinutes());
			}
			if (k === "yesterday") {
				return "昨天";
			}
			if (k === "week") {
				return WEEK[d.getDay()];
			}
			if (d.getFullYear() === oNow.getFullYear()) {
				return p(d.getMonth() + 1) + "-" + p(d.getDate());
			}
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
		},

		/**
		 * 行左边的类型：chat 对话 / sched 定时任务 / report 报表 / fiori / data 数据分析 / code 代码 / file 文件 / task 其他任务。
		 * 新引擎不再分场景（AgentType 多为 AUTO），按标题关键字猜；猜不出就是 task。
		 */
		kind: function (o, bSched) {
			if (!o || o.Mode !== "AGENT") {
				return "chat";
			}
			if (bSched) {
				return "sched";
			}
			var sc = String(o.AgentType || "").toUpperCase();
			if (sc === "REPORT") { return "report"; }
			if (sc === "FIORI") { return "fiori"; }
			if (sc === "CODE") { return "code"; }
			if (sc === "DATA" || sc === "INVENTORY") { return "data"; }
			var t = String(o.Title || "");
			if (/fiori/i.test(t)) { return "fiori"; }
			if (/代码|源码|程序|类\b|ZCL_|方法|调用|语法|增强|BAdI|ABAP|SE38|SE24/i.test(t)) { return "code"; }
			if (/执行|报表|参数卡|跑一下|\bZ[A-Z]{2,}\d{2,}/.test(t)) { return "report"; }
			if (/文件|文件夹|CSV|Excel|xlsx|汇总表|导出/i.test(t)) { return "file"; }
			if (/统计|分析|分布|占比|趋势|数量|多少|库存|排名|查询|查一下/.test(t)) { return "data"; }
			return "task";
		},

		ICON: {
			chat: "sap-icon://discussion", sched: "sap-icon://history", report: "sap-icon://table-view",
			fiori: "sap-icon://overview-chart", data: "sap-icon://bar-chart", code: "sap-icon://source-code",
			file: "sap-icon://folder-blank", task: "sap-icon://ai"
		}
	};
});
