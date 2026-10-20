sap.ui.define([
        "sap/m/MessageToast",
        "zai/chat/service/ChatService"
], function (MessageToast, ChatService) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器块：权限审批对话框（侧栏「权限审批」，仅 ADMIN）
         * =====================================================================
         * 审批是 IT 天天打开的界面，单独设计（AuthApprove 片段），不复用 AuthAdmin 的四页签面板：
         *   · 待审批：一张申请一张卡片，批准 / 驳回在卡片内展开确认（驳回原因必填）
         *   · 最近处理：最近 30 条已处理记录，只读
         *   · 右上「管理」→ AuthPanel 的 AuthAdminDialog（批量代加 / 权限表 / 规则 / 全部记录与撤销）
         * 数据放在视图模型 "auth" 的 /apv 下（换账号时随 auth 模型一起重建）；
         * 后端调用与 AuthPanel 相同（ChatService.authList / authDecide），语义不变。
         * 方法名统一 Apv / _apv 前缀（红线 8）。
         * =====================================================================
         */

        var DONE_TOP = 30;
        var HUES = 6;

        /** CHAR14 yyyymmddhhmmss → "mm-dd hh:mm"（不是 14 位数字就原样显示） */
        function fmtShort(s) {
                return /^\d{14}$/.test(s || "")
                        ? s.substring(4, 6) + "-" + s.substring(6, 8) + " " + s.substring(8, 10) + ":" + s.substring(10, 12)
                        : (s || "");
        }

        /** 账号 → 头像底色编号（同一账号颜色固定） */
        function hueOf(sUser) {
                var n = 0;
                for (var i = 0; i < sUser.length; i++) {
                        n = (n * 31 + sUser.charCodeAt(i)) % 997;
                }
                return String(n % HUES);
        }

        return {

                /** /apv 子树（auth 模型重建后第一次用时补上） */
                _apvModel: function () {
                        var oModel = this._authModel();
                        if (!oModel.getProperty("/apv")) {
                                oModel.setProperty("/apv", { tab: "pending", rows: [], done: [], total: 0, loading: false, notice: "", subtitle: "" });
                        }
                        return oModel;
                },

                /** 后端行 → 卡片 / 列表行（界面字段：头像、工厂文字、时间、确认态） */
                _apvDecorate: function (aRows) {
                        var oRB = this._rb();
                        return (aRows || []).map(function (r) {
                                var x = Object.assign({}, r);
                                var sUser = String(r.targetUser || "");
                                x.initials = sUser.substring(0, 2).toUpperCase() || "?";
                                x.hue = hueOf(sUser);
                                x.werksText = !r.werks ? oRB.getText("apvWerksNone")
                                        : r.werks === "ALL" ? oRB.getText("apvWerksAll") : oRB.getText("apvWerks", [r.werks]);
                                x.timeText = fmtShort(r.createdAt);
                                x.statusText = oRB.getText("authStatus" + r.status);
                                x.doneSub = [
                                        r.decidedBy ? oRB.getText("apvDecidedBy", [r.decidedBy === "AUTO" ? oRB.getText("apvAuto") : r.decidedBy]) : "",
                                        fmtShort(r.decidedAt || r.createdAt),
                                        r.message || ""
                                ].filter(Boolean).join("  ·  ");
                                x.mode = "";
                                x.note = "";
                                x.confirmText = "";
                                x.error = "";
                                x.busy = false;
                                return x;
                        });
                },

                onOpenAuthApprove: function () {
                        var oModel = this._apvModel();
                        oModel.setProperty("/apv/tab", "pending");
                        oModel.setProperty("/apv/notice", "");
                        if (!this._oAuthApproveDialog) {
                                this._oAuthApproveDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.AuthApprove", this);
                                this.getView().addDependent(this._oAuthApproveDialog);
                        }
                        this._oAuthApproveDialog.open();
                        this._apvLoadEnabled();
                        this._apvLoad();
                },

                onApvClose: function () {
                        if (this._oAuthApproveDialog) {
                                this._oAuthApproveDialog.close();
                        }
                },

                /** 右上「管理」：关掉审批框，打开完整管理（四页签） */
                onApvManage: function () {
                        this.onApvClose();
                        this.onOpenAuthAdmin();
                },

                onApvRefresh: function () {
                        this._apvLoad();
                },

                onApvTab: function (oEvent) {
                        var sTab = oEvent.getSource().data("tab"), oModel = this._apvModel();
                        if (oModel.getProperty("/apv/tab") === sTab) {
                                return;
                        }
                        oModel.setProperty("/apv/tab", sTab);
                        this._apvLoad();
                },

                /** 开关状态（关着时顶部黄条提示：批准 / 驳回会被拒绝） */
                _apvLoadEnabled: function () {
                        var oModel = this._apvModel();
                        var pEnabled = ChatService.getMode() === "mock"
                                ? Promise.resolve(ChatService._mockAuthEnabled())
                                : ChatService.getConfigValue("AUTH_ENABLED").then(function (v) { return v === "X"; });
                        pEnabled.then(function (bOn) {
                                oModel.setProperty("/enabled", bOn);
                        }).catch(function () { /* 读不到就不提示 */ });
                },

                /** 加载当前页签；待审批页顺带校正侧栏角标 */
                _apvLoad: function () {
                        var that = this, oModel = this._apvModel(), oRB = this._rb();
                        var bPending = oModel.getProperty("/apv/tab") === "pending";
                        oModel.setProperty("/apv/loading", true);
                        oModel.setProperty("/apv/notice", "");
                        var p = bPending
                                ? ChatService.authList({ Status: "PENDING", Top: "50", Skip: "0" }).then(function (r) {
                                        var n = Number(r.total) || 0;
                                        oModel.setProperty("/apv/rows", that._apvDecorate(r.requests));
                                        oModel.setProperty("/apv/total", n);
                                        that._authSetPending(n);
                                })
                                : Promise.all([
                                        ChatService.authList({ Top: String(DONE_TOP), Skip: "0" }),
                                        ChatService.authList({ Status: "PENDING", Top: "1", Skip: "0" })   // 头部条数与角标也跟着刷新
                                ]).then(function (a) {
                                        var n = Number(a[1].total) || 0;
                                        oModel.setProperty("/apv/done", that._apvDecorate((a[0].requests || []).filter(function (x) {
                                                return x.status !== "PENDING";
                                        })));
                                        oModel.setProperty("/apv/total", n);
                                        that._authSetPending(n);
                                });
                        return p.catch(function (e) {
                                oModel.setProperty("/apv/notice", (e && e.message) || String(e));
                        }).then(function () {
                                var n = oModel.getProperty("/apv/total");
                                oModel.setProperty("/apv/subtitle", n > 0 ? oRB.getText("apvSubCount", [n]) : oRB.getText("apvSubNone"));
                                oModel.setProperty("/apv/loading", false);
                        });
                },

                _apvCtx: function (oEvent) {
                        return oEvent.getSource().getBindingContext("auth");
                },

                /** 点「批准」/「驳回」：在这张卡片里展开确认（同一时间只展开一张） */
                onApvAsk: function (oEvent) {
                        var oCtx = this._apvCtx(oEvent), oModel = oCtx.getModel(), oRB = this._rb();
                        var sMode = oEvent.getSource().data("mode"), r = oCtx.getObject();
                        (oModel.getProperty("/apv/rows") || []).forEach(function (x, i) {
                                if (x.mode) {
                                        oModel.setProperty("/apv/rows/" + i + "/mode", "");
                                }
                        });
                        oModel.setProperty(oCtx.getPath() + "/note", "");
                        oModel.setProperty(oCtx.getPath() + "/error", "");
                        oModel.setProperty(oCtx.getPath() + "/confirmText", oRB.getText(sMode === "reject" ? "apvConfirmReject" : "apvConfirmApprove", [r.targetUser, r.tcode, r.werksText]));
                        oModel.setProperty(oCtx.getPath() + "/mode", sMode);
                },

                onApvCancel: function (oEvent) {
                        var oCtx = this._apvCtx(oEvent);
                        oCtx.getModel().setProperty(oCtx.getPath() + "/mode", "");
                },

                /** 确认：调后端 → 成功提示并刷新（卡片消失、角标减一）；失败把后端原话写在卡片里 */
                onApvConfirm: function (oEvent) {
                        var that = this, oCtx = this._apvCtx(oEvent), oModel = oCtx.getModel(), sPath = oCtx.getPath(), r = oCtx.getObject();
                        var bApprove = r.mode === "approve", sNote = (r.note || "").trim();
                        if (!bApprove && !sNote) {
                                oModel.setProperty(sPath + "/error", this._rb().getText("apvNeedReason"));
                                return;
                        }
                        oModel.setProperty(sPath + "/busy", true);
                        oModel.setProperty(sPath + "/error", "");
                        ChatService.authDecide({ ReqId: r.reqId, Approve: bApprove ? "X" : "", Message: sNote }).then(function (oRes) {
                                MessageToast.show(oRes.summary || that._rb().getText("authDone"));
                                return that._apvLoad();
                        }).catch(function (e) {
                                // 刷新期间列表可能已重建：只在这一行还在原位时写回错误
                                if (oModel.getProperty(sPath + "/reqId") === r.reqId) {
                                        oModel.setProperty(sPath + "/busy", false);
                                        oModel.setProperty(sPath + "/error", (e && e.message) || String(e));
                                }
                        });
                }
        };
});
