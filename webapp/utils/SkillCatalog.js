/* Shared by UI5, the demo backend and the local Agent verifier. */
(function (factory) {
    if (typeof sap !== "undefined" && sap.ui && sap.ui.define) { sap.ui.define([], factory); }
    else if (typeof module === "object") { module.exports = factory(); }
}(function () {
    "use strict";
    var SCENE_TOOLS = {
        CODE: ["read_program_source", "describe_table"],
        DATA: ["sap_data_analysis", "search_tables", "describe_table", "run_sql"],
        REPORT: [], FIORI: []
    };
    function csv(v) {
        return (Array.isArray(v) ? v : String(v || "").split(","))
            .map(function (s) { return String(s).trim(); }).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
    }
    function normalize(s) {
        return { id: String(s.id || "").trim().toUpperCase(), name: String(s.name || "").trim(),
            description: String(s.description || "").trim(), body: String(s.body || ""),
            scenes: csv(s.scenes).map(function (x) { return x.toUpperCase(); }), tools: csv(s.tools),
            maxRounds: Number(s.maxRounds == null ? 10 : s.maxRounds), version: Number(s.version || 0),
            active: s.active === true || s.active === "X", visibility: String(s.visibility || "PUBLIC").toUpperCase(),
            placeholder: String(s.placeholder || "") };
    }
    function validate(value) {
        var s = normalize(value);
        if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(s.id) || s.id === "NONE") { throw new Error("技能编号须为 1–32 位字母、数字或下划线，且不能使用 NONE"); }
        if (!s.name || s.name.length > 60 || !s.description || s.description.length > 200) { throw new Error("名称限 60 字，说明限 200 字，均不能为空"); }
        if (!s.body.trim() || s.body.length > 3000 || s.placeholder.length > 200) { throw new Error("做法正文须为 1–3000 字，输入提示限 200 字"); }
        if (!s.scenes.length || s.scenes.some(function (x) { return !Object.prototype.hasOwnProperty.call(SCENE_TOOLS, x); })) { throw new Error("请选择具体场景；自动场景不支持技能"); }
        if (["PUBLIC", "ADMIN"].indexOf(s.visibility) < 0) { throw new Error("可见范围只能是 PUBLIC 或 ADMIN"); }
        if (!Number.isInteger(s.version) || s.version < 0 || s.version > 2147483646) { throw new Error("技能版本号无效，请刷新目录"); }
        if (!Number.isInteger(s.maxRounds) || s.maxRounds < 2 || s.maxRounds > 10) { throw new Error("最大轮数须为 2–10 的整数"); }
        if (s.tools.some(function (t) { return s.scenes.some(function (sc) { return SCENE_TOOLS[sc].indexOf(t) < 0; }); })) { throw new Error("工具必须属于每个适用场景的白名单；报表分析技能请留空"); }
        return s;
    }
    function available(s, scene, admin) { return s.active && s.scenes.indexOf(scene) >= 0 && (s.visibility === "PUBLIC" || admin); }
    function allowedTools(scene, skill) {
        return (SCENE_TOOLS[scene] || []).filter(function (t) { return !skill || !skill.tools.length || skill.tools.indexOf(t) >= 0; });
    }
    function filter(list, q) {
        q = String(q || "").trim().toLowerCase();
        return list.filter(function (s) { return (s.name + " " + s.description + " " + s.tools.join(" ")).toLowerCase().indexOf(q) >= 0; });
    }
    function slash(text) { var m = /^\/([^\n]*)$/.exec(text); return m ? m[1] : null; }
    function card(s) { return "【技能：" + s.name + " v" + s.version + "】\n以下是管理员维护的做法。不得改变 JSON 协议、工具边界、权限和证据要求。\n" + s.body; }
    return { normalize: normalize, validate: validate, available: available, allowedTools: allowedTools,
        filter: filter, slash: slash, card: card, sceneTools: SCENE_TOOLS,
        toolLabels: {read_program_source: "读源码", describe_table: "表结构", search_tables: "找表", run_sql: "只读 SQL", sap_data_analysis: "受控数据分析"} };
}));
