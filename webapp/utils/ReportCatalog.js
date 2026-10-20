sap.ui.define([
        "sap/ui/core/HTML",
        "zai/chat/utils/Formatter"
], function (HTML, Formatter) {
        "use strict";

        /**
         * =====================================================================
         * 报表目录组件（「报表执行」TCode 目录与「Fiori 报表」目录共用）
         * =====================================================================
         * 设计：功能计划书/报表执行目录/01-方案与开发计划 §3.3、Fiori报表分析 §6。
         * 生成 HTML 字符串放进 sap.ui.core.HTML，点击 / 键盘用事件委托处理（与运行卡同一做法）；
         * 搜索与分类切换只改行的 hidden，不重绘控件（输入框不丢焦点）。所有动态文本先 escapeHtml。
         *
         * 一期单选（mode = "single"）：点行或行尾按钮 = onPick(item)。多选（G3）以后再加。
         * items: [{ id, title, code, desc, category, paramCount, badges: [], disabled, disabledText }]
         * categories: null = 不显示分类页签；数组 = 分类页签（「全部」自动加在最前）
         * status: "loading" | "ready" | "error"（ready 且 items 为空 = 空清单）
         * texts: { title, searchPh, footNote, empty, loadFail, retry, loading, all, noMatch,
         *          params, pick, offTip, pickTip }
         * 纯函数 filterItems / rowHtml / html 单独导出，供 Node 测试。
         * =====================================================================
         */

        var esc = Formatter.escapeHtml;

        /** 行首图标（内联 SVG，跟随 currentColor；doc = TCode 报表，chart = Fiori 报表） */
        var ICONS = {
                doc: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
                chart: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>',
                search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
                list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>'
        };

        function norm(s) {
                return String(s === undefined || s === null ? "" : s).toLowerCase();
        }

        /**
          * 按搜索词与分类过滤（不分大小写；匹配报表名、代码、说明、分类、关键词）
          * @param {object[]} aItems 目录行
          * @param {string} sQuery 搜索词（空 = 不过滤）
          * @param {string} sCategory 分类（空 = 全部）
          * @returns {object[]} 命中的行（保持原顺序）
          */
        function filterItems(aItems, sQuery, sCategory) {
                var q = norm(sQuery).trim();
                return (aItems || []).filter(function (it) {
                        if (sCategory && it.category !== sCategory) {
                                return false;
                        }
                        if (!q) {
                                return true;
                        }
                        return [it.title, it.code, it.desc, it.category, it.keywords].some(function (s) {
                                return norm(s).indexOf(q) >= 0;
                        });
                });
        }

        /** 每个分类的报表数：{ "": 总数, 分类: 数量 } */
        function countByCategory(aItems) {
                var m = { "": (aItems || []).length };
                (aItems || []).forEach(function (it) {
                        var k = it.category || "";
                        if (k) {
                                m[k] = (m[k] || 0) + 1;
                        }
                });
                return m;
        }

        function fmt(sTpl, aArgs) {
                return String(sTpl || "").replace(/\{(\d+)\}/g, function (s, i) {
                        return aArgs[+i] === undefined ? s : aArgs[+i];
                });
        }

        /**
          * 一行报表的 HTML
          * @param {object} it 目录行
          * @param {object} o { texts, icon, showCategory }
          */
        function rowHtml(it, o) {
                var t = (o && o.texts) || {};
                var bOff = !!it.disabled;
                var aMeta = [];
                if (o && o.showCategory && it.category) {
                        aMeta.push('<span class="biz">' + esc(it.category) + "</span>");
                }
                if (it.paramCount !== undefined && it.paramCount !== null) {
                        aMeta.push("<span>" + esc(fmt(t.params || "{0} 个参数", [it.paramCount])) + "</span>");
                }
                (it.badges || []).forEach(function (b) {
                        aMeta.push('<span class="bdJob">' + esc(b) + "</span>");
                });
                if (bOff) {
                        aMeta.push('<span class="bdOff">' + esc(it.disabledText || "") + "</span>");
                }
                return '<div class="catRow' + (bOff ? " off" : "") + '" data-id="' + esc(it.id) + '"' +
                        (bOff ? ' aria-disabled="true" title="' + esc(t.offTip || "") + '"' : ' title="' + esc(t.pickTip || "") + '"') +
                        ' tabindex="0" role="button">' +
                        '<div class="rIcon">' + (ICONS[(o && o.icon) || "doc"] || ICONS.doc) + "</div>" +
                        '<div class="rMain"><div class="rName"><span class="rTitle">' + esc(it.title) + "</span>" +
                        (it.code ? '<span class="tc">' + esc(it.code) + "</span>" : "") + "</div>" +
                        (it.desc ? '<div class="rDesc">' + esc(it.desc) + "</div>" : "") + "</div>" +
                        '<div class="rMeta">' + aMeta.join("") + "</div>" +
                        (bOff ? "" : '<button type="button" class="dtBtn dtPrimary catPick" tabindex="-1">' + esc(t.pick || "") + "</button>") +
                        "</div>";
        }

        /**
          * 整个目录的 HTML（状态从 st 取：status / items / message / query / category）
          * @param {object} cfg 配置（texts / categories / icon）
          * @param {object} st 状态
          */
        function html(cfg, st) {
                var t = cfg.texts || {};
                var aItems = st.items || [];
                var mCnt = countByCategory(aItems);
                var bTabs = !!(cfg.categories && cfg.categories.length) && st.status === "ready" && aItems.length > 0;
                var s = '<div class="catalog" role="region" aria-label="' + esc(t.title) + '">' +
                        '<div class="catHead"><h3>' + ICONS.list + esc(t.title) + "</h3>" +
                        (st.status === "ready" && aItems.length ? '<span class="cnt">' + esc(fmt(t.count || "共 {0} 张", [aItems.length])) + "</span>" : "") +
                        (st.status === "ready" && aItems.length
                                ? '<label class="catSearch">' + ICONS.search +
                                  '<input type="search" class="catQ" value="' + esc(st.query || "") + '" placeholder="' + esc(t.searchPh) + '" aria-label="' + esc(t.searchPh) + '"></label>'
                                : "") +
                        "</div>";
                if (bTabs) {
                        s += '<div class="bizTabs" role="tablist">' + [""].concat(cfg.categories).filter(function (c) {
                                return c === "" || mCnt[c];
                        }).map(function (c) {
                                return '<button type="button" class="bizTab' + ((st.category || "") === c ? " on" : "") + '" data-cat="' + esc(c) + '" role="tab">' +
                                        esc(c || t.all || "全部") + " <small>" + (mCnt[c] || 0) + "</small></button>";
                        }).join("") + "</div>";
                }
                if (t.footNote && st.status === "ready" && aItems.length) {
                        s += '<div class="catNote">' + esc(t.footNote) + "</div>";
                }
                s += '<div class="catList">';
                if (st.status === "loading") {
                        s += '<div class="catEmpty">' + esc(t.loading) + "</div>";
                } else if (st.status === "error") {
                        s += '<div class="catEmpty">' + esc(st.message || t.loadFail) +
                                ' <button type="button" class="dtBtn catRetry">' + esc(t.retry) + "</button></div>";
                } else if (!aItems.length) {
                        s += '<div class="catEmpty">' + esc(st.message || t.empty) + "</div>";
                } else {
                        var bGroup = bTabs && !st.category;
                        var sLast = null;
                        aItems.forEach(function (it) {
                                if (bGroup && (it.category || "") !== sLast) {
                                        sLast = it.category || "";
                                        s += '<div class="catGroup" data-group="' + esc(sLast) + '">' + esc(sLast) + "</div>";
                                }
                                s += rowHtml(it, { texts: t, icon: cfg.icon, showCategory: !!cfg.categories && !bGroup });
                        });
                        s += '<div class="catEmpty catNoMatch" hidden>' + esc(t.noMatch) + "</div>";
                }
                return s + "</div></div>";
        }

        /** 按当前搜索词 / 分类显示或隐藏行与分组标题（不重绘） */
        function applyFilter(oRoot, cfg, st) {
                var aHit = filterItems(st.items, st.query, st.category);
                var mHit = {};
                aHit.forEach(function (it) { mHit[it.id] = true; });
                var mGrp = {};
                Array.prototype.forEach.call(oRoot.querySelectorAll(".catRow"), function (el) {
                        var bShow = !!mHit[el.getAttribute("data-id")];
                        el.hidden = !bShow;
                        if (bShow) {
                                var it = (st.items || []).filter(function (x) { return String(x.id) === el.getAttribute("data-id"); })[0];
                                mGrp[(it && it.category) || ""] = true;
                        }
                });
                Array.prototype.forEach.call(oRoot.querySelectorAll(".catGroup"), function (el) {
                        el.hidden = !mGrp[el.getAttribute("data-group")];
                });
                var oNo = oRoot.querySelector(".catNoMatch");
                if (oNo) {
                        oNo.hidden = aHit.length > 0;
                }
        }

        function visibleRows(oRoot) {
                return Array.prototype.filter.call(oRoot.querySelectorAll(".catRow"), function (el) { return !el.hidden; });
        }

        /** 渲染后挂事件（每次 HTML 控件重新渲染都会重挂） */
        function bind(oRoot, cfg, st) {
                var fnPick = function (el) {
                        if (!el || el.classList.contains("off")) {
                                return;
                        }
                        var sId = el.getAttribute("data-id");
                        var it = (st.items || []).filter(function (x) { return String(x.id) === sId; })[0];
                        if (it && cfg.onPick) {
                                cfg.onPick(it);
                        }
                };
                oRoot.onclick = function (ev) {
                        var t = ev.target;
                        if (t.closest(".catRetry")) {
                                if (cfg.onRetry) {
                                        cfg.onRetry();
                                }
                                return;
                        }
                        var oTab = t.closest(".bizTab");
                        if (oTab) {
                                st.category = oTab.getAttribute("data-cat") || "";
                                // 分类切换要重排分组标题 → 重绘（搜索词保留在状态里）
                                if (cfg.onRedraw) {
                                        cfg.onRedraw();
                                }
                                return;
                        }
                        fnPick(t.closest(".catRow"));
                };
                var oQ = oRoot.querySelector(".catQ");
                if (oQ) {
                        oQ.oninput = function () {
                                st.query = oQ.value;
                                applyFilter(oRoot, cfg, st);
                        };
                }
                oRoot.onkeydown = function (ev) {
                        var t = ev.target;
                        if (ev.isComposing || ev.keyCode === 229) {
                                return;
                        }
                        if (ev.key === "/" && oQ && t !== oQ) {
                                ev.preventDefault();
                                oQ.focus();
                                return;
                        }
                        var aRows = visibleRows(oRoot);
                        if (!aRows.length) {
                                return;
                        }
                        var i = aRows.indexOf(t.closest ? t.closest(".catRow") : null);
                        if (ev.key === "ArrowDown") {
                                ev.preventDefault();
                                aRows[Math.min(aRows.length - 1, i + 1)].focus();
                        } else if (ev.key === "ArrowUp") {
                                ev.preventDefault();
                                if (i <= 0 && oQ) {
                                        oQ.focus();
                                } else {
                                        aRows[Math.max(0, i - 1)].focus();
                                }
                        } else if (ev.key === "Enter" && i >= 0) {
                                ev.preventDefault();
                                fnPick(aRows[i]);
                        }
                };
                applyFilter(oRoot, cfg, st);
        }

        /**
          * 建目录控件
          * @param {object} cfg { texts, categories, icon, onPick, onRetry }
          * @returns {sap.ui.core.HTML} 控件；状态更新用 ReportCatalog.update(oCtl, {status, items, message})
          */
        function create(cfg) {
                var st = { status: "loading", items: [], message: "", query: "", category: "" };
                var oCtl = new HTML({ preferDOM: false, sanitizeContent: false });
                var fnRedraw = function () {
                        oCtl.setContent('<div class="catalogHostInner">' + html(cfg, st) + "</div>");
                        // 已渲染时 setContent 直接替换 DOM、不触发 afterRendering → 这里自己重挂事件
                        // （handler 都是赋值式，重复挂不会叠加）
                        var oDom = oCtl.getDomRef();
                        if (oDom) {
                                bind(oDom, cfg, st);
                        }
                };
                cfg.onRedraw = fnRedraw;
                oCtl.attachAfterRendering(function () {
                        var oDom = oCtl.getDomRef();
                        if (oDom) {
                                bind(oDom, cfg, st);
                        }
                });
                oCtl.data("catState", st);
                oCtl.data("catRedraw", fnRedraw);
                fnRedraw();
                return oCtl;
        }

        /** 更新状态并重绘（status / items / message；搜索词与分类保留） */
        function update(oCtl, oPatch) {
                var st = oCtl.data("catState");
                Object.keys(oPatch || {}).forEach(function (k) { st[k] = oPatch[k]; });
                if (st.category && !(st.items || []).some(function (it) { return it.category === st.category; })) {
                        st.category = "";
                }
                oCtl.data("catRedraw")();
        }

        return {
                create: create,
                update: update,
                filterItems: filterItems,
                countByCategory: countByCategory,
                rowHtml: rowHtml,
                html: html
        };
});
