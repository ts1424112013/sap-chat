sap.ui.define([], function () {
	"use strict";

	/**
	 * 20261108：模型系列图标 —— 按模型名 / ID / 接口地址判断属于哪个系列，返回 css/style-models.css 里的 data-logo 键。
	 * 按「模型」认，不按「部署方式」认：本地 Ollama 跑的 Qwen 显示千问图标；认不出系列、但是 Ollama 部署的显示 Ollama 图标；
	 * 都认不出显示灵犀的星芒（lynx）。
	 */
	var RULES = [
		["deepseek", /deepseek/i],
		["qwen", /qwen|qwq|通义|千问|tongyi|dashscope/i],
		["claude", /claude|anthropic/i],
		["openai", /\bgpt|chatgpt|openai|\bo[134](-|\b)/i],
		["gemini", /gemini|gemma/i],
		["zhipu", /\bglm|chatglm|zhipu|智谱|bigmodel/i],
		["kimi", /kimi|moonshot/i],
		["doubao", /doubao|豆包|volces|ark\./i],
		["meta", /llama/i],
		["wenxin", /ernie|wenxin|文心|qianfan/i],
		["hunyuan", /hunyuan|混元/i],
		["minimax", /minimax|abab/i]
	];

	return {
		/** @param {object} m 模型配置（ModelId / ModelName / ModelDesc / ModelType / EndpointUrl / ApiModel） */
		family: function (m) {
			if (!m) {
				return "lynx";
			}
			// 名字最能代表模型，先看名字和 ID，再看接口里的模型名 / 地址
			var aSrc = [m.ModelName, m.ModelId, m.ApiModel, m.ModelDesc, m.EndpointUrl].map(function (s) { return String(s || ""); });
			for (var i = 0; i < aSrc.length; i++) {
				for (var j = 0; j < RULES.length; j++) {
					if (aSrc[i] && RULES[j][1].test(aSrc[i])) {
						return RULES[j][0];
					}
				}
			}
			return /ollama/i.test(aSrc.join(" ") + " " + (m.ModelType || "")) ? "ollama" : "lynx";
		}
	};
});
