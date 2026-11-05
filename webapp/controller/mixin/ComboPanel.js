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
         *  · 20261031 二期「交给模型分析」（设计：功能计划书/组合分析/01-二期方案 V1.1）：确认卡 → 新开
         *    「组合分析」会话 → ComboCreate（只提交组合方式 / 关联列 / 来源结果号 / 汇总列，后端在全量
         *    存储行上重新组合并登记成 COMBO_RESULT）→ 插入组合结果卡 → 以它为聚焦结果自动发分析问题。
         *    后端没部署（SEGW 没有 ComboCreate）时不显示按钮，一期功能照旧
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
                        // 20261031 二期：后端有没有部署「交给模型分析」（没有就不显示按钮）
                        Promise.resolve(ChatService.comboAvailable ? ChatService.comboAvailable() : false).then(function (b) {
                                that._bCbxModel = !!b;
                                if (that._oCombo === c) {
                                        that._cbxRender();
                                }
                        });
                },

                _cbxFetch: function (it) {
                        var that = this;
                        var c = this._cbx();
                        var p = it.type === "FIORI_RESULT"
                                ? ChatService.getFioriReportResult(it.art)
                                : (it.type === "COMBO_RESULT" ? ChatService.getComboResult(it.art) : ChatService.getReportResult(it.art));
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
                                type: sArt ? (oEntry.combo ? "COMBO_RESULT" : (oEntry.fiori ? "FIORI_RESULT" : "REPORT_RESULT")) : "",
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
                                s += this._cbxSendHtml(oRes);
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
                        case "ask":
                                c.confirm = true;
                                c.sendErr = "";
                                this._cbxRender();
                                return;
                        case "askno":
                                c.confirm = false;
                                c.sendErr = "";
                                this._cbxRender();
                                return;
                        case "send":
                                this._cbxSend();
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
                        if (sKind === "grp") {
                                c.groupBy = c.groupBy || ["", ""];
                                c.groupBy[parseInt(oEl.getAttribute("data-j"), 10) || 0] = oEl.value || "";
                                this._cbxRender();
                                return;
                        }
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

                /* ---------------------------------------------------------
                 * 20261031 二期：交给模型分析
                 * --------------------------------------------------------- */

                /** 不能发的原因（能发返回 ""） */
                _cbxSendBlock: function (oRes) {
                        var c = this._cbx();
                        if (c.items.some(function (it) { return it.st === "loading"; })) {
                                return "还有结果在取回中，稍等一下";
                        }
                        var aBad = [];
                        c.items.forEach(function (it) {
                                if (it.st !== "ok") {
                                        aBad.push("「" + it.name + "」数据不可用");
                                } else if (!it.art) {
                                        aBad.push("「" + it.name + "」没有结果号（数据分析的表、回答里的表格不能交给模型）");
                                } else if (it.type === "COMBO_RESULT") {
                                        aBad.push("「" + it.name + "」本身是组合结果，不能再组合交给模型");
                                }
                        });
                        if (aBad.length) {
                                return aBad.join("；");
                        }
                        if (oRes.items.length < 2) {
                                return "至少要两份结果";
                        }
                        if (oRes.mode === "join" && c.items.slice(1).some(function (it) { return !(c.keys[it.id] || []).length; })) {
                                return "关联模式下每份都要选关联列";
                        }
                        return "";
                },

                /** 汇总列候选：组合预览里的文字列（并排时「来源」固定在第一位） */
                _cbxGroupCols: function (oRes) {
                        var oDs = oRes.mode === "side"
                                ? ComboData.append(oRes.items.map(function (it) { return it.ds; }), oRes.items.map(function (it) { return it.name; }))
                                : oRes.ds;
                        if (!oDs) {
                                return [];
                        }
                        var mNum = {};
                        ChartRenderer.analyze(oDs).numeric.forEach(function (i) { mNum[i] = true; });
                        return (oDs.columns || []).map(function (col, i) {
                                return { name: col.name, label: ComboData.label(col, i), i: i };
                        }).filter(function (x) { return !mNum[x.i] && x.name !== "_SRC"; });
                },

                _cbxSendHtml: function (oRes) {
                        var c = this._cbx();
                        if (!this._bCbxModel) {
                                return '<div class="cbxFoot">组合只在本页计算，数据不会发给模型。</div>';
                        }
                        if (c.sending) {
                                return '<div class="cbxSend"><button type="button" class="dtBtn dtPrimary cbxSendBtn" disabled>' +
                                        '<span class="cbxSpin"></span>正在组合…</button>' +
                                        '<div class="cbxNote">后端正在读取全部存储数据重新组合，数据多时要几秒到十几秒。</div></div>';
                        }
                        var sBlock = this._cbxSendBlock(oRes);
                        if (!c.confirm) {
                                return '<div class="cbxSend"><button type="button" class="dtBtn dtPrimary cbxSendBtn" data-cact="ask"' +
                                        (sBlock ? " disabled" : "") + ">交给模型分析</button>" +
                                        '<div class="cbxNote' + (sBlock ? " cbxWarn" : "") + '">' +
                                        esc(sBlock || "会新开一个「组合分析」会话：后端在全部存储数据上重新组合，再把统计、汇总和部分明细发给模型。") +
                                        "</div></div>";
                        }
                        return this._cbxConfirmHtml(oRes, sBlock);
                },

                _cbxConfirmHtml: function (oRes, sBlock) {
                        var c = this._cbx();
                        var aG = this._cbxGroupCols(oRes);
                        var aSel = c.groupBy || ["", ""];
                        var fnOpts = function (sSel, bOptional) {
                                return '<option value="">' + (bOptional ? "（不用）" : "自动选") + "</option>" +
                                        aG.map(function (g) {
                                                return '<option value="' + esc(g.name) + '"' + (g.name === sSel ? " selected" : "") + ">" + esc(g.label) + "</option>";
                                        }).join("");
                        };
                        var sMode = { append: "追加（上下拼）", join: "关联（以第一份为主表）", side: "并排（不合并，按「来源」分开汇总）" }[oRes.mode] || "";
                        var s = '<div class="cbxConfirm"><div class="cbxSecTitle">确认交给模型分析</div>' +
                                '<div class="cbxCfRow"><span class="cbxCfK">组合方式</span><span>' + esc(sMode) + "</span></div>" +
                                '<div class="cbxCfRow"><span class="cbxCfK">来源</span><span class="cbxCfList">' +
                                oRes.items.map(function (it, i) {
                                        var oTr = ComboData.truncInfo(it.ds, it.type);
                                        return "<span>" + (i + 1) + ". " + esc(it.name) + "：" +
                                                (oTr ? esc(oTr.total ? "页面 " + oTr.rows + " 行 / 后端共 " + oTr.total + " 行" : "页面 " + oTr.rows + " 行，不是全部") : it.ds.rows.length + " 行") +
                                                "</span>";
                                }).join("") + "</span></div>" +
                                '<div class="cbxCfRow"><span class="cbxCfK">汇总维度</span><span class="cbxCfSel">' +
                                '<select class="cbxSel" data-cch="grp" data-j="0" title="按哪一列分组汇总">' + fnOpts(aSel[0], false) + "</select>" +
                                '<select class="cbxSel" data-cch="grp" data-j="1" title="第二个分组列（可选）">' + fnOpts(aSel[1], true) + "</select></span></div>" +
                                '<div class="cbxNote">发给模型：后端统计 + 按所选列的分组汇总（最多 50 组）+ 第一个数值列最大、最小各 10 行；' +
                                "组合后不超过 200 行时直接发全部明细。数字都由后端在全部存储数据上算，页面预览只用了已取回的行。</div>";
                        if (c.sendErr) {
                                s += '<div class="cbxTrunc"><div>' + esc(c.sendErr) + "</div></div>";
                        }
                        s += '<div class="cbxActs"><button type="button" class="dtBtn dtPrimary" data-cact="send"' + (sBlock ? " disabled" : "") + ">发送</button>" +
                                '<button type="button" class="dtBtn" data-cact="askno">取消</button></div>';
                        if (sBlock) {
                                s += '<div class="cbxNote cbxWarn">' + esc(sBlock) + "</div>";
                        }
                        return s + "</div>";
                },

                /** 组合说明（只有说明，没有数据；关联列、汇总列都用列名） */
                _cbxSpec: function (oRes) {
                        var c = this._cbx();
                        var aIt = oRes.items;
                        var sJoin = oRes.mode === "join" ? " × " : " + ";
                        return {
                                mode: String(oRes.mode || "side").toUpperCase(),
                                inner: oRes.mode === "join" && !!c.inner,
                                title: ("组合分析：" + aIt.map(function (it) { return it.name; }).join(sJoin)).substring(0, 120),
                                sources: aIt.map(function (it) { return { artifactId: it.art, type: it.type, name: it.name }; }),
                                keys: aIt.map(function (it, k) {
                                        if (k === 0 || oRes.mode !== "join") {
                                                return null;
                                        }
                                        return (c.keys[it.id] || []).map(function (p) {
                                                var ca = aIt[0].ds.columns[p.a], cb = it.ds.columns[p.b];
                                                return ca && cb ? { a: ca.name, b: cb.name } : null;
                                        }).filter(Boolean);
                                }),
                                groupBy: (c.groupBy || []).filter(Boolean),
                                // 只给提问文字用（后端不读）：关联列的标题
                                keyLabels: oRes.mode !== "join" ? [] : (c.keys[(aIt[1] || {}).id] || []).map(function (p) {
                                        return ComboData.label(aIt[0].ds.columns[p.a], p.a);
                                })
                        };
                },

                /** 发送：后端组合并登记 → 切到新的「组合分析」会话 → 插入组合结果卡 → 自动提问 */
                _cbxSend: function () {
                        var that = this;
                        var c = this._cbx();
                        var oChat = this.getView().getModel("chat");
                        var oRes = this._cbxResult();
                        if (c.sending || this._cbxSendBlock(oRes)) {
                                return;
                        }
                        if (oChat.getProperty("/busy")) {
                                MessageToast.show(this._rb().getText("busyWait"));
                                return;
                        }
                        var oSpec = this._cbxSpec(oRes);
                        var sNew = this._newSessionId();
                        c.sending = true;
                        c.sendErr = "";
                        this._cbxRender();
                        ChatService.comboCreate({ sessionId: sNew, spec: oSpec, clientRequestId: this._newSessionId() }).then(function (oCr) {
                                c.sending = false;
                                c.confirm = false;
                                that._cbxRender();
                                that._cbxOpenSession(sNew, oCr, oSpec);
                        }).catch(function (e) {
                                c.sending = false;
                                c.sendErr = (e && e.message) || String(e);
                                that._cbxRender();
                        });
                },

                _cbxOpenSession: function (sNew, oCr, oSpec) {
                        var oChat = this.getView().getModel("chat");
                        this._sStreamToken = "";
                        oChat.setProperty("/workspaceMode", "AGENT");
                        this._setSessionContext({ id: sNew, mode: "AGENT", agentType: "AUTO", status: "IDLE" });
                        this.getView().getModel("session").setProperty("/currentId", sNew);
                        this.getView().getModel("session").setProperty("/title", "");
                        oChat.setProperty("/messages", []);
                        this._setViewLayout(true);
                        this._applyWorkspaceChrome();
                        if (this._applySessionFilter) {
                                this._applySessionFilter();
                        }
                        oCr.artifactId = oCr.artifactId || "";
                        this._cbxPushResult(oCr, sNew);
                        this._mFocusArt = this._mFocusArt || {};
                        this._mFocusArt[sNew] = oCr.artifactId;
                        var sKeys = (oSpec.keyLabels || []).length ? "，按 " + oSpec.keyLabels.join("、") + " 对上" : "";
                        var sMode = { APPEND: "追加", JOIN: "关联", SIDE: "并排" }[oSpec.mode] || "";
                        var sQ = "请分析这份组合数据（" + oSpec.sources.length + " 份结果" + sMode + sKeys + "），说说主要发现和值得注意的地方。";
                        this._executeSend({
                                mode: "AGENT", agentType: "AUTO", displayText: sQ,
                                meta: "", question: sQ, keepInput: true
                        });
                },

                /**
                  * 组合结果 → 结果卡（复用 _pushReportResult 的表格 / 图表 / 导出）；卡下方写来源与组合方式。
                  * oMore {noAppend, time} —— 刷新后恢复时只造条目（ResultRestore 插入）
                  */
                _cbxPushResult: function (oCr, sSid, oMore) {
                        var that = this;
                        var aSrc = [], oSum = {};
                        try { aSrc = JSON.parse(oCr.sourcesJson || "[]") || []; } catch (e) { aSrc = []; }
                        try { oSum = JSON.parse(oCr.summaryJson || "{}") || {}; } catch (e) { oSum = {}; }
                        var sMode = { APPEND: "追加", JOIN: "关联", SIDE: "并排" }[oCr.mode] || "";
                        return this._pushReportResult(oCr, oCr.comboId || oCr.artifactId, {
                                sessionId: sSid,
                                noAppend: !!(oMore && oMore.noAppend),
                                time: oMore && oMore.time,
                                artType: "COMBO_RESULT",
                                text: function (iTotal, oDs) {
                                        return "组合结果「" + (oCr.label || "") + "」：" + aSrc.length + " 份结果" + sMode + "，共 " + iTotal + " 行" +
                                                (oDs.truncated ? "（这里显示前 " + oDs.rows.length + " 行）" : "") + "。由后端在全部存储数据上计算" +
                                                (oCr.truncated === "X" ? "；有来源已截断，结论只代表已取到的部分" : "") + "。";
                                },
                                decorate: function (oE) {
                                        oE.combo = { sources: aSrc, mode: oCr.mode, note: oSum.note || "" };
                                        oE.runHtml = that._cbxCardHtml(oE);
                                }
                        });
                },

                /** 组合结果卡下方：来源（可点开原会话）+ 组合说明 */
                _cbxCardHtml: function (oEntry) {
                        var o = oEntry.combo || {};
                        var s = '<div class="cbxCard" data-uid="' + esc(oEntry.uid) + '"><div class="cbxCardHead">' +
                                '<span class="cbxIco cbxIcoAcc">' + ICON.stack + "</span>来源</div><div class=\"cbxCardList\">";
                        (o.sources || []).forEach(function (src, i) {
                                var sRows = src.truncated ? "存储 " + src.stored + " 行 / 共 " + src.total + " 行（已截断）" : src.stored + " 行";
                                s += '<div class="cbxCardSrc"><span class="cbxCardNo">' + (i + 1) + "</span>" +
                                        (src.sessionId ? '<button type="button" class="cbxLink" data-act="combo-goto" data-sid="' + esc(src.sessionId) + '" title="打开来源会话">' + esc(src.name) + "</button>"
                                                : "<span>" + esc(src.name) + "</span>") +
                                        '<span class="cbxMeta">' + esc((src.type === "FIORI_RESULT" ? "Fiori" : "报表执行") + " · " + sRows) + "</span></div>";
                        });
                        s += "</div>" + (o.note ? '<div class="cbxNote">' + esc(o.note) + "</div>" : "") + "</div>";
                        return s;
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
                },

                /* ---------------------------------------------------------
                 * 20261105 联合分析 #01 报表接力（功能计划书/联合分析/01 §5.4）
                 *  · 参数卡里有"从上一份结果带入"的参数 → 提交时记下 运行号 → 来源结果（本机，最多 50 条）
                 *  · 这次运行的结果卡工具条出「和结果 X 关联」→ 把来源结果和这份结果放进组合分析面板，
                 *    关联模式、关联列预选好：来源那一列 = 这份结果里和带入值重合最多的一列
                 * --------------------------------------------------------- */

                _rlKey: function () {
                        return "zaiChat.relay.v1." + this._modelUserKey();
                },

                _rlAll: function () {
                        try { return JSON.parse(window.localStorage.getItem(this._rlKey()) || "{}") || {}; } catch (e) { return {}; }
                },

                /** 参数卡提交成功后调用：卡上有来源结果才记 */
                _rlRemember: function (sRunId, oAsk) {
                        var m = (oAsk && oAsk.prefill) || {};
                        var sPid = Object.keys(m).filter(function (k) { return m[k] && m[k].source_artifact; })[0];
                        if (!sRunId || !sPid) {
                                return;
                        }
                        var p = m[sPid];
                        var o = this._rlAll();
                        o[sRunId] = {
                                srcArt: String(p.source_artifact), srcCol: String(p.source_column || ""), srcShort: String(p.source_short || ""),
                                srcLabel: String(p.source_label || ""), srcRun: String(p.source_run || ""), param: sPid, count: p.count || 0, at: Date.now()
                        };
                        var aIds = Object.keys(o).sort(function (a, b) { return (o[b].at || 0) - (o[a].at || 0); });
                        aIds.slice(50).forEach(function (k) { delete o[k]; });
                        try { window.localStorage.setItem(this._rlKey(), JSON.stringify(o)); } catch (e) { /* 存不下：只是刷新后没有「关联」按钮 */ }
                },

                /** 运行号 → 来源说明（没有返回 null） */
                _rlOf: function (sRunId) {
                        return (sRunId && this._rlAll()[sRunId]) || null;
                },

                /** 这份结果里和来源那一列重合最多的列（按 normKey 比；一列都没有重合返回 -1） */
                _rlBestCol: function (oSrcDs, iSrc, oDs) {
                        var mSrc = {};
                        (oSrcDs.rows || []).forEach(function (r) {
                                var k = ComboData.normKey(r[iSrc]);
                                if (k) { mSrc[k] = true; }
                        });
                        var iBest = -1, nBest = 0;
                        (oDs.columns || []).forEach(function (c, i) {
                                var n = 0;
                                (oDs.rows || []).forEach(function (r) {
                                        if (mSrc[ComboData.normKey(r[i])]) { n++; }
                                });
                                if (n > nBest) { nBest = n; iBest = i; }
                        });
                        return iBest;
                },

                /** 「和结果 X 关联」：来源结果放第一位（主表），这份结果第二位，关联列预选 */
                _cbxRelayJoin: function (oEntry) {
                        var that = this;
                        var r = oEntry && oEntry.relay;
                        var oDs = oEntry && oEntry.analysis && (oEntry.analysis.datasets || [])[0];
                        if (!r || !oDs) {
                                return;
                        }
                        var c = this._cbx();
                        var aRest = c.items.filter(function (it) { return it.art !== r.srcArt && it.art !== oEntry.artifactId; });
                        if (aRest.length + 2 > MAX_ITEMS) {
                                this._cbxOpen(true);
                                MessageToast.show("组合里最多放 " + MAX_ITEMS + " 份结果，先移除几份");
                                return;
                        }
                        MessageToast.show("正在取回结果 " + (r.srcShort || "") + "…");
                        ChatService.getReportResult(r.srcArt).then(function (oRes) {
                                if (!oRes || (!oRes.rowsJson && !oRes.schemaJson && !oRes.rowCount)) {
                                        throw new Error((oRes && oRes.message) || "结果已失效");
                                }
                                var oSrcDs = that._rptDataset(oRes, r.srcRun);
                                var oSess = that.getView().getModel("chat").getProperty("/currentSession") || {};
                                var fnItem = function (sName, sArt, sRun, oD) {
                                        return {
                                                id: "x" + that._newSessionId().substring(0, 8), name: sName, sid: oSess.id || that._sMessagesSession || "",
                                                sess: "", at: Formatter.formatTime(""), art: sArt, type: "REPORT_RESULT", run: sRun,
                                                src: "relay:" + sArt, ds: oD, st: "ok"
                                        };
                                };
                                var itSrc = fnItem(r.srcLabel || oSrcDs.name, r.srcArt, r.srcRun, oSrcDs);
                                var itTgt = fnItem(oDs.name || "结果", oEntry.artifactId || "", String(oEntry.runId || ""), oDs);
                                c.items = [itSrc, itTgt].concat(aRest);
                                c.mode = "join";
                                c.modeAuto = false;
                                that._cbxResetKeys();
                                var iA = ComboData.label ? (oSrcDs.columns || []).map(function (col, i) { return ComboData.label(col, i); }).indexOf(r.srcCol) : -1;
                                if (iA < 0) {
                                        iA = (oSrcDs.columns || []).map(function (col) { return col.name; }).indexOf(r.srcCol);
                                }
                                var iB = iA >= 0 ? that._rlBestCol(oSrcDs, iA, oDs) : -1;
                                if (iA >= 0 && iB >= 0) {
                                        c.keys[itTgt.id] = [{ a: iA, b: iB }];
                                }
                                c.open = true;
                                that._cbxChanged(true);
                                that._cbxFlash(itTgt.id);
                                MessageToast.show(iB >= 0 ? "已放进组合分析，按「" + r.srcCol + "」关联" : "已放进组合分析，请在面板里选关联列");
                        }).catch(function (e) {
                                MessageToast.show("取不回来源结果：" + ((e && e.message) || String(e)));
                        });
                }
        };
});
