sap.ui.define([
        "sap/m/VBox",
        "sap/m/HBox",
        "sap/m/Text",
        "sap/m/Label",
        "sap/m/Input",
        "sap/m/DatePicker",
        "sap/m/Button",
        "sap/m/ToggleButton",
        "sap/ui/core/Icon"
], function (VBox, HBox, Text, Label, Input, DatePicker, Button, ToggleButton, Icon) {
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
         */

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
        function buildParam(oP, mVals, bMarkErr) {
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
                        var oInput = bDate
                                ? new DatePicker({ valueFormat: "yyyyMMdd", displayFormat: "yyyy-MM-dd", value: sV, placeholder: sPh || "选择日期", width: "100%" })
                                : new Input({ value: sV, placeholder: sPh || (bMulti ? "可填多个，用逗号或空格分隔" : ""), width: "100%" });
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

        /** 收集参数值；必填缺失的控件标红，返回 {values, missing[]} */
        function collect(aRecs) {
                var mOut = {}, aMissing = [];
                aRecs.forEach(function (r) {
                        var sV;
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
                return { values: mOut, missing: aMissing };
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
                if (oAsk.kind === "params" && (oAsk.params || []).length) {
                        oAsk.values = oAsk.values || {};
                        // 20261015：参数一行一个（原 HBox 换行网格一行挤 2~3 个）
                        var oFields = new VBox().addStyleClass("askFields");
                        oAsk.params.slice(0, 20).forEach(function (p) {
                                if (p && p.param_id) {
                                        var r = buildParam(p, oAsk.values, !!oAsk.error);
                                        aRecs.push(r);
                                        oFields.addItem(r.cell);
                                }
                        });
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
                                                        var oFirst = aRecs.length && (aRecs[0].input || aRecs[0].low || (aRecs[0].enumBtns || [])[0]);
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

        return { render: render, detectChoices: detectChoices, dateDisplay: dateDisplay, valueDisplay: valueDisplay, enumOptions: enumOptions };
});
