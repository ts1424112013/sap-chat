sap.ui.define([
	"zai/chat/utils/Toast",
	"sap/m/Dialog",
	"sap/m/Button",
	"sap/m/ActionSheet",
	"sap/ui/core/HTML",
	"zai/chat/service/ChatService",
	"zai/chat/service/BrowserAgentService",
	"zai/chat/utils/Formatter"
], function (MessageToast, Dialog, Button, ActionSheet, HTML, ChatService, BrowserAgentService, Formatter) {
	"use strict";

	/**
	 * =====================================================================
	 * App 控制器拆分块：浏览器 Agent 引擎（Deep Agents 浏览器版）
	 * 设计：功能计划书/Deep Agents浏览器接入/02-方案与开发计划_V2.0
	 * =====================================================================
	 *  · 输入框下「新引擎」开关（Agent 工作区、浏览器满足条件时出现；按账号记在本机）
	 *  · 「选择文件夹」胶囊：选 / 刷新后恢复授权 / 撤回上一次修改 / 换文件夹 / 不再使用
	 *  · _baSend：替代 ChatService.sendByMode，返回同形结果；引擎步骤直接画进「边跑边看」（_applyLive）
	 *  · _baConfirm：改文件前的确认对话框（改前 / 改后逐行对比），用户点「应用」才写
	 * 原 ABAP Agent 不受影响：开关关闭时一切照旧。方法名统一 _ba 前缀。
	 * =====================================================================
	 */

	var PREF_KEY = "lingxi-ba-on:";
	var MAX_HISTORY = 12;

	function esc(s) {
		return Formatter.escapeHtml(s == null ? "" : String(s));
	}

	/** 逐行对比（LCS）；太长时只给首尾 */
	function lineDiff(sA, sB) {
		var a = String(sA || "").split("\n"), b = String(sB || "").split("\n");
		if (a.length * b.length > 250000) {
			return null;
		}
		var n = a.length, m = b.length, i, j;
		var dp = new Array(n + 1);
		for (i = 0; i <= n; i++) {
			dp[i] = new Uint16Array(m + 1);
		}
		for (i = n - 1; i >= 0; i--) {
			for (j = m - 1; j >= 0; j--) {
				dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		var out = [];
		i = 0; j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && a[i] === b[j]) { out.push([" ", a[i]]); i++; j++; }
			else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { out.push(["-", a[i]]); i++; }   // 先删后增
			else { out.push(["+", b[j]]); j++; }
		}
		return out;
	}

	return {

		// ------------------------------------------------------------------
		// 初始化 / 开关
		// ------------------------------------------------------------------

		/** 登录后调用：可用性、个人开关、上次的文件夹 */
		_baInit: function () {
			var oChat = this.getView().getModel("chat");
			var oUser = ChatService.getAppUser() || {};
			var sUser = oUser.userId || "";
			var bMock = ChatService.getMode() === "mock";
			BrowserAgentService.useMock = bMock;
			var bAvail = BrowserAgentService.available();
			// 用户在设置里开 / 关过（X / N）按用户的；没动过按 config.js 的 browserAgent.defaultOn
			var oCfgBa = (window.ZAI_CONFIG && window.ZAI_CONFIG.browserAgent) || {};
			var bOnly = oCfgBa.only !== false;   // 20261108：默认 Agent 只用新引擎，不给开关
			var bOn = bOnly || oCfgBa.defaultOn === true;
			try {
				var sPref = window.localStorage.getItem(PREF_KEY + sUser);
				if (!bOnly && (sPref === "X" || sPref === "N")) { bOn = sPref === "X"; }
			} catch (e) { /* 无本地存储 */ }
			oChat.setProperty("/ba", {
				available: bAvail,
				only: bOnly,
				on: bAvail && bOn,
				mock: bMock,
				folderSupported: BrowserAgentService.folderSupported(),
				folderName: "",
				folderState: "none",    // none | granted | prompt
				changes: 0
			});
			this._sBaUser = sUser;
			if (bAvail && bOn) {
				this._baWarm();
			}
			if (this._rtInfo) {
				this._rtInfo(null);
			}
		},

		/** 预加载引擎并取回上次的文件夹（选文件夹必须在点击里同步调用，引擎得先就绪） */
		_baWarm: function () {
			var that = this;
			return BrowserAgentService.load().then(function () {
				return BrowserAgentService.restoreFolder(that._sBaUser);
			}).then(function (oInfo) {
				that._baSyncFolder(oInfo);
			}).catch(function (e) {
				MessageToast.show((e && e.message) || "浏览器引擎加载失败");
			});
		},

		_baSyncFolder: function (oInfo) {
			var oChat = this.getView().getModel("chat");
			oChat.setProperty("/ba/folderName", oInfo ? oInfo.name : "");
			oChat.setProperty("/ba/folderState", oInfo ? (oInfo.permission === "granted" ? "granted" : "prompt") : "none");
			oChat.setProperty("/ba/changes", oInfo ? oInfo.changes : 0);
			if (this._rtInfo) {
				var mRt = this._mRt || {}, sCur = this._sMessagesSession;
				var oLast = Object.keys(mRt).map(function (k) { return mRt[k]; }).filter(function (x) { return x.sid === sCur && x.limits; }).pop();
				this._rtInfo(oLast || null);
			}
			var sState = oInfo ? (oInfo.permission === "granted" ? "granted" : "prompt") : "none";
			["baFolderHero", "baFolderDock"].forEach(function (sId) {
				var oBtn = this.byId(sId);
				if (oBtn) {
					oBtn.toggleStyleClass("baFolderOn", sState === "granted");
					oBtn.toggleStyleClass("baFolderWarn", sState === "prompt");
				}
			}, this);
		},

		/** 本轮是否走浏览器引擎 */
		_baActive: function () {
			var o = this.getView().getModel("chat").getProperty("/ba") || {};
			return !!(o.available && o.on);
		},

		/** 设置里的「新引擎」开关 */
		onBaSwitch: function (oEvent) {
			this._baSetOn(!!oEvent.getParameter("state"));
		},

		onToggleBrowserAgent: function (oEvent) {
			this._baSetOn(!!oEvent.getParameter("pressed"));
		},

		_baSetOn: function (bOn) {
			var oChat = this.getView().getModel("chat");
			oChat.setProperty("/ba/on", bOn);
			try { window.localStorage.setItem(PREF_KEY + (this._sBaUser || ""), bOn ? "X" : "N"); } catch (e) { /* ignore */ }
			if (this._rtInfo) {
				this._rtInfo(null);
			}
			if (this._renderScenePicker) {
				this._renderScenePicker();
			}
			if (this._paintSkill) {
				this._paintSkill();
			}
			if (bOn) {
				this._baWarm();
				MessageToast.show(oChat.getProperty("/ba/mock")
					? "已切到浏览器 Agent（演示模式：固定剧本，不连 SAP）"
					: "已切到浏览器 Agent：可以列计划、调用子任务，选了文件夹后还能读写文件");
			} else {
				MessageToast.show("已切回原 Agent");
			}
		},

		// 视图格式化
		fmtBaVisible: function (sWorkspace, bAvail) {
			// 20261108：开关默认只在设置里；config.browserAgent.toggleInInput = true 时输入框下也放一个
			var oCfgBa = (window.ZAI_CONFIG && window.ZAI_CONFIG.browserAgent) || {};
			return sWorkspace === "AGENT" && !!bAvail && oCfgBa.toggleInInput === true;
		},
		/** 附件按钮：新引擎下隐藏（文件交给「选择文件夹」，模型按需读，不整份塞进提问） */
		fmtAttachVisible: function (sWorkspace, bOn) {
			return !(sWorkspace === "AGENT" && !!bOn);
		},
		fmtBaFolderVisible: function (sWorkspace, bAvail, bOn, bFs) {
			return sWorkspace === "AGENT" && !!bAvail && !!bOn && !!bFs;
		},
		fmtBaFolderText: function (sName, sState) {
			if (!sName) {
				return "选择文件夹";
			}
			return sState === "granted" ? sName : sName + " · 点此恢复";
		},
		fmtBaFolderTip: function (sName, sState) {
			if (!sName) {
				return "让灵犀读写你电脑上的一个文件夹（只能访问你选的这个文件夹；改文件前会先问你）";
			}
			return sState === "granted"
				? "灵犀可以读写「" + sName + "」。点击：撤回修改 / 换文件夹 / 不再使用"
				: "刷新后浏览器需要你再允许一次访问「" + sName + "」";
		},

		// ------------------------------------------------------------------
		// 文件夹
		// ------------------------------------------------------------------

		onBaFolder: function (oEvent) {
			var that = this;
			var oChat = this.getView().getModel("chat");
			var oBa = oChat.getProperty("/ba") || {};
			if (!oBa.folderSupported) {
				MessageToast.show("当前浏览器不支持访问文件夹：需要 HTTPS 打开的新版 Chrome / Edge");
				return;
			}
			if (!window.LingxiAgent) {
				MessageToast.show("浏览器引擎正在加载，请稍后再点");
				this._baWarm();
				return;
			}
			if (!oBa.folderName) {
				this._baPick();
				return;
			}
			if (oBa.folderState !== "granted") {
				BrowserAgentService.reauthorize().then(function (oInfo) {
					that._baSyncFolder(oInfo);
					if (oInfo && oInfo.permission !== "granted") {
						MessageToast.show("没有获得授权，灵犀暂时不能访问这个文件夹");
					}
				}).catch(function (e) {
					MessageToast.show((e && e.message) || "授权失败");
				});
				return;
			}
			var oSrc = oEvent.getSource();
			var oSheet = new ActionSheet({
				showCancelButton: true,
				placement: "Top",   // 按钮在页面最下方，往上弹
				buttons: [
					new Button({
						text: "撤回上一次修改", icon: "sap-icon://undo",
						enabled: (BrowserAgentService.folderInfo() || {}).changes > 0,
						press: function () { that._baUndo(); }
					}),
					new Button({ text: "换一个文件夹", icon: "sap-icon://open-folder", press: function () { that._baPick(); } }),
					new Button({
						text: "不再使用这个文件夹", icon: "sap-icon://decline",
						press: function () {
							BrowserAgentService.forgetFolder().then(function () { that._baSyncFolder(null); });
						}
					})
				],
				afterClose: function () { oSheet.destroy(); }
			});
			this.getView().addDependent(oSheet);
			oSheet.openBy(oSrc);
		},

		_baPick: function () {
			var that = this;
			BrowserAgentService.pickFolder().then(function (oInfo) {
				that._baSyncFolder(oInfo);
				MessageToast.show("灵犀现在可以读写「" + oInfo.name + "」了；改文件前会先给你看改动");
			}).catch(function (e) {
				if (e && e.name === "AbortError") {
					return;   // 用户取消了选择框
				}
				MessageToast.show((e && e.message) || "没有选到文件夹");
			});
		},

		_baUndo: function () {
			var that = this;
			BrowserAgentService.undoLast().then(function (r) {
				if (r && r.error) {
					MessageToast.show(r.error);
					return;
				}
				that._baSyncFolder(BrowserAgentService.folderInfo());
				MessageToast.show("已撤回：" + r.action + " " + r.path);
			});
		},

		// ------------------------------------------------------------------
		// 发送（_executeSend 在浏览器引擎开着时调用这里，代替 ChatService.sendByMode）
		// ------------------------------------------------------------------

		_baHistory: function () {
			var aMsgs = this.getView().getModel("chat").getProperty("/messages") || [];
			var a = [];
			aMsgs.forEach(function (m) {
				if (!m || m.streaming || (m.role !== "user" && m.role !== "assistant")) {
					return;
				}
				var s = m.role === "user" ? (m.question || m.raw || "") : (m.raw || "");
				if (s) {
					a.push({ role: m.role, content: String(s).slice(0, 4000) });
				}
			});
			// 最后一条是本轮刚推进去的用户消息，由引擎自己加
			if (a.length && a[a.length - 1].role === "user") {
				a.pop();
			}
			return a.slice(-MAX_HISTORY);
		},

		/**
		 * @param {object} p sendByMode 的参数（sessionId / question / modelId / scene / skillId / think）
		 * @param {object} oPending 本轮占位气泡（取 uid 画步骤）
		 */
		_baSend: function (p, oPending) {
			var that = this;
			var sUid = oPending.uid;
			// 20261108（界面改版）：过程画在时间线里（RunTimeline），确认就地完成
			this._rtStart(sUid, p.sessionId);
			var oAbort = new AbortController();
			this._baAbort = oAbort;
			return BrowserAgentService.send({
				question: p.question,
				history: this._baHistory(),
				sessionId: p.sessionId,
				scene: p.scene,
				modelId: p.modelId,
				skillId: p.skillId,
				focusArtifactId: p.focusedArtifactId || "",
				think: p.think === "X",
				signal: oAbort.signal,
				authHeader: function () { return ChatService._basicHeader ? ChatService._basicHeader() : ""; },
				// 演示模式：报表目录与技能清单取 ChatService 的演示数据（真实环境由 SAP /run/start 下发）
				mock: ChatService.getMode() === "mock" ? {
					reportDefs: function () { return ChatService._mockReportDefs ? ChatService._mockReportDefs() : null; },
					skills: function () { return ChatService.getSkills ? ChatService.getSkills({ scene: p.scene, sessionId: p.sessionId }) : null; },
					// Fiori 场景同原 Agent 的演示：先走确定性的一轮（参数卡 / 候选 / 闸门 / 同意分析）
					fioriTurn: ChatService._fioriTurn ? function (sQ) {
						return ChatService._fioriTurn({ sessionId: p.sessionId, question: sQ || p.question, focusedArtifactId: p.focusedArtifactId || "" });
					} : null,
					// 20261108：场景只作权限后，聚焦的是不是 Fiori 结果（是才走「交给模型分析」的确定性一轮）
					isFioriResult: function (sId) {
						var st = ChatService._mockFioriState ? ChatService._mockFioriState() : null;
						return !!(sId && st && st.runs && st.runs[sId]);
					},
					fioriAnalysis: ChatService._fioriMockAnalysis ? function (oRun) {
						return ChatService._fioriMockAnalysis(oRun, p.question);
					} : null
				} : null,
				onEvent: function (e) {
					that._rtEvent(sUid, e);
				},
				confirm: function (req) {
					return that._rtConfirm(sUid, req);
				},
				ask: function (req) {
					return that._rtQuestion(sUid, req);
				}
			}).then(function (r) {
				that._baSyncFolder(BrowserAgentService.folderInfo());
				that._rtFinish(sUid, r && r.status === "STOPPED" ? "STOPPED" : "OK");
				// 数据集 → 和原 Agent 一样的 analysis（表格 / 图表 / 导出 / 加入组合）
				if (r && r.analysisRaw) {
					r.analysis = ChatService._sanitizeAnalysis ? ChatService._sanitizeAnalysis(r.analysisRaw) : null;
					delete r.analysisRaw;
				}
				// 演示模式没有 SAP 的 run/finish：本地记进会话，左侧列表与重开会话都能看到
				if (ChatService.getMode() === "mock" && r && r.status === "OK" && ChatService._mockRecordExchange) {
					ChatService._mockRecordExchange({ sessionId: p.sessionId, question: p.question, modelId: p.modelId, scene: p.scene }, r.answer);
				}
				return r;
			}, function (e) {
				that._baSyncFolder(BrowserAgentService.folderInfo());
				that._rtFinish(sUid, oAbort.signal.aborted ? "STOPPED" : "ERROR");
				throw e;
			}).then(function (r) {
				if (that._baAbort === oAbort) { that._baAbort = null; }
				return r;
			}, function (e) {
				if (that._baAbort === oAbort) { that._baAbort = null; }
				throw e;
			});
		},

		/** 停止生成时中断浏览器里的运行（已发到 SAP 的请求以 SAP 状态为准） */
		_baStop: function () {
			if (this._fnBaDlgCancel) {
				this._fnBaDlgCancel();   // 还开着的确认框按「不要改」收掉
			}
			// 时间线里还在等确认的面板也按「不要」收掉，引擎才能停下来
			var sRt = this._rtActiveUid && this._rtActiveUid();
			if (sRt && this._mRt[sRt].ask) {
				this._rtCancelAsk(sRt);
			}
			if (this._baAbort) {
				this._baAbort.abort(new Error("用户停止"));
				this._baAbort = null;
			}
		},

		// ------------------------------------------------------------------
		// 改文件确认
		// ------------------------------------------------------------------

		_baDiffHtml: function (req) {
			var sBefore = req.before, sAfter = req.after;
			if (req.action === "删除") {
				return '<div class="baDiffNote">删除后原文件会先备份到 .lingxi/备份/，可以撤回。</div>' +
					(sBefore != null ? '<pre class="baDiff">' + String(sBefore).split("\n").slice(0, 200).map(function (l) {
						return '<span class="baDel">- ' + esc(l) + "</span>";
					}).join("") + "</pre>" : "");
			}
			if (sBefore == null) {
				var aNew = String(sAfter || "").split("\n");
				return '<div class="baDiffNote">' + (req.action === "新建" ? "新建文件" : "覆盖文件（原文件不是文本或太大，无法逐行对比）") +
					"，共 " + aNew.length + " 行</div><pre class=\"baDiff\">" +
					aNew.slice(0, 400).map(function (l) { return '<span class="baAdd">+ ' + esc(l) + "</span>"; }).join("") +
					(aNew.length > 400 ? '<span class="baGap">…</span>' : "") + "</pre>";
			}
			var d = lineDiff(sBefore, sAfter);
			if (!d) {
				return '<div class="baDiffNote">文件较大，只显示改后的前 200 行</div><pre class="baDiff">' +
					esc(String(sAfter).split("\n").slice(0, 200).join("\n")) + "</pre>";
			}
			// 只显示改动附近 3 行
			var aShow = [], iLast = -10, nAdd = 0, nDel = 0;
			d.forEach(function (x, i) {
				if (x[0] === "+") { nAdd++; }
				if (x[0] === "-") { nDel++; }
			});
			var aMark = d.map(function (x) { return x[0] !== " "; });
			d.forEach(function (x, i) {
				var bNear = false;
				for (var k = Math.max(0, i - 3); k <= Math.min(d.length - 1, i + 3); k++) {
					if (aMark[k]) { bNear = true; break; }
				}
				if (!bNear) {
					return;
				}
				if (i - iLast > 1 && aShow.length) {
					aShow.push('<span class="baGap">⋯</span>');
				}
				iLast = i;
				var sCls = x[0] === "+" ? "baAdd" : x[0] === "-" ? "baDel" : "baCtx";
				aShow.push('<span class="' + sCls + '">' + (x[0] === " " ? "  " : x[0] + " ") + esc(x[1]) + "</span>");
			});
			return '<div class="baDiffNote">+' + nAdd + " 行　−" + nDel + " 行　改之前的原样会备份到 .lingxi/备份/，可以撤回</div>" +
				'<pre class="baDiff">' + (aShow.length ? aShow.join("") : "（内容没有变化）") + "</pre>";
		},

		/** 改 / 建 / 删文件前弹窗；返回 Promise<{approved, message}> */
		_baConfirm: function (req) {
			var that = this;
			var sFolder = this.getView().getModel("chat").getProperty("/ba/folderName") || "";
			return new Promise(function (resolve) {
				var bDone = false;
				var fnEnd = function (bOk, sMsg) {
					if (bDone) { return; }
					bDone = true;
					that._fnBaDlgCancel = null;
					resolve({ approved: bOk, message: sMsg || "" });
					oDlg.close();
				};
				var oDlg = new Dialog({
					title: "灵犀想" + req.action + "文件",
					contentWidth: "44rem",
					resizable: true,
					draggable: true,
					content: [new HTML({
						content: '<div class="baConfirm"><div class="baPath"><span class="baAct">' + esc(req.action) + "</span>" +
							esc(sFolder) + esc(req.path) + "</div>" + that._baDiffHtml(req) + "</div>"
					})],
					beginButton: new Button({ text: "应用", type: "Emphasized", press: function () { fnEnd(true); } }),
					endButton: new Button({ text: "不要改", press: function () { fnEnd(false, "用户点了不要改"); } }),
					escapeHandler: function (oPromise) { oPromise.reject(); fnEnd(false, "用户关闭了确认框"); },
					afterClose: function () { oDlg.destroy(); }
				}).addStyleClass("baConfirmDialog");
				that._fnBaDlgCancel = function () { fnEnd(false, "用户停止了这次运行"); };
				that.getView().addDependent(oDlg);
				oDlg.open();
			});
		}
	};
});
