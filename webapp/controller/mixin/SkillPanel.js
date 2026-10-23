sap.ui.define([
    "sap/ui/model/json/JSONModel", "sap/m/ResponsivePopover", "sap/m/SearchField", "sap/m/List",
    "sap/m/CustomListItem", "sap/m/VBox", "sap/m/HBox", "sap/m/Text", "sap/m/Button",
    "sap/m/Toolbar", "sap/m/ToolbarSpacer", "sap/m/Dialog", "sap/m/TextArea", "sap/m/MessageToast",
    "zai/chat/service/ChatService", "zai/chat/utils/SkillCatalog"
], function (JSONModel, ResponsivePopover, SearchField, List, CustomListItem, VBox, HBox, Text, Button,
    Toolbar, ToolbarSpacer, Dialog, TextArea, MessageToast, Service, Skills) {
    "use strict";
    return {
        _skillModel: function () {
            var m = this.getView().getModel("skill");
            if (!m) {
                m = new JSONModel({ visible: false, enabled: false, loading: false, supported: false,
                    items: [], selected: null, label: "技能", hint: "", error: "", canPick: false });
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
            m.setProperty("/items", []); m.setProperty("/error", "");
            m.setProperty("/loading", true); m.setProperty("/enabled", false);
            this._paintSkill();
            Service.getSkills(p).then(function (r) {
                if (that._skillLoadToken !== loadToken || that._skillActiveKey !== key || that._wsMode() !== "AGENT") { return; }
                m.setProperty("/supported", r.supported); m.setProperty("/enabled", r.enabled);
                m.setProperty("/items", r.skills); m.setProperty("/loading", false);
                if (!Object.prototype.hasOwnProperty.call(that._skillSelections, key)) {
                    m.setProperty("/selected", r.selectedId ? r.skills.filter(function (s) { return s.id === r.selectedId; })[0] ||
                        {id: r.selectedId, name: "技能已不可用", version: 0, invalid: true} : null);
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
        _paintSkill: function () {
            var m = this._skillModel(), s = m.getProperty("/selected"), scene = this._curScene();
            var hint = m.getProperty("/error") || (m.getProperty("/loading") ? "正在读取技能…" :
                !m.getProperty("/supported") ? "后端尚未部署技能入口" :
                !m.getProperty("/enabled") ? "技能能力尚未启用" :
                scene === "AUTO" || scene === "INVENTORY" ? "先选具体场景，再使用技能" :
                s && s.invalid ? "该技能已停用或不可见，请取消或重新选择" :
                s ? "本任务按「" + s.name + " v" + s.version + "」的做法回答" : "可选择一种做法；输入 / 也能打开技能");
            if (["REPORT", "FIORI"].indexOf(scene) >= 0 && m.getProperty("/enabled")) {
                hint += "；仅分析结果时生效，不改变执行和取数流程";
            }
            m.setProperty("/label", s ? s.name : "技能"); m.setProperty("/hint", hint);
            m.setProperty("/canPick", !m.getProperty("/loading") && m.getProperty("/enabled") && !!Skills.sceneTools[scene]);
            ["skillBtnHero", "skillBtnDock"].forEach(function (id) {
                var b = this.byId(id); if (b) { b.toggleStyleClass("skillSelected", !!s); }
            }, this);
            if (s && !s.invalid && s.placeholder) {
                var chat = this.getView().getModel("chat");
                chat.setProperty("/heroPh", s.placeholder); chat.setProperty("/inputPh", s.placeholder);
            }
        },
        _skillHeroCards: function (box) {
            var m = this._skillModel(), that = this;
            if (!m.getProperty("/enabled") || ["CODE", "DATA"].indexOf(this._curScene()) < 0) { return false; }
            m.getProperty("/items").slice(0, 3).forEach(function (s) {
                box.addItem(new Button({ text: s.name, icon: "sap-icon://learning-assistant", tooltip: s.description,
                    type: "Transparent", press: function () { that._chooseSkill(s); }
                }).addStyleClass("heroChip skillHeroCard"));
            });
            return m.getProperty("/items").length > 0;
        },
        onRefreshSkills: function () { this._syncSkills(true); },
        onOpenSkills: function (e) { this._openSkills(e.getSource(), false); },
        _openSkills: function (anchor, slash) {
            var m = this._skillModel(), that = this;
            if (!m.getProperty("/canPick") || this.getView().getModel("chat").getProperty("/busy")) { return; }
            this._skillSlash = slash;
            if (!this._skillPopover) {
                this._skillSearch = new SearchField({ placeholder: "搜索技能或做法", width: "100%", liveChange: function () { that._fillSkills(); } });
                this._skillList = new List({ mode: "None", noDataText: "没有匹配的技能" }).addStyleClass("skillList");
                var help = new Text({ text: "技能只改变做法，不增加工具和权限" }).addStyleClass("skillFootnote");
                this._skillPopover = new ResponsivePopover({ title: "选择技能", contentWidth: "27rem", placement: "Top",
                    initialFocus: this._skillSearch, content: [new VBox({ items: [this._skillSearch,
                        new Text({text: "报表类技能仅在分析结果时生效", visible: "{= ${chat>/currentSession/agentType} === 'REPORT' || ${chat>/currentSession/agentType} === 'FIORI' }"}).addStyleClass("skillNotice"),
                        this._skillList, help] }).addStyleClass("skillPickerBody")],
                    beginButton: new Button({text: "管理技能", type: "Transparent", visible: Service.isAdmin(),
                        press: function () { that._skillPopover.close(); that.onOpenSkillManager(); }}),
                    endButton: new Button({ text: "关闭", press: function () { that._skillPopover.close(); } }),
                    afterClose: function () { that._skillSlash = false; }
                }).addStyleClass("skillPopover");
                var keyboard = { onkeydown: function (ev) {
                    if (ev.isComposing || ev.keyCode === 229) { return; }
                    var items = that._skillList.getItems();
                    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                        ev.preventDefault(); that._skillHi = ((that._skillHi || 0) + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % (items.length || 1);
                        that._markSkillRow();
                    } else if (ev.key === "Enter") {
                        ev.preventDefault(); ev.stopPropagation(); var row = items[that._skillHi || 0]; if (row) { that._chooseSkill(row.data("skill")); }
                    } else if (ev.key === "Escape") { ev.preventDefault(); that._skillPopover.close(); }
                } };
                this._skillSearch.addEventDelegate(keyboard);
                this._skillList.addEventDelegate(keyboard);
                this.getView().addDependent(this._skillPopover);
            }
            this._skillSearch.setValue(slash ? Skills.slash(this.getView().getModel("chat").getProperty("/input") || "") || "" : "");
            this._fillSkills(); this._skillPopover.openBy(anchor);
        },
        _fillSkills: function () {
            var that = this, rows = Skills.filter(this._skillModel().getProperty("/items"), this._skillSearch.getValue());
            this._skillList.destroyItems(); this._skillHi = 0;
            rows.forEach(function (s) {
                var item = new CustomListItem({ type: "Active", press: function () { that._chooseSkill(s); }, content: [new VBox({items: [
                    new Text({text: s.name + "  v" + s.version + ((that._skillModel().getProperty("/selected") || {}).id === s.id ? "  ✓" : "")}).addStyleClass("skillRowTitle"),
                    new Text({text: s.description}).addStyleClass("skillRowDescription"),
                    new Text({text: s.tools.length ? "工具：" + s.tools.map(function (id) { return Skills.toolLabels[id] || id; }).join(" · ") : "只用已有报表结果"}).addStyleClass("skillRowTools")
                ]})] }).data("skill", s).addStyleClass("skillRow");
                that._skillList.addItem(item);
            });
            this._markSkillRow();
        },
        _markSkillRow: function () {
            this._skillList.getItems().forEach(function (r, i) { r.toggleStyleClass("skillRowFocused", i === this._skillHi); }, this);
        },
        _chooseSkill: function (s) {
            if (this.getView().getModel("chat").getProperty("/busy")) { return; }
            var chat = this.getView().getModel("chat");
            if (this._skillSlash && Skills.slash(chat.getProperty("/input")) !== null) { chat.setProperty("/input", ""); }
            this._skillSelections[this._skillActiveKey] = s;
            this._skillModel().setProperty("/selected", s);
            if (this._skillPopover) { this._skillPopover.close(); }
            this._paintSkill();
        },
        onClearSkill: function () {
            if (this.getView().getModel("chat").getProperty("/busy")) { return; }
            this._skillSelections = this._skillSelections || {};
            this._skillSelections[this._skillActiveKey] = null;
            this._skillModel().setProperty("/selected", null);
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
                MessageToast.show(m.getProperty("/hint")); return false;
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
        onViewSkill: function () {
            var s = this._skillModel().getProperty("/selected"); if (!s || !s.body) { return; }
            var d = new Dialog({title: s.name + " v" + s.version, contentWidth: "36rem",
                content: [new Text({text: s.body, renderWhitespace: true}).addStyleClass("sapUiSmallMargin")],
                endButton: new Button({text: "关闭", press: function () { d.close(); }}), afterClose: function () { d.destroy(); }});
            this.getView().addDependent(d); d.open();
        },
        onOpenSkillManager: function () {
            if (!Service.isAdmin()) { return; }
            if (!this._skillAdminDialog) {
                this._skillAdminDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.SkillAdmin", this);
                this.getView().addDependent(this._skillAdminDialog);
            }
            this.getView().setModel(new JSONModel({items: [], edit: null, saving: false, error: ""}), "skillAdmin");
            this._skillAdminDialog.open(); this.onRefreshSkillAdmin();
        },
        onRefreshSkillAdmin: function () {
            var that = this, m = this.getView().getModel("skillAdmin");
            m.setProperty("/error", "");
            Service.getSkills({includeInactive: true}).then(function (r) {
                if (!r.supported) { throw new Error("后端尚未部署技能接口"); }
                m.setProperty("/items", r.skills);
                if (!m.getProperty("/edit")) { that.onNewSkill(); }
            }).catch(function (e) { m.setProperty("/error", e.message); });
        },
        onNewSkill: function () {
            this.getView().getModel("skillAdmin").setProperty("/edit", {
                id: "", name: "", description: "", scenes: ["CODE"], tools: [], body: "", placeholder: "",
                visibility: "PUBLIC", active: true, version: 0, maxRounds: 10 });
        },
        onEditSkill: function (e) {
            var c = e.getParameter("listItem").getBindingContext("skillAdmin");
            this.getView().getModel("skillAdmin").setProperty("/edit", JSON.parse(JSON.stringify(c.getObject())));
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
