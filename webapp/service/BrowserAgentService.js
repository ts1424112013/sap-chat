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
		ls: "列目录", read_file: "读文件", write_file: "写文件", edit_file: "改文件", "delete": "删除文件", delete_file: "删除文件",
		glob: "找文件", grep: "搜内容", task: "子任务", ask_user: "问你",
		search_tables: "查表", describe_table: "表结构", run_sql: "执行查询", sap_data_analysis: "数据分析",
		resolve_report: "找报表", get_report_parameters: "报表参数", get_report_result: "报表结果",
		read_program_source: "读源码", call_function: "调用函数", query_result: "查询结果",
		resolve_material: "物料", get_stock_snapshot: "库存", get_daily_movement: "出入库", get_batch_stock: "批次库存",
		// 20261107 M2：报表 / 结果 / 存到文件夹
		list_results: "我的结果", read_result: "读结果", lookup_by_result: "关联查表",
		open_report: "报表参数卡", prefill_report: "预填参数卡", save_result_to_folder: "存到文件夹",
		// 20261109 新建 Excel / Word（引擎 0.13.0）
		create_excel_file: "新建 Excel", create_word_file: "新建 Word",
		// 20261108 ADT 代码工具（只读，浏览器直连 /sap/bc/adt）
		adt_search: "找对象", adt_read_source: "读源码", adt_structure: "对象结构", adt_where_used: "被谁使用",
		adt_package: "包内容", adt_syntax_check: "语法检查",
		// 20261109 记忆超过 6000 字时回答后整理（引擎自己做的一步，不是模型工具）
		compact_memory: "整理记忆"
	};

	function cfg() {
		var c = (window.ZAI_CONFIG && window.ZAI_CONFIG.browserAgent) || {};
		return { enabled: c.enabled !== false, path: c.path || "/sap/bc/zai_agent" };
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

		/** 工具的中文名（时间线、步骤用） */
		toolLabel: function (sTool) {
			// 20261109（《04》〇-AU）：MCP 工具 mcp_<服务>_<工具> → 「MCP · 工具」（服务名在 SAP 给模型的说明里）
			if (!TOOL_LABEL[sTool] && /^mcp_[a-z0-9]+_./.test(sTool || "")) {
				return "MCP · " + String(sTool).replace(/^mcp_[a-z0-9]+_/, "");
			}
			return TOOL_LABEL[sTool] || sTool || "";
		},

		/**
		 * 会话里新引擎各轮的精简过程记录（刷新 / 重开会话时画回来）。
		 * @returns {Promise<Array<{msgSeq:number, answerHead:string, steps:Array}>>} 拿不到时返回 []
		 */
		getSteps: function (sSessionId, oOpt) {
			var that = this;
			if (!sSessionId || !this.available()) {
				return Promise.resolve([]);
			}
			return this.load().then(function (LA) {
				var o = oOpt || {};
				var client = that.useMock ? BrowserAgentMock.createClient({ sessionId: sSessionId })
					: LA.createSapClient({ base: cfg().path, authHeader: o.authHeader ? o.authHeader() : "" });
				return client.getSteps ? client.getSteps({ sessionId: sSessionId }) : { runs: [] };
			}).then(function (r) {
				return (r && Array.isArray(r.runs)) ? r.runs : [];
			}).catch(function () {
				return [];   // SAP 还没部署 /run/steps 等：不影响历史显示
			});
		},

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
		 * @param {function(object)} o.onEvent 引擎事件（原样转发，RunTimeline 据此画过程）
		 * @param {function(object):Promise} o.confirm 改文件确认 {action,path,before,after} → {approved, always}
		 * @param {function(object):Promise} o.ask 模型问用户 {question, options} → {answer} | {other} | {cancel}
		 * @param {AbortSignal} o.signal
		 * @param {function():string} o.authHeader 本地开发经代理时的 Basic 头（部署在 SAP 时为空，走登录 Cookie）
		 * @param {object} [o.mock] 演示模式的目录数据（reportDefs / skills），见 BrowserAgentMock.createClient
		 * @returns {Promise<object>} 与 ChatService.sendTask 同形
		 */
		send: function (o) {
			var that = this;
			var t0 = Date.now();
			return this.load().then(function (LA) {
					// 20261108（界面改版）：过程由控制器的 RunTimeline 按引擎事件画；这里只原样转发事件，
				// 另外记下工具步骤（给结果的 trace / 轮数）和改动的文件（回答末尾列出）
				var aSteps = [];
				var mById = {};
				var aChanges = [];
				var iTools = 0;
				var onEvent = function (e) {
					if (e.type === "tool_start" && e.tool === "ask_user") {
						// 问用户不算工具步骤（时间线里是问题卡）
					} else if (e.type === "tool_start") {
						iTools++;
						mById[e.id] = { phase: "EXECUTING", status: "RUNNING", tool: e.tool, toolLabel: TOOL_LABEL[e.tool] || e.tool,
							label: e.arg || mainArg(e.tool, e.args), t: Date.now() };
						aSteps.push(mById[e.id]);
					} else if (e.type === "tool_end" && mById[e.id]) {
						mById[e.id].status = e.ok ? "OK" : "ERROR";
						mById[e.id].elapsedMs = Date.now() - mById[e.id].t;
					} else if (e.type === "card") {
						aSteps.forEach(function (s) { if (s.status === "RUNNING") { s.status = "OK"; s.elapsedMs = Date.now() - s.t; } });
					} else if (e.type === "file_changed") {
						aChanges.push({ action: e.action, path: e.path, backup: e.backup });
					}
					if (o.onEvent) {
						try { o.onEvent(e); } catch (x) { /* 界面错误不打断运行 */ }
					}
				};

				var oFB = that._folderBackend(LA);
				var oRun = {
					question: o.question,
					history: o.history || [],
					context: { sessionId: o.sessionId, scene: o.scene, modelId: o.modelId, think: !!o.think, skillId: o.skillId || "",
						focusArtifactId: o.focusArtifactId || "" },
					folderBackend: oFB || undefined,
					confirm: o.confirm,
					ask: o.ask,
					title: !!o.genTitle,   // 20261108：任务第一轮回答后让模型起会话标题
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
					res.title = r.title || "";
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
				return "SAP 上还没有新引擎服务（/sap/bc/zai_agent），请先部署后端或切回原引擎。";
			}
			if (e && (e.status === 401 || e.status === 403)) {
				return "没有使用新引擎的权限（" + s + "）。请联系管理员开通，或切回原引擎。";
			}
			return "新引擎出错：" + s;
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
