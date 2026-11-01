sap.ui.define([
        "zai/chat/utils/Toast",
        "sap/m/Dialog",
        "sap/m/Popover",
        "sap/ui/core/HTML",
        "zai/chat/service/ChatService",
        "zai/chat/utils/UserAccess",
        "zai/chat/utils/Formatter"
], function (MessageToast, Dialog, Popover, HTML, ChatService, UserAccess, Formatter) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：按用户开放场景 + 报表授权（设计：功能计划书/用户权限/01-方案）
         * =====================================================================
         *  · 设置 → 用户管理：顶部「按用户限制报表」开关（ZAI_CHAT_CFG RPT_ACL_ENABLED）、
         *    每行「可用范围」→ 自绘弹窗：四个场景勾选 + 报表执行 / Fiori 两组报表清单（搜索、全选）
         *  · 末尾一行「所有人」只维护公共报表（USERID = *）
         *  · 侧栏：普通用户没有设置，齿轮换成「退出登录」（先确认）
         * 真正的拦截在后端（ZCL_AI_ACCESS），这里只是维护界面。
         */

        var ICON = {
                REPORT: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
                FIORI: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>',
                DATA: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
                CODE: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></svg>',
                check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
                search: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
                close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
                info: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
                logout: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/></svg>'
        };

        var SCENE_TXT = {
                REPORT: ["报表执行", "运行登记的 TCode 报表"],
                FIORI: ["Fiori 报表", "从 Fiori 报表取数分析"],
                DATA: ["数据分析", "查表、写 SQL 统计"],
                CODE: ["代码分析", "读 ABAP 源码"]
        };

        function esc(s) { return Formatter.escapeHtml(String(s === undefined || s === null ? "" : s)); }

        function pick(o, k) {
                if (!o) { return undefined; }
                if (o[k] !== undefined) { return o[k]; }
                var u = k.toUpperCase();
                if (o[u] !== undefined) { return o[u]; }
                var c = k.replace(/_([a-z])/g, function (m, x) { return x.toUpperCase(); });
                return o[c];
        }

        return {

                /* ======================= 侧栏：普通用户退出登录 ======================= */

                onSideLogout: function (oEvent) {
                        var that = this;
                        var oBtn = oEvent.getSource();
                        if (!this._oLogoutPop) {
                                var oHtml = new HTML({
                                        preferDOM: false, sanitizeContent: false,
                                        content: '<div class="uaOut"><div class="uaOutTitle">退出当前账号？</div>' +
                                                '<div class="uaOutSub">退出后需要重新登录，未发送的输入不会保留。</div>' +
                                                '<div class="uaOutBtns"><button type="button" class="uaBtn" data-ua="cancel">取消</button>' +
                                                '<button type="button" class="uaBtn uaBtnDanger" data-ua="logout">' + ICON.logout + '退出登录</button></div></div>'
                                });
                                oHtml.attachAfterRendering(function () {
                                        var root = oHtml.getDomRef();
                                        if (!root) { return; }
                                        root.onclick = function (ev) {
                                                var b = ev.target.closest("[data-ua]");
                                                if (!b) { return; }
                                                that._oLogoutPop.close();
                                                if (b.getAttribute("data-ua") === "logout") { that.onAppLogout(); }
                                        };
                                });
                                this._oLogoutPop = new Popover({
                                        showHeader: false, placement: "Top", contentWidth: "16rem", content: [oHtml]
                                }).addStyleClass("uaPop");
                                this.getView().addDependent(this._oLogoutPop);
                        }
                        this._oLogoutPop.openBy(oBtn);
                },

                /* ======================= 用户管理：开关与列表 ======================= */

                /** 打开用户管理时调用：能不能维护授权（SEGW 有没有加参数）、开关当前值、报表清单（预取） */
                _uaRefresh: function () {
                        var oSettings = this.getView().getModel("settings");
                        ChatService.userAccessAvailable().then(function (b) {
                                oSettings.setProperty("/uaAvail", !!b);
                        });
                        ChatService.getConfigValue("RPT_ACL_ENABLED").then(function (s) {
                                oSettings.setProperty("/aclOn", String(s || "").toUpperCase() === "X");
                        }).catch(function () { oSettings.setProperty("/aclOn", false); });
                        this._uaDefs = null;   // 下次打开弹窗重读目录（报表登记可能刚改过）
                },

                onAclSwitch: function (oEvent) {
                        var oSettings = this.getView().getModel("settings");
                        var bOn = !!oEvent.getParameter("state");
                        ChatService.saveConfigValue("RPT_ACL_ENABLED", bOn ? "X" : "").then(function () {
                                oSettings.setProperty("/aclOn", bOn);
                                MessageToast.show(bOn ? "已按用户限制报表：普通用户只看到分配给自己的和公共的报表"
                                        : "已取消限制：所有人都能看到全部报表");
                        }).catch(function (e) {
                                oSettings.setProperty("/aclOn", !bOn);
                                MessageToast.show("保存失败：" + ((e && e.message) || e));
                        });
                },

                /** 用户列表一行的「可用范围」简述 */
                _uaSummary: function (u) {
                        return UserAccess.summary(u.Role, u.AgentScenes, u.Reports);
                },

                /* ======================= 可用范围弹窗 ======================= */

                onEditUserAccess: function (oEvent) {
                        var sId = oEvent.getSource().data("userId");
                        var oRow = (this.getView().getModel("settings").getProperty("/userList") || [])
                                .filter(function (u) { return u.UserId === sId; })[0];
                        if (!oRow) { return; }
                        var bAll = !UserAccess.normScenes(oRow.AgentScenesRaw).length;
                        this._ua = {
                                row: oRow,
                                isPublic: oRow.UserId === "*",
                                isAdmin: oRow.RoleRaw === "ADMIN",
                                scenes: bAll ? UserAccess.SCENES.slice() : UserAccess.normScenes(oRow.AgentScenesRaw),
                                reports: UserAccess.normReports(oRow.ReportsRaw),
                                tab: "REPORT",
                                q: "",
                                saving: false,
                                error: ""
                        };
                        this._uaOpen();
                        this._uaLoadDefs();
                },

                _uaOpen: function () {
                        var that = this;
                        if (!this._oUaDlg) {
                                this._oUaHtml = new HTML({ preferDOM: false, sanitizeContent: false });
                                this._oUaHtml.attachAfterRendering(this._uaBind.bind(this));
                                this._oUaDlg = new Dialog({
                                        showHeader: false, contentWidth: "40rem", verticalScrolling: false, horizontalScrolling: false,
                                        content: [this._oUaHtml],
                                        escapeHandler: function (o) { o.resolve(); }
                                }).addStyleClass("uaDlg");
                                this._oUaDlg.attachAfterClose(function () { that._ua = null; });
                                this.getView().addDependent(this._oUaDlg);
                        }
                        this._oUaDlg.setContentWidth(Math.min(640, Math.max(300, window.innerWidth - 24)) + "px");
                        this._uaPaint();
                        if (!this._oUaDlg.isOpen()) { this._oUaDlg.open(); }
                },

                /** 两份报表目录（管理员看到的是全部）→ [{key, src, id, name, code, cat}] */
                _uaLoadDefs: function () {
                        var that = this;
                        if (this._uaDefs) { return; }
                        this._uaDefsLoading = true;
                        var pR = ChatService.getReportCatalog().then(function (o) { return { defs: o.defs || [], msg: o.message || "" }; })
                                .catch(function (e) { return { defs: [], msg: (e && e.message) || "报表目录加载失败" }; });
                        var pF = ChatService.getFioriReportDefs().then(function (o) { return { defs: o.defs || [], msg: o.message || "" }; })
                                .catch(function (e) { return { defs: [], msg: (e && e.message) || "Fiori 报表目录加载失败" }; });
                        Promise.all([pR, pF]).then(function (a) {
                                that._uaDefsLoading = false;
                                that._uaDefs = {
                                        REPORT: a[0].defs.map(function (d) {
                                                var id = String(pick(d, "report_id") || "").toUpperCase();
                                                return { key: "REPORT:" + id, id: id, name: String(pick(d, "name") || pick(d, "report_name") || id),
                                                        code: String(pick(d, "tcode") || ""), cat: String(pick(d, "module") || "") };
                                        }).filter(function (x) { return x.id; }),
                                        FIORI: a[1].defs.map(function (d) {
                                                var id = String(pick(d, "report_id") || "").toUpperCase();
                                                return { key: "FIORI:" + id, id: id, name: String(pick(d, "report_name") || id),
                                                        code: id, cat: String(pick(d, "category") || "") };
                                        }).filter(function (x) { return x.id; }),
                                        msg: { REPORT: a[0].msg, FIORI: a[1].msg }
                                };
                                if (that._ua) { that._uaPaint(); }
                        });
                },

                _uaPaint: function () {
                        if (!this._ua || !this._oUaHtml) { return; }
                        // 已渲染时 setContent 直接换 DOM、不再触发 afterRendering，事件要自己重绑；保留列表滚动位置
                        var oOld = this._oUaHtml.getDomRef();
                        var oList = oOld && oOld.querySelector(".uaList");
                        var iTop = oList ? oList.scrollTop : 0;
                        var bFocus = !!(oOld && document.activeElement && document.activeElement.classList.contains("uaSearchInput"));
                        this._oUaHtml.setContent(this._uaMarkup());
                        var oNew = this._oUaHtml.getDomRef();
                        if (oNew && oOld) {
                                this._uaBind();
                                var oList2 = oNew.querySelector(".uaList");
                                if (oList2) { oList2.scrollTop = iTop; }
                                var oIn = bFocus && oNew.querySelector(".uaSearchInput");
                                if (oIn) { oIn.focus(); oIn.setSelectionRange(oIn.value.length, oIn.value.length); }
                        }
                },

                _uaMarkup: function () {
                        var ua = this._ua, row = ua.row;
                        var oSettings = this.getView().getModel("settings");
                        var bAcl = !!oSettings.getProperty("/aclOn");
                        var sWho = ua.isPublic ? "所有人（公共报表）" : esc(row.UserNameRaw || row.UserId) + '<span class="uaWhoId">' + esc(row.UserId) + '</span>';
                        var h = '<div class="uaBox">';
                        h += '<div class="uaHead"><div><div class="uaTitle">可用范围</div><div class="uaWho">' + sWho + '</div></div>' +
                                '<button type="button" class="uaX" data-ua="close" aria-label="关闭">' + ICON.close + '</button></div>';
                        h += '<div class="uaBody">';

                        // ---- 场景 ----
                        if (!ua.isPublic) {
                                h += '<div class="uaSec"><div class="uaSecHead"><span class="uaSecTitle">Agent 场景</span>';
                                if (ua.isAdmin) {
                                        h += '</div><div class="uaNote">' + ICON.info + '<span>管理员不受限制，四个场景和全部报表都能用。</span></div></div>';
                                } else {
                                        var bFull = ua.scenes.length === UserAccess.SCENES.length;
                                        h += '<span class="uaSecMeta">' + (bFull ? "全部开放" : "已开放 " + ua.scenes.length + " / 4") + '</span></div>';
                                        h += '<div class="uaScenes">' + UserAccess.SCENES.map(function (k) {
                                                var on = ua.scenes.indexOf(k) >= 0;
                                                return '<button type="button" class="uaScene' + (on ? " on" : "") + '" data-ua="scene" data-k="' + k + '" aria-pressed="' + on + '">' +
                                                        '<span class="uaSceneIco">' + ICON[k] + '</span>' +
                                                        '<span class="uaSceneTxt"><b>' + SCENE_TXT[k][0] + '</b><i>' + SCENE_TXT[k][1] + '</i></span>' +
                                                        '<span class="uaTick">' + ICON.check + '</span></button>';
                                        }).join("") + '</div>';
                                        h += '<div class="uaHint">「自动」所有人都能用，但里面只用这里开放的能力（例如没开数据分析，「自动」里也不能查表）。至少保留一个场景。</div></div>';
                                }
                        }

                        // ---- 报表 ----
                        if (!ua.isAdmin) {
                                var defs = this._uaDefs;
                                var aCur = defs ? defs[ua.tab] : [];
                                var nSel = function (src) { return ua.reports.filter(function (k) { return k.indexOf(src + ":") === 0; }).length; };
                                h += '<div class="uaSec uaSecGrow"><div class="uaSecHead"><span class="uaSecTitle">' + (ua.isPublic ? "公共报表" : "可用报表") + '</span>' +
                                        '<span class="uaSecMeta">' + (ua.isPublic ? "所有用户都能用" : "另加上公共报表") + '</span></div>';
                                if (!bAcl) {
                                        h += '<div class="uaNote uaWarn">' + ICON.info + '<span>「按用户限制报表」还没打开，现在所有人都能看到全部报表。分配会先保存，打开开关后生效。</span></div>';
                                }
                                h += '<div class="uaTabs">' + ["REPORT", "FIORI"].map(function (src) {
                                        var n = defs ? defs[src].length : 0;
                                        return '<button type="button" class="uaTab' + (ua.tab === src ? " on" : "") + '" data-ua="tab" data-k="' + src + '">' +
                                                (src === "REPORT" ? "报表执行" : "Fiori 报表") + '<span class="uaTabN">' + nSel(src) + (defs ? " / " + n : "") + '</span></button>';
                                }).join("") + '</div>';
                                h += '<div class="uaTools"><label class="uaSearch">' + ICON.search +
                                        '<input class="uaSearchInput" type="text" placeholder="搜索报表名或编号" autocomplete="off" value="' + esc(ua.q) + '"/></label>' +
                                        '<button type="button" class="uaLink" data-ua="all">全选</button><button type="button" class="uaLink" data-ua="none">清空</button></div>';
                                h += '<div class="uaList">';
                                if (!defs) {
                                        h += '<div class="uaEmpty">正在读取报表目录…</div>';
                                } else if (!aCur.length) {
                                        h += '<div class="uaEmpty">' + esc(defs.msg[ua.tab] || "没有已登记的报表") + '</div>';
                                } else {
                                        h += aCur.map(function (d) {
                                                var on = ua.reports.indexOf(d.key) >= 0;
                                                var hay = (d.name + " " + d.code + " " + d.id + " " + d.cat).toLowerCase();
                                                return '<button type="button" class="uaRow' + (on ? " on" : "") + '" data-ua="rpt" data-k="' + esc(d.key) + '" data-hay="' + esc(hay) + '" aria-pressed="' + on + '">' +
                                                        '<span class="uaBoxChk">' + ICON.check + '</span>' +
                                                        '<span class="uaRowMain"><b>' + esc(d.name) + '</b><i>' + esc([d.code, d.cat].filter(Boolean).join(" · ")) + '</i></span></button>';
                                        }).join("") + '<div class="uaEmpty" data-ua-none hidden>没有匹配的报表</div>';
                                }
                                h += '</div></div>';
                        }
                        h += '</div>';

                        // ---- 页脚 ----
                        h += '<div class="uaFoot"><span class="uaErr">' + esc(ua.error) + '</span>' +
                                '<button type="button" class="uaBtn" data-ua="close">' + (ua.isAdmin ? "关闭" : "取消") + '</button>' +
                                (ua.isAdmin ? "" : '<button type="button" class="uaBtn uaBtnPrimary" data-ua="save"' + (ua.saving ? " disabled" : "") + '>' + (ua.saving ? "正在保存…" : "保存") + '</button>') +
                                '</div></div>';
                        return h;
                },

                _uaBind: function () {
                        var that = this, root = this._oUaHtml && this._oUaHtml.getDomRef();
                        if (!root || !this._ua) { return; }
                        var input = root.querySelector(".uaSearchInput");
                        this._uaFilter(input ? input.value : "");
                        root.onclick = function (ev) {
                                var b = ev.target.closest("[data-ua]");
                                if (!b || !that._ua) { return; }
                                var ua = that._ua, act = b.getAttribute("data-ua"), k = b.getAttribute("data-k");
                                if (act === "close") { that._oUaDlg.close(); return; }
                                if (act === "save") { that._uaSave(); return; }
                                if (act === "scene") {
                                        var i = ua.scenes.indexOf(k);
                                        if (i >= 0) {
                                                if (ua.scenes.length === 1) { MessageToast.show("至少保留一个场景"); return; }
                                                ua.scenes.splice(i, 1);
                                        } else {
                                                ua.scenes = UserAccess.normScenes(ua.scenes.concat([k]));
                                        }
                                } else if (act === "tab") {
                                        ua.tab = k;
                                        ua.q = "";
                                } else if (act === "rpt") {
                                        var j = ua.reports.indexOf(k);
                                        if (j >= 0) { ua.reports.splice(j, 1); } else { ua.reports.push(k); }
                                        // 只改这一行和计数，不重画（保持滚动位置）
                                        b.classList.toggle("on", j < 0);
                                        b.setAttribute("aria-pressed", String(j < 0));
                                        that._uaCounts(root);
                                        return;
                                } else if (act === "all" || act === "none") {
                                        Array.prototype.forEach.call(root.querySelectorAll(".uaRow:not([hidden])"), function (r) {
                                                var key = r.getAttribute("data-k"), at = ua.reports.indexOf(key);
                                                if (act === "all" && at < 0) { ua.reports.push(key); }
                                                if (act === "none" && at >= 0) { ua.reports.splice(at, 1); }
                                        });
                                } else {
                                        return;
                                }
                                that._uaPaint();
                        };
                        if (input) {
                                input.oninput = function () {
                                        that._ua.q = input.value;
                                        that._uaFilter(input.value);
                                };
                        }
                },

                _uaFilter: function (q) {
                        var root = this._oUaHtml && this._oUaHtml.getDomRef();
                        if (!root) { return; }
                        var s = String(q || "").trim().toLowerCase(), n = 0;
                        Array.prototype.forEach.call(root.querySelectorAll(".uaRow"), function (r) {
                                var hit = !s || r.getAttribute("data-hay").indexOf(s) >= 0;
                                r.hidden = !hit;
                                if (hit) { n++; }
                        });
                        var oNone = root.querySelector("[data-ua-none]");
                        if (oNone) { oNone.hidden = n > 0; }
                },

                _uaCounts: function (root) {
                        var ua = this._ua, defs = this._uaDefs;
                        Array.prototype.forEach.call(root.querySelectorAll(".uaTab"), function (t) {
                                var src = t.getAttribute("data-k");
                                var n = ua.reports.filter(function (k) { return k.indexOf(src + ":") === 0; }).length;
                                var oN = t.querySelector(".uaTabN");
                                if (oN) { oN.textContent = n + (defs ? " / " + defs[src].length : ""); }
                        });
                },

                _uaSave: function () {
                        var that = this, ua = this._ua;
                        if (!ua || ua.saving) { return; }
                        ua.saving = true;
                        ua.error = "";
                        this._uaPaint();
                        // 已登记目录里没有的旧授权（报表停用了）原样保留，不因为看不到就被删掉
                        ChatService.saveUserAccess(ua.row, ua.isPublic ? [] : ua.scenes, ua.reports).then(function () {
                                MessageToast.show(ua.isPublic ? "公共报表已保存" : "已保存「" + (ua.row.UserNameRaw || ua.row.UserId) + "」的可用范围");
                                that._oUaDlg.close();
                                that._refreshUserTable();
                        }).catch(function (e) {
                                if (!that._ua) { return; }
                                that._ua.saving = false;
                                that._ua.error = "保存失败：" + ((e && e.message) || e);
                                that._uaPaint();
                        });
                }
        };
});
