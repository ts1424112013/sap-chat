sap.ui.define([
        "zai/chat/utils/Toast",
        "sap/m/Dialog",
        "sap/ui/core/HTML",
        "zai/chat/service/ChatService",
        "zai/chat/utils/ScheduleData",
        "zai/chat/utils/Formatter"
], function (MessageToast, Dialog, HTML, ChatService, ScheduleData, Formatter) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：定时任务（设计：功能计划书/定时任务/01-方案与开发计划 V1.1）
         * =====================================================================
         *  · 侧栏「定时任务」入口（角标 = 有新结果的个数）→ 列表窗口：我的 / 全部用户（管理员）；
         *    每行 立即运行 / 暂停·恢复 / 编辑 / 删除 / 打开会话，展开看运行记录
         *  · 新建 / 编辑对话框（参考 Claude「新建定时任务」）：名称 → 指令框（底部 场景 / 模型）→ 说明条 →
         *    触发方式（最多 3 个）→ 高级设置（数据来源与参数：只有日期能改成相对日期）
         *  · 结果卡工具条「设为定时」：后端从结果号带出数据来源和这次运行的参数（PREFILL）
         *  · 侧栏专属会话行：时钟图标 + 未读点；打开会话即标记已看（SEEN）
         * 自绘：Dialog + core:HTML，事件委托 data-sc；方法名统一 _sc 前缀。
         * 无人值守时灵犀不决定报表参数（方案 D5）：参数只来自一次成功运行。
         * =====================================================================
         */

        var MAX_TRIG = 3;
        var POLL_MS = 5 * 60 * 1000;

        var ICON = {
                clock: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
                close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
                plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
                trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
                chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
                play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
                pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
                edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
                chat: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H8l-4 4z"/></svg>',
                auto: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l7 7-7 7M12 5l7 7-7 7"/></svg>',
                info: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
                db: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>'
        };

        var SCENE_TXT = { AUTO: "自动", REPORT: "报表执行", FIORI: "Fiori 报表", DATA: "数据分析", CODE: "代码分析" };
        var STATUS_TXT = { ACTIVE: "运行中", PAUSED: "已暂停", ADMIN_STOP: "管理员停用", JOB_ERROR: "作业异常" };
        var RUN_TXT = { OK: "成功", FAILED: "失败", SKIPPED: "跳过", ANALYZE_ERR: "分析未完成" };

        function esc(s) { return Formatter.escapeHtml(String(s === undefined || s === null ? "" : s)); }

        function yes(v) { return v === true || v === "X" || v === "x"; }

        /** YYYYMMDD → yyyy-mm-dd（date 输入框） */
        function isoDate(s) {
                var m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ""));
                return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
        }

        function hm(s) {
                var t = String(s || "").replace(":", "");
                return /^\d{4}$/.test(t) ? t.substring(0, 2) + ":" + t.substring(2) : "09:00";
        }

        function nowHm() {
                var d = new Date();
                var p = function (n) { return (n < 10 ? "0" : "") + n; };
                return p(d.getHours()) + ":" + p(d.getMinutes());
        }

        return {

                /* ======================= 登录后：能力探测 + 列表 + 未读 ======================= */

                _scInit: function () {
                        var that = this;
                        var oSettings = this.getView().getModel("settings");
                        this._bSchedAvail = false;
                        this._mSchedSess = {};
                        oSettings.setProperty("/schedAvail", false);
                        oSettings.setProperty("/schedUnread", 0);
                        if (document.body && document.body.classList) { document.body.classList.remove("schedOn"); }
                        ChatService.scheduleAvailable().then(function (b) {
                                that._bSchedAvail = !!b;
                                oSettings.setProperty("/schedAvail", !!b);
                                // 结果卡上的「设为定时」按钮：后端支持才显示（CSS body.schedOn）
                                if (document.body && document.body.classList) { document.body.classList.toggle("schedOn", !!b); }
                                if (b) {
                                        that._scLoad(true);
                                }
                        });
                        if (!this._iScTimer) {
                                this._iScTimer = window.setInterval(function () {
                                        if (!document.hidden && that._bSchedAvail) { that._scLoad(false); }
                                }, POLL_MS);
                        }
                },

                /** 读自己的定时任务 → 侧栏未读角标、专属会话映射；bToast = 登录后第一次（有新结果提示一次） */
                _scLoad: function (bToast) {
                        var that = this;
                        return ChatService.scheduleList("").then(function (r) {
                                var aItems = r.items || [];
                                that._aScMine = aItems;
                                that._bScAdmin = yes(r.isAdmin);
                                var m = {}, nUnread = 0;
                                aItems.forEach(function (it) {
                                        if (it.sessionId) { m[it.sessionId] = { id: it.schedId, unread: yes(it.unread) }; }
                                        if (yes(it.unread)) { nUnread++; }
                                });
                                var bChanged = JSON.stringify(m) !== JSON.stringify(that._mSchedSess || {});
                                that._mSchedSess = m;
                                that.getView().getModel("settings").setProperty("/schedUnread", nUnread);
                                if (bChanged) {
                                        that.getView().getModel("session").refresh(true);   // 侧栏重画时钟图标 / 未读点
                                }
                                if (bToast && nUnread > 0) {
                                        MessageToast.show("有 " + nUnread + " 个定时任务有新结果，点侧栏「定时任务」查看", { duration: 5000 });
                                }
                                if (that._sc && that._sc.view === "list" && that._sc.scope !== "ALL") {
                                        that._sc.items = aItems;
                                        that._scPaint();
                                }
                                return aItems;
                        }).catch(function () { return []; });
                },

                /** 侧栏会话行：是不是定时任务的专属会话（sessionItemFactory 调用） */
                _scSessInfo: function (sSid) {
                        return (this._mSchedSess && this._mSchedSess[sSid]) || null;
                },

                /** 打开会话后调用：专属会话有未读就标记已看 */
                _scSeen: function (sSid) {
                        var that = this;
                        var o = this._scSessInfo(sSid);
                        if (!o || !o.unread) { return; }
                        o.unread = false;
                        ChatService.scheduleAction(o.id, "SEEN", "").then(function () {
                                that._scLoad(false);
                        }).catch(function () { /* 静默 */ });
                },

                /* ======================= 列表窗口 ======================= */

                onOpenSchedules: function () {
                        this._sc = { view: "list", scope: "", items: this._aScMine || [], loading: true, open: {}, runs: {}, delFor: "", stopFor: "" };
                        this._scOpenDlg();
                        this._scReloadList();
                },

                _scReloadList: function () {
                        var that = this, sc = this._sc;
                        if (!sc) { return; }
                        sc.loading = true;
                        this._scPaint();
                        ChatService.scheduleList(sc.scope).then(function (r) {
                                if (!that._sc || that._sc !== sc) { return; }
                                sc.items = r.items || [];
                                sc.loading = false;
                                sc.msg = r.message || "";
                                that._bScAdmin = yes(r.isAdmin);
                                if (!sc.scope) { that._aScMine = sc.items; }
                                that._scPaint();
                        }).catch(function (e) {
                                sc.loading = false;
                                sc.msg = (e && e.message) || "定时任务加载失败";
                                that._scPaint();
                        });
                },

                _scOpenDlg: function () {
                        var that = this;
                        if (!this._oScDlg) {
                                this._oScHtml = new HTML({ preferDOM: false, sanitizeContent: false });
                                this._oScHtml.attachAfterRendering(this._scBind.bind(this));
                                this._oScDlg = new Dialog({
                                        showHeader: false, verticalScrolling: false, horizontalScrolling: false,
                                        content: [this._oScHtml],
                                        escapeHandler: function (o) { o.resolve(); }
                                }).addStyleClass("uaDlg scDlg");
                                this._oScDlg.attachAfterClose(function () {
                                        var bBack = that._sc && that._sc.view === "edit" && that._sc.back;
                                        that._sc = null;
                                        if (bBack) { that.onOpenSchedules(); }
                                });
                                this.getView().addDependent(this._oScDlg);
                        }
                        this._oScDlg.setContentWidth(Math.min(720, Math.max(300, window.innerWidth - 24)) + "px");
                        this._scPaint();
                        if (!this._oScDlg.isOpen()) { this._oScDlg.open(); }
                },

                _scPaint: function () {
                        if (!this._sc || !this._oScHtml) { return; }
                        var oOld = this._oScHtml.getDomRef();
                        var oBody = oOld && oOld.querySelector(".scBody");
                        var iTop = oBody ? oBody.scrollTop : 0;
                        this._oScHtml.setContent(this._sc.view === "edit" ? this._scEditMarkup() : this._scListMarkup());
                        var oNew = this._oScHtml.getDomRef();
                        if (oNew && oOld) {
                                this._scBind();
                                var oBody2 = oNew.querySelector(".scBody");
                                if (oBody2) { oBody2.scrollTop = iTop; }
                        }
                },

                _scListMarkup: function () {
                        var sc = this._sc;
                        var h = '<div class="uaBox scBox">';
                        h += '<div class="uaHead scHead"><div class="scHeadL"><span class="scHeadIco">' + ICON.clock + '</span><div class="uaTitle">定时任务</div></div>' +
                                '<div class="scHeadR"><button type="button" class="uaBtn uaBtnPrimary scNew" data-sc="new">' + ICON.plus + '新建</button>' +
                                '<button type="button" class="uaX" data-sc="close" aria-label="关闭">' + ICON.close + "</button></div></div>";
                        if (this._bScAdmin) {
                                h += '<div class="scTabs"><button type="button" class="scTab' + (!sc.scope ? " on" : "") + '" data-sc="scope" data-k="">我的</button>' +
                                        '<button type="button" class="scTab' + (sc.scope === "ALL" ? " on" : "") + '" data-sc="scope" data-k="ALL">全部用户</button></div>';
                        }
                        h += '<div class="scBody">';
                        if (sc.loading && !sc.items.length) {
                                h += '<div class="scEmpty">正在读取…</div>';
                        } else if (!sc.items.length) {
                                h += '<div class="scEmpty"><div class="scEmptyIco">' + ICON.clock + '</div><div class="scEmptyT">' +
                                        esc(sc.msg || "还没有定时任务") + '</div><div class="scEmptyS">点右上角「新建」写一段指令；要定时跑报表，先执行一次，在结果卡下方点「设为定时」。</div></div>';
                        } else {
                                sc.items.forEach(function (it) { h += this._scRowMarkup(it); }, this);
                        }
                        h += "</div></div>";
                        return h;
                },

                _scRowMarkup: function (it) {
                        var sc = this._sc, id = esc(it.schedId);
                        var bMine = !sc.scope || it.owner === ((ChatService.getAppUser() || {}).userId);
                        var aTrig = (it.triggers || []).map(function (t) { return t.text || ScheduleData.trigText(t); });
                        var sLast = it.lastRunAt ? (RUN_TXT[it.lastRunSts] || it.lastRunSts || "") + " · " + ScheduleData.fmtTs(it.lastRunAt) : "还没运行过";
                        var h = '<div class="scRow' + (yes(it.unread) ? " unread" : "") + '">';
                        h += '<div class="scRowMain" data-sc="toggle" data-k="' + id + '">' +
                                '<div class="scRowTop"><span class="scName">' + esc(it.name) + "</span>" +
                                (yes(it.unread) ? '<span class="scNewDot" title="有新结果"></span>' : "") +
                                '<span class="scChip scene-' + esc(it.scene) + '">' + esc(SCENE_TXT[it.scene] || it.scene) + "</span>" +
                                '<span class="scSt st-' + esc(it.status) + '">' + esc(STATUS_TXT[it.status] || it.status) + "</span>" +
                                (sc.scope === "ALL" ? '<span class="scOwner">' + esc(it.owner) + "</span>" : "") + "</div>" +
                                '<div class="scRowSub"><span>' + esc(aTrig.join("、")) + "</span>" +
                                (it.nextRun ? "<span>下次 " + esc(ScheduleData.fmtTs(it.nextRun)) + "</span>" : "") +
                                '<span class="scLast lst-' + esc(it.lastRunSts || "NONE") + '">上次 ' + esc(sLast) + "</span></div>" +
                                (it.srcType ? '<div class="scRowSrc">' + ICON.db + "<span>" + esc(it.reportName || it.reportId) + "</span></div>" : "") +
                                (it.stopNote ? '<div class="scRowNote">' + esc(it.stopNote) + "</div>" : "") +
                                "</div>";
                        // 操作
                        h += '<div class="scActs">';
                        if (sc.delFor === it.schedId) {
                                h += '<span class="scConfirm">删除后作业停止，专属会话保留。确定删除？</span>' +
                                        '<button type="button" class="uaBtn" data-sc="delno">取消</button>' +
                                        '<button type="button" class="uaBtn uaBtnDanger" data-sc="delyes" data-k="' + id + '">删除</button>';
                        } else if (sc.stopFor === it.schedId) {
                                h += '<input class="scStopIn" maxlength="120" placeholder="停用原因（会显示给创建人）"/>' +
                                        '<button type="button" class="uaBtn" data-sc="stopno">取消</button>' +
                                        '<button type="button" class="uaBtn uaBtnDanger" data-sc="stopyes" data-k="' + id + '">停用</button>';
                        } else {
                                if (bMine) {
                                        h += '<button type="button" class="scAct" data-sc="run" data-k="' + id + '"' + (it.status === "ADMIN_STOP" ? " disabled" : "") + ">" + ICON.play + "立即运行</button>";
                                        h += it.status === "ACTIVE"
                                                ? '<button type="button" class="scAct" data-sc="pause" data-k="' + id + '">' + ICON.pause + "暂停</button>"
                                                : '<button type="button" class="scAct" data-sc="resume" data-k="' + id + '"' + (it.status === "ADMIN_STOP" ? " disabled" : "") + ">" + ICON.play + "恢复</button>";
                                        h += '<button type="button" class="scAct" data-sc="edit" data-k="' + id + '"' + (it.status === "ADMIN_STOP" ? " disabled" : "") + ">" + ICON.edit + "编辑</button>";
                                        if (it.sessionId) {
                                                h += '<button type="button" class="scAct" data-sc="sess" data-k="' + id + '">' + ICON.chat + "打开会话</button>";
                                        }
                                        h += '<button type="button" class="scAct scActDanger" data-sc="del" data-k="' + id + '">' + ICON.trash + "删除</button>";
                                } else if (this._bScAdmin) {
                                        h += it.status === "ADMIN_STOP"
                                                ? '<button type="button" class="scAct" data-sc="aresume" data-k="' + id + '">' + ICON.play + "恢复</button>"
                                                : '<button type="button" class="scAct scActDanger" data-sc="stop" data-k="' + id + '">' + ICON.pause + "停用</button>";
                                }
                        }
                        h += "</div>";
                        // 运行记录
                        if (sc.open[it.schedId]) {
                                var aRuns = sc.runs[it.schedId];
                                h += '<div class="scRuns">';
                                if (!aRuns) {
                                        h += '<div class="scRunsEmpty">正在读取运行记录…</div>';
                                } else if (!aRuns.length) {
                                        h += '<div class="scRunsEmpty">还没有运行记录</div>';
                                } else {
                                        h += '<table class="scRunTbl"><thead><tr><th>时间</th><th>结果</th><th>行数</th><th>耗时</th><th>说明</th></tr></thead><tbody>';
                                        aRuns.forEach(function (r) {
                                                h += "<tr><td>" + esc(ScheduleData.fmtTs(r.startedAt)) + (+r.trigNo === 0 ? '<span class="scRunNow">手动</span>' : "") + "</td>" +
                                                        '<td><span class="scRunSt rst-' + esc(r.status) + '">' + esc(RUN_TXT[r.status] || r.status) + "</span></td>" +
                                                        "<td>" + (r.artifactId || +r.rowCount ? esc(r.rowCount) : "—") + "</td>" +
                                                        "<td>" + (r.elapsedMs ? esc((Math.round(+r.elapsedMs / 100) / 10) + " 秒") : "—") + "</td>" +
                                                        '<td class="scRunMsg" title="' + esc(r.paramsUsed ? "参数：" + r.paramsUsed : "") + '">' + esc(r.message || "") + "</td></tr>";
                                        });
                                        h += "</tbody></table>";
                                }
                                h += "</div>";
                        }
                        h += "</div>";
                        return h;
                },

                /* ======================= 新建 / 编辑对话框 ======================= */

                /** 结果卡「设为定时」：后端从结果号带出数据来源和参数 */
                _scFromEntry: function (oEntry) {
                        var that = this;
                        if (!oEntry || !oEntry.artifactId) {
                                MessageToast.show("这张表没有结果号，不能设为定时");
                                return;
                        }
                        ChatService.scheduleAction("", "PREFILL", oEntry.artifactId).then(function (r) {
                                var it = r.item || {};
                                that._scOpenEditor({
                                        name: it.name || "",
                                        instruction: "",
                                        scene: it.scene || it.srcType,
                                        srcType: it.srcType, reportId: it.reportId, reportName: it.reportName,
                                        fromArtifact: it.fromArtifact || oEntry.artifactId,
                                        params: it.params || []
                                }, false);
                        }).catch(function (e) {
                                MessageToast.show((e && e.message) || "读取这份结果的参数失败");
                        });
                },

                /** 打开编辑框；oInit 为空 = 新建（只有指令） */
                _scOpenEditor: function (oInit, bBack) {
                        var o = oInit || {};
                        var aTrig = (o.triggers && o.triggers.length ? o.triggers : [{ freq: "DAILY", time: "0900" }]).map(function (t) {
                                return {
                                        freq: t.freq || "DAILY", time: hm(t.time || t.runTime),
                                        weekdays: String(t.weekdays || "XXXXX  ").substring(0, 7),
                                        monthDay: +t.monthDay || 1, everyHours: +t.everyHours || 2
                                };
                        });
                        var aParams = (o.params || []).map(function (p) {
                                var bDate = String(p.dataType || "").toUpperCase() === "DATE";
                                var aItems = bDate ? String(p.value || "").split(",") : [];
                                if (bDate && yes(p.isRange) && aItems.length < 2) { aItems.push(""); }
                                return {
                                        paramId: p.paramId, label: p.label || p.paramId, value: String(p.value || ""), isDate: bDate,
                                        isRange: yes(p.isRange), items: aItems.map(function (v) { return ScheduleData.dateMode(v); })
                                };
                        });
                        this._sc = {
                                view: "edit", back: !!bBack, schedId: o.schedId || "",
                                name: o.name || "", instruction: o.instruction || "",
                                scene: o.srcType ? o.srcType : (["DATA", "CODE"].indexOf(o.scene) >= 0 ? o.scene : "AUTO"),
                                modelId: o.modelId || "",
                                srcType: o.srcType || "", reportId: o.reportId || "", reportName: o.reportName || "",
                                fromArtifact: o.fromArtifact || "", params: aParams, triggers: aTrig,
                                adv: !!o.srcType, saving: false, error: ""
                        };
                        this._scOpenDlg();
                },

                /** 模型下拉：本场景白名单里启用的模型（没配白名单 = 全部启用模型） */
                _scModels: function (sScene) {
                        var aAll = (this.getView().getModel("chat").getProperty("/models") || []).filter(function (m) {
                                return m.ModelId && String(m.ModelId).toUpperCase() !== "AUTO" && m.IsActive === "X";
                        });
                        var r = this._mAgentModelRules || {};
                        var aAllow = (sScene !== "AUTO" && r[sScene] && r[sScene].length) ? r[sScene] : (r.ALL || []);
                        return !aAllow.length ? aAll : aAll.filter(function (m) { return aAllow.indexOf(String(m.ModelId).toUpperCase()) >= 0; });
                },

                /** 没有数据来源时可选的场景（用户已开放的 ∩ 自动 / 数据分析 / 代码分析） */
                _scScenes: function () {
                        var aVis = (this._visibleScenes ? this._visibleScenes() : []).map(function (o) { return o.key; });
                        return ["AUTO", "DATA", "CODE"].filter(function (k) { return k === "AUTO" || aVis.indexOf(k) >= 0; });
                },

                _scEditMarkup: function () {
                        var sc = this._sc;
                        var bSrc = !!sc.srcType;
                        var h = '<div class="uaBox scBox scEdit">';
                        h += '<div class="uaHead scHead"><div class="uaTitle">' + (sc.schedId ? "编辑定时任务" : "新建定时任务") + "</div>" +
                                '<button type="button" class="uaX" data-sc="close" aria-label="关闭">' + ICON.close + "</button></div>";
                        h += '<div class="scBody">';

                        // 名称
                        h += '<label class="scLbl" for="scName">名称</label>' +
                                '<input id="scName" class="scInput" data-f="name" maxlength="80" placeholder="每日简报" value="' + esc(sc.name) + '"/>';

                        // 指令卡（底部：场景 / 模型）
                        var aScenes = bSrc ? [sc.srcType] : this._scScenes();
                        var aModels = this._scModels(sc.scene);
                        h += '<div class="scCard scInstr"><textarea class="scTa" data-f="instruction" maxlength="4000" placeholder="' +
                                esc(bSrc ? "跑完之后要灵犀做什么（可以不填，只跑报表）。例如：看库存最高的前 10 个料号，和上次比有什么变化"
                                        : "写下到点后要灵犀做什么，例如：统计昨天各工厂的出货量，列出比前一天下降超过 20% 的工厂") + '">' +
                                esc(sc.instruction) + "</textarea>" +
                                '<div class="scBar"><label class="scPill scScene">' + ICON.auto +
                                '<select data-f="scene"' + (bSrc ? " disabled" : "") + ">" + aScenes.map(function (k) {
                                        return '<option value="' + k + '"' + (k === sc.scene ? " selected" : "") + ">" + esc(SCENE_TXT[k] || k) + "</option>";
                                }).join("") + "</select>" + (bSrc ? "" : '<span class="scChev">' + ICON.chev + "</span>") + "</label>" +
                                '<label class="scPill scModel"><select data-f="modelId"><option value="">默认模型</option>' + aModels.map(function (m) {
                                        return '<option value="' + esc(m.ModelId) + '"' + (m.ModelId === sc.modelId ? " selected" : "") + ">" + esc(m.ModelName || m.ModelId) + "</option>";
                                }).join("") + '</select><span class="scChev">' + ICON.chev + "</span></label></div></div>";

                        // 说明条
                        h += '<div class="scCard scNotice">' + ICON.info + "<span>到点后灵犀会直接执行，不会停下来等你确认。" +
                                (bSrc ? "报表按下面确认过的参数运行（相对日期按当天换算），灵犀只做查询和分析。"
                                        : "要定时跑报表，请先执行一次，在结果卡下方点「设为定时」。") +
                                "查表照常受你自己的权限限制。</span></div>";

                        // 触发
                        h += '<div class="scCard scTrigs">';
                        sc.triggers.forEach(function (t, i) {
                                h += '<div class="scTrig" data-i="' + i + '">' + (i === 0 ? '<span class="scTrigLbl">触发方式</span>' : '<span class="scTrigLbl"></span>') +
                                        '<span class="scPill scPillGray">' + ICON.clock + "定时</span>" +
                                        '<label class="scPill"><select data-t="freq" data-i="' + i + '">' + ScheduleData.FREQS.map(function (f) {
                                                return '<option value="' + f.key + '"' + (f.key === t.freq ? " selected" : "") + ">" + f.text + "</option>";
                                        }).join("") + '</select><span class="scChev">' + ICON.chev + "</span></label>";
                                if (t.freq === "MONTHLY") {
                                        var aOpt = [];
                                        for (var d = 1; d <= 31; d++) { aOpt.push('<option value="' + d + '"' + (+t.monthDay === d ? " selected" : "") + ">" + d + " 号</option>"); }
                                        aOpt.push('<option value="99"' + (+t.monthDay === 99 ? " selected" : "") + ">最后一天</option>");
                                        h += '<label class="scPill"><select data-t="monthDay" data-i="' + i + '">' + aOpt.join("") + '</select><span class="scChev">' + ICON.chev + "</span></label>";
                                } else if (t.freq === "HOURLY") {
                                        h += '<span class="scInline">每 <input class="scNum" type="number" min="1" max="24" data-t="everyHours" data-i="' + i + '" value="' + esc(t.everyHours) + '"/> 小时，从</span>';
                                }
                                h += '<input class="scTime" type="time" data-t="time" data-i="' + i + '" value="' + esc(t.time) + '"/>';
                                if (i === 0 && sc.triggers.length < MAX_TRIG) {
                                        h += '<button type="button" class="scIcoBtn scAddTrig" data-sc="addtrig" title="再加一个触发（最多 ' + MAX_TRIG + ' 个）">' + ICON.plus + "</button>";
                                } else if (i > 0) {
                                        h += '<button type="button" class="scIcoBtn" data-sc="deltrig" data-i="' + i + '" title="删掉这个触发">' + ICON.trash + "</button>";
                                }
                                if (t.freq === "WEEKLY") {
                                        h += '<div class="scWeek">' + ScheduleData.WEEK_NAMES.map(function (n, k) {
                                                var bOn = t.weekdays.charAt(k) === "X";
                                                return '<button type="button" class="scDay' + (bOn ? " on" : "") + '" data-sc="day" data-i="' + i + '" data-k="' + k + '" aria-pressed="' + bOn + '">' + n + "</button>";
                                        }).join("") + "</div>";
                                }
                                h += "</div>";
                        });
                        h += "</div>";

                        // 高级设置
                        h += '<div class="scCard scAdv' + (sc.adv ? " open" : "") + '"><button type="button" class="scAdvHead" data-sc="adv"><span>高级设置</span>' +
                                '<span class="scChev">' + ICON.chev + "</span></button>";
                        if (sc.adv) {
                                h += '<div class="scAdvBody"><div class="scSub">数据来源</div>';
                                if (!bSrc) {
                                        h += '<div class="scSrcNone">无。要定时跑报表或 Fiori 报表：先在对应场景里执行一次，在结果卡下方点「设为定时」，参数会带过来。</div>';
                                } else {
                                        h += '<div class="scSrc">' + ICON.db + "<span>" + esc(SCENE_TXT[sc.srcType]) + " · " + esc(sc.reportName || sc.reportId) + "</span></div>";
                                        h += '<div class="scParams">';
                                        sc.params.forEach(function (p, pi) {
                                                h += '<div class="scParam"><span class="scPLbl">' + esc(p.label) + "</span>";
                                                if (!p.isDate) {
                                                        h += '<span class="scPVal">' + esc(p.value || "（空）") + "</span>";
                                                } else {
                                                        h += '<span class="scPDates">';
                                                        p.items.forEach(function (st, k) {
                                                                if (p.isRange) { h += '<span class="scPSide">' + (k === 0 ? "从" : "至") + "</span>"; }
                                                                h += '<label class="scPill scPillSm"><select data-p="mode" data-pi="' + pi + '" data-k="' + k + '">' +
                                                                        ScheduleData.DATE_MODES.map(function (dm) {
                                                                                return '<option value="' + dm.key + '"' + (dm.key === st.mode ? " selected" : "") + ">" + dm.text + "</option>";
                                                                        }).join("") + '</select><span class="scChev">' + ICON.chev + "</span></label>";
                                                                if (st.mode === "N_DAYS") {
                                                                        h += '<input class="scNum" type="number" min="1" max="366" data-p="n" data-pi="' + pi + '" data-k="' + k + '" value="' + esc(st.n) + '"/>';
                                                                } else if (!st.mode) {
                                                                        h += '<input class="scDate" type="date" data-p="fixed" data-pi="' + pi + '" data-k="' + k + '" value="' + esc(isoDate(st.fixed)) + '"/>';
                                                                }
                                                        });
                                                        h += "</span>";
                                                }
                                                h += "</div>";
                                        });
                                        h += '</div><div class="scHint">只有日期参数能改；要换别的参数值，请重新执行一次报表再设为定时。</div>';
                                }
                                h += '<div class="scSub">运行记录</div><div class="scHint">每个定时任务保留最近 30 次运行记录；结果和分析写进专属会话「定时：名称」。</div>';
                                h += "</div>";
                        }
                        h += "</div>";
                        h += "</div>";   // scBody

                        h += '<div class="uaFoot">' + (sc.error ? '<span class="scErr">' + esc(sc.error) + "</span>" : "") +
                                '<button type="button" class="uaBtn" data-sc="cancel">取消</button>' +
                                '<button type="button" class="uaBtn uaBtnPrimary" data-sc="save"' + (sc.saving ? " disabled" : "") + ">" +
                                (sc.saving ? "保存中…" : (sc.schedId ? "保存" : "创建")) + "</button></div>";
                        h += "</div>";
                        return h;
                },

                /* ======================= 事件 ======================= */

                _scBind: function () {
                        var that = this, root = this._oScHtml && this._oScHtml.getDomRef();
                        if (!root || !this._sc) { return; }
                        root.onclick = function (ev) {
                                var b = ev.target.closest("[data-sc]");
                                if (!b || !that._sc || b.disabled) { return; }
                                that._scClick(b.getAttribute("data-sc"), b.getAttribute("data-k"), +b.getAttribute("data-i"), root);
                        };
                        // 输入：只记进状态，不重画（保持焦点）；下拉 / 数字改了要重画的才重画
                        root.oninput = function (ev) { that._scInput(ev.target, false); };
                        root.onchange = function (ev) { that._scInput(ev.target, true); };
                },

                _scInput: function (el, bChange) {
                        var sc = this._sc;
                        if (!sc || sc.view !== "edit") { return; }
                        var f = el.getAttribute("data-f"), t = el.getAttribute("data-t"), p = el.getAttribute("data-p");
                        if (f) {
                                sc[f] = el.value;
                                if (f === "scene" && bChange) {
                                        if (!this._scModels(sc.scene).some(function (m) { return m.ModelId === sc.modelId; })) { sc.modelId = ""; }
                                        this._scPaint();
                                }
                                return;
                        }
                        if (t) {
                                var tr = sc.triggers[+el.getAttribute("data-i")];
                                if (!tr) { return; }
                                tr[t] = t === "time" ? el.value : (t === "freq" ? el.value : +el.value);
                                if (t === "freq" && bChange) { this._scPaint(); }
                                return;
                        }
                        if (p) {
                                var prm = sc.params[+el.getAttribute("data-pi")];
                                var st = prm && prm.items[+el.getAttribute("data-k")];
                                if (!st) { return; }
                                if (p === "mode") {
                                        st.mode = el.value;
                                        if (!st.mode && !st.fixed) { st.fixed = ScheduleData.fromDate(new Date()); }
                                        if (bChange) { this._scPaint(); }
                                } else if (p === "n") {
                                        st.n = Math.max(1, Math.min(366, parseInt(el.value, 10) || 1));
                                } else if (p === "fixed") {
                                        st.fixed = String(el.value || "").replace(/-/g, "");
                                }
                        }
                },

                _scClick: function (act, k, i, root) {
                        var that = this, sc = this._sc;
                        var fnItem = function () { return (sc.items || []).filter(function (x) { return x.schedId === k; })[0]; };
                        switch (act) {
                        case "close": this._oScDlg.close(); return;
                        case "cancel":
                                if (sc.back) { this.onOpenSchedules(); } else { this._oScDlg.close(); }
                                return;
                        case "new": this._scOpenEditor(null, true); return;
                        case "scope": sc.scope = k || ""; sc.open = {}; sc.runs = {}; this._scReloadList(); return;
                        case "toggle":
                                sc.open[k] = !sc.open[k];
                                if (sc.open[k] && !sc.runs[k]) {
                                        ChatService.scheduleRuns(k).then(function (r) {
                                                if (that._sc === sc) { sc.runs[k] = r.runs || []; that._scPaint(); }
                                        }).catch(function (e) {
                                                if (that._sc === sc) { sc.runs[k] = []; MessageToast.show((e && e.message) || "运行记录读取失败"); that._scPaint(); }
                                        });
                                }
                                break;
                        case "run": this._scAct(k, "RUNNOW", ""); return;
                        case "pause": this._scAct(k, "PAUSE", ""); return;
                        case "resume": this._scAct(k, "RESUME", ""); return;
                        case "aresume": this._scAct(k, "ADMIN_RESUME", ""); return;
                        case "del": sc.delFor = k; sc.stopFor = ""; break;
                        case "delno": sc.delFor = ""; break;
                        case "delyes": sc.delFor = ""; this._scAct(k, "DELETE", ""); return;
                        case "stop": sc.stopFor = k; sc.delFor = ""; break;
                        case "stopno": sc.stopFor = ""; break;
                        case "stopyes":
                                var oIn = root.querySelector(".scStopIn");
                                sc.stopFor = "";
                                this._scAct(k, "ADMIN_STOP", oIn ? oIn.value : "");
                                return;
                        case "edit":
                                var it = fnItem();
                                if (it) { this._scOpenEditor(it, true); }
                                return;
                        case "sess":
                                var it2 = fnItem();
                                if (it2 && it2.sessionId) { this._scGoSession(it2.sessionId); }
                                return;
                        case "addtrig":
                                if (sc.triggers.length < MAX_TRIG) { sc.triggers.push({ freq: "DAILY", time: nowHm(), weekdays: "XXXXX  ", monthDay: 1, everyHours: 2 }); }
                                break;
                        case "deltrig": sc.triggers.splice(i, 1); break;
                        case "day":
                                var tr = sc.triggers[i], w = tr.weekdays.split("");
                                w[+k] = w[+k] === "X" ? " " : "X";
                                tr.weekdays = w.join("");
                                break;
                        case "adv": sc.adv = !sc.adv; break;
                        case "save": this._scSave(); return;
                        default: return;
                        }
                        this._scPaint();
                },

                /** 列表上的操作 → 后端 → 刷新这一行与侧栏 */
                _scAct: function (sId, sAct, sNote) {
                        var that = this, sc = this._sc;
                        ChatService.scheduleAction(sId, sAct, sNote).then(function (r) {
                                MessageToast.show(r.message || "已完成");
                                if (that._sc === sc) {
                                        if (sAct === "DELETE") {
                                                sc.items = sc.items.filter(function (x) { return x.schedId !== sId; });
                                        } else if (r.item && r.item.schedId) {
                                                sc.items = sc.items.map(function (x) { return x.schedId === sId ? r.item : x; });
                                        }
                                        if (sAct === "RUNNOW") { delete sc.runs[sId]; sc.open[sId] = false; }
                                        that._scPaint();
                                }
                                that._scLoad(false);
                        }).catch(function (e) {
                                MessageToast.show((e && e.message) || "操作失败");
                        });
                },

                _scGoSession: function (sSid) {
                        var that = this;
                        var fnOpen = function () {
                                var oMeta = that._findSession(sSid);
                                if (!oMeta) { return false; }
                                that._oScDlg.close();
                                that._restoreWorkspaceBySession(oMeta);
                                that._loadHistoryFor(sSid, oMeta.Mode === "AGENT");
                                that._scSeen(sSid);
                                return true;
                        };
                        if (fnOpen()) { return; }
                        // 刚建的会话侧栏还没有：刷新会话列表，稍后再试一次
                        this._refreshSessions();
                        window.setTimeout(function () {
                                if (!fnOpen()) { MessageToast.show("没找到专属会话（可能已被删除），请稍后在侧栏查看"); }
                        }, 1500);
                },

                /** 收集 + 前端校验 + 保存 */
                _scSave: function () {
                        var that = this, sc = this._sc;
                        var sName = String(sc.name || "").trim();
                        var sInstr = String(sc.instruction || "").trim();
                        var sErr = "";
                        if (!sName) { sErr = "请填写名称"; }
                        if (!sErr && !sInstr && !sc.srcType) { sErr = "请写指令（没有数据来源时指令必填）"; }
                        var aTrig = sc.triggers.map(function (t) {
                                return {
                                        freq: t.freq, time: String(t.time || "").replace(":", ""),
                                        weekdays: t.freq === "WEEKLY" ? t.weekdays : "",
                                        monthDay: t.freq === "MONTHLY" ? String(t.monthDay) : "",
                                        everyHours: t.freq === "HOURLY" ? String(t.everyHours) : ""
                                };
                        });
                        aTrig.forEach(function (t, i) {
                                if (!sErr) { sErr = ScheduleData.checkTrigger(t, i, 1); }
                        });
                        var oParams = {};
                        sc.params.forEach(function (p) {
                                if (!p.isDate) { return; }
                                var aV = p.items.map(function (st) { return ScheduleData.modeValue(st.mode, st.n, st.fixed); });
                                if (!sErr && aV.some(function (v, ix) { return !v && (ix === 0 || p.isRange); }) && p.value) {
                                        sErr = "「" + p.label + "」请选日期或相对日期";
                                }
                                oParams[p.paramId] = aV.join(",");
                        });
                        if (sErr) {
                                sc.error = sErr;
                                this._scPaint();
                                return;
                        }
                        sc.saving = true;
                        sc.error = "";
                        this._scPaint();
                        ChatService.scheduleSave({
                                schedId: sc.schedId, name: sName, instruction: sInstr, scene: sc.scene, modelId: sc.modelId,
                                fromArtifactId: sc.schedId ? "" : sc.fromArtifact, params: oParams, triggers: aTrig
                        }, this._newSessionId ? this._newSessionId() : String(Date.now())).then(function (r) {
                                MessageToast.show(r.message || "已保存");
                                var bBack = sc.back;
                                sc.back = false;
                                that._scLoad(false);
                                if (that._refreshSessions) { that._refreshSessions(); }
                                if (bBack) { that.onOpenSchedules(); } else { that._oScDlg.close(); }
                        }).catch(function (e) {
                                if (that._sc !== sc) { return; }
                                sc.saving = false;
                                sc.error = (e && e.message) || "保存失败";
                                that._scPaint();
                        });
                }
        };
});
