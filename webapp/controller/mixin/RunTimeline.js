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
	 *   → 结果行（一句话）→ 可展开的数据预览 → 就地确认面板（1 / 2 / 3）
	 * 计划清单与状态行固定在过程最下面：后面不管输出多少说明和步骤，都能一眼看到进度。
	 * 输入区显示上下文圆环、调用次数和运行状态。
	 * 一次运行的状态在 this._mRt[uid]；画成 HTML 写进消息条目的 tlHtml（同 liveHtml / extraHtml 的做法）。
	 * 所有动态文字先转义，标签由本文件构造。原引擎不经过这里。方法名统一 _rt 前缀。
	 * 20261117（11.17 记录 #01）：
	 *   ① _rtEvent / _rtFinish 记 hasModel，修复纯文字回复（无工具/无 say）误判为确定性导致模型次数停在 0 的问题
	 *   ② _rtInfo 增加 _rtSessionTotals 同会话累计口径：多轮时显示单轮配额与累计调用次数
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

	function tokens(n) {
		if (n < 1000) { return String(n); }
		var iUnit = n >= 1000000 ? 1000000 : 1000;
		return Math.round(n / iUnit * 10) / 10 + (iUnit === 1000 ? "k" : "M");
	}

	function isRoutineFileStep(x) {
		return x.k === "tool" && !x.ds && (x.st === "OK" || x.st === "RUNNING") &&
			["ls", "read_file", "glob", "grep"].indexOf(x.tool) !== -1;
	}

	return {

		/* ---------------- 运行中 ---------------- */

		/** 开始一次新引擎运行：建状态、挂交互，返回状态对象 */
		_rtStart: function (sUid, sSid) {
			this._rtBind();
			this._mRt = this._mRt || {};
			var s = this._mRt[sUid] = {
				uid: sUid, sid: sSid, folder: BrowserAgentService.grantedFolder(), items: [], byId: {}, plan: null, status: "RUNNING", verb: "理解问题",
				t0: Date.now(), model: 0, tool: 0, hasModel: false, lastWasTool: false, limits: {}, ask: null, collapsed: false
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
			case "cancel_asks":
				this._rtCancelAsk(sUid);
				return;
			case "save_failed":
				s.saveFailed = true;
				s.items.push({ k: "note", st: "ERROR", text: e.message });
				break;
			case "run":
				s.limits = e.limits || {};
				break;
			case "say":
				// 说明和同一轮的工具调用是一次模型回应：这里先记一次，紧跟的工具不再重复计
				s.items.push({ k: "say", text: e.text });
				s.hasModel = true;
				s.model++;
				s.lastWasTool = true;
				break;
			case "think":
				s.hasModel = true;
				s.items.push({ k: "think", text: e.text, ms: e.ms || 0, open: false });
				break;
			case "usage":
				s.hasModel = true;
				var oState = this._mSessionMessages && this._mSessionMessages[s.sid];
				var iLimit = e.ctx || s.limits.contextTokens;
				if (oState && e.input > 0 && iLimit > 0) { oState.rtContext = { input: e.input, limit: iLimit }; }
				break;
			case "answer":
				// 20261117（11.17 #01）：纯文字回复没有 say/tool_start，靠 answer 标明确实调过模型
				s.hasModel = true;
				return;
			case "todos":
				s.plan = (e.todos || []).map(function (t) { return { text: t.content, st: t.status }; });
				break;
			case "tool_start":
				s.hasModel = true;
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
				s.items.push({ k: "skill", text: e.name + (e.source === "FOLDER" ? "（文件夹）" : e.source === "BUILTIN" ? "（内置）" : "") });
				break;
			case "compacted":
				s.items.push({ k: "note", text: e.scope === "chat" ? "已压缩较早的聊天记录" :
					"对话较长，已自动压缩（早期内容总结成一段，原文留在本次运行的草稿里）" });
				break;
			case "card":
				s.items.forEach(function (x) { if (x.k === "tool" && x.st === "RUNNING") { x.st = "OK"; x.ms = Date.now() - x.t; } });
				s.items.push({ k: "note", st: "OK", text: "参数卡已生成，请在下面核对参数后提交" });
				break;
			case "loop_stop":   // 20261110（11.10 #04）：同一步原样失败多次，引擎已停
				s.items.push({ k: "note", st: "ERROR", text: e.reason === "same"
					? "同一步用同样的条件失败了 " + e.count + " 次，已停止，不再原样重试"
					: "连续 " + e.count + " 步失败，已停止" });
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
			if (!s || s.status !== "RUNNING" || s.asksClosed) {
				return Promise.resolve({ approved: false, message: "运行已结束或确认不可用" });
			}
			// 20261109（11.9 #02）：这个任务里选过「都不再询问」→ 后面每一轮的写和改都自动通过（删除照样问）
			if (req.action !== "删除" && this._rtHasWriteGrant(s)) {
				s.items.push({ k: "note", st: "OK", text: "已按你的允许自动" + (req.action || "修改") + " " + (req.path || "") });
				this._rtRenderSoon(sUid);
				return Promise.resolve({ approved: true, always: true });
			}
			return new Promise(function (resolve) {
				var oIt = { k: "ask", req: req, done: null };
				s.items.push(oIt);
				// 删除只有「删除 / 不要」两项（「本次都不再询问」对删除不生效）
				that._rtOpenAsk(s, { item: oIt, resolve: resolve, n: req.action === "删除" ? 2 : 3 });
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
			if (!s || s.status !== "RUNNING" || s.asksClosed) {
				return Promise.resolve({ cancel: true });
			}
			return new Promise(function (resolve) {
				var oIt = { k: "q", question: req.question || "", options: (req.options || []).slice(0, 4), done: null };
				s.items.push(oIt);
				that._rtOpenAsk(s, { item: oIt, resolve: resolve, n: oIt.options.length + 1 });
				that._rtRender(sUid);
				that._rtInfo(s);
				if (that._isNearBottom && that._isNearBottom()) {
					that._scrollToBottom();
				}
			});
		},

		/**
		 * 11.11 #02：模型一次改两个文件时两张确认卡会同时来。只让一张可点，其余排队（卡上写「等上一项确认」），
		 * 点完一张再亮下一张；以前第二张会顶掉第一张，点第一张实际答的是第二张，第一张永远挂着。
		 */
		_rtOpenAsk: function (s, oAsk) {
			if (s.ask) {
				oAsk.item.queued = true;
				(s.askQ = s.askQ || []).push(oAsk);
			} else {
				s.ask = oAsk;
			}
		},

		/** 当前这张答完后亮下一张；选过「都不再询问」时排队中的写和改直接通过（删除照样问） */
		_rtNextAsk: function (s) {
			var q = s.askQ || [];
			while (!s.ask && q.length) {
				var a = q.shift();
				a.item.queued = false;
				if (a.item.k === "ask" && a.item.req && a.item.req.action !== "删除" && this._rtHasWriteGrant(s)) {
					a.item.done = "auto";
					a.resolve({ approved: true, always: true });
				} else {
					s.ask = a;
				}
			}
		},

		/** 收掉还开着和排队中的确认 / 问题（停止、运行结束时） */
		_rtCancelAsk: function (sUid) {
			var s = this._mRt && this._mRt[sUid];
			if (!s) { return; }
			s.asksClosed = true;
			if (!s.ask && !(s.askQ || []).length) { return; }
			var aAsks = s.ask ? [s.ask].concat(s.askQ || []) : (s.askQ || []);
			s.ask = null;
			s.askQ = [];
			aAsks.forEach(function (a) {
				a.item.queued = false;
				var bQuestion = a.item.k === "q";
				a.item.done = bQuestion ? { cancel: true } : "cancelled";
				a.resolve(bQuestion ? a.item.done : { approved: false, message: "运行已结束，确认已取消" });
			});
			this._rtRender(sUid);
			this._rtInfo(s);
		},

		/**
		 * 选了一项。改文件确认：0 = 是，1 = 是且本次都不再询问，2 = 否；
		 * 问题卡：0..n-1 = 候选，n = 我直接说，-1 = 停止
		 */
		_rtPick: function (sUid, iOpt, iItem) {
			var s = this._mRt && this._mRt[sUid];
			if (!s || !s.ask || s.status !== "RUNNING" || s.asksClosed ||
				(iItem !== undefined && s.items[iItem] !== s.ask.item) || !Number.isInteger(iOpt)) {
				return;
			}
			var a = s.ask;
			if (a.item.k === "q") {
				var aOpt = a.item.options;
				if (iOpt < 0 || iOpt > aOpt.length) {
					return;
				}
				s.ask = null;
				a.item.done = iOpt === aOpt.length ? { other: true } : { answer: aOpt[iOpt] };
				a.resolve(a.item.done);
				if (a.item.done.other) {
					this._rtCancelAsk(sUid);
				} else {
					this._rtNextAsk(s);
				}
				this._rtRender(sUid);
				this._rtInfo(s);
				return;
			}
			if (iOpt < 0 || iOpt > 2) { return; }
			if (a.item.req && a.item.req.action === "删除" && iOpt === 1) {
				iOpt = 2;   // 删除卡第 2 项是「不要」
			}
			s.ask = null;
			if (iOpt === 1) {
				this._rtSetWriteGrant(s);
			}
			a.item.done = iOpt === 2 ? "no" : (iOpt === 1 ? "all" : "yes");
			this._rtNextAsk(s);
			this._rtRender(sUid);
			this._rtInfo(s);
			a.resolve(iOpt === 2 ? { approved: false, message: "用户选择了不要改" } : { approved: true, always: iOpt === 1 });
		},

		/**
		 * 20261109（11.9 #02）：「写文件都不再询问」管整个任务（会话），不只一轮。
		 * 只记在本页内存：刷新页面、换了文件夹就失效，要重新确认。
		 */
		_rtSetWriteGrant: function (s) {
			if (!s.folder) { return; }
			this._mWriteGrant = this._mWriteGrant || {};
			this._mWriteGrant[s.sid || ""] = s.folder;
		},

		_rtHasWriteGrant: function (s) {
			return !!(s.folder && this._mWriteGrant && this._mWriteGrant[s.sid || ""] === s.folder);
		},

		/** 运行结束（成功 / 出错 / 停止） */
		_rtFinish: function (sUid, sStatus) {
			var s = this._mRt && this._mRt[sUid];
			if (!s) {
				return;
			}
			s.status = sStatus === "OK" ? "OK" : (sStatus === "STOPPED" ? "STOPPED" : "ERROR");
			this._rtCancelAsk(sUid);
			if (s.status !== "OK" && this._mWriteGrant) { delete this._mWriteGrant[s.sid || ""]; }
			s.items.forEach(function (x) {
				if (x.k === "tool" && x.st === "RUNNING") { x.st = s.status === "OK" ? "OK" : "STOPPED"; x.ms = Date.now() - x.t; }
			});
			// 20261117（11.17 #01）：最后给出回答的那一轮（SAP 直接回答的——如 Fiori 参数卡——没有调模型事件，不计；
			// 纯文字回复虽然没调工具也没有 say，但已有 answer/usage/think 事件，要计入 1 次模型调用）
			var bAskOther = s.items.some(function (x) { return x.k === "q" && x.done && x.done.other; });
			var bDet = !s.hasModel && !s.tool && !s.items.some(function (x) { return x.k === "say"; });
			if (s.status === "OK" && !bDet && !bAskOther) { s.model++; }
			s.ms = Date.now() - s.t0;
			s.collapsed = !s.saveFailed && this._rtPrefCollapse();
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
				for (var i = 0; i < s.items.length;) {
					if (!isRoutineFileStep(s.items[i])) {
						h += this._rtItemHtml(s, s.items[i], i++);
						continue;
					}
					var end = i + 1;
					while (end < s.items.length && isRoutineFileStep(s.items[end])) { end++; }
					h += this._rtFileStepsHtml(s, i, end);
					i = end;
				}
				h += "</div>";
			}
			// 计划固定在最下面（紧挨状态行），过程再长也能看到进度
			if (s.plan && s.plan.length && (!s.collapsed || bRun)) {
				h += this._rtPlanHtml(s.plan);
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

		_rtFileStepsHtml: function (s, i, end) {
			var aSteps = s.items.slice(i, end);
			var aLabels = Array.from(new Set(aSteps.map(function (x) { return x.label || x.tool; })));
			var bOpen = !!(s.openFileSteps && s.openFileSteps[i]);
			var bWorking = aSteps.some(function (x) { return x.st === "RUNNING"; });
			var sCaption = aSteps.length === 1 ? aSteps[0].arg : aSteps.length + " 步";
			var h = '<div class="rtFileSteps"><button type="button" class="rtFileStepsButton" data-rt="file-steps" data-i="' + i +
				'" aria-expanded="' + bOpen + '">' + (bWorking ? IC.spin : "") +
				"<span>" + esc(aLabels.join("、")) + "</span>" +
				(sCaption ? '<span class="rtFileStepsCaption">' + esc(sCaption) + '</span>' : '') + IC.chev + "</button>";
			if (bOpen) {
				h += '<div class="rtFileStepsBody">';
				for (var j = i; j < end; j++) { h += this._rtToolHtml(s.items[j], j); }
				h += "</div>";
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
				return this._rtAskHtml(x, i);
			case "q":
				return this._rtQHtml(x, i);
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
				h += this._rtDsHtml(x.ds, i);
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

		/** 工具数据默认收起，展开后只显示列名与样例行 */
		_rtDsHtml: function (ds, i) {
			var aPv = ds.preview || [];
			if (!aPv.length) {
				return ds.count ? '<div class="rtDsSummary">返回 ' + esc(ds.count) + " 张数据表</div>" : "";
			}
			var sLabel = aPv.length === 1 && aPv[0].total != null
				? "数据预览 · " + Number(aPv[0].total).toLocaleString("zh-CN") + " 行"
				: aPv.length + " 张数据表";
			var h = '<button type="button" class="rtDsSummary' + (ds.open ? ' rtOpen' : '') + '" data-rt="datasets" data-i="' + i +
				'" aria-expanded="' + !!ds.open + '">' + IC.chev + "<span>" + esc(sLabel) + "</span></button>";
			if (!ds.open) {
				return h;
			}
			aPv.forEach(function (p) {
				h += '<div class="rtDs"><div class="rtDsHead"><b>' + esc(p.name || "数据") + "</b>" +
					(p.total != null ? '<span class="rtSub">' + esc(Number(p.total).toLocaleString("zh-CN")) + " 行</span>" : "") +
					'<span class="rtSub rtDsSample">样例</span></div>';
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

		_rtAskHtml: function (x, i) {
			var req = x.req || {};
			if (x.done === "cancelled") {
				return '<div class="rtNote">' + IC.stop + "<span>确认已取消：" + esc(req.path) + "</span></div>";
			}
			if (x.done) {
				return x.done === "no"
					? '<div class="rtNote rtErr">' + IC.err + "<span>你拒绝了" + esc(req.action) + " " + esc(req.path) + "，没有改动文件</span></div>"
					: '<div class="rtNote rtOk">' + IC.ok + "<span>" + (x.done === "auto" ? "已按你的允许自动" : "已同意") + esc(req.action) + " " + esc(req.path) +
						(x.done === "all" ? "（这个任务后面的写入不再询问）" : "") + "</span></div>";
			}
			if (x.queued) {   // 11.11 #02：排队中，等上一张确认完再亮
				return '<div class="rtAsk rtAskQueued"><div class="rtAskHead"><b>' + esc("要" + (req.action || "修改") + "这个文件吗？") +
					'</b><span class="rtSub">' + esc(req.path) + " · 等上一项确认后再处理</span></div></div>";
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
					return '<div class="rtOpt" data-rt="pick" data-i="' + i + '" data-v="' + o[1] + '" role="button" tabindex="0"><span class="rtKey">' + (k + 1) + "</span><span>" + esc(o[0]) + "</span></div>";
				}).join("") + "</div>";
		},

		_rtQHtml: function (x, i) {
			if (x.queued && !x.done) {
				return '<div class="rtAsk rtQ rtAskQueued"><div class="rtAskHead"><b>' + esc(x.question) + "</b>" +
					'<span class="rtSub">等上一项确认后再回答</span></div></div>';
			}
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
					return '<div class="rtOpt' + (k === aOpt.length - 1 ? " rtOptOther" : "") + '" data-rt="pick" data-i="' + i + '" data-v="' + k +
						'" role="button" tabindex="0"><span class="rtKey">' + (k + 1) + "</span><span>" + esc(t) + "</span></div>";
				}).join("") + "</div>";
		},

		/* ---------------- 输入框下的信息栏 ---------------- */

		/** 20261117（11.17 #01）：统计本页面生命周期内同一会话的模型 / 工具累计次数 */
		_rtSessionTotals: function (sSid) {
			var m = this._mRt || {}, iModel = 0, iTool = 0, iRuns = 0;
			Object.keys(m).forEach(function (k) {
				var x = m[k];
				if (x && x.sid === sSid && x.t0) {
					iRuns++;
					iModel += x.model || 0;
					iTool += x.tool || 0;
				}
			});
			return { runs: iRuns, model: iModel, tool: iTool };
		},

		_rtInfo: function (s) {
			var oChat = this.getView().getModel("chat");
			if (!oChat) {
				return;
			}
			// 20261109：只显示正在看的会话的运行（别的会话后台在跑时不覆盖底栏）
			if (s && s.sid && this._sMessagesSession && s.sid !== this._sMessagesSession) {
				return;
			}
			this._rtContextInfo(s);
			var sInfo = "";
			if (s && s.status === "RUNNING") {
				var sStatus = s.ask ? (s.ask.item.k === "q" ? "等你回答" : "等你确认") : esc(s.verb) + "…";
				sInfo = '<div class="rtInfo"><span class="rtInfoRun">' + sStatus + "</span></div>";
			}
			oChat.setProperty("/ba/infoHtml", sInfo);
		},

		_rtContextInfo: function (oRun) {
			var sSid = this._sMessagesSession;
			var oState = sSid && this._mSessionMessages && this._mSessionMessages[sSid];
			var oUsage = oState && oState.rtContext;
			var iUsed = Number(oUsage && oUsage.input);
			var iLimit = Number(oUsage && oUsage.limit);
			var bKnown = Number.isFinite(iUsed) && iUsed > 0 && Number.isFinite(iLimit) && iLimit > 0;
			var nPct = bKnown ? Math.min(100, iUsed * 100 / iLimit) : 0;
			var iPct = Math.round(nPct);
			var sDetails = bKnown
				? '<span>' + iPct + '% 已用（剩余 ' + (100 - iPct) + '%）</span><span>已用 ' +
					tokens(iUsed) + ' token，共 ' + tokens(iLimit) + '</span>'
				: '<span>暂无上下文用量</span>';
			if (oRun === undefined && sSid) {
				var mRt = this._mRt || {};
				oRun = mRt[this._rtActiveUid()] || Object.values(mRt).filter(function (x) {
					return x.sid === sSid && x.t0;
				}).pop();
			}
			var sCalls = "";
			if (oRun && oRun.sid === sSid) {
				var oLimits = oRun.limits || {};
				sCalls = esc("模型 " + oRun.model + (oLimits.maxModelCalls ? "/" + oLimits.maxModelCalls : "") +
					" · 工具 " + oRun.tool + (oLimits.maxToolCalls ? "/" + oLimits.maxToolCalls : ""));
				var oTotals = this._rtSessionTotals(sSid);
				sDetails += '<span class="rtContextCallDetails">' + sCalls + '</span>';
				if (oTotals.runs > 1) {
					sDetails += '<span class="rtContextTotal">会话累计 模型 ' + oTotals.model + ' · 工具 ' + oTotals.tool + '</span>';
				}
			}
			var sHtml = sSid ? '<div class="rtContext">' +
				'<button type="button" class="rtContextButton" aria-label="上下文窗口" aria-describedby="rtContextTip">' +
				'<i class="rtContextRing" style="--rt-context-fill:' + nPct + '%" aria-hidden="true"></i></button>' +
				(sCalls ? '<span class="rtContextCalls">' + sCalls + '</span>' : '') +
				'<div class="rtContextTip" id="rtContextTip" role="tooltip"><span class="rtContextTitle">上下文窗口</span>' +
				sDetails + '</div></div>' : "";
			this.getView().getModel("chat").setProperty("/ba/contextHtml", sHtml);
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
				if (ev.key === "Enter" && tgt && tgt.tagName !== "BUTTON" && tgt.getAttribute && tgt.getAttribute("data-rt")) {
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
			if (!s) {
				return;
			}
			var i = Number(el.getAttribute("data-i"));
			if (sAct === "fold") {
				s.collapsed = !s.collapsed;
				this._rtPrefCollapse(s.collapsed);
			} else if (sAct === "file-steps" && s.items[i] && isRoutineFileStep(s.items[i])) {
				s.openFileSteps = s.openFileSteps || {};
				s.openFileSteps[i] = !s.openFileSteps[i];
			} else if (sAct === "tool" || sAct === "think") {
				if (s.items[i]) { s.items[i].open = !s.items[i].open; }
			} else if (sAct === "datasets") {
				var oDs = s.items[i] && s.items[i].ds;
				if (oDs) { oDs.open = !oDs.open; }
			} else if (sAct === "pick") {
				this._rtPick(sUid, Number(el.getAttribute("data-v")), i);
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
			return BrowserAgentService.getSteps(sSid, { authHeader: fnAuth }).then(function (oHistory) {
				if (!that._mSessionMessages || that._mSessionMessages[sSid] !== oState) {
					return;
				}
				if (!oState.rtContext && oHistory.contextUsage) {
					oState.rtContext = oHistory.contextUsage;
					if (that._sMessagesSession === sSid) { that._rtContextInfo(); }
				}
				var aRuns = oHistory.runs;
				var aAi = oState.messages.filter(function (e) { return e.role === "assistant" && !e.tlHtml; });
				var mUsed = {};
				var nHit = 0;
				aRuns.forEach(function (r) {
					var iSeq = Number(r.msgSeq) || 0;
					var aMatches = iSeq ? aAi.filter(function (e) { return e.msgSeq === iSeq; }) : [];
					// 20261111（11.11 #04 串台）：有消息序号却没对上时不再按回答开头猜 —— 两轮回答开头一样
					//（同样的问候语、都以「（浏览器 Agent 未完成」开头）会把这轮的过程画到别的回复上
					if (!iSeq && r.answerHead && aRuns.filter(function (x) { return x.answerHead === r.answerHead; }).length === 1) {
						aMatches = aAi.filter(function (e) { return String(e.raw || "").indexOf(r.answerHead) === 0; });
					}
					var oE = aMatches.length === 1 ? aMatches[0] : null;
					if (!oE || mUsed[oE.uid] || !(r.steps || []).length) {
						return;
					}
					mUsed[oE.uid] = true;
					oE.tl = true;
					oE.tlHtml = that._rtFromSteps(oE.uid, r.steps, sSid, r.status, oE.raw);
					nHit++;
				});
				if (nHit && that._sMessagesSession === sSid) {
					that.getView().getModel("chat").setProperty("/messages", oState.messages.slice());
				}
			});
		},

		/** 精简过程记录（引擎 compactSteps）→ 已完成的时间线 HTML */
		_rtFromSteps: function (sUid, aSteps, sSid, sRunStatus, sAnswer) {
			var sStatus = sRunStatus === "CANCELLED" || /^（已停止|^（未完成：你停止/.test(sAnswer || "") ? "STOPPED"
				: sRunStatus === "ERROR" || /^（(?:浏览器 Agent )?未完成/.test(sAnswer || "") ? "ERROR" : "OK";
			var s = { uid: sUid, sid: sSid || "", items: [], plan: null, status: sStatus, ms: 0, collapsed: this._rtPrefCollapse() };
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
