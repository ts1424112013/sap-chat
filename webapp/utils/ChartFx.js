sap.ui.define([
        "zai/chat/utils/Formatter"
], function (Formatter) {
        "use strict";

        /**
         * 图表交互（20261025）：出场动画只播一次 + 悬停聚焦与数值提示卡
         * ---------------------------------------------------------------
         * 图表是 ChartRenderer 输出的静态 SVG，消息列表一刷新整张图的 DOM 就会重建，所以：
         *  · 出场动画：监听对话卡片里新出现的图（.chartCard svg.gcSvg），按内容指纹 data-k 判断 ——
         *    第一次见到才加 .gcGrow 播动画；列表重绘出来的同一张图不再重播；换类型 / 改配置指纹变了会再播一次。
         *    图表面板里的预览不播（改一个选项就重长一遍太晃）。
         *  · 悬停：鼠标在某个类目的感应区（data-i）上 → 同类目的柱 / 点 / 扇区 / 图例 / 数值标注高亮，其余变淡；
         *    提示卡贴在高亮图元上方（条形图贴在右侧），列出类目名 + 每个系列的数值（饼图带占比）；
         *    折线 / 面积图显示竖向参考线；环形图中心的「合计」换成当前扇区的占比。
         * 样式 .gcGrow / .gcHover / .gcTip（style-gale.css 末尾）。
         */

        var esc = function (s) { return Formatter.escapeHtml(s); };
        var oSeen = Object.create(null);
        var oTip = null;
        var oCur = null;   // { svg, i }
        var bBound = false;

        function tipEl() {
                if (!oTip || !oTip.isConnected) {
                        oTip = document.createElement("div");
                        oTip.className = "gcTip";
                        oTip.setAttribute("role", "tooltip");
                        document.body.appendChild(oTip);
                }
                return oTip;
        }

        function clear() {
                if (!oCur) {
                        return;
                }
                var oSvg = oCur.svg;
                oSvg.classList.remove("gcHover");
                Array.prototype.forEach.call(oSvg.querySelectorAll(".gcOn"), function (e) { e.classList.remove("gcOn"); });
                var oGuide = oSvg.querySelector(".gcGuide");
                if (oGuide) {
                        oGuide.setAttribute("opacity", "0");
                }
                var oTot = oSvg.querySelector(".gcTotal"), oTotL = oSvg.querySelector(".gcTotalLab");
                if (oTot && oTot.hasAttribute("data-orig")) {
                        oTot.textContent = oTot.getAttribute("data-orig");
                        oTotL.textContent = oTotL.getAttribute("data-orig");
                }
                oCur = null;
                if (oTip) {
                        oTip.classList.remove("is-on");
                }
        }

        /** 提示卡：类目名 + 每个系列一行（色点 · 系列名 · 数值 [· 占比]） */
        function showTip(aMarks, aAnchor) {
                var o = tipEl();
                var m0 = aMarks[0];
                var bOne = aMarks.length === 1;
                var sHtml = '<div class="gcTipT">' + esc(m0.getAttribute("data-l")) + "</div>";
                aMarks.forEach(function (m) {
                        var sCol = m.getAttribute("data-c") || "";
                        var sPct = m.getAttribute("data-p");
                        sHtml += '<div class="gcTipR">' +
                                (/^#[0-9a-f]{3,8}$/i.test(sCol) ? '<i style="background:' + sCol + '"></i>' : "<i></i>") +
                                '<span class="gcTipS">' + esc(m.getAttribute("data-s")) + "</span>" +
                                '<b class="gcTipV' + (bOne ? " gcTipBig" : "") + '">' + esc(m.getAttribute("data-v")) + "</b>" +
                                (sPct ? '<span class="gcTipP">' + esc(sPct) + "%</span>" : "") + "</div>";
                });
                o.innerHTML = sHtml;
                // 锚点：高亮图元（含数值标注）的外接框
                var r = null;
                (aAnchor || aMarks).forEach(function (m) {
                        var b = m.getBoundingClientRect();
                        r = r ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) }
                                : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
                });
                o.classList.remove("is-below", "is-side");
                o.style.left = "0px";
                o.style.top = "0px";
                var w = o.offsetWidth, h = o.offsetHeight, vw = window.innerWidth;
                var bSide = m0.classList.contains("gcRt") || m0.classList.contains("gcLt");
                var oPie = m0.classList.contains("gcSlice") && m0.closest(".gcPie");
                var x, y;
                if (oPie) {
                        // 饼 / 环：放到这一块外沿再往外一点（中心已显示占比，不能压在中间）
                        var p = oPie.getBoundingClientRect();
                        var pcx = (p.left + p.right) / 2, pcy = (p.top + p.bottom) / 2, rad = p.width / 2;
                        var dx = (r.left + r.right) / 2 - pcx, dy = (r.top + r.bottom) / 2 - pcy, len = Math.sqrt(dx * dx + dy * dy) || 1;
                        var ax = pcx + dx / len * (rad + 12), ay = pcy + dy / len * (rad + 12);
                        if (Math.abs(dx) >= Math.abs(dy)) {
                                x = dx >= 0 ? ax : ax - w;
                                y = ay - h / 2;
                                o.classList.add("is-side");
                        } else {
                                x = ax - w / 2;
                                y = dy >= 0 ? ay : ay - h;
                                if (dy >= 0) {
                                        o.classList.add("is-below");
                                }
                        }
                } else if (bSide && r.right + 12 + w <= vw - 8) {
                        x = r.right + 12;
                        y = (r.top + r.bottom) / 2 - h / 2;
                        o.classList.add("is-side");
                } else {
                        x = (r.left + r.right) / 2 - w / 2;
                        y = r.top - h - 10;
                        if (y < 8) {
                                y = r.bottom + 10;
                                o.classList.add("is-below");
                        }
                }
                o.style.left = Math.round(Math.max(8, Math.min(x, vw - w - 8))) + "px";
                o.style.top = Math.round(Math.max(8, Math.min(y, window.innerHeight - h - 8))) + "px";
                o.classList.add("is-on");
        }

        function focus(oSvg, sI) {
                if (oCur && oCur.svg === oSvg && oCur.i === sI) {
                        return;
                }
                clear();
                oCur = { svg: oSvg, i: sI };
                var aAll = oSvg.querySelectorAll('[data-i="' + sI + '"]');
                Array.prototype.forEach.call(aAll, function (e) { e.classList.add("gcOn"); });
                oSvg.classList.add("gcHover");
                var aMarks = Array.prototype.filter.call(aAll, function (e) { return e.hasAttribute("data-s"); });
                if (!aMarks.length) {
                        return;
                }
                // 折线 / 面积：竖向参考线移到这一列
                var oGuide = oSvg.querySelector(".gcGuide");
                var oHit = Array.prototype.filter.call(aAll, function (e) { return e.hasAttribute("data-x"); })[0];
                if (oGuide && oHit) {
                        oGuide.setAttribute("x1", oHit.getAttribute("data-x"));
                        oGuide.setAttribute("x2", oHit.getAttribute("data-x"));
                        oGuide.setAttribute("opacity", "1");
                }
                // 环形图：中心「合计」换成这一块的占比
                var oTot = oSvg.querySelector(".gcTotal"), oTotL = oSvg.querySelector(".gcTotalLab");
                if (oTot && oTotL && aMarks[0].hasAttribute("data-p")) {
                        if (!oTot.hasAttribute("data-orig")) {
                                oTot.setAttribute("data-orig", oTot.textContent);
                                oTotL.setAttribute("data-orig", oTotL.textContent);
                        }
                        var sLab = aMarks[0].getAttribute("data-l") || "";
                        oTot.textContent = aMarks[0].getAttribute("data-p") + "%";
                        oTotL.textContent = sLab.length > 8 ? sLab.substring(0, 8) + "…" : sLab;
                }
                // 提示卡锚在图元 + 它的数值标注之上，不压住标注
                var aVals = Array.prototype.filter.call(aAll, function (e) { return e.classList.contains("gcVal"); });
                showTip(aMarks, aMarks.concat(aVals));
        }

        /** 第一次见到后多久内再次出现仍播动画：图表刚出现时消息条目常会连着重绘一两次 */
        var GROW_WINDOW_MS = 900;

        /** 新出现的对话图表：按「图表卡 ID + 内容指纹」第一次见到才播出场动画 */
        function growNew(oNode) {
                var aSvg = oNode.matches && oNode.matches("svg.gcSvg") ? [oNode]
                        : (oNode.querySelectorAll ? oNode.querySelectorAll("svg.gcSvg") : []);
                Array.prototype.forEach.call(aSvg, function (oSvg) {
                        var oCard = oSvg.closest(".chartCard");
                        var sK = oSvg.getAttribute("data-k");
                        if (!sK || !oCard) {
                                return;
                        }
                        sK = (oCard.getAttribute("data-cid") || "") + ":" + sK;
                        var iNow = Date.now();
                        if (!oSeen[sK]) {
                                oSeen[sK] = iNow;
                        }
                        if (iNow - oSeen[sK] < GROW_WINDOW_MS) {
                                oSvg.classList.add("gcGrow");
                        }
                });
        }

        return {
                bind: function () {
                        if (bBound || typeof document === "undefined") {
                                return;
                        }
                        bBound = true;
                        document.addEventListener("mouseover", function (e) {
                                var t = e.target;
                                var oMark = t && t.closest ? t.closest(".gcSvg [data-i]") : null;
                                if (!oMark) {
                                        clear();
                                        return;
                                }
                                focus(oMark.closest(".gcSvg"), oMark.getAttribute("data-i"));
                        });
                        document.addEventListener("mouseout", function (e) {
                                if (!e.relatedTarget) {
                                        clear();   // 移出窗口
                                }
                        });
                        document.addEventListener("scroll", clear, true);
                        new MutationObserver(function (aMut) {
                                if (oCur && !oCur.svg.isConnected) {
                                        clear();   // 悬停中的图被重绘掉了
                                }
                                aMut.forEach(function (m) {
                                        Array.prototype.forEach.call(m.addedNodes, function (n) {
                                                if (n.nodeType === 1) {
                                                        growNew(n);
                                                }
                                        });
                                });
                        }).observe(document.body, { childList: true, subtree: true });
                }
        };
});
