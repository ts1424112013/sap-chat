sap.ui.define([
        "sap/m/Dialog",
        "sap/ui/core/HTML",
        "zai/chat/utils/Formatter"
], function (Dialog, HTML, Formatter) {
        "use strict";

        /**
         * =====================================================================
         * 20261024（10.24 记录 #02）：大结果集 —— 聊天里只画预览，完整数据进分页查看器
         * =====================================================================
         * 卡顿根因：报表 / 分析结果最多 2000 行 × 全部列一次拼成一整张表塞进消息（DOM 几万格），
         * 单元格还自动折行把行撑高。现在：
         *  · 聊天里最多画 PREVIEW_ROWS 行（tableHtml），单元格不折行、放不下省略（悬停看全）
         *  · 工具条「查看全部 N 行」→ open()：分页查看器（每页 PAGE_SIZE 行；搜索 / 点列头排序 / 复制 / 导出 CSV），
         *    任何时候只画一页 DOM。数据就是消息里已有的数据集，不再请求后端。
         * 纯函数（filterRows / sortRows / pageOf / tableHtml / viewerBodyHtml）无 UI5 依赖，test-server 里有单测。
         * =====================================================================
         */

        var PREVIEW_ROWS = 50;
        var PAGE_SIZE = 100;
        var LONG_CELL = 24;   // 超过这么多字的格子加 title，悬停看全

        var esc = function (v) {
                return Formatter.escapeHtml(v === undefined || v === null ? "" : String(v));
        };

        function fmt(sTpl, aArgs) {
                return String(sTpl || "").replace(/\{(\d+)\}/g, function (s, i) {
                        return aArgs[+i] === undefined ? s : aArgs[+i];
                });
        }

        /**
          * 按关键词过滤（不分大小写，任一格包含即命中）
          * @param {Array[]} aRows 行（每行是值数组）
          * @param {string} sQuery 关键词（空 = 不过滤）
          * @returns {Array[]} 命中的行（保持原顺序）
          */
        function filterRows(aRows, sQuery) {
                var q = String(sQuery || "").trim().toLowerCase();
                if (!q) {
                        return (aRows || []).slice();
                }
                return (aRows || []).filter(function (r) {
                        return (r || []).some(function (v) {
                                return v !== undefined && v !== null && String(v).toLowerCase().indexOf(q) >= 0;
                        });
                });
        }

        /** 能当数字比的值（去千分位逗号；空串不算） */
        function toNum(v) {
                if (typeof v === "number") {
                        return isFinite(v) ? v : null;
                }
                var s = String(v === undefined || v === null ? "" : v).replace(/,/g, "").trim();
                if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?-?$/i.test(s)) {
                        return null;
                }
                // SAP 负号在后（"12.5-"）
                var n = parseFloat(s.slice(-1) === "-" ? "-" + s.slice(0, -1) : s);
                return isFinite(n) ? n : null;
        }

        /**
          * 按某列排序（稳定）。两边都是数字按数值比，否则按文本（中文按拼音序）；空值总在最后。
          * @param {Array[]} aRows 行
          * @param {number} iCol 列下标（< 0 = 不排序）
          * @param {string} sDir "asc" | "desc"
          * @returns {Array[]} 新数组
          */
        function sortRows(aRows, iCol, sDir) {
                var a = (aRows || []).slice();
                if (!(iCol >= 0)) {
                        return a;
                }
                var k = sDir === "desc" ? -1 : 1;
                return a.map(function (r, i) { return { r: r, i: i }; }).sort(function (x, y) {
                        var vx = x.r[iCol], vy = y.r[iCol];
                        var ex = vx === undefined || vx === null || vx === "", ey = vy === undefined || vy === null || vy === "";
                        if (ex || ey) {
                                return ex === ey ? x.i - y.i : (ex ? 1 : -1);
                        }
                        var nx = toNum(vx), ny = toNum(vy), c;
                        if (nx !== null && ny !== null) {
                                c = nx - ny;
                        } else {
                                c = String(vx).localeCompare(String(vy), "zh-Hans-CN");
                        }
                        return c ? c * k : x.i - y.i;
                }).map(function (o) { return o.r; });
        }

        /**
          * 取一页
          * @param {Array[]} aRows 行
          * @param {number} iPage 页码（从 1 开始，越界自动夹回）
          * @param {number} [iSize] 每页行数
          * @returns {{rows: Array[], page: number, pages: number, from: number, to: number, total: number}} from/to 从 1 开始；无数据时都是 0
          */
        function pageOf(aRows, iPage, iSize) {
                var n = (aRows || []).length;
                var size = iSize > 0 ? iSize : PAGE_SIZE;
                var pages = Math.max(1, Math.ceil(n / size));
                var p = Math.min(Math.max(1, parseInt(iPage, 10) || 1), pages);
                var i0 = (p - 1) * size;
                var aOut = (aRows || []).slice(i0, i0 + size);
                return { rows: aOut, page: p, pages: pages, from: n ? i0 + 1 : 0, to: n ? i0 + aOut.length : 0, total: n };
        }

        /**
          * 数据表 HTML（动态文本全部转义）。单元格不折行；长文本加 title。
          * @param {object[]} aCols 列 [{label, numeric}]
          * @param {Array[]} aRows 行
          * @param {object} [o] { cls: 额外 class, rowNo: 首行行号（给了就加行号列）, sortCol, sortDir（列头加排序标记与 data-col）}
          * @returns {string} HTML
          */
        function tableHtml(aCols, aRows, o) {
                o = o || {};
                var bNo = o.rowNo > 0;
                var bSort = !!o.sortable;
                var s = '<div class="mdTableWrap dgWrap"><table class="mdTable dgTable' + (o.cls ? " " + esc(o.cls) : "") + '"><thead><tr>';
                if (bNo) {
                        s += '<th class="dgNo">#</th>';
                }
                (aCols || []).forEach(function (c, i) {
                        var sMark = "";
                        if (bSort && o.sortCol === i) {
                                sMark = o.sortDir === "desc" ? " ↓" : " ↑";
                        }
                        s += "<th" + (c.numeric ? ' class="num"' : "") + (bSort ? ' data-col="' + i + '" title="' + esc(o.sortTip || "") + '"' : "") + ">" +
                                esc(c.label || c.name) + (sMark ? '<span class="dgSort">' + sMark + "</span>" : "") + "</th>";
                });
                s += "</tr></thead><tbody>";
                (aRows || []).forEach(function (r, iRow) {
                        s += "<tr>";
                        if (bNo) {
                                s += '<td class="dgNo">' + (o.rowNo + iRow) + "</td>";
                        }
                        (aCols || []).forEach(function (c, i) {
                                var v = r ? r[i] : "";
                                var sv = v === undefined || v === null ? "" : String(v);
                                var bLong = sv.length > LONG_CELL;
                                s += "<td" + (c.numeric ? ' class="num"' : "") + (bLong ? ' title="' + esc(sv) + '"' : "") + ">" + esc(sv) + "</td>";
                        });
                        s += "</tr>";
                });
                return s + "</tbody></table></div>";
        }

        /**
          * 查看器里会变的部分：表格 + 页脚（分页）。状态 st = { ds, query, sortCol, sortDir, page }
          * @param {object} st 状态
          * @param {object} t 文案
          * @returns {{table: string, foot: string, meta: string}} HTML 片段
          */
        function viewerBodyHtml(st, t) {
                var oDs = st.ds || {};
                var aCols = oDs.columns || [];
                var aHit = sortRows(filterRows(oDs.rows, st.query), st.sortCol, st.sortDir);
                var pg = pageOf(aHit, st.page, st.pageSize);
                st.page = pg.page;
                var sTable = aHit.length
                        ? tableHtml(aCols, pg.rows, { rowNo: pg.from, sortable: true, sortCol: st.sortCol, sortDir: st.sortDir, sortTip: t.sortTip, cls: "dgFull" })
                        : '<div class="dgEmpty">' + esc(t.noMatch) + "</div>";
                var sRange = aHit.length ? fmt(t.range, [pg.from, pg.to, aHit.length]) : "";
                var sFoot = '<span class="dgRange">' + esc(sRange) + "</span>" +
                        '<span class="dgPager">' +
                        '<button type="button" class="dtBtn" data-act="first"' + (pg.page <= 1 ? " disabled" : "") + ">«</button>" +
                        '<button type="button" class="dtBtn" data-act="prev"' + (pg.page <= 1 ? " disabled" : "") + ">" + esc(t.prev) + "</button>" +
                        '<span class="dgPageNo">' + esc(fmt(t.page, [pg.page, pg.pages])) + "</span>" +
                        '<button type="button" class="dtBtn" data-act="next"' + (pg.page >= pg.pages ? " disabled" : "") + ">" + esc(t.next) + "</button>" +
                        '<button type="button" class="dtBtn" data-act="last"' + (pg.page >= pg.pages ? " disabled" : "") + ">»</button>" +
                        "</span>";
                var aMeta = [fmt(t.size, [(oDs.rows || []).length, aCols.length])];
                if (oDs.truncated && oDs.total > (oDs.rows || []).length) {
                        aMeta.push(fmt(t.truncated, [oDs.total]));
                }
                if (String(st.query || "").trim()) {
                        aMeta.push(fmt(t.matched, [aHit.length]));
                }
                return { table: sTable, foot: sFoot, meta: aMeta.join(" · "), hits: aHit };
        }

        var TEXTS = {
                close: "关闭",
                search: "在结果里搜索…",
                copy: "复制",
                csv: "导出 CSV",
                prev: "上一页",
                next: "下一页",
                page: "{0} / {1} 页",
                range: "第 {0}–{1} 行，共 {2} 行",
                size: "{0} 行 × {1} 列",
                truncated: "后端共 {0} 行，这里是已取回的部分",
                matched: "匹配 {0} 行",
                noMatch: "没有匹配的行",
                sortTip: "点击按这一列排序（再点一次倒序，第三次取消）",
                copyTip: "复制当前结果（搜索时只复制匹配的行），可直接粘贴到 Excel",
                csvTip: "导出当前结果（搜索时只导出匹配的行），Excel 可直接打开"
        };

        /**
          * 打开分页查看器
          * @param {object} oDs 数据集 { name, columns, rows, truncated, total }
          * @param {object} oOpt { onCopy(oDsView), onCsv(oDsView), texts }
          */
        function open(oDs, oOpt) {
                oOpt = oOpt || {};
                var t = jQuery.extend({}, TEXTS, oOpt.texts || {});
                var st = { ds: oDs, query: "", sortCol: -1, sortDir: "asc", page: 1, pageSize: PAGE_SIZE, hits: oDs.rows || [] };
                var oRoot = null;

                var fnPaint = function () {
                        if (!oRoot) {
                                return;
                        }
                        var o = viewerBodyHtml(st, t);
                        st.hits = o.hits;
                        oRoot.querySelector(".dgMeta").textContent = o.meta;
                        var oBody = oRoot.querySelector(".dgBody");
                        oBody.innerHTML = o.table;
                        oBody.scrollTop = 0;
                        oRoot.querySelector(".dgFoot").innerHTML = o.foot;
                };
                // 当前视图（搜索 + 排序后）的数据集，复制 / 导出用
                var fnView = function () {
                        return { name: oDs.name, columns: oDs.columns, rows: st.hits || [] };
                };

                var sShell = '<div class="dgRoot">' +
                        '<div class="dgHead">' +
                        '<div class="dgTitleBox"><div class="dgTitle">' + esc(oDs.name || "") + '</div><div class="dgMeta"></div></div>' +
                        '<label class="catSearch dgSearch"><input type="search" class="dgQ" placeholder="' + esc(t.search) + '" aria-label="' + esc(t.search) + '"></label>' +
                        '<button type="button" class="dtBtn" data-act="copy" title="' + esc(t.copyTip) + '">' + esc(t.copy) + "</button>" +
                        '<button type="button" class="dtBtn" data-act="csv" title="' + esc(t.csvTip) + '">' + esc(t.csv) + "</button>" +
                        '<button type="button" class="dgClose" data-act="close" title="' + esc(t.close) + '" aria-label="' + esc(t.close) + '">✕</button>' +
                        "</div>" +
                        '<div class="dgBody"></div>' +
                        '<div class="dgFoot"></div>' +
                        "</div>";

                var oHtml = new HTML({ content: sShell, preferDOM: false, sanitizeContent: false });
                var oDlg = new Dialog({
                        showHeader: false,
                        contentWidth: "94vw",   // 最大宽度在样式里限制（.dgDialog，CSSSize 不认 min()）
                        contentHeight: "82vh",
                        verticalScrolling: false,
                        horizontalScrolling: false,
                        content: [oHtml],
                        afterClose: function () { oDlg.destroy(); }
                }).addStyleClass("apvDialog dgDialog");

                var iTimer = null;
                oHtml.attachAfterRendering(function () {
                        oRoot = oHtml.getDomRef();
                        if (!oRoot) {
                                return;
                        }
                        oRoot.onclick = function (ev) {
                                var oTh = ev.target.closest("th[data-col]");
                                if (oTh) {
                                        var i = parseInt(oTh.getAttribute("data-col"), 10);
                                        // 同一列：升序 → 降序 → 取消
                                        if (st.sortCol !== i) {
                                                st.sortCol = i;
                                                st.sortDir = "asc";
                                        } else if (st.sortDir === "asc") {
                                                st.sortDir = "desc";
                                        } else {
                                                st.sortCol = -1;
                                        }
                                        st.page = 1;
                                        fnPaint();
                                        return;
                                }
                                var oBtn = ev.target.closest("button[data-act]");
                                if (!oBtn || oBtn.disabled) {
                                        return;
                                }
                                var sAct = oBtn.getAttribute("data-act");
                                if (sAct === "close") {
                                        oDlg.close();
                                } else if (sAct === "copy" && oOpt.onCopy) {
                                        oOpt.onCopy(fnView());
                                } else if (sAct === "csv" && oOpt.onCsv) {
                                        oOpt.onCsv(fnView());
                                } else if (/^(first|prev|next|last)$/.test(sAct)) {
                                        st.page = sAct === "first" ? 1 : sAct === "prev" ? st.page - 1 : sAct === "next" ? st.page + 1 : 1e9;
                                        fnPaint();
                                }
                        };
                        var oQ = oRoot.querySelector(".dgQ");
                        oQ.oninput = function () {
                                clearTimeout(iTimer);
                                iTimer = setTimeout(function () {
                                        st.query = oQ.value;
                                        st.page = 1;
                                        fnPaint();
                                }, 180);
                        };
                        fnPaint();
                });
                oDlg.open();
                return oDlg;
        }

        return {
                PREVIEW_ROWS: PREVIEW_ROWS,
                PAGE_SIZE: PAGE_SIZE,
                TEXTS: TEXTS,
                filterRows: filterRows,
                sortRows: sortRows,
                pageOf: pageOf,
                tableHtml: tableHtml,
                viewerBodyHtml: viewerBodyHtml,
                open: open
        };
});
