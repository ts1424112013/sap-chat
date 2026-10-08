sap.ui.define([
        "sap/m/Dialog",
        "sap/m/Button",
        "sap/m/HBox",
        "sap/m/VBox",
        "sap/m/Label",
        "sap/m/Text",
        "sap/m/Select",
        "sap/m/MultiComboBox",
        "sap/m/Input",
        "sap/m/Switch",
        "sap/ui/core/Item",
        "sap/ui/core/HTML",
        "zai/chat/utils/ChartRenderer"
], function (Dialog, Button, HBox, VBox, Label, Text, Select, MultiComboBox, Input, Switch, Item, HTML, ChartRenderer) {
        "use strict";

        /**
         * V16：图表配置面板 —— 用户自己决定画什么图。
         * 左：图表类型 / X 轴 / 指标 / 汇总 / 排序 / Top N / 配色 / 数值标签 / 标题
         * 右：实时预览（每次改动立即重绘）
         */
        function field(sLabel, oCtrl) {
                return new VBox({ items: [new Label({ text: sLabel }).addStyleClass("cbLabel"), oCtrl] }).addStyleClass("cbField");
        }

        function selectOf(aItems, sKey, fnChange) {
                var oSel = new Select({ width: "100%", selectedKey: sKey, change: fnChange });
                aItems.forEach(function (o) { oSel.addItem(new Item({ key: o.key, text: o.text })); });
                return oSel;
        }

        /**
         * @param {object} oDs 数据集 {name, columns, rows}
         * @param {object} oInit 初始配置（编辑已有图表 / 后端推荐类型），可空
         * @param {function} fnDone 回调 fnDone(oCfg)
         * @param {object} [oOpt] {edit:boolean}
         */
        function open(oDs, oInit, fnDone, oOpt) {
                var oA = ChartRenderer.analyze(oDs);
                var c = {
                        type: oA.type, x: oA.x, y: oA.y.slice(), agg: oA.agg, sort: "none", top: 0,
                        palette: "gale", showValues: true, title: ""
                };
                Object.keys(oInit || {}).forEach(function (k) {
                        if (oInit[k] !== undefined && oInit[k] !== null) { c[k] = oInit[k]; }
                });
                c.y = (c.y || []).filter(function (i) { return oA.numeric.indexOf(i) >= 0 && i !== c.x; });
                if (!c.y.length && c.agg !== "count") {
                        c.agg = oA.numeric.filter(function (i) { return i !== c.x; }).length ? c.agg : "count";
                        c.y = oA.numeric.filter(function (i) { return i !== c.x; }).slice(0, 1);
                }

                var oPreview = new HTML({ content: '<div class="cbPreviewBody"></div>', sanitizeContent: false, preferDOM: false });
                var oNote = new Text({ text: "" }).addStyleClass("cbNote");
                var fnUpdate = function () {
                        var o = ChartRenderer.render(oDs, c);
                        var oDom = oPreview.getDomRef();
                        if (oDom) {
                                oDom.innerHTML = o.svg || '<div class="cbEmpty">' + (o.note || "无可绘制数据") + "</div>";
                        }
                        oNote.setText(o.svg ? (o.note || "") : "");
                        oYBox.setEnabled(c.agg !== "count");
                        oShow.setEnabled(c.type !== "pie" && c.type !== "donut");
                };

                // —— 图表类型：2×3 方块选择（当前项高亮） ——
                var aTypeBtns = [];
                var oTypeGrid = new HBox({ wrap: "Wrap" }).addStyleClass("cbTypes");
                ChartRenderer.TYPES.forEach(function (t) {
                        var oBtn = new Button({
                                icon: t.icon, text: t.text, type: "Transparent",
                                press: function () {
                                        c.type = t.key;
                                        aTypeBtns.forEach(function (b) { b.toggleStyleClass("cbTypeOn", b === oBtn); });
                                        fnUpdate();
                                }
                        }).addStyleClass("cbType");
                        oBtn.toggleStyleClass("cbTypeOn", t.key === c.type);
                        aTypeBtns.push(oBtn);
                        oTypeGrid.addItem(oBtn);
                });

                var aColItems = (oDs.columns || []).map(function (col, i) {
                        return { key: String(i), text: ChartRenderer.colLabel(oDs, i) };
                });
                var oXSel = selectOf(aColItems, String(c.x), function (e) {
                        c.x = parseInt(e.getParameter("selectedItem").getKey(), 10);
                        c.y = c.y.filter(function (i) { return i !== c.x; });
                        fnUpdate();
                });
                var oYBox = new MultiComboBox({
                        width: "100%",
                        placeholder: oA.numeric.length ? "选择 1~4 个数值字段" : "无数值字段，按记录数统计",
                        selectedKeys: c.y.map(String),
                        selectionFinish: function () {
                                c.y = oYBox.getSelectedKeys().map(function (k) { return parseInt(k, 10); })
                                        .filter(function (i) { return i !== c.x; }).slice(0, 4);
                                fnUpdate();
                        }
                });
                oA.numeric.forEach(function (i) {
                        oYBox.addItem(new Item({ key: String(i), text: ChartRenderer.colLabel(oDs, i) }));
                });
                var oAgg = selectOf([
                        { key: "none", text: "不汇总（逐行）" }, { key: "sum", text: "按 X 求和" },
                        { key: "avg", text: "按 X 平均" }, { key: "count", text: "按 X 计数" }
                ], c.agg, function (e) { c.agg = e.getParameter("selectedItem").getKey(); fnUpdate(); });
                var oSort = selectOf([
                        { key: "none", text: "原始顺序" }, { key: "desc", text: "从大到小" }, { key: "asc", text: "从小到大" }
                ], c.sort, function (e) { c.sort = e.getParameter("selectedItem").getKey(); fnUpdate(); });
                var oTop = selectOf([
                        { key: "0", text: "全部" }, { key: "5", text: "前 5" }, { key: "10", text: "前 10" }, { key: "20", text: "前 20" }
                ], String(c.top || 0), function (e) { c.top = parseInt(e.getParameter("selectedItem").getKey(), 10); fnUpdate(); });
                var oPal = selectOf(ChartRenderer.PALETTES, c.palette, function (e) {
                        c.palette = e.getParameter("selectedItem").getKey(); fnUpdate();
                });
                var oShow = new Switch({ state: c.showValues !== false, customTextOn: " ", customTextOff: " ",
                        change: function (e) { c.showValues = e.getParameter("state"); fnUpdate(); } });
                var oTitle = new Input({ width: "100%", value: c.title, placeholder: oDs.name || "图表标题",
                        liveChange: function (e) { c.title = e.getParameter("value"); } });

                var oForm = new VBox({
                        items: [
                                field("图表类型", oTypeGrid),
                                new HBox({ items: [field("X 轴 / 分类", oXSel), field("汇总方式", oAgg)] }).addStyleClass("cbRow"),
                                field("指标（Y 轴）", oYBox),
                                new HBox({ items: [field("排序", oSort), field("显示数量", oTop)] }).addStyleClass("cbRow"),
                                new HBox({ items: [field("配色", oPal), field("数值标签", oShow)] }).addStyleClass("cbRow"),
                                field("标题", oTitle)
                        ]
                }).addStyleClass("cbForm");

                var oDlg = new Dialog({
                        title: oOpt && oOpt.edit ? "编辑图表" : "生成图表",
                        contentWidth: "60rem",
                        resizable: true,
                        draggable: true,
                        content: [new HBox({
                                items: [oForm, new VBox({
                                        items: [new Text({ text: "预览 · " + (oDs.name || "数据集") + " · " + (oDs.rows || []).length + " 行" }).addStyleClass("cbPreviewHead"),
                                                oPreview, oNote]
                                }).addStyleClass("cbPreview")]
                        }).addStyleClass("cbBody")],
                        beginButton: new Button({
                                text: oOpt && oOpt.edit ? "更新图表" : "插入对话",
                                type: "Emphasized",
                                press: function () {
                                        if (!ChartRenderer.render(oDs, c).svg) {
                                                return;
                                        }
                                        oDlg.close();
                                        fnDone(jQuery.extend(true, {}, c));
                                }
                        }),
                        endButton: new Button({ text: "取消", press: function () { oDlg.close(); } }),
                        afterOpen: fnUpdate,
                        afterClose: function () { oDlg.destroy(); }
                }).addStyleClass("chartBuilderDlg");
                oDlg.open();
        }

        return { open: open };
});
