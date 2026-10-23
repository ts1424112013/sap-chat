sap.ui.define([
    "sap/ui/model/json/JSONModel", "sap/m/ResponsivePopover", "sap/m/FlexItemData", "sap/m/MessageToast",
    "sap/ui/core/HTML", "sap/ui/Device", "zai/chat/service/ChatService", "zai/chat/utils/SkillCatalog", "zai/chat/utils/Formatter"
], function (JSONModel, ResponsivePopover, FlexItemData, MessageToast, HTML, Device, Service, Skills, Formatter) {
    "use strict";

    /* ==========================================================================
     * Agent 技能入口（设计稿：功能计划书/技能入口/设计稿/01–08）
     * - 输入框底部「技能」胶囊：未选 = 技能 ▾；选中 = 「名称 ×」一个蓝色胶囊；不可用 = 虚线变灰
     * - 选择弹层、首页技能卡片：自绘 HTML（与报表目录 ReportCatalog 同一做法：
     *   字符串放进 sap.ui.core.HTML，点击 / 键盘用事件委托；动态文本一律 escapeHtml）
     * - 首页输入框下方提示行只在「已选技能 / 场景不支持 / 出错」时出现，查看做法就地展开
     * ========================================================================== */
    var esc = Formatter.escapeHtml;
    var SCENE_TEXT = { CODE: "代码分析", DATA: "数据分析", REPORT: "报表执行", FIORI: "Fiori 报表" };
    var ICON = {
        layers: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l6.2 3.2L8 8.2 1.8 5z M1.8 8L8 11.2 14.2 8 M1.8 11L8 14.2 14.2 11"/></svg>',
        search: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z M10.3 10.3L13.5 13.5"/></svg>',
        check: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>',
        info: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8z M8 7.3v4 M8 5v.3"/></svg>',
        right: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 4L10 8l-3.5 4"/></svg>'
    };

    /** 工具一行的文字：有子集列子集；空 = 报表类只读结果 / 其余场景用场景全部工具 */
    function toolText(s, scene) {
        if (s.tools.length) { return s.tools.map(function (id) { return Skills.toolLabels[id] || id; }).join(" · "); }
        return scene === "REPORT" || scene === "FIORI" ? "不调工具，只读已有结果" : "场景内全部工具";
    }

    return {
        _skillModel: function () {
            var m = this.getView().getModel("skill");
            if (!m) {
                // supported: null = 还不知道；false = 后端没部署（胶囊置灰，悬停说明「后端尚未部署技能入口」）
                m = new JSONModel({ visible: false, enabled: false, loading: false, supported: null,
                    items: [], selected: null, label: "技能", tooltip: "", status: "", hint: "", hintKind: "",
                    hintVisible: false, canViewBody: false, bodyOpen: false, error: "", canPick: false });
                this.getView().setModel(m, "skill");
            }
            return m;
        },
        _skillContext: function () {
            var c = this.getView().getModel("chat"), sess = c.getProperty("/currentSession") || {};
            return { scene: this._curScene(), sessionId: sess.id || "", taskId: (c.getProperty("/currentTask") || {}).taskId || "" };
        },
        _skillKey: function (p) {
            var cfg = Service.getConfig();
            return [cfg.mode, cfg.host, cfg.path, String((Service.getAppUser() || {}).userId || "").toUpperCase(),
                p.sessionId, p.taskId, p.scene].join("|");
        },
        _syncSkills: function (force) {
            var m = this._skillModel(), p = this._skillContext(), key = this._skillKey(p), that = this;
            var agent = this._wsMode() === "AGENT";
            m.setProperty("/visible", agent);
            if (!agent) { if (this._skillPopover) { this._skillPopover.close(); } return; }
            if (this._skillActiveKey === key && !force) { this._paintSkill(); return; }
            this._skillActiveKey = key;
            var loadToken = this._skillLoadToken = (this._skillLoadToken || 0) + 1;
            if (this._skillPopover) { this._skillPopover.close(); }
            this._skillSelections = this._skillSelections || {};
            m.setProperty("/selected", this._skillSelections[key] || null);
            m.setProperty("/items", []); m.setProperty("/error", ""); m.setProperty("/bodyOpen", false);
            m.setProperty("/loading", true); m.setProperty("/enabled", false);
            this._paintSkill();
            Service.getSkills(p).then(function (r) {
                if (that._skillLoadToken !== loadToken || that._skillActiveKey !== key || that._wsMode() !== "AGENT") { return; }
                m.setProperty("/supported", r.supported); m.setProperty("/enabled", r.enabled);
                m.setProperty("/items", r.skills); m.setProperty("/loading", false);
                if (!Object.prototype.hasOwnProperty.call(that._skillSelections, key)) {
                    m.setProperty("/selected", r.selectedId ? r.skills.filter(function (s) { return s.id === r.selectedId; })[0] ||
                        {id: r.selectedId, name: "技能已不可用", version: 0, invalid: true, tools: []} : null);
                } else {
                    var selected = m.getProperty("/selected");
                    if (selected) {
                        m.setProperty("/selected", r.skills.filter(function (s) { return s.id === selected.id; })[0] ||
                            Object.assign({}, selected, {invalid: true}));
                    }
                }
                that._paintSkill(); that._renderHeroBubbles();
            }).catch(function (e) {
                if (that._skillLoadToken !== loadToken || that._skillActiveKey !== key) { return; }
                m.setProperty("/loading", false); m.setProperty("/error", e.message || "技能目录读取失败");
                that._paintSkill();
            });
        },

        /** 按当前状态算出胶囊文字 / 提示 / 可选与否，并刷新两个输入框的样式与占位文字 */
        _paintSkill: function () {
            var m = this._skillModel(), s = m.getProperty("/selected"), scene = this._curScene();
            var bLoading = m.getProperty("/loading"), sErr = m.getProperty("/error");
            var bEnabled = m.getProperty("/enabled"), bScene = !!Skills.sceneTools[scene];
            var bRpt = scene === "REPORT" || scene === "FIORI";
            var bValid = !!s && !s.invalid;
            var canPick = !bLoading && bEnabled && bScene;
            // 不能选的原因（胶囊悬停提示，也是发送被拦时的提示）
            var sStatus = sErr ? "技能目录读取失败：" + sErr
                : bLoading ? "正在读取技能…"
                : m.getProperty("/supported") === false ? "后端尚未部署技能入口"
                : !bEnabled ? "技能能力尚未启用"
                : !bScene ? "自动场景不能用技能，先选具体场景"
                : s && s.invalid ? "该技能已停用或不可见，请取消或重新选择" : "";
            var sHint = "", sKind = "";
            if (sErr) {
                sHint = "技能目录读取失败：" + sErr; sKind = "warn";
            } else if (s && s.invalid) {
                sHint = "该技能已停用或不可见，请点 × 取消，或重新选一个"; sKind = "warn";
            } else if (bValid && bEnabled) {
                sKind = "skill";
                sHint = bRpt
                    ? "分析结果时按「" + s.name + " v" + s.version + "」的做法回答；执行和取数流程不变"
                    : "本任务按「" + s.name + " v" + s.version + "」的做法回答，" +
                        (s.tools.length ? "只用" + s.tools.map(function (id) { return Skills.toolLabels[id] || id; }).join("、")
                            : "可用场景内全部工具") + "；追问也沿用";
            } else if (bEnabled && !bLoading && !bScene) {
                sHint = "自动场景每句话分到的领域不同，不能用技能；先选上面的具体场景再用"; sKind = "info";
            }
            m.setProperty("/status", sStatus);
            m.setProperty("/hint", sHint); m.setProperty("/hintKind", sKind); m.setProperty("/hintVisible", !!sHint);
            m.setProperty("/canViewBody", bValid && !!s.body);
            if (!bValid) { m.setProperty("/bodyOpen", false); }
            m.setProperty("/label", s ? s.name : "技能");
            m.setProperty("/tooltip", sStatus || (s ? "换一个技能" : "选一种做法，Agent 按它来回答（输入框里打 / 也能打开）"));
            m.setProperty("/canPick", canPick);
            var bOpen = !!(this._skillPopover && this._skillPopover.isOpen());
            ["skillSlotHero", "skillSlotDock"].forEach(function (id) {
                var b = this.byId(id); if (!b) { return; }
                b.toggleStyleClass("skillOn", bValid);
                b.toggleStyleClass("skillWarn", !!s && !!s.invalid);
                b.toggleStyleClass("skillOff", !canPick && !s);
                b.toggleStyleClass("skillOpen", bOpen);
            }, this);
            if (bValid) {
                var chat = this.getView().getModel("chat"), oSc = this._sceneDef ? this._sceneDef(scene) : null;
                chat.setProperty("/heroPh", s.placeholder || (oSc && oSc.ph) || chat.getProperty("/heroPh"));
                chat.setProperty("/inputPh", "继续追问，仍按「" + s.name + "」的做法回答");
            }
        },

        /* ---------------- 首页：常用技能卡片（代码分析 / 数据分析） ---------------- */
        _skillHeroCards: function (box) {
            var m = this._skillModel(), that = this, scene = this._curScene();
            var items = m.getProperty("/items") || [];
            if (!m.getProperty("/enabled") || ["CODE", "DATA"].indexOf(scene) < 0 || !items.length) { return false; }
            var sel = m.getProperty("/selected");
            var cards = items.slice(0, 3).map(function (s) {
                var on = !!sel && !sel.invalid && sel.id === s.id;
                return '<button type="button" class="skCard" data-skill="' + esc(s.id) + '" aria-pressed="' + on + '" title="' + esc(s.description) + '">' +
                    '<span class="skCardTop"><span class="skIco">' + ICON.layers + '</span>' +
                    (on ? '<span class="skInUse">使用中</span>' : '') + '</span>' +
                    '<span class="skCardName">' + esc(s.name) + '</span>' +
                    '<span class="skCardDesc">' + esc(s.description) + '</span>' +
                    '<span class="skCardTools">工具：' + esc(toolText(s, scene)) + '</span></button>';
            }).join("");
            var html = '<div class="skHero"><div class="skHeroHead"><span>' + esc(SCENE_TEXT[scene]) + ' · 常用技能</span>' +
                '<button type="button" class="skHeroAll" data-skill-all="1">全部 ' + items.length + ' 个' + ICON.right + '</button></div>' +
                '<div class="skCards">' + cards + '</div></div>';
            var ctl = new HTML({ content: html, preferDOM: false, sanitizeContent: false,
                layoutData: new FlexItemData({ growFactor: 1, baseSize: "100%" }) });
            ctl.attachAfterRendering(function () {
                var root = ctl.getDomRef(); if (!root) { return; }
                root.onclick = function (ev) {
                    if (that.getView().getModel("chat").getProperty("/busy")) { return; }
                    if (ev.target.closest("[data-skill-all]")) { that._openSkills(that.byId("skillBtnHero"), false); return; }
                    var card = ev.target.closest("[data-skill]"); if (!card) { return; }
                    var id = card.getAttribute("data-skill"), cur = m.getProperty("/selected");
                    if (cur && cur.id === id) { that.onClearSkill(); return; }
                    var s = (m.getProperty("/items") || []).filter(function (x) { return x.id === id; })[0];
                    if (s) { that._chooseSkill(s); }
                };
            });
            box.addItem(ctl);
            return true;
        },

        /* ---------------- 选择弹层 ---------------- */
        onRefreshSkills: function () { this._syncSkills(true); },
        onOpenSkills: function (e) { this._openSkills(e.getSource(), false); },
        _openSkills: function (anchor, slash) {
            var m = this._skillModel(), that = this;
            if (!m.getProperty("/canPick") || this.getView().getModel("chat").getProperty("/busy")) { return; }
            // 从输入框（输入 /）打开时，弹层仍挂在同一输入卡的技能胶囊上
            var sId = anchor && anchor.getId ? anchor.getId() : "";
            var bDock = /msgInput$|skillBtnDock$/.test(sId) || (!/heroInput$|skillBtnHero$/.test(sId) &&
                !this.getView().getModel("chat").getProperty("/heroVisible"));
            var oPill = this.byId(bDock ? "skillBtnDock" : "skillBtnHero") || anchor;
            if (this._skillPopover && this._skillPopover.isOpen()) {
                // 打开后 300ms 内的第二次按压视为双击/触控板抖动，保持打开（否则表现为「点开就回缩」）
                if (!slash && Date.now() - (this._skillOpenedAt || 0) > 300) { this._skillPopover.close(); return; }
            }
            this._skillSlash = slash;
            if (!this._skillPopover) {
                this._skillPopHtml = new HTML({ preferDOM: false, sanitizeContent: false });
                this._skillPopHtml.attachAfterRendering(this._bindSkillPop.bind(this));
                this._skillPopover = new ResponsivePopover({
                    // 手机上 ResponsivePopover 变成全屏对话框：保留标题栏和关闭按钮，否则没地方关
                    showHeader: Device.system.phone, title: "选择技能", showArrow: false, contentWidth: "26rem", verticalScrolling: false,
                    content: [this._skillPopHtml],
                    afterOpen: function () { that._focusSkillSearch(); that._paintSkill(); },
                    afterClose: function () { that._skillSlash = false; that._paintSkill(); }
                }).addStyleClass("skillPopover");
                this.getView().addDependent(this._skillPopover);
            }
            // 方向：首页往下弹（设计稿 02），对话底部往上弹（设计稿 04）；放不下再换方向，列表高度按剩余空间收
            var oRef = oPill && oPill.getDomRef && oPill.getDomRef(), rc = oRef ? oRef.getBoundingClientRect() : null;
            var below = rc ? window.innerHeight - rc.bottom - 16 : 400, above = rc ? rc.top - 16 : 400;
            var sc = this._curScene(), fixed = 125 + (sc === "REPORT" || sc === "FIORI" ? 52 : 0);
            // 搜索 + 计数 + 页脚 + 至少 2 行就够用（多出来的行在列表里滚动），不够才换方向
            var need = fixed + Math.min((m.getProperty("/items") || []).length, 2) * 62;
            var bDown = bDock ? (above < need && below > above) : (below >= need || below >= above);
            this._skillListMax = Math.max(140, Math.min(320, (bDown ? below : above) - fixed));
            this._skillPopover.setPlacement(bDown ? "Bottom" : "Top");
            // 窄窗口（嵌入容器 / 分屏）下 26rem 会超出视口：收缩到「视口 - 左右边距」，弹层不再溢出
            this._skillPopover.setContentWidth(Math.min(416, Math.max(280, window.innerWidth - 24)) + "px");
            this._skillQuery = slash ? Skills.slash(this.getView().getModel("chat").getProperty("/input") || "") || "" : "";
            this._skillHi = 0;
            this._skillPopHtml.setContent(this._skillPopMarkup());
            if (this._skillPopover.isOpen()) { this._focusSkillSearch(); return; }
            this._skillOpenedAt = Date.now();
            this._skillPopover.openBy(oPill);
        },
        _skillPopMarkup: function () {
            var m = this._skillModel(), scene = this._curScene(), items = m.getProperty("/items") || [];
            var sel = m.getProperty("/selected") || {}, q = this._skillQuery || "";
            var rows = items.map(function (s) {
                var on = sel.id === s.id && !sel.invalid;
                var hay = (s.name + " " + s.description + " " + s.tools.join(" ")).toLowerCase();
                return '<div class="skPopRow" role="option" data-skill="' + esc(s.id) + '" data-hay="' + esc(hay) + '" aria-selected="' + on + '">' +
                    '<span class="skIco">' + ICON.layers + '</span>' +
                    '<span class="skPopMain"><span class="skPopName">' + esc(s.name) + '<span class="skVer">v' + esc(s.version) + '</span></span>' +
                    '<span class="skPopDesc">' + esc(s.description) + '</span>' +
                    '<span class="skPopTools">工具：' + esc(toolText(s, scene)) + '</span></span>' +
                    (on ? '<span class="skPopCheck">' + ICON.check + '</span>' : '') + '</div>';
            }).join("");
            var bRpt = scene === "REPORT" || scene === "FIORI";
            return '<div class="skPop">' +
                '<div class="skPopTop"><label class="skSearch">' + ICON.search +
                '<input class="skSearchInput" type="text" placeholder="搜索技能" aria-label="搜索技能" autocomplete="off" value="' + esc(q) + '"/></label>' +
                '<div class="skPopMeta"><span>' + esc(SCENE_TEXT[scene] || "") + ' · ' + items.length + ' 个技能</span><span>↑↓ 选择 · Enter 使用 · Esc 关闭</span></div></div>' +
                (bRpt ? '<div class="skPopNote">' + ICON.info + '<span>报表类场景的执行和取数是固定流程，技能只在「交给模型分析结果」这一步生效</span></div>' : '') +
                '<div class="skPopList" role="listbox" aria-label="技能" style="max-height:' + (this._skillListMax || 320) + 'px">' + rows +
                '<div class="skPopEmpty" hidden="hidden">没有匹配的技能</div></div>' +
                '<div class="skPopFoot"><span>' + ICON.info + '技能只改变做法，不增加工具和权限</span>' +
                (Service.isAdmin() ? '<button type="button" class="skPopManage" data-skill-manage="1">管理技能</button>' : '') +
                '</div></div>';
        },
        /** 弹层渲染后：搜索框过滤只改行的 hidden（不重绘，输入框不丢焦点），点击 / 键盘用事件委托 */
        _bindSkillPop: function () {
            var root = this._skillPopHtml.getDomRef(), that = this;
            if (!root) { return; }
            var input = root.querySelector(".skSearchInput");
            this._skillFilterRows(input ? input.value : "");
            root.onclick = function (ev) {
                if (ev.target.closest("[data-skill-manage]")) { that._skillPopover.close(); that.onOpenSkillManager(); return; }
                var row = ev.target.closest(".skPopRow");
                if (row) { that._pickSkillId(row.getAttribute("data-skill")); }
            };
            if (input) {
                input.oninput = function () { that._skillHi = 0; that._skillFilterRows(input.value); };
                input.onkeydown = function (ev) {
                    if (ev.isComposing || ev.keyCode === 229) { return; }
                    var rows = that._skillVisibleRows();
                    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                        ev.preventDefault();
                        if (rows.length) { that._skillHi = (that._skillHi + (ev.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length; }
                        that._markSkillRow();
                    } else if (ev.key === "Enter") {
                        ev.preventDefault(); ev.stopPropagation();
                        if (rows[that._skillHi]) { that._pickSkillId(rows[that._skillHi].getAttribute("data-skill")); }
                    } else if (ev.key === "Escape") {
                        ev.preventDefault(); that._skillPopover.close();
                    }
                };
            }
        },
        _skillVisibleRows: function () {
            var root = this._skillPopHtml && this._skillPopHtml.getDomRef();
            return root ? Array.prototype.filter.call(root.querySelectorAll(".skPopRow"), function (r) { return !r.hidden; }) : [];
        },
        _skillFilterRows: function (q) {
            var root = this._skillPopHtml && this._skillPopHtml.getDomRef(); if (!root) { return; }
            q = String(q || "").trim().toLowerCase();
            var n = 0;
            Array.prototype.forEach.call(root.querySelectorAll(".skPopRow"), function (r) {
                var hit = !q || r.getAttribute("data-hay").indexOf(q) >= 0;
                r.hidden = !hit; if (hit) { n++; }
            });
            var empty = root.querySelector(".skPopEmpty"); if (empty) { empty.hidden = n > 0; }
            this._markSkillRow();
        },
        _markSkillRow: function () {
            var rows = this._skillVisibleRows(), hi = this._skillHi || 0;
            var root = this._skillPopHtml.getDomRef();
            Array.prototype.forEach.call(root.querySelectorAll(".skPopRow"), function (r) { r.classList.remove("skHi"); });
            if (rows[hi]) { rows[hi].classList.add("skHi"); rows[hi].scrollIntoView({ block: "nearest" }); }
        },
        _focusSkillSearch: function () {
            var root = this._skillPopHtml && this._skillPopHtml.getDomRef();
            var input = root && root.querySelector(".skSearchInput");
            if (input) { input.focus(); var n = input.value.length; input.setSelectionRange(n, n); }
        },
        _pickSkillId: function (id) {
            var s = (this._skillModel().getProperty("/items") || []).filter(function (x) { return x.id === id; })[0];
            if (s) { this._chooseSkill(s); }
        },
        _chooseSkill: function (s) {
            var chat = this.getView().getModel("chat");
            if (chat.getProperty("/busy")) { return; }
            if (this._skillSlash && Skills.slash(chat.getProperty("/input")) !== null) { chat.setProperty("/input", ""); }
            this._skillSelections = this._skillSelections || {};
            this._skillSelections[this._skillActiveKey] = s;
            this._skillModel().setProperty("/selected", s);
            this._skillModel().setProperty("/bodyOpen", false);
            if (this._skillPopover && this._skillPopover.isOpen()) { this._skillPopover.close(); }
            this._paintSkill();
            if (chat.getProperty("/heroVisible")) { this._renderHeroBubbles(); }
            var oInput = this.byId(chat.getProperty("/heroVisible") ? "heroInput" : "msgInput");
            if (oInput) { setTimeout(function () { oInput.focus(); }, 0); }
        },
        onClearSkill: function () {
            var chat = this.getView().getModel("chat");
            if (chat.getProperty("/busy")) { return; }
            this._skillSelections = this._skillSelections || {};
            this._skillSelections[this._skillActiveKey] = null;
            this._skillModel().setProperty("/selected", null);
            this._skillModel().setProperty("/bodyOpen", false);
            this._applyWorkspaceChrome();
        },
        onSkillInputChange: function (e) {
            if (this._wsMode() === "AGENT" && Skills.slash(e.getParameter("value") || "") !== null) {
                this._openSkills(e.getSource(), true);
            }
        },
        _skillSendReady: function () {
            var m = this._skillModel(), s = m.getProperty("/selected");
            if (m.getProperty("/loading") || m.getProperty("/error") || s && s.invalid) {
                MessageToast.show(m.getProperty("/status")); return false;
            }
            return true;
        },
        _skillRequestId: function () {
            var m = this._skillModel(), s = m.getProperty("/selected");
            return m.getProperty("/supported") ? (s ? s.id : "NONE") : "";
        },
        _adoptSkillTask: function () {
            var s = this._skillModel().getProperty("/selected"), key = this._skillKey(this._skillContext());
            this._skillSelections = this._skillSelections || {}; this._skillSelections[key] = s;
            this._skillActiveKey = key;
        },
        /** 首页提示行「查看做法」：就地展开 / 收起做法正文 */
        onViewSkill: function () {
            var m = this._skillModel();
            if (!m.getProperty("/canViewBody")) { return; }
            m.setProperty("/bodyOpen", !m.getProperty("/bodyOpen"));
        },

        /* ---------------- 技能管理（仅 ADMIN） ---------------- */
        onOpenSkillManager: function () {
            if (!Service.isAdmin()) { return; }
            if (!this._skillAdminDialog) {
                this._skillAdminDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.SkillAdmin", this);
                this.getView().addDependent(this._skillAdminDialog);
            }
            this.getView().setModel(new JSONModel({ items: [], view: [], filter: "ALL", q: "", counts: {},
                edit: null, sceneOn: {}, toolOptions: [], toolNote: "", bodyLen: 0, title: "", footNote: "",
                saving: false, error: "" }), "skillAdmin");
            this._skillAdminDialog.open(); this.onRefreshSkillAdmin();
        },
        onRefreshSkillAdmin: function () {
            var that = this, m = this.getView().getModel("skillAdmin");
            m.setProperty("/error", "");
            Service.getSkills({includeInactive: true}).then(function (r) {
                if (!r.supported) { throw new Error("后端尚未部署技能接口"); }
                m.setProperty("/items", r.skills);
                var edit = m.getProperty("/edit");
                if (edit && edit.version) {
                    var fresh = r.skills.filter(function (s) { return s.id === edit.id; })[0];
                    if (fresh) { m.setProperty("/edit", JSON.parse(JSON.stringify(fresh))); }
                } else if (!edit) {
                    if (r.skills.length) { m.setProperty("/edit", JSON.parse(JSON.stringify(r.skills[0]))); } else { that.onNewSkill(); return; }
                }
                that._skAdmDerive();
            }).catch(function (e) { m.setProperty("/error", e.message); });
        },
        /** 由 items / edit 推出：左侧列表、计数、场景胶囊、可勾的工具、字数、页脚说明 */
        _skAdmDerive: function () {
            var m = this.getView().getModel("skillAdmin"); if (!m) { return; }
            var items = m.getProperty("/items") || [], f = m.getProperty("/filter"), q = String(m.getProperty("/q") || "").trim().toLowerCase();
            var edit = m.getProperty("/edit") || {};
            var counts = { ALL: items.length };
            Object.keys(SCENE_TEXT).forEach(function (k) { counts[k] = items.filter(function (s) { return s.scenes.indexOf(k) >= 0; }).length; });
            m.setProperty("/counts", counts);
            m.setProperty("/view", items.filter(function (s) {
                return (f === "ALL" || s.scenes.indexOf(f) >= 0) &&
                    (!q || (s.name + " " + s.id + " " + s.description).toLowerCase().indexOf(q) >= 0);
            }).map(function (s) {
                return { id: s.id, name: s.name, version: s.version, active: s.active, on: s.id === edit.id && !!edit.version,
                    meta: s.scenes.map(function (k) { return SCENE_TEXT[k] || k; }).join(" / ") + " · v" + s.version +
                        (s.visibility === "ADMIN" ? " · 仅管理员" : "") };
            }));
            var scenes = edit.scenes || [], on = {};
            Object.keys(SCENE_TEXT).forEach(function (k) { on[k] = scenes.indexOf(k) >= 0; });
            m.setProperty("/sceneOn", on);
            // 可勾的工具 = 所选每个场景都允许的工具（与 SkillCatalog.validate 同口径）
            var allowed = scenes.length ? scenes.reduce(function (acc, k) {
                return acc.filter(function (t) { return (Skills.sceneTools[k] || []).indexOf(t) >= 0; });
            }, (Skills.sceneTools[scenes[0]] || []).slice()) : [];
            m.setProperty("/toolOptions", allowed.map(function (t) {
                return { key: t, label: Skills.toolLabels[t] || t, on: (edit.tools || []).indexOf(t) >= 0 };
            }));
            m.setProperty("/toolNote", !scenes.length ? "先选适用场景" : !allowed.length ? "报表 / Fiori 结果分析不调用工具"
                : "只列出所选场景都允许的工具；都不勾 = 用场景全部工具");
            m.setProperty("/bodyLen", String(edit.body || "").length);
            m.setProperty("/title", edit.version ? edit.name || edit.id : "新建技能");
            m.setProperty("/footNote", edit.version ? "保存后升为 v" + (edit.version + 1) + "；运行记录保留当时的做法快照"
                : "新技能保存后为 v1");
        },
        onSkillAdmFilter: function (e) {
            this.getView().getModel("skillAdmin").setProperty("/filter", e.getSource().data("scene"));
            this._skAdmDerive();
        },
        onSkillAdmSearch: function (e) {
            this.getView().getModel("skillAdmin").setProperty("/q", e.getParameter("value") || "");
            this._skAdmDerive();
        },
        onSkillAdmPick: function (e) {
            var m = this.getView().getModel("skillAdmin");
            var id = e.getSource().getBindingContext("skillAdmin").getProperty("id");
            var s = (m.getProperty("/items") || []).filter(function (x) { return x.id === id; })[0];
            if (s) { m.setProperty("/edit", JSON.parse(JSON.stringify(s))); m.setProperty("/error", ""); this._skAdmDerive(); }
        },
        onNewSkill: function () {
            var m = this.getView().getModel("skillAdmin"), f = m.getProperty("/filter");
            m.setProperty("/edit", {
                id: "", name: "", description: "", scenes: [SCENE_TEXT[f] ? f : "CODE"], tools: [], body: "", placeholder: "",
                visibility: "PUBLIC", active: true, version: 0, maxRounds: 10 });
            m.setProperty("/error", "");
            this._skAdmDerive();
        },
        onSkillSceneToggle: function (e) {
            var m = this.getView().getModel("skillAdmin"), k = e.getSource().data("scene");
            var scenes = (m.getProperty("/edit/scenes") || []).slice(), i = scenes.indexOf(k);
            if (i >= 0) { scenes.splice(i, 1); } else { scenes.push(k); }
            m.setProperty("/edit/scenes", scenes);
            this._skAdmDerive();
            // 场景变了，勾掉已不在可选范围内的工具
            var keep = (m.getProperty("/toolOptions") || []).filter(function (o) { return o.on; }).map(function (o) { return o.key; });
            m.setProperty("/edit/tools", keep);
        },
        onSkillToolToggle: function () {
            var m = this.getView().getModel("skillAdmin");
            m.setProperty("/edit/tools", (m.getProperty("/toolOptions") || []).filter(function (o) { return o.on; }).map(function (o) { return o.key; }));
        },
        onSkillBodyChange: function (e) {
            this.getView().getModel("skillAdmin").setProperty("/bodyLen", String(e.getParameter("value") || "").length);
        },
        onSaveSkill: function () {
            var that = this, m = this.getView().getModel("skillAdmin");
            if (m.getProperty("/saving")) { return; }
            m.setProperty("/saving", true); m.setProperty("/error", "");
            Service.saveSkill(m.getProperty("/edit")).then(function (s) {
                m.setProperty("/edit", s); that.onRefreshSkillAdmin(); that._syncSkills(true);
                MessageToast.show("已保存为 v" + s.version);
            }).catch(function (e) { m.setProperty("/error", e.message); }).then(function () { m.setProperty("/saving", false); });
        },
        onImportBuiltinSkills: function () {
            var that = this, m = this.getView().getModel("skillAdmin"), rows = m.getProperty("/items") || [];
            if (m.getProperty("/saving")) { return; }
            m.setProperty("/saving", true); m.setProperty("/error", "");
            var add = Skills.builtin.filter(function (s) { return !rows.some(function (r) { return r.id === s.id; }); });
            add.reduce(function (p, s) { return p.then(function () { return Service.saveSkill(Object.assign({}, s, {version: 0})); }); }, Promise.resolve())
                .then(function () { MessageToast.show("已补入 " + add.length + " 个内置技能"); that.onRefreshSkillAdmin(); that._syncSkills(true); })
                .catch(function (e) { m.setProperty("/error", e.message); }).then(function () { m.setProperty("/saving", false); });
        },
        onEvalSkill: function () {
            var s = this.getView().getModel("skillAdmin").getProperty("/edit");
            var saved = (this.getView().getModel("skillAdmin").getProperty("/items") || []).filter(function (r) { return r.id === s.id; })[0];
            if (!saved || !s.active || JSON.stringify(Skills.normalize(saved)) !== JSON.stringify(Skills.normalize(s))) {
                MessageToast.show("请先保存并启用技能，再试跑"); return;
            }
            this._skillAdminDialog.close(); this.onOpenEval();
            this._oEvalModel.setProperty("/skillId", s.id);
            this._oEvalModel.setProperty("/skillLabel", s.name + " v" + s.version);
            this._oEvalModel.setProperty("/skillScenes", s.scenes);
            this._oEvalModel.setProperty("/skillVersion", s.version);
            this._oEvalModel.setProperty("/scene", s.scenes[0]);
        },
        onCloseSkillManager: function () { this._skillAdminDialog.close(); }
    };
});
