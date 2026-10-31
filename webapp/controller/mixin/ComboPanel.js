sap.ui.define([
        "zai/chat/utils/Toast",
        "zai/chat/service/ChatService",
        "zai/chat/utils/Formatter",
        "zai/chat/utils/ChartRenderer",
        "zai/chat/utils/ChartBuilder",
        "zai/chat/utils/DataGrid",
        "zai/chat/utils/ComboData"
], function (MessageToast, ChatService, Formatter, ChartRenderer, ChartBuilder, DataGrid, ComboData) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：右侧「组合分析」面板（20261031，一期：纯前端）
         * =====================================================================
         *  · 结果卡的表头可以拖进面板，表格工具条上也有「加入组合」；面板不跟会话走，
         *    切到别的会话可以继续往里加 —— 不同会话的报表结果放在一起
         *  · 组合方式：追加（上下拼）/ 关联（按共同列对上）/ 并排（不合并）—— 计算见 utils/ComboData
         *  · 组合结果可以生成图表、查看全部、复制、导出 CSV（复用结果卡的同一套图表面板与查看器）
         *  · 本机只记结果号与图表配置（不存数据，同 ResultRestore 的口径）；刷新后按结果号重新取明细。
         *    没有结果号的表（数据分析 SQL 结果、回答里的表格）刷新后不保留数据
         *  · 不发给模型 —— 「交给模型分析」是二期（要改 ABAP / SEGW）
         * 方法名统一 _cbx 前缀。
         * =====================================================================
         */

        var STORE_PREFIX = "zaiChat.combo.v1.";
        var MAX_ITEMS = 6;
        var PREVIEW_ROWS = 8;
        var DRAG_TYPE = "application/x-zai-combo";

        var MODES = [
                { key: "append", text: "追加", tip: "结构相近的表上下拼起来，前面加一列「来源」" },
                { key: "join", text: "关联", tip: "以第一份为主表，按共同列把其他表对上" },
                { key: "side", text: "并排", tip: "不合并，各表原样放在一起" }
        ];

        var esc = function (s) { return Formatter.escapeHtml(s === undefined || s === null ? "" : String(s)); };

        var ICON = {
                stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 3 8.5l9 4.5 9-4.5L12 4Z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg>',
                close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
                collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M15 4.5v15M9 10l2 2-2 2"/></svg>',
                drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>',
                trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5"/></svg>'
        };

        return {

                /* ---------------------------------------------------------
                 * 状态与本机记录
                 * --------------------------------------------------------- */

                _cbx: function () {
                        if (!this._oCombo) {
                                this._oCombo = { user: "", open: false, mode: "", modeAuto: true, inner: false, items: [], keys: {}, charts: [] };
                        }
                        return this._oCombo;
                },

                _cbxKey: function () {
                        return STORE_PREFIX + this._modelUserKey();
                },

                _cbxSave: function () {
                        var c = this._cbx();
                        var o = {
                                open: c.open, mode: c.mode, modeAuto: c.modeAuto, inner: c.inner, keys: c.keys,
                                items: c.items.map(function (it) {
                                        return { id: it.id, name: it.name, sid: it.sid, sess: it.sess, at: it.at, art: it.art, type: it.type, run: it.run };
                                }),
                                charts: c.charts.map(function (ch) { return { id: ch.id, src: ch.src, cfg: ch.cfg, sig: ch.sig }; })
                        };
                        try { window.localStorage.setItem(this._cbxKey(), JSON.stringify(o)); } catch (e) { /* 存不下：只影响刷新后的恢复 */ }
                },

                /** 登录后（换账号）读本机记录；有结果号的按号重新取明细 */
                _cbxLoad: function () {
                        var that = this;
                        var c = this._cbx();
                        var sUser = this._modelUserKey();
                        if (c.user === sUser) {
                                this._cbxRender();
                                return;
                        }
                        var o = null;
                        try { o = JSON.parse(window.localStorage.getItem(this._cbxKey()) || "null"); } catch (e) { o = null; }
                        o = o && typeof o === "object" ? o : {};
                        this._oCombo = c = {
                                user: sUser, open: !!o.open, mode: o.mode || "", modeAuto: o.modeAuto !== false, inner: !!o.inner,
                                keys: o.keys && typeof o.keys === "object" ? o.keys : {},
                                charts: Array.isArray(o.charts) ? o.charts.filter(function (ch) { return ch && ch.cfg; }) : [],
                                items: (Array.isArray(o.items) ? o.items : []).slice(0, MAX_ITEMS).map(function (it) {
                                        return {
                                                id: it.id, name: it.name || "", sid: it.sid || "", sess: it.sess || "", at: it.at || "",
                                                art: it.art || "", type: it.type || "", run: it.run || "", ds: null,
                                                st: it.art ? "loading" : "lost",
                                                why: it.art ? "" : "这份表没有结果号，刷新后数据没有保留，请回原对话重新加入"
                                        };
                                })
                        };
                        this._cbxRender();
                        c.items.filter(function (it) { return it.st === "loading"; }).forEach(function (it) {
                                that._cbxFetch(it);
                        });
                },

                _cbxFetch: function (it) {
                        var that = this;
                        var c = this._cbx();
                        var p = it.type === "FIORI_RESULT"
                                ? ChatService.getFioriReportResult(it.art)
                                : ChatService.getReportResult(it.art);
                        Promise.resolve(p).then(function (oRes) {
                                if (!oRes || (!oRes.rowsJson && !oRes.schemaJson && !oRes.rowCount)) {
                                        throw new Error((oRes && oRes.message) || "结果已失效");
                                }
                                var oDs = that._rptDataset(oRes, it.run);
                                if (!oDs.columns.length) {
                                        throw new Error("结果没有列定义");
                                }
                                it.ds = oDs;
                                it.name = it.name || oDs.name;
                                it.st = "ok";
                        }).catch(function (e) {
                                it.st = "lost";
                                it.why = "取不回：" + ((e && e.message) || String(e));
                        }).then(function () {
                                if (that._oCombo === c) {
                                        that._cbxChanged(false);
                                }
                        });
                },

                /* ---------------------------------------------------------
                 * 加入 / 移除
                 * --------------------------------------------------------- */

                /**
                  * 把消息里的一张表加入组合。
                  * @param {object} oEntry 消息条目
                  * @param {object} oDs 数据集
                  * @param {number|null} iDs 在 analysis.datasets 里的下标（正文表格为 null）
                  */
                _cbxAddFromEntry: function (oEntry, oDs, iDs) {
                        var c = this._cbx();
                        if (!oDs || !(oDs.columns || []).length || !(oDs.rows || []).length) {
                                MessageToast.show("这张表没有数据，不能加入组合");
                                return;
                        }
                        // 结果卡（报表 / Fiori）的那张表才有结果号，刷新后能取回
                        var sArt = oEntry && oEntry.localResult && oEntry.artifactId && iDs === 0 ? oEntry.artifactId : "";
                        var sSrc = (oEntry ? oEntry.uid : "") + ":" + (iDs === null || iDs === undefined ? "md" : iDs);
                        var oDup = c.items.filter(function (it) {
                                return (sArt && it.art === sArt) || it.src === sSrc;
                        })[0];
                        if (oDup) {
                                this._cbxOpen(true);
                                this._cbxFlash(oDup.id);
                                MessageToast.show("这份结果已经在组合里了");
                                return;
                        }
                        if (c.items.length >= MAX_ITEMS) {
                                this._cbxOpen(true);
                                MessageToast.show("组合里最多放 " + MAX_ITEMS + " 份结果，先移除一份");
                                return;
                        }
                        var oSess = this.getView().getModel("chat").getProperty("/currentSession") || {};
                        var it = {
                                id: "x" + this._newSessionId().substring(0, 8),
                                name: oDs.name || "结果",
                                sid: oSess.id || this._sMessagesSession || "",
                                sess: this._stripRolePrefix ? this._stripRolePrefix(this.getView().getModel("session").getProperty("/title") || "") : "",
                                at: Formatter.formatTime(""),
                                art: sArt,
                                type: sArt ? (oEntry.fiori ? "FIORI_RESULT" : "REPORT_RESULT") : "",
                                run: sArt ? String(oEntry.runId || "") : "",
                                src: sSrc,
                                ds: oDs,
                                st: "ok"
                        };
                        c.items.push(it);
                        if (c.items.length > 1) {
                                c.keys[it.id] = ComboData.suggestKeys(this._cbxDs(c.items[0]), oDs);
                        }
                        c.open = true;
                        this._cbxChanged(true);
                        this._cbxFlash(it.id);
                },

                _cbxRemove: function (sId) {
                        var c = this._cbx();
                        var i = this._cbxIndex(sId);
                        if (i < 0) {
                                return;
                        }
                        c.items.splice(i, 1);
                        delete c.keys[sId];
                        c.charts = c.charts.filter(function (ch) { return ch.src !== sId; });
                        if (i === 0) {
                                this._cbxResetKeys();
                        }
                        this._cbxChanged(true);
                },

                /** 关联模式：把某份设为主表（放到第一位），关联列重新按列名推荐 */
                _cbxMakeBase: function (sId) {
                        var c = this._cbx();
                        var i = this._cbxIndex(sId);
                        if (i <= 0) {
                                return;
                        }
                        c.items.unshift(c.items.splice(i, 1)[0]);
                        this._cbxResetKeys();
                        this._cbxChanged(true);
                },

                _cbxResetKeys: function () {
                        var c = this._cbx();
                        var oBase = c.items[0] && this._cbxDs(c.items[0]);
                        c.keys = {};
                        c.items.slice(1).forEach(function (it) {
                                c.keys[it.id] = oBase && it.ds ? ComboData.suggestKeys(oBase, it.ds) : [];
                        });
                },

                _cbxIndex: function (sId) {
                        var a = this._cbx().items;
                        for (var i = 0; i < a.length; i++) {
                                if (a[i].id === sId) { return i; }
                        }
                        return -1;
                },

                _cbxDs: function (it) {
                        return it && it.st === "ok" ? it.ds : null;
                },

                /* ---------------------------------------------------------
                 * 组合计算
                 * --------------------------------------------------------- */

                _cbxReady: function () {
                        return this._cbx().items.filter(function (it) { return it.st === "ok" && it.ds; });
                },

                /** @returns {{mode, ds, items}} 并排或不足两份时 ds 为空 */
                _cbxResult: function () {
                        var c = this._cbx();
                        var aOk = this._cbxReady();
                        var sMode = c.mode;
                        if (aOk.length < 2) {
                                return { mode: aOk.length ? "single" : "none", ds: aOk[0] ? aOk[0].ds : null, items: aOk };
                        }
                        if (!sMode || c.modeAuto) {
                                sMode = c.mode = ComboData.suggestMode(aOk.map(function (it) { return it.ds; }));
                        }
                        var aDs = aOk.map(function (it) { return it.ds; });
                        var aNames = aOk.map(function (it) { return it.name; });
                        if (sMode === "append") {
                                return { mode: sMode, ds: ComboData.append(aDs, aNames), items: aOk };
                        }
                        if (sMode === "join") {
                                var aKeys = aOk.map(function (it, k) { return k ? (c.keys[it.id] || []) : []; });
                                return { mode: sMode, ds: ComboData.join(aDs, aNames, aKeys, c.inner), items: aOk };
                        }
                        return { mode: "side", ds: null, items: aOk };
                },

                /* ---------------------------------------------------------
                 * 渲染
                 * --------------------------------------------------------- */

                _cbxRoot: function () {
                        var o = this.byId("comboHost");
                        return o && o.getDomRef();
                },

                _cbxChanged: function (bSave) {
                        if (bSave) {
                                this._cbxSave();
                        }
                        this._cbxRender();
                },

                _cbxOpen: function (bOpen) {
                        var c = this._cbx();
                        if (c.open === bOpen) {
                                return;
                        }
                        c.open = bOpen;
                        this._cbxChanged(true);
                },

                /** 顶栏按钮 */
                onToggleCombo: function () {
                        this._cbxOpen(!this._cbx().open);
                },

                _cbxRender: function () {
                        var oRoot = this._cbxRoot();
                        if (!oRoot) {
                                return;
                        }
                        this._cbxBind(oRoot);
                        var c = this._cbx();
                        var n = c.items.length;
                        var bDrag = !!this._oCbxDrag;
                        var sState = c.open || bDrag ? "cbxOpen" : (n ? "cbxRail" : "cbxHidden");
                        oRoot.className = "cbx " + sState + (bDrag ? " cbxDragging" : "");
                        var oBtn = this.byId("comboToggle");
                        if (oBtn) {
                                oBtn.toggleStyleClass("comboToggleOn", c.open);
                                oBtn.setText(n ? String(n) : "");
                        }
                        if (sState === "cbxHidden") {
                                oRoot.innerHTML = "";
                                return;
                        }
                        if (sState === "cbxRail") {
                                oRoot.innerHTML = '<button type="button" class="cbxRailBtn" data-cact="open" title="展开组合分析">' +
                                        '<span class="cbxIco">' + ICON.stack + '</span><span class="cbxRailNum">' + n + "</span>" +
                                        '<span class="cbxRailTxt">组合分析</span></button>';
                                return;
                        }
                        var oBody = oRoot.querySelector(".cbxBody");
                        var iScroll = oBody ? oBody.scrollTop : 0;
                        oRoot.innerHTML = this._cbxPanelHtml();
                        oBody = oRoot.querySelector(".cbxBody");
                        if (oBody) {
                                oBody.scrollTop = iScroll;
                        }
                },

                _cbxPanelHtml: function () {
                        var c = this._cbx();
                        var n = c.items.length;
                        var s = '<div class="cbxHead"><span class="cbxIco cbxIcoAcc">' + ICON.stack + "</span>" +
                                '<span class="cbxTitle">组合分析</span>' +
                                (n ? '<span class="cbxCount">' + n + " 份</span>" : "") +
                                '<span class="cbxGrow"></span>' +
                                (n ? '<button type="button" class="cbxIconBtn" data-cact="clear" title="清空组合">' + ICON.trash + "</button>" : "") +
                                '<button type="button" class="cbxIconBtn" data-cact="close" title="收起">' + ICON.collapse + "</button></div>";
                        s += '<div class="cbxBody">';
                        if (!n) {
                                s += '<div class="cbxEmpty"><span class="cbxEmptyIco">' + ICON.stack + "</span>" +
                                        '<div class="cbxEmptyTitle">把几份报表结果放在一起看</div>' +
                                        '<div class="cbxEmptySub">按住结果表头拖到这里，或点表格下方的「加入组合」。可以切到别的会话继续加。</div></div>';
                        }
                        var oRes = this._cbxResult();
                        var bJoin = oRes.mode === "join";
                        var iBase = 0;
                        if (n) {
                                s += '<div class="cbxItems">';
                                c.items.forEach(function (it, i) {
                                        var bOk = it.st === "ok" && it.ds;
                                        var aMeta = [];
                                        if (it.sess) { aMeta.push(esc(it.sess)); }
                                        if (it.at) { aMeta.push(esc(it.at)); }
                                        var oTr = bOk ? ComboData.truncInfo(it.ds, it.type) : null;
                                        if (bOk) {
                                                aMeta.push(it.ds.rows.length + "×" + it.ds.columns.length);
                                        }
                                        var bBase = bJoin && bOk && i === iBase;
                                        s += '<div class="cbxItem' + (bOk ? "" : " cbxItemDim") + '" data-id="' + esc(it.id) + '">' +
                                                '<div class="cbxItemTop"><span class="cbxItemName" title="' + esc(it.name) + '">' + esc(it.name) + "</span>" +
                                                (bBase ? '<span class="cbxTag">主表</span>' : "") +
                                                (bJoin && bOk && i > 0 ? '<button type="button" class="cbxLink" data-cact="base" data-id="' + esc(it.id) + '">设为主表</button>' : "") +
                                                '<button type="button" class="cbxX" data-cact="remove" data-id="' + esc(it.id) + '" title="移出组合">' + ICON.close + "</button></div>" +
                                                '<div class="cbxItemMeta">' +
                                                (it.sid ? '<button type="button" class="cbxLink cbxGoto" data-cact="goto" data-sid="' + esc(it.sid) + '" title="打开来源会话">' + (aMeta.shift() || "来源会话") + "</button>" : "") +
                                                (aMeta.length ? "<span>" + aMeta.join(" · ") + "</span>" : "") + "</div>" +
                                                (oTr ? '<div class="cbxItemNote cbxWarn">' + esc(oTr.text) + "</div>" : "") +
                                                (it.st === "loading" ? '<div class="cbxItemNote">正在取回数据…</div>' : "") +
                                                (it.st === "lost" ? '<div class="cbxItemNote cbxWarn">' + esc(it.why || "数据不可用") + "</div>" : "") +
                                                "</div>";
                                });
                                s += "</div>";
                        }
                        s += '<div class="cbxDrop"><span class="cbxIco">' + ICON.drop + "</span>" +
                                (n ? "拖到这里加入" : "松开即可加入") + "</div>";
                        if (oRes.items.length >= 2) {
                                s += '<div class="cbxSec"><div class="cbxSecTitle">组合方式</div><div class="cbxSeg">' +
                                        MODES.map(function (m) {
                                                return '<button type="button" class="cbxSegBtn' + (m.key === oRes.mode ? " on" : "") +
                                                        '" data-cact="mode" data-mode="' + m.key + '" title="' + esc(m.tip) + '">' + m.text + "</button>";
                                        }).join("") + "</div>";
                                if (bJoin) {
                                        s += this._cbxKeysHtml(oRes.items);
                                }
                                s += "</div>";
                        }
                        if (oRes.ds || oRes.mode === "side") {
                                s += this._cbxPreviewHtml(oRes);
                        }
                        s += this._cbxChartsHtml(oRes);
                        if (n) {
                                s += '<div class="cbxFoot">组合只在本页计算，数据不会发给模型。</div>';
                        }
                        s += "</div>";
                        return s;
                },

                _cbxKeysHtml: function (aOk) {
                        var c = this._cbx();
                        var oBase = aOk[0].ds;
                        var fnOpts = function (oDs, iSel) {
                                return (oDs.columns || []).map(function (col, i) {
                                        return '<option value="' + i + '"' + (i === iSel ? " selected" : "") + ">" + esc(ComboData.label(col, i)) + "</option>";
                                }).join("");
                        };
                        var s = "";
                        aOk.slice(1).forEach(function (it) {
                                var aK = c.keys[it.id] || [];
                                s += '<div class="cbxKeys"><div class="cbxKeysHead">「' + esc(it.name) + "」按这些列对上主表</div>";
                                if (!aK.length) {
                                        s += '<div class="cbxItemNote cbxWarn">没找到同名的列，请手动选关联列</div>';
                                }
                                aK.forEach(function (p, j) {
                                        s += '<div class="cbxKeyRow"><select class="cbxSel" data-cch="key" data-id="' + esc(it.id) + '" data-j="' + j + '" data-side="a" title="主表的列">' +
                                                fnOpts(oBase, p.a) + '</select><span class="cbxEq">=</span>' +
                                                '<select class="cbxSel" data-cch="key" data-id="' + esc(it.id) + '" data-j="' + j + '" data-side="b" title="这份表的列">' +
                                                fnOpts(it.ds, p.b) + "</select>" +
                                                '<button type="button" class="cbxX" data-cact="keydel" data-id="' + esc(it.id) + '" data-j="' + j + '" title="去掉这一对">' + ICON.close + "</button></div>";
                                });
                                s += '<button type="button" class="cbxLink" data-cact="keyadd" data-id="' + esc(it.id) + '">+ 加一对关联列</button></div>';
                        });
                        s += '<label class="cbxCheck"><input type="checkbox" data-cch="inner"' + (c.inner ? " checked" : "") +
                                "/>只保留每份都对上的行</label>";
                        return s;
                },

                /** 20261031（二期方案 §7.1）：来源被截断时写明哪一份、取回多少、后端共多少，以及对组合结果的影响 */
                _cbxTruncHtml: function (oRes) {
                        var aIt = oRes.items || [];
                        var aNotes = ComboData.truncNotes(aIt.map(function (it) { return it.ds; }),
                                aIt.map(function (it) { return it.name; }),
                                aIt.map(function (it) { return it.type; }), oRes.mode);
                        if (!aNotes.length) { return ""; }
                        var sTail = aNotes.pop();
                        return '<div class="cbxTrunc">' + aNotes.map(function (t) { return "<div>" + esc(t) + "</div>"; }).join("") +
                                '<div class="cbxTruncTail">' + esc(sTail) + "</div></div>";
                },

                _cbxPreviewHtml: function (oRes) {
                        var s = '<div class="cbxSec">';
                        var sTrunc = this._cbxTruncHtml(oRes);
                        if (oRes.mode === "side") {
                                s += '<div class="cbxSecTitle">并排查看</div>' + sTrunc;
                                oRes.items.forEach(function (it) {
                                        s += '<div class="cbxSide"><div class="cbxSideHead"><span class="cbxItemName">' + esc(it.name) + "</span>" +
                                                '<span class="cbxMeta">' + it.ds.rows.length + " 行</span></div>" +
                                                DataGrid.tableHtml(it.ds.columns, it.ds.rows.slice(0, 5), { cls: "cbxTable" }) +
                                                '<div class="cbxActs">' +
                                                '<button type="button" class="dtBtn" data-cact="chart" data-src="' + esc(it.id) + '">生成图表</button>' +
                                                '<button type="button" class="dtBtn" data-cact="all" data-src="' + esc(it.id) + '">查看全部</button></div></div>';
                                });
                                s += '<div class="cbxActs"><button type="button" class="dtBtn" data-cact="csv">导出 CSV（全部表）</button></div>';
                                return s + "</div>";
                        }
                        var oDs = oRes.ds;
                        var sTitle = oRes.mode === "single" ? "预览" : "组合结果";
                        s += '<div class="cbxSecTitle">' + sTitle + '<span class="cbxMeta">' + oDs.rows.length + " 行 × " + oDs.columns.length + " 列</span></div>";
                        if (oDs.note) {
                                s += '<div class="cbxNote">' + esc(oDs.note) + "</div>";
                        }
                        s += sTrunc;
                        if (oRes.mode === "single") {
                                s += '<div class="cbxNote">再加一份结果就能组合。</div>';
                        }
                        s += oDs.rows.length
                                ? DataGrid.tableHtml(oDs.columns, oDs.rows.slice(0, PREVIEW_ROWS), { cls: "cbxTable" })
                                : '<div class="cbxNote cbxWarn">没有对上的行，换一下关联列试试。</div>';
                        s += '<div class="cbxActs">' +
                                '<button type="button" class="dtBtn dtPrimary" data-cact="chart" data-src="combo">生成图表</button>' +
                                (oDs.rows.length > PREVIEW_ROWS ? '<button type="button" class="dtBtn" data-cact="all" data-src="combo">查看全部 ' + oDs.rows.length + " 行</button>" : "") +
                                '<button type="button" class="dtBtn" data-cact="copy">复制</button>' +
                                '<button type="button" class="dtBtn" data-cact="csv">导出 CSV</button></div>';
                        return s + "</div>";
                },

                /** 图表签名：列标签串（组合方式 / 关联列变了，下标对不上时提示重画，不画错图） */
                _cbxSig: function (oDs) {
                        return (oDs && oDs.columns || []).map(function (c, i) { return ComboData.label(c, i); }).join("|");
                },

                _cbxChartDs: function (sSrc, oRes) {
                        if (sSrc === "combo") {
                                return oRes.ds;
                        }
                        var i = this._cbxIndex(sSrc);
                        return i >= 0 ? this._cbxDs(this._cbx().items[i]) : null;
                },

                _cbxChartsHtml: function (oRes) {
                        var that = this;
                        var aCh = this._cbx().charts;
                        if (!aCh.length) {
                                return "";
                        }
                        var s = '<div class="cbxSec"><div class="cbxSecTitle">图表</div>';
                        aCh.forEach(function (ch) {
                                var oDs = that._cbxChartDs(ch.src, oRes);
                                var bOk = oDs && that._cbxSig(oDs) === ch.sig;
                                var o = bOk ? ChartRenderer.render(oDs, ch.cfg) : null;
                                s += '<div class="chartCard cbxChart" data-cid="' + esc(ch.id) + '"><div class="ccHead"><span class="ccTitle">' +
                                        esc(ch.cfg.title || (oDs && oDs.name) || "图表") + '</span><span class="ccActs">' +
                                        (bOk ? '<button type="button" class="ccAct" data-cact="cedit" data-cid="' + esc(ch.id) + '">编辑</button>' +
                                                '<button type="button" class="ccAct" data-cact="csvg" data-cid="' + esc(ch.id) + '">下载</button>' : "") +
                                        '<button type="button" class="ccAct ccDel" data-cact="cdel" data-cid="' + esc(ch.id) + '">移除</button></span></div>' +
                                        '<div class="ccBody">' + (bOk
                                                ? (o.svg || '<div class="cbEmpty">' + esc(o.note) + "</div>")
                                                : '<div class="cbEmpty">数据结构变了（组合方式、关联列或来源有变化），请移除后重新生成</div>') + "</div></div>";
                        });
                        return s + "</div>";
                },

                /** 新加入的那张小卡闪一下，告诉用户放到哪了 */
                _cbxFlash: function (sId) {
                        var oRoot = this._cbxRoot();
                        var oEl = oRoot && oRoot.querySelector('.cbxItem[data-id="' + sId + '"]');
                        if (oEl) {
                                oEl.classList.add("cbxFlash");
                                oEl.scrollIntoView({ block: "nearest" });
                                setTimeout(function () { oEl.classList.remove("cbxFlash"); }, 1200);
                        }
                },

                /* ---------------------------------------------------------
                 * 事件：面板内点击 / 选择 / 放下；全局拖动开始 / 结束
                 * --------------------------------------------------------- */

                _cbxBind: function (oRoot) {
                        var that = this;
                        if (oRoot._cbxBound) {
                                return;
                        }
                        oRoot._cbxBound = true;
                        oRoot.addEventListener("click", function (e) {
                                var oBtn = e.target.closest && e.target.closest("[data-cact]");
                                if (oBtn && oRoot.contains(oBtn)) {
                                        that._cbxAction(oBtn);
                                }
                        });
                        oRoot.addEventListener("change", function (e) {
                                var oEl = e.target;
                                if (oEl && oEl.getAttribute && oEl.getAttribute("data-cch")) {
                                        that._cbxChange(oEl);
                                }
                        });
                        var fnOurs = function (e) {
                                var t = e.dataTransfer && e.dataTransfer.types;
                                return !!t && Array.prototype.indexOf.call(t, DRAG_TYPE) >= 0;
                        };
                        oRoot.addEventListener("dragover", function (e) {
                                if (!fnOurs(e)) {
                                        return;
                                }
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "copy";
                                oRoot.classList.add("cbxOver");
                        });
                        oRoot.addEventListener("dragleave", function (e) {
                                if (!e.relatedTarget || !oRoot.contains(e.relatedTarget)) {
                                        oRoot.classList.remove("cbxOver");
                                }
                        });
                        oRoot.addEventListener("drop", function (e) {
                                if (!fnOurs(e)) {
                                        return;
                                }
                                e.preventDefault();
                                oRoot.classList.remove("cbxOver");
                                var d = that._oCbxDrag;
                                that._oCbxDrag = null;
                                if (d) {
                                        that._cbx().open = true;
                                        that._cbxAddDragged(d);
                                }
                        });
                        this._cbxBindDrag();
                },

                /** 结果表头（.analysisDsHead[draggable]）拖动：记下来源，面板展开成放置区 */
                _cbxBindDrag: function () {
                        var that = this;
                        if (this._bCbxDragBound) {
                                return;
                        }
                        this._bCbxDragBound = true;
                        document.addEventListener("dragstart", function (e) {
                                var oHead = e.target && e.target.closest ? e.target.closest(".analysisDsHead[draggable]") : null;
                                var oHost = oHead && oHead.closest("[data-uid]");
                                if (!oHost) {
                                        return;
                                }
                                that._oCbxDrag = { uid: oHost.getAttribute("data-uid"), ds: parseInt(oHead.getAttribute("data-ds"), 10) || 0 };
                                e.dataTransfer.effectAllowed = "copy";
                                e.dataTransfer.setData(DRAG_TYPE, "1");
                                e.dataTransfer.setData("text/plain", oHead.querySelector(".dsName") ? oHead.querySelector(".dsName").textContent : "");
                                oHead.classList.add("dsDragging");
                                // 先让浏览器拍下拖动影像，再展开面板（同一帧改布局会拍到空白）
                                setTimeout(function () {
                                        if (that._oCbxDrag) {
                                                that._cbxRender();
                                        }
                                }, 0);
                        });
                        document.addEventListener("dragend", function (e) {
                                var oHead = e.target && e.target.closest ? e.target.closest(".analysisDsHead") : null;
                                if (oHead) {
                                        oHead.classList.remove("dsDragging");
                                }
                                if (that._oCbxDrag !== undefined) {
                                        that._oCbxDrag = null;
                                        var oRoot = that._cbxRoot();
                                        if (oRoot) {
                                                oRoot.classList.remove("cbxOver");
                                        }
                                        that._cbxRender();
                                }
                        });
                },

                _cbxAddDragged: function (d) {
                        var oHit = this._entryByUid(d.uid);
                        var oEntry = oHit && oHit.entry;
                        var oDs = oEntry && oEntry.analysis && (oEntry.analysis.datasets || [])[d.ds];
                        if (!oDs || oDs.status !== "OK") {
                                this._cbxRender();
                                MessageToast.show("没读到这张表的数据");
                                return;
                        }
                        this._cbxAddFromEntry(oEntry, oDs, d.ds);
                },

                _cbxAction: function (oBtn) {
                        var that = this;
                        var c = this._cbx();
                        var sAct = oBtn.getAttribute("data-cact");
                        var sId = oBtn.getAttribute("data-id");
                        var oRes;
                        switch (sAct) {
                        case "open":
                                this._cbxOpen(true);
                                return;
                        case "close":
                                this._cbxOpen(false);
                                return;
                        case "clear":
                                c.items = [];
                                c.keys = {};
                                c.charts = [];
                                c.modeAuto = true;
                                c.mode = "";
                                this._cbxChanged(true);
                                return;
                        case "remove":
                                this._cbxRemove(sId);
                                return;
                        case "base":
                                this._cbxMakeBase(sId);
                                return;
                        case "goto":
                                this._cbxGoto(oBtn.getAttribute("data-sid"));
                                return;
                        case "mode":
                                c.mode = oBtn.getAttribute("data-mode");
                                c.modeAuto = false;
                                this._cbxChanged(true);
                                return;
                        case "keyadd":
                                (c.keys[sId] = c.keys[sId] || []).push({ a: 0, b: 0 });
                                this._cbxChanged(true);
                                return;
                        case "keydel":
                                (c.keys[sId] || []).splice(parseInt(oBtn.getAttribute("data-j"), 10), 1);
                                this._cbxChanged(true);
                                return;
                        }
                        oRes = this._cbxResult();
                        var sSrc = oBtn.getAttribute("data-src") || "combo";
                        var oDs = this._cbxChartDs(sSrc, oRes);
                        if (sAct === "csv" && oRes.mode === "side") {
                                this._download("﻿" + ComboData.sideCsv(oRes.items.map(function (it) { return it.ds; }),
                                        oRes.items.map(function (it) { return it.name; })), "组合分析.csv", "text/csv;charset=utf-8");
                                return;
                        }
                        if (sAct === "chart" && oDs) {
                                var oA = ChartRenderer.analyze(oDs);
                                if (!oA.chartable) {
                                        MessageToast.show(this._rb().getText("chartNotSuitable", [oA.reason]));
                                        return;
                                }
                                ChartBuilder.open(oDs, null, function (oCfg) {
                                        c.charts.push({ id: "c" + that._newSessionId().substring(0, 8), src: sSrc, cfg: oCfg, sig: that._cbxSig(oDs) });
                                        that._cbxChanged(true);
                                });
                        } else if (sAct === "all" && oDs) {
                                this._openDataGrid(oDs);
                        } else if (sAct === "copy" && oDs) {
                                this._copyText(ChartRenderer.toDelimited(oDs, "\t"), this._rb().getText("copiedForExcel"));
                        } else if (sAct === "csv" && oDs) {
                                this._download("﻿" + ChartRenderer.toDelimited(oDs, ","), "组合分析.csv", "text/csv;charset=utf-8");
                        } else if (/^c(edit|svg|del)$/.test(sAct)) {
                                var sCid = oBtn.getAttribute("data-cid");
                                var oCh = c.charts.filter(function (x) { return x.id === sCid; })[0];
                                if (!oCh) {
                                        return;
                                }
                                var oCds = this._cbxChartDs(oCh.src, oRes);
                                if (sAct === "cdel") {
                                        c.charts = c.charts.filter(function (x) { return x !== oCh; });
                                        this._cbxChanged(true);
                                } else if (sAct === "cedit" && oCds) {
                                        ChartBuilder.open(oCds, oCh.cfg, function (oCfg) {
                                                oCh.cfg = oCfg;
                                                that._cbxChanged(true);
                                        }, { edit: true });
                                } else if (sAct === "csvg" && oCds) {
                                        var oR = ChartRenderer.render(oCds, oCh.cfg);
                                        if (oR.svg) {
                                                this._download(ChartRenderer.standalone(oR.svg), (oCh.cfg.title || oCds.name || "图表") + ".svg", "image/svg+xml");
                                        }
                                }
                        }
                },

                _cbxChange: function (oEl) {
                        var c = this._cbx();
                        var sKind = oEl.getAttribute("data-cch");
                        if (sKind === "inner") {
                                c.inner = !!oEl.checked;
                        } else if (sKind === "key") {
                                var p = (c.keys[oEl.getAttribute("data-id")] || [])[parseInt(oEl.getAttribute("data-j"), 10)];
                                if (p) {
                                        p[oEl.getAttribute("data-side") === "b" ? "b" : "a"] = parseInt(oEl.value, 10) || 0;
                                }
                        }
                        this._cbxChanged(true);
                },

                /** 点来源：打开那个会话（面板保持不动） */
                _cbxGoto: function (sSid) {
                        var oMeta = sSid && this._findSession(sSid);
                        if (!oMeta) {
                                MessageToast.show("来源会话已不在列表里");
                                return;
                        }
                        this._restoreWorkspaceBySession(oMeta);
                        this._loadHistoryFor(sSid, oMeta.Mode === "AGENT");
                }
        };
});
