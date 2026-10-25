sap.ui.define([], function () {
        "use strict";

        /**
         * =====================================================================
         * ChatService 拆分块：Fiori 报表 + 报表目录的演示模式（mock）后端
         * =====================================================================
         * 与 ZCL_AI_FIORI_REPORT_SERVICE / ZCL_AI_ODATA_SHAPER 的语义对应（设计：
         * 功能计划书/Fiori报表分析/01-方案与开发计划）：
         *  · 目录（FioriReportDefs）、同步取数（RunFioriReport，幂等）、结果重读（FioriReportResult）
         *  · 参数校验 + 拼 $filter（只用来展示请求 URI，与后端同口径）
         *  · 返回结构转换 FLAT / PIVOT / EXPAND + 统一清洗 + 数值列判断 + 后端统计
         *  · Agent 一轮（选择报表 → 参数卡；一句话找报表；分析闸门；重跑）
         *  · 另带「报表执行」目录的演示清单（_mockReportDefs，键用大写，和真实 ReportDefinitions 一样）
         *    与「执行 <TCode>」的演示 Agent（_mockReportAgent，20261024：出参数卡，不提交作业）
         * 开关：localStorage zaiChat.cfg.FIORI_ENABLED（未设 = 开），用来演示"能力未开启"。
         * 以 mixin 方式并入 ChatService（方法里的 this 就是 ChatService）；方法名统一 _mockFiori / _fiori 前缀。
         * =====================================================================
         */

        /** 演示用的 Fiori 报表登记（字段与 ZAI_FRPT_DEF / ZAI_FRPT_PARAM 对应） */
        var DEFS = [
                {
                        reportId: "SHIPMENT", reportName: "shipment報表", category: "销量分析",
                        keywords: "出货,出貨,shipment,ship mode,销量", description: "按维度和月份透视的出货数量（ZSD_IDP_001_SRV）",
                        servicePath: "/sap/opu/odata/sap/ZSD_IDP_001_SRV", entitySet: "DynamiFIELDSet", expandNav: "DynamicDataSet",
                        shape: "PIVOT", analyzeEnabled: "X", sortNo: 10,
                        shapeCfg: { colList: "d.results", colName: "Name", colLabel: "Description", colOrder: "Position", valueList: "DynamicDataSet.results", valueField: "Value" },
                        params: [
                                { paramId: "DIM", label: "維度", dataType: "ENUM", typeLength: 20, required: true, multiValue: true, rangeAllowed: false, odataProp: "Dimension", filterOp: "IN", valueFmt: "STRING",
                                  enumJson: [{ key: "SHMODE", text: "ship mode" }, { key: "REGION", text: "region" }, { key: "SITE", text: "SITE" }, { key: "BU", text: "BU" }, { key: "MODEL", text: "MODEL" }],
                                  defaultType: "STATIC", defaultValue: "SHMODE", helpText: "可多选", sortNo: 10 },
                                { paramId: "DATE", label: "日期区间", dataType: "DATE", typeLength: 8, required: true, multiValue: false, rangeAllowed: true, commonKey: "DATE_RANGE", odataProp: "BegDat", odataPropTo: "EndDat", filterOp: "BT2", valueFmt: "DATETIME",
                                  defaultType: "THIS_MONTH", sortNo: 20 },
                                { paramId: "SITE", label: "site", dataType: "CHAR", typeLength: 4, required: false, multiValue: true, rangeAllowed: false, commonKey: "SITE", odataProp: "Site", filterOp: "IN", valueFmt: "STRING",
                                  helpText: "可多值，逗号分隔，例如 HHZZ", sortNo: 30 },
                                { paramId: "BU", label: "bu", dataType: "CHAR", typeLength: 10, required: false, multiValue: true, rangeAllowed: false, commonKey: "BU", odataProp: "Bu", filterOp: "IN", valueFmt: "STRING", sortNo: 40 }
                        ]
                },
                {
                        reportId: "SO_BACKLOG", reportName: "订单未交明细", category: "销量分析",
                        keywords: "未交,backlog,订单,出货", description: "销售订单未交数量与金额（演示 FLAT 形状）",
                        servicePath: "/sap/opu/odata/sap/ZSD_DEMO_BACKLOG_SRV", entitySet: "BacklogSet", shape: "FLAT", analyzeEnabled: "X", sortNo: 20,
                        shapeCfg: { rowList: "d.results", columns: [{ prop: "Werks", label: "工厂" }, { prop: "Vbeln", label: "订单" }, { prop: "Matnr", label: "物料" }, { prop: "Kwmeng", label: "未交数量" }, { prop: "Netwr", label: "未交金额" }] },
                        params: [
                                { paramId: "SITE", label: "site", dataType: "CHAR", typeLength: 4, required: false, multiValue: true, commonKey: "SITE", odataProp: "Werks", filterOp: "IN", valueFmt: "STRING", sortNo: 10 }
                        ]
                },
                {
                        reportId: "PO_OPEN", reportName: "采购未清报表", category: "采购",
                        keywords: "采购,未清,PO", description: "未清采购订单行（演示：未开放模型分析）",
                        servicePath: "/sap/opu/odata/sap/ZMM_DEMO_PO_SRV", entitySet: "OpenPoSet", shape: "FLAT", analyzeEnabled: "", sortNo: 10,
                        shapeCfg: { rowList: "d.results" },
                        params: [
                                { paramId: "SITE", label: "site", dataType: "CHAR", typeLength: 4, required: true, multiValue: false, commonKey: "SITE", odataProp: "Werks", filterOp: "EQ", valueFmt: "STRING", defaultType: "STATIC", defaultValue: "1000", sortNo: 10 }
                        ]
                },
                {
                        reportId: "WO_YIELD", reportName: "工单良率日报", category: "生产",
                        keywords: "良率,工单,yield,生产", description: "按工单的投入、良品与良率（演示 EXPAND 形状）",
                        servicePath: "/sap/opu/odata/sap/ZPP_DEMO_YIELD_SRV", entitySet: "OrderSet", expandNav: "ToItems", shape: "EXPAND", analyzeEnabled: "X", sortNo: 10,
                        shapeCfg: { rowList: "d.results", itemList: "ToItems.results", headerCols: ["Werks", "Aufnr"], itemCols: ["Matnr", "Qty", "Good"] },
                        params: [
                                { paramId: "DAY", label: "日期", dataType: "DATE", typeLength: 8, required: true, multiValue: false, odataProp: "Budat", filterOp: "EQ", valueFmt: "DATETIME", defaultType: "TODAY", sortNo: 10 }
                        ]
                }
        ];

        /** 「报表执行」目录演示清单（与真实 ReportDefinitions 一样用大写键） */
        var TCODE_DEFS = [
                { REPORT_ID: "ZDPMM702", TCODE: "ZDPMM702", NAME: "MIH 需求报表", DESCRIPTION: "按工厂、机种汇总 MIH 需求（程序 ZRMM_IDP_0702）", EXEC_ENABLED: "X",
                  PARAMS: [{ PARAM_ID: "WERKS" }, { PARAM_ID: "MODEL" }] },
                { REPORT_ID: "ZDPMM455", TCODE: "ZDPMM455", NAME: "物料收发汇总", DESCRIPTION: "按期间汇总物料收发数量（演示）", EXEC_ENABLED: "X",
                  PARAMS: [{ PARAM_ID: "WERKS" }, { PARAM_ID: "BUDAT" }, { PARAM_ID: "MATNR" }] },
                { REPORT_ID: "ZDPSD010", TCODE: "ZDPSD010", NAME: "出货差异对账", DESCRIPTION: "出货与开票差异（演示：暂未开放执行）",
                  PARAMS: [{ PARAM_ID: "VKORG" }] },
                // 20261024（10.24 记录 #03a）：仿 ZRSD_IDP_0012 —— 两组单选（R）、两个复选框（C）、一堆选填条件。
                // PARAMS 写成后端 get_params 整理后的样子：R → ENUM + ENUM_JSON + 默认项；C → BOOL；F（固定值）不返回
                { REPORT_ID: "ZDPSD012", TCODE: "ZDPSD012", PROGNAME: "ZRSD_IDP_0012", NAME: "出貨明細報表", DESCRIPTION: "按工廠、出貨日期查出貨明細（演示：單選組 / 複選框 / 選填條件折疊）", EXEC_ENABLED: "X",
                  PARAMS: [
                        { PARAM_ID: "P_PLANT", ABAP_NAME: "P_PLANT", DISPLAY_LABEL: "工廠", DATA_TYPE: "CHAR", TYPE_LENGTH: 4, REQUIRED: true, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 10 },
                        { PARAM_ID: "S_ERDAT", ABAP_NAME: "S_ERDAT", DISPLAY_LABEL: "出貨日期", DATA_TYPE: "DATE", TYPE_LENGTH: 8, REQUIRED: true, RANGE_ALLOWED: true, SEL_KIND: "S", SORT_NO: 20 },
                        { PARAM_ID: "RB_SHIP", ABAP_NAME: "G_SHIP", DISPLAY_LABEL: "出貨狀態", DATA_TYPE: "ENUM", SEL_KIND: "R", SORT_NO: 30,
                          ALLOWED_OPS: "P_SHIP=已出貨;P_OPEN=未出貨;P_ALL=全部*", VALIDATION_RULE: "P_SHIP,P_OPEN,P_ALL", DEFAULT_TYPE: "STATIC", DEFAULT_VALUE: "P_ALL",
                          ENUM_JSON: '[{"key":"P_SHIP","text":"已出貨"},{"key":"P_OPEN","text":"未出貨"},{"key":"P_ALL","text":"全部"}]' },
                        { PARAM_ID: "RB_PACK", ABAP_NAME: "G_PACK", DISPLAY_LABEL: "包裝", DATA_TYPE: "ENUM", SEL_KIND: "R", SORT_NO: 40,
                          ALLOWED_OPS: "P_SINGLE=單體;P_MULTI=多體;P_PKALL=所有包裝*", VALIDATION_RULE: "P_SINGLE,P_MULTI,P_PKALL", DEFAULT_TYPE: "STATIC", DEFAULT_VALUE: "P_PKALL",
                          ENUM_JSON: '[{"key":"P_SINGLE","text":"單體"},{"key":"P_MULTI","text":"多體"},{"key":"P_PKALL","text":"所有包裝"}]' },
                        { PARAM_ID: "P_CANCEL", ABAP_NAME: "P_CANCEL", DISPLAY_LABEL: "含取消發票", DATA_TYPE: "BOOL", SEL_KIND: "C", SORT_NO: 50 },
                        { PARAM_ID: "P_ERRONLY", ABAP_NAME: "P_ERRONLY", DISPLAY_LABEL: "只看異常", DATA_TYPE: "BOOL", SEL_KIND: "C", SORT_NO: 60, ALLOWED_OPS: "X", DEFAULT_VALUE: "X",
                          HELP_TEXT: "出貨數量與開票數量不一致的行" },
                        { PARAM_ID: "S_KUNNR", ABAP_NAME: "S_KUNNR", DISPLAY_LABEL: "客戶代碼", DATA_TYPE: "CHAR", TYPE_LENGTH: 10, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 70 },
                        { PARAM_ID: "S_VKORG", ABAP_NAME: "S_VKORG", DISPLAY_LABEL: "銷售組織", DATA_TYPE: "CHAR", TYPE_LENGTH: 4, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 80 },
                        { PARAM_ID: "S_MODEL", ABAP_NAME: "S_MODEL", DISPLAY_LABEL: "機種", DATA_TYPE: "CHAR", TYPE_LENGTH: 18, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 90 },
                        { PARAM_ID: "S_BSTNK", ABAP_NAME: "S_BSTNK", DISPLAY_LABEL: "客戶PO", DATA_TYPE: "CHAR", TYPE_LENGTH: 20, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 100 },
                        { PARAM_ID: "S_GSBER", ABAP_NAME: "S_GSBER", DISPLAY_LABEL: "業務範圍", DATA_TYPE: "CHAR", TYPE_LENGTH: 4, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 110 },
                        { PARAM_ID: "S_VBELN", ABAP_NAME: "S_VBELN", DISPLAY_LABEL: "交貨單號", DATA_TYPE: "CHAR", TYPE_LENGTH: 10, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 120 },
                        { PARAM_ID: "S_FKART", ABAP_NAME: "S_FKART", DISPLAY_LABEL: "發票類型", DATA_TYPE: "CHAR", TYPE_LENGTH: 4, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 130 },
                        { PARAM_ID: "S_INVNO", ABAP_NAME: "S_INVNO", DISPLAY_LABEL: "發票號碼", DATA_TYPE: "CHAR", TYPE_LENGTH: 10, MULTI_VALUE: true, SEL_KIND: "S", SORT_NO: 140 }
                  ] }
        ];

        /** 演示取数结果在 localStorage 里的键与保留份数（DATA-01：刷新后可重读） */
        var MOCK_FIORI_KEY = "zaiChat.mockFiori.v1";
        var MOCK_FIORI_KEEP = 30;

        /** 参数校验用：完整数值形态 */
        var NUM_RE = /^-?\d+(\.\d+)?$/;
        /** 数值列判断用：另外排除前导零（0045123 这类单据号 / 物料号按文本，转数字会丢零） */
        var NUM_COL_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

        function pad2(n) { return (n < 10 ? "0" : "") + n; }
        function ymd(d) { return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }
        function validDate(s) {
                if (!/^\d{8}$/.test(s)) { return false; }
                var d = new Date(+s.substring(0, 4), +s.substring(4, 6) - 1, +s.substring(6, 8));
                return ymd(d) === s;
        }
        /** 确定性的伪随机（同样的输入出同样的数，演示数据稳定） */
        function hash(s) {
                var h = 2166136261;
                for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
                return h;
        }
        function getPath(o, sPath) {
                return String(sPath || "").split(".").filter(Boolean).reduce(function (cur, k) {
                        return cur === undefined || cur === null ? undefined : cur[k];
                }, o);
        }

        return {

                /* ===================== 结构转换（与 ZCL_AI_ODATA_SHAPER 同口径） ===================== */

                /**
                  * 单元格清洗：去前后空格；/Date(ms)/ → YYYY-MM-DD；千分位；ABAP 尾负号 100- → -100
                  * @returns {string}
                  */
                _fioriClean: function (v) {
                        if (v === undefined || v === null) { return ""; }
                        var s = String(v).trim();
                        var m = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(s);
                        if (m) {
                                var d = new Date(+m[1]);
                                return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
                        }
                        if (/^-?\d{1,3}(,\d{3})+(\.\d+)?-?$/.test(s)) { s = s.replace(/,/g, ""); }
                        if (/^\d+(\.\d+)?-$/.test(s)) { s = "-" + s.substring(0, s.length - 1); }
                        return s;
                },

                /** 一列的值去空格后全部是完整数值形态且没有前导零（空值不算反例，但至少要有一个值）→ 数值列 */
                _fioriNumericCol: function (aVals) {
                        var bAny = false;
                        for (var i = 0; i < aVals.length; i++) {
                                if (aVals[i] === "") { continue; }
                                if (!NUM_COL_RE.test(aVals[i])) { return false; }
                                bAny = true;
                        }
                        return bAny;
                },

                /**
                  * OData JSON → 统一数据集 { columns:[{name,label,numeric}], rows:[{name:value}], error }
                  * @param {object} oJson OData V2 响应（{d:{results:[…]}}）
                  * @param {string} sShape FLAT / PIVOT / EXPAND
                  * @param {object} oCfg SHAPE_CFG
                  */
                _fioriShape: function (oJson, sShape, oCfg) {
                        var Service = this;
                        var cfg = oCfg || {};
                        var aCols = [], aRows = [];
                        if (sShape === "PIVOT") {
                                var aList = getPath(oJson, cfg.colList || "d.results") || [];
                                var aSorted = aList.slice().sort(function (a, b) {
                                        return (parseInt(a[cfg.colOrder || "Position"], 10) || 0) - (parseInt(b[cfg.colOrder || "Position"], 10) || 0);
                                });
                                var aVals = aSorted.map(function (c) {
                                        return (getPath(c, cfg.valueList || "DynamicDataSet.results") || []).map(function (v) {
                                                return Service._fioriClean(v[cfg.valueField || "Value"]);
                                        });
                                });
                                var iLen = aVals.length ? aVals[0].length : 0;
                                if (aVals.some(function (a) { return a.length !== iLen; })) {
                                        return { columns: [], rows: [], error: "返回结构列长度不一致，无法按行拼接" };
                                }
                                aCols = aSorted.map(function (c, i) {
                                        var sName = String(c[cfg.colName || "Name"] || ("C" + (i + 1))).trim();
                                        return { name: sName, label: String(c[cfg.colLabel || "Description"] || sName).trim() };
                                });
                                for (var r = 0; r < iLen; r++) {
                                        var oRow = {};
                                        aCols.forEach(function (col, ci) { oRow[col.name] = aVals[ci][r]; });
                                        aRows.push(oRow);
                                }
                        } else if (sShape === "EXPAND") {
                                var aHead = getPath(oJson, cfg.rowList || "d.results") || [];
                                var aHc = cfg.headerCols || [], aIc = cfg.itemCols || [];
                                aCols = aHc.concat(aIc).map(function (p) { return { name: p, label: p }; });
                                aHead.forEach(function (h) {
                                        (getPath(h, cfg.itemList) || []).forEach(function (it) {
                                                var oRow = {};
                                                aHc.forEach(function (p) { oRow[p] = Service._fioriClean(h[p]); });
                                                aIc.forEach(function (p) { oRow[p] = Service._fioriClean(it[p]); });
                                                aRows.push(oRow);
                                        });
                                });
                        } else {
                                var aRaw = getPath(oJson, cfg.rowList || "d.results") || [];
                                if (cfg.columns && cfg.columns.length) {
                                        aCols = cfg.columns.map(function (c) { return { name: c.prop, label: c.label || c.prop }; });
                                } else if (aRaw.length) {
                                        aCols = Object.keys(aRaw[0]).filter(function (k) {
                                                return k !== "__metadata" && (aRaw[0][k] === null || typeof aRaw[0][k] !== "object");
                                        }).map(function (k) { return { name: k, label: k }; });
                                }
                                aRaw.forEach(function (o) {
                                        var oRow = {};
                                        aCols.forEach(function (c) { oRow[c.name] = Service._fioriClean(o[c.name]); });
                                        aRows.push(oRow);
                                });
                        }
                        aCols.forEach(function (c) {
                                c.numeric = Service._fioriNumericCol(aRows.map(function (r) { return r[c.name]; }));
                        });
                        // 数值列输出成数字（与后端 ROW_JSON 一致：数值列不带引号）
                        aRows.forEach(function (r) {
                                aCols.forEach(function (c) {
                                        if (c.numeric && r[c.name] !== "") { r[c.name] = Number(r[c.name]); }
                                });
                        });
                        return { columns: aCols, rows: aRows, error: "" };
                },

                /**
                  * 后端统计（与 compute_stats 同口径）：数值列合计 / 最大 / 最小；第一个维度列按最后一个数值列
                  * 的前 10 名与占比；相邻数值列（期间列）合计的变化率
                  */
                _fioriStats: function (oDs) {
                        var aNum = oDs.columns.filter(function (c) { return c.numeric; });
                        var oDim = oDs.columns.filter(function (c) { return !c.numeric; })[0];
                        var round2 = function (x) { return Math.round(x * 100) / 100; };
                        var aNumeric = aNum.map(function (c) {
                                var fSum = 0, fMax = null, fMin = null, sMaxAt = "", sMinAt = "";
                                oDs.rows.forEach(function (r) {
                                        var v = r[c.name];
                                        if (v === "" || v === undefined) { return; }
                                        fSum += v;
                                        if (fMax === null || v > fMax) { fMax = v; sMaxAt = oDim ? String(r[oDim.name]) : ""; }
                                        if (fMin === null || v < fMin) { fMin = v; sMinAt = oDim ? String(r[oDim.name]) : ""; }
                                });
                                return { name: c.name, label: c.label, sum: round2(fSum), max: fMax, maxAt: sMaxAt, min: fMin, minAt: sMinAt };
                        });
                        var aTop = [];
                        if (oDim && aNum.length) {
                                var cV = aNum[aNum.length - 1];
                                var fTot = aNumeric[aNumeric.length - 1].sum;
                                aTop = oDs.rows.filter(function (r) { return r[cV.name] !== ""; }).map(function (r) {
                                        return { key: String(r[oDim.name]), value: r[cV.name], share: fTot ? round2(r[cV.name] * 100 / fTot) : 0 };
                                }).sort(function (a, b) { return b.value - a.value; }).slice(0, 10);
                        }
                        var aTrend = [];
                        for (var i = 1; i < aNumeric.length; i++) {
                                var p = aNumeric[i - 1].sum, q = aNumeric[i].sum;
                                aTrend.push({ from: aNumeric[i - 1].label, to: aNumeric[i].label, change: p ? round2((q - p) * 100 / p) : null });
                        }
                        return { rowCount: oDs.rows.length, dimension: oDim ? oDim.label : "", valueColumn: aNum.length ? aNum[aNum.length - 1].label : "", numeric: aNumeric, top: aTop, columnTrend: aTrend };
                },

                /* ===================== 参数 → $filter（与 build_filter 同口径） ===================== */

                /** 值的 OData 字面量 */
                _fioriLit: function (sVal, sFmt) {
                        if (sFmt === "DATETIME") {
                                return "datetime'" + sVal.substring(0, 4) + "-" + sVal.substring(4, 6) + "-" + sVal.substring(6, 8) + "T00:00:00'";
                        }
                        if (sFmt === "INT") { return sVal; }
                        if (sFmt === "DECIMAL") { return sVal + "M"; }
                        return "'" + sVal.replace(/'/g, "''") + "'";
                },

                /**
                  * 校验参数并拼 $filter
                  * @returns {{error: string, filter: string}}
                  */
                _fioriBuildFilter: function (oDef, mVals) {
                        var Service = this;
                        var aErr = [], aCond = [];
                        oDef.params.forEach(function (p) {
                                var sRaw = String((mVals || {})[p.paramId] || "").trim();
                                if (!sRaw) {
                                        if (p.required) { aErr.push("「" + p.label + "」必填"); }
                                        return;
                                }
                                var bRange = p.rangeAllowed && !p.multiValue;
                                var aV = sRaw.split(/[,|]/).map(function (x) { return x.trim(); }).filter(Boolean);
                                if (!bRange && !p.multiValue && aV.length > 1) { aErr.push("「" + p.label + "」只能填一个值"); return; }
                                if (bRange && aV.length > 2) { aErr.push("「" + p.label + "」范围只能是 从,至"); return; }
                                if (aV.length > 50) { aErr.push("「" + p.label + "」最多 50 个值"); return; }
                                var sDt = String(p.dataType || "CHAR").toUpperCase();
                                var aKeys = (p.enumJson || []).map(function (o) { return o.key; });
                                for (var i = 0; i < aV.length; i++) {
                                        var v = aV[i];
                                        if (sDt === "DATE" && !validDate(v)) { aErr.push("「" + p.label + "」不是有效日期: " + v); return; }
                                        if (sDt === "NUM" && !NUM_RE.test(v)) { aErr.push("「" + p.label + "」不是数字: " + v); return; }
                                        if (sDt === "ENUM" && aKeys.indexOf(v) < 0) { aErr.push("「" + p.label + "」没有选项 " + v); return; }
                                        if (p.typeLength && v.length > p.typeLength) { aErr.push("「" + p.label + "」超过 " + p.typeLength + " 位: " + v); return; }
                                        if (/[\u0000-\u001f]/.test(v)) { aErr.push("「" + p.label + "」含有控制字符"); return; }
                                }
                                if (!p.odataProp) { return; }   // 只校验、不进 $filter（属性名未确认时）
                                var fmt = p.valueFmt || "STRING";
                                var L = function (x) { return Service._fioriLit(x, fmt); };
                                var op = p.filterOp || (p.multiValue ? "IN" : (bRange ? "BT" : "EQ"));
                                if (op === "BT2" && aV.length) {
                                        var aPart = [p.odataProp + " " + (p.opFrom || "ge") + " " + L(aV[0])];
                                        if (p.odataPropTo) { aPart.push(p.odataPropTo + " " + (p.opTo || "le") + " " + L(aV[aV.length - 1])); }
                                        aCond.push(aPart.join(" and "));
                                } else if (op === "BT" && aV.length === 2) {
                                        aCond.push("(" + p.odataProp + " ge " + L(aV[0]) + " and " + p.odataProp + " le " + L(aV[1]) + ")");
                                } else if (op === "SUBSTR") {
                                        aCond.push("substringof(" + L(aV[0]) + ", " + p.odataProp + ")");
                                } else if (aV.length > 1) {
                                        aCond.push("(" + aV.map(function (x) { return p.odataProp + " eq " + L(x); }).join(" or ") + ")");
                                } else {
                                        aCond.push(p.odataProp + " eq " + L(aV[0]));
                                }
                        });
                        return { error: aErr.join("；"), filter: aCond.join(" and ") };
                },

                /** 默认值（DEFAULT_TYPE：NONE / STATIC / TODAY / MONTH_START / MONTH_END / THIS_MONTH） */
                _fioriDefaults: function (oDef) {
                        var d = new Date();
                        var sToday = ymd(d);
                        var sStart = ymd(new Date(d.getFullYear(), d.getMonth(), 1));
                        var sEnd = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
                        var m = {};
                        oDef.params.forEach(function (p) {
                                var t = p.defaultType || "NONE";
                                var v = t === "STATIC" ? (p.defaultValue || "") : t === "TODAY" ? sToday : t === "MONTH_START" ? sStart
                                        : t === "MONTH_END" ? sEnd : t === "THIS_MONTH" ? sStart + "," + sEnd : "";
                                if (v) { m[p.paramId] = v; }
                        });
                        return m;
                },

                /* ===================== 演示状态 ===================== */

                /**
                  * 演示状态。20261025（改进清单 DATA-01）：存进 localStorage —— 和真实系统一样，刷新页面后结果还能按
                  * ArtifactId 重读（FioriReportResult），用来演示 / 测试"刷新后结果表还在"。只留最近 MOCK_FIORI_KEEP 份。
                  */
                _mockFioriState: function () {
                        if (!this._oFioriMock) {
                                var st = { runs: {}, byRequest: {}, seq: 0 };
                                var o = null;
                                try { o = JSON.parse(window.localStorage.getItem(MOCK_FIORI_KEY) || "null"); } catch (e) { o = null; }
                                if (o && typeof o === "object" && o.runs && typeof o.runs === "object") {
                                        st.seq = parseInt(o.seq, 10) || 0;
                                        Object.keys(o.runs).forEach(function (k) {
                                                var r = o.runs[k] || {};
                                                var oDef = r.result ? this._mockFioriDef(r.result.reportId) : null;
                                                if (!oDef) { return; }
                                                var oDs;
                                                try {
                                                        oDs = { columns: (JSON.parse(r.result.schemaJson || "{}") || {}).columns || [], rows: JSON.parse(r.result.rowsJson || "[]") || [] };
                                                } catch (e) { return; }
                                                st.runs[k] = {
                                                        result: r.result, ds: oDs, def: oDef, params: r.params || {}, sessionId: r.sessionId || "",
                                                        analyzed: !!r.analyzed, createdAt: r.createdAt || "", summary: this._fioriStats(oDs)
                                                };
                                        }, this);
                                        Object.keys(o.byRequest || {}).forEach(function (sReq) {
                                                if (st.runs[o.byRequest[sReq]]) { st.byRequest[sReq] = o.byRequest[sReq]; }
                                        });
                                }
                                this._oFioriMock = st;
                        }
                        return this._oFioriMock;
                },

                /** 写回 localStorage（只存可序列化的部分；ds / def / summary 读取时重建） */
                _mockFioriSave: function () {
                        var st = this._oFioriMock;
                        if (!st) { return; }
                        var aKeep = Object.keys(st.runs).sort(function (a, b) {
                                return String(st.runs[a].createdAt || "").localeCompare(String(st.runs[b].createdAt || "")) || a.localeCompare(b);
                        }).slice(-MOCK_FIORI_KEEP);
                        var o = { seq: st.seq, byRequest: {}, runs: {} };
                        aKeep.forEach(function (k) {
                                var r = st.runs[k];
                                o.runs[k] = { result: r.result, params: r.params, sessionId: r.sessionId, analyzed: !!r.analyzed, createdAt: r.createdAt || "" };
                        });
                        Object.keys(st.byRequest).forEach(function (sReq) {
                                if (o.runs[st.byRequest[sReq]]) { o.byRequest[sReq] = st.byRequest[sReq]; }
                        });
                        try { window.localStorage.setItem(MOCK_FIORI_KEY, JSON.stringify(o)); } catch (e) { /* 存不下：只影响刷新后的演示恢复 */ }
                },

                /** 会话里登记过的 Fiori 结果（ChatService.getSessionResults 的演示实现，结构同真实系统） */
                _mockFioriArtifacts: function (sSessionId) {
                        var st = this._mockFioriState();
                        return Object.keys(st.runs).filter(function (k) {
                                return st.runs[k].sessionId === sSessionId;
                        }).map(function (k) {
                                var r = st.runs[k];
                                return {
                                        artifactId: k, type: "FIORI_RESULT", taskId: "", label: r.def.reportName,
                                        rowCount: parseInt(r.result.rowCount, 10) || 0, createdAt: r.createdAt || "", runId: r.result.runId || ""
                                };
                        }).sort(function (x, y) { return x.createdAt.localeCompare(y.createdAt); });
                },

                _mockFioriEnabled: function () {
                        var s = null;
                        try { s = window.localStorage.getItem("zaiChat.cfg.FIORI_ENABLED"); } catch (e) { s = null; }
                        return s === null || s === "X";
                },

                _mockFioriDef: function (sId) {
                        return DEFS.filter(function (d) { return d.reportId === sId; })[0] || null;
                },

                /** 目录：报表 + 参数（字段名与后端 ty_def 序列化后的 camelCase 一致） */
                _mockFioriDefsList: function () {
                        return DEFS.map(function (d) {
                                return {
                                        reportId: d.reportId, reportName: d.reportName, category: d.category, keywords: d.keywords,
                                        description: d.description, analyzeEnabled: d.analyzeEnabled, sortNo: d.sortNo,
                                        params: d.params.map(function (p) {
                                                return { paramId: p.paramId, label: p.label, dataType: p.dataType, required: !!p.required, multiValue: !!p.multiValue,
                                                         rangeAllowed: !!p.rangeAllowed, commonKey: p.commonKey || "", helpText: p.helpText || "" };
                                        })
                                };
                        });
                },

                _mockReportDefs: function () {
                        return Promise.resolve({ defs: JSON.parse(JSON.stringify(TCODE_DEFS)), message: "" });
                },

                /**
                  * 20261024：「报表执行」会话的演示 Agent —— 只认「执行 <TCode>」，其余返回 null（交回通用演示）。
                  * 待填参数与后端 AGENT_SERVICE.build_report_intro 同格式：只带 param_id / label / required /
                  * data_type / multi_value / range_allowed（不带选项和默认值），前端再按目录定义补齐（_enrichReportAsk）。
                  */
                _mockReportAgent: function (oPayload) {
                        var m = /执行\s*([A-Za-z0-9_]{3,20})/.exec(String(oPayload.question || ""));
                        if (!m) {
                                return null;
                        }
                        var Service = this;
                        var sTc = m[1].toUpperCase();
                        var oDef = TCODE_DEFS.filter(function (d) { return d.TCODE === sTc; })[0];
                        var aP = ((oDef && oDef.PARAMS) || []).filter(function (p) { return p.SEL_KIND !== "F"; });
                        var bCard = !!(oDef && oDef.EXEC_ENABLED === "X" && aP.length);
                        var sAnswer;
                        if (!oDef) {
                                sAnswer = "【报表未登记】事务代码 " + sTc + " 未在系统报表登记表中，或已被停用。（演示模式）";
                        } else {
                                sAnswer = "【报表 " + oDef.NAME + "】(" + oDef.TCODE + " / " + oDef.REPORT_ID + ")\n" + (oDef.DESCRIPTION || "") + "\n\n" +
                                        "【需要填写参数】(在任务卡表单中填写后提交执行; 聊天内不会直接提交作业, 参数由服务端二次校验)\n" +
                                        aP.map(function (p) {
                                                return "- " + (p.DISPLAY_LABEL || p.PARAM_ID) + "(" + (p.REQUIRED ? "必填" : "可选") +
                                                        (p.MULTI_VALUE ? ", 支持多值" : p.RANGE_ALLOWED ? ", 支持范围" : "") + ")";
                                        }).join("\n") + "\n\n(演示模式: 不会提交后台作业。)";
                        }
                        var sPending = bCard ? JSON.stringify({
                                report_id: oDef.REPORT_ID, tcode: oDef.TCODE,
                                params: aP.map(function (p) {
                                        return { param_id: p.PARAM_ID, label: p.DISPLAY_LABEL || p.PARAM_ID, required: !!p.REQUIRED,
                                                data_type: p.DATA_TYPE || "CHAR", multi_value: !!p.MULTI_VALUE, range_allowed: !!p.RANGE_ALLOWED };
                                })
                        }) : "";
                        return new Promise(function (fnResolve) {
                                setTimeout(function () {
                                        var oStore = Service._mockStore();
                                        var aHist = oStore.messages[oPayload.sessionId] = oStore.messages[oPayload.sessionId] || [];
                                        var sNow = Service._mockTime();
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "user", Content: oPayload.question, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "assistant", Content: sAnswer, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        var oSess = oStore.sessions.filter(function (x) { return x.SessionId === oPayload.sessionId; })[0];
                                        if (!oSess) {
                                                oStore.sessions.unshift({
                                                        SessionId: oPayload.sessionId, Title: oPayload.question.substring(0, 24), ModelId: oPayload.modelId || "",
                                                        MsgCount: "2", CreatedAt: sNow, ChangedAt: sNow, Mode: "AGENT", AgentType: "REPORT", Status: "COMPLETED"
                                                });
                                        } else {
                                                oSess.ChangedAt = sNow;
                                                oSess.MsgCount = String((parseInt(oSess.MsgCount || "0", 10) || 0) + 2);
                                        }
                                        Service._mockSave(oStore);
                                        fnResolve({
                                                answer: sAnswer, status: "OK", elapsedMs: 0, rounds: 0, message: "", modelId: oPayload.modelId || "AUTO",
                                                trace: [{ phase: "UNDERSTANDING", label: "理解问题", status: "OK", elapsedMs: 0 },
                                                        { phase: "COMPOSING", label: bCard ? "整理报表参数" : "报表未登记", status: "OK", elapsedMs: 0 }],
                                                analysis: null,
                                                taskId: bCard ? "RTASK" + String(oPayload.sessionId || "").substring(0, 8) : "",
                                                taskModule: "REPORT", taskStatus: bCard ? "WAITING_INPUT" : "",
                                                needsInput: bCard, pendingParamsJson: sPending, artifactRefsJson: ""
                                        });
                                }, 400);
                        });
                },

                /** 待填参数 JSON（与后端 agent_turn 输出同格式；键用下划线，AskCard 直接渲染） */
                _fioriPendingJson: function (oDef, mValues) {
                        return JSON.stringify({
                                kind: "FIORI", report_id: oDef.reportId, report_name: oDef.reportName, service: oDef.servicePath,
                                params: oDef.params.map(function (p) {
                                        return {
                                                param_id: p.paramId, label: p.label, data_type: p.dataType, type_length: p.typeLength || 0,
                                                required: !!p.required, multi_value: !!p.multiValue, range_allowed: !!p.rangeAllowed,
                                                common_key: p.commonKey || "", enum_json: p.enumJson ? JSON.stringify(p.enumJson) : "",
                                                default_value: p.defaultValue || "", help_text: p.helpText || ""
                                        };
                                }),
                                values: mValues || {}
                        });
                },

                /** 演示的 OData 原始响应（按报表的形状造数，数字带前导空格，和 shipment 抓包一样） */
                _mockFioriRaw: function (oDef, mVals) {
                        var aSite = String(mVals.SITE || "").split(",").filter(Boolean);
                        if (oDef.reportId === "SHIPMENT") {
                                var aDims = String(mVals.DIM || "SHMODE").split(",").filter(Boolean);
                                var mDimVals = { SHMODE: ["D", "C"], REGION: ["APAC", "EMEA", "AMER"], SITE: aSite.length ? aSite : ["HHZZ", "HHCD"], BU: ["NB", "DT"], MODEL: ["M15", "M17"] };
                                var mDimLbl = { SHMODE: "Ship Mode", REGION: "Region", SITE: "SITE", BU: "BU", MODEL: "MODEL" };
                                var aR = String(mVals.DATE || "").split(",");
                                var sFrom = aR[0] || ymd(new Date()), sTo = aR[1] || sFrom;
                                var aMonths = [];
                                var y = +sFrom.substring(0, 4), mo = +sFrom.substring(4, 6);
                                while ((y * 100 + mo) <= +sTo.substring(0, 6) && aMonths.length < 12) {
                                        aMonths.push(y + pad2(mo));
                                        mo++; if (mo > 12) { mo = 1; y++; }
                                }
                                var aCombos = [[]];
                                aDims.forEach(function (k) {
                                        var aNext = [];
                                        aCombos.forEach(function (c) { (mDimVals[k] || ["-"]).forEach(function (v) { aNext.push(c.concat([v])); }); });
                                        aCombos = aNext.slice(0, 40);
                                });
                                var aCols = [];
                                aDims.forEach(function (k, i) {
                                        aCols.push({ Name: k, Description: mDimLbl[k] || k, Position: String(i + 1),
                                                DynamicDataSet: { results: aCombos.map(function (c) { return { Value: c[i] }; }) } });
                                });
                                aMonths.forEach(function (ym, j) {
                                        aCols.push({ Name: ym, Description: ym.substring(0, 4) + "-" + ym.substring(4), Position: String(aDims.length + j + 1),
                                                DynamicDataSet: { results: aCombos.map(function (c) {
                                                        // 抓包里那组：ship mode / 2026-10-15 / HHZZ → D = 139418、C = 33390
                                                        var n = (aDims.length === 1 && aDims[0] === "SHMODE" && sFrom === "20261015" && sTo === "20261015")
                                                                ? (c[0] === "D" ? 139418 : 33390)
                                                                : 1000 + hash(c.join("|") + ym) % 150000;
                                                        return { Value: ("           " + n).slice(-11) };
                                                }) } });
                                });
                                return { d: { results: aCols } };
                        }
                        if (oDef.reportId === "SO_BACKLOG") {
                                var aW = aSite.length ? aSite : ["1000", "2000"];
                                var aRows = [];
                                aW.forEach(function (w) {
                                        for (var i = 1; i <= 4; i++) {
                                                var h = hash(w + i);
                                                aRows.push({ __metadata: { type: "Backlog" }, Werks: w, Vbeln: "00" + (4500000 + h % 90000), Matnr: "M" + (100 + h % 800),
                                                        Kwmeng: String(10 + h % 900) + ".000", Netwr: ((h % 9000000) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",") });
                                        }
                                });
                                return { d: { results: aRows } };
                        }
                        if (oDef.reportId === "PO_OPEN") {
                                return { d: { results: [1, 2, 3].map(function (i) {
                                        return { __metadata: {}, Ebeln: "45000012" + i, Ebelp: "000" + i + "0", Werks: mVals.SITE || "1000", Menge: (5 * i) + "-", Eindt: "/Date(" + Date.UTC(2026, 9, 10 + i) + ")/" };
                                }) } };
                        }
                        return { d: { results: ["100001", "100002"].map(function (a, i) {
                                return { Werks: "1000", Aufnr: a, ToItems: { results: [1, 2].map(function (k) {
                                        var q = 100 * (i + k); return { Matnr: "FG" + i + k, Qty: String(q), Good: String(q - (3 * k + i)) };
                                }) } };
                        }) } };
                },

                /** 一次取数（幂等：同一 clientRequestId 返回同一结果） */
                _mockFioriRun: function (o) {
                        var Service = this;
                        var st = this._mockFioriState();
                        if (o.ClientRequestId && st.byRequest[o.ClientRequestId]) {
                                return st.runs[st.byRequest[o.ClientRequestId]].result;
                        }
                        var oDef = this._mockFioriDef(o.ReportId);
                        if (!oDef) { throw new Error("报表 " + (o.ReportId || "") + " 未登记或已停用"); }
                        var mVals = {};
                        try { mVals = JSON.parse(o.ParamsJson || "{}") || {}; } catch (e) { throw new Error("参数格式不正确"); }
                        var oF = this._fioriBuildFilter(oDef, mVals);
                        if (oF.error) { throw new Error(oF.error); }
                        var oDs = this._fioriShape(this._mockFioriRaw(oDef, mVals), oDef.shape, oDef.shapeCfg);
                        if (oDs.error) { throw new Error(oDs.error); }
                        st.seq++;
                        var sArt = "FART" + ("0000" + st.seq).slice(-4) + "0000000000000000000000000";
                        var sUri = oDef.servicePath + "/" + oDef.entitySet + "?$filter=" + encodeURIComponent(oF.filter) +
                                (oDef.expandNav ? "&$expand=" + oDef.expandNav : "") + "&$format=json";
                        var oRes = {
                                artifactId: sArt, runId: "FRUN" + st.seq, reportId: oDef.reportId, label: oDef.reportName,
                                status: "READY", schemaJson: JSON.stringify({ columns: oDs.columns }), rowsJson: JSON.stringify(oDs.rows),
                                rowCount: oDs.rows.length, truncated: "", elapsedMs: 300 + hash(sArt) % 900,
                                analyzeEnabled: oDef.analyzeEnabled, analyzed: "", requestUri: sUri, message: ""
                        };
                        st.runs[sArt] = {
                                result: oRes, ds: oDs, def: oDef, params: mVals, sessionId: o.SessionId, analyzed: false,
                                createdAt: Service._mockTime ? Service._mockTime() : "", summary: Service._fioriStats(oDs)
                        };
                        if (o.ClientRequestId) { st.byRequest[o.ClientRequestId] = sArt; }
                        this._mockFioriSave();
                        return oRes;
                },

                /** 三个 FI 的演示实现（_fioriCall 在演示模式下调用） */
                _mockFioriCall: function (sAction, o) {
                        var Service = this;
                        return new Promise(function (fnResolve, fnReject) {
                                setTimeout(function () {
                                        try {
                                                if (!Service._mockFioriEnabled()) {
                                                        if (sAction === "FioriReportDefs") {
                                                                fnResolve({ reports: [], message: "Fiori 报表能力未开启(FIORI_ENABLED)，请联系管理员" });
                                                                return;
                                                        }
                                                        throw new Error("Fiori 报表能力未开启(FIORI_ENABLED)，请联系管理员");
                                                }
                                                if (sAction === "FioriReportDefs") {
                                                        fnResolve({ reports: Service._mockFioriDefsList(), message: "" });
                                                } else if (sAction === "RunFioriReport") {
                                                        fnResolve(JSON.parse(JSON.stringify(Service._mockFioriRun(o))));
                                                } else if (sAction === "FioriReportResult") {
                                                        var oRun = Service._mockFioriState().runs[o.ArtifactId];
                                                        if (!oRun) { throw new Error("结果不存在或已过期"); }
                                                        fnResolve(JSON.parse(JSON.stringify(oRun.result)));
                                                } else {
                                                        throw new Error("未知的函数导入 " + sAction);
                                                }
                                        } catch (e) {
                                                fnReject(e);
                                        }
                                }, 250);
                        });
                },

                /* ===================== Agent 一轮（与 agent_turn 同口径） ===================== */

                /** 一句话找报表：报表名、关键词、分类、说明的包含匹配打分，取前 5 */
                _fioriCandidates: function (sQ) {
                        var q = String(sQ || "").toLowerCase().replace(/\s+/g, "");
                        if (!q) { return []; }
                        return DEFS.map(function (d) {
                                var n = d.reportName.toLowerCase().replace(/\s+/g, "");
                                var iScore = 0;
                                if (q.indexOf(n) >= 0) { iScore += 100; } else if (q.length >= 2 && n.indexOf(q) >= 0) { iScore += 60; }
                                String(d.keywords || "").split(",").forEach(function (k) {
                                        k = k.toLowerCase().replace(/\s+/g, "");
                                        if (k.length >= 2 && q.indexOf(k) >= 0) { iScore += 30; }
                                });
                                if (d.category && q.indexOf(d.category.toLowerCase()) >= 0) { iScore += 20; }
                                if (q.length >= 2 && String(d.description || "").toLowerCase().indexOf(q) >= 0) { iScore += 10; }
                                return { def: d, score: iScore };
                        }).filter(function (x) { return x.score > 0; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 5);
                },

                /**
                  * 确定性的一轮（不调模型）：返回 {kind: CARD|ANSWER|ANALYZE, answer, pending, run}
                  * 顺序：开关 → 选择报表 → 分析意图 → 重跑意图 → 已同意分析的追问 → 找报表 → 闸门提示 → 场景说明
                  */
                _fioriTurn: function (oPayload) {
                        var Service = this;
                        var sQ = String(oPayload.question || "").trim();
                        var st = this._mockFioriState();
                        if (!this._mockFioriEnabled()) {
                                return { kind: "ANSWER", answer: "【Fiori 报表能力未开启】系统当前未开放 Fiori 报表(FIORI_ENABLED)。可以联系管理员在 ZAI_CHAT_CFG 中维护该配置后再试。" };
                        }
                        var mSel = /^选择报表\s*[:：]\s*(.+)$/.exec(sQ);
                        if (mSel) {
                                var sName = mSel[1].trim();
                                var oHit = DEFS.filter(function (d) { return d.reportName === sName; })[0];
                                if (!oHit) {
                                        return { kind: "ANSWER", answer: "没有找到名为「" + sName + "」的 Fiori 报表（可能已停用）。请在目录里重新选择。" };
                                }
                                return Service._fioriCardTurn(oHit, Service._fioriDefaults(oHit), "");
                        }
                        // 本会话要分析的结果：前端聚焦的结果优先，否则最近一份
                        var oRun = st.runs[oPayload.focusedArtifactId || ""];
                        if (!oRun || oRun.sessionId !== oPayload.sessionId) {
                                oRun = null;
                                Object.keys(st.runs).forEach(function (k) {
                                        if (st.runs[k].sessionId === oPayload.sessionId) { oRun = st.runs[k]; }
                                });
                        }
                        var bAnalyze = /分析|解读|总结|洞察/.test(sQ) && /这|该|结果|数据|上面|刚才|一下|报表/.test(sQ);
                        if (oRun && bAnalyze) {
                                if (oRun.def.analyzeEnabled !== "X") {
                                        return { kind: "ANSWER", answer: "这张报表「" + oRun.def.reportName + "」未开放模型分析（登记里 ANALYZE_ENABLED 为空），数据不会发给模型。可以用表格、图表和导出自行查看。" };
                                }
                                oRun.analyzed = true;
                                oRun.result.analyzed = "X";
                                this._mockFioriSave();
                                return { kind: "ANALYZE", run: oRun };
                        }
                        if (oRun && /重新取|重取|再取|再查|再跑|重跑|换成|改成|换个|再看/.test(sQ)) {
                                return Service._fioriCardTurn(oRun.def, oRun.params, "按「" + oRun.def.reportName + "」重新取数：");
                        }
                        if (oRun && oRun.analyzed) {
                                return { kind: "ANALYZE", run: oRun };
                        }
                        var aCand = Service._fioriCandidates(sQ);
                        if (aCand.length === 1 || (aCand.length > 1 && aCand[0].score >= 100 && aCand[1].score < 100)) {
                                return Service._fioriCardTurn(aCand[0].def, Service._fioriDefaults(aCand[0].def), "");
                        }
                        if (aCand.length > 1) {
                                return { kind: "ANSWER", answer: "找到 " + aCand.length + " 张相关的 Fiori 报表，请选择要用哪一张？\n" +
                                        aCand.map(function (c, i) { return (i + 1) + ". 选择报表：" + c.def.reportName; }).join("\n") };
                        }
                        if (oRun) {
                                return { kind: "ANSWER", answer: "这份结果「" + oRun.def.reportName + "」还没有交给模型（模型目前只知道行数和列名）。如需让我解读数据，请点结果下方的「交给模型分析」，再继续提问。" };
                        }
                        var aCats = [];
                        DEFS.forEach(function (d) { if (aCats.indexOf(d.category) < 0) { aCats.push(d.category); } });
                        return { kind: "ANSWER", answer: "当前是「Fiori 报表」场景。可以这样用：\n1. 在首页的报表目录里点一张报表，确认参数后取数；\n" +
                                "2. 直接说报表名或业务，例如「出货」；\n3. 取数后点「交给模型分析」，再追问。\n\n已登记 " + DEFS.length + " 张报表：" + aCats.join("、") + "。\n" +
                                "执行 TCode 报表请新建「报表执行」场景，查表 / 写 SQL 请新建「数据分析」场景。" };
                },

                _fioriCardTurn: function (oDef, mValues, sLead) {
                        return {
                                kind: "CARD",
                                answer: (sLead || "") + "【" + oDef.reportName + "】" + oDef.category + "\n" + oDef.description +
                                        "\n\n请在下方卡片里确认参数后点「取数」。取数只读，数据不会发给模型。",
                                pending: this._fioriPendingJson(oDef, mValues)
                        };
                },

                /** 演示的"模型分析"回答：只用后端统计里的数字 */
                _fioriMockAnalysis: function (oRun, sQ) {
                        var s = oRun.summary;
                        var a = ["【演示模式】以下解读只用了后端统计（真实环境由模型基于统计 + 最多 200 行数据回答）：", ""];
                        a.push("◆ 「" + oRun.def.reportName + "」共 " + s.rowCount + " 行" + (s.dimension ? "，按「" + s.dimension + "」看" : "") + "。");
                        s.numeric.slice(-3).forEach(function (n) {
                                a.push("◆ " + n.label + "：合计 " + n.sum + "，最大 " + n.max + (n.maxAt ? "（" + n.maxAt + "）" : "") + "，最小 " + n.min + (n.minAt ? "（" + n.minAt + "）" : "") + "。");
                        });
                        if (s.top.length) {
                                a.push("◆ " + s.valueColumn + " 前几名：" + s.top.slice(0, 3).map(function (t) { return t.key + " " + t.value + "（" + t.share + "%）"; }).join("、") + "。");
                        }
                        s.columnTrend.slice(-2).forEach(function (t) {
                                if (t.change !== null) { a.push("◆ " + t.from + " → " + t.to + "：合计变化 " + t.change + "%。"); }
                        });
                        if (!/分析|解读|总结|洞察/.test(sQ)) {
                                a.push("", "（针对你的追问「" + sQ + "」：演示模式不调用模型，只回显上面的统计。）");
                        }
                        return a.join("\n");
                },

                /** 「Fiori 报表」会话的演示 Agent（_mockSendAgent 遇到 FIORI 会话转过来） */
                _mockFioriAgent: function (oPayload) {
                        var Service = this;
                        return new Promise(function (fnResolve) {
                                setTimeout(function () {
                                        var oT = Service._fioriTurn(oPayload);
                                        var sAnswer = oT.kind === "ANALYZE" ? Service._fioriMockAnalysis(oT.run, String(oPayload.question || "")) : oT.answer;
                                        var aTrace = [{ phase: "UNDERSTANDING", label: "理解问题", status: "OK", elapsedMs: 0 }];
                                        aTrace.push(oT.kind === "ANALYZE"
                                                ? { phase: "COMPOSING", label: "分析报表结果（用户已同意）", status: "OK", elapsedMs: 900 }
                                                : { phase: "COMPOSING", label: oT.kind === "CARD" ? "整理报表参数" : "Fiori 报表场景", status: "OK", elapsedMs: 0 });
                                        var oStore = Service._mockStore();
                                        var aHist = oStore.messages[oPayload.sessionId] = oStore.messages[oPayload.sessionId] || [];
                                        var sNow = Service._mockTime();
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "user", Content: oPayload.question, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        aHist.push({ SessionId: oPayload.sessionId, MsgSeq: "", Role: "assistant", Content: sAnswer, ProgramName: "AGENT", CreatedAt: sNow, Status: "OK" });
                                        var oSess = oStore.sessions.filter(function (s) { return s.SessionId === oPayload.sessionId; })[0];
                                        if (!oSess) {
                                                oStore.sessions.unshift({
                                                        SessionId: oPayload.sessionId,
                                                        Title: oPayload.question.length > 24 ? oPayload.question.substring(0, 24) + "…" : oPayload.question,
                                                        ModelId: oPayload.modelId || "", MsgCount: "2", CreatedAt: sNow, ChangedAt: sNow,
                                                        Mode: "AGENT", AgentType: "FIORI", Status: "COMPLETED"
                                                });
                                        } else {
                                                oSess.ChangedAt = sNow;
                                                oSess.MsgCount = String((parseInt(oSess.MsgCount || "0", 10) || 0) + 2);
                                                oSess.Status = "COMPLETED";
                                        }
                                        Service._mockSave(oStore);
                                        var bCard = oT.kind === "CARD";
                                        var bTask = bCard || oT.kind === "ANALYZE";   // 场景说明 / 闸门提示不挂任务（后端 finish_det 传空任务）
                                        fnResolve({
                                                answer: sAnswer, status: "OK", elapsedMs: oT.kind === "ANALYZE" ? 1500 : 0,
                                                rounds: oT.kind === "ANALYZE" ? 1 : 0, message: "", modelId: oPayload.modelId || "AUTO",
                                                trace: aTrace, analysis: null,
                                                taskId: bTask ? "FTASK" + String(oPayload.sessionId || "").substring(0, 8) : "",
                                                taskModule: "FIORI", taskStatus: bCard ? "WAITING_INPUT" : "COMPLETED",
                                                needsInput: bCard, pendingParamsJson: bCard ? oT.pending : "", artifactRefsJson: ""
                                        });
                                }, 500);
                        });
                }
        };
});
