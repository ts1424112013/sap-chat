sap.ui.define([], function () {
        "use strict";

        /**
         * =====================================================================
         * 权限自助申请 —— 演示模式（内存数据，刷新后恢复示例）
         * =====================================================================
         * 语义与 backend-abap/ZCL_AI_AUTH_SERVICE 一一对应（改一边要同步另一边）：
         *   · 返回结构的字段与后端 GenericResult.ResultJson 相同（camelCase）
         *   · 失败时和后端一样让调用方看到 Error(消息)：开关未开 / 角色不够 / 校验不过 / 业务拒绝
         *   · BLOCK 只拦自助申请，IT 批量代加不受限
         *   · 映射只允许 CHAR / NUMC / DATS / TIMS 字段；主键必须有明确映射；工厂映射可选
         *   · 20261022（V1.1）：至少一个 USER 映射；同一种映射可以配给多个字段，写入同一个值
         *   · 开关关闭只拒绝写权限表的操作（申请 / 代加 / 审批 / 撤销）和普通用户查记录，配置照常
         *   · 20261023（V1.2）：事务码规则可带自己的整份字段映射（rmaps，对应 ZAI_AUTH_RMAP）；
         *     命中规则、规则指定了表、且有自己的映射才用，其余沿用权限表映射；审批按当前配置重新选
         * 演示数据：事务码 ZDPMM051 / ZDPMM052 / ZDPMM702(规则 BLOCK) / ZDEMO001 / ZDEMO002 / ZDEMO003 / ZNOTABLE(无权限表)，
         * 工厂 1000 / 2000 / 3000，账号 DEMOUSER / USERA / USERB 可用、LOCKED 已锁定；
         * 可登记的表 ZIDPPP009(已登记) / ZAUTH_TEST(字段名不同) / YAUTH_SINGLE(没有事务码列) /
         * ZAUTH_NOPLANT(没有工厂列) / ZAUTH_TWIN(两列账号 + 两列事务码，同类映射配多个字段) /
         * ZAUTH_WIDE(多一列工厂、多一列账号，演示规则单独映射)。
         * 开关：localStorage zaiChat.cfg.AUTH_ENABLED（没设过 = 开，演示方便；设置里的开关会写它）。
         * 以 Object.assign 并入 ChatService（this 即 ChatService）。
         * =====================================================================
         */

        var TCODES = ["ZDPMM051", "ZDPMM052", "ZDPMM702", "ZDEMO001", "ZDEMO002", "ZDEMO003", "ZNOTABLE"];
        var PLANTS = ["1000", "2000", "3000"];
        var USERS = ["DEMOUSER", "USERA", "USERB"];
        // 20261024：演示用 USER_ADDR（账号 → [姓名, 部门]）；USERB 没有部门、其他账号查不到，演示降级显示
        var ADDR = { DEMOUSER: ["演示用户", "信息技术部"], USERA: ["张三", "生产管理部 · 计划课"], USERB: ["Li Si", ""] };
        var LOCKED = ["LOCKED"];
        var MAP_OK = ["TCODE", "USER", "WERKS", "CONST", "DATE", "TIME", "BY", "INITIAL"];
        var TYPE_OK = ["CHAR", "NUMC", "DATS", "TIMS"];

        function clone(v) { return JSON.parse(JSON.stringify(v)); }
        function fail(s) { throw new Error(s); }
        function now14() {
                var d = new Date();
                var p = function (n) { return (n < 10 ? "0" : "") + n; };
                return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        }
        function split(v) {
                var seen = {};
                return String(v || "").toUpperCase().split(/[,，;；\s]+/).filter(function (x) {
                        if (!x || seen[x]) { return false; }
                        seen[x] = true;
                        return true;
                }).sort();
        }
        function wild(pat, s) {
                return new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(s);
        }
        function fld(name, key, leng, map, type) {
                return { fieldname: name, keyflag: key ? "X" : "", datatype: type || "CHAR", leng: leng, convexit: "", mapType: map || "INITIAL", constVal: "" };
        }

        return {

                _mockAuthState: function () {
                        if (!this._oAuthMock) {
                                var base = [fld("TCODE", true, 20, "TCODE"), fld("FIR_ACCOUNT", true, 12, "USER"), fld("WERKS", true, 4, "WERKS")];
                                this._oAuthMock = {
                                        seq: 0,
                                        requests: [],
                                        rows: { ZIDPPP009: [], ZAUTH_TEST: [], YAUTH_SINGLE: [], ZAUTH_NOPLANT: [], ZAUTH_TWIN: [], ZAUTH_WIDE: [] },
                                        catalog: {
                                                ZIDPPP009: base,
                                                ZAUTH_TEST: [fld("TCD", true, 20), fld("BNAME", true, 12), fld("PLANT", true, 4), fld("ERDAT", false, 8, "DATE", "DATS")],
                                                YAUTH_SINGLE: [fld("UNAME", true, 12), fld("WERKS", true, 4)],
                                                ZAUTH_NOPLANT: [fld("TCODE", true, 20), fld("BNAME", true, 12)],
                                                ZAUTH_TWIN: [fld("TCODE", true, 20), fld("UNAME", true, 12), fld("TCODE_ALT", false, 20), fld("OWNER", false, 12)],
                                                ZAUTH_WIDE: [fld("TCODE", true, 20, "TCODE"), fld("FIR_ACCOUNT", true, 12, "USER"), fld("WERKS", true, 4, "WERKS"), fld("WERKS_TO", false, 4),
                                                        fld("CREATOR", false, 12), fld("ERDAT", false, 8, "DATE", "DATS")]
                                        },
                                        tables: {
                                                ZIDPPP009: { descr: "演示事务码权限表", discover: "X", active: "X",
                                                        fmap: { TCODE: { t: "TCODE", c: "" }, FIR_ACCOUNT: { t: "USER", c: "" }, WERKS: { t: "WERKS", c: "" } } }
                                        },
                                        // 规则自己的字段映射（ZAI_AUTH_RMAP）：{ 规则: { tabname, fmap } }
                                        rmaps: {},
                                        rules: [
                                                { tcodePat: "ZDPMM051", tabname: "ZIDPPP009", ruleMode: "AUTO", allowAll: "", active: "X" },
                                                { tcodePat: "ZDPMM052", tabname: "ZIDPPP009", ruleMode: "AUTO", allowAll: "", active: "X" },
                                                { tcodePat: "ZDPMM702", tabname: "ZIDPPP009", ruleMode: "BLOCK", allowAll: "", active: "X" }
                                        ]
                                };
                        }
                        return this._oAuthMock;
                },

                /** 开关：没设过 = 开 */
                _mockAuthEnabled: function () {
                        var v = null;
                        try { v = window.localStorage.getItem("zaiChat.cfg.AUTH_ENABLED"); } catch (e) { v = null; }
                        return v === null || v === "X";
                },

                /** 入口：action 为 FI 名（AuthSubmit …），p 为 FI 参数；成功 resolve ResultJson 对象，失败 reject Error */
                _mockAuthCall: function (action, p) {
                        var svc = this;
                        return Promise.resolve().then(function () {
                                var admin = action !== "AuthSubmit" && action !== "AuthList";
                                // 开关只挡写权限表的操作和普通用户查记录；配置与 ADMIN 查记录照常（可以先配好再打开）
                                var needOn = ["AuthSubmit", "AuthBatchAdd", "AuthDecide", "AuthRevoke"].indexOf(action) >= 0 ||
                                        (action === "AuthList" && !svc.isAdmin());
                                if (needOn && !svc._mockAuthEnabled()) { fail("权限自助申请尚未启用，请联系 IT"); }
                                var user = svc.getAppUser();
                                if (!user) { fail("当前 SAP 账号未开通 Momo，请联系管理员"); }
                                if (admin && !svc.isAdmin()) { fail("该操作仅管理员可执行"); }
                                var s = svc._mockAuthState();
                                var me = String(user.userId || "").toUpperCase();
                                var snapshot = clone(s);          // 写操作中途失败时整体还原（对应后端 ROLLBACK）
                                var ctx = { s: s, me: me, admin: svc.isAdmin() };
                                try {
                                        switch (action) {
                                        case "AuthSubmit": return svc._mockAuthSubmit(ctx, "SELF", me, p);
                                        case "AuthBatchAdd": return svc._mockAuthSubmit(ctx, "ADMIN", p.Users, p);
                                        case "AuthDecide": return svc._mockAuthDecide(ctx, p);
                                        case "AuthRevoke": return svc._mockAuthRevoke(ctx, p);
                                        case "AuthList": return svc._mockAuthList(ctx, p);
                                        case "AuthTableDescribe": return svc._mockAuthDescribe(ctx, p);
                                        case "AuthTableSave": return svc._mockAuthTableSave(ctx, p);
                                        case "AuthRuleSave": return svc._mockAuthRuleSave(ctx, p);
                                        case "AuthConfig": return svc._mockAuthConfig(ctx);
                                        default: return fail("未知权限接口：" + action);
                                        }
                                } catch (e) {
                                        svc._oAuthMock = snapshot;
                                        throw e;
                                }
                        });
                },

                /* ---------- 校验与查找 ---------- */

                _mockAuthValidRequest: function (tcode, werksList, reason, bPlantsOptional) {
                        if (!/^[A-Z0-9_\/]{1,20}$/.test(tcode)) { fail("事务码格式不合法"); }
                        if (TCODES.indexOf(tcode) < 0) { fail("事务码 " + tcode + " 不存在"); }
                        if (!String(reason || "").trim() || String(reason).length > 255) { fail("申请原因必填，最多 255 字"); }
                        var plants = split(werksList);
                        if (!plants.length && bPlantsOptional) { return plants; }
                        if (!plants.length || plants.length > 50) { fail("工厂数量须为 1 至 50 个"); }
                        plants.forEach(function (w) {
                                if (w.length > 4 || !/^[A-Z0-9]+$/.test(w)) { fail("工厂格式不合法: " + w); }
                                if (w !== "ALL" && PLANTS.indexOf(w) < 0) { fail("工厂 " + w + " 不存在"); }
                        });
                        return plants;
                },

                _mockAuthFields: function (s, name) {
                        if (!/^[ZY][A-Z0-9_]*$/.test(name) || /^ZAI_/.test(name) || name.length > 30 || !s.catalog[name]) {
                                fail("只能登记 Z / Y 开头的透明表, 且不能是 ZAI_* 系统表, 并且表必须存在(演示只有 ZIDPPP009 / ZAUTH_TEST / YAUTH_SINGLE / ZAUTH_NOPLANT / ZAUTH_TWIN / ZAUTH_WIDE)");
                        }
                        return clone(s.catalog[name]);
                },

                _mockAuthLoadTable: function (s, name, needActive) {
                        var fields = this._mockAuthFields(s, name);
                        var t = s.tables[name];
                        if (!t || (needActive && t.active !== "X")) { fail("权限表 " + name + " 未登记或未启用"); }
                        fields.forEach(function (f) {
                                var m = t.fmap[f.fieldname];
                                if (!m) { fail("权限表 " + name + " 的结构已变化(新增字段 " + f.fieldname + ")，请 IT 重新保存该表的配置"); }
                                f.mapType = m.t;
                                f.constVal = m.c;
                        });
                        return { tabname: name, descr: t.descr, discover: t.discover, active: t.active, fields: fields };
                },

                _mockAuthFindRule: function (s, tcode) {
                        var best = null, bestScore = -1;
                        s.rules.forEach(function (r) {
                                if (r.active !== "X" || !wild(r.tcodePat, tcode)) { return; }
                                var score = r.tcodePat.indexOf("*") < 0 ? 1000 : r.tcodePat.replace(/\*/g, "").length;
                                if (score > bestScore) { best = r; bestScore = score; }
                        });
                        return best ? clone(best) : { tcodePat: "", tabname: "", ruleMode: "AUTO", allowAll: "", active: "X" };
                },

                _mockAuthFindTables: function (s, tcode, rule) {
                        var svc = this;
                        if (rule.tabname) { return [svc._mockAuthApplyRuleMap(s, rule.tcodePat, svc._mockAuthLoadTable(s, rule.tabname, true))]; }
                        var out = [];
                        Object.keys(s.tables).sort().forEach(function (name) {
                                var t = s.tables[name];
                                if (t.active !== "X" || t.discover !== "X") { return; }
                                var tab = svc._mockAuthLoadTable(s, name, true);
                                // 20261022（V1.1）：TCODE 映射可以有多列，任一列里有这个事务码就算
                                var cols = tab.fields.filter(function (f) { return f.mapType === "TCODE"; });
                                if (cols.length && s.rows[name].some(function (r) { return cols.some(function (c) { return r[c.fieldname] === tcode; }); })) { out.push(tab); }
                        });
                        if (!out.length) { fail("该事务码尚未配置权限表，请联系 IT"); }
                        return out;
                },

                /** V1.2（apply_rule_map）：规则有自己的映射时整份覆盖；表结构多了映射里没有的字段 → 拒绝 */
                _mockAuthApplyRuleMap: function (s, pat, tab) {
                        var m = pat && s.rmaps[pat];
                        if (!m || m.tabname !== tab.tabname) { return tab; }
                        tab.fields.forEach(function (f) {
                                var x = m.fmap[f.fieldname];
                                if (!x) { fail("规则 " + pat + " 的字段映射缺少字段 " + f.fieldname + "(权限表结构已变化)，请 IT 重新保存该规则"); }
                                f.mapType = x.t;
                                f.constVal = x.c;
                        });
                        return tab;
                },

                /** V1.2（check_fmap）：字段映射校验，权限表与规则共用；needTcode = 至少一个 TCODE */
                _mockAuthCheckFmap: function (s, name, json, needTcode) {
                        var fields = this._mockAuthFields(s, name);
                        var list;
                        try { list = JSON.parse(json || ""); } catch (e) { list = null; }
                        if (!Array.isArray(list)) { fail("字段映射必须是 JSON 数组"); }
                        if (list.length !== fields.length) { fail("必须提交每个字段的映射(MANDT 除外)"); }
                        var fmap = {}, n = { USER: 0, WERKS: 0, TCODE: 0 };
                        list.forEach(function (m) {
                                var f = fields.filter(function (x) { return x.fieldname === m.f; })[0];
                                if (!f) { fail("字段 " + m.f + " 不在表结构里(字段名只能来自 DDIC)"); }
                                if (fmap[m.f]) { fail("字段 " + m.f + " 重复"); }
                                if (MAP_OK.indexOf(m.t) < 0) { fail("字段 " + m.f + " 的映射类型不合法: " + m.t); }
                                if (n[m.t] !== undefined) { n[m.t]++; }
                                var c = String(m.c || "").trim();
                                if (m.t !== "INITIAL" && TYPE_OK.indexOf(f.datatype) < 0) { fail("字段 " + m.f + " 的类型 " + f.datatype + " 不支持写入映射, 只支持 CHAR / NUMC / DATS / TIMS"); }
                                if ((m.t === "DATE" && f.leng < 8) || (m.t === "TIME" && f.leng < 6)) { fail("字段 " + m.f + " 太短, 放不下日期 / 时间"); }
                                if (m.t === "CONST") {
                                        if (!c) { fail("字段 " + m.f + " 选了固定值，但没填值"); }
                                        if (c.length > f.leng || c.length > 60) { fail("字段 " + m.f + " 的固定值过长"); }
                                        if (/^(NUMC|DATS|TIMS)$/.test(f.datatype) && /\D/.test(c)) { fail("字段 " + m.f + " 的固定值必须是数字"); }
                                }
                                if (f.keyflag === "X" && m.t === "INITIAL") { fail("主键字段 " + m.f + " 必须配置映射(留空不允许)"); }
                                fmap[m.f] = { t: m.t, c: m.t === "CONST" ? c : "" };
                        });
                        // 20261022（V1.1）：同类映射可以配到多个字段（写入同一个值），只要求至少有一个 USER
                        if (n.USER < 1) { fail("至少要有一个 USER(目标账号)映射"); }
                        if (needTcode && n.TCODE < 1) { fail("参与自动发现的表必须有 TCODE 映射"); }
                        return fmap;
                },

                /* ---------- 组行 / 查重 / 授权 / 撤销（对应 build_row / row_exists / grant_row / revoke_row） ---------- */

                _mockAuthBuildRow: function (tab, tcode, user, werks) {
                        var row = {};
                        tab.fields.forEach(function (f) {
                                var v;
                                switch (f.mapType) {
                                case "TCODE": v = tcode; break;
                                case "USER": v = user; break;
                                case "WERKS": v = werks; break;
                                case "CONST": v = f.constVal; break;
                                case "DATE": v = now14().substring(0, 8); break;
                                case "TIME": v = now14().substring(8); break;
                                case "BY": v = "DEMO"; break;
                                default: return;
                                }
                                if (String(v).length > f.leng) { fail("字段 " + f.fieldname + " 的值超过长度 " + f.leng + ", 拒绝截断"); }
                                row[f.fieldname] = v;
                        });
                        return row;
                },

                _mockAuthExists: function (s, tab, row) {
                        var cols = tab.fields.filter(function (f) { return f.mapType === "TCODE" || f.mapType === "USER" || f.mapType === "WERKS"; });
                        return s.rows[tab.tabname].some(function (r) {
                                return cols.every(function (f) {
                                        return r[f.fieldname] === row[f.fieldname] || (f.mapType === "WERKS" && r[f.fieldname] === "ALL");
                                });
                        });
                },

                _mockAuthGrant: function (s, tab, row) {
                        var keys = tab.fields.filter(function (f) { return f.keyflag === "X"; });
                        if (!keys.length) { fail("权限表没有主键字段, 拒绝写入"); }
                        var dup = s.rows[tab.tabname].some(function (r) {
                                return keys.every(function (f) { return r[f.fieldname] === row[f.fieldname]; });
                        });
                        if (dup) { return { status: "EXISTS", keyJson: "" }; }
                        s.rows[tab.tabname].push(clone(row));
                        return { status: "DONE", keyJson: JSON.stringify(keys.map(function (f) { return { f: f.fieldname, v: row[f.fieldname] || "" }; })) };
                },

                _mockAuthNew: function (ctx, channel, user, tcode, werks, reason) {
                        var s = ctx.s;
                        return { reqId: "MOCKAUTH" + ("00000000000000000000" + (++s.seq)).slice(-24), requester: ctx.me, targetUser: user, tcode: tcode, werks: werks,
                                tabname: "", channel: channel, status: "", reason: reason || "", message: "", decidedBy: "", createdAt: now14(), decidedAt: "",
                                keyJson: "" };
                },

                _mockAuthLine: function (r) {
                        return { reqId: r.reqId, targetUser: r.targetUser, tcode: r.tcode, werks: r.werks, tabname: r.tabname, status: r.status, message: r.message };
                },

                /* ---------- 申请 / 批量代加 ---------- */

                _mockAuthSubmit: function (ctx, channel, users, p) {
                        var svc = this, s = ctx.s;
                        var tcode = String(p.Tcode || "").trim().toUpperCase();
                        var plants = svc._mockAuthValidRequest(tcode, p.WerksList, p.Reason);
                        var list = channel === "SELF" ? [ctx.me] : split(users);
                        if (!list.length || list.length > 100) { fail("账号数量须为 1 至 100 个"); }
                        var rule = svc._mockAuthFindRule(s, tcode);
                        var lines = [];

                        if (channel === "SELF" && rule.ruleMode === "BLOCK") {
                                plants.forEach(function (w) {
                                        var r = svc._mockAuthNew(ctx, channel, ctx.me, tcode, w, p.Reason);
                                        r.status = "REJECTED"; r.message = "该事务码不允许自助申请，请联系 IT"; r.decidedBy = "AUTO"; r.decidedAt = now14();
                                        s.requests.unshift(r);
                                        lines.push(svc._mockAuthLine(r));
                                });
                                return { lines: lines, summary: "该事务码不允许自助申请，请联系 IT", error: "" };
                        }

                        var tabs = svc._mockAuthFindTables(s, tcode, rule);
                        var n = list.length * plants.length * tabs.length;
                        if (n > 500) { fail("一次最多处理 500 条(账号 × 工厂 × 权限表)，当前 " + n + " 条，请分批"); }

                        list.forEach(function (user) {
                                if (channel === "ADMIN" && USERS.indexOf(user) < 0) {
                                        var bad = svc._mockAuthNew(ctx, channel, user.length <= 12 ? user : "", tcode, "", p.Reason);
                                        bad.status = "FAILED"; bad.message = "SAP 账号不存在、已锁定或已失效: " + user; bad.decidedBy = ctx.me; bad.decidedAt = now14();
                                        s.requests.unshift(bad);
                                        lines.push(svc._mockAuthLine(bad));
                                        return;
                                }
                                tabs.forEach(function (tab) {
                                        if (tab.fields.some(function (f) { return f.mapType === "WERKS"; })) {
                                                plants.forEach(function (w) {
                                                        lines.push(svc._mockAuthOne(ctx, channel, user, tcode, w, p.Reason, rule, tab));
                                                });
                                        } else {
                                                // 这张表不按工厂控制：不论申请了几个工厂只写一行（工厂留空）
                                                lines.push(svc._mockAuthOne(ctx, channel, user, tcode, "", p.Reason, rule, tab));
                                        }
                                });
                        });

                        var c = { DONE: 0, EXISTS: 0, PENDING: 0, BAD: 0 };
                        lines.forEach(function (l) { c[c[l.status] === undefined ? "BAD" : l.status]++; });
                        return { lines: lines, error: "",
                                summary: "共 " + lines.length + " 条: 已开通 " + c.DONE + "，已有 " + c.EXISTS + "，待审批 " + c.PENDING + "，失败或拒绝 " + c.BAD };
                },

                _mockAuthOne: function (ctx, channel, user, tcode, werks, reason, rule, tab) {
                        var svc = this, s = ctx.s;
                        var r = svc._mockAuthNew(ctx, channel, user, tcode, werks, reason);
                        r.tabname = tab.tabname;
                        var row = null, err = "", found = false;
                        try {
                                row = svc._mockAuthBuildRow(tab, tcode, user, werks);
                                found = svc._mockAuthExists(s, tab, row);
                        } catch (e) { err = e.message; }

                        if (err) {
                                r.status = "FAILED"; r.message = err;
                        } else if (found) {
                                r.status = "EXISTS"; r.message = "已有权限，未重复写入";
                        } else if (channel === "SELF" && (rule.ruleMode === "APPROVE" || (werks === "ALL" && rule.allowAll !== "X"))) {
                                var dup = s.requests.filter(function (x) {
                                        return x.status === "PENDING" && x.targetUser === user && x.tcode === tcode && x.werks === werks && x.tabname === tab.tabname;
                                })[0];
                                if (dup) {
                                        return { reqId: dup.reqId, targetUser: user, tcode: tcode, werks: werks, tabname: tab.tabname, status: "PENDING", message: "已有相同的待审批申请，请等待 IT 处理" };
                                }
                                r.status = "PENDING";
                                r.message = werks === "ALL" && rule.ruleMode !== "APPROVE" ? "申请全部工厂(ALL)需要 IT 审批" : "等待 IT 审批";
                        } else {
                                var g = svc._mockAuthGrant(s, tab, row);
                                if (g.status === "EXISTS") { r.status = "EXISTS"; r.message = "相同主键已存在，未重复写入"; }
                                else { r.status = "DONE"; r.keyJson = g.keyJson; r.message = "权限已开通"; }
                        }
                        if (r.status !== "PENDING") { r.decidedBy = channel === "ADMIN" ? ctx.me : "AUTO"; r.decidedAt = now14(); }
                        s.requests.unshift(r);
                        return svc._mockAuthLine(r);
                },

                /* ---------- 审批 / 撤销 ---------- */

                _mockAuthDecide: function (ctx, p) {
                        var svc = this, s = ctx.s;
                        var r = s.requests.filter(function (x) { return x.reqId === p.ReqId; })[0];
                        if (!r) { fail("申请不存在"); }
                        if (r.status !== "PENDING") { fail("只能处理待审批的申请"); }
                        var msg = String(p.Message || "");
                        if (msg.length > 255) { fail("申请编号或处理说明长度不合法"); }
                        if (p.Approve === "X") {
                                if (USERS.indexOf(r.targetUser) < 0 && r.targetUser !== ctx.me) { fail("目标 SAP 账号不存在、已锁定或已失效"); }
                                svc._mockAuthValidRequest(r.tcode, r.werks, r.reason, !r.werks);
                                var tab = svc._mockAuthLoadTable(s, r.tabname, true);
                                // V1.2：按当前配置重新选映射——当前命中的规则指向这张表且有自己的映射时用它
                                var rule = svc._mockAuthFindRule(s, r.tcode);
                                if (rule.tabname === tab.tabname) { svc._mockAuthApplyRuleMap(s, rule.tcodePat, tab); }
                                var row = svc._mockAuthBuildRow(tab, r.tcode, r.targetUser, r.werks);
                                if (svc._mockAuthExists(s, tab, row)) {
                                        r.status = "EXISTS"; r.message = "审批时发现已有权限，未重复写入";
                                } else {
                                        var g = svc._mockAuthGrant(s, tab, row);
                                        r.status = g.status; r.keyJson = g.keyJson;
                                        r.message = g.status === "EXISTS" ? "审批时发现已有权限，未重复写入" : (msg || "已批准并开通");
                                }
                        } else {
                                if (!msg.trim()) { fail("请填写驳回原因"); }
                                r.status = "REJECTED"; r.message = msg;
                        }
                        r.decidedBy = ctx.me; r.decidedAt = now14();
                        return { lines: [svc._mockAuthLine(r)], summary: r.message, error: "" };
                },

                _mockAuthRevoke: function (ctx, p) {
                        var svc = this, s = ctx.s;
                        var r = s.requests.filter(function (x) { return x.reqId === p.ReqId; })[0];
                        if (!r) { fail("申请不存在"); }
                        if (r.status !== "DONE" || !r.keyJson) { fail("只能撤销本系统已开通、且记有原始主键的权限"); }
                        var tab = svc._mockAuthLoadTable(s, r.tabname, false);
                        var keys = JSON.parse(r.keyJson);
                        var keyFields = tab.fields.filter(function (f) { return f.keyflag === "X"; });
                        if (!keyFields.length || keyFields.length !== keys.length ||
                                !keyFields.every(function (f) { return keys.some(function (k) { return k.f === f.fieldname; }); })) {
                                fail("原始主键与当前表结构不一致, 拒绝撤销");
                        }
                        var before = s.rows[tab.tabname].length;
                        s.rows[tab.tabname] = s.rows[tab.tabname].filter(function (row) {
                                return !keys.every(function (k) { return row[k.f] === k.v; });
                        });
                        var removed = s.rows[tab.tabname].length < before;
                        r.status = "REVOKED"; r.decidedBy = ctx.me; r.decidedAt = now14();
                        r.message = !removed ? "权限行已不存在(可能已被手工删除)，记录标为已撤销" : (String(p.Message || "") || "权限已撤销");
                        return { lines: [svc._mockAuthLine(r)], summary: r.message, error: "" };
                },

                /* ---------- 列表 ---------- */

                _mockAuthList: function (ctx, p) {
                        var user = String(p.User || "").trim().toUpperCase(), status = String(p.Status || "").trim().toUpperCase(), tcode = String(p.Tcode || "").trim().toUpperCase();
                        var top = Math.max(1, Math.min(200, parseInt(p.Top, 10) || 50)), skip = Math.max(0, parseInt(p.Skip, 10) || 0);
                        var rows = ctx.s.requests.filter(function (r) {
                                if (!ctx.admin && r.requester !== ctx.me) { return false; }
                                if (ctx.admin && user && r.targetUser !== user) { return false; }
                                if (status && r.status !== status) { return false; }
                                return !tcode || r.tcode === tcode;
                        });
                        return { total: rows.length, error: "", requests: rows.slice(skip, skip + top).map(function (r) {
                                var x = clone(r);
                                x.revocable = r.status === "DONE" && r.keyJson ? "X" : "";
                                var a = ADDR[String(r.targetUser || "").toUpperCase()] || ["", ""];
                                x.targetName = a[0];
                                x.targetDept = a[1];
                                delete x.keyJson;
                                return x;
                        }) };
                },

                /* ---------- 权限表 / 规则 / 配置 ---------- */

                _mockAuthDescribe: function (ctx, p) {
                        var name = String(p.Tabname || "").trim().toUpperCase();
                        var fields = this._mockAuthFields(ctx.s, name);
                        var saved = ctx.s.tables[name];
                        if (saved) {
                                fields.forEach(function (f) {
                                        var m = saved.fmap[f.fieldname];
                                        if (m) { f.mapType = m.t; f.constVal = m.c; }
                                });
                        }
                        return { fields: fields, error: "" };
                },

                _mockAuthTableSave: function (ctx, p) {
                        var s = ctx.s, name = String(p.Tabname || "").trim().toUpperCase();
                        var fmap = this._mockAuthCheckFmap(s, name, p.FmapJson, p.Discover === "X");
                        if (String(p.Descr || "").length > 60) { fail("说明不能超过 60 字"); }
                        s.tables[name] = { descr: String(p.Descr || ""), discover: p.Discover === "X" ? "X" : "", active: p.Active === "X" ? "X" : "", fmap: fmap };
                        return { message: "权限表配置已保存", error: "" };
                },

                _mockAuthRuleSave: function (ctx, p) {
                        var s = ctx.s, pat = String(p.TcodePat || "").trim().toUpperCase(), tab = String(p.Tabname || "").trim().toUpperCase();
                        if (!pat || pat.length > 20 || !/^[A-Z0-9_\/*]+$/.test(pat)) { fail("事务码规则格式不合法(字母、数字、_ / 和通配符 *)"); }
                        if (p.Delete === "X") {
                                s.rules = s.rules.filter(function (r) { return r.tcodePat !== pat; });
                                delete s.rmaps[pat];                  // V1.2：映射随规则一起删
                                return { message: "规则已删除", error: "" };
                        }
                        if (["AUTO", "APPROVE", "BLOCK"].indexOf(p.RuleMode) < 0) { fail("处理方式必须是 AUTO / APPROVE / BLOCK"); }
                        if (tab) { this._mockAuthLoadTable(s, tab, true); }
                        // V1.2：本规则自己的字段映射（整份，约束同权限表但不要求 TCODE）；空 = 沿用权限表映射
                        var json = String(p.FmapJson || "").trim(), fmap = null;
                        if (json) {
                                if (!tab) { fail("规则不指定权限表(走自动发现)时不能单独配字段映射"); }
                                try { fmap = this._mockAuthCheckFmap(s, tab, json, false); } catch (e) { fail("本规则的字段映射: " + e.message); }
                        }
                        if (fmap) { s.rmaps[pat] = { tabname: tab, fmap: fmap }; } else { delete s.rmaps[pat]; }
                        var rule = { tcodePat: pat, tabname: tab, ruleMode: p.RuleMode, allowAll: p.AllowAll === "X" ? "X" : "", active: p.Active === "X" ? "X" : "" };
                        var i = -1;
                        s.rules.forEach(function (r, k) { if (r.tcodePat === pat) { i = k; } });
                        if (i >= 0) { s.rules[i] = rule; } else { s.rules.push(rule); }
                        s.rules.sort(function (a, b) { return a.tcodePat < b.tcodePat ? -1 : 1; });
                        return { message: fmap ? "事务码规则已保存(使用本规则自己的字段映射)" : "事务码规则已保存", error: "" };
                },

                _mockAuthConfig: function (ctx) {
                        var svc = this, s = ctx.s;
                        // V1.2：有自己映射的规则带 ownMap = X 和字段（当前表结构 + 规则映射；结构新增的字段显示建议值）
                        var rules = clone(s.rules).map(function (r) {
                                var m = r.tabname && s.rmaps[r.tcodePat];
                                r.ownMap = "";
                                r.fields = [];
                                if (m && m.tabname === r.tabname) {
                                        r.ownMap = "X";
                                        r.fields = svc._mockAuthFields(s, r.tabname).map(function (f) {
                                                var x = m.fmap[f.fieldname];
                                                if (x) { f.mapType = x.t; f.constVal = x.c; }
                                                return f;
                                        });
                                }
                                return r;
                        });
                        return { error: "", rules: rules, tables: Object.keys(s.tables).sort().map(function (name) {
                                var t = s.tables[name];
                                var fields = svc._mockAuthFields(s, name);
                                fields.forEach(function (f) {
                                        var m = t.fmap[f.fieldname];
                                        if (m) { f.mapType = m.t; f.constVal = m.c; }
                                });
                                return { tabname: name, descr: t.descr, discover: t.discover, active: t.active, fields: fields };
                        }) };
                }
        };
});
