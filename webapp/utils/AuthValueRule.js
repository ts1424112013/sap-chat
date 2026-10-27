sap.ui.define([], function () {
    "use strict";

    /* ==========================================================================
     * 权限表字段映射的"生成型"填值（10.27 记录 #02）—— 与 ZCL_AI_AUTH_SERVICE V1.5 同口径
     * - SEQ  递增序号：参数 = 起始值（只填数字，位数 = 补零位数，如 0001）；空 = 从 1 开始、
     *        位数 = 字段长度（最多 10 位）。值 = 该列现有同格式值的最大值 + 1（不小于起始值）
     * - RULE 按规则组合：文字原样 + 占位 {SEQn} {RANDn} {NUMn} {DATE} {TIME} {USER} {TCODE}
     *        {WERKS} {BY}；一条规则最多一个 {SEQn}；NUMC 字段只能出数字
     * 演示后端（AuthMockBackend）用 generate 真正生成；配置页用 check / preview 就地提示。
     * ========================================================================== */
    var FIXED = { DATE: 8, TIME: 6 };
    var NAMED = ["DATE", "TIME", "USER", "TCODE", "WERKS", "BY"];
    var ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    /** 规则串 → [{lit}] / [{tok, n}]；出错返回 {error} */
    function parse(tpl) {
        var parts = [], lit = "", tok = null, seqs = 0, s = String(tpl || "");
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            if (tok === null) {
                if (ch === "{") { if (lit) { parts.push({ lit: lit }); lit = ""; } tok = ""; }
                else if (ch === "}") { return { error: "规则里的花括号没有配对" }; }
                else { lit += ch; }
                continue;
            }
            if (ch === "{") { return { error: "规则里的花括号没有配对" }; }
            if (ch !== "}") { tok += ch; continue; }
            var name = tok.trim().toUpperCase(), m = /^(SEQ|RAND|NUM)(\d{1,2})$/.exec(name);
            tok = null;
            if (m) {
                var n = Number(m[2]);
                if (n < 1 || n > 32 || (m[1] === "SEQ" && n > 20)) { return { error: name + " 的位数不对(序号 1-20 位, 随机 1-32 位)" }; }
                if (m[1] === "SEQ") { seqs++; }
                parts.push({ tok: m[1], n: n });
            } else if (NAMED.indexOf(name) >= 0) {
                parts.push({ tok: name, n: 0 });
            } else {
                return { error: "规则里有不认识的占位 " + name + "(可用 SEQn RANDn NUMn DATE TIME USER TCODE WERKS BY)" };
            }
        }
        if (tok !== null) { return { error: "规则里的花括号没有配对" }; }
        if (lit) { parts.push({ lit: lit }); }
        if (seqs > 1) { return { error: "一条规则里只能有一个递增序号 SEQn" }; }
        return { parts: parts };
    }

    /** SEQ 的位数与起始值（空参数：从 1 开始、位数 = 字段长度，最多 10 位） */
    function seqSpec(f, c) {
        c = String(c || "").trim();
        return c ? { width: c.length, start: Number(c) } : { width: Math.min(f.leng, 10), start: 1 };
    }

    /** 保存前校验，返回错误文字（"" = 通过）；f = { datatype, leng } */
    function check(f, type, c) {
        if (type !== "SEQ" && type !== "RULE") { return ""; }
        if (!/^(CHAR|NUMC)$/.test(f.datatype) || !(f.leng > 0)) { return "递增序号 / 规则组合只支持 CHAR / NUMC 字段"; }
        if (type === "SEQ") {
            c = String(c || "").trim();
            if (!c) { return ""; }
            if (/\D/.test(c)) { return "递增序号的起始值只能填数字(如 0001)"; }
            if (c.length > 20 || c.length > f.leng) { return "起始值位数超过字段长度 " + f.leng + "(最多 20 位)"; }
            return "";
        }
        c = String(c || "").replace(/^\s+/, "");
        if (!c) { return "选了按规则组合, 但没填规则"; }
        if (c.length > 60) { return "规则不能超过 60 个字符"; }
        var p = parse(c);
        if (p.error) { return p.error; }
        var min = 0;
        for (var i = 0; i < p.parts.length; i++) {
            var x = p.parts[i];
            if (!x.tok) {
                min += x.lit.length;
                if (f.datatype === "NUMC" && /\D/.test(x.lit)) { return "NUMC 字段的规则里, 文字部分只能是数字"; }
                continue;
            }
            min += x.n || FIXED[x.tok] || 1;
            if (f.datatype === "NUMC" && ["SEQ", "NUM", "DATE", "TIME"].indexOf(x.tok) < 0) {
                return "NUMC 字段的规则只能用 SEQn / NUMn / DATE / TIME, 不能用 " + x.tok;
            }
        }
        return min > f.leng ? "规则生成的值至少 " + min + " 位, 超过字段长度 " + f.leng : "";
    }

    function randomOf(alphabet, n, rnd) {
        var v = "";
        for (var i = 0; i < n; i++) { v += alphabet.charAt(Math.floor(rnd() * alphabet.length)); }
        return v;
    }
    function reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    /**
     * 生成一个值。ctx = { tcode, user, werks, by, date: "YYYYMMDD", time: "HHMMSS", random?: fn }，
     * existing = 该列已有的值（递增序号用）。返回 { value } 或 { error }
     */
    function generate(f, type, c, ctx, existing) {
        var parts, start = 1, rnd = ctx.random || Math.random;
        if (type === "SEQ") {
            var sp = seqSpec(f, c);
            parts = [{ tok: "SEQ", n: sp.width }]; start = sp.start;
        } else {
            var p = parse(c);
            if (p.error) { return { error: p.error }; }
            parts = p.parts;
        }
        var pre = "", post = "", rePre = "", rePost = "", width = 0, seen = false;
        parts.forEach(function (x) {
            var piece, re;
            switch (x.tok) {
            case "SEQ": seen = true; width = x.n; return;
            case "RAND": piece = randomOf(ALNUM, x.n, rnd); break;
            case "NUM": piece = randomOf("0123456789", x.n, rnd); break;
            case "DATE": piece = ctx.date; break;
            case "TIME": piece = ctx.time; break;
            case "USER": piece = ctx.user || ""; break;
            case "TCODE": piece = ctx.tcode || ""; break;
            case "WERKS": piece = ctx.werks || ""; break;
            case "BY": piece = ctx.by || ""; break;
            default: piece = x.lit;
            }
            // 每次会变的段（随机 / 时间）按位数通配，其余原样 —— 与后端 LIKE 的 _ 通配同口径
            re = x.tok === "RAND" || x.tok === "NUM" || x.tok === "TIME" ? "[\\s\\S]{" + piece.length + "}" : reEscape(piece);
            if (seen) { post += piece; rePost += re; } else { pre += piece; rePre += re; }
        });
        if (!seen) { return { value: pre }; }
        var re = new RegExp("^" + rePre + "([\\s\\S]{" + width + "})" + rePost + "$"), max = null;
        (existing || []).forEach(function (v) {
            var m = re.exec(String(v == null ? "" : v));
            if (m && /^\d+$/.test(m[1]) && (max === null || Number(m[1]) > max)) { max = Number(m[1]); }
        });
        var next = max !== null && max + 1 > start ? max + 1 : start;
        if (String(next).length > width) { return { error: "递增序号已用到 " + width + " 位上限, 请加长位数" }; }
        return { value: pre + ("00000000000000000000" + next).slice(-width) + post };
    }

    /** 配置页预览：用示例值生成第一条（表里还没有同格式值时的样子） */
    function preview(f, type, c) {
        if (check(f, type, c)) { return ""; }
        var d = new Date(), pad = function (n) { return (n < 10 ? "0" : "") + n; };
        var seed = 0.137;
        var r = generate(f, type, c, {
            tcode: "ZDPMM051", user: "F1246311", werks: "1000", by: "ADMIN",
            date: d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()),
            time: pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()),
            random: function () { seed = (seed * 9301 + 0.49297) % 1; return seed; }
        }, []);
        return r.error ? "" : r.value;
    }

    /** 规范写法：占位大写、去掉花括号里的空格（保存时用；解析失败原样返回） */
    function normalize(c) {
        var p = parse(String(c || "").replace(/^\s+/, ""));
        if (p.error) { return String(c || ""); }
        return p.parts.map(function (x) { return x.tok ? "{" + x.tok + (x.n || "") + "}" : x.lit; }).join("");
    }

    /** 主键碰撞时是"生成冲突"（会变的值）还是"已有权限"（固定拼出来的值） */
    function volatile(type, c) {
        return type === "RANDOM" || type === "SEQ" || (type === "RULE" && /\{\s*(SEQ|RAND|NUM)\d|\{\s*TIME\s*\}/i.test(String(c || "")));
    }

    return { parse: parse, check: check, generate: generate, preview: preview, volatile: volatile, seqSpec: seqSpec, normalize: normalize };
});
