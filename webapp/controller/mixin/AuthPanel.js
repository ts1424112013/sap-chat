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
         * 入口都在侧栏会话列表下方（设计：功能计划书/权限自助申请/01-方案与开发计划_V1.3）：
         *   ① 「申请权限」→ 对话框 AuthDialog：申请 / 我的申请
         *   ② 「权限审批」（仅 ADMIN）→ 审批对话框（见 AuthApprove mixin）；入口上的红色角标 = 待审批条数
         *      （登录后、每 2 分钟、切回页面时查一次；条数变多时弹提示）
         *   ③ 审批对话框右上「管理」→ AuthAdminDialog（内容 AuthAdmin）：全部记录与撤销 / 批量代加 / 权限表配置 / 事务码规则
         * 数据都在视图模型 "auth" 里；所有后端调用经 ChatService.auth*（失败抛 Error(后端原话)，
         * 这里统一显示在对话框 / 页签顶部的红色提示条）。
         * 以 mixin 并入 zai.chat.controller.App，方法名统一 auth / _auth 前缀，避免与其他块重名（红线 8）。
         * =====================================================================
         */

        var PAGE = 50;
        var PENDING_POLL_MS = 120000;
        var STATUS_STATE = { DONE: "Success", EXISTS: "Information", PENDING: "Warning", FAILED: "Error", REJECTED: "Error", REVOKED: "None" };

        /** CHAR14 yyyymmddhhmmss → "yyyy-mm-dd hh:mm:ss"（不是 14 位数字就原样显示） */
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
                                form: { tcode: "", werks: "", reason: "" },
                                result: { lines: [], summary: "" },
                                mine: { rows: [], total: 0, skip: 0 },
                                admin: { rows: [], total: 0, skip: 0, status: "", user: "", tcode: "", note: "" },
                                batch: { users: "", tcode: "", werks: "", reason: "" },
                                tables: [],
                                rules: [],
                                editTable: { tabname: "", descr: "", discover: true, active: true, fields: [], loaded: "" },
                                editRule: { tcodePat: "", tabname: "", ruleMode: "AUTO", allowAll: false, active: true },
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
                        this._iAuthPendingSeen = n;
                        oSettings.setProperty("/authPending", n);
                        oSettings.setProperty("/authPendingTip", this._rb().getText("authPendingTip", [n]));
                },

                /* =========================================================
                 * 管理入口：审批对话框右上「管理」→ 四页签管理对话框（仅 ADMIN）
                 * ========================================================= */

                /** 打开即刷新 */
                onOpenAuthAdmin: function () {
                        var that = this, oModel = this._authModel();
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
                        var oModel = this._authModel();
                        return Promise.all([
                                this._authLoadAdminList(bReset),
                                ChatService.authConfig().then(function (r) {
                                        oModel.setProperty("/tables", r.tables || []);
                                        oModel.setProperty("/rules", r.rules || []);
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
                        var oModel = this._authModel(), sTab = (oModel.getProperty("/editTable/tabname") || "").trim().toUpperCase();
                        oModel.setProperty("/editTable/fields", []);
                        oModel.setProperty("/editTable/loaded", "");
                        this._authRun(function () {
                                return ChatService.authTableDescribe({ Tabname: sTab }).then(function (r) {
                                        oModel.setProperty("/editTable/tabname", sTab);
                                        oModel.setProperty("/editTable/fields", r.fields || []);
                                        oModel.setProperty("/editTable/loaded", sTab);
                                });
                        });
                },

                onAuthPickTable: function (oEvent) {
                        var oModel = this._authModel(), oRow = oEvent.getParameter("listItem").getBindingContext("auth").getObject();
                        oModel.setProperty("/editTable", {
                                tabname: oRow.tabname, descr: oRow.descr, discover: oRow.discover === "X", active: oRow.active === "X",
                                fields: JSON.parse(JSON.stringify(oRow.fields || [])), loaded: oRow.tabname
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

                /* ---------- 事务码规则 ---------- */

                onAuthPickRule: function (oEvent) {
                        var oRow = oEvent.getParameter("listItem").getBindingContext("auth").getObject();
                        this._authModel().setProperty("/editRule", {
                                tcodePat: oRow.tcodePat, tabname: oRow.tabname, ruleMode: oRow.ruleMode, allowAll: oRow.allowAll === "X", active: oRow.active === "X"
                        });
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
                        this._authRun(function () {
                                return ChatService.authRuleSave({
                                        TcodePat: (r.tcodePat || "").trim().toUpperCase(), Tabname: (r.tabname || "").trim().toUpperCase(), RuleMode: r.ruleMode,
                                        AllowAll: r.allowAll ? "X" : "", Active: r.active ? "X" : "", Delete: bDelete ? "X" : ""
                                }).then(function (oRes) {
                                        MessageToast.show(oRes.message || that._rb().getText("authSaved"));
                                        return that._authLoadAdmin(false);
                                });
                        });
                }
        };
});
