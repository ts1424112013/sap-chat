sap.ui.define([
	"zai/chat/service/BrowserAgentMock"
], function (BrowserAgentMock) {
	"use strict";

	/**
	 * =====================================================================
	 * 浏览器 Agent 引擎（Deep Agents 浏览器版）服务层
	 * 设计：功能计划书/Deep Agents浏览器接入/02-方案与开发计划_V2.0
	 * =====================================================================
	 *  · 按需加载 thirdparty/lingxi-agent/lingxi-agent.js（2.6 MB，不进 Component-preload）
	 *  · 文件夹：选择 / 记住（IndexedDB 只存句柄）/ 刷新后恢复授权 / 撤回上一次修改
	 *  · send()：调 LingxiAgent.run()，把引擎事件转成「边跑边看」步骤（_applyLive 的格式），
	 *    返回与 ChatService.sendTask 相同形状的结果（answer / status / trace …），控制器无需区分
	 *  · 演示模式（ZAI_CONFIG.mode = mock 或探测失败降级）走 BrowserAgentMock，不连 SAP
	 * 模型密钥、工具权限都在 SAP（/sap/bc/zai_agent）；本层不做任何授权判断。
	 * =====================================================================
	 */

	var BUNDLE = "zai/chat/thirdparty/lingxi-agent/lingxi-agent.js";
	var FOLDER_KEY_PREFIX = "lingxi-folder:";

	var TOOL_LABEL = {
		ls: "列目录", read_file: "读文件", write_file: "写文件", edit_file: "改文件", "delete": "删除文件",
		glob: "找文件", grep: "搜内容", task: "子任务",
		search_tables: "查表", describe_table: "表结构", run_sql: "执行查询", sap_data_analysis: "数据分析",
		resolve_report: "找报表", get_report_parameters: "报表参数", get_report_result: "报表结果",
		read_program_source: "读源码", call_function: "调用函数", query_result: "查询结果",
		resolve_material: "物料", get_stock_snapshot: "库存", get_daily_movement: "出入库", get_batch_stock: "批次库存",
		// 20261107 M2：报表 / 结果 / 存到文件夹
		list_results: "我的结果", read_result: "读结果", lookup_by_result: "关联查表",
		open_report: "报表参数卡", prefill_report: "预填参数卡", save_result_to_folder: "存到文件夹"
	};

	function cfg() {
		var c = (window.ZAI_CONFIG && window.ZAI_CONFIG.browserAgent) || {};
		return { enabled: c.enabled !== false, path: c.path || "/sap/bc/zai_agent" };
	}

	/** 一个工具调用的参数挑几个给人看（路径、关键字、表名…），长值截短 */
	function argChips(oArgs) {
		var a = [];
		Object.keys(oArgs || {}).forEach(function (k) {
			if (a.length >= 4 || k === "content" || k === "old_string" || k === "new_string" || k === "todos") {
				return;
			}
			var v = oArgs[k];
			if (v === null || v === undefined || v === "") {
				return;
			}
			v = typeof v === "string" ? v : JSON.stringify(v);
			a.push([k, v.length > 60 ? v.slice(0, 57) + "…" : v]);
		});
		return a;
	}

	function mainArg(sTool, oArgs) {
		var o = oArgs || {};
		return o.file_path || o.path || o.pattern || o.keyword || o.description || o.table || o.tabname ||
			o.tcode || o.purpose || "";
	}

	var Service = {
		_pLoad: null,
		_oFolder: null,        // { handle, backend, name, permission }
		_sUserKey: "",
		useMock: false,

		/** 浏览器条件：安全上下文（HTTPS / localhost）；配置可关 */
		available: function () {
			return cfg().enabled && !!window.isSecureContext && typeof window.fetch === "function";
		},

		/** 能不能选文件夹（Chrome / Edge + HTTPS） */
		folderSupported: function () {
			return !!window.isSecureContext && typeof window.showDirectoryPicker === "function";
		},

		/** 加载引擎（只加载一次） */
		load: function () {
			if (window.LingxiAgent) {
				return Promise.resolve(window.LingxiAgent);
			}
			if (this._pLoad) {
				return this._pLoad;
			}
			var that = this;
			this._pLoad = new Promise(function (resolve, reject) {
				var s = document.createElement("script");
				s.src = sap.ui.require.toUrl(BUNDLE);
				s.async = true;
				s.onload = function () {
					if (window.LingxiAgent) {
						resolve(window.LingxiAgent);
					} else {
						reject(new Error("浏览器引擎加载后不可用"));
					}
				};
				s.onerror = function () {
					that._pLoad = null;
					reject(new Error("浏览器引擎文件加载失败（" + s.src + "）"));
				};
				document.head.appendChild(s);
			});
			return this._pLoad;
		},

		// ------------------------------------------------------------------
		// 文件夹
		// ------------------------------------------------------------------

		/** 登录后调用：按账号取回上次的文件夹（不弹窗；权限可能是 prompt，要用户点一下恢复） */
		restoreFolder: function (sUser) {
			var that = this;
			this._sUserKey = FOLDER_KEY_PREFIX + (sUser || "");
			this._oFolder = null;
			if (!this.folderSupported()) {
				return Promise.resolve(null);
			}
			return this.load().then(function (LA) {
				return LA.restoreFolder(that._sUserKey);
			}).then(function (r) {
				if (!r) {
					return null;
				}
				that._oFolder = { handle: r.handle, backend: null, name: r.handle.name, permission: r.permission };
				return that.folderInfo();
			}).catch(function () {
				return null;
			});
		},

		folderInfo: function () {
			var f = this._oFolder;
			return f ? { name: f.name, permission: f.permission, changes: f.backend ? f.backend.changes.length : 0 } : null;
		},

		/** 选文件夹（必须在点击事件里同步调用到 showDirectoryPicker 之前，不能先 await 别的） */
		pickFolder: function () {
			var that = this;
			var LA = window.LingxiAgent;
			if (!LA) {
				return Promise.reject(new Error("浏览器引擎还没加载好，请稍后再点"));
			}
			return LA.pickFolder(this._sUserKey).then(function (h) {
				that._oFolder = { handle: h, backend: null, name: h.name, permission: "granted" };
				return that.folderInfo();
			});
		},

		/** 刷新后恢复授权（点击事件里调用） */
		reauthorize: function () {
			var that = this;
			var f = this._oFolder;
			if (!f || !window.LingxiAgent) {
				return Promise.resolve(null);
			}
			return window.LingxiAgent.requestFolderPermission(f.handle).then(function (p) {
				f.permission = p;
				return that.folderInfo();
			});
		},

		forgetFolder: function () {
			var LA = window.LingxiAgent;
			this._oFolder = null;
			return LA ? LA.forgetFolder(this._sUserKey) : Promise.resolve();
		},

		undoLast: function () {
			var f = this._oFolder;
			if (!f || !f.backend) {
				return Promise.resolve({ error: "这次打开页面后还没有改过文件" });
			}
			return f.backend.undoLast();
		},

		_folderBackend: function (LA) {
			var f = this._oFolder;
			if (!f || f.permission !== "granted") {
				return null;
			}
			if (!f.backend) {
				f.backend = new LA.FolderBackend(f.handle);
			}
			return f.backend;
		},

		// ------------------------------------------------------------------
		// 运行
		// ------------------------------------------------------------------

		/**
		 * @param {object} o
		 * @param {string} o.question
		 * @param {Array<{role,content}>} o.history
		 * @param {string} o.sessionId / o.scene / o.modelId / o.skillId / o.focusArtifactId
		 * @param {boolean} o.think
		 * @param {function(Array)} o.onSteps 每有变化推一次完整步骤列表（_applyLive 格式）
		 * @param {function(object):Promise} o.confirm 改文件确认 {action,path,before,after} → {approved}
		 * @param {AbortSignal} o.signal
		 * @param {function():string} o.authHeader 本地开发经代理时的 Basic 头（部署在 SAP 时为空，走登录 Cookie）
		 * @param {object} [o.mock] 演示模式的目录数据（reportDefs / skills），见 BrowserAgentMock.createClient
		 * @returns {Promise<object>} 与 ChatService.sendTask 同形
		 */
		send: function (o) {
			var that = this;
			var t0 = Date.now();
			return this.load().then(function (LA) {
				var aSteps = [];
				var mById = {};
				var iSeq = 0;
				var oPlan = null;
				var aChanges = [];
				var iTools = 0;
				var push = function () {
					if (o.onSteps) {
						o.onSteps(aSteps.slice());
					}
				};
				var addStep = function (st) {
					st.seq = ++iSeq;
					aSteps.push(st);
					return st;
				};
				var onEvent = function (e) {
					switch (e.type) {
					case "todos":
						var sPlan = (e.todos || []).map(function (t) {
							return (t.status === "completed" ? "✓ " : t.status === "in_progress" ? "▸ " : "○ ") + t.content;
						}).join("　");
						if (!oPlan) {
							oPlan = addStep({ phase: "NOTE", status: "OK", label: "" });
						}
						oPlan.label = "计划　" + sPlan;
						break;
					case "tool_start":
						iTools++;
						mById[e.id] = addStep({
							phase: "EXECUTING", status: "RUNNING", tool: e.tool,
							toolLabel: TOOL_LABEL[e.tool] || e.tool,
							label: mainArg(e.tool, e.args),
							args: argChips(e.args), t: Date.now()
						});
						break;
					case "tool_end":
						var st = mById[e.id];
						if (st) {
							st.status = e.ok ? "OK" : "ERROR";
							st.elapsedMs = Date.now() - st.t;
						}
						break;
					case "confirm":
						addStep({ phase: "NOTE", status: "OK", label: "等你确认：" + e.action + " " + e.path });
						break;
					case "confirmed":
						addStep({ phase: "NOTE", status: "OK", label: (e.approved ? "已同意：" : "已拒绝：") + e.action + " " + e.path });
						break;
					case "file_changed":
						aChanges.push({ action: e.action, path: e.path, backup: e.backup });
						break;
					case "thinking":
						if (e.text && e.text.trim()) {
							addStep({ phase: "NOTE", status: "OK", label: e.text.trim().slice(0, 300) });
						}
						break;
					case "skill":
						addStep({ phase: "NOTE", status: "OK", label: "使用技能：" + e.name + (e.source === "FOLDER" ? "（文件夹）" : "") });
						break;
					case "card":
						// 参数卡出来引擎就停了，这一步的工具没有 tool_end：在这里收口
						aSteps.forEach(function (s) {
							if (s.status === "RUNNING" && (!e.tool || s.tool === e.tool)) {
								s.status = "OK";
								s.elapsedMs = Date.now() - s.t;
							}
						});
						addStep({ phase: "NOTE", status: "OK", label: "参数卡已生成，请在下面核对参数后提交" });
						break;
					default:
						return;
					}
					push();
				};

				var oFB = that._folderBackend(LA);
				var oRun = {
					question: o.question,
					history: o.history || [],
					context: { sessionId: o.sessionId, scene: o.scene, modelId: o.modelId, think: !!o.think, skillId: o.skillId || "",
						focusArtifactId: o.focusArtifactId || "" },
					folderBackend: oFB || undefined,
					confirm: o.confirm,
					onEvent: onEvent,
					signal: o.signal,
					sap: { base: cfg().path }
				};
				if (that.useMock) {
					oRun.client = BrowserAgentMock.createClient({ folder: !!oFB, scene: o.scene, sessionId: o.sessionId, mock: o.mock });
				} else if (o.authHeader && o.authHeader()) {
					oRun.client = LA.createSapClient({ base: cfg().path, authHeader: o.authHeader() });
				}
				return LA.run(oRun).then(function (r) {
					var sAnswer = r.answer || "";
					if (aChanges.length) {
						sAnswer += "\n\n**本次改动的文件**（改之前的原样在 `.lingxi/备份/`，可在文件夹菜单里撤回）\n" +
							aChanges.map(function (c) { return "- " + c.action + "　`" + c.path + "`"; }).join("\n");
					}
					var res = that._result(r, sAnswer, aSteps, iTools, t0, "OK", "", o.modelId);
					// 报表参数卡：和原 Agent 同形的任务字段，控制器照常挂内联参数卡（_updateTaskState / _attachAskCard）
					// 工具带回的数据集：原样交给控制器（ChatService._sanitizeAnalysis 清洗后画表格 / 图表）
					if (r.datasets && r.datasets.length) {
						res.analysisRaw = { summary: "", findings: [], charts: [], datasets: r.datasets };
					}
					if (r.deterministic) {
						res.rounds = 0;
					}
					var c = r.card;
					if (c && c.taskId) {
						res.taskId = c.taskId;
						res.taskModule = c.taskModule || "REPORT";
						res.taskStatus = c.taskStatus || "WAITING_INPUT";
						res.needsInput = c.needsInput !== false;
						res.pendingParamsJson = c.pendingParamsJson || "";
					}
					return res;
				}, function (e) {
					var bStop = o.signal && o.signal.aborted;
					var res = that._result({ trace: e && e.trace }, "", aSteps, iTools, t0, bStop ? "STOPPED" : "ERROR",
						(e && e.message) || String(e), o.modelId);
					if (bStop) {
						return res;
					}
					var err = new Error(that._errText(e));
					err.result = res;
					throw err;
				});
			});
		},

		_errText: function (e) {
			var s = (e && e.message) || String(e);
			if (e && (e.status === 404 || /404/.test(s))) {
				return "SAP 上还没有浏览器 Agent 服务（/sap/bc/zai_agent），请先部署后端或切回原引擎。";
			}
			if (e && (e.status === 401 || e.status === 403)) {
				return "没有使用浏览器 Agent 的权限（" + s + "）。请联系管理员开通，或切回原引擎。";
			}
			return "浏览器 Agent 出错：" + s;
		},

		_result: function (r, sAnswer, aSteps, iTools, t0, sStatus, sMsg, sModelId) {
			return {
				engine: "BROWSER",
				answer: sAnswer,
				status: sStatus,
				message: sMsg,
				elapsedMs: (r && r.elapsedMs) || (Date.now() - t0),
				rounds: iTools,
				modelId: sModelId || "",
				traceValid: true,
				trace: aSteps.filter(function (s) { return s.phase === "EXECUTING"; }).map(function (s) {
					return {
						phase: "EXECUTING", label: (s.toolLabel || "") + (s.label ? " " + s.label : ""), tool: s.tool || "",
						status: s.status === "RUNNING" ? (sStatus === "OK" ? "OK" : sStatus) : s.status,
						elapsedMs: s.elapsedMs || null, rows: null, detail: ""
					};
				}),
				taskId: "", taskModule: "", taskStatus: "", needsInput: false, pendingParamsJson: "", artifactRefsJson: ""
			};
		}
	};

	return Service;
});
