sap.ui.define([
	"zai/chat/utils/Formatter",
	"zai/chat/service/BrowserAgentService"
], function (Formatter, BrowserAgentService) {
	"use strict";

	/**
	 * =====================================================================
	 * App 控制器拆分块：新引擎的过程时间线（界面改版方案 V1.1）
	 * =====================================================================
	 * Claude Code 的结构和节奏、正常界面的排版：
	 *   说明（模型在关键节点说的一句话）→ 工具行（图标 + 中文名 + 主要参数，点开看详情）
	 *   → 结果行（一句话）→ 数据预览（完整表格在回答下方）→ 就地确认面板（1 / 2 / 3）
	 * 计划清单与状态行固定在过程最下面：后面不管输出多少说明和步骤，都能一眼看到进度。
	 * 输入框下的信息栏（chat>/ba/infoHtml）同时显示引擎、文件夹、上下文用量、次数和计划进度。
	 * 一次运行的状态在 this._mRt[uid]；画成 HTML 写进消息条目的 tlHtml（同 liveHtml / extraHtml 的做法）。
	 * 所有动态文字先转义，标签由本文件构造。原引擎不经过这里。方法名统一 _rt 前缀。
	 * =====================================================================
	 */

	function esc(s) {
		return Formatter.escapeHtml(s == null ? "" : String(s));
	}

	var VERB = {
		search_tables: "查表中", describe_table: "看表结构", run_sql: "查询中", sap_data_analysis: "分析中",
		call_function: "调用函数中", query_result: "计算中", lookup_by_result: "关联查表中", list_results: "找结果中",
		read_result: "读结果中", open_report: "准备参数卡", prefill_report: "准备参数卡", save_result_to_folder: "导出中",
		read_file: "读文件中", write_file: "写文件中", edit_file: "改文件中", ls: "看文件夹", glob: "找文件中", grep: "搜内容中",
		task: "子任务进行中", read_program_source: "读源码中", resolve_material: "查物料", get_stock_snapshot: "查库存",
		get_daily_movement: "查出入库", get_batch_stock: "查批次库存",
		adt_search: "找对象中", adt_read_source: "读源码中", adt_structure: "看结构", adt_where_used: "查使用处",
		adt_package: "看包内容", adt_syntax_check: "语法检查中", delete_file: "删文件中", compact_memory: "整理记忆中",
		create_excel_file: "生成 Excel 中", create_word_file: "生成 Word 中"
	};

	/* 小图标（16×16，currentColor） */
	var P = function (d) {
		return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
	};
	var IC = {
		ok: P("M3.5 8.4l3 3 6-6.4"),
		err: P("M4.5 4.5l7 7M11.5 4.5l-7 7"),
		stop: P("M5 5h6v6H5z"),
		spin: '<svg class="rtSpin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
		plan: P("M6 4h7M6 8h7M6 12h7M2.8 4l.7.7 1.2-1.4M2.8 8l.7.7 1.2-1.4M2.8 12l.7.7 1.2-1.4"),
		think: P("M8 2.5a4 4 0 0 0-2.3 7.3V11h4.6V9.8A4 4 0 0 0 8 2.5zM6.3 13.5h3.4"),
		note: P("M3 4.5h10M3 8h10M3 11.5h6"),
		skill: P("M8 2l1.6 3.6 3.9.4-2.9 2.6.8 3.8L8 10.5l-3.4 1.9.8-3.8L2.5 6l3.9-.4z"),
		chev: '<svg class="rtChev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		hand: P("M5.5 8V3.8a1 1 0 0 1 2 0V7m0-3.6a1 1 0 0 1 2 0V7m0-2.6a1 1 0 0 1 2 0V9a4 4 0 0 1-4 4h-.6a3.5 3.5 0 0 1-2.8-1.4L2.6 9.5a1 1 0 0 1 1.5-1.3L5.5 9.6")
	};

	function secs(ms) {
		return ms >= 50 ? (ms / 1000).toFixed(1) + " 秒" : "";
	}

	return {

		/* ---------------- 运行中 ---------------- */

		/** 开始一次新引擎运行：建状态、挂交互，返回状态对象 */
		_rtStart: function (sUid, sSid) {
			this._rtBind();
			this._mRt = this._mRt || {};
			var s = this._mRt[sUid] = {
				uid: sUid, sid: sSid, items: [], byId: {}, plan: null, status: "RUNNING", verb: "理解问题",
				t0: Date.now(), model: 0, tool: 0, lastWasTool: false, limits: {}, ctxUsed: 0, ask: null, collapsed: false
			};
			this._rtRender(sUid);
			this._rtTicker();
			this._rtInfo(s);
			return s;
		},

		/** 引擎事件 → 状态（BrowserAgentService.send 的 onEvent） */
		_rtEvent: function (sUid, e) {
			var s = this._mRt && this._mRt[sUid];
			if (!s || !e) {
				return;
			}
			var oIt;
			switch (e.type) {
			case "run":
				s.limits = e.limits || {};
				break;
			case "say":
				// 说明和同一轮的工具调用是一次模型回应：这里先记一次，紧跟的工具不再重复计
				s.items.push({ k: "say", text: e.text });
				s.model++;
				s.lastWasTool = true;
				break;
			case "think":
				s.items.push({ k: "think", text: e.text, ms: e.ms || 0, open: false });
				break;
			case "usage":
				s.ctxUsed = e.input || 0;
				if (e.ctx) { s.limits.contextTokens = e.ctx; }
				break;
			case "todos":
				s.plan = (e.todos || []).map(function (t) { return { text: t.content, st: t.status }; });
				break;
			case "tool_start":
				if (e.tool === "ask_user") {   // 问用户：由 _rtQuestion 画成问题卡，不另画工具行
					if (!s.lastWasTool) { s.model++; }
					s.lastWasTool = true;
					return;
				}
				if (!s.lastWasTool) { s.model++; }
				s.lastWasTool = true;
				s.tool++;
				oIt = { k: "tool", id: e.id, tool: e.tool, label: BrowserAgentService.toolLabel(e.tool), arg: e.arg || "",
					args: e.args, st: "RUNNING", t: Date.now(), open: false };
				s.byId[e.id] = oIt;
				s.items.push(oIt);
				s.verb = VERB[e.tool] || "执行中";
				break;
			case "tool_end":
				if (e.tool === "ask_user") {
					s.lastWasTool = false;
					return;
				}
				oIt = s.byId[e.id];
				s.lastWasTool = false;
				if (oIt) {
					oIt.st = e.ok ? "OK" : "ERROR";
					oIt.sum = e.summary || "";
					oIt.preview = e.preview || "";
					oIt.ms = Date.now() - oIt.t;
				}
				s.verb = "整理中";
				break;
			case "datasets":
				oIt = s.byId[e.id] || s.items.filter(function (x) { return x.k === "tool" && x.tool === e.tool; }).pop();
				if (oIt) { oIt.ds = { index: e.index, count: e.count, preview: e.preview || [] }; }
				break;
			case "confirmed":
				if (e.auto) {
					s.items.push({ k: "note", st: "OK", text: "已按你的允许自动" + e.action + " " + e.path });
				}
				break;
			case "skill":
				s.items.push({ k: "skill", text: e.name + (e.source === "FOLDER" ? "（文件夹）" : "") });
				break;
			case "compacted":
				s.items.push({ k: "note", text: "对话较长，已自动压缩（早期内容总结成一段，原文留在本次运行的草稿里）" });
				break;
			case "card":
				s.items.forEach(function (x) { if (x.k === "tool" && x.st === "RUNNING") { x.st = "OK"; x.ms = Date.now() - x.t; } });
				s.items.push({ k: "note", st: "OK", text: "参数卡已生成，请在下面核对参数后提交" });
				break;
			case "error":
				if (/用户停止|abort/i.test(e.message || "")) {
					return;   // 用户自己停的：工具行已标「已停止」，不再重复
				}
				s.items.push({ k: "note", st: "ERROR", text: e.message || "运行出错" });
				break;
			default:
				return;
			}
			this._rtRenderSoon(sUid);
			this._rtInfo(s);
		},

		/** 改 / 建 / 删文件前：在时间线里就地确认，返回 Promise<{approved, always}> */
		_rtConfirm: function (sUid, req) {
			var that = this;
			var s = this._mRt && this._mRt[sUid];
			if (!s) {
				return Promise.resolve({ approved: false, message: "界面不支持确认" });
			}
			// 20261109（11.9 #02）：这个任务里选过「都不再询问」→ 后面每一轮的写和改都自动通过（删除照样问）
			if (req.action !== "删除" && this._rtHasWriteGrant(s.sid)) {
				s.items.push({ k: "note", st: "OK", text: "已按你的允许自动" + (req.action || "修改") + " " + (req.path || "") });
				this._rtRenderSoon(sUid);
				return Promise.resolve({ approved: true, always: true });
			}
			return new Promise(function (resolve) {
				var oIt = { k: "ask", req: req, done: null };
				s.items.push(oIt);
				// 删除只有「删除 / 不要」两项（「本次都不再询问」对删除不生效）
				s.ask = { item: oIt, resolve: resolve, n: req.action === "删除" ? 2 : 3 };
				that._rtRender(sUid);
				that._rtInfo(s);
				// 确认面板滚进视野（用户往上翻时不打扰：只在本来就在底部附近时跟随）
				if (that._isNearBottom && that._isNearBottom()) {
					that._scrollToBottom();
				}
			});
		},

		/**
		 * 模型问用户（ask_user）：在时间线里就地出问题卡，候选 + 「我直接说」，
		 * 返回 Promise<{answer} | {other: true} | {cancel: true}>
		 */
		_rtQuestion: function (sUid, req) {
			var that = this;
			var s = this._mRt && this._mRt[sUid];
			if (!s) {
				return Promise.resolve({ other: true });
			}
			return new Promise(function (resolve) {
				var oIt = { k: "q", question: req.question || "", options: (req.options || []).slice(0, 4), done: null };
				s.items.push(oIt);
				s.ask = { item: oIt, resolve: resolve, n: oIt.options.length + 1 };
				that._rtRender(sUid);
				that._rtInfo(s);
				if (that._isNearBottom && that._isNearBottom()) {
					that._scrollToBottom();
				}
			});
		},

		/** 收掉还开着的确认 / 问题（停止、运行结束时） */
		_rtCancelAsk: function (sUid) {
			var s = this._mRt && this._mRt[sUid];
			if (s && s.ask) {
				this._rtPick(sUid, s.ask.item.k === "q" ? -1 : 2);
			}
		},

		/**
		 * 选了一项。改文件确认：0 = 是，1 = 是且本次都不再询问，2 = 否；
		 * 问题卡：0..n-1 = 候选，n = 我直接说，-1 = 停止
		 */
		_rtPick: function (sUid, iOpt) {
			var s = this._mRt && this._mRt[sUid];
			if (!s || !s.ask) {
				return;
			}
			var a = s.ask;
			if (a.item.k === "q") {
				var aOpt = a.item.options;
				if (iOpt >= aOpt.length + 1) {
					return;
				}
				s.ask = null;
				a.item.done = iOpt < 0 ? { cancel: true } : (iOpt === aOpt.length ? { other: true } : { answer: aOpt[iOpt] });
				this._rtRender(sUid);
				this._rtInfo(s);
				a.resolve(a.item.done);
				return;
			}
			if (a.item.req && a.item.req.action === "删除" && iOpt === 1) {
				iOpt = 2;   // 删除卡第 2 项是「不要」
			}
			s.ask = null;
			if (iOpt === 1) {
				this._rtSetWriteGrant(s.sid);
			}
			a.item.done = iOpt === 2 ? "no" : (iOpt === 1 ? "all" : "yes");
			this._rtRender(sUid);
			this._rtInfo(s);
			a.resolve(iOpt === 2 ? { approved: false, message: "用户选择了不要改" } : { approved: true, always: iOpt === 1 });
		},

		/**
		 * 20261109（11.9 #02）：「写文件都不再询问」管整个任务（会话），不只一轮。
		 * 只记在本页内存：刷新页面、换了文件夹就失效，要重新确认。
		 */
		_rtSetWriteGrant: function (sSid) {
			var oF = BrowserAgentService.folderInfo() || {};
			this._mWriteGrant = this._mWriteGrant || {};
			this._mWriteGrant[sSid || ""] = String(oF.name || "");
		},

		_rtHasWriteGrant: function (sSid) {
			var m = this._mWriteGrant || {};
			if (!Object.prototype.hasOwnProperty.call(m, sSid || "")) {
				return false;
			}
			var oF = BrowserAgentService.folderInfo() || {};
			return m[sSid || ""] === String(oF.name || "");
		},

		/** 运行结束（成功 / 出错 / 停止） */
		_rtFinish: function (sUid, sStatus) {
			var s = this._mRt && this._mRt[sUid];
			if (!s) {
				return;
			}
			if (s.ask) {   // 停止时还开着的确认按「不要」、问题按「停止」收掉
				this._rtCancelAsk(sUid);
			}
			s.status = sStatus === "OK" ? "OK" : (sStatus === "STOPPED" ? "STOPPED" : "ERROR");
			s.items.forEach(function (x) {
				if (x.k === "tool" && x.st === "RUNNING") { x.st = s.status === "OK" ? "OK" : "STOPPED"; x.ms = Date.now() - x.t; }
			});
			// 最后给出回答的那一轮（SAP 直接回答的——如 Fiori 参数卡——没有调模型，不计）
			var bDet = !s.tool && !s.items.some(function (x) { return x.k === "say"; });
			// 选了「我直接说」：引擎直接收尾，没有最后那一轮模型
			bDet = bDet || s.items.some(function (x) { return x.k === "q" && x.done && x.done.other; });
			if (s.status === "OK" && !bDet) { s.model++; }
			s.ms = Date.now() - s.t0;
			s.collapsed = this._rtPrefCollapse();
			this._rtRender(sUid);
			this._rtInfo(s);
		},

		/* ---------------- 画 ---------------- */

		_rtRenderSoon: function (sUid) {
			var that = this;
			this._mRtPending = this._mRtPending || {};
			if (this._mRtPending[sUid]) {
				return;
			}
			this._mRtPending[sUid] = setTimeout(function () {
				delete that._mRtPending[sUid];
				that._rtRender(sUid);
			}, 60);
		},

		_rtRender: function (sUid) {
			var s = this._mRt && this._mRt[sUid];
			if (!s) {
				return;
			}
			var oHit = this._entryByUid(sUid, s.sid);
			if (!oHit) {
				return;
			}
			var sHtml = this._rtHtml(s);
			var oChat = this.getView().getModel("chat");
			var bShown = this._sMessagesSession === s.sid && (oChat.getProperty("/messages") || [])[oHit.index] === oHit.entry;
			var bNear = bShown && this._isNearBottom();
			if (oHit.entry.tlHtml === sHtml) {
				return;
			}
			if (bShown) {
				oChat.setProperty("/messages/" + oHit.index + "/tlHtml", sHtml);
			} else {
				oHit.entry.tlHtml = sHtml;
			}
			if (bNear && s.status === "RUNNING") {
				this._scrollToBottom();
			}
		},

		/** 整段过程 HTML。restore = 刷新后从精简记录画回来（没有返回全文、没有交互确认） */
		_rtHtml: function (s) {
			var that = this;
			var bRun = s.status === "RUNNING";
			var nSteps = s.items.filter(function (x) { return x.k === "tool"; }).length;
			var h = '<div class="rt' + (bRun ? " rtRunning" : "") + (s.collapsed ? " rtCollapsed" : "") + '" data-rtuid="' + esc(s.uid) + '">';
			if (!bRun) {
				var aMeta = nSteps ? [nSteps + " 步"] : [];
				if (s.ms) { aMeta.push(secs(s.ms)); }
				if (s.status === "STOPPED") { aMeta.push("已停止"); }
				if (s.status === "ERROR") { aMeta.push("出错"); }
				h += '<div class="rtHead" data-rt="fold" role="button" tabindex="0">' + IC.plan + "<span>过程</span>" +
					'<span class="rtSub">' + esc(aMeta.join(" · ")) + "</span>" + IC.chev + "</div>";
			}
			if (!s.collapsed || bRun) {
				h += '<div class="rtBody">';
				s.items.forEach(function (x, i) { h += that._rtItemHtml(s, x, i); });
				h += "</div>";
			}
			// 计划固定在最下面（紧挨状态行），过程再长也能看到进度
			if (s.plan && s.plan.length && (!s.collapsed || bRun)) {
				h += that._rtPlanHtml(s.plan);
			}
			if (bRun) {
				h += s.ask
					? '<div class="rtStatus rtWait">' + IC.hand + "<span>" + (s.ask.item.k === "q" ? "等你回答" : "等你确认") +
						" · 点选或按 " + Array.apply(null, { length: s.ask.n || 3 }).map(function (v, k) { return k + 1; }).join(" / ") + "</span></div>"
					: '<div class="rtStatus">' + IC.spin + '<span class="rtShim">' + esc(s.verb) + "…</span>" +
						'<span class="rtTimer" data-t0="' + s.t0 + '">' + Math.round((Date.now() - s.t0) / 1000) + " 秒</span>" +
						'<span class="rtHint">Esc 停止</span></div>';
			}
			return h + "</div>";
		},

		_rtPlanHtml: function (aPlan) {
			var nDone = aPlan.filter(function (t) { return t.st === "completed"; }).length;
			var h = '<div class="rtPlan"><div class="rtPlanHead">' + IC.plan + "<b>计划</b>" +
				'<span class="rtSub">' + nDone + " / " + aPlan.length + " 完成</span>" +
				'<span class="rtPlanBar"><i style="width:' + Math.round(nDone * 100 / aPlan.length) + '%"></i></span></div>';
			aPlan.forEach(function (t) {
				var c = t.st === "completed" ? "rtTodo rtTodoDone" : (t.st === "in_progress" ? "rtTodo rtTodoCur" : "rtTodo");
				h += '<div class="' + c + '"><span class="rtCk">' + (t.st === "completed" ? IC.ok : "") + "</span><span>" + esc(t.text) + "</span></div>";
			});
			return h + "</div>";
		},

		_rtItemHtml: function (s, x, i) {
			switch (x.k) {
			case "say":
				return '<div class="rtSay">' + esc(x.text) + "</div>";
			case "think":
				return '<div class="rtThink' + (x.open ? " rtOpen" : "") + '"><div class="rtThinkHead" data-rt="think" data-i="' + i + '" role="button" tabindex="0">' +
					IC.think + "<span>思考" + (x.ms ? " · " + esc(secs(x.ms)) : "") + "</span>" + (x.text ? IC.chev : "") + "</div>" +
					(x.open && x.text ? '<div class="rtThinkBody">' + esc(x.text) + "</div>" : "") + "</div>";
			case "skill":
				return '<div class="rtNote rtSkill">' + IC.skill + "<span>使用技能：" + esc(x.text) + "</span></div>";
			case "note":
				return '<div class="rtNote' + (x.st === "ERROR" ? " rtErr" : x.st === "OK" ? " rtOk" : "") + '">' +
					(x.st === "ERROR" ? IC.err : x.st === "OK" ? IC.ok : IC.note) + "<span>" + esc(x.text) + "</span></div>";
			case "card":
				return '<div class="rtNote">' + IC.note + "<span>参数卡已生成</span></div>";
			case "ask":
				return this._rtAskHtml(x);
			case "q":
				return this._rtQHtml(x);
			case "tool":
				return this._rtToolHtml(x, i);
			default:
				return "";
			}
		},

		_rtToolHtml: function (x, i) {
			var sIco = x.st === "RUNNING" ? IC.spin : x.st === "OK" ? IC.ok : x.st === "STOPPED" ? IC.stop : IC.err;
			var bDet = !!(x.args || x.preview);
			var h = '<div class="rtTool rtSt' + x.st + (x.open ? " rtOpen" : "") + '">' +
				'<div class="rtToolRow"' + (bDet ? ' data-rt="tool" data-i="' + i + '" role="button" tabindex="0"' : "") + ">" +
				'<span class="rtIco">' + sIco + "</span><b>" + esc(x.label || x.tool) + "</b>" +
				'<span class="rtArg">' + esc(x.arg) + "</span>" +
				'<span class="rtMs">' + esc(x.ms ? secs(x.ms) || (x.ms + " ms") : "") + "</span>" + (bDet ? IC.chev : "") + "</div>";
			if (x.sum) {
				h += '<div class="rtSum">' + esc(x.sum) + "</div>";
			} else if (x.st === "STOPPED") {
				h += '<div class="rtSum">已停止</div>';
			}
			if (x.ds) {
				h += this._rtDsHtml(x.ds);
			}
			if (x.open && bDet) {
				h += '<div class="rtDet">';
				if (x.args) {
					var sArgs = "";
					try { sArgs = JSON.stringify(x.args, null, 1); } catch (e) { sArgs = String(x.args); }
					h += '<div class="rtDetLabel">参数</div><pre>' + esc(sArgs.length > 2000 ? sArgs.slice(0, 2000) + "…" : sArgs) + "</pre>";
				}
				if (x.preview) {
					h += '<div class="rtDetLabel">返回</div><pre>' + esc(x.preview) + (x.preview.length >= 1000 ? "…" : "") + "</pre>";
				}
				h += "</div>";
			}
			return h + "</div>";
		},

		/** 数据预览：列名 + 前 3 行；完整表格（图表、导出、组合）在回答下方 */
		_rtDsHtml: function (ds) {
			var aPv = ds.preview || [];
			if (!aPv.length) {
				return ds.count ? '<div class="rtDsLink" data-rt="todata" role="button" tabindex="0">' + ds.count + " 张数据表 · 在回答下方查看</div>" : "";
			}
			var h = "";
			aPv.forEach(function (p) {
				h += '<div class="rtDs"><div class="rtDsHead"><b>' + esc(p.name || "数据") + "</b>" +
					(p.total != null ? '<span class="rtSub">' + esc(Number(p.total).toLocaleString("zh-CN")) + " 行</span>" : "") +
					'<span class="rtDsGo" data-rt="todata" role="button" tabindex="0">完整表格在回答下方</span></div>';
				if ((p.columns || []).length && (p.rows || []).length) {
					h += '<table class="rtDsTb"><tr>' + p.columns.map(function (c, k) {
						return "<th" + ((p.numeric || [])[k] ? ' class="rtNum"' : "") + ">" + esc(c) + "</th>";
					}).join("") + "</tr>" + p.rows.map(function (r) {
						return "<tr>" + p.columns.map(function (c, k) {
							var v = r[k];
							return "<td" + ((p.numeric || [])[k] ? ' class="rtNum"' : "") + ">" + esc(v == null ? "" : (typeof v === "number" ? v.toLocaleString("zh-CN") : v)) + "</td>";
						}).join("") + "</tr>";
					}).join("") + "</table>";
				}
				h += "</div>";
			});
			return h;
		},

		_rtAskHtml: function (x) {
			var req = x.req || {};
			if (x.done) {
				return x.done === "no"
					? '<div class="rtNote rtErr">' + IC.err + "<span>你拒绝了" + esc(req.action) + " " + esc(req.path) + "，没有改动文件</span></div>"
					: '<div class="rtNote rtOk">' + IC.ok + "<span>已同意" + esc(req.action) + " " + esc(req.path) +
						(x.done === "all" ? "（这个任务后面的写入不再询问）" : "") + "</span></div>";
			}
			var bMem = req.action === "整理记忆";   // 记忆超过上限，回答后合并重复规则（原文件会备份，可撤回）
			var sQ = bMem ? "记忆超过上限，用整理后的版本替换吗？" : req.action === "删除" ? "要删除这个文件吗？" : req.action === "新建" ? "要新建这个文件吗？" : "要" + (req.action || "修改") + "这个文件吗？";
			// [显示文字, 选项值]；选项值 0 = 是，1 = 是且本次都不再询问，2 = 不要。删除每次都问，没有第 2 项
			var aOpt = req.action === "删除"
				? [["删除", 0], ["不要，保留这个文件", 2]]
				: [["是，" + (req.action || "修改"), 0], ["是，这个任务里写文件都不再询问", 1], [bMem ? "不要，保持原样" : "不要，告诉灵犀怎么改", 2]];
			return '<div class="rtAsk"><div class="rtAskHead"><b>' + esc(sQ) + '</b><span class="rtSub">' + esc(req.path) + "</span></div>" +
				'<div class="rtAskDiff">' + (this._baDiffHtml ? this._baDiffHtml(req) : "") + "</div>" +
				aOpt.map(function (o, k) {
					return '<div class="rtOpt" data-rt="pick" data-v="' + o[1] + '" role="button" tabindex="0"><span class="rtKey">' + (k + 1) + "</span><span>" + esc(o[0]) + "</span></div>";
				}).join("") + "</div>";
		},

		_rtQHtml: function (x) {
			if (x.done) {
				if (x.done.cancel) {
					return '<div class="rtNote">' + IC.err + "<span>没有回答：" + esc(x.question) + "</span></div>";
				}
				return '<div class="rtNote rtOk">' + IC.ok + "<span>" + esc(x.question) + " → <b>" +
					esc(x.done.other ? "我直接说" : x.done.answer) + "</b></span></div>";
			}
			var aOpt = x.options.concat(["我直接说（在输入框里补充）"]);
			return '<div class="rtAsk rtQ"><div class="rtAskHead"><b>' + esc(x.question) + "</b>" +
				'<span class="rtSub">灵犀需要你确认一下再继续</span></div>' +
				aOpt.map(function (t, k) {
					return '<div class="rtOpt' + (k === aOpt.length - 1 ? " rtOptOther" : "") + '" data-rt="pick" data-v="' + k +
						'" role="button" tabindex="0"><span class="rtKey">' + (k + 1) + "</span><span>" + esc(t) + "</span></div>";
				}).join("") + "</div>";
		},

		/* ---------------- 输入框下的信息栏 ---------------- */

		_rtInfo: function (s) {
			var oChat = this.getView().getModel("chat");
			if (!oChat) {
				return;
			}
			var a = [];
			// 20261108：不再写「文件夹 xxx」—— 左边的文件夹胶囊已经显示了，重复
			if (s) {
				var ctx = (s.limits && s.limits.contextTokens) || 0;
				if (ctx && s.ctxUsed) {
					var pct = Math.min(100, Math.round(s.ctxUsed * 100 / ctx));
					a.push('<span>上下文 <i class="rtMeter"><b style="width:' + pct + '%"></b></i> ' + pct + "%</span>");
				}
				var mm = (s.limits && s.limits.maxModelCalls) || 0, mt = (s.limits && s.limits.maxToolCalls) || 0;
				a.push("<span>模型 " + s.model + (mm ? "/" + mm : "") + " · 工具 " + s.tool + (mt ? "/" + mt : "") + "</span>");
				if (s.plan && s.plan.length) {
					var nDone = s.plan.filter(function (t) { return t.st === "completed"; }).length;
					var cur = s.plan.filter(function (t) { return t.st === "in_progress"; })[0];
					a.push('<span class="rtInfoPlan">计划 ' + nDone + "/" + s.plan.length +
						(cur && s.status === "RUNNING" ? " · 正在：" + esc(cur.text) : "") + "</span>");
				}
				if (s.status === "RUNNING") {
					a.push('<span class="rtInfoRun">' + (s.ask ? (s.ask.item.k === "q" ? "等你回答" : "等你确认") : esc(s.verb) + "…") + "</span>");
				}
			}
			oChat.setProperty("/ba/infoHtml", a.length ? '<div class="rtInfo">' + a.join("") + "</div>" : "");
		},

		/* ---------------- 交互 ---------------- */

		_rtBind: function () {
			if (this._bRtBound) {
				return;
			}
			this._bRtBound = true;
			var that = this;
			document.addEventListener("click", function (ev) {
				var el = ev.target && ev.target.closest && ev.target.closest("[data-rt]");
				if (!el) {
					return;
				}
				var root = el.closest("[data-rtuid]");
				if (!root) {
					return;
				}
				that._rtAct(root.getAttribute("data-rtuid"), el.getAttribute("data-rt"), el);
			});
			document.addEventListener("keydown", function (ev) {
				var tgt = ev.target;
				var bTyping = tgt && (tgt.tagName === "TEXTAREA" || tgt.tagName === "INPUT" || tgt.isContentEditable);
				if (ev.key === "Enter" && tgt && tgt.getAttribute && tgt.getAttribute("data-rt")) {
					tgt.click();
					return;
				}
				var sUid = that._rtActiveUid();
				if (!sUid) {
					return;
				}
				var s = that._mRt[sUid];
				if (s.ask && !bTyping && /^[1-9]$/.test(ev.key) && Number(ev.key) <= (s.ask.n || 3)) {
					ev.preventDefault();
					that._rtPick(sUid, Number(ev.key) - 1);
				} else if (ev.key === "Escape" && s.status === "RUNNING" && !(sap.m.InstanceManager && sap.m.InstanceManager.hasOpenDialog &&
						sap.m.InstanceManager.hasOpenDialog())) {
					if (that.onStopGenerate) { that.onStopGenerate(); }
				}
			});
		},

		/** 当前会话里正在运行（或等确认）的那次新引擎运行 */
		_rtActiveUid: function () {
			var m = this._mRt || {};
			var sCur = this._sMessagesSession;
			return Object.keys(m).filter(function (k) { return m[k].status === "RUNNING" && m[k].sid === sCur; }).pop() || "";
		},

		_rtAct: function (sUid, sAct, el) {
			var s = this._mRt && this._mRt[sUid];
			if (sAct === "todata") {
				var oNode = document.querySelector('[data-rtuid="' + sUid + '"]');
				var oMsg = oNode && oNode.closest(".sapMLIB");
				var oTarget = oMsg && oMsg.querySelector(".analysisBlock");
				if (oTarget && oTarget.scrollIntoView) { oTarget.scrollIntoView({ behavior: "smooth", block: "start" }); }
				return;
			}
			if (!s) {
				return;
			}
			var i = Number(el.getAttribute("data-i"));
			if (sAct === "fold") {
				s.collapsed = !s.collapsed;
				this._rtPrefCollapse(s.collapsed);
			} else if (sAct === "tool" || sAct === "think") {
				if (s.items[i]) { s.items[i].open = !s.items[i].open; }
			} else if (sAct === "pick") {
				this._rtPick(sUid, Number(el.getAttribute("data-v")));
				return;
			} else {
				return;
			}
			this._rtRender(sUid);
		},

		/** 计时：只改 DOM 里的秒数，不整段重画 */
		_rtTicker: function () {
			if (this._iRtTick) {
				return;
			}
			this._iRtTick = setInterval(function () {
				var a = document.querySelectorAll(".rtRunning .rtTimer");
				if (!a.length) {
					return;
				}
				Array.prototype.forEach.call(a, function (el) {
					el.textContent = Math.round((Date.now() - Number(el.getAttribute("data-t0"))) / 1000) + " 秒";
				});
			}, 1000);
		},

		/** 已完成的过程默认收起？（点过「过程」标题就记住，按本机） */
		_rtPrefCollapse: function (bSet) {
			try {
				if (bSet !== undefined) {
					window.localStorage.setItem("lingxi-rt-collapse", bSet ? "1" : "0");
					return bSet;
				}
				return window.localStorage.getItem("lingxi-rt-collapse") === "1";
			} catch (e) {
				return false;
			}
		},

		/* ---------------- 刷新 / 重开会话后画回来 ---------------- */

		/**
		 * 打开会话（含刷新页面后）：取回这个会话里新引擎各轮的过程记录，画到对应的回复上方。
		 * 对应关系：SAP 按消息序号（MsgSeq）；演示模式按回答开头。SAP 还没部署 /run/steps 时什么都不做。
		 */
		_rtRestore: function (sSid, oState, fnAuth) {
			var that = this;
			if (!oState || !BrowserAgentService.available()) {
				return Promise.resolve();
			}
			return BrowserAgentService.getSteps(sSid, { authHeader: fnAuth }).then(function (aRuns) {
				if (!aRuns.length || !that._mSessionMessages || that._mSessionMessages[sSid] !== oState) {
					return;
				}
				var aAi = oState.messages.filter(function (e) { return e.role === "assistant" && !e.tlHtml; });
				var mUsed = {};
				var nHit = 0;
				aRuns.forEach(function (r) {
					var iSeq = Number(r.msgSeq) || 0;
					var oE = iSeq ? aAi.filter(function (e) { return e.msgSeq === iSeq && !mUsed[e.uid]; })[0] : null;
					if (!oE && r.answerHead) {
						oE = aAi.filter(function (e) { return !mUsed[e.uid] && String(e.raw || "").indexOf(r.answerHead) === 0; })[0];
					}
					if (!oE || !(r.steps || []).length) {
						return;
					}
					mUsed[oE.uid] = true;
					oE.tl = true;
					oE.tlHtml = that._rtFromSteps(oE.uid, r.steps, sSid);
					nHit++;
				});
				if (nHit && that._sMessagesSession === sSid) {
					that.getView().getModel("chat").setProperty("/messages", oState.messages.slice());
				}
			});
		},

		/** 精简过程记录（引擎 compactSteps）→ 已完成的时间线 HTML */
		_rtFromSteps: function (sUid, aSteps, sSid) {
			var s = { uid: sUid, sid: sSid || "", items: [], plan: null, status: "OK", ms: 0, collapsed: this._rtPrefCollapse() };
			(aSteps || []).forEach(function (x) {
				switch (x.k) {
				case "say": s.items.push({ k: "say", text: x.text }); break;
				case "think": s.items.push({ k: "think", text: "", ms: x.ms }); break;
				case "plan":
					try { s.plan = JSON.parse(x.text || "[]").map(function (t) { return { text: t[0], st: t[1] }; }); } catch (e) { s.plan = null; }
					break;
				case "tool":
					s.items.push({ k: "tool", tool: x.tool, label: BrowserAgentService.toolLabel(x.tool), arg: x.arg || "", st: x.st || "OK",
						sum: x.sum || "", ms: x.ms || 0, ds: x.dn ? { index: x.ds, count: x.dn, preview: [] } : null });
					s.ms += x.ms || 0;
					break;
				case "skill": s.items.push({ k: "skill", text: x.text }); break;
				case "note": s.items.push({ k: "note", st: x.st, text: x.text }); break;
				case "card": s.items.push({ k: "card" }); break;
				default: break;
				}
			});
			this._mRt = this._mRt || {};
			this._mRt[sUid] = s;   // 让「过程」标题、展开等交互可用
			this._rtBind();
			return this._rtHtml(s);
		}
	};
});
