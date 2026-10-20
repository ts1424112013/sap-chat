sap.ui.define([
        "sap/m/MessageToast",
        "zai/chat/service/ChatService",
        "zai/chat/utils/ReportCatalog"
], function (MessageToast, ChatService, ReportCatalog) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：报表目录（「报表执行」与「Fiori 报表」场景首页）
         * =====================================================================
         * 设计：功能计划书/报表执行目录/01-方案与开发计划_V1.0、Fiori报表分析/01-方案与开发计划 §6。
         *  · 只在 Agent 空会话首页显示（目录容器在 hero 里，发出第一条消息后随 hero 一起隐藏）
         *  · 「报表执行」：ReportDefinitions（已有接口）→ 单选，点选发出「执行 <TCode>」，之后走现有报表链路
         *  · 「Fiori 报表」：FioriReportDefs → 按业务分类页签，点选发出「选择报表：<报表名>」
         *  · 清单每个场景取一次缓存在控制器里；点「重试」重新取
         * 以 mixin 方式并入 zai.chat.controller.App（方法里的 this 就是控制器）；方法名统一 _cat 前缀。
         * =====================================================================
         */

        /** 有目录的场景 */
        var CAT_SCENES = ["REPORT", "FIORI"];

        /** 取字段：兼容 camelCase / 下划线小写 / 大写（ReportDefinitions 的 ResultJson 没设 pretty_name，键是大写） */
        function pick(o, sKey) {
                if (!o) {
                        return undefined;
                }
                var sCamel = sKey.replace(/_([a-z])/g, function (s, c) { return c.toUpperCase(); });
                var aTry = [sKey, sKey.toUpperCase(), sCamel];
                for (var i = 0; i < aTry.length; i++) {
                        if (o[aTry[i]] !== undefined && o[aTry[i]] !== null) {
                                return o[aTry[i]];
                        }
                }
                return undefined;
        }

        return {

                /** 当前场景有没有目录 */
                _catScene: function (sScene) {
                        return CAT_SCENES.indexOf(sScene) >= 0;
                },

                /** hero 里显示 / 隐藏目录（_renderHeroBubbles 末尾调用） */
                _renderCatalog: function () {
                        var oHost = this.byId("catalogHost");
                        if (!oHost) {
                                return;
                        }
                        var bAgent = this.getView().getModel("chat").getProperty("/workspaceMode") === "AGENT";
                        var sScene = bAgent ? this._curScene() : "";
                        var bShow = this._catScene(sScene);
                        oHost.setVisible(bShow);
                        if (!bShow) {
                                return;
                        }
                        this._mCat = this._mCat || {};
                        var oCat = this._mCat[sScene];
                        if (!oCat) {
                                oCat = this._mCat[sScene] = { cfg: this._catCfg(sScene), loaded: false, loading: false };
                                oCat.ctl = ReportCatalog.create(oCat.cfg);
                        }
                        if (oHost.getItems()[0] !== oCat.ctl) {
                                oHost.removeAllItems();   // 不销毁：另一个场景的目录留在缓存里
                                oHost.addItem(oCat.ctl);
                        }
                        // 收起 / 展开是全局偏好：另一个场景里改过的，切过来时跟上
                        var bFold = this._catFolded();
                        if (oCat.ctl.data("catState").collapsed !== bFold) {
                                ReportCatalog.update(oCat.ctl, { collapsed: bFold });
                        }
                        if (!oCat.loaded && !oCat.loading) {
                                this._catLoad(sScene);
                        }
                },

                /** 20261020：目录默认收起；用户展开过就记住（本地，两个场景共用） */
                _catFolded: function () {
                        try {
                                return window.localStorage.getItem("zaiChat.catalogOpen") !== "X";
                        } catch (e) {
                                return true;
                        }
                },

                _catOnToggle: function (bCollapsed) {
                        try {
                                window.localStorage.setItem("zaiChat.catalogOpen", bCollapsed ? "" : "X");
                        } catch (e) { /* 忽略 */ }
                },

                /** 目录配置（文案按场景取 i18n） */
                _catCfg: function (sScene) {
                        var oRB = this._rb();
                        var bF = sScene === "FIORI";
                        return {
                                icon: bF ? "chart" : "doc",
                                categories: null,
                                collapsible: true,
                                collapsed: this._catFolded(),
                                onToggle: this._catOnToggle.bind(this),
                                texts: {
                                        title: oRB.getText("catTitle"),
                                        count: oRB.getText("catCount"),
                                        searchPh: oRB.getText(bF ? "catSearchPhFiori" : "catSearchPhReport"),
                                        footNote: oRB.getText(bF ? "catFootFiori" : "catFootReport"),
                                        empty: oRB.getText(bF ? "catEmptyFiori" : "catEmpty"),
                                        loadFail: oRB.getText("catLoadFail"),
                                        retry: oRB.getText("catRetry"),
                                        loading: oRB.getText("catLoading"),
                                        all: oRB.getText("catAll"),
                                        noMatch: oRB.getText("catNoMatch"),
                                        params: oRB.getText("catParams"),
                                        pick: oRB.getText(bF ? "catPickFiori" : "catPickReport"),
                                        pickTip: oRB.getText(bF ? "catPickTipFiori" : "catPickTipReport"),
                                        offTip: oRB.getText("catOffTip"),
                                        expand: oRB.getText("catExpand"),
                                        collapse: oRB.getText("catCollapse")
                                },
                                onPick: this._catOnPick.bind(this, sScene),
                                onRetry: this._catLoad.bind(this, sScene)
                        };
                },

                /** 取清单（失败显示原因 + 重试，不影响输入框） */
                _catLoad: function (sScene) {
                        var that = this;
                        var oCat = this._mCat && this._mCat[sScene];
                        if (!oCat) {
                                return;
                        }
                        oCat.loading = true;
                        ReportCatalog.update(oCat.ctl, { status: "loading", message: "" });
                        var pList = sScene === "FIORI" ? ChatService.getFioriReportDefs() : ChatService.getReportCatalog();
                        pList.then(function (o) {
                                oCat.loading = false;
                                oCat.loaded = true;
                                var aItems = (o.defs || []).map(sScene === "FIORI" ? that._catFioriItem.bind(that) : that._catReportItem.bind(that));
                                if (sScene === "FIORI") {
                                        // 分类页签按清单里出现的顺序（后端已按 CATEGORY、SORT_NO 排好）
                                        var aCats = [];
                                        aItems.forEach(function (it) {
                                                if (it.category && aCats.indexOf(it.category) < 0) {
                                                        aCats.push(it.category);
                                                }
                                        });
                                        oCat.cfg.categories = aCats.length > 1 ? aCats : null;
                                }
                                ReportCatalog.update(oCat.ctl, { status: "ready", items: aItems, message: o.message || "" });
                        }).catch(function (e) {
                                oCat.loading = false;
                                ReportCatalog.update(oCat.ctl, { status: "error", items: [], message: that._rb().getText("catLoadFail") + ((e && e.message) ? "：" + e.message : "") });
                        });
                },

                /** ReportDefinitions 一条 → 目录行（设计 §3.2） */
                _catReportItem: function (d) {
                        var oRB = this._rb();
                        var aP = pick(d, "params") || [];
                        return {
                                id: String(pick(d, "report_id") || pick(d, "tcode") || ""),
                                title: String(pick(d, "name") || pick(d, "report_name") || pick(d, "tcode") || ""),
                                code: String(pick(d, "tcode") || ""),
                                desc: String(pick(d, "description") || ""),
                                paramCount: Array.isArray(aP) ? aP.length : 0,
                                badges: [oRB.getText("catBadgeJob")],
                                disabled: pick(d, "exec_enabled") !== "X" && pick(d, "exec_enabled") !== true,
                                disabledText: oRB.getText("catOff")
                        };
                },

                /** FioriReportDefs 一条 → 目录行 */
                _catFioriItem: function (d) {
                        var aP = pick(d, "params") || [];
                        return {
                                id: String(pick(d, "report_id") || ""),
                                title: String(pick(d, "report_name") || pick(d, "report_id") || ""),
                                code: "",
                                desc: String(pick(d, "description") || ""),
                                category: String(pick(d, "category") || ""),
                                keywords: String(pick(d, "keywords") || ""),
                                paramCount: Array.isArray(aP) ? aP.length : 0,
                                badges: [],
                                disabled: false
                        };
                },

                /** 点选：等同用户自己打字发出一条消息，之后完全走现有链路 */
                _catOnPick: function (sScene, oItem) {
                        var oChat = this.getView().getModel("chat");
                        if (oChat.getProperty("/busy")) {
                                MessageToast.show(this._rb().getText("busyWait"));
                                return;
                        }
                        if (this._curScene() !== sScene) {
                                return;   // 目录属于另一个场景（理论上不会出现：容器只放当前场景的目录）
                        }
                        var sText = sScene === "FIORI"
                                ? this._rb().getText("catSendFiori", [oItem.title])
                                : this._rb().getText("catSendReport", [oItem.code]);
                        var oCtx = oChat.getProperty("/currentSession") || {};
                        this._executeSend({
                                mode: "AGENT",
                                agentType: oCtx.agentType || sScene,
                                displayText: sText,
                                meta: "",
                                question: sText,
                                keepInput: true
                        });
                }
        };
});
