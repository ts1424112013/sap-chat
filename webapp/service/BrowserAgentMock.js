sap.ui.define([], function () {
	"use strict";

	/**
	 * =====================================================================
	 * 浏览器 Agent 演示后端（演示模式 / 后端不可用时）
	 * =====================================================================
	 * 在浏览器里冒充 SAP 的 /sap/bc/zai_agent：运行号、工具清单、工具执行、技能清单、结果导出，
	 * 以及一个固定剧本的"模型"（OpenAI 兼容响应，交给引擎里真正的 Deep Agents 跑）。
	 * 用来不连 SAP / 模型时体验和自测。剧本按问题里的关键字选：
	 *   · 「执行 / 跑 + 报表事务码」→ open_report → 参数卡（引擎拿到卡即停）
	 *   · 「结果 / 导出 / 存」→ list_results → query_result →（选了文件夹且要存）save_result_to_folder
	 *   · 问题里有「技能」→ 先读第一个技能的 SKILL.md
	 *   · 数据分析 / 自动：「统计 / 分布 / 汇总」→ sap_data_analysis；「函数 / 未清采购」→ call_function（都带数据集回界面）
	 *   · Fiori 报表：同原 Agent 演示的 _fioriTurn —— 参数卡 / 候选 / 闸门提示直接回答（不调模型），同意分析后才进模型
	 *   · 其余：选了文件夹 → 列计划 / 看文件夹 / 读文件 /（要写时）写汇总；没选 → 查表
	 * 不发任何网络请求。
	 * =====================================================================
	 */

	var ROOT = "/__lingxi_mock_agent";
	var DEMO_ART = "DEMOART0050569C";
	var DEMO_COLS = ["鴻海料號", "倉碼", "庫存"];
	var DEMO_ROWS = [
		["1AM00037", "W01", 1200], ["1AM00074", "W01", 860], ["1AM00111", "W02", 3400], ["1AM00148", "W02", 75],
		["1AM00185", "W03", 2210], ["2BX00010", "W01", 640], ["2BX00020", "W03", 1980], ["3CZ00005", "W02", 15]
	];

	function call(name, args) {
		return { id: "call_" + Math.random().toString(16).slice(2, 10), type: "function", "function": { name: name, arguments: JSON.stringify(args) } };
	}

	function textOf(m) {
		var c = m && m.content;
		if (typeof c === "string") {
			return c;
		}
		return Array.isArray(c) ? c.map(function (p) { return (p && p.text) || ""; }).join("") : "";
	}

	/** 从 ls 的输出里挑一个能读的文本文件 */
	function pickFile(sLs) {
		var a = String(sLs || "").split("\n").map(function (l) { return l.replace(/\s*\(.*$/, "").trim(); });
		return a.filter(function (p) {
			return /\.(csv|txt|md|json|tsv|log)$/i.test(p) && p.indexOf("/.lingxi/") !== 0 && p !== "/灵犀记忆.md";
		})[0] || "";
	}

	function plan(aDone) {
		var a = ["看看文件夹里有什么", "读取相关文件", "回答你的问题"];
		return { todos: a.map(function (s, i) { return { content: s, status: i < aDone ? "completed" : i === aDone ? "in_progress" : "pending" }; }) };
	}

	function scriptFolder(iStep, aMsgs, sQ) {
		var aTool = aMsgs.filter(function (m) { return m.role === "tool"; });
		var sLs = (aTool.filter(function (m) { return /\(directory\)|bytes\)/.test(textOf(m)); })[0] || {});
		var sFile = pickFile(textOf(sLs));
		var bWrite = /写|改|汇总|生成|保存|整理/.test(sQ);
		switch (iStep) {
		case 0: return [call("write_todos", plan(0))];
		case 1: return [call("ls", { path: "/" })];
		case 2: return sFile ? [call("read_file", { file_path: sFile, limit: 20 }), call("write_todos", plan(1))] : null;
		case 3: return bWrite ? [call("write_file", {
			file_path: "/灵犀演示-汇总.md",
			content: "# 灵犀演示汇总\n\n- 问题：" + sQ + "\n- 读取的文件：" + (sFile || "无") + "\n- 生成时间：" + new Date().toLocaleString() + "\n"
		}), call("write_todos", plan(2))] : null;
		default: return null;
		}
	}

	function scriptNoFolder(iStep, aMsgs, sQ) {
		if (iStep === 0) {
			return [call("write_todos", { todos: [
				{ content: "在 SAP 里找相关的表", status: "in_progress" },
				{ content: "整理回答", status: "pending" }
			] })];
		}
		if (iStep === 1) {
			return [call("search_tables", { keyword: sQ.replace(/[？?。，,\s]/g, "").slice(0, 4) || "订单" })];
		}
		return null;
	}

	/** 报表：直接开参数卡 */
	function scriptReport(iStep, aMsgs, sQ, sTcode) {
		return iStep === 0 ? [call("open_report", { tcode: sTcode })] : null;
	}

	/** 结果：列结果 → 按库存排前 5 →（要存且有文件夹）存 CSV */
	function scriptResult(iStep, aMsgs, sQ, bFolder) {
		var bSave = bFolder && /存|导出|保存|另存|下载/.test(sQ);
		switch (iStep) {
		case 0: return [call("list_results", {})];
		case 1: return [call("query_result", { result_id: DEMO_ART, sort: { column: "庫存", order: "desc" }, limit: 5, purpose: "库存最高前 5 料号" })];
		case 2: return bSave ? [call("save_result_to_folder", { result_id: DEMO_ART, file_path: "/灵犀导出/成品可用库存.csv" })] : null;
		default: return null;
		}
	}

	function answer(aMsgs, sQ, bFolder, sKind) {
		var aTool = aMsgs.filter(function (m) { return m.role === "tool"; }).map(textOf);
		var aLines = ["（演示模式：没有连接 SAP 和模型，下面是固定剧本的结果，用来看浏览器 Agent 的流程。）", ""];
		if (sKind === "PLAN") {
			aLines.push("- 按受控查询计划统计了物料类型分布：原材料（ROH）最多，9120 个；成品（FERT）1280 个。明细见下方表格，可以直接生成图表。");
			return aLines.join("\n");
		}
		if (sKind === "FUNC") {
			aLines.push("- 调用函数 Z_AI_DEMO_PO_OPEN 查到工厂 1000 有 3 张未清采购单，供应商 100023 占 2 张。明细见下方表格。");
			return aLines.join("\n");
		}
		var sSkill = aTool.filter(function (t) { return /以下是管理员维护的做法/.test(t); })[0];
		if (sSkill) {
			var mName = /name: "([^"]+)"/.exec(sSkill);
			aLines.push("- 先读了技能「" + (mName ? mName[1] : "") + "」的做法，再按做法执行。");
		}
		if (sKind === "RESULT") {
			aLines.push("- 本会话的结果「成品可用庫存報表（演示）」共 " + DEMO_ROWS.length + " 行，库存最高的 5 个料号：", "",
				"| 鴻海料號 | 倉碼 | 庫存 |", "|---|---|---:|");
			DEMO_ROWS.slice().sort(function (a, b) { return b[2] - a[2]; }).slice(0, 5).forEach(function (r) {
				aLines.push("| " + r[0] + " | " + r[1] + " | " + r[2] + " |");
			});
			aLines.push("");
			if (aTool.some(function (t) { return /^已保存/.test(t); })) {
				aLines.push("- 整份结果已按你的确认存到 `/灵犀导出/成品可用库存.csv`（Excel 可直接打开）。");
			} else if (aTool.some(function (t) { return /用户拒绝/.test(t); })) {
				aLines.push("- 你拒绝了写文件，所以没有导出。");
			} else if (!bFolder && /存|导出|保存/.test(sQ)) {
				aLines.push("- 要存到电脑上，先点输入框下方的「选择文件夹」。");
			}
			return aLines.join("\n");
		}
		if (bFolder) {
			var sLs = aTool.filter(function (t) { return /\(directory\)|bytes\)/.test(t); })[0] || "";
			var n = sLs ? sLs.split("\n").filter(function (l) { return /bytes\)/.test(l); }).length : 0;
			aLines.push("- 你选的文件夹里有 **" + n + "** 个文件。");
			var sRead = aTool.filter(function (t) { return /^@@ lines/.test(t) && !/sap_skill_id|以下是管理员维护的做法/.test(t); })[0];
			if (sRead) {
				aLines.push("- 读了其中一个文本文件的前几行：", "", "```", sRead.split("\n").slice(1, 6).join("\n"), "```");
			}
			if (aTool.some(function (t) { return /Successfully wrote/.test(t); })) {
				aLines.push("- 已按你的确认写好 `/灵犀演示-汇总.md`。");
			} else if (aTool.some(function (t) { return /用户拒绝/.test(t); })) {
				aLines.push("- 你拒绝了写文件，所以没有改动任何文件。");
			}
		} else {
			aLines.push("- 没有选择本地文件夹；在 SAP 里查到 2 张相关的表（演示数据）：AFKO 订单表头、AFPO 订单项目。",
				"- 点输入框下方的「选择文件夹」，可以让灵犀读写你电脑上的一个文件夹。");
		}
		return aLines.join("\n");
	}

	/** 演示数据集（与 SAP build_datasets_json 同格式） */
	function demoDs(sName, aCols, aRows, sSource) {
		return {
			name: sName, status: "OK", total_rows: aRows.length, truncated: false, elapsed_ms: 120, source: sSource || "",
			columns: aCols.map(function (c) { return { name: c[0], label: c[1] || c[0], numeric: !!c[2] }; }),
			rows: aRows
		};
	}

	var DS_RESULT = function (iLimit) {
		return demoDs("库存最高前 " + iLimit + " 料号", [["鴻海料號"], ["倉碼"], ["庫存", "", true]],
			DEMO_ROWS.slice().sort(function (a, b) { return b[2] - a[2]; }).slice(0, iLimit), "RESULT:" + DEMO_ART);
	};
	var DS_PLAN = demoDs("按物料类型统计物料数", [["MTART", "物料类型"], ["COUNT", "物料数", true]],
		[["FERT", 1280], ["HALB", 3460], ["ROH", 9120], ["VERP", 410]], "PLAN");
	var DS_FUNC = demoDs("工厂 1000 未清采购", [["EBELN", "采购订单"], ["LIFNR", "供应商"], ["OPEN_QTY", "未清数量", true]],
		[["4500012345", "100023", 1200], ["4500012377", "100045", 300], ["4500012410", "100023", 75]], "FUNC:Z_AI_DEMO_PO_OPEN");

	/** 数据分析：受控查询计划 → 数据集 */
	function scriptPlan(iStep) {
		return iStep === 0 ? [call("sap_data_analysis", { intent: "table_analysis", queries: [{
			name: "按物料类型统计物料数", entity: "MATERIAL", operation: "group", dimensions: ["MTART"], metrics: ["count"], filters: []
		}] })] : null;
	}

	/** 调用函数：未清采购（演示函数） */
	function scriptFunc(iStep) {
		return iStep === 0 ? [call("call_function", { "function": "Z_AI_DEMO_PO_OPEN", purpose: "工厂 1000 未清采购", params: { IV_WERKS: "1000" } })] : null;
	}

	function demoCsv() {
		var cell = function (v) {
			v = String(v);
			return /[",\r\n]/.test(v) ? "\"" + v.replace(/"/g, "\"\"") + "\"" : v;
		};
		return [DEMO_COLS].concat(DEMO_ROWS).map(function (r) { return r.map(cell).join(","); }).join("\r\n") + "\r\n";
	}

	/** 报表事务码：问题里点名的（不认识时用演示目录里第一张能执行的） */
	function tcodeOf(sQ, aDefs) {
		var m = /([A-Za-z][A-Za-z0-9_]{3,29})/.exec(String(sQ).replace(/报表|执行|跑/g, " "));
		var s = m ? m[1].toUpperCase() : "";
		if (s && aDefs.some(function (d) { return d.TCODE === s; })) {
			return s;
		}
		var d = aDefs.filter(function (x) { return x.EXEC_ENABLED === "X"; })[0];
		return s || (d ? d.TCODE : "ZDPMM702");
	}

	return {
		ROOT: ROOT,
		DEMO_ART: DEMO_ART,

		/**
		 * @param {object} oOpt
		 * @param {boolean} oOpt.folder 选了文件夹
		 * @param {string} oOpt.scene / oOpt.sessionId
		 * @param {{reportDefs?:function():Promise, skills?:function():Promise}} [oOpt.mock] 演示目录（ChatService 的演示数据）
		 */
		createClient: function (oOpt) {
			var o = oOpt || {};
			var mock = o.mock || {};
			var sQuestion = "";
			var sKind = "";
			var sTcode = "";
			var aDefs = [];
			var root = window.location.origin + ROOT;
			var fnResp = function (oBody) {
				return Promise.resolve(new Response(JSON.stringify(oBody), { status: 200, headers: { "Content-Type": "application/json" } }));
			};
			var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
			var safe = function (fn) {
				try { return Promise.resolve(fn ? fn() : null).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
			};
			var scene = String(o.scene || "AUTO").toUpperCase();
			var bRptScene = scene === "AUTO" || scene === "REPORT";
			var sFioriText = "";
			return {
				root: root,
				startRun: function (p) {
					sQuestion = (p && p.question) || "";
					// Fiori 场景：同 SAP，先走确定性的一轮；不是「同意分析」就直接回答（不调模型）
					var oT = scene === "FIORI" && mock.fioriTurn ? mock.fioriTurn() : null;
					if (oT && oT.kind !== "ANALYZE") {
						var bCard = oT.kind === "CARD" && oT.pending;
						return wait(200).then(function () {
							return {
								runId: "MOCK" + Date.now().toString(36), model: "演示模型", tools: [], skills: [], "export": false,
								answer: oT.answer || "（没有可显示的内容）",
								card: bCard ? {
									tool: "fiori", taskId: "FTASK" + String(o.sessionId || "").substring(0, 8),
									taskModule: "FIORI", taskStatus: "WAITING_INPUT", needsInput: true,
									pendingParamsJson: oT.pending, answer: oT.answer
								} : null
							};
						});
					}
					if (oT) {
						sKind = "FIORI_ANALYZE";
						sFioriText = mock.fioriAnalysis && oT.run ? mock.fioriAnalysis(oT.run) : "（演示）已同意分析。";
					}
					return Promise.all([safe(mock.reportDefs), safe(mock.skills)]).then(function (a) {
						aDefs = (a[0] && a[0].defs) || [];
						var aSkills = ((a[1] && a[1].enabled !== false && a[1].skills) || []).filter(function (s) {
							return s.id && s.body && s.id !== (p && p.skillId);
						}).slice(0, 30).map(function (s) {
							return { id: s.id, name: s.name, description: s.description, body: s.body };
						});
						var bDataScene = scene === "DATA" || scene === "AUTO";
						if (sKind === "FIORI_ANALYZE") {
							// 已定
						} else if (bRptScene && /执行|跑一下|跑个|开.*报表|报表参数/.test(sQuestion)) {
							sKind = "REPORT";
							sTcode = tcodeOf(sQuestion, aDefs);
						} else if (bDataScene && /函数|未清采购/.test(sQuestion)) {
							sKind = "FUNC";
						} else if (bDataScene && /统计|分布|占比|趋势|汇总/.test(sQuestion) && !/结果/.test(sQuestion)) {
							sKind = "PLAN";
						} else if (/结果|导出|存成|另存|排名|最高|最多/.test(sQuestion)) {
							sKind = "RESULT";
						}
						var aTools = [{
							name: "search_tables",
							description: "按关键字搜索 SAP 表（表名与描述）",
							parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] }
						}, {
							name: "list_results", description: "列出本会话里可以分析的报表结果", parameters: { type: "object", properties: {} }
						}, {
							name: "read_result", description: "读一份报表结果的概况",
							parameters: { type: "object", properties: { result_id: { type: "string" } }, required: ["result_id"] }
						}, {
							name: "query_result", description: "在一份报表结果的全部行上筛选 / 分组 / 排序",
							parameters: { type: "object", properties: { result_id: { type: "string" }, sort: { type: "object" }, limit: { type: "integer" }, purpose: { type: "string" } }, required: ["result_id"] }
						}];
						if (bDataScene) {
							aTools.push({
								name: "sap_data_analysis", description: "SAP 数据分析(受控查询计划)",
								parameters: { type: "object", properties: { intent: { type: "string" }, queries: { type: "array", items: { type: "object" } } }, required: ["queries"] }
							}, {
								name: "call_function", description: "调用已登记的只读函数",
								parameters: { type: "object", properties: { "function": { type: "string" }, purpose: { type: "string" }, params: { type: "object" } }, required: ["function"] }
							});
						}
						if (bRptScene) {
							aTools.push({
								name: "open_report", description: "打开报表参数卡",
								parameters: { type: "object", properties: { tcode: { type: "string" } }, required: ["tcode"] }
							});
						}
						return wait(200).then(function () {
							return {
								runId: "MOCK" + Date.now().toString(36),
								model: "演示模型",
								tools: aTools,
								skills: aSkills,
								"export": true,
								limits: { recursionLimit: 60 },
								systemPrompt: "场景：" + scene + "（演示）" + (aDefs.length ? "\n可用的报表：" +
									aDefs.map(function (d) { return d.TCODE + " " + d.NAME; }).join("；") : "")
							};
						});
					});
				},
				execTool: function (p) {
					return wait(400).then(function () {
						var a = p.args || {};
						switch (p.tool) {
						case "search_tables":
							return { ok: true, content: JSON.stringify({ rows: [{ TABNAME: "AFKO", DDTEXT: "订单表头" }, { TABNAME: "AFPO", DDTEXT: "订单项目" }], total: 2 }) };
						case "list_results":
							return { ok: true, content: JSON.stringify({ ok: true, count: 1, results: [{ id: DEMO_ART, label: "成品可用庫存報表（演示）", report: "ZDPMM702", rows: DEMO_ROWS.length }] }) };
						case "read_result":
						case "query_result":
							if (a.result_id !== DEMO_ART) {
								return { ok: true, content: JSON.stringify({ ok: false, error: "结果 " + a.result_id + " 不存在或不属于当前会话" }) };
							}
							var aRows = DEMO_ROWS.slice().sort(function (x, y) { return y[2] - x[2]; }).slice(0, a.limit || 20);
							return { ok: true, content: JSON.stringify({ ok: true, total: DEMO_ROWS.length, columns: DEMO_COLS, rows: aRows }),
								datasets: p.tool === "query_result" ? [DS_RESULT(a.limit || 20)] : undefined };
						case "sap_data_analysis":
							return { ok: true, content: JSON.stringify({ ok: true, datasets: [DS_PLAN] }), datasets: [DS_PLAN] };
						case "call_function":
							return { ok: true, content: JSON.stringify({ ok: true, "function": "Z_AI_DEMO_PO_OPEN", dataset: DS_FUNC }), datasets: [DS_FUNC] };
						case "open_report":
							var sTc = String(a.tcode || "").toUpperCase();
							var d = aDefs.filter(function (x) { return x.TCODE === sTc; })[0];
							var aP = ((d && d.PARAMS) || []).filter(function (x) { return x.SEL_KIND !== "F"; });
							if (!d || d.EXEC_ENABLED !== "X" || !aP.length) {
								return { ok: true, content: JSON.stringify({ ok: false, error: "【报表未登记】事务代码 " + sTc + " 未登记或暂未开放执行（演示）" }) };
							}
							var oPend = {
								report_id: d.REPORT_ID, tcode: d.TCODE,
								params: aP.map(function (x) {
									return { param_id: x.PARAM_ID, label: x.DISPLAY_LABEL || x.PARAM_ID, required: !!x.REQUIRED,
										data_type: x.DATA_TYPE || "CHAR", multi_value: !!x.MULTI_VALUE, range_allowed: !!x.RANGE_ALLOWED };
								})
							};
							return { ok: true, content: "{\"ok\":true,\"card\":true}", card: {
								tool: "open_report",
								taskId: "RTASK" + String(o.sessionId || "").substring(0, 8),
								taskModule: "REPORT", taskStatus: "WAITING_INPUT", needsInput: true,
								pendingParamsJson: JSON.stringify(oPend),
								answer: "【报表 " + d.NAME + "】(" + d.TCODE + " / " + d.REPORT_ID + ")\n" + (d.DESCRIPTION || "") +
									"\n\n请在下面的参数卡里填写参数后提交（演示模式：不会提交后台作业）。"
							} };
						default:
							return { ok: false, message: "演示后端没有这个工具：" + p.tool };
						}
					});
				},
				exportResult: function (p) {
					return wait(300).then(function () {
						if (p.resultId !== DEMO_ART) {
							throw new Error("结果 " + p.resultId + " 不存在或不属于当前会话");
						}
						return { ok: true, label: "成品可用庫存報表（演示）", rows: DEMO_ROWS.length, columns: DEMO_COLS.length, truncated: false, csv: demoCsv() };
					});
				},
				finishRun: function () {
					return Promise.resolve({ ok: true });
				},
				modelFetch: function () {
					return function (url, init) {
						var oReq = {};
						try { oReq = JSON.parse((init && init.body) || "{}"); } catch (e) { /* ignore */ }
						var aMsgs = oReq.messages || [];
						var sFirst = textOf(aMsgs.filter(function (m) { return m.role === "user"; })[0]);
						var sSys = aMsgs.filter(function (m) { return m.role === "system"; }).map(textOf).join("\n");
						// 只数本轮（最后一条用户消息之后）的模型步骤；同一会话前几轮的回答也在 messages 里
						var iLastUser = -1;
						aMsgs.forEach(function (m, i) { if (m.role === "user") { iLastUser = i; } });
						var aTurn = aMsgs.slice(iLastUser + 1);
						var iStep = aTurn.filter(function (m) { return m.role === "assistant"; }).length;
						aMsgs = aMsgs.slice(Math.max(0, iLastUser));   // 剧本只看本轮的工具结果
						var calls;
						var sText = "";
						if (/^子任务/.test(sFirst)) {
							sText = "子任务完成（演示）";
						} else {
							// 问题里提到「技能」且系统提示里列了技能 → 第一步先读技能
							var mSkill = /技能/.test(sQuestion) && /(\/(?:SAP技能|\.lingxi\/技能)\/[^\s)`'"]+\/SKILL\.md)/.exec(sSys);
							var iOff = mSkill ? 1 : 0;
							if (sKind === "FIORI_ANALYZE") {
								calls = null;   // 结果上下文已在系统说明里（演示：直接给统计解读）
							} else if (mSkill && iStep === 0) {
								calls = [call("read_file", { file_path: mSkill[1] })];
							} else if (sKind === "PLAN") {
								calls = scriptPlan(iStep - iOff);
							} else if (sKind === "FUNC") {
								calls = scriptFunc(iStep - iOff);
							} else if (sKind === "REPORT") {
								calls = scriptReport(iStep - iOff, aMsgs, sQuestion, sTcode);
							} else if (sKind === "RESULT") {
								calls = scriptResult(iStep - iOff, aMsgs, sQuestion, o.folder);
							} else {
								calls = o.folder ? scriptFolder(iStep - iOff, aMsgs, sQuestion) : scriptNoFolder(iStep - iOff, aMsgs, sQuestion);
							}
							if (!calls) {
								sText = sKind === "FIORI_ANALYZE" ? sFioriText : answer(aMsgs, sQuestion, o.folder, sKind);
							}
						}
						return wait(calls ? 600 : 400).then(function () {
							return fnResp({
								id: "mock-" + Date.now(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock",
								choices: [{ index: 0, finish_reason: calls ? "tool_calls" : "stop",
									message: calls ? { role: "assistant", content: "", tool_calls: calls } : { role: "assistant", content: sText } }],
								usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
							});
						});
					};
				}
			};
		}
	};
});
