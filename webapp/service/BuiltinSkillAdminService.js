sap.ui.define([
	"zai/chat/service/ChatService"
], function (ChatService) {
	"use strict";

	/**
	 * 20261110（《03》/《04》〇-AV）：内置技能管理（只限管理员）。
	 * 内置技能不再随前端包发布（任何登录用户都能按地址下载全文），而是：
	 *   项目 部署产物/builtin-skills.json（scripts/build-builtin-skills.js 生成）
	 *   → 管理员在「技能管理 → 内置 → 导入内置技能包」选这个文件 → SAP 表 ZAI_BSKILL
	 *   → 每次提问 SAP 按用户开放的场景下发给新引擎。
	 * 真实环境：POST /sap/bc/zai_agent/admin/bskill/<动作>（list / get / import / active），请求头同新引擎；
	 * 演示模式：本浏览器 localStorage 里的模拟数据（导入的文件存在本机）。
	 */
	var MOCK_KEY = "zaiChat.bskillMock";

	function cfgPath() {
		var c = (window.ZAI_CONFIG && window.ZAI_CONFIG.browserAgent) || {};
		return (c.path || "/sap/bc/zai_agent").replace(/\/+$/, "");
	}

	function sapQuery() {
		try {
			var q = new URLSearchParams(window.location.search), out = new URLSearchParams();
			["sap-client", "sap-language"].forEach(function (k) { if (q.get(k)) { out.set(k, q.get(k)); } });
			var s = out.toString();
			return s ? "?" + s : "";
		} catch (e) {
			return "";
		}
	}

	/* ---------------- 演示模式 ---------------- */

	function mockRead() {
		try { return JSON.parse(window.localStorage.getItem(MOCK_KEY)) || []; } catch (e) { return []; }
	}
	function mockWrite(a) {
		try { window.localStorage.setItem(MOCK_KEY, JSON.stringify(a)); } catch (e) { throw new Error("浏览器存储空间不足，演示模式导入失败"); }
	}
	function meta(s) {
		return { dir: s.dir, title: s.title, description: s.description, source: s.source, scenes: s.scenes,
			sortNo: s.sortNo, active: s.active !== false, version: s.version, pkgVersion: s.pkgVersion || "",
			chars: (s.content || "").length, fileCount: (s.files || []).length };
	}
	function mockCall(sAction, o) {
		var a = mockRead();
		switch (sAction) {
			case "list":
				return { ok: true, skills: a.map(meta) };
			case "get":
				var one = a.filter(function (s) { return s.dir === o.dir; })[0];
				if (!one) { throw new Error("没有内置技能 " + o.dir); }
				return { ok: true, skill: Object.assign(meta(one), { content: one.content, files: one.files || [] }) };
			case "import":
				var old = {};
				a.forEach(function (s) { old[s.dir] = s.active !== false; });
				var next = (o.skills || []).map(function (s) {
					return Object.assign({}, s, { active: Object.prototype.hasOwnProperty.call(old, s.dir) ? old[s.dir] : true, pkgVersion: o.version || "" });
				});
				mockWrite(next);
				var added = next.filter(function (s) { return !Object.prototype.hasOwnProperty.call(old, s.dir); }).length;
				return { ok: true, version: o.version || "", added: added, updated: next.length - added,
					removed: a.filter(function (s) { return !next.some(function (n) { return n.dir === s.dir; }); }).length };
			case "active":
				var hit = false;
				a.forEach(function (s) { if (s.dir === o.dir) { s.active = !!o.active; hit = true; } });
				if (!hit) { throw new Error("没有内置技能 " + o.dir); }
				mockWrite(a);
				return { ok: true, dir: o.dir, active: !!o.active };
			default:
				throw new Error("未知动作 " + sAction);
		}
	}

	/** 导入前在浏览器先查一遍包的形状，免得把别的文件传上去（SAP 端还会再全面校验） */
	function checkPkg(p) {
		if (!p || typeof p !== "object" || !Array.isArray(p.skills) || !p.skills.length) {
			throw new Error("这不是内置技能包：请选项目里的 部署产物/builtin-skills.json");
		}
		p.skills.forEach(function (s) {
			if (!s || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.dir || "") || !s.title || !s.content || !s.scenes) {
				throw new Error("内置技能包格式不对（" + ((s && s.dir) || "?") + "）：请重新运行 node scripts/build-builtin-skills.js 生成");
			}
		});
		return p;
	}

	/* ---------------- 对外 ---------------- */

	return {
		isMock: function () {
			return ChatService.getMode() === "mock";
		},

		checkPkg: checkPkg,

		/** @returns {Promise<object>} SAP 回的 JSON（ok:true）；失败 reject Error(message) */
		call: function (sAction, oBody) {
			if (this.isMock()) {
				return new Promise(function (resolve, reject) {
					setTimeout(function () {
						try { resolve(mockCall(sAction, oBody || {})); } catch (e) { reject(e); }
					}, 200);
				});
			}
			var h = { "Content-Type": "application/json", "X-Lingxi-Agent": "1", "X-Requested-With": "XMLHttpRequest" };
			var sAuth = ChatService._basicHeader ? ChatService._basicHeader() : "";
			if (/^Basic\s+\S+$/.test(sAuth || "")) { h.Authorization = sAuth; }
			return fetch(window.location.origin + cfgPath() + "/admin/bskill/" + sAction + sapQuery(), {
				method: "POST", credentials: "same-origin", headers: h, body: JSON.stringify(oBody || {})
			}).then(function (res) {
				return res.text().then(function (t) {
					var d = null;
					try { d = t ? JSON.parse(t) : null; } catch (e) { /* ICF 错误页等 */ }
					if (!res.ok || !d || d.ok === false) {
						var sMsg = (d && d.message) || (res.status === 404 && !d
							? "SAP 上还没有内置技能接口（ZCL_AI_AGENT_HTTP V1.8），请先部署《03》〇-AV"
							: "SAP 返回 " + res.status);
						throw new Error(sMsg);
					}
					return d;
				});
			});
		}
	};
});
