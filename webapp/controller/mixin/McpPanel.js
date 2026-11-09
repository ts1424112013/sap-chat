sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageBox",
	"zai/chat/utils/Toast",
	"zai/chat/service/ChatService",
	"zai/chat/service/McpAdminService"
], function (JSONModel, MessageBox, MessageToast, ChatService, Mcp) {
	"use strict";

	/* ==========================================================================
	 * 20261109（《04》〇-AU，MCP 连接 M1）：设置 → MCP 连接（仅管理员）
	 * 左边服务列表，右边服务设置 + 工具勾选表；数据经 McpAdminService（SAP /admin/mcp/*，演示模式本地）。
	 * 规则以 SAP 为准（只读才能开放、变了的工具自动停用待复核、技术账号默认只给管理员），界面只做提示。
	 * ========================================================================== */
	var SCENES = ["REPORT", "DATA", "CODE", "FIORI"];

	function blankServer() {
		return { srvId: "", name: "", dest: "", path: "/mcp", idMode: "USER", scenes: "", users: "",
			timeoutSec: 60, maxCalls: 20, active: false, testAt: "", testOk: false, testMsg: "", protocol: "" };
	}

	return {

		onOpenMcpManager: function () {
			if (!this._mcpDialog) {
				this._mcpDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.McpAdmin", this);
				this.getView().addDependent(this._mcpDialog);
			}
			this.getView().setModel(new JSONModel({
				servers: [], sel: "", edit: null, isNew: false, sceneOn: {}, tools: [], testText: "",
				busy: false, error: "", info: "", mock: Mcp.isMock()
			}), "mcpAdmin");
			this._mcpDialog.open();
			this.onMcpRefresh();
		},

		onCloseMcpManager: function () {
			if (this._mcpDialog) { this._mcpDialog.close(); }
		},

		_mcpModel: function () {
			return this.getView().getModel("mcpAdmin");
		},

		/** 统一包一层：转圈、清提示、出错写进红条 */
		_mcpRun: function (p, sInfo) {
			var m = this._mcpModel();
			m.setProperty("/busy", true);
			m.setProperty("/error", "");
			m.setProperty("/info", "");
			return p.then(function (r) {
				if (sInfo) { m.setProperty("/info", typeof sInfo === "function" ? sInfo(r) : sInfo); }
				return r;
			}, function (e) {
				m.setProperty("/error", (e && e.message) || String(e));
				throw e;
			}).then(function (r) {
				m.setProperty("/busy", false);
				return r;
			}, function (e) {
				m.setProperty("/busy", false);
				throw e;
			});
		},

		onMcpRefresh: function () {
			var that = this, m = this._mcpModel();
			return this._mcpRun(Mcp.call("list")).then(function (r) {
				m.setProperty("/servers", (r.servers || []).map(that._mcpRow));
				var sSel = m.getProperty("/sel");
				var aIds = (r.servers || []).map(function (s) { return s.srvId; });
				if (sSel && aIds.indexOf(sSel) >= 0) {
					return that._mcpLoad(sSel);
				}
				if (aIds.length) {
					return that._mcpLoad(aIds[0]);
				}
				that.onMcpNew();
			}).catch(function () { /* 红条已写 */ });
		},

		/** 列表一行：名称 + 编号 / SM59 / 工具数；连续失败或有待复核的标黄 */
		_mcpRow: function (s) {
			var aWarn = [];
			if (s.toolsChanged) { aWarn.push(s.toolsChanged + " 个工具待复核"); }
			if (s.fails >= 3) { aWarn.push("连续失败 " + s.fails + " 次"); }
			if (s.testAt && !s.testOk) { aWarn.push("最近测试没通过"); }
			return Object.assign({}, s, {
				meta: s.srvId + " · " + s.dest + " · " + (s.idMode === "TECH" ? "技术账号" : "用户本人") +
					" · 开放 " + (s.toolsOn || 0) + "/" + (s.toolCount || 0),
				warn: aWarn.join("；")
			});
		},

		_mcpLoad: function (sId) {
			var that = this, m = this._mcpModel();
			return this._mcpRun(Mcp.call("get", { srvId: sId })).then(function (r) {
				that._mcpSetEdit(r.server, false);
				that._mcpSetTools(r.tools);
			});
		},

		_mcpSetEdit: function (oSrv, bNew) {
			var m = this._mcpModel(), o = Object.assign(blankServer(), oSrv || {}), mOn = {};
			String(o.scenes || "").split(",").forEach(function (x) { if (x) { mOn[x] = true; } });
			m.setProperty("/edit", o);
			m.setProperty("/isNew", !!bNew);
			m.setProperty("/sel", bNew ? "" : o.srvId);
			m.setProperty("/sceneOn", mOn);
			m.setProperty("/testText", o.testAt
				? (o.testOk ? "最近测试通过：" : "最近测试失败：") + (o.testMsg || "") +
					(o.protocol ? "（协议 " + o.protocol + "）" : "") + " · " + String(o.testAt).replace("T", " ").replace(/\..*$|Z$/, "")
				: (bNew ? "" : "还没测试过连接"));
		},

		_mcpSetTools: function (aTools) {
			this._mcpModel().setProperty("/tools", (aTools || []).map(function (t) {
				var aF = [];
				if (t.changed) { aF.push("待复核：服务改了说明或参数，已自动停用"); }
				if (t.gone) { aF.push("已下线：服务里没有这个工具了"); }
				if (!t.changed && !t.gone && t.hint && t.hint !== t.category) {
					aF.push("服务自报：" + (t.hint === "READ" ? "只读" : "会改数据"));
				}
				return Object.assign({}, t, { flag: aF.join("；") });
			}));
		},

		onMcpPick: function (oEvent) {
			var o = oEvent.getSource().getBindingContext("mcpAdmin").getObject();
			this._mcpLoad(o.srvId).catch(function () { /* 红条已写 */ });
		},

		onMcpNew: function () {
			this._mcpSetEdit(blankServer(), true);
			this._mcpSetTools([]);
		},

		onMcpSceneToggle: function (oEvent) {
			var m = this._mcpModel(), sSc = oEvent.getSource().data("scene");
			m.setProperty("/sceneOn/" + sSc, !m.getProperty("/sceneOn/" + sSc));
		},

		onMcpCategory: function (oEvent) {
			// 改成「会改数据」时顺手取消开放（第一期不能开放）
			var o = oEvent.getSource().getBindingContext("mcpAdmin");
			if (o.getProperty("category") === "WRITE") {
				this._mcpModel().setProperty(o.getPath() + "/active", false);
			}
		},

		onMcpSave: function () {
			var that = this, m = this._mcpModel(), e = m.getProperty("/edit"), mOn = m.getProperty("/sceneOn") || {};
			var oBody = {
				srvId: String(e.srvId || "").trim().toUpperCase(), name: e.name, dest: String(e.dest || "").trim().toUpperCase(),
				path: e.path, idMode: e.idMode, users: e.users, timeoutSec: Number(e.timeoutSec) || 60,
				maxCalls: Number(e.maxCalls) || 20, active: !!e.active,
				scenes: SCENES.filter(function (k) { return mOn[k]; }).join(",")
			};
			this._mcpRun(Mcp.call("save", oBody), "已保存。下一步：「测试连接」确认 SAP 能连到这个服务").then(function (r) {
				m.setProperty("/sel", r.server.srvId);
				return Mcp.call("list").then(function (rl) {
					m.setProperty("/servers", (rl.servers || []).map(that._mcpRow));
					that._mcpSetEdit(r.server, false);
				});
			}).catch(function () { /* 红条已写 */ });
		},

		onMcpTest: function () {
			var that = this, m = this._mcpModel(), sId = m.getProperty("/edit/srvId");
			this._mcpRun(Mcp.call("test", { srvId: sId }), function (r) {
				return "连接成功：" + (r.name || "MCP 服务") + " " + (r.version || "") + "，协议 " + (r.protocol || "-");
			}).catch(function () { /* 红条已写 */ }).then(function () {
				return that._mcpReloadKeep(sId);
			});
		},

		onMcpFetch: function () {
			var that = this, sId = this._mcpModel().getProperty("/edit/srvId");
			this._mcpRun(Mcp.call("fetch", { srvId: sId }), function (r) {
				return "拉到 " + r.count + " 个工具：新增 " + (r.added || 0) + " 个（默认关闭）" +
					(r.changed ? "，" + r.changed + " 个说明或参数变了，已停用待复核" : "") + "。勾选要开放的只读工具后点「保存工具设置」";
			}).then(function (r) {
				that._mcpSetTools(r.tools);
				return that._mcpReloadKeep(sId);
			}).catch(function () { /* 红条已写 */ });
		},

		/** 只刷新左边列表（计数 / 测试结果），右边保留正在编辑的内容与提示 */
		_mcpReloadKeep: function (sId) {
			var that = this, m = this._mcpModel();
			return Mcp.call("list").then(function (r) {
				var a = (r.servers || []).map(that._mcpRow);
				m.setProperty("/servers", a);
				var o = a.filter(function (s) { return s.srvId === sId; })[0];
				if (o) {
					var e = m.getProperty("/edit");
					that._mcpSetEdit(Object.assign({}, e, { testAt: o.testAt, testOk: o.testOk, testMsg: o.testMsg, protocol: o.protocol }), false);
				}
			}).catch(function () { /* 列表刷不出来不影响 */ });
		},

		onMcpSaveTools: function () {
			var that = this, m = this._mcpModel(), sId = m.getProperty("/edit/srvId");
			var aT = (m.getProperty("/tools") || []).map(function (t) {
				return { toolName: t.toolName, active: !!t.active, category: t.category, descr: t.descr || "", scenes: t.scenes || "", users: t.users || "" };
			});
			var nOn = aT.filter(function (t) { return t.active; }).length;
			this._mcpRun(Mcp.call("tools", { srvId: sId, tools: aT }),
				"工具设置已保存：开放 " + nOn + " 个。用户下次在任务里提问时就能用（工具名以 mcp_ 开头）").then(function (r) {
				that._mcpSetTools(r.tools);
				return that._mcpReloadKeep(sId);
			}).catch(function () {
				// 红条已写；工具表换回已保存的状态（不让界面停在被拒的勾选上）
				Mcp.call("get", { srvId: sId }).then(function (r) { that._mcpSetTools(r.tools); }).catch(function () { /* 无妨 */ });
			});
		},

		onMcpDelete: function () {
			var that = this, m = this._mcpModel(), e = m.getProperty("/edit");
			MessageBox.confirm("删除服务「" + (e.name || e.srvId) + "」和它的 " + (m.getProperty("/tools") || []).length +
				" 个工具设置？用户之后就用不到这些工具了。SM59 目标不受影响。", {
				title: "删除 MCP 服务",
				actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
				emphasizedAction: MessageBox.Action.DELETE,
				onClose: function (sAct) {
					if (sAct !== MessageBox.Action.DELETE) { return; }
					that._mcpRun(Mcp.call("delete", { srvId: e.srvId })).then(function () {
						MessageToast.show("已删除 " + e.srvId);
						m.setProperty("/sel", "");
						return that.onMcpRefresh();
					}).catch(function () { /* 红条已写 */ });
				}
			});
		}
	};
});
