sap.ui.define([], function () {
	"use strict";

	/**
	 * =====================================================================
	 * 浏览器 Agent 演示后端（演示模式 / 后端不可用时）
	 * =====================================================================
	 * 在浏览器里冒充 SAP 的 /sap/bc/zai_agent：运行号、工具清单、工具执行，
	 * 以及一个固定剧本的"模型"（OpenAI 兼容响应，交给引擎里真正的 Deep Agents 跑）。
	 * 用来不连 SAP / 模型时体验和自测：列计划 → 看文件夹 → 读文件 →（问题里有"写/改/汇总"时）写汇总 → 回答。
	 * 不发任何网络请求。
	 * =====================================================================
	 */

	var ROOT = "/__lingxi_mock_agent";

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

	function scriptFolder(aMsgs, sQ) {
		var iStep = aMsgs.filter(function (m) { return m.role === "assistant"; }).length;
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

	function scriptNoFolder(aMsgs, sQ) {
		var iStep = aMsgs.filter(function (m) { return m.role === "assistant"; }).length;
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

	function answer(aMsgs, sQ, bFolder) {
		var aTool = aMsgs.filter(function (m) { return m.role === "tool"; }).map(textOf);
		var aLines = ["（演示模式：没有连接 SAP 和模型，下面是固定剧本的结果，用来看浏览器 Agent 的流程。）", ""];
		if (bFolder) {
			var sLs = aTool.filter(function (t) { return /\(directory\)|bytes\)/.test(t); })[0] || "";
			var n = sLs ? sLs.split("\n").filter(function (l) { return /bytes\)/.test(l); }).length : 0;
			aLines.push("- 你选的文件夹里有 **" + n + "** 个文件。");
			var sRead = aTool.filter(function (t) { return /^@@ lines/.test(t); })[0];
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

	return {
		ROOT: ROOT,

		createClient: function (oOpt) {
			var o = oOpt || {};
			var sQuestion = "";
			var root = window.location.origin + ROOT;
			var fnResp = function (oBody) {
				return Promise.resolve(new Response(JSON.stringify(oBody), { status: 200, headers: { "Content-Type": "application/json" } }));
			};
			var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
			return {
				root: root,
				startRun: function (p) {
					sQuestion = (p && p.question) || "";
					return wait(200).then(function () {
						return {
							runId: "MOCK" + Date.now().toString(36),
							model: "演示模型",
							tools: [{
								name: "search_tables",
								description: "按关键字搜索 SAP 表（表名与描述）",
								parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] }
							}],
							limits: { recursionLimit: 60 },
							systemPrompt: "场景：" + (o.scene || "AUTO") + "（演示）"
						};
					});
				},
				execTool: function (p) {
					return wait(500).then(function () {
						if (p.tool !== "search_tables") {
							return { ok: false, message: "演示后端没有这个工具：" + p.tool };
						}
						return { ok: true, content: JSON.stringify({ rows: [{ TABNAME: "AFKO", DDTEXT: "订单表头" }, { TABNAME: "AFPO", DDTEXT: "订单项目" }], total: 2 }) };
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
						var calls;
						var sText = "";
						if (/^子任务/.test(sFirst)) {
							sText = "子任务完成（演示）";
						} else {
							calls = o.folder ? scriptFolder(aMsgs, sQuestion) : scriptNoFolder(aMsgs, sQuestion);
							if (!calls) {
								sText = answer(aMsgs, sQuestion, o.folder);
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
