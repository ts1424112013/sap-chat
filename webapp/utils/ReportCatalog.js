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
         *          params, pick, offTip, pickTip, expand, collapse }
         * 20261020：collapsible = true 时可收起（collapsed = 初始状态）；收起态是一个「报表目录 · 共 N 张」胶囊，
         * 点开恢复完整目录，标题栏右侧有收起按钮；每次切换回调 onToggle(collapsed)。
         * 纯函数 filterItems / rowHtml / html 单独导出，供 Node 测试。
         * =====================================================================
         */

        var esc = Formatter.escapeHtml;

        /** 行首图标（内联 SVG，跟随 currentColor；doc = TCode 报表，chart = Fiori 报表） */
        var ICONS = {
                doc: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
                chart: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>',
                search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
                list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
                down: '<svg class="ctChev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
                up: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>'
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

        /* ---------- 20261024（10.24 记录 #01）：报表执行目录按模块分类 ---------- */

        /** 认识的模块代码（顺序 = 页签顺序） */
        var MODULES = ["MM", "PP", "SD", "FI", "CO", "QM", "PM", "WM", "PS", "HR"];
        var RE_MOD = "(" + MODULES.join("|") + ")";
        // 事务码：Z/Y + 两位前缀 + 模块（公司惯例 ZDP + MM702 / ZDP + SD012 / ZDP + PP123），或 Z/Y 后紧跟模块（ZMM001）
        var RE_TCODE = [new RegExp("^[ZY][A-Z0-9]{2}" + RE_MOD), new RegExp("^[ZY]" + RE_MOD)];
        // 程序名：ZR + 模块 + _（ZRMM_IDP_0702 / ZRSD_IDP_0012），或 Z/Y 后紧跟模块
        var RE_PROG = [new RegExp("^[ZY]R" + RE_MOD + "[_0-9]"), new RegExp("^[ZY]" + RE_MOD + "[_0-9]")];

        /**
          * 报表所属模块：登记表显式值优先（以后 ZAI_RPT_DEF 加 MODULE 列即可人工修正），
          * 否则按事务码、再按程序名的命名推断；推不出返回空串（调用方显示为「其他」）。
          * @param {string} sTcode 事务码
          * @param {string} sProg 程序名
          * @param {string} [sExplicit] 登记表里的模块（可空）
          * @returns {string} 模块代码（大写）或空串
          */
        function moduleOf(sTcode, sProg, sExplicit) {
                var sEx = String(sExplicit || "").trim().toUpperCase();
                if (sEx) {
                        return sEx;
                }
                var aTry = [[String(sTcode || "").trim().toUpperCase(), RE_TCODE], [String(sProg || "").trim().toUpperCase(), RE_PROG]];
                for (var i = 0; i < aTry.length; i++) {
                        for (var j = 0; j < aTry[i][1].length; j++) {
                                var m = aTry[i][1][j].exec(aTry[i][0]);
                                if (m) {
                                        return m[1];
                                }
                        }
                }
                return "";
        }

        /**
          * 按模块排序（稳定：同一模块内保持登记顺序）：认识的模块按 MODULES 顺序，
          * 其他显式模块排在后面，「其他」（sOther）最后。
          * @param {object[]} aItems 目录行（category = 模块）
          * @param {string} sOther 「其他」分类的文字
          * @returns {object[]} 新数组
          */
        function sortByModule(aItems, sOther) {
                var rank = function (c) {
                        var i = MODULES.indexOf(c);
                        return i >= 0 ? i : (c && c !== sOther ? 50 : 99);
                };
                return (aItems || []).map(function (it, i) { return { it: it, i: i }; })
                        .sort(function (a, b) {
                                return (rank(a.it.category) - rank(b.it.category)) || (a.i - b.i);
                        })
                        .map(function (x) { return x.it; });
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
                // 20261020：可收起（cfg.collapsible）。收起态只是输入框下方一个胶囊；根节点不用 .catalog，
                // 首页因此保持居中（.heroArea:has(.catalog) 只在展开时生效）
                if (cfg.collapsible && st.collapsed) {
                        var sCnt = st.status === "ready" && aItems.length ? fmt(t.count || "共 {0} 张", [aItems.length])
                                : st.status === "loading" ? (t.loading || "") : "";
                        return '<div class="catalogMini"><button type="button" class="catToggle" aria-expanded="false" title="' + esc(t.expand || "") + '">' +
                                ICONS.list + '<span class="ctTitle">' + esc(t.title) + "</span>" +
                                (sCnt ? '<span class="ctCnt">' + esc(sCnt) + "</span>" : "") + ICONS.down + "</button></div>";
                }
                var mCnt = countByCategory(aItems);
                var bTabs = !!(cfg.categories && cfg.categories.length) && st.status === "ready" && aItems.length > 0;
                var s = '<div class="catalog" role="region" aria-label="' + esc(t.title) + '">' +
                        '<div class="catHead"><h3>' + ICONS.list + esc(t.title) + "</h3>" +
                        (st.status === "ready" && aItems.length ? '<span class="cnt">' + esc(fmt(t.count || "共 {0} 张", [aItems.length])) + "</span>" : "") +
                        (st.status === "ready" && aItems.length
                                ? '<label class="catSearch">' + ICONS.search +
                                  '<input type="search" class="catQ" value="' + esc(st.query || "") + '" placeholder="' + esc(t.searchPh) + '" aria-label="' + esc(t.searchPh) + '"></label>'
                                : "") +
                        (cfg.collapsible
                                ? '<button type="button" class="catFold" aria-expanded="true" title="' + esc(t.collapse || "") + '" aria-label="' + esc(t.collapse || "") + '">' + ICONS.up + "</button>"
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
                                // 20261024：cfg.categoryChip —— 只有一个分类、不出页签时，行上仍标出分类（报表执行目录的模块）
                                s += rowHtml(it, { texts: t, icon: cfg.icon, showCategory: (!!cfg.categories || !!cfg.categoryChip) && !bGroup });
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

        /* ---------------------------------------------------------------------
         * 20261020：收起 / 展开动画（Web Animations API）
         *  · 展开：卡片按最终尺寸排好版，用 clip-path 从胶囊的形状放开（不改宽高 → 文字不重排、不抖）；
         *    内容稍后淡入，前几行依次上浮；收起按钮的箭头从朝下转到朝上
         *  · 收起：卡片先裁回胶囊形状再换成胶囊；胶囊箭头从朝上转回朝下
         *  · 首页其余部分（标题 / 场景 / 输入框）用 FLIP：切换前后各量一次位置，从旧位置滑到新位置
         *    （首页有展开的目录时从上往下排、否则居中，见 .heroArea:has(.catalog)）
         *  · 系统「减少动态效果」或浏览器不支持时直接切换；动画期间忽略重复点击
         * --------------------------------------------------------------------- */
        var EASE = "cubic-bezier(.22, 1, .36, 1)";   // 与 style.css 的 --ease 一致
        var DUR = 420;

        function canAnimate(el) {
                return !!(el && el.animate) &&
                        !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        }

        /** 首页里参与位移的块（hero 的直接子节点）及其当前顶边位置 */
        function heroKids(oRoot) {
                var oHero = oRoot && oRoot.closest ? oRoot.closest(".heroArea") : null;
                return oHero ? Array.prototype.slice.call(oHero.children) : [];
        }

        function tops(aEls) {
                return aEls.map(function (el) { return el.getBoundingClientRect().top; });
        }

        /** FLIP：从切换前的位置滑到现在的位置 */
        function flip(aEls, aBefore, aAfter) {
                aEls.forEach(function (el, i) {
                        var dy = aBefore[i] - aAfter[i];
                        if (Math.abs(dy) > 0.5) {
                                el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: DUR, easing: EASE });
                        }
                });
        }

        /** 切换：改状态、记偏好、重绘；返回重绘后的新 DOM（HTML 控件重绘会换掉根节点） */
        function swap(cfg, st) {
                st.collapsed = !st.collapsed;
                if (cfg.onToggle) {
                        cfg.onToggle(st.collapsed);
                }
                if (cfg.onRedraw) {
                        cfg.onRedraw();
                }
                return st.dom ? st.dom() : null;
        }

        /** 展开后焦点给搜索框（没有搜索框就给收起按钮）；收起后给胶囊 */
        function focusAfter(oDom, st) {
                var oFocus = oDom && (oDom.querySelector(st.collapsed ? ".catToggle" : ".catQ") || oDom.querySelector(".catFold"));
                if (oFocus) {
                        oFocus.focus({ preventScroll: true });
                }
        }

        function toggle(oRoot, cfg, st) {
                if (st.animating) {
                        return;
                }
                if (!canAnimate(oRoot)) {
                        focusAfter(swap(cfg, st), st);
                        return;
                }
                st.animating = true;
                var fnDone = function () { st.animating = false; };
                if (st.collapsed) {
                        animateOpen(oRoot, cfg, st, fnDone);
                } else {
                        animateClose(oRoot, cfg, st, fnDone);
                }
        }

        function animateOpen(oRoot, cfg, st, fnDone) {
                var aKids = heroKids(oRoot);
                var aBefore = tops(aKids);
                var oPill = oRoot.querySelector(".catToggle");
                var rP = oPill ? oPill.getBoundingClientRect() : null;
                if (rP) {
                        st.pillW = rP.width;
                        st.pillH = rP.height;
                }
                var oDom = swap(cfg, st);
                var aAfter = tops(aKids);
                var oCard = oDom && oDom.querySelector(".catalog");
                // 先量完再开动画（动画开始后量到的位置会带上位移）
                var rC = oCard ? oCard.getBoundingClientRect() : null;
                var iHost = oDom ? aKids.indexOf(closestKid(oDom, aKids)) : -1;
                var dyHost = iHost >= 0 ? aBefore[iHost] - aAfter[iHost] : 0;
                flip(aKids, aBefore, aAfter);
                if (oCard && rC && rP) {
                        var t = Math.max(0, rP.top - (rC.top + dyHost));
                        var l = Math.max(0, rP.left - rC.left);
                        var r = Math.max(0, rC.right - rP.right);
                        var b = Math.max(0, rC.bottom + dyHost - rP.bottom);
                        // 终点外扩 12px：动画期间也不裁掉卡片阴影，结束后撤掉 clip 时不跳
                        oCard.animate([
                                { clipPath: "inset(" + t + "px " + r + "px " + b + "px " + l + "px round " + (rP.height / 2) + "px)" },
                                { clipPath: "inset(-12px -12px -12px -12px round 28px)" }
                        ], { duration: DUR, easing: EASE });
                        Array.prototype.forEach.call(oCard.children, function (el) {
                                el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 60, easing: "ease-out", fill: "backwards" });
                        });
                        Array.prototype.slice.call(oCard.querySelectorAll(".catRow, .catGroup"), 0, 10).forEach(function (el, i) {
                                el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
                                        { duration: 300, delay: 140 + i * 30, easing: EASE, fill: "backwards" });
                        });
                        var oChev = oCard.querySelector(".catFold svg");
                        if (oChev) {
                                oChev.animate([{ transform: "rotate(180deg)" }, { transform: "none" }], { duration: DUR, easing: EASE });
                        }
                }
                focusAfter(oDom, st);
                window.setTimeout(fnDone, DUR + 40);
        }

        function animateClose(oRoot, cfg, st, fnDone) {
                var oCard = oRoot.querySelector(".catalog");
                if (!oCard) {
                        focusAfter(swap(cfg, st), st);
                        fnDone();
                        return;
                }
                var rC = oCard.getBoundingClientRect();
                var pw = Math.min(st.pillW || 190, rC.width), ph = st.pillH || 34;
                var l = Math.max(0, (rC.width - pw) / 2), b = Math.max(0, rC.height - ph);
                Array.prototype.forEach.call(oCard.children, function (el) {
                        el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease-in", fill: "forwards" });
                });
                var oShrink = oCard.animate([
                        { clipPath: "inset(-12px -12px -12px -12px round 28px)" },
                        { clipPath: "inset(0px " + l + "px " + b + "px " + l + "px round " + (ph / 2) + "px)" }
                ], { duration: 260, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
                // 页面在后台时动画时间线会暂停、onfinish 迟迟不来 → 定时兜底，两者谁先到都只走一次
                var bNext = false;
                var fnNext = function () {
                        if (bNext) {
                                return;
                        }
                        bNext = true;
                        var aKids = heroKids(oCard);
                        var aBefore = tops(aKids);
                        var oDom = swap(cfg, st);
                        flip(aKids, aBefore, tops(aKids));
                        var oChev = oDom && oDom.querySelector(".catToggle .ctChev");
                        if (oChev) {
                                oChev.animate([{ transform: "rotate(180deg)" }, { transform: "none" }], { duration: DUR, easing: EASE });
                        }
                        focusAfter(oDom, st);
                        window.setTimeout(fnDone, DUR + 40);
                };
                oShrink.onfinish = fnNext;
                window.setTimeout(fnNext, 260 + 80);
        }

        /** oDom 落在哪个首页子块里 */
        function closestKid(oDom, aKids) {
                for (var i = 0; i < aKids.length; i++) {
                        if (aKids[i].contains(oDom)) {
                                return aKids[i];
                        }
                }
                return null;
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
                        if (t.closest(".catToggle, .catFold")) {
                                toggle(oRoot, cfg, st);
                                return;
                        }
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
                var st = { status: "loading", items: [], message: "", query: "", category: "", collapsed: !!cfg.collapsed };
                var oCtl = new HTML({ preferDOM: false, sanitizeContent: false });
                st.dom = function () { return oCtl.getDomRef(); };   // 重绘会换掉根节点，动画 / 焦点要取最新的
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
                moduleOf: moduleOf,
                sortByModule: sortByModule,
                rowHtml: rowHtml,
                html: html
        };
});
