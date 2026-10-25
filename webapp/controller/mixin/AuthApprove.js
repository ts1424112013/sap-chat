sap.ui.define([
        "zai/chat/utils/Toast",
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
        var EASE = "cubic-bezier(.22, 1, .36, 1)";   // 与 style.css 的 --ease 一致

        /** 处理成功后卡片上的结果标记图标（对勾带描线动画用的 class="draw"） */
        var MARK_SVG = {
                ok: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path class="draw" d="M5 12.5l4.5 4.5L19 7.5" stroke-dasharray="24" stroke-dashoffset="0"/></svg>',
                no: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>'
        };

        function canAnimate() {
                return !!(document.body && document.body.animate) &&
                        !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        }

        function cardSel(sReqId) {
                var s = String(sReqId || "");
                return '.apvCard[data-reqid="' + (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&")) + '"]';
        }

        /** CHAR14 yyyymmddhhmmss → "mm-dd hh:mm"（不是 14 位数字就原样显示） */
        function fmtShort(s) {
                return /^\d{14}$/.test(s || "")
                        ? s.substring(4, 6) + "-" + s.substring(6, 8) + " " + s.substring(8, 10) + ":" + s.substring(10, 12)
                        : (s || "");
        }

        /** 20261024：头像文字 —— 有中文姓名取后两个字（王小明 → 小明），西文姓名取首字母，没有姓名退回账号前两位 */
        function avatarText(sName, sUser) {
                var n = String(sName || "").trim();
                if (n && /[\u4e00-\u9fff]/.test(n)) {
                        n = n.replace(/\s+/g, "");
                        return n.length > 2 ? n.slice(-2) : n;
                }
                if (n) {
                        var w = n.split(/\s+/);
                        return (w.length > 1 ? w[0].charAt(0) + w[1].charAt(0) : n.substring(0, 2)).toUpperCase();
                }
                return String(sUser || "").substring(0, 2).toUpperCase() || "?";
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
                                // 20261024（10.24 记录 #00a）：后端从 USER_ADDR 补的姓名 / 部门；查不到为空，只显示账号
                                var sName = String(r.targetName || "").trim();
                                x.targetName = sName;
                                x.targetDept = String(r.targetDept || "").trim();
                                x.whoText = sName ? oRB.getText("apvWho", [sName, sUser]) : sUser;
                                x.initials = avatarText(sName, sUser);
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

                /** 加载当前页签；待审批页顺带校正侧栏角标。bSilent：不显示加载遮罩、失败不提示（处理完卡片后的后台对账） */
                _apvLoad: function (bSilent) {
                        var that = this, oModel = this._apvModel(), oRB = this._rb();
                        var bPending = oModel.getProperty("/apv/tab") === "pending";
                        if (!bSilent) {
                                oModel.setProperty("/apv/loading", true);
                                oModel.setProperty("/apv/notice", "");
                        }
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
                                if (!bSilent) {
                                        oModel.setProperty("/apv/notice", (e && e.message) || String(e));
                                }
                        }).then(function () {
                                that._apvSubtitle();
                                if (!bSilent) {
                                        oModel.setProperty("/apv/loading", false);
                                }
                        });
                },

                _apvSubtitle: function () {
                        var oModel = this._apvModel(), n = oModel.getProperty("/apv/total"), oRB = this._rb();
                        oModel.setProperty("/apv/subtitle", n > 0 ? oRB.getText("apvSubCount", [n]) : oRB.getText("apvSubNone"));
                },

                /* ---------------------------------------------------------
                 * 20261020：处理成功后的卡片动画
                 *  ① 卡片上盖结果标记（绿色对勾描线「已批准」/ 红色「已驳回」），停留 0.65 秒
                 *  ② 卡片上移、缩小、淡出
                 *  ③ 从列表移除这一行，下面的卡片 FLIP 滑上来补位；条数与角标同步减一
                 *  ④ 补位结束后静默刷新一次与后端对账
                 * 用定时器串步骤（页面在后台时动画时间线会停，定时器仍会走）；
                 * 卡片按 data-reqid 找 DOM（同时处理多张时下标会变）。
                 * --------------------------------------------------------- */
                _apvAnimateDone: function (sReqId, bApprove) {
                        var that = this;
                        var oDom = document.querySelector(cardSel(sReqId));
                        if (!oDom) {
                                this._apvRemoveRow(sReqId);
                                return;
                        }
                        var oMark = document.createElement("div");
                        oMark.className = "apvDoneMark" + (bApprove ? "" : " rej");
                        oMark.innerHTML = "<i>" + (bApprove ? MARK_SVG.ok : MARK_SVG.no) + "</i><span></span>";
                        oMark.querySelector("span").textContent = this._rb().getText(bApprove ? "apvDoneApprove" : "apvDoneReject");
                        oDom.appendChild(oMark);
                        oMark.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
                        oMark.querySelector("i").animate([{ transform: "scale(.55)" }, { transform: "none" }],
                                { duration: 420, easing: "cubic-bezier(.34, 1.56, .64, 1)" });
                        var oPath = oMark.querySelector("path.draw");
                        if (oPath) {
                                oPath.animate([{ strokeDashoffset: 24 }, { strokeDashoffset: 0 }], { duration: 320, delay: 100, easing: "ease-out", fill: "backwards" });
                        }
                        window.setTimeout(function () {
                                var oNow = document.querySelector(cardSel(sReqId));
                                if (oNow) {
                                        oNow.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px) scale(.97)" }],
                                                { duration: 220, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
                                }
                                window.setTimeout(function () { that._apvRemoveRow(sReqId); }, 230);
                        }, 650);
                },

                /** 卡片当前位置：{reqId: {el, top}} */
                _apvCardTops: function () {
                        var m = {};
                        Array.prototype.forEach.call(document.querySelectorAll(".apvCards .apvCard[data-reqid]"), function (el) {
                                m[el.getAttribute("data-reqid")] = { el: el, top: el.getBoundingClientRect().top };
                        });
                        return m;
                },

                _apvRemoveRow: function (sReqId) {
                        var that = this, oModel = this._apvModel();
                        var aRows = (oModel.getProperty("/apv/rows") || []).slice();
                        var i = aRows.map(function (x) { return x.reqId; }).indexOf(sReqId);
                        if (i < 0) {
                                this._apvLoad(true);
                                return;
                        }
                        var mBefore = this._apvCardTops();
                        // UI5 可能原地复用卡片 DOM：先撤掉这张的退场动画 / 结果标记，免得留到接替它的下一张上
                        var oOld = document.querySelector(cardSel(sReqId));
                        if (oOld) {
                                oOld.getAnimations().forEach(function (a) { a.cancel(); });
                                Array.prototype.forEach.call(oOld.querySelectorAll(".apvDoneMark"), function (el) { el.remove(); });
                        }
                        aRows.splice(i, 1);
                        oModel.setProperty("/apv/rows", aRows);
                        var n = Math.max(0, (Number(oModel.getProperty("/apv/total")) || 0) - 1);
                        oModel.setProperty("/apv/total", n);
                        this._apvSubtitle();
                        this._authSetPending(n);
                        var fnFlip = function () {
                                var mAfter = that._apvCardTops();
                                Object.keys(mAfter).forEach(function (id) {
                                        var dy = mBefore[id] ? mBefore[id].top - mAfter[id].top : 0;
                                        if (Math.abs(dy) > 0.5) {
                                                mAfter[id].el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: 340, easing: EASE });
                                        }
                                });
                                // 补位结束后静默对账（总数 / 期间新来的申请）
                                window.setTimeout(function () { that._apvLoad(true); }, 380);
                        };
                        // 同步渲染后再量新位置（Core.applyChanges 在 1.130 仍可用；没有就等下一轮渲染）
                        var oCore = sap.ui.getCore();
                        if (oCore.applyChanges) {
                                oCore.applyChanges();
                                fnFlip();
                        } else {
                                window.setTimeout(fnFlip, 0);
                        }
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
                        oModel.setProperty(oCtx.getPath() + "/confirmText", oRB.getText(sMode === "reject" ? "apvConfirmReject" : "apvConfirmApprove", [r.whoText || r.targetUser, r.tcode, r.werksText]));
                        oModel.setProperty(oCtx.getPath() + "/mode", sMode);
                },

                onApvCancel: function (oEvent) {
                        var oCtx = this._apvCtx(oEvent);
                        oCtx.getModel().setProperty(oCtx.getPath() + "/mode", "");
                },

                /** 确认：调后端 → 成功后卡片动画退场（不支持动画时提示并刷新）；失败把后端原话写在卡片里 */
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
                                if (!canAnimate()) {
                                        MessageToast.show(oRes.summary || that._rb().getText("authDone"));
                                        that._apvLoad();
                                        return;
                                }
                                var iRow = (oModel.getProperty("/apv/rows") || []).map(function (x) { return x.reqId; }).indexOf(r.reqId);
                                if (iRow >= 0) {
                                        oModel.setProperty("/apv/rows/" + iRow + "/busy", false);   // 确认面板不收起（免得卡片先变矮），结果标记直接盖上去
                                }
                                // 等撤掉 busy 遮罩的重绘落地，再盖结果标记
                                window.setTimeout(function () { that._apvAnimateDone(r.reqId, bApprove); }, 30);
                        }, function (e) {
                                // 刷新期间列表可能已重建：只在这一行还在原位时写回错误
                                if (oModel.getProperty(sPath + "/reqId") === r.reqId) {
                                        oModel.setProperty(sPath + "/busy", false);
                                        oModel.setProperty(sPath + "/error", (e && e.message) || String(e));
                                }
                        });
                }
        };
});
