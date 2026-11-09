sap.ui.define([
	"zai/chat/service/ChatService"
], function (ChatService) {
	"use strict";

	/**
	 * 20261109（《04》〇-AU，MCP 连接 M1）：管理员维护 MCP 服务与工具。
	 * 真实环境：POST /sap/bc/zai_agent/admin/mcp/<动作>（只限管理员，SAP 端再查一次），
	 *   动作 list / get / save / delete / test / fetch / tools，请求头同新引擎（X-Lingxi-Agent）。
	 * 演示模式：本浏览器里的模拟数据（localStorage），「测试连接」「拉取工具」返回固定的演示服务。
	 * 连接信息（地址、证书、令牌）在 SAP 的 SM59，这里只填目标名，不存任何密钥。
	 */
	var MOCK_KEY = "zaiChat.mcpMock";

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

	var DEMO_TOOLS = [
		{ name: "get_material", description: "按物料号查物料主数据（描述、基本单位、物料组）",
			inputSchema: { type: "object", properties: { matnr: { type: "string", description: "物料号" } }, required: ["matnr"] },
			annotations: { readOnlyHint: true } },
		{ name: "list_plants", description: "列出公司的工厂（编号、名称、公司代码）",
			inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
		{ name: "post_goods_movement", description: "过账一笔货物移动（会改数据）",
			inputSchema: { type: "object", properties: { bwart: { type: "string" }, matnr: { type: "string" }, menge: { type: "number" } },
				required: ["bwart", "matnr", "menge"] } }
	];

	function mockLoad() {
		try {
			var o = JSON.parse(window.localStorage.getItem(MOCK_KEY) || "null");
			if (o && o.servers) { return o; }
		} catch (e) { /* 读不到就从空开始 */ }
		return { servers: {}, tools: {} };
	}

	function mockSave(o) {
		try { window.localStorage.setItem(MOCK_KEY, JSON.stringify(o)); } catch (e) { /* 存不了就只在本页有效 */ }
	}

	function mockSrvOut(db, s) {
		var t = db.tools[s.srvId] || [];
		return Object.assign({}, s, {
			toolCount: t.length,
			toolsOn: t.filter(function (x) { return x.active; }).length,
			toolsChanged: t.filter(function (x) { return x.changed; }).length
		});
	}

	function llmName(srv, tool) {
		return ("mcp_" + srv + "_" + tool).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
	}

	function mockCall(action, body) {
		var db = mockLoad(), id = String((body && body.srvId) || "").toUpperCase(), s = db.servers[id];
		var ok = function (o) { return Object.assign({ ok: true }, o); };
		switch (action) {
		case "list":
			return ok({ servers: Object.keys(db.servers).sort().map(function (k) { return mockSrvOut(db, db.servers[k]); }) });
		case "get":
			if (!s) { throw new Error("没有服务 " + id); }
			return ok({ server: mockSrvOut(db, s), tools: db.tools[id] || [] });
		case "save":
			if (!/^[A-Z0-9_]{1,16}$/.test(id)) { throw new Error("服务编号只能是 1 ~ 16 位大写字母、数字、下划线"); }
			if (!body.dest) { throw new Error("请填 SM59 目标名(类型 G, 最多 32 位)"); }
			s = Object.assign(s || { testAt: "", testOk: false, testMsg: "", protocol: "", fails: 0 }, {
				srvId: id, name: body.name || id, dest: String(body.dest).toUpperCase(), path: body.path || "/mcp",
				idMode: body.idMode === "USER" ? "USER" : "TECH", scenes: body.scenes || "", users: String(body.users || "").toUpperCase(),
				timeoutSec: body.timeoutSec || 60, maxCalls: body.maxCalls || 20, active: !!body.active
			});
			db.servers[id] = s;
			mockSave(db);
			return ok({ server: mockSrvOut(db, s) });
		case "delete":
			delete db.servers[id];
			delete db.tools[id];
			mockSave(db);
			return ok({});
		case "test":
			if (!s) { throw new Error("没有服务 " + id); }
			s.testAt = new Date().toISOString();
			s.testOk = true;
			s.testMsg = "demo-mcp 1.0.0（演示）";
			s.protocol = "2025-03-26";
			mockSave(db);
			return ok({ name: "demo-mcp", version: "1.0.0", protocol: "2025-03-26", message: "", server: mockSrvOut(db, s) });
		case "fetch":
			if (!s) { throw new Error("没有服务 " + id); }
			var have = db.tools[id] || [], added = 0;
			DEMO_TOOLS.forEach(function (t) {
				var cur = have.filter(function (x) { return x.toolName === t.name; })[0];
				if (!cur) {
					added++;
					have.push({ toolName: t.name, llmName: llmName(id, t.name), active: false,
						category: t.annotations && t.annotations.readOnlyHint ? "READ" : "WRITE",
						hint: t.annotations && t.annotations.readOnlyHint ? "READ" : "WRITE",
						descrSrc: t.description, descr: "", schema: JSON.stringify(t.inputSchema), scenes: "", users: "",
						changed: false, gone: false, reviewedBy: "" });
				}
			});
			db.tools[id] = have;
			mockSave(db);
			return ok({ count: DEMO_TOOLS.length, added: added, changed: 0, tools: have });
		case "tools":
			if (!s) { throw new Error("没有服务 " + id); }
			var list = db.tools[id] || [];
			(body.tools || []).forEach(function (t) {
				var cur = list.filter(function (x) { return x.toolName === t.toolName; })[0];
				if (!cur) { return; }
				if (t.active && t.category === "WRITE") {
					throw new Error("工具 " + t.toolName + " 是「会改数据」: 第一期只能开放只读工具(确认流程在第二期)");
				}
				if (t.active && (!cur.active || cur.changed)) { cur.changed = false; cur.reviewedBy = "DEMO"; }
				Object.assign(cur, { active: !!t.active, category: t.category, descr: t.descr || "", scenes: t.scenes || "", users: t.users || "" });
			});
			mockSave(db);
			return ok({ tools: list });
		default:
			throw new Error("未知动作 " + action);
		}
	}

	/* ---------------- 对外 ---------------- */

	return {
		isMock: function () {
			return ChatService.getMode() === "mock";
		},

		/** @returns {Promise<object>} SAP 回的 JSON（ok:true）；失败 reject Error(message) */
		call: function (sAction, oBody) {
			if (this.isMock()) {
				return new Promise(function (resolve, reject) {
					setTimeout(function () {
						try { resolve(mockCall(sAction, oBody || {})); } catch (e) { reject(e); }
					}, 250);
				});
			}
			var h = { "Content-Type": "application/json", "X-Lingxi-Agent": "1", "X-Requested-With": "XMLHttpRequest" };
			var sAuth = ChatService._basicHeader ? ChatService._basicHeader() : "";
			if (/^Basic\s+\S+$/.test(sAuth || "")) { h.Authorization = sAuth; }
			return fetch(window.location.origin + cfgPath() + "/admin/mcp/" + sAction + sapQuery(), {
				method: "POST", credentials: "same-origin", headers: h, body: JSON.stringify(oBody || {})
			}).then(function (res) {
				return res.text().then(function (t) {
					var d = null;
					try { d = t ? JSON.parse(t) : null; } catch (e) { /* ICF 错误页等 */ }
					if (!res.ok || !d || d.ok === false) {
						var sMsg = (d && d.message) || (res.status === 404 && !d
							? "SAP 上还没有 MCP 管理接口（ZCL_AI_AGENT_HTTP V1.7），请先部署《03》〇-AU"
							: "SAP 返回 " + res.status);
						throw new Error(sMsg);
					}
					return d;
				});
			});
		}
	};
});
