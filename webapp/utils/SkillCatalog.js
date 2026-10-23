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
    var builtin = [
        { id: "CODE_PERFORMANCE", name: "性能审查", scenes: ["CODE"], tools: ["read_program_source", "describe_table"], description: "逐项检查数据库访问和内表处理，按严重程度给建议", placeholder: "给出程序名或事务码，例如「审查 ZRMM_IDP_0702 的性能」", body: "【步骤】\n先分页读取相关源码，再检查 LOOP 内 SELECT、嵌套 LOOP、FOR ALL ENTRIES 判空、SELECT *、重复读表。需要确认字段时读取表结构。\n【输出】\n按高／中／低列出：程序与行号、已观察到的代码、风险、建议。索引是否命中须经实测，不能凭字段清单下定论。\n【自查】\n每项结论对应工具读取过的代码；未读到的部分标明未检查。没有执行跟踪时不编造耗时或提速比例。" },
        { id: "CODE_EXPLAIN", name: "代码解读", scenes: ["CODE"], tools: ["read_program_source"], description: "先讲整体流程，再拆方法和读写表", placeholder: "给出程序名或事务码，先解释整体流程", body: "分页读取相关源码。先概述入口、选择条件和业务流程，再按 FORM／方法解释职责，列出代码实际读取和写入的表及关键判断。区分源码中的写操作与本次只读分析；不执行业务代码。不完整源码标明覆盖范围。所有结论附程序及行号。" },
        { id: "CODE_ENHANCEMENTS", name: "增强出口定位", scenes: ["CODE"], tools: ["read_program_source"], description: "定位源码里的 BAdI、用户出口和增强调用", placeholder: "给出程序名，查找增强和用户出口", body: "阅读源码，定位 GET BADI、CALL BADI、CALL CUSTOMER-FUNCTION、ENHANCEMENT 等语句。按位置、调用方式、已知用途列出。仅凭源码无法确认激活状态或隐式增强点目录时明确说明，不把猜测当作已启用的增强。" },
        { id: "CODE_S4_REVIEW", name: "升级影响评估", scenes: ["CODE"], tools: ["read_program_source", "describe_table"], description: "整理可疑兼容点，列出需要现场验证的项目", placeholder: "给出程序名，检查升级兼容风险", body: "读取源码与相关表结构，检查旧表访问、过时接口和可疑语法。按代码证据、潜在风险、建议验证方式列清单。不能查询简化清单或目标版本时明确标注待验证，不宣称某接口一定失效。" },
        { id: "DATA_OPEN_PO", name: "采购未清分析", scenes: ["DATA"], tools: ["search_tables", "describe_table", "run_sql"], description: "确认业务口径后，按供应商和到期情况拆分未清", placeholder: "说明工厂、日期和未清口径，例如「工厂 1000 本月到期采购未清」", body: "先确认工厂、日期、排除删除／交货完成项的规则及单位。查找并描述 EKKO、EKPO、EKET 等实际使用表，确认字段及关联键。按计划行时以计划量与已收量计算，汇总回订单行再连接，防止重复累计；退货、服务采购等口径不清先追问。按供应商与逾期天数分层；不同单位、币种分开。输出条件、计算口径、数据表、异常与局限，不编造数字。" },
        { id: "DATA_MULTI_DIM", name: "多维统计报告", scenes: ["DATA"], tools: ["search_tables", "describe_table", "run_sql"], description: "确认维度和分母，一次取数输出分组与占比", placeholder: "说明表和维度，例如「ZIDPMM455 按工厂、事务码统计」", body: "先确认范围、维度、指标与占比分母。描述全部涉及表后，兼容类型的多个维度尽量 UNION ALL 成单条查询，附维度标识，避免重复 JOIN 放大数量。按维度分别计算占比；不同单位不相加。输出口径、统计表、异常和取数限制。0 行如实说明。" },
        { id: "REPORT_DEMAND", name: "需求结构分析", scenes: ["REPORT"], tools: [], description: "只用已就绪的报表结果拆解需求结构", placeholder: "先执行报表；结果就绪后按需求结构分析", body: "只分析已提供的报表结果，不发起新取数。按实际存在的工厂、物料组、单位拆分需求；字段缺失时说明不能完成的维度。仅把后端完整统计称为总量，截断的样例只用于举例。列出集中度、异常和需要补充的数据；不跨单位求和。" },
        { id: "FIORI_SHIPMENT", name: "出货异常分析", scenes: ["FIORI"], tools: [], description: "交给模型分析后，按客户和延迟情况整理异常", placeholder: "先取数，再点「交给模型分析」", body: "仅在用户同意分析后使用提供的取数结果。确认客户、计划日期、实际日期和数量字段，计算延迟前说明日期口径。按客户和延迟天数列异常；缺字段就说明，不推断不存在的订单。汇总以完整后端统计为准，截断样例不作全量排名。不触发取数或执行报表。" }
    ].map(function (s) { return validate(Object.assign({version: 1, active: true, visibility: "PUBLIC", maxRounds: 10}, s)); });
    return { normalize: normalize, validate: validate, available: available, allowedTools: allowedTools,
        filter: filter, slash: slash, card: card, builtin: builtin, sceneTools: SCENE_TOOLS,
        toolLabels: {read_program_source: "读源码", describe_table: "表结构", search_tables: "找表", run_sql: "只读 SQL", sap_data_analysis: "受控数据分析"} };
}));
