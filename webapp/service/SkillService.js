sap.ui.define(["zai/chat/utils/SkillCatalog"], function (Skills) {
    "use strict";
    function read(key, fallback) {
        try { return JSON.parse(window.localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
    }
    function write(key, value) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private browsing */ } }
    return {
        _skillOwner: function () { return String((this.getAppUser() || {}).userId || "anonymous").toUpperCase(); },
        _skillContextKey: function (p) { return "zaiChat.skill." + this._skillOwner() + "." + p.sessionId + "." + (p.taskId || ""); },
        _skillRows: function () { return read("zaiChat.skillCatalog.v1", Skills.builtin).map(Skills.normalize); },
        /** 演示模式的技能总开关：没设过 = 开（演示方便）；关 = 存 "OFF"（存空串会被当成没设过） */
        _mockSkillEnabled: function () {
            var v = null;
            try { v = window.localStorage.getItem("zaiChat.cfg.SKILL_ENABLED"); } catch (e) { v = null; }
            return v === null || v === "X";
        },
        /** 技能总开关（ZAI_CHAT_CFG.SKILL_ENABLED）：关时聊天里不能选技能，管理照常 */
        getSkillEnabled: function () {
            if (this._sConfig.mode === "mock") { return Promise.resolve(this._mockSkillEnabled()); }
            return this.getConfigValue("SKILL_ENABLED").then(function (v) { return v === "X"; });
        },
        setSkillEnabled: function (bOn) {
            if (!this.isAdmin()) { return Promise.reject(new Error("只有管理员可以开关技能入口")); }
            if (this._sConfig.mode === "mock") {
                try { window.localStorage.setItem("zaiChat.cfg.SKILL_ENABLED", bOn ? "X" : "OFF"); } catch (e) { /* private browsing */ }
                return Promise.resolve(bOn);
            }
            return this.saveConfigValue("SKILL_ENABLED", bOn ? "X" : "").then(function () { return bOn; });
        },
        getSkills: function (p) {
            p = p || {};
            var that = this;
            if (this._sConfig.mode === "mock") {
                if (p.includeInactive && !this.isAdmin()) { return Promise.reject(new Error("只有管理员可以维护技能")); }
                // 与后端同口径：开关关着时聊天入口拿不到技能，管理（includeInactive）照常列出
                var on = this._mockSkillEnabled();
                var rows = !on && !p.includeInactive ? [] : this._skillRows().filter(function (s) {
                    return p.includeInactive || Skills.available(s, p.scene, that.isAdmin());
                });
                return Promise.resolve({ supported: true, enabled: on, skills: rows,
                    selectedId: read(this._skillContextKey(p), "") });
            }
            var model = this._getModel();
            return Promise.resolve(model.metadataLoaded ? model.metadataLoaded() : null).then(function () {
                if (!that._fiHasParam("AnalyzeTask", "SkillId") || !that._fiHasParam("SkillList", "Scene")) {
                    return { supported: false, enabled: false, skills: [], selectedId: "" };
                }
                that._taskApiAvailable = true;
                return that._taskCall("SkillList", { Scene: p.scene || "", SessionId: p.sessionId || "",
                    TaskId: p.taskId || "", IncludeInactive: p.includeInactive ? "X" : "" }, false).then(function (r) {
                    if (!r.success) { throw new Error(r.message || "技能目录读取失败"); }
                    var data = r.result || {};
                    return { supported: true, enabled: data.enabled === true || data.enabled === "X",
                        skills: (data.skills || []).map(Skills.normalize), selectedId: data.selectedId || "", uses: data.uses || [] };
                });
            });
        },
        _skillHistory: function (sessionId, rows) {
            return this.getSkills({sessionId: sessionId}).then(function (r) {
                var tags = Object.create(null);
                (r.uses || []).forEach(function (u) {
                    tags[String(u.userSeq)] = tags[String(Number(u.userSeq) + 1)] = "技能：" + u.name + " v" + u.version;
                });
                return rows.map(function (row) { return Object.assign({}, row, {SkillMeta: tags[String(Number(row.MsgSeq))] || ""}); });
            }).catch(function () { return rows; });
        },
        saveSkill: function (value) {
            if (!this.isAdmin()) { return Promise.reject(new Error("只有管理员可以维护技能")); }
            var skill;
            try { skill = Skills.validate(value); } catch (e) { return Promise.reject(e); }
            if (this._sConfig.mode === "mock") {
                var rows = this._skillRows(), old = rows.filter(function (s) { return s.id === skill.id; })[0];
                if ((old ? old.version : 0) !== skill.version) { return Promise.reject(new Error("版本已变化，请刷新后再保存")); }
                skill.version += 1;
                rows = rows.filter(function (s) { return s.id !== skill.id; }); rows.push(skill);
                write("zaiChat.skillCatalog.v1", rows);
                return Promise.resolve(skill);
            }
            var that = this;
            var wire = Object.assign({}, skill, { scenes: skill.scenes.join(","), tools: skill.tools.join(",") });
            return this._prepareQuestion(JSON.stringify(wire)).then(function (payload) {
                return that._taskCall("SkillSave", { Payload: payload }, true);
            }).then(function (r) {
                if (!r.success) { throw new Error(r.message || "技能保存失败"); }
                return Skills.normalize(r.result || {});
            });
        },
        _mockSendSkillTask: function (p) {
            var id = p.skillId == null || p.skillId === "" ? read(this._skillContextKey(p), "") : p.skillId;
            var that = this, skill = null;
            var known = this._mockStore().sessions.filter(function (s) { return s.SessionId === p.sessionId; })[0];
            var scene = String(known && known.AgentType || p.scene || "").toUpperCase();
            if (id && id !== "NONE") {
                if (!this._mockSkillEnabled()) { return Promise.reject(new Error("技能能力尚未启用，请取消技能后重试")); }
                skill = this._skillRows().filter(function (s) { return s.id === id; })[0];
                if (!skill || !Skills.available(skill, scene, this.isAdmin())) {
                    return Promise.reject(new Error("技能已停用、不可见或不适用于当前场景，请重新选择"));
                }
            }
            write(this._skillContextKey(p), skill ? skill.id : "");
            return this._mockSendAgent(p).then(function (r) {
                if (!skill) { return r; }
                // This is a UI demo. Do not invent a skill evaluation or SAP execution.
                r.trace = r.trace || [];
                r.trace.unshift({ phase: "SKILL", label: "使用技能：" + skill.name + " v" + skill.version + "（演示）", status: "OK", elapsedMs: 0 });
                r.skillId = skill.id; r.skillName = skill.name; r.skillVersion = skill.version;
                var store = that._mockStore(), history = store.messages[p.sessionId] || [];
                history.slice(-2).forEach(function (row) { row.SkillMeta = "技能：" + skill.name + " v" + skill.version; });
                that._mockSave(store);
                if (r.taskId) { write(that._skillContextKey(Object.assign({}, p, {taskId: r.taskId})), skill.id); }
                return r;
            });
        }
    };
});
