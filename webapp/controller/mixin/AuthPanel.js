sap.ui.define([
        "sap/ui/model/json/JSONModel",
        "sap/m/MessageToast",
        "sap/m/MessageBox",
        "zai/chat/service/ChatService"
], function (JSONModel, MessageToast, MessageBox, ChatService) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器块：事务码权限自助申请
         * =====================================================================
         * 入口都在侧栏会话列表下方（设计：功能计划书/权限自助申请/01-方案与开发计划_V1.4）：
         *   ① 「申请权限」→ 对话框 AuthDialog：申请 / 我的申请
         *   ② 「权限审批」（仅 ADMIN）→ 审批对话框（见 AuthApprove mixin）；入口上的红色角标 = 待审批条数
         *      （登录后、每 2 分钟、切回页面时查一次；条数变多时弹提示）
         *   ③ 审批对话框右上「管理」→ AuthAdminDialog（内容 AuthAdmin，与审批对话框同一套外壳）：全部记录与撤销 / 批量代加 / 权限表配置 / 事务码规则
         *      20261023：事务码规则可带自己的整份字段映射（沿用权限表映射 / 本规则单独映射；列表与权限表配置共用 AuthFieldMap 片段）
         * 数据都在视图模型 "auth" 里；所有后端调用经 ChatService.auth*（失败抛 Error(后端原话)，
         * 这里统一显示在对话框 / 页签顶部的红色提示条）。
         * 以 mixin 并入 zai.chat.controller.App，方法名统一 auth / _auth 前缀，避免与其他块重名（红线 8）。
         * =====================================================================
         */

        var PAGE = 50;
        var PENDING_POLL_MS = 120000;
        var STATUS_STATE = { DONE: "Success", EXISTS: "Information", PENDING: "Warning", FAILED: "Error", REJECTED: "Error", REVOKED: "None" };

        /** CHAR14 yyyymmddhhmmss → "yyyy-mm-dd hh:mm:ss"（不是 14 位数字就原样显示） */
        function clone(v) { return JSON.parse(JSON.stringify(v)); }

        /** 规则编辑区的空白值（新建规则 / 删除之后） */
        function emptyRule() {
                return { tcodePat: "", tabname: "", ruleMode: "AUTO", allowAll: false, active: true, ownMap: false, fields: [], fieldsTab: "" };
        }

        function fmtTime(s) {
                return /^\d{14}$/.test(s || "")
                        ? s.substring(0, 4) + "-" + s.substring(4, 6) + "-" + s.substring(6, 8) + " " + s.substring(8, 10) + ":" + s.substring(10, 12) + ":" + s.substring(12)
                        : (s || "");
        }

        return {

                /* =========================================================
                 * 模型与通用
                 * ========================================================= */

                /** 视图模型 "auth"；换了登录账号就新建一份（不保留上一位用户的申请与结果） */
                _authModel: function () {
                        var sOwner = (ChatService.getAppUser() || {}).userId || "";
                        var oModel = this.getView().getModel("auth");
                        if (oModel && oModel.getProperty("/owner") === sOwner) {
                                return oModel;
                        }
                        var oRB = this._rb();
                        oModel = new JSONModel({
                                owner: sOwner,
                                busy: false,
                                notice: "",
                                enabled: true,
                                tab: "apply",
                                admTab: "records",
                                form: { tcode: "", werks: "", reason: "" },
                                result: { lines: [], summary: "" },
                                mine: { rows: [], total: 0, skip: 0 },
                                admin: { rows: [], total: 0, skip: 0, status: "", user: "", tcode: "", note: "" },
                                batch: { users: "", tcode: "", werks: "", reason: "" },
                                tables: [],
                                rules: [],
                                editTable: { tabname: "", descr: "", discover: true, active: true, fields: [], loaded: "", ownRulesText: "" },
                                editRule: Object.assign(emptyRule(), { baseMap: [], baseHint: "", ownHint: "" }),
                                ruleTables: [],
                                mapTypes: ["TCODE", "USER", "WERKS", "CONST", "DATE", "TIME", "BY", "INITIAL"].map(function (k) {
                                        return { key: k, text: oRB.getText("authMap" + k) };
                                })
                        });
                        oModel.setSizeLimit(2000);
                        this.getView().setModel(oModel, "auth");
                        return oModel;
                },

                /** 串行执行一个后端动作：忙时不重入；失败把后端原话放进红色提示条 */
                _authRun: function (fnWork) {
                        var oModel = this._authModel();
                        if (oModel.getProperty("/busy")) {
                                return Promise.resolve();
                        }
                        oModel.setProperty("/busy", true);
                        oModel.setProperty("/notice", "");
                        return Promise.resolve().then(fnWork).catch(function (e) {
                                oModel.setProperty("/notice", (e && e.message) || String(e));
                        }).then(function () {
                                oModel.setProperty("/busy", false);
                        });
                },

                _authRow: function (oEvent) {
                        return oEvent.getSource().getBindingContext("auth").getObject();
                },

                /** 给后端返回的行加上界面用的字段（状态文字 / 颜色、时间、可否审批 / 撤销） */
                _authDecorate: function (aRows) {
                        var oRB = this._rb();
                        return (aRows || []).map(function (r) {
                                var x = Object.assign({}, r);
                                x.statusText = oRB.getText("authStatus" + r.status);
                                x.statusState = STATUS_STATE[r.status] || "None";
                                x.channelText = oRB.getText(r.channel === "ADMIN" ? "authChannelAdmin" : "authChannelSelf");
                                x.createdAtText = fmtTime(r.createdAt);
                                x.werksText = !r.werks ? oRB.getText("apvWerksNone")
                                        : r.werks === "ALL" ? oRB.getText("apvWerksAll") : oRB.getText("apvWerks", [r.werks]);
                                x.mineSub = [r.message || "", fmtTime(r.createdAt)].filter(Boolean).join("  ·  ");
                                x.recSub = [x.channelText, x.createdAtText].filter(Boolean).join("  ·  ");
                                x.canDecide = r.status === "PENDING";
                                x.canRevoke = r.revocable === "X";
                                return x;
                        });
                },

                /** 写操作的统一结果：逐条结果表 + 汇总 */
                _authShowResult: function (oRes) {
                        var oModel = this._authModel();
                        oModel.setProperty("/result", { lines: this._authDecorate(oRes.lines), summary: oRes.summary || "" });
                },

                /* =========================================================
                 * 用户入口：申请权限对话框
                 * ========================================================= */

                onOpenAuth: function () {
                        var that = this, oModel = this._authModel();
                        oModel.setProperty("/tab", "apply");
                        oModel.setProperty("/notice", "");
                        oModel.setProperty("/result", { lines: [], summary: "" });
                        oModel.setProperty("/mine", { rows: [], total: 0, skip: 0 });
                        if (!this._oAuthDialog) {
                                this._oAuthDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.AuthDialog", this);
                                this.getView().addDependent(this._oAuthDialog);
                        }
                        this._oAuthDialog.open();
                        // 功能没开时这里就会拿到"尚未启用"，显示在提示条里
                        this._authRun(function () { return that._authLoadMine(true); });
                },

                /** 申请 / 我的申请 页签（按钮的自定义数据 tab） */
                onAuthTab: function (oEvent) {
                        this._authModel().setProperty("/tab", oEvent.getSource().data("tab"));
                        this._authScrollTop("aplScroll");
                },

                /** 换页签后内容区回到顶部（各页签共用一个滚动容器，不重置会停在上一页的位置） */
                _authScrollTop: function (sId) {
                        var oBox = this.byId(sId), oDom = oBox && oBox.getDomRef();
                        if (oDom) {
                                oDom.scrollTop = 0;
                        }
                },

                onCloseAuth: function () {
                        if (this._oAuthDialog) {
                                this._oAuthDialog.close();
                        }
                },

                onAuthSubmit: function () {
                        var that = this, oModel = this._authModel(), f = oModel.getProperty("/form");
                        if (!f.tcode.trim() || !f.werks.trim() || !f.reason.trim()) {
                                oModel.setProperty("/notice", this._rb().getText("authNeedFields"));
                                return;
                        }
                        this._authRun(function () {
                                return ChatService.authSubmit({ Tcode: f.tcode.trim().toUpperCase(), WerksList: f.werks, Reason: f.reason.trim() }).then(function (oRes) {
                                        that._authShowResult(oRes);
                                        that._authCheckPending();   // ADMIN 给自己申请到待审批时，角标立刻更新
                                        return that._authLoadMine(true);
                                });
                        });
                },

                onAuthRefreshMine: function () {
                        var that = this;
                        this._authRun(function () { return that._authLoadMine(true); });
                },

                _authLoadMine: function (bReset) {
                        var that = this, oModel = this._authModel();
                        if (bReset) {
                                oModel.setProperty("/mine/skip", 0);
                        }
                        return ChatService.authList({ Top: String(PAGE), Skip: String(oModel.getProperty("/mine/skip")) }).then(function (r) {
                                oModel.setProperty("/mine/rows", that._authDecorate(r.requests));
                                oModel.setProperty("/mine/total", r.total || 0);
                        });
                },

                /** 上一页 / 下一页（按钮的自定义数据：list = mine | admin，delta = ±PAGE） */
                onAuthPage: function (oEvent) {
                        var oBtn = oEvent.getSource(), bAdmin = oBtn.data("list") === "admin", oModel = this._authModel(), that = this;
                        var sPath = bAdmin ? "/admin/skip" : "/mine/skip";
                        oModel.setProperty(sPath, Math.max(0, oModel.getProperty(sPath) + Number(oBtn.data("delta"))));
                        this._authRun(function () { return bAdmin ? that._authLoadAdmin(false) : that._authLoadMine(false); });
                },

                /* =========================================================
                 * 待审批提醒（仅 ADMIN）：侧栏「权限审批」角标 + 条数变多时的提示
                 * ========================================================= */

                /** 登录后调用（_afterAppLogin）；定时器与页面可见性监听只装一次，换账号也复用。
                 *  条数放在 settings 模型（/authPending），侧栏启动时就能绑定；"上次查到的条数"放控制器上 */
                _authWatchStart: function () {
                        var that = this;
                        this._iAuthPendingSeen = -1;   // -1 = 本次登录还没查过（查到有待审批就提示一次）
                        this.getView().getModel("settings").setProperty("/authPending", 0);
                        if (!this._iAuthPendingTimer) {
                                this._iAuthPendingTimer = window.setInterval(function () {
                                        if (!document.hidden) {
                                                that._authCheckPending();
                                        }
                                }, PENDING_POLL_MS);
                                document.addEventListener("visibilitychange", function () {
                                        if (!document.hidden) {
                                                that._authCheckPending();
                                        }
                                });
                        }
                        // 稍后再查：错开登录欢迎提示和登录时的一批请求
                        window.setTimeout(function () { that._authCheckPending(); }, 1500);
                },

                /** 查待审批条数（只取 1 行看 total）；失败不打扰（比如后端还没部署这个功能） */
                _authCheckPending: function () {
                        var oUser = ChatService.getAppUser();
                        if (!oUser || !ChatService.isAdmin()) {
                                return Promise.resolve();
                        }
                        var that = this, sUser = oUser.userId;
                        return ChatService.authList({ Status: "PENDING", Top: "1", Skip: "0" }).then(function (r) {
                                if ((ChatService.getAppUser() || {}).userId !== sUser) {
                                        return;   // 查询期间换了账号
                                }
                                var n = Number(r.total) || 0, nSeen = that._iAuthPendingSeen;
                                that._authSetPending(n);
                                if (n > 0 && (nSeen < 0 || n > nSeen)) {
                                        MessageToast.show(that._rb().getText(nSeen < 0 ? "authPendingToast" : "authPendingNewToast", [n]), { duration: 5000 });
                                }
                        }).catch(function () { /* 静默 */ });
                },

                /** 写角标（不提示）：审批对话框加载待审批列表时也用它，免得刚处理完又弹"新申请" */
                _authSetPending: function (n) {
                        var oSettings = this.getView().getModel("settings");
                        var nOld = oSettings.getProperty("/authPending");
                        this._iAuthPendingSeen = n;
                        oSettings.setProperty("/authPending", n);
                        oSettings.setProperty("/authPendingTip", this._rb().getText("authPendingTip", [n]));
                        // 20261020：条数变了（处理掉一条 / 新来一条）角标轻弹一下
                        if (n > 0 && n !== nOld) {
                                window.setTimeout(function () {
                                        var el = document.querySelector(".sideAuthBadge");
                                        if (el && el.animate && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
                                                el.animate([
                                                        { transform: "translateY(-50%) scale(1)" },
                                                        { transform: "translateY(-50%) scale(1.32)" },
                                                        { transform: "translateY(-50%) scale(1)" }
                                                ], { duration: 380, easing: "cubic-bezier(.34, 1.56, .64, 1)" });
                                        }
                                }, 40);
                        }
                },

                /* =========================================================
                 * 管理入口：审批对话框右上「管理」→ 四页签管理对话框（仅 ADMIN）
                 * ========================================================= */

                /** 打开即刷新 */
                onOpenAuthAdmin: function () {
                        var that = this, oModel = this._authModel();
                        oModel.setProperty("/admTab", "records");
                        oModel.setProperty("/notice", "");
                        oModel.setProperty("/result", { lines: [], summary: "" });
                        if (!this._oAuthAdminDialog) {
                                this._oAuthAdminDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.AuthAdminDialog", this);
                                this.getView().addDependent(this._oAuthAdminDialog);
                        }
                        this._oAuthAdminDialog.open();
                        this._authRun(function () {
                                var pEnabled = ChatService.getMode() === "mock"
                                        ? Promise.resolve(ChatService._mockAuthEnabled())
                                        : ChatService.getConfigValue("AUTH_ENABLED").then(function (v) { return v === "X"; });
                                return pEnabled.then(function (bOn) {
                                        oModel.setProperty("/enabled", bOn);
                                        // 开关关着也加载：IT 可以先登记权限表和规则，再打开开关
                                        return that._authLoadAdmin(true);
                                });
                        });
                },

                onCloseAuthAdmin: function () {
                        if (this._oAuthAdminDialog) {
                                this._oAuthAdminDialog.close();
                        }
                },

                /** 退出登录时关掉权限对话框、清掉角标（下一位用户不该看到） */
                _authCloseAll: function () {
                        this.onCloseAuth();
                        this.onCloseAuthAdmin();
                        this.onApvClose();
                        this.getView().getModel("settings").setProperty("/authPending", 0);
                },

                onAuthEnabledChange: function (oEvent) {
                        var that = this, bOn = oEvent.getParameter("state"), oModel = this._authModel();
                        this._authRun(function () {
                                return ChatService.saveConfigValue("AUTH_ENABLED", bOn ? "X" : "").then(function () {
                                        oModel.setProperty("/enabled", bOn);
                                        return that._authLoadAdmin(true);
                                }).catch(function (e) {
                                        oModel.setProperty("/enabled", !bOn);
                                        throw e;
                                });
                        });
                },

                /** 记录列表 + 表 / 规则配置一起刷新 */
                _authLoadAdmin: function (bReset) {
                        var that = this, oModel = this._authModel();
                        return Promise.all([
                                this._authLoadAdminList(bReset),
                                ChatService.authConfig().then(function (r) {
                                        var oRB = that._rb();
                                        oModel.setProperty("/tables", (r.tables || []).map(function (t) {
                                                return Object.assign({}, t, { activeText: oRB.getText(t.active === "X" ? "authOn" : "authOff") });
                                        }));
                                        oModel.setProperty("/rules", (r.rules || []).map(function (x) {
                                                return Object.assign({}, x, {
                                                        modeText: oRB.getText("authMode" + x.ruleMode),
                                                        targetText: x.tabname ? oRB.getText("admArrowTable", [x.tabname]) : oRB.getText("admArrowAuto")
                                                });
                                        }));
                                        // 20261023：规则的目标表下拉（只列已登记的表；第一项 = 不指定，走自动发现）
                                        oModel.setProperty("/ruleTables", [{ key: "-", text: oRB.getText("admRuleTableAuto") }].concat((r.tables || []).map(function (t) {
                                                return { key: t.tabname, text: t.tabname + (t.descr ? "  ·  " + t.descr : "") + (t.active === "X" ? "" : "  （" + oRB.getText("authOff") + "）") };
                                        })));
                                        // 配置变了：两个编辑区里"权限表的映射"摘要 / 对照、"哪些规则单独映射"提示跟着刷新
                                        oModel.setProperty("/editTable/ownRulesText", that._authOwnRulesText(oModel.getProperty("/editTable/tabname")));
                                        that._authRuleSet(oModel.getProperty("/editRule"));
                                })
                        ]);
                },

                _authLoadAdminList: function (bReset) {
                        var that = this, oModel = this._authModel(), a = oModel.getProperty("/admin");
                        if (bReset) {
                                oModel.setProperty("/admin/skip", 0);
                        }
                        return ChatService.authList({ Status: a.status, User: a.user, Tcode: a.tcode, Top: String(PAGE), Skip: String(oModel.getProperty("/admin/skip")) }).then(function (r) {
                                oModel.setProperty("/admin/rows", that._authDecorate(r.requests));
                                oModel.setProperty("/admin/total", r.total || 0);
                                // 审批 / 驳回 / 撤销 / 批量代加 / 刷新之后，角标跟着更新
                                that._authCheckPending();
                        });
                },

                /** 管理对话框页签（按钮的自定义数据 tab） */
                onAdmTab: function (oEvent) {
                        this._authModel().setProperty("/admTab", oEvent.getSource().data("tab"));
                        this._authScrollTop("admScroll");
                },

                /** 申请记录的状态胶囊：选中即按该状态重新查（空 = 全部） */
                onAdmStatus: function (oEvent) {
                        var that = this, oModel = this._authModel();
                        oModel.setProperty("/admin/status", oEvent.getSource().data("status") || "");
                        this._authRun(function () { return that._authLoadAdminList(true); });
                },

                onAdmRuleMode: function (oEvent) {
                        this._authModel().setProperty("/editRule/ruleMode", oEvent.getSource().data("mode"));
                },

                /** 编辑区回到空白（新建一张权限表 / 一条规则） */
                onAuthNewTable: function () {
                        this._authModel().setProperty("/editTable", { tabname: "", descr: "", discover: true, active: true, fields: [], loaded: "", ownRulesText: "" });
                },

                onAuthNewRule: function () {
                        this._authRuleSet(emptyRule());
                },

                onAuthRefreshAdmin: function () {
                        var that = this;
                        this._authRun(function () { return that._authLoadAdmin(true); });
                },

                /* ---------- 审批 / 驳回 / 撤销 ---------- */

                onAuthApprove: function (oEvent) {
                        this._authDecide(this._authRow(oEvent), true);
                },

                onAuthReject: function (oEvent) {
                        this._authDecide(this._authRow(oEvent), false);
                },

                _authDecide: function (oRow, bApprove) {
                        var that = this, oModel = this._authModel(), oRB = this._rb();
                        var sNote = (oModel.getProperty("/admin/note") || "").trim();
                        if (!bApprove && !sNote) {
                                oModel.setProperty("/notice", oRB.getText("authNeedRejectReason"));
                                return;
                        }
                        MessageBox.confirm(oRB.getText(bApprove ? "authConfirmApprove" : "authConfirmReject", [oRow.targetUser, oRow.tcode, oRow.werks]), {
                                onClose: function (sAction) {
                                        if (sAction !== MessageBox.Action.OK) {
                                                return;
                                        }
                                        that._authRun(function () {
                                                return ChatService.authDecide({ ReqId: oRow.reqId, Approve: bApprove ? "X" : "", Message: sNote }).then(function (oRes) {
                                                        oModel.setProperty("/admin/note", "");
                                                        MessageToast.show(oRes.summary || oRB.getText("authDone"));
                                                        return that._authLoadAdminList(false);
                                                });
                                        });
                                }
                        });
                },

                onAuthRevoke: function (oEvent) {
                        var that = this, oModel = this._authModel(), oRB = this._rb(), oRow = this._authRow(oEvent);
                        var sNote = (oModel.getProperty("/admin/note") || "").trim();
                        MessageBox.confirm(oRB.getText("authConfirmRevoke", [oRow.targetUser, oRow.tcode, oRow.werks]), {
                                onClose: function (sAction) {
                                        if (sAction !== MessageBox.Action.OK) {
                                                return;
                                        }
                                        that._authRun(function () {
                                                return ChatService.authRevoke({ ReqId: oRow.reqId, Message: sNote }).then(function (oRes) {
                                                        oModel.setProperty("/admin/note", "");
                                                        MessageToast.show(oRes.summary || oRB.getText("authDone"));
                                                        return that._authLoadAdminList(false);
                                                });
                                        });
                                }
                        });
                },

                /* ---------- 批量代加 ---------- */

                onAuthBatchAdd: function () {
                        var that = this, oModel = this._authModel(), b = oModel.getProperty("/batch");
                        if (!b.users.trim() || !b.tcode.trim() || !b.werks.trim() || !b.reason.trim()) {
                                oModel.setProperty("/notice", this._rb().getText("authNeedBatchFields"));
                                return;
                        }
                        this._authRun(function () {
                                return ChatService.authBatchAdd({ Users: b.users, Tcode: b.tcode.trim().toUpperCase(), WerksList: b.werks, Reason: b.reason.trim() }).then(function (oRes) {
                                        that._authShowResult(oRes);
                                        return that._authLoadAdminList(true);
                                });
                        });
                },

                /* ---------- 权限表配置 ---------- */

                /** 读表结构 + 建议映射（已登记的表带出已保存的映射，可直接改） */
                onAuthDescribe: function () {
                        var that = this, oModel = this._authModel(), sTab = (oModel.getProperty("/editTable/tabname") || "").trim().toUpperCase();
                        oModel.setProperty("/editTable/fields", []);
                        oModel.setProperty("/editTable/loaded", "");
                        this._authRun(function () {
                                return ChatService.authTableDescribe({ Tabname: sTab }).then(function (r) {
                                        oModel.setProperty("/editTable/tabname", sTab);
                                        oModel.setProperty("/editTable/fields", r.fields || []);
                                        oModel.setProperty("/editTable/loaded", sTab);
                                        oModel.setProperty("/editTable/ownRulesText", that._authOwnRulesText(sTab));
                                });
                        });
                },

                onAuthPickTable: function (oEvent) {
                        var oModel = this._authModel(), oRow = oEvent.getParameter("listItem").getBindingContext("auth").getObject();
                        oModel.setProperty("/editTable", {
                                tabname: oRow.tabname, descr: oRow.descr, discover: oRow.discover === "X", active: oRow.active === "X",
                                fields: clone(oRow.fields || []), loaded: oRow.tabname, ownRulesText: this._authOwnRulesText(oRow.tabname)
                        });
                },

                onAuthSaveTable: function () {
                        var that = this, oModel = this._authModel(), t = oModel.getProperty("/editTable");
                        var sTab = (t.tabname || "").trim().toUpperCase();
                        if (!t.fields.length || t.loaded !== sTab) {
                                oModel.setProperty("/notice", this._rb().getText("authDescribeFirst"));
                                return;
                        }
                        var aMap = t.fields.map(function (f) { return { f: f.fieldname, t: f.mapType, c: f.constVal || "" }; });
                        this._authRun(function () {
                                return ChatService.authTableSave({
                                        Tabname: sTab, Descr: t.descr || "", Discover: t.discover ? "X" : "", Active: t.active ? "X" : "", FmapJson: JSON.stringify(aMap)
                                }).then(function (oRes) {
                                        MessageToast.show(oRes.message || that._rb().getText("authSaved"));
                                        return that._authLoadAdmin(false);
                                });
                        });
                },

                /* ---------- 事务码规则（20261023 起可带自己的字段映射） ---------- */

                /** 已登记权限表的字段与映射（来自 AuthConfig；规则"复制权限表映射"与"对照"都用它） */
                _authTableFields: function (sTab) {
                        var oTab = (this._authModel().getProperty("/tables") || []).filter(function (t) { return t.tabname === sTab; })[0];
                        return clone((oTab && oTab.fields) || []).map(function (f) {
                                return { fieldname: f.fieldname, keyflag: f.keyflag, datatype: f.datatype, leng: f.leng, convexit: f.convexit,
                                        mapType: f.mapType || "INITIAL", constVal: f.constVal || "" };
                        });
                },

                /** 权限表配置里的提示：哪些规则用自己的映射（改这张表的映射不会带到它们） */
                _authOwnRulesText: function (sTab) {
                        var aPats = (this._authModel().getProperty("/rules") || []).filter(function (r) {
                                return sTab && r.ownMap === "X" && r.tabname === sTab;
                        }).map(function (r) { return r.tcodePat; });
                        return aPats.length ? this._rb().getText("admTableOwnRules", [aPats.join("、")]) : "";
                },

                /** 写规则编辑区：按目标表算出"沿用"摘要、"单独"提示，给单独映射的每行带上权限表自己的映射作对照 */
                _authRuleSet: function (oRule) {
                        var oRB = this._rb(), r = Object.assign(emptyRule(), oRule || {});
                        var aBase = r.tabname ? this._authTableFields(r.tabname) : [];
                        var fText = function (f) {
                                return oRB.getText("authMap" + f.mapType) + (f.mapType === "CONST" ? "「" + f.constVal + "」" : "");
                        };
                        r.baseMap = aBase.filter(function (f) { return f.mapType !== "INITIAL"; }).map(function (f) {
                                return { text: f.fieldname + " → " + fText(f) };
                        });
                        r.baseHint = r.tabname ? oRB.getText("admRuleMapBaseHint", [r.tabname]) : "";
                        r.fields = (r.fields || []).map(function (f) {
                                var b = aBase.filter(function (x) { return x.fieldname === f.fieldname; })[0] || { mapType: "INITIAL", constVal: "" };
                                return Object.assign({}, f, {
                                        constVal: f.constVal || "",
                                        baseType: b.mapType, baseConst: b.mapType === "CONST" ? b.constVal : "", baseText: fText(b)
                                });
                        });
                        r.ownHint = oRB.getText("admRuleMapOwnHint", [r.tabname, r.fields.length]);
                        this._authModel().setProperty("/editRule", r);
                },

                onAuthPickRule: function (oEvent) {
                        var oRow = oEvent.getParameter("listItem").getBindingContext("auth").getObject();
                        var bOwn = oRow.ownMap === "X";
                        this._authRuleSet({
                                tcodePat: oRow.tcodePat, tabname: oRow.tabname, ruleMode: oRow.ruleMode, allowAll: oRow.allowAll === "X", active: oRow.active === "X",
                                ownMap: bOwn, fields: bOwn ? clone(oRow.fields || []) : [], fieldsTab: bOwn ? oRow.tabname : ""
                        });
                },

                /** 换目标表：单独映射时按新表的映射重新复制一份；改成"不指定"就回到沿用 */
                onAuthRuleTable: function (oEvent) {
                        var oItem = oEvent.getParameter("selectedItem");
                        var r = clone(this._authModel().getProperty("/editRule"));
                        r.tabname = oItem && oItem.getKey() !== "-" ? oItem.getKey() : "";   // "-" = 不指定（自动发现）
                        if (!r.tabname) {
                                r.ownMap = false;
                        }
                        if (r.ownMap) {
                                r.fields = this._authTableFields(r.tabname);
                                r.fieldsTab = r.tabname;
                                MessageToast.show(this._rb().getText("admRuleMapRecopied", [r.tabname]));
                        } else if (r.fieldsTab !== r.tabname) {
                                r.fields = [];
                                r.fieldsTab = "";
                        }
                        this._authRuleSet(r);
                },

                /** 「沿用权限表映射」/「本规则单独映射」胶囊（自定义数据 map = inherit | own）；
                 *  第一次切到单独映射时复制权限表的映射；来回切换保留已改的内容 */
                onAdmRuleMap: function (oEvent) {
                        var r = clone(this._authModel().getProperty("/editRule"));
                        r.ownMap = oEvent.getSource().data("map") === "own";
                        if (r.ownMap && (!r.fields.length || r.fieldsTab !== r.tabname)) {
                                r.fields = this._authTableFields(r.tabname);
                                r.fieldsTab = r.tabname;
                        }
                        this._authRuleSet(r);
                },

                onAuthRuleRecopy: function () {
                        var r = clone(this._authModel().getProperty("/editRule"));
                        r.fields = this._authTableFields(r.tabname);
                        r.fieldsTab = r.tabname;
                        this._authRuleSet(r);
                        MessageToast.show(this._rb().getText("admRuleMapRecopied", [r.tabname]));
                },

                onAuthSaveRule: function () {
                        this._authSaveRule(false);
                },

                onAuthDeleteRule: function () {
                        var that = this, oRB = this._rb(), sPat = this._authModel().getProperty("/editRule/tcodePat");
                        MessageBox.confirm(oRB.getText("authConfirmDeleteRule", [sPat]), {
                                onClose: function (sAction) {
                                        if (sAction === MessageBox.Action.OK) {
                                                that._authSaveRule(true);
                                        }
                                }
                        });
                },

                _authSaveRule: function (bDelete) {
                        var that = this, oModel = this._authModel(), r = oModel.getProperty("/editRule");
                        var sPat = (r.tcodePat || "").trim().toUpperCase(), sTab = (r.tabname || "").trim().toUpperCase();
                        // 单独映射：整份提交（每个字段一行）；沿用 / 不指定表：空串 = 后端清掉本规则的映射
                        var bOwn = !bDelete && r.ownMap && !!sTab && r.fields.length > 0;
                        var sFmap = bOwn ? JSON.stringify(r.fields.map(function (f) { return { f: f.fieldname, t: f.mapType, c: f.constVal || "" }; })) : "";
                        this._authRun(function () {
                                return ChatService.authRuleSave({
                                        TcodePat: sPat, Tabname: sTab, RuleMode: r.ruleMode,
                                        AllowAll: r.allowAll ? "X" : "", Active: r.active ? "X" : "", Delete: bDelete ? "X" : "", FmapJson: sFmap
                                }).then(function (oRes) {
                                        MessageToast.show(oRes.message || that._rb().getText("authSaved"));
                                        return that._authLoadAdmin(false);
                                }).then(function () {
                                        // 编辑区换成后端存下的样子（删除后回到空白）
                                        var oSaved = bDelete ? null : (oModel.getProperty("/rules") || []).filter(function (x) { return x.tcodePat === sPat; })[0];
                                        var bSavedOwn = !!oSaved && oSaved.ownMap === "X";
                                        that._authRuleSet(!oSaved ? emptyRule() : {
                                                tcodePat: oSaved.tcodePat, tabname: oSaved.tabname, ruleMode: oSaved.ruleMode, allowAll: oSaved.allowAll === "X", active: oSaved.active === "X",
                                                ownMap: bSavedOwn, fields: bSavedOwn ? clone(oSaved.fields || []) : [], fieldsTab: bSavedOwn ? oSaved.tabname : ""
                                        });
                                });
                        });
                }
        };
});
