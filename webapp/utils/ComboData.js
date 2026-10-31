sap.ui.define(["zai/chat/utils/ChartRenderer"], function (ChartRenderer) {
        "use strict";

        /**
         * 20261031：组合分析（一期，纯前端）—— 把几份报表结果组合成一张表。
         * 数据集格式与结果卡相同：{name, columns:[{name,label,numeric}], rows:[[...]], total, truncated}
         *  · append  追加：结构相近的表上下拼，最前面加一列「来源」；列按列名（标签）对齐
         *  · join    关联：以第一份为主表，其他表按关联列对上（左连接；可选只保留都对上的行）。
         *            其他表同一关联值有多行时先汇总（数值列求和、文字列取第一个），避免主表行被放大
         *  · side    并排：不合并，各表原样放在一起（没有共同列时只能这样）
         * 不访问网络、不碰 DOM，便于 node 测试。
         */

        var SRC_LABEL = "来源";

        function lab(c, i) {
                return String((c && (c.label || c.name)) || ("列" + (i + 1))).trim();
        }

        function normLabel(s) {
                return String(s || "").replace(/\s+/g, "").toUpperCase();
        }

        /** 关联值归一：去空格；纯数字去前导零（订单号 004541152 与 4541152 视为同一个） */
        function normKey(v) {
                var s = String(v === null || v === undefined ? "" : v).trim();
                return /^\d+$/.test(s) ? (s.replace(/^0+(?=\d)/, "")) : s.toUpperCase();
        }

        function numericCols(oDs) {
                var a = ChartRenderer.analyze(oDs).numeric;
                var m = {};
                a.forEach(function (i) { m[i] = true; });
                return m;
        }

        function anyTruncated(aDs) {
                return aDs.some(function (d) { return !!d.truncated; });
        }

        /** 两表的候选关联列：标签相同、且两边都不是数值列 */
        function suggestKeys(oBase, oOther) {
                var mNumA = numericCols(oBase), mNumB = numericCols(oOther);
                var aOut = [];
                (oBase.columns || []).forEach(function (ca, ia) {
                        if (mNumA[ia]) { return; }
                        (oOther.columns || []).forEach(function (cb, ib) {
                                if (!mNumB[ib] && normLabel(lab(ca, ia)) === normLabel(lab(cb, ib))) {
                                        aOut.push({ a: ia, b: ib });
                                }
                        });
                });
                return aOut;
        }

        function sameShape(aDs) {
                var sig = function (d) {
                        return (d.columns || []).map(function (c, i) { return normLabel(lab(c, i)); }).sort().join("|");
                };
                return aDs.length > 1 && aDs.every(function (d) { return sig(d) === sig(aDs[0]); });
        }

        /** 默认组合方式：结构相同 → 追加；第一份和其他每份都有共同维度列 → 关联；否则并排 */
        function suggestMode(aDs) {
                if (aDs.length < 2) { return "side"; }
                if (sameShape(aDs)) { return "append"; }
                var bJoin = aDs.slice(1).every(function (d) { return suggestKeys(aDs[0], d).length > 0; });
                return bJoin ? "join" : "side";
        }

        function append(aDs, aNames) {
                var aCols = [{ name: "_SRC", label: SRC_LABEL, numeric: false }];
                var mIdx = {};
                aDs.forEach(function (d) {
                        (d.columns || []).forEach(function (c, i) {
                                var k = normLabel(lab(c, i));
                                if (mIdx[k] === undefined) {
                                        mIdx[k] = aCols.length;
                                        aCols.push({ name: c.name || ("C" + aCols.length), label: lab(c, i), numeric: c.numeric === true ? true : undefined });
                                } else if (c.numeric !== true) {
                                        aCols[mIdx[k]].numeric = undefined;
                                }
                        });
                });
                var aRows = [];
                aDs.forEach(function (d, k) {
                        var aMap = (d.columns || []).map(function (c, i) { return mIdx[normLabel(lab(c, i))]; });
                        (d.rows || []).forEach(function (r) {
                                var aRow = aCols.map(function () { return ""; });
                                aRow[0] = aNames[k] || d.name || "";
                                aMap.forEach(function (iTo, iFrom) { aRow[iTo] = r[iFrom] === null || r[iFrom] === undefined ? "" : r[iFrom]; });
                                aRows.push(aRow);
                        });
                });
                return {
                        name: aNames.join(" + "), status: "OK", columns: aCols, rows: aRows,
                        total: aRows.length, truncated: anyTruncated(aDs),
                        note: aDs.length + " 份结果上下拼成 " + aRows.length + " 行，列按列名对齐"
                };
        }

        /**
         * @param {object[]} aDs 数据集（第一份为主表）
         * @param {string[]} aNames 各份名称
         * @param {object[][]} aKeys aKeys[k] = 第 k 份（k ≥ 1）的关联列 [{a: 主表列, b: 该表列}]
         * @param {boolean} bInner 只保留每份都对上的行
         */
        function join(aDs, aNames, aKeys, bInner) {
                var oBase = aDs[0];
                var aCols = (oBase.columns || []).map(function (c, i) {
                        return { name: c.name, label: lab(c, i), numeric: c.numeric === true ? true : undefined };
                });
                var mUsed = {};
                aCols.forEach(function (c) { mUsed[normLabel(c.label)] = true; });
                var aParts = [], aSkip = [], aAgg = [];
                aDs.slice(1).forEach(function (d, j) {
                        var k = j + 1;
                        var aK = (aKeys[k] || []).filter(function (p) {
                                return p && p.a >= 0 && p.b >= 0 && p.a < aCols.length && p.b < (d.columns || []).length;
                        });
                        if (!aK.length) {
                                aSkip.push(aNames[k]);
                                return;
                        }
                        var mKeyB = {};
                        aK.forEach(function (p) { mKeyB[p.b] = true; });
                        var mNum = numericCols(d);
                        var aTake = [];
                        (d.columns || []).forEach(function (c, i) {
                                if (mKeyB[i]) { return; }
                                var sLab = lab(c, i);
                                if (mUsed[normLabel(sLab)]) {
                                        sLab = sLab + "·" + aNames[k];
                                }
                                mUsed[normLabel(sLab)] = true;
                                aTake.push(i);
                                aCols.push({ name: (c.name || "C" + i) + "_" + k, label: sLab, numeric: mNum[i] ? true : undefined });
                        });
                        var mGroup = {}, bMulti = false;
                        (d.rows || []).forEach(function (r) {
                                var sKey = aK.map(function (p) { return normKey(r[p.b]); }).join("\u0001");
                                var g = mGroup[sKey];
                                if (!g) {
                                        g = mGroup[sKey] = { n: 0, vals: aTake.map(function (i) { return mNum[i] ? 0 : ""; }) };
                                }
                                g.n++;
                                if (g.n > 1) { bMulti = true; }
                                aTake.forEach(function (i, t) {
                                        if (mNum[i]) {
                                                var v = ChartRenderer.normNum(r[i]);
                                                g.vals[t] += isNaN(v) ? 0 : v;
                                        } else if (g.vals[t] === "" && r[i] !== null && r[i] !== undefined) {
                                                g.vals[t] = r[i];
                                        }
                                });
                        });
                        if (bMulti) { aAgg.push(aNames[k]); }
                        aParts.push({ keys: aK, take: aTake, group: mGroup, num: mNum });
                });
                var aRows = [], iMatched = 0;
                (oBase.rows || []).forEach(function (r) {
                        var aRow = r.slice(0, (oBase.columns || []).length);
                        var bAll = true;
                        aParts.forEach(function (p) {
                                var g = p.group[p.keys.map(function (q) { return normKey(r[q.a]); }).join("\u0001")];
                                if (!g) { bAll = false; }
                                p.take.forEach(function (i, t) {
                                        var v = g ? g.vals[t] : "";
                                        aRow.push(typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
                                });
                        });
                        if (bAll) { iMatched++; }
                        if (!bInner || bAll) { aRows.push(aRow); }
                });
                var aNote = ["以「" + aNames[0] + "」为主表，" + (oBase.rows || []).length + " 行里有 " + iMatched + " 行在其他表都对上了"];
                if (aAgg.length) { aNote.push(aAgg.join("、") + " 同一关联值有多行，已先汇总（数值求和）"); }
                if (aSkip.length) { aNote.push(aSkip.join("、") + " 没选关联列，未参与"); }
                return {
                        name: aNames.join(" × "), status: "OK", columns: aCols, rows: aRows,
                        total: aRows.length, truncated: anyTruncated(aDs), note: aNote.join("；"),
                        matched: iMatched
                };
        }

        function fmtN(n) {
                return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        }

        /**
         * 20261031（二期方案 §7.1）：单份数据是否只是部分。
         * total > rows → 有确切总数；只有 truncated 标记 → 不知道总数。
         * 报表执行（REPORT_RESULT）页面里只有登记 MAX_ROWS 条样例，措辞单独说"样例"。
         * @returns {null|{rows, total, text}} 完整时为 null
         */
        function truncInfo(oDs, sType) {
                if (!oDs) { return null; }
                var iRows = (oDs.rows || []).length;
                var iTotal = parseInt(oDs.total, 10) || 0;
                if (iTotal > iRows) {
                        return {
                                rows: iRows, total: iTotal,
                                text: sType === "REPORT_RESULT"
                                        ? "只取回 " + fmtN(iRows) + " 行样例（后端共 " + fmtN(iTotal) + " 行）"
                                        : "只取回前 " + fmtN(iRows) + " 行（共 " + fmtN(iTotal) + " 行）"
                        };
                }
                if (oDs.truncated) {
                        return { rows: iRows, total: 0, text: "只取回 " + fmtN(iRows) + " 行，不是全部" };
                }
                return null;
        }

        /**
         * 组合预览上的截断提示：每份被截断的来源一行 + 一行后果说明（按组合方式措辞）。
         * @param {string} sMode append / join / side / single
         * @returns {string[]} 都完整时为空数组
         */
        function truncNotes(aDs, aNames, aTypes, sMode) {
                var aOut = [];
                aDs.forEach(function (d, k) {
                        var o = truncInfo(d, aTypes && aTypes[k]);
                        if (o) { aOut.push("「" + (aNames[k] || d.name || "") + "」" + o.text); }
                });
                if (!aOut.length) { return aOut; }
                aOut.push(sMode === "join"
                        ? "关联和合计都不完整：没对上的行可能只是没取到，合计会偏小。"
                        : (sMode === "append"
                                ? "合计和行数都不完整，只代表已取回的部分。"
                                : "统计和图表只代表已取回的部分。"));
                return aOut;
        }

        /** 并排模式导出：各表依次写进一个 CSV，表与表之间空一行、前面写表名 */
        function sideCsv(aDs, aNames) {
                return aDs.map(function (d, k) {
                        return ChartRenderer.toDelimited({ columns: [{ label: aNames[k] || d.name }], rows: [] }, ",") + "\r\n" +
                                ChartRenderer.toDelimited(d, ",");
                }).join("\r\n\r\n");
        }

        return {
                SRC_LABEL: SRC_LABEL,
                normKey: normKey,
                suggestKeys: suggestKeys,
                suggestMode: suggestMode,
                append: append,
                join: join,
                sideCsv: sideCsv,
                truncInfo: truncInfo,
                truncNotes: truncNotes,
                label: lab
        };
});
