sap.ui.define([
        "sap/m/VBox",
        "sap/m/HBox",
        "sap/m/Text",
        "sap/m/Label",
        "sap/m/Input",
        "sap/m/DatePicker",
        "sap/m/Button",
        "sap/m/ToggleButton",
        "sap/ui/core/Icon",
        "sap/m/ResponsivePopover",
        "sap/ui/core/HTML",
        "sap/m/TextArea"
], function (VBox, HBox, Text, Label, Input, DatePicker, Button, ToggleButton, Icon, ResponsivePopover, HTML, TextArea) {
        "use strict";

        /**
         * V16：对话内联「需要你确认」卡片（参考 Agent 权限确认交互）
         * 两种形态：
         *   params —— 报表待填参数：内联表单 + 编号操作（提交执行 / 先不执行 / 告诉 Agent…）
         *   choice —— 意图不明确：编号选项 + 自由输入（选择即作为下一条消息发送）
         * 键盘：↑↓ / Tab 切换选项，1~9 直选，Enter 确认（输入框内回车不抢占）
         * 状态：open → busy（提交中）→ done / cancelled（折叠为一行结论）
         * 卡片只负责交互与收集，业务动作由控制器 onAction(oAsk, oPick) 执行。
         * 20261020（Fiori 报表）：参数 data_type = ENUM 时按 enum_json（[{key,text}]）渲染成可点选的标签，
         * multi_value 决定单选 / 多选，提交值为选项 key 逗号拼接；oAsk.values 可预填（重跑时带上次的参数）。
         * 20261024（10.24 记录 #03a）：报表选择项 + 参数卡重新排版 ——
         *  · data_type = BOOL（复选框，SEL_KIND C）→ 开关胶囊，提交 "X" / ""（空 = 不勾，后端会明确下发空格）
         *  · 排版：单选组（单选 ENUM）在最上，必填项随后，开关集中一行，选填项超过 1 个且总数多时
         *    折进「更多筛选条件（N）」（有预填值时自动展开）；字段少时与原来一样全部平铺
         *  · mergeParamDefs：TCode 报表的待填参数（Agent 只给类型）按 ReportDefinitions 补选项 / 默认值 / 说明
         * 20261027（10.27 记录 #04）：复选框按原选择屏的块分组 —— 参数定义带 group_label（块标题，
         *   SCANNER V1.0b 登记、REPORT_SERVICE V1.0.15 透出）时，每块一行、块标题作行标签；都没有时仍是一行「选项」
         * 20261103（参数搜索帮助）：oAsk.vh = {参数编号大写: true} 标出有搜索帮助的参数（控制器按 ValueHelp 元数据填），
         *   这些输入框右侧出现小方块按钮（和 SAP GUI 的 F4 一样，焦点在框里按 F4 也能打开），点开是自绘弹层：
         *   搜索框 + 「编号 / 名称」列表；单值点一行即填入，多值勾选后「填入」。取值由 setValueHelp 注入的函数负责
         */

        /* =================================================================
         * 20261104（函数表参数粘贴数据，功能计划书/RFC函数执行/05）：data_type = TABLE 的参数是粘贴框，
         * 从 Excel / ALV 复制几行粘进来；第一行对得上字段（字段名或中文名）就当标题，否则按列顺序。
         * 提交值 = JSON 数组的数组，第一行是字段名：[["MATNR","WERKS"],["100234","1000"]]
         * 列定义来自 oAsk.tcols[参数编号大写]（控制器按 ValueHelp 元数据填）；没有时第一行必须写字段名。
         * ================================================================= */
        var TBL_MAX_ROWS = 1000;

        function isTable(oP) {
                return String((oP && oP.data_type) || "").toUpperCase() === "TABLE";
        }

        /** Excel 复制出来的 TSV → 行（支持带引号的格子：里面的换行 / Tab / 两个引号） */
        function parseTsv(sText) {
                var s = String(sText || "").replace(/\r\n?/g, "\n");
                var aRows = [], aRow = [], sCell = "", bQ = false, i = 0;
                for (; i < s.length; i++) {
                        var c = s.charAt(i);
                        if (bQ) {
                                if (c === '"') {
                                        if (s.charAt(i + 1) === '"') { sCell += '"'; i++; } else { bQ = false; }
                                } else {
                                        sCell += c;
                                }
                        } else if (c === '"' && sCell === "") {
                                bQ = true;
                        } else if (c === "\t") {
                                aRow.push(sCell); sCell = "";
                        } else if (c === "\n") {
                                aRow.push(sCell); aRows.push(aRow); aRow = []; sCell = "";
                        } else {
                                sCell += c;
                        }
                }
                if (sCell !== "" || aRow.length) {
                        aRow.push(sCell);
                        aRows.push(aRow);
                }
                return aRows.map(function (r) {
                        return r.map(function (x) { return String(x).replace(/[\r\n\t]+/g, " ").trim(); });
                }).filter(function (r) { return r.some(Boolean); });
        }

        /**
          * 粘贴内容 → 提交值。
          * @param {string} sText 粘贴的原文
          * @param {object[]} aCols 列定义 [{name, label}]（可空）
          * @param {boolean} bSingle 结构参数：只收一行
          * @returns {{ok, json, header:string[], labels:string[], rows:string[][], count, unknown:string[], note, error, byOrder}}
          */
        function parsePaste(sText, aCols, bSingle) {
                var out = { ok: false, json: "", header: [], labels: [], rows: [], count: 0, unknown: [], note: "", error: "", byOrder: false };
                var aLines = parseTsv(sText);
                if (!aLines.length) {
                        return out;
                }
                var aC = (aCols || []).filter(function (c) { return c && c.name; });
                var fnNorm = function (x) { return String(x || "").replace(/\s+/g, "").toUpperCase(); };
                var fnFind = function (h) {
                        var k = fnNorm(h);
                        return k ? aC.filter(function (c) { return fnNorm(c.name) === k || fnNorm(c.label) === k; })[0] : null;
                };
                var aFirst = aLines[0];
                var aHits = aFirst.map(fnFind);
                var bHeader = !aC.length || aHits.some(Boolean);
                var aMap, aData;
                if (bHeader) {
                        aMap = aFirst.map(function (h, i) {
                                if (aC.length) { return aHits[i] ? aHits[i].name : null; }
                                var k = String(h || "").trim().toUpperCase();
                                return /^[A-Z0-9_\/]+$/.test(k) ? k : null;
                        });
                        out.unknown = aFirst.filter(function (h, i) { return !aMap[i] && String(h || "").trim(); });
                        aData = aLines.slice(1);
                        if (!aC.length && aMap.every(function (x) { return !x; })) {
                                out.error = "第一行要写字段名（如 MATNR），后面每行一条数据";
                                return out;
                        }
                } else {
                        out.byOrder = true;
                        var iW = aLines.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
                        if (iW > aC.length) {
                                out.error = "粘贴了 " + iW + " 列，这张表只有 " + aC.length + " 列；第一行写上标题可以只填其中几列";
                                return out;
                        }
                        aMap = aC.slice(0, iW).map(function (c) { return c.name; });
                        aData = aLines;
                }
                var aIdx = [];
                aMap.forEach(function (f, i) { if (f) { aIdx.push(i); } });
                if (!aIdx.length) {
                        out.error = "第一行的标题一个也没对上字段";
                        return out;
                }
                var aHead = aIdx.map(function (i) { return aMap[i]; });
                var aDup = aHead.filter(function (f, i) { return aHead.indexOf(f) !== i; });
                if (aDup.length) {
                        out.error = "字段 " + aDup[0] + " 出现了两次";
                        return out;
                }
                var aRows = aData.map(function (r) {
                        return aIdx.map(function (i) { return r[i] === undefined ? "" : r[i]; });
                }).filter(function (r) { return r.some(Boolean); });
                if (!aRows.length) {
                        out.error = "只有标题，没有数据行";
                        return out;
                }
                if (bSingle && aRows.length > 1) {
                        out.note = "这个参数只收一行，只用第一行";
                        aRows = aRows.slice(0, 1);
                }
                if (aRows.length > TBL_MAX_ROWS) {
                        out.error = "超过 " + TBL_MAX_ROWS + " 行，请分批";
                        return out;
                }
                out.header = aHead;
                out.labels = aHead.map(function (f) {
                        var c = aC.filter(function (x) { return x.name === f; })[0];
                        return c && c.label && c.label !== f ? c.label : f;
                });
                out.rows = aRows;
                out.count = aRows.length;
                out.json = JSON.stringify([aHead].concat(aRows));
                out.ok = true;
                return out;
        }

        /** 粘贴预览（前 8 行） */
        function pastePreviewHtml(res, aCols) {
                if (!res || (!res.ok && !res.error)) {
                        return "<div class=\"askPastePrev askPasteEmpty\"></div>";
                }
                if (!res.ok) {
                        return "<div class=\"askPastePrev\"><div class=\"askPasteErr\">" + escHtml(res.error) + "</div></div>";
                }
                var sHead = res.header.map(function (f, i) {
                        return "<th>" + escHtml(res.labels[i]) + (res.labels[i] !== f ? "<span>" + escHtml(f) + "</span>" : "") + "</th>";
                }).join("");
                var sBody = res.rows.slice(0, 8).map(function (r) {
                        return "<tr>" + r.map(function (x) { return "<td>" + escHtml(x) + "</td>"; }).join("") + "</tr>";
                }).join("");
                var aNote = ["共 " + res.count + " 行" + (res.byOrder ? " · 按列顺序对应" : "")];
                if (res.count > 8) { aNote.push("预览前 8 行"); }
                if (res.unknown.length) { aNote.push("没对上的列不提交：" + res.unknown.slice(0, 5).join("、")); }
                if (res.note) { aNote.push(res.note); }
                return "<div class=\"askPastePrev\"><div class=\"askPasteScroll\"><table><thead><tr>" + sHead + "</tr></thead><tbody>" + sBody +
                        "</tbody></table></div><div class=\"askPasteNote" + (res.unknown.length || res.note ? " askPasteWarn" : "") + "\">" +
                        escHtml(aNote.join(" · ")) + "</div></div>";
        }

        /** 列说明：「列：物料 MATNR、工厂 WERKS…」 */
        function pasteColsText(aCols) {
                var a = (aCols || []).filter(function (c) { return c && c.name; });
                if (!a.length) {
                        return "第一行写字段名（如 MATNR、WERKS），后面每行一条数据";
                }
                if (a.length === 1 && a[0].name === "TABLE_LINE") {
                        return "每行一个" + (a[0].label && a[0].label !== "TABLE_LINE" ? a[0].label : "值");
                }
                var sList = a.slice(0, 8).map(function (c) {
                        return c.label && c.label !== c.name ? c.label + " " + c.name : c.name;
                }).join("、");
                return "列：" + sList + (a.length > 8 ? " 等 " + a.length + " 列" : "") + "。第一行写标题可以只填其中几列、顺序随意";
        }

        /** 表参数控件：粘贴框 + 列说明 + 预览 */
        function buildTable(oP, mVals, bMarkErr, oAsk) {
                var sId = oP.param_id;
                var sKey = String(sId || "").toUpperCase();
                var aCols = (oAsk && oAsk.tcols && oAsk.tcols[sKey]) || [];
                var bSingle = oP.multi_value === false;
                oAsk.paste = oAsk.paste || {};
                var sRaw = oAsk.paste[sId] || "";
                var oRec = { id: sId, label: oP.label || sId, required: oP.required === true, table: true, res: parsePaste(sRaw, aCols, bSingle) };
                var oPrev = new HTML({ content: pastePreviewHtml(oRec.res, aCols), preferDOM: false });
                var oTa = new TextArea({
                        value: sRaw,
                        width: "100%",
                        rows: 3,
                        growing: true,
                        growingMaxLines: 8,
                        placeholder: bSingle ? "从 Excel 复制一行粘到这里（可以带标题行）" : "从 Excel / SAP 表格复制几行粘到这里（可以带标题行）"
                }).addStyleClass("askPasteInput");
                oTa.attachLiveChange(function (e) {
                        var v = e.getParameter("value") || "";
                        oAsk.paste[sId] = v;
                        oRec.res = parsePaste(v, aCols, bSingle);
                        mVals[sId] = oRec.res.ok ? oRec.res.json : "";
                        oTa.setValueState("None");
                        oPrev.setContent(pastePreviewHtml(oRec.res, aCols));
                });
                mVals[sId] = oRec.res.ok ? oRec.res.json : "";
                if (bMarkErr && ((oRec.required && !oRec.res.ok) || oRec.res.error)) {
                        oTa.setValueState("Error");
                }
                oRec.ta = oTa;
                oRec.cell = new VBox({
                        items: [
                                new Label({ text: oRec.label, required: oRec.required, wrapping: true }).addStyleClass("askFieldLabel"),
                                new VBox({ items: [new Text({ text: pasteColsText(aCols) }).addStyleClass("askPasteCols"), oTa, oPrev] })
                                        .addStyleClass("askPasteBox")
                        ]
                }).addStyleClass("askField askFieldTable");
                return oRec;
        }

        /** 20261103：搜索帮助取值函数 fn(oAsk, sParamId, sQuery) → Promise<{items, keyLabel, textLabel, source, sourceName, message, truncated}> */
        var fnValueHelp = null;

        function setValueHelp(fn) {
                fnValueHelp = typeof fn === "function" ? fn : null;
        }

        function hasValueHelp(oAsk, sId) {
                return !!(fnValueHelp && oAsk && oAsk.vh && oAsk.vh[String(sId || "").toUpperCase()] === true);
        }

        function escHtml(s) {
                return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
                        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
                });
        }

        var VH_SOURCE = { SHLP: "搜索帮助", CHECK: "检查表", FIXED: "固定值" };

        /**
          * 20261103：搜索帮助弹层（自绘列表）。
          * @param {sap.ui.core.Control} oOpener 输入框
          * @param {object} o {title, multi, current: string[], load: fn(q) → Promise, onPick: fn(string[])}
          */
        function openPicker(oOpener, o) {
                var aItems = [];
                var iSel = 0;
                var iReq = 0;
                var tDeb = null;
                var oLast = null;
                var aChecked = (o.current || []).slice();
                var oSearch = new Input({ placeholder: "输入编号或名称搜索", width: "100%", showClearIcon: true }).addStyleClass("vhSearch");
                var oList = new HTML({ content: "<div class=\"vhList\"></div>", preferDOM: false });
                var oStatus = new Text({ text: "加载中…" }).addStyleClass("vhStatus");
                var oFill = null;
                var oPop;

                var bHadValue = aChecked.length > 0;
                // 原来有值、全部取消勾选 = 清空；原来没值又没勾 = 灰掉
                var fnFillText = function () {
                        return aChecked.length ? "填入（" + aChecked.length + "）" : (bHadValue ? "清空" : "填入");
                };
                var fnFillSync = function () {
                        oFill.setText(fnFillText());
                        oFill.setEnabled(aChecked.length > 0 || bHadValue);
                };
                var fnRowHtml = function (it, i) {
                        var bChk = o.multi && aChecked.indexOf(it.key) >= 0;
                        return "<div class=\"vhRow" + (i === iSel ? " vhOn" : "") + (bChk ? " vhChk" : "") + "\" data-i=\"" + i + "\" role=\"option\">" +
                                (o.multi ? "<span class=\"vhBox\"></span>" : "") +
                                "<span class=\"vhKey\">" + escHtml(it.display || it.key) + "</span>" +
                                "<span class=\"vhText\">" + escHtml(it.text) + "</span></div>";
                };
                var fnPaint = function () {
                        var sHead = "";
                        if (aItems.length && oLast) {
                                sHead = "<div class=\"vhHead\">" + (o.multi ? "<span class=\"vhBox vhBoxHead\"></span>" : "") +
                                        "<span class=\"vhKey\">" + escHtml(oLast.keyLabel || "编号") + "</span>" +
                                        "<span class=\"vhText\">" + escHtml(oLast.textLabel || "") + "</span></div>";
                        }
                        oList.setContent("<div class=\"vhList\" role=\"listbox\">" + sHead + aItems.map(fnRowHtml).join("") + "</div>");
                };
                var fnMark = function () {
                        var oDom = oList.getDomRef();
                        if (!oDom) { return; }
                        Array.prototype.forEach.call(oDom.querySelectorAll(".vhRow"), function (el) {
                                var i = parseInt(el.getAttribute("data-i"), 10);
                                el.classList.toggle("vhOn", i === iSel);
                                el.classList.toggle("vhChk", !!o.multi && aChecked.indexOf((aItems[i] || {}).key) >= 0);
                                if (i === iSel && el.scrollIntoView) { el.scrollIntoView({ block: "nearest" }); }
                        });
                };
                var fnChoose = function (i) {
                        var it = aItems[i];
                        if (!it) { return; }
                        if (!o.multi) {
                                o.onPick([it.key]);
                                oPop.close();
                                return;
                        }
                        var k = aChecked.indexOf(it.key);
                        if (k >= 0) { aChecked.splice(k, 1); } else { aChecked.push(it.key); }
                        iSel = i;
                        fnMark();
                        fnFillSync();
                };
                var fnLoad = function (q) {
                        var n = ++iReq;
                        oStatus.setText(q ? "搜索中…" : "加载中…");
                        Promise.resolve(o.load(q)).then(function (r) {
                                if (n !== iReq || !oPop || oPop.isDestroyed()) { return; }
                                oLast = r || {};
                                aItems = (oLast.items || []).slice(0, 200);
                                iSel = 0;
                                fnPaint();
                                var aBits = [oLast.message || (aItems.length ? "共 " + aItems.length + " 条" : "没有可选值")];
                                if (aItems.length && oLast.source) {
                                        aBits.push((VH_SOURCE[oLast.source] || oLast.source) + (oLast.sourceName ? " " + oLast.sourceName : ""));
                                }
                                oStatus.setText(aBits.join(" · "));
                        }).catch(function (e) {
                                if (n !== iReq || !oPop || oPop.isDestroyed()) { return; }
                                aItems = [];
                                fnPaint();
                                oStatus.setText("取值失败：" + ((e && e.message) || e));
                        });
                };

                // HTML 控件 setContent 会直接替换 DOM（不走重渲染），点击挂在外层容器上
                var oListBox = new VBox({ items: [oList] }).addStyleClass("vhListBox");
                oListBox.attachBrowserEvent("click", function (ev) {
                        var el = ev.target.closest && ev.target.closest(".vhRow");
                        if (el) { fnChoose(parseInt(el.getAttribute("data-i"), 10)); }
                });
                oSearch.attachLiveChange(function (e) {
                        var v = e.getParameter("value") || "";
                        clearTimeout(tDeb);
                        tDeb = setTimeout(function () { fnLoad(v.trim()); }, 300);
                });
                oSearch.attachBrowserEvent("keydown", function (ev) {
                        if (ev.isComposing || ev.keyCode === 229) { return; }
                        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                                ev.preventDefault();
                                if (!aItems.length) { return; }
                                iSel = (iSel + (ev.key === "ArrowDown" ? 1 : -1) + aItems.length) % aItems.length;
                                fnMark();
                        } else if (ev.key === "Enter") {
                                ev.preventDefault();
                                fnChoose(iSel);
                        }
                });

                var aFoot = [oStatus];
                if (o.multi) {
                        oFill = new Button({
                                text: fnFillText(),
                                type: "Emphasized",
                                press: function () {
                                        o.onPick(aChecked.slice());
                                        oPop.close();
                                }
                        }).addStyleClass("vhFill");
                        fnFillSync();
                        aFoot.push(oFill);
                }
                oPop = new ResponsivePopover({
                        showHeader: false,
                        placement: "VerticalPreferredBottom",
                        contentWidth: "26rem",
                        horizontalScrolling: false,
                        verticalScrolling: false,
                        content: [new VBox({
                                items: [
                                        new Text({ text: o.title || "" }).addStyleClass("vhTitle"),
                                        oSearch,
                                        oListBox,
                                        new HBox({ alignItems: "Center", justifyContent: "SpaceBetween", items: aFoot }).addStyleClass("vhFoot")
                                ]
                        }).addStyleClass("vhPanel")],
                        afterOpen: function () { oSearch.focus(); },
                        afterClose: function () {
                                clearTimeout(tDeb);
                                setTimeout(function () {
                                        if (oPop && !oPop.isDestroyed()) { oPop.destroy(); }
                                        if (oOpener && !oOpener.isDestroyed() && oOpener.focus) { oOpener.focus(); }
                                }, 0);
                        }
                }).addStyleClass("vhPop");
                fnPaint();
                oPop.openBy(oOpener);
                fnLoad("");
                return oPop;
        }

        /** ENUM 选项：enum_json 可以是 JSON 字符串或数组；坏数据返回 [] */
        function enumOptions(oP) {
                var a = oP && oP.enum_json;
                if (typeof a === "string") {
                        try { a = a ? JSON.parse(a) : []; } catch (e) { a = []; }
                }
                return (Array.isArray(a) ? a : []).filter(function (o) {
                        return o && o.key !== undefined && o.key !== null && String(o.key) !== "";
                }).map(function (o) {
                        return { key: String(o.key), text: String(o.text || o.key) };
                });
        }

        function isEnum(oP) {
                return String((oP && oP.data_type) || "").toUpperCase() === "ENUM" && enumOptions(oP).length > 0;
        }

        /** 20261024：复选框（SEL_KIND C → data_type BOOL） */
        function isBool(oP) {
                return String((oP && oP.data_type) || "").toUpperCase() === "BOOL";
        }

        /** 取字段：兼容 snake_case / 大写（ReportDefinitions 没设 pretty_name）/ camelCase */
        function pick(o, sKey) {
                if (!o) {
                        return undefined;
                }
                var sCamel = sKey.replace(/_([a-z])/g, function (x, c) { return c.toUpperCase(); });
                var aTry = [sKey, sKey.toUpperCase(), sCamel];
                for (var i = 0; i < aTry.length; i++) {
                        if (o[aTry[i]] !== undefined && o[aTry[i]] !== null) {
                                return o[aTry[i]];
                        }
                }
                return undefined;
        }

        /** 登记的默认值 → 预填值：STATIC 原值；TODAY = 今天 ± 偏移天数（yyyyMMdd）；其余（USER 等）不预填 */
        function defaultValueOf(sType, sVal) {
                if (sType === "STATIC") {
                        return sVal === undefined || sVal === null ? "" : String(sVal);
                }
                if (sType === "TODAY") {
                        var iOff = parseInt(String(sVal || "0").replace(/^\+/, ""), 10) || 0;
                        var d = new Date();
                        d.setDate(d.getDate() + iOff);
                        var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
                        return "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate());
                }
                return "";
        }

        /**
          * 20261024：TCode 报表待填参数 + ReportDefinitions 的参数定义 → 补齐选项、默认值、说明。
          * Agent 的待填参数只有 param_id / label / required / data_type / multi / range（后端 get_params 已把
          * 单选组整理成 ENUM、复选框整理成 BOOL、固定值不返回），选项（enum_json）与默认值要从目录定义里取。
          * 默认值只填用户还没碰过的（values 里没有这个键）；定义里 sel_kind = F 的再兜底隐藏一次。
          * @param {object[]} aPending 待填参数
          * @param {object[]} aDefParams ReportDefinitions 里该报表的 PARAMS
          * @param {object} [mValues] 已有填写值（会被就地补默认值）
          * @returns {{params: object[], values: object}}
          */
        function mergeParamDefs(aPending, aDefParams, mValues) {
                var mVals = mValues || {};
                var mDef = {};
                (aDefParams || []).forEach(function (d) {
                        var sId = String(pick(d, "param_id") || "").toUpperCase();
                        if (sId) {
                                mDef[sId] = d;
                        }
                });
                var aOut = [];
                (aPending || []).forEach(function (p) {
                        var d = p && mDef[String(p.param_id || "").toUpperCase()];
                        if (!d) {
                                aOut.push(p);
                                return;
                        }
                        var sKind = String(pick(d, "sel_kind") || "").toUpperCase();
                        if (sKind === "F") {
                                return;
                        }
                        var q = Object.assign({}, p, { sel_kind: sKind });
                        var sHelp = pick(d, "help_text");
                        if (sHelp && !q.help_text) {
                                q.help_text = String(sHelp);
                        }
                        var sGrp = pick(d, "group_label");
                        if (sGrp && !q.group_label) {
                                q.group_label = String(sGrp).trim();
                        }
                        if (sKind === "R") {
                                q.data_type = "ENUM";
                                q.multi_value = false;
                                q.range_allowed = false;
                                q.enum_json = pick(d, "enum_json") || q.enum_json || "";
                                // 有默认项或必填的单选组和 SAP 单选按钮一样，总要选中一个（不能点掉）
                                q.keep_one = !!(q.required || pick(d, "default_value"));
                                if (!q.help_text && !q.keep_one) {
                                        q.help_text = "不选 = 按报表程序的默认";
                                }
                        } else if (sKind === "C") {
                                q.data_type = "BOOL";
                                q.multi_value = false;
                                q.range_allowed = false;
                        }
                        var sDef = pick(d, "default_value");
                        if ((sKind === "R" || sKind === "C") && sDef && mVals[q.param_id] === undefined) {
                                mVals[q.param_id] = String(sDef);
                        }
                        // 20261024（自动登记）：其余参数按登记的默认值预填 —— STATIC 原值、TODAY = 今天 ± DEFAULT_VALUE 天
                        // （与后端 validate_params 缺值补齐同口径）；记下 default_shown，折叠区不会因为预填的默认值自动展开
                        if (sKind !== "R" && sKind !== "C" && mVals[q.param_id] === undefined) {
                                var sDefVal = defaultValueOf(String(pick(d, "default_type") || "").toUpperCase(), sDef);
                                if (sDefVal) {
                                        mVals[q.param_id] = sDefVal;
                                        q.default_shown = sDefVal;
                                }
                        }
                        aOut.push(q);
                });
                return { params: aOut, values: mVals };
        }

        function dateDisplay(s) {
                return /^\d{8}$/.test(s) ? s.substring(0, 4) + "-" + s.substring(4, 6) + "-" + s.substring(6, 8) : s;
        }

        /** 20261015：多值同时登记了范围时按多值处理（与后端校验 / EXEC_SAP 拆选择表同口径） */
        function isRange(oP) {
                return oP.range_allowed === true && oP.multi_value !== true;
        }

        /** 20261015：多值分隔符归一 —— 中英文逗号、顿号、分号、竖线、空格 / 换行都算分隔，
          * 统一成英文逗号（后端只按 , 和 | 拆分，其余会被当成一个值校验失败） */
        function normMulti(s) {
                return String(s || "").split(/[,，、;；|｜\s]+/).filter(Boolean).join(",");
        }

        /** 提交后回显：范围 "从 ~ 至"，多值 "a、b"，日期转 yyyy-MM-dd，ENUM 显示选项文字 */
        function valueDisplay(oP, sVal) {
                if (isTable(oP)) {
                        try {
                                var a = JSON.parse(sVal);
                                return Array.isArray(a) ? Math.max(0, a.length - 1) + " 行" : "";
                        } catch (e) {
                                return "";
                        }
                }
                if (isBool(oP)) {
                        return sVal === "X" ? "是" : "否";
                }
                if (isEnum(oP)) {
                        var aOpt = enumOptions(oP);
                        return String(sVal || "").split(",").filter(Boolean).map(function (k) {
                                var o = aOpt.filter(function (x) { return x.key === k; })[0];
                                return o ? o.text : k;
                        }).join("、");
                }
                return String(sVal || "").split(",").map(dateDisplay).join(isRange(oP) ? " ~ " : "、");
        }

        /** 参数控件：DATE → 日期选择器；范围 → 从/至两个输入；其余单输入（多值逗号分隔） */
        function buildParam(oP, mVals, bMarkErr, oAsk) {
                if (isTable(oP)) {
                        return buildTable(oP, mVals, bMarkErr, oAsk || {});
                }
                var sId = oP.param_id;
                var bDate = String(oP.data_type || "").toUpperCase().indexOf("DAT") >= 0;
                var bMulti = oP.multi_value === true;
                var sVal = mVals[sId] || "";
                // 每次编辑就记在消息数据里；范围保留空端点，避免只填“至”后切回来变成“从”。
                var aDraft = isRange(oP) && !isEnum(oP) ? sVal.split(",") : [sVal];
                var fnSave = function (iPart, sV) {
                        aDraft[iPart] = sV || "";
                        mVals[sId] = oRec.range ? (aDraft[0] || "") + "," + (aDraft[1] || "") : aDraft[0];
                };
                var fnMk = function (sV, sPh, iPart) {
                        iPart = iPart || 0;
                        // 先设日期格式再设值，避免 UI5 重置校验状态后把未完成的日期显示为空。
                        var bVh = !bDate && hasValueHelp(oAsk, sId);
                        var oInput = bDate
                                ? new DatePicker({ valueFormat: "yyyyMMdd", displayFormat: "yyyy-MM-dd", value: sV, placeholder: sPh || "选择日期", width: "100%" })
                                : new Input({ value: sV, placeholder: sPh || (bMulti ? "可填多个，用逗号或空格分隔" : ""), width: "100%",
                                        showValueHelp: bVh, valueHelpIconSrc: "sap-icon://value-help" });
                        if (bVh) {
                                // 20261103：小方块按钮 / F4 → 搜索帮助弹层；多值（非范围）可勾选多个
                                var bPickMulti = bMulti && !isRange(oP);
                                oInput.addStyleClass("askVhInput");
                                oInput.attachValueHelpRequest(function () {
                                        openPicker(oInput, {
                                                title: (oP.label || sId) + (bPickMulti ? " · 可多选" : ""),
                                                multi: bPickMulti,
                                                current: bPickMulti ? normMulti(oInput.getValue()).split(",").filter(Boolean) : [],
                                                load: function (q) { return fnValueHelp(oAsk, sId, q); },
                                                onPick: function (aKeys) {
                                                        var sNew = bPickMulti ? aKeys.join(",") : (aKeys[0] || "");
                                                        oInput.setValue(sNew);
                                                        oInput.setValueState("None");
                                                        fnSave(iPart, sNew);
                                                }
                                        });
                                });
                        }
                        oInput.attachChange(function (e) { fnSave(iPart, e.getParameter("value")); });
                        if (bDate) {
                                // 日期选择器没有 liveChange；同时保存手工输入、尚未失焦的日期草稿。
                                oInput.attachBrowserEvent("input", function (e) {
                                        var sDraft = e.target.value || "";
                                        fnSave(iPart, /^\d{4}-\d{2}-\d{2}$/.test(sDraft) ? sDraft.replace(/-/g, "") : sDraft);
                                });
                        } else {
                                oInput.attachLiveChange(function (e) { fnSave(iPart, e.getParameter("value")); });
                        }
                        return oInput;
                };
                var oRec = { id: sId, label: oP.label || sId, required: oP.required === true, range: !isEnum(oP) && isRange(oP), multi: bMulti };
                // 校验失败重绘后保留红框提示（必填且为空）
                var fnMark = function (oCtl) {
                        if (bMarkErr && oRec.required && !sVal) {
                                oCtl.setValueState("Error");
                        }
                        return oCtl;
                };
                var oCtl;
                if (isEnum(oP)) {
                        // 标签式选项：单选时点一个会取消其他
                        var aSel = sVal ? sVal.split(",") : [];
                        oRec.enumBtns = enumOptions(oP).map(function (o) {
                                return new ToggleButton({
                                        text: o.text,
                                        pressed: aSel.indexOf(o.key) >= 0,
                                        press: function (e) {
                                                // 20261024：keep_one（单选组有默认 / 必填）时不能把唯一选中的点掉
                                                if (!bMulti && oP.keep_one && !e.getParameter("pressed")) {
                                                        e.getSource().setPressed(true);
                                                        return;
                                                }
                                                if (!bMulti && e.getParameter("pressed")) {
                                                        oRec.enumBtns.forEach(function (b) {
                                                                if (b !== e.getSource()) { b.setPressed(false); }
                                                        });
                                                }
                                                mVals[sId] = oRec.enumBtns.filter(function (b) { return b.getPressed(); })
                                                        .map(function (b) { return b.data("key"); }).join(",");
                                        }
                                }).data("key", o.key).addStyleClass("askEnumBtn");
                        });
                        oCtl = new HBox({ wrap: "Wrap", items: oRec.enumBtns }).addStyleClass("askEnum");
                        if (bMarkErr && oRec.required && !sVal) {
                                oCtl.addStyleClass("askEnumErr");
                        }
                        oRec.enumBox = oCtl;
                } else if (oRec.range) {
                        var aPart = sVal.split(",");
                        oRec.low = fnMark(fnMk(aPart[0] || "", "从"));
                        oRec.high = fnMark(fnMk(aPart[1] || "", "至", 1));
                        oCtl = new HBox({ alignItems: "Center", items: [oRec.low, new Text({ text: "—" }).addStyleClass("askRangeSep"), oRec.high] })
                                .addStyleClass("askRange");
                } else {
                        oRec.input = fnMark(fnMk(sVal));
                        oCtl = oRec.input;
                }
                var oCell = new VBox({
                        items: [new Label({ text: oRec.label, required: oRec.required, wrapping: true }).addStyleClass("askFieldLabel"), oCtl]
                }).addStyleClass("askField");
                if (oP.help_text) {
                        oCell.addItem(new Text({ text: oP.help_text }).addStyleClass("askFieldHelp"));
                }
                oRec.cell = oCell;
                return oRec;
        }

        /** 20261024：复选框 → 开关胶囊（按下 = "X"）；同一张卡的开关集中放一行 */
        function buildBool(oP, mVals) {
                var sId = oP.param_id;
                var oRec = { id: sId, label: oP.label || sId, required: false };
                oRec.bool = new ToggleButton({
                        text: oRec.label,
                        icon: "sap-icon://accept",
                        pressed: mVals[sId] === "X",
                        tooltip: oP.help_text || oRec.label,
                        press: function (e) { mVals[sId] = e.getParameter("pressed") ? "X" : ""; }
                }).addStyleClass("askEnumBtn askBoolBtn");
                return oRec;
        }

        /**
          * 20261027：复选框按块分组（保持首次出现的顺序）。都没有块标题 → 一组「选项」；
          * 有的有、有的没有 → 没标题的那组叫「其他选项」
          * @returns {{label: string, params: object[]}[]}
          */
        function groupBools(aBools) {
                var aGroups = [];
                (aBools || []).forEach(function (p) {
                        var sKey = String(p.group_label || "").trim();
                        var g = aGroups.filter(function (x) { return x.key === sKey; })[0];
                        if (!g) {
                                g = { key: sKey, params: [] };
                                aGroups.push(g);
                        }
                        g.params.push(p);
                });
                var bNamed = aGroups.some(function (g) { return !!g.key; });
                return aGroups.map(function (g) {
                        return { label: g.key || (bNamed ? "其他选项" : "选项"), params: g.params, named: !!g.key };
                });
        }

        /**
          * 20261024：参数排版 —— 单选组（单选 ENUM）→ 必填 → 开关 → 选填；
          * 选填项：先补足到 3 个平铺，剩下 ≥ 2 个才折叠（只剩 1 个就直接平铺）
          * @returns {{enums: object[], shown: object[], bools: object[], more: object[]}} 参数定义分组（保持原相对顺序）
          */
        function layoutParams(aParams) {
                var o = { enums: [], shown: [], bools: [], more: [] };
                var aOpt = [];
                (aParams || []).forEach(function (p) {
                        if (!p || !p.param_id) {
                                return;
                        }
                        if (isBool(p)) {
                                o.bools.push(p);
                        } else if (isEnum(p) && p.multi_value !== true) {
                                o.enums.push(p);
                        } else if (p.required === true) {
                                o.shown.push(p);
                        } else {
                                aOpt.push(p);
                        }
                });
                while (o.shown.length < 3 && aOpt.length) {
                        o.shown.push(aOpt.shift());
                }
                if (aOpt.length <= 1) {
                        o.shown = o.shown.concat(aOpt);
                        aOpt = [];
                }
                o.more = aOpt;
                return o;
        }

        /** 收集参数值；必填缺失的控件标红，返回 {values, missing[]} */
        function collect(aRecs) {
                var mOut = {}, aMissing = [], aInvalid = [];
                aRecs.forEach(function (r) {
                        var sV;
                        if (r.table) {
                                // 20261104：粘贴的表 —— 解析出错算无效，没粘且必填算缺
                                mOut[r.id] = r.res && r.res.ok ? r.res.json : "";
                                var bBad = !!(r.res && r.res.error);
                                var bMissT = r.required && !mOut[r.id] && !bBad;
                                r.ta.setValueState(bBad || bMissT ? "Error" : "None");
                                if (bBad) { aInvalid.push(r.label + "：" + r.res.error); }
                                if (bMissT) { aMissing.push(r.label); }
                                return;
                        }
                        if (r.bool) {
                                mOut[r.id] = r.bool.getPressed() ? "X" : "";
                                return;
                        }
                        if (r.enumBtns) {
                                sV = r.enumBtns.filter(function (b) { return b.getPressed(); })
                                        .map(function (b) { return b.data("key"); }).join(",");
                                mOut[r.id] = sV;
                                r.enumBox.toggleStyleClass("askEnumErr", r.required && !sV);
                                if (r.required && !sV) {
                                        aMissing.push(r.label);
                                }
                                return;
                        }
                        if (r.range) {
                                var sLo = (r.low.getValue() || "").trim(), sHi = (r.high.getValue() || "").trim();
                                sV = sLo && sHi ? sLo + "," + sHi : (sLo || sHi);
                        } else if (r.multi) {
                                sV = normMulti(r.input.getValue());
                        } else {
                                sV = (r.input.getValue() || "").trim();
                        }
                        mOut[r.id] = sV;
                        var bMiss = r.required && !sV;
                        (r.range ? [r.low, r.high] : [r.input]).forEach(function (c) {
                                c.setValueState(bMiss ? "Error" : "None");
                        });
                        if (bMiss) {
                                aMissing.push(r.label);
                        }
                });
                return { values: mOut, missing: aMissing, invalid: aInvalid };
        }

        /**
         * 渲染卡片到宿主容器（宿主由消息工厂创建，按消息 uid 登记）
         * @param {sap.m.VBox} oHost 宿主
         * @param {object} oAsk 卡片状态（存于消息条目，重渲染以它为准）
         * @param {function} fnAction 控制器动作 fnAction(oPick)，oPick = {key, text, values, missing}
         */
        function render(oHost, oAsk, fnAction) {
                oHost.destroyItems();
                if (!oAsk) {
                        oHost.setVisible(false);
                        return;
                }
                oHost.setVisible(true);

                // —— 已完成 / 已取消：折叠为一行结论 ——
                if (oAsk.state === "done" || oAsk.state === "cancelled") {
                        oHost.addItem(new HBox({
                                alignItems: "Center",
                                items: [
                                        new Icon({ src: oAsk.state === "done" ? "sap-icon://accept" : "sap-icon://decline" }).addStyleClass("askDoneIcon"),
                                        new Text({ text: oAsk.title }).addStyleClass("askDoneTitle"),
                                        new Text({ text: oAsk.resultText || "" }).addStyleClass("askDoneText")
                                ]
                        }).addStyleClass("askCard askCardDone askCard-" + oAsk.state));
                        return;
                }

                var bBusy = oAsk.state === "busy";
                var aRecs = [];
                oAsk.sel = Math.max(0, Math.min(oAsk.sel || 0, (oAsk.options || []).length));
                var oCard = new VBox().addStyleClass("askCard");
                oCard.addItem(new HBox({
                        alignItems: "Center",
                        items: [new Text({ text: oAsk.title }).addStyleClass("askTitle"),
                                new Text({ text: oAsk.subtitle || "" }).addStyleClass("askSub")]
                }).addStyleClass("askHead"));

                // —— 参数表单（params 形态） ——
                // 20261015：参数一行一个；20261024：单选组 → 必填 → 开关 → 选填（多时折叠）
                if (oAsk.kind === "params" && (oAsk.params || []).length) {
                        oAsk.values = oAsk.values || {};
                        var oLay = layoutParams(oAsk.params.slice(0, 40));
                        var oFields = new VBox().addStyleClass("askFields");
                        oLay.enums.concat(oLay.shown).forEach(function (p) {
                                var r = buildParam(p, oAsk.values, !!oAsk.error, oAsk);
                                aRecs.push(r);
                                oFields.addItem(r.cell);
                        });
                        // 20261027（10.27 #04）：复选框按原选择屏的块分组，每块一行、块标题作行标签
                        var aBoolGroups = groupBools(oLay.bools);
                        aBoolGroups.forEach(function (g, i) {
                                var aBoolRecs = g.params.map(function (p) { return buildBool(p, oAsk.values); });
                                aRecs = aRecs.concat(aBoolRecs);
                                var oGrp = new VBox({
                                        items: [new Label({ text: g.label, wrapping: true, tooltip: g.label }).addStyleClass("askFieldLabel"),
                                                new HBox({ wrap: "Wrap", items: aBoolRecs.map(function (r) { return r.bool; }) }).addStyleClass("askEnum askBools")]
                                }).addStyleClass("askField askBoolGroup");
                                if (aBoolGroups.length > 1 && i > 0) {
                                        oGrp.addStyleClass("askBoolGroupNext");
                                }
                                oFields.addItem(oGrp);
                        });
                        if (oLay.more.length) {
                                var oMoreBox = new VBox().addStyleClass("askMoreBox");
                                var iFilled = 0;
                                oLay.more.forEach(function (p) {
                                        var r = buildParam(p, oAsk.values, !!oAsk.error, oAsk);
                                        aRecs.push(r);
                                        oMoreBox.addItem(r.cell);
                                        // 预填的默认值不算「已填」（不因为它自动展开）
                                        var v = oAsk.values[p.param_id];
                                        if (v && v !== p.default_shown) { iFilled++; }
                                });
                                if (oAsk.moreOpen === undefined) {
                                        oAsk.moreOpen = iFilled > 0;
                                }
                                var fnMoreText = function () {
                                        return (oAsk.moreOpen ? "收起筛选条件" : "更多筛选条件（" + oLay.more.length + "）") +
                                                (iFilled && !oAsk.moreOpen ? " · 已填 " + iFilled : "");
                                };
                                oMoreBox.setVisible(!!oAsk.moreOpen);
                                var oMoreBtn = new Button({
                                        text: fnMoreText(),
                                        icon: oAsk.moreOpen ? "sap-icon://slim-arrow-up" : "sap-icon://slim-arrow-down",
                                        iconFirst: false,
                                        type: "Transparent",
                                        enabled: !bBusy,
                                        press: function () {
                                                oAsk.moreOpen = !oAsk.moreOpen;
                                                oMoreBox.setVisible(oAsk.moreOpen);
                                                oMoreBtn.setText(fnMoreText());
                                                oMoreBtn.setIcon(oAsk.moreOpen ? "sap-icon://slim-arrow-up" : "sap-icon://slim-arrow-down");
                                        }
                                }).addStyleClass("askMoreBtn");
                                oFields.addItem(new HBox({ alignItems: "Center", items: [oMoreBtn] }).addStyleClass("askMoreRow"));
                                oFields.addItem(oMoreBox);
                        }
                        oCard.addItem(oFields);
                }

                // —— 编号选项 + 自由输入 ——
                var aRows = [];
                var oFree = null;
                var fnHighlight = function () {
                        aRows.forEach(function (o, i) { o.toggleStyleClass("askOptOn", i === oAsk.sel); });
                };
                var oList = new VBox().addStyleClass("askOpts");
                (oAsk.options || []).slice(0, 9).forEach(function (o, i) {
                        var oRow = new HBox({
                                alignItems: "Center",
                                items: [new Text({ text: (i + 1) + "." }).addStyleClass("askNo"),
                                        new Text({ text: o.label }).addStyleClass("askOptLabel"),
                                        new Text({ text: o.desc || "" }).addStyleClass("askOptDesc")]
                        }).addStyleClass("askOpt");
                        oRow.attachBrowserEvent("click", function () {
                                if (bBusy) { return; }
                                oAsk.sel = i;
                                fnHighlight();
                        });
                        oRow.attachBrowserEvent("dblclick", function () { if (!bBusy) { fnConfirm(); } });
                        aRows.push(oRow);
                        oList.addItem(oRow);
                });
                if (oAsk.allowFree !== false) {
                        var iFree = aRows.length;
                        oFree = new Input({
                                value: oAsk.freeText || "",
                                placeholder: oAsk.freePh || "告诉 Agent 接下来应该怎么做…",
                                width: "100%",
                                liveChange: function (e) {
                                        oAsk.freeText = e.getParameter("value");
                                        oAsk.sel = iFree;
                                        fnHighlight();
                                }
                        }).addStyleClass("askFreeInput");
                        var oFreeRow = new HBox({
                                alignItems: "Center",
                                items: [new Text({ text: (iFree + 1) + "." }).addStyleClass("askNo"), oFree]
                        }).addStyleClass("askOpt askOptFree");
                        oFreeRow.attachBrowserEvent("click", function () { oAsk.sel = iFree; fnHighlight(); });
                        aRows.push(oFreeRow);
                        oList.addItem(oFreeRow);
                }
                oCard.addItem(oList);

                var oErr = new Text({ text: oAsk.error || "", visible: !!oAsk.error }).addStyleClass("askError");
                oCard.addItem(oErr);

                function fnConfirm() {
                        if (bBusy) { return; }
                        var bFree = oFree && oAsk.sel === aRows.length - 1;
                        var oOpt = bFree ? { key: "free" } : (oAsk.options || [])[oAsk.sel];
                        if (!oOpt) { return; }
                        var oPick = { key: oOpt.key, text: bFree ? (oAsk.freeText || "").trim() : (oOpt.send || oOpt.label), option: oOpt };
                        if (bFree && !oPick.text) {
                                oErr.setText("请先输入内容").setVisible(true);
                                return;
                        }
                        if (aRecs.length) {
                                var oC = collect(aRecs);
                                oAsk.values = oC.values;
                                oPick.values = oC.values;
                                oPick.missing = oC.missing;
                                oPick.invalid = oC.invalid;
                        }
                        fnAction(oPick);
                }

                oCard.addItem(new HBox({
                        alignItems: "Center", justifyContent: "SpaceBetween",
                        items: [
                                new HBox({ alignItems: "Center", items: [
                                        new Icon({ src: "sap-icon://hint" }).addStyleClass("askHintIcon"),
                                        new Text({ text: bBusy ? (oAsk.busyText || "正在处理…") : "使用 Tab / 上下键选择，回车确认" }).addStyleClass("askHint")
                                ] }),
                                new Button({ text: bBusy ? "处理中…" : "确认", enabled: !bBusy, type: "Emphasized", press: fnConfirm }).addStyleClass("askConfirm")
                        ]
                }).addStyleClass("askFoot"));
                if (bBusy) {
                        oCard.addStyleClass("askCardBusy");
                }
                fnHighlight();

                // —— 键盘交互（卡片根节点可聚焦；输入框内仅回车直达确认用于自由输入） ——
                oCard.addEventDelegate({
                        onAfterRendering: function () {
                                var oDom = oCard.getDomRef();
                                if (!oDom) { return; }
                                oDom.setAttribute("tabindex", "0");
                                oDom.setAttribute("role", "group");
                                oDom.setAttribute("aria-label", oAsk.title);
                                oDom.onkeydown = function (ev) {
                                        if (bBusy || ev.isComposing || ev.keyCode === 229) { return; }
                                        // ENUM 标签上的回车 / 空格交给按钮自己（切换选中），不提交卡片
                                        if (ev.target.closest && ev.target.closest(".askEnum")) { return; }
                                        var bInField = ev.target !== oDom && /INPUT|TEXTAREA/.test(ev.target.tagName);
                                        var bFreeField = oFree && oFree.getDomRef() && oFree.getDomRef().contains(ev.target);
                                        if (ev.key === "Enter" && (!bInField || bFreeField)) {
                                                ev.preventDefault();
                                                fnConfirm();
                                                return;
                                        }
                                        if (bInField) { return; }
                                        var n = aRows.length;
                                        if (ev.key === "ArrowDown" || (ev.key === "Tab" && !ev.shiftKey && oAsk.sel < n - 1)) {
                                                ev.preventDefault();
                                                oAsk.sel = (oAsk.sel + 1) % n;
                                        } else if (ev.key === "ArrowUp" || (ev.key === "Tab" && ev.shiftKey && oAsk.sel > 0)) {
                                                ev.preventDefault();
                                                oAsk.sel = (oAsk.sel - 1 + n) % n;
                                        } else if (/^[1-9]$/.test(ev.key) && parseInt(ev.key, 10) <= n) {
                                                ev.preventDefault();
                                                oAsk.sel = parseInt(ev.key, 10) - 1;
                                        } else {
                                                return;
                                        }
                                        fnHighlight();
                                        if (oFree && oAsk.sel === n - 1) {
                                                oFree.focus();
                                        }
                                };
                                if (oAsk.autoFocus) {
                                        oAsk.autoFocus = false;
                                        var oAct = document.activeElement;
                                        var bTyping = oAct && oAct.tagName === "TEXTAREA" && (oAct.value || "").trim();
                                        if (!bTyping) {
                                                setTimeout(function () {
                                                        var oFirst = aRecs.length && (aRecs[0].input || aRecs[0].low || (aRecs[0].enumBtns || [])[0] || aRecs[0].bool);
                                                        if (oFirst) { oFirst.focus(); } else { oDom.focus(); }
                                                }, 60);
                                        }
                                }
                        }
                });
                oHost.addItem(oCard);
        }

        /**
         * 从 Agent 回答末尾识别"提问 + 编号选项"（模型不确定意图时的追问）
         * 规则：末尾连续 2~6 条编号行，其前一行是问句；选项过长不识别（避免误判普通列表）
         * @returns {object|null} {question, options:[{key,label,desc,send}]}
         */
        function detectChoices(sAnswer) {
                var aLines = String(sAnswer || "").replace(/\r/g, "").split("\n");
                while (aLines.length && !aLines[aLines.length - 1].trim()) { aLines.pop(); }
                var aOpts = [];
                var i = aLines.length - 1;
                for (; i >= 0; i--) {
                        var m = /^\s*(?:\d{1,2}|[A-Fa-f①-⑨])\s*[.、)）:：]\s*(.+)$/.exec(aLines[i]);
                        if (!m) { break; }
                        aOpts.unshift(m[1].trim());
                }
                while (i >= 0 && !aLines[i].trim()) { i--; }
                var sQ = i >= 0 ? aLines[i].trim() : "";
                if (aOpts.length < 2 || aOpts.length > 6 || !/[?？]|请选择|请确认|请问|您希望|你希望|需要哪|哪一个|哪个/.test(sQ)) {
                        return null;
                }
                if (aOpts.some(function (s) { return s.length > 60; })) {
                        return null;
                }
                return {
                        question: sQ.replace(/^[#>*\s]+/, "").replace(/\*\*/g, ""),
                        options: aOpts.map(function (s, k) {
                                var sClean = s.replace(/\*\*|`/g, "");
                                // "标签：说明" / "标签 - 说明"（全角冒号后通常无空格）
                                var mSplit = /^(.{1,24}?)\s*(?:[:：]|\s[—-])\s*(.+)$/.exec(sClean);
                                return {
                                        key: "opt" + k,
                                        label: mSplit ? mSplit[1] : sClean,
                                        desc: mSplit ? mSplit[2] : "",
                                        send: sClean
                                };
                        })
                };
        }

        return { render: render, detectChoices: detectChoices, dateDisplay: dateDisplay, valueDisplay: valueDisplay, enumOptions: enumOptions,
                mergeParamDefs: mergeParamDefs, layoutParams: layoutParams, groupBools: groupBools, defaultValueOf: defaultValueOf,
                setValueHelp: setValueHelp, hasValueHelp: hasValueHelp, openPicker: openPicker,
                isTable: isTable, parsePaste: parsePaste, parseTsv: parseTsv, pasteColsText: pasteColsText };
});
