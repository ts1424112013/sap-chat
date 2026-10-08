sap.ui.define([
        "sap/m/VBox",
        "sap/m/HBox",
        "sap/m/Text",
        "sap/m/Label",
        "sap/m/Input",
        "sap/m/DatePicker",
        "sap/m/Button",
        "sap/ui/core/Icon"
], function (VBox, HBox, Text, Label, Input, DatePicker, Button, Icon) {
        "use strict";

        /**
         * V16：对话内联「需要你确认」卡片（参考 Agent 权限确认交互）
         * 两种形态：
         *   params —— 报表待填参数：内联表单 + 编号操作（提交执行 / 先不执行 / 告诉 Agent…）
         *   choice —— 意图不明确：编号选项 + 自由输入（选择即作为下一条消息发送）
         * 键盘：↑↓ / Tab 切换选项，1~9 直选，Enter 确认（输入框内回车不抢占）
         * 状态：open → busy（提交中）→ done / cancelled（折叠为一行结论）
         * 卡片只负责交互与收集，业务动作由控制器 onAction(oAsk, oPick) 执行。
         */

        function dateDisplay(s) {
                return /^\d{8}$/.test(s) ? s.substring(0, 4) + "-" + s.substring(4, 6) + "-" + s.substring(6, 8) : s;
        }

        /** 参数控件：DATE → 日期选择器；范围 → 从/至两个输入；其余单输入（多值逗号分隔） */
        function buildParam(oP, mVals, bMarkErr) {
                var sId = oP.param_id;
                var bDate = String(oP.data_type || "").toUpperCase().indexOf("DAT") >= 0;
                var sVal = mVals[sId] || "";
                var fnMk = function (sV, sPh) {
                        return bDate
                                ? new DatePicker({ value: sV, valueFormat: "yyyyMMdd", displayFormat: "yyyy-MM-dd", placeholder: sPh || "选择日期", width: "100%" })
                                : new Input({ value: sV, placeholder: sPh || (oP.multi_value === true ? "多个值用英文逗号分隔" : ""), width: "100%" });
                };
                var oRec = { id: sId, label: oP.label || sId, required: oP.required === true, range: oP.range_allowed === true };
                // 校验失败重绘后保留红框提示（必填且为空）
                var fnMark = function (oCtl) {
                        if (bMarkErr && oRec.required && !sVal) {
                                oCtl.setValueState("Error");
                        }
                        return oCtl;
                };
                var oCtl;
                if (oRec.range) {
                        var aPart = sVal.split(",");
                        oRec.low = fnMark(fnMk(aPart[0] || "", "从"));
                        oRec.high = fnMark(fnMk(aPart[1] || "", "至"));
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
                        if (r.range) {
                                var sLo = (r.low.getValue() || "").trim(), sHi = (r.high.getValue() || "").trim();
                                sV = sLo && sHi ? sLo + "," + sHi : (sLo || sHi);
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
                        var oGrid = new HBox({ wrap: "Wrap" }).addStyleClass("askFields");
                        oAsk.params.slice(0, 20).forEach(function (p) {
                                if (p && p.param_id) {
                                        var r = buildParam(p, oAsk.values, !!oAsk.error);
                                        aRecs.push(r);
                                        oGrid.addItem(r.cell);
                                }
                        });
                        oCard.addItem(oGrid);
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
                                                        if (aRecs.length) { (aRecs[0].input || aRecs[0].low).focus(); } else { oDom.focus(); }
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

        return { render: render, detectChoices: detectChoices, dateDisplay: dateDisplay };
});
