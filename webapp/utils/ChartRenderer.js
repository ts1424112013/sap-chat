sap.ui.define(["zai/chat/utils/Formatter"], function (Formatter) {
        "use strict";

        /**
         * V16：图表渲染器（原生 SVG，无外部依赖）
         * 对话页不再自动画图 —— 数据返回后由用户在图表面板里选择类型与字段。
         * 本模块负责：① 判断数据集能否出图 ② 按用户配置聚合/排序/截断 ③ 输出 SVG。
         * 安全：所有动态文本经 Formatter.escapeHtml，标签全部由本模块构造。
         */
        var esc = function (s) { return Formatter.escapeHtml(s); };
        var fmt = function (n) { return Formatter.formatMetricNumber(n); };
        var f = function (n) { return (Math.round(n * 10) / 10).toString(); };
        var clip = function (s, n) { s = String(s); return s.length > n ? s.substring(0, n) + "…" : s; };

        var TYPES = [
                { key: "bar", short: "柱", text: "柱状图", icon: "sap-icon://vertical-bar-chart" },
                { key: "hbar", short: "条", text: "条形图", icon: "sap-icon://horizontal-bar-chart" },
                { key: "line", short: "线", text: "折线图", icon: "sap-icon://line-chart" },
                { key: "area", short: "面", text: "面积图", icon: "sap-icon://area-chart" },
                { key: "pie", short: "饼", text: "饼图", icon: "sap-icon://pie-chart" },
                { key: "donut", short: "环", text: "环形图", icon: "sap-icon://donut-chart" }
        ];

        var PALETTES = {
                gale: ["#2B6BE6", "#14B8A6", "#F5A524", "#8B5CF6", "#EC4899", "#0EA5E9", "#84CC16", "#F97316"],
                ocean: ["#1D4FBF", "#3B82F6", "#06B6D4", "#60A5FA", "#0E7490", "#93C5FD", "#2DD4BF", "#6366F1"],
                warm: ["#EA580C", "#F5A524", "#DC2626", "#DB2777", "#CA8A04", "#FB923C", "#E11D48", "#A16207"]
        };
        var PALETTE_LIST = [
                { key: "gale", text: "Lynx 多彩" },
                { key: "ocean", text: "海蓝" },
                { key: "warm", text: "暖阳" }
        ];

        /** 单元格 → 数字；兼容千分位、百分号与 ABAP 尾负号（123.45-）。非数字返回 NaN */
        function normNum(v) {
                if (typeof v === "number") {
                        return v;
                }
                var s = String(v === null || v === undefined ? "" : v).trim().replace(/,/g, "").replace(/%$/, "");
                s = s.replace(/^(\d+(?:\.\d+)?)-$/, "-$1");
                return /^[-+]?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
        }

        function colLabel(oDs, i) {
                var c = (oDs.columns || [])[i];
                return (c && (c.label || c.name)) || ("列" + (i + 1));
        }

        /**
         * 数据集画像：哪些列是数值、哪些是维度、能否出图、推荐配置。
         * 后端 DDIC 明确 numeric=false 的列（如工厂/物料编码）不当作指标。
         * @param {object} oDs {columns:[{name,label,numeric}], rows:[[...]]}
         * @returns {object} {chartable, reason, numeric[], dims[], x, y, agg, type}
         */
        function analyze(oDs) {
                var aCols = (oDs && oDs.columns) || [];
                var aRows = (oDs && oDs.rows) || [];
                var aNum = [], aDim = [];
                aCols.forEach(function (c, i) {
                        var iFilled = 0, iNumeric = 0;
                        aRows.forEach(function (r) {
                                var v = r[i];
                                if (v === null || v === undefined || String(v).trim() === "") {
                                        return;
                                }
                                iFilled++;
                                if (!isNaN(normNum(v))) {
                                        iNumeric++;
                                }
                        });
                        var bNum = c.numeric === true ||
                                (c.numeric !== false && iFilled > 0 && iNumeric / iFilled >= 0.8);
                        (bNum ? aNum : aDim).push(i);
                });
                var iX = aDim.length ? aDim[0] : 0;
                var aY = aNum.filter(function (i) { return i !== iX; });
                var oSeen = {}, bDup = false;
                aRows.forEach(function (r) {
                        var k = String(r[iX]);
                        if (oSeen[k]) { bDup = true; }
                        oSeen[k] = true;
                });
                var oOut = { numeric: aNum, dims: aDim, x: iX, y: aY.length ? [aY[0]] : [], agg: "none", type: "bar" };
                if (aRows.length < 2) {
                        oOut.chartable = false;
                        oOut.reason = "数据只有 " + aRows.length + " 行，不足以生成图表";
                        return oOut;
                }
                if (!aY.length && !bDup) {
                        oOut.chartable = false;
                        oOut.reason = "没有可作为指标的数值列";
                        return oOut;
                }
                oOut.chartable = true;
                oOut.agg = !aY.length ? "count" : (bDup ? "sum" : "none");
                var sX0 = String((aRows[0] || [])[iX] || "");
                var bTime = /^\d{4}[-./]?\d{2}([-./]?\d{2})?$/.test(sX0) || /(日期|月份|年|月|DATE|DATUM|ERSDA|BUDAT)/i.test(colLabel(oDs, iX));
                oOut.type = bTime ? "line" : (Object.keys(oSeen).length > 12 ? "hbar" : "bar");
                return oOut;
        }

        /**
         * 按用户配置整理绘图数据：分组聚合 → 排序 → Top N（饼图合并"其他"）
         * @param {object} oDs 数据集
         * @param {object} c {type, x, y[], agg, sort, top}
         * @returns {object} {labels[], series[{name, values[]}], note}
         */
        function prepare(oDs, c) {
                var aRows = (oDs && oDs.rows) || [];
                var bCount = c.agg === "count" || !(c.y && c.y.length);
                var aY = bCount ? [] : c.y.slice(0, 4);
                var bPie = c.type === "pie" || c.type === "donut";
                if (bPie && aY.length > 1) {
                        aY = aY.slice(0, 1);   // 饼图只能表达一个指标
                }
                var aGroups = [];
                var oIdx = {};
                aRows.forEach(function (r, iRow) {
                        var sKey = String(r[c.x] === null || r[c.x] === undefined ? "" : r[c.x]);
                        var g;
                        if (c.agg === "none" && !bCount) {
                                g = { key: sKey, sum: [], n: 0, row: iRow };
                                aGroups.push(g);
                        } else {
                                g = oIdx[sKey];
                                if (!g) {
                                        g = oIdx[sKey] = { key: sKey, sum: [], n: 0 };
                                        aGroups.push(g);
                                }
                        }
                        g.n++;
                        aY.forEach(function (iCol, k) {
                                var v = normNum(r[iCol]);
                                g.sum[k] = (g.sum[k] || 0) + (isNaN(v) ? 0 : v);
                        });
                });
                aGroups.forEach(function (g) {
                        g.vals = bCount ? [g.n] : aY.map(function (_, k) {
                                return c.agg === "avg" ? (g.sum[k] || 0) / g.n : (g.sum[k] || 0);
                        });
                });
                if (c.sort === "desc" || c.sort === "asc") {
                        var iDir = c.sort === "desc" ? -1 : 1;
                        aGroups.sort(function (a, b) { return iDir * (a.vals[0] - b.vals[0]); });
                }
                var iCap = bPie ? 12 : 60;
                var iLimit = Math.min(c.top > 0 ? c.top : iCap, iCap);
                var sNote = "";
                if (aGroups.length > iLimit) {
                        if (bPie) {
                                var aRest = aGroups.slice(iLimit - 1);
                                var fRest = 0;
                                aRest.forEach(function (g) { fRest += g.vals[0]; });
                                aGroups = aGroups.slice(0, iLimit - 1);
                                aGroups.push({ key: "其他", vals: [fRest] });
                                sNote = "其余 " + aRest.length + " 项已合并为\"其他\"";
                        } else {
                                sNote = "共 " + aGroups.length + " 项，仅显示前 " + iLimit + " 项";
                                aGroups = aGroups.slice(0, iLimit);
                        }
                }
                var aNames = bCount ? ["记录数"] : aY.map(function (i) { return colLabel(oDs, i); });
                return {
                        labels: aGroups.map(function (g) { return g.key || "(空)"; }),
                        series: aNames.map(function (sName, k) {
                                return { name: sName, values: aGroups.map(function (g) { return g.vals[k] || 0; }) };
                        }),
                        note: sNote
                };
        }

        /** "友好"刻度上界：1/2/5×10^k；支持负数区间 */
        function niceBounds(aAll) {
                var fMax = Math.max.apply(null, aAll.concat([0]));
                var fMin = Math.min.apply(null, aAll.concat([0]));
                var hi = fMax > 0 ? Formatter.niceAxisMax(fMax) : 0;
                var lo = fMin < 0 ? -Formatter.niceAxisMax(-fMin) : 0;
                if (hi === lo) { hi = 1; }
                return { lo: lo, hi: hi };
        }

        /** 字符串指纹（djb2，36 进制） */
        function hash(sText) {
                var h = 5381;
                for (var i = 0; i < sText.length; i++) {
                        h = ((h << 5) + h + sText.charCodeAt(i)) | 0;
                }
                return (h >>> 0).toString(36) + sText.length.toString(36);
        }

        function svgOpen(W, H) {
                return '<svg class="gcSvg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H +
                        '" role="img" preserveAspectRatio="xMidYMid meet">';
        }

        function legend(aSeries, aColors, W, y) {
                if (aSeries.length < 2) {
                        return "";
                }
                var s = "", x = 56;
                aSeries.forEach(function (o, k) {
                        s += '<rect x="' + x + '" y="' + (y - 9) + '" width="10" height="10" rx="2" fill="' + aColors[k % aColors.length] + '"/>' +
                                '<text x="' + (x + 15) + '" y="' + y + '" class="gcText">' + esc(clip(o.name, 14)) + "</text>";
                        x += 30 + Math.min(o.name.length, 14) * 12;
                });
                return s;
        }

        /**
         * 20261025：图元的悬停数据 —— 类目下标 / 完整类目名 / 系列名 / 格式化数值 / 颜色（/ 占比）。
         * 页面上由 ChartFx 读取：悬停时同类目高亮、其余变淡，并画数值提示卡（替代原生 <title> 的慢提示）
         */
        function hov(j, sLab, sSer, val, sCol, sPct) {
                return ' data-i="' + j + '" data-l="' + esc(sLab) + '" data-s="' + esc(sSer) + '" data-v="' + esc(fmt(val)) +
                        '" data-c="' + sCol + '"' + (sPct ? ' data-p="' + sPct + '"' : "");
        }

        /** 出场动画的依次延迟（ms）：类目越多间隔越短，整体不超过约半秒 */
        function gd(j, n) {
                return ' style="--gd:' + Math.round(j * Math.min(45, 520 / Math.max(n, 1))) + 'ms"';
        }

        /** 每个类目一整列 / 一整行的透明感应区（不用对准细柱子），data-x 给折线的竖向参考线定位 */
        function hit(j, x, y, w, h, fX) {
                return '<rect class="gcHit" data-i="' + j + '"' + (fX !== undefined ? ' data-x="' + f(fX) + '"' : "") +
                        ' x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) + '" fill="transparent"/>';
        }

        /** 柱状 / 折线 / 面积（竖直坐标系，viewBox 640×340） */
        function axisSvg(d, c, aColors) {
                var aSer = d.series, aLab = d.labels, n = aLab.length;
                var bLegend = aSer.length > 1;
                var W = 640, H = 340, L = 58, R = 18, T = bLegend ? 34 : 20, B = 54;
                var pw = W - L - R, ph = H - T - B;
                var aAll = [];
                aSer.forEach(function (o) { aAll = aAll.concat(o.values); });
                var b = niceBounds(aAll);
                var Y = function (v) { return T + ph - (v - b.lo) / (b.hi - b.lo) * ph; };
                var s = svgOpen(W, H) + legend(aSer, aColors, W, 18);
                for (var i = 0; i <= 4; i++) {
                        var v = b.lo + (b.hi - b.lo) * i / 4, gy = Y(v);
                        s += '<line x1="' + L + '" y1="' + f(gy) + '" x2="' + (W - R) + '" y2="' + f(gy) + '" class="gcGrid"/>' +
                                '<text x="' + (L - 8) + '" y="' + f(gy + 4) + '" class="gcText gcR">' + fmt(v) + "</text>";
                }
                var slot = pw / n;
                var cx = function (j) { return L + slot * j + slot / 2; };
                var y0 = Y(0);
                if (c.type === "bar") {
                        var gw = Math.min(slot * 0.68, 26 * aSer.length + 20), bw = gw / aSer.length;
                        aSer.forEach(function (o, k) {
                                var col = aColors[k % aColors.length];
                                o.values.forEach(function (val, j) {
                                        var x = cx(j) - gw / 2 + bw * k, yv = Y(val);
                                        var top = Math.min(yv, y0), h = Math.max(Math.abs(y0 - yv), 1);
                                        s += '<rect class="gcBar ' + (val < 0 ? "gcDn" : "gcUp") + '"' + gd(j, n) + ' x="' + f(x + 1) + '" y="' + f(top) +
                                                '" width="' + f(Math.max(bw - 2, 2)) + '" height="' + f(h) + '" rx="3" fill="' + col + '"' + hov(j, aLab[j], o.name, val, col) + "/>";
                                        if (c.showValues && n * aSer.length <= 24) {
                                                s += '<text x="' + f(x + bw / 2) + '" y="' + f(top - 6) + '" class="gcText gcC gcVal" data-i="' + j + '"' + gd(j, n) + ">" + fmt(val) + "</text>";
                                        }
                                });
                        });
                        for (var jb = 0; jb < n; jb++) {
                                s += hit(jb, L + slot * jb, T, slot, ph);
                        }
                } else {
                        // 竖向参考线：悬停某个类目时移到该列（默认透明；内联 opacity 让下载的 SVG 也不显示）
                        s += '<line class="gcGuide" x1="0" y1="' + T + '" x2="0" y2="' + f(T + ph) + '" opacity="0"/>';
                        aSer.forEach(function (o, k) {
                                var col = aColors[k % aColors.length];
                                var aPt = o.values.map(function (val, j) { return f(cx(j)) + "," + f(Y(val)); });
                                if (c.type === "area") {
                                        s += '<polygon class="gcArea" points="' + f(cx(0)) + "," + f(y0) + " " + aPt.join(" ") + " " + f(cx(n - 1)) + "," + f(y0) +
                                                '" fill="' + col + '" fill-opacity="' + (aSer.length > 1 ? 0.14 : 0.2) + '"/>';
                                }
                                // path + pathLength=1：出场时按比例"画"出来（polyline 的 pathLength 支持不一）
                                s += '<path class="gcLine" pathLength="1" d="M ' + aPt.join(" L ") + '" fill="none" stroke="' + col +
                                        '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
                                o.values.forEach(function (val, j) {
                                        s += '<circle cx="' + f(cx(j)) + '" cy="' + f(Y(val)) + '" r="' + (n > 30 ? 2 : 3.4) + '" fill="' + col + '" class="gcDot"' +
                                                gd(j, n) + hov(j, aLab[j], o.name, val, col) + "/>";
                                        if (c.showValues && n <= 16 && aSer.length === 1) {
                                                // 低谷点（比两侧都低）标签放到点下方，免得压在两段折线的交汇处；下方贴近 X 轴时仍放上方
                                                var vPrev = j > 0 ? o.values[j - 1] : null, vNext = j < n - 1 ? o.values[j + 1] : null;
                                                var bValley = (vPrev !== null || vNext !== null) && (vPrev === null || vPrev > val) && (vNext === null || vNext > val);
                                                var yLab = bValley && Y(val) + 17 <= y0 - 3 ? Y(val) + 17 : Y(val) - 9;
                                                s += '<text x="' + f(cx(j)) + '" y="' + f(yLab) + '" class="gcText gcC gcVal" data-i="' + j + '"' + gd(j, n) + ">" + fmt(val) + "</text>";
                                        }
                                });
                        });
                        for (var jl = 0; jl < n; jl++) {
                                s += hit(jl, L + slot * jl, T, slot, ph, cx(jl));
                        }
                }
                s += '<line x1="' + L + '" y1="' + f(y0) + '" x2="' + (W - R) + '" y2="' + f(y0) + '" class="gcAxis"/>';
                var iStep = Math.ceil(n / 12);
                for (var m = 0; m < n; m += iStep) {
                        s += '<text x="' + f(cx(m)) + '" y="' + (T + ph + 20) + '" class="gcText gcC"><title>' + esc(aLab[m]) + "</title>" +
                                esc(clip(aLab[m], n > 8 ? 8 : 12)) + "</text>";
                }
                return s + "</svg>";
        }

        /** 条形图（水平，适合类目多/名称长；高度随行数增长） */
        function hbarSvg(d, c, aColors) {
                var aSer = d.series, aLab = d.labels, n = aLab.length;
                var bLegend = aSer.length > 1;
                var rowH = Math.max(18, 12 * aSer.length + 10), L = 132, R = 56, T = bLegend ? 34 : 14, B = 28;
                var W = 640, H = T + B + rowH * n, pw = W - L - R;
                var aAll = [];
                aSer.forEach(function (o) { aAll = aAll.concat(o.values); });
                var b = niceBounds(aAll);
                var X = function (v) { return L + (v - b.lo) / (b.hi - b.lo) * pw; };
                var s = svgOpen(W, H) + legend(aSer, aColors, W, 18);
                for (var i = 0; i <= 4; i++) {
                        var v = b.lo + (b.hi - b.lo) * i / 4, gx = X(v);
                        s += '<line x1="' + f(gx) + '" y1="' + T + '" x2="' + f(gx) + '" y2="' + (H - B) + '" class="gcGrid"/>' +
                                '<text x="' + f(gx) + '" y="' + (H - B + 18) + '" class="gcText gcC">' + fmt(v) + "</text>";
                }
                var x0 = X(0), bh = (rowH - 6) / aSer.length;
                aLab.forEach(function (sLab, j) {
                        var yRow = T + rowH * j;
                        s += '<text x="' + (L - 8) + '" y="' + f(yRow + rowH / 2 + 4) + '" class="gcText gcR"><title>' + esc(sLab) + "</title>" + esc(clip(sLab, 10)) + "</text>";
                        aSer.forEach(function (o, k) {
                                var val = o.values[j], xv = X(val), y = yRow + 3 + bh * k, col = aColors[k % aColors.length];
                                s += '<rect class="gcBar ' + (val < 0 ? "gcLt" : "gcRt") + '"' + gd(j, n) + ' x="' + f(Math.min(x0, xv)) + '" y="' + f(y) +
                                        '" width="' + f(Math.max(Math.abs(xv - x0), 1)) + '" height="' + f(Math.max(bh - 2, 2)) + '" rx="3" fill="' + col + '"' +
                                        hov(j, sLab, o.name, val, col) + "/>";
                                if (c.showValues) {
                                        s += '<text x="' + f(Math.max(x0, xv) + 6) + '" y="' + f(y + bh / 2 + 2) + '" class="gcText gcVal" data-i="' + j + '"' + gd(j, n) + ">" + fmt(val) + "</text>";
                                }
                        });
                });
                aLab.forEach(function (_, j) {
                        s += hit(j, 0, T + rowH * j, W, rowH);   // 整行（含左侧类目名）都能触发
                });
                return s + "</svg>";
        }

        /** 饼图 / 环形图（右侧图例：名称 + 数值 + 占比） */
        function pieSvg(d, c, aColors) {
                var aVal = d.series[0].values.map(function (v) { return Math.max(v, 0); });
                var fTotal = aVal.reduce(function (a, v) { return a + v; }, 0);
                if (fTotal <= 0) {
                        return "";
                }
                var W = 640, H = 300, cx = 160, cy = 150, r = 116, ri = c.type === "donut" ? 66 : 0;
                var s = svgOpen(W, H), a0 = -Math.PI / 2;
                var pt = function (rad, a) { return f(cx + rad * Math.cos(a)) + " " + f(cy + rad * Math.sin(a)); };
                var sSer = d.series[0].name;
                // 20261025：扇区包一层 <g class="gcPie">，出场时整体旋开；悬停的扇区沿角平分线外移（--px/--py）
                s += '<g class="gcPie" style="transform-origin:' + cx + "px " + cy + 'px">';
                aVal.forEach(function (v, j) {
                        if (v <= 0) { return; }
                        var sweep = v / fTotal * Math.PI * 2, a1 = a0 + sweep, lg = sweep > Math.PI ? 1 : 0, am = a0 + sweep / 2;
                        var col = aColors[j % aColors.length], sPct = String(Math.round(v / fTotal * 100));
                        var sAttr = ' class="gcSlice" style="--px:' + f(Math.cos(am) * 7) + "px;--py:" + f(Math.sin(am) * 7) + 'px"' + hov(j, d.labels[j], sSer, v, col, sPct);
                        if (sweep >= Math.PI * 2 - 1e-6) {
                                s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + col + '"' + hov(j, d.labels[j], sSer, v, col, sPct) + ' class="gcSlice"/>';
                        } else if (ri) {
                                s += '<path d="M ' + pt(r, a0) + " A " + r + " " + r + " 0 " + lg + " 1 " + pt(r, a1) +
                                        " L " + pt(ri, a1) + " A " + ri + " " + ri + " 0 " + lg + " 0 " + pt(ri, a0) + ' Z" fill="' + col + '"' + sAttr + "/>";
                        } else {
                                s += '<path d="M ' + cx + " " + cy + " L " + pt(r, a0) + " A " + r + " " + r + " 0 " + lg + " 1 " + pt(r, a1) +
                                        ' Z" fill="' + col + '"' + sAttr + "/>";
                        }
                        a0 = a1;
                });
                s += "</g>";
                if (ri) {
                        s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ri + '" class="gcHole"/>' +
                                '<text x="' + cx + '" y="' + (cy - 4) + '" class="gcText gcC gcTotal">' + fmt(fTotal) + "</text>" +
                                '<text x="' + cx + '" y="' + (cy + 16) + '" class="gcText gcC gcTotalLab">合计</text>';
                }
                var iRows = Math.min(d.labels.length, 12), ly = cy - iRows * 22 / 2 + 12;
                for (var k = 0; k < iRows; k++) {
                        // 图例行也能悬停（同一个 data-i），行尾透明感应区盖住整行
                        s += '<g class="gcLegRow" data-i="' + k + '">' +
                                '<rect x="330" y="' + f(ly - 10) + '" width="11" height="11" rx="3" fill="' + aColors[k % aColors.length] + '"/>' +
                                '<text x="350" y="' + f(ly) + '" class="gcText"><title>' + esc(d.labels[k]) + "</title>" + esc(clip(d.labels[k], 14)) + "</text>" +
                                '<text x="624" y="' + f(ly) + '" class="gcText gcR">' + fmt(aVal[k]) + " · " + Math.round(aVal[k] / fTotal * 100) + "%</text>" +
                                '<rect class="gcHit" data-i="' + k + '" x="324" y="' + f(ly - 15) + '" width="306" height="22" fill="transparent"/></g>';
                        ly += 22;
                }
                return s + "</svg>";
        }

        /**
         * 按配置渲染完整 SVG；无可绘数据返回空串（调用方展示说明）
         * @param {object} oDs 数据集
         * @param {object} c 图表配置 {type,x,y[],agg,sort,top,showValues,palette}
         * @returns {{svg:string, note:string}}
         */
        function render(oDs, c) {
                var d = prepare(oDs, c);
                if (!d.labels.length) {
                        return { svg: "", note: "当前配置下没有可绘制的数据" };
                }
                var aColors = PALETTES[c.palette] || PALETTES.gale;
                var sSvg = c.type === "hbar" ? hbarSvg(d, c, aColors)
                        : (c.type === "pie" || c.type === "donut") ? pieSvg(d, c, aColors)
                        : axisSvg(d, c, aColors);
                // 20261025：内容指纹 —— 同一张图（同数据 + 同配置）只在第一次出现时播出场动画（ChartFx）
                if (sSvg) {
                        sSvg = sSvg.replace(/^<svg /, '<svg data-k="' + hash(sSvg) + '" ');
                }
                return { svg: sSvg, note: sSvg ? d.note : "数值全部为 0 或负数，无法绘制占比图" };
        }

        /** 下载用独立 SVG：内联样式（脱离页面 CSS 也能正确显示） */
        function standalone(sSvg) {
                var sStyle = "<style>.gcText{font:11px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;fill:#475569}" +
                        ".gcR{text-anchor:end}.gcC{text-anchor:middle}.gcVal{fill:#1e293b;font-weight:600}" +
                        ".gcTotal{font-size:18px;font-weight:700;fill:#0f172a}.gcGrid{stroke:#e2e8f0}.gcAxis{stroke:#cbd5e1}.gcHole{fill:#fff}</style>";
                return sSvg.replace(/^<svg([^>]*)>/, '<svg$1><rect width="100%" height="100%" fill="#ffffff"/>' + sStyle);
        }

        /** 页面 Markdown 表格 → 数据集（用户点"生成图表"时按 DOM 读取） */
        function fromTable(oTable) {
                if (!oTable) {
                        return null;
                }
                var aHead = Array.prototype.map.call(oTable.querySelectorAll("thead th"), function (th) {
                        return (th.textContent || "").trim();
                });
                var aRows = Array.prototype.map.call(oTable.querySelectorAll("tbody tr"), function (tr) {
                        return Array.prototype.map.call(tr.children, function (td) { return (td.textContent || "").trim(); });
                });
                return {
                        name: aHead.slice(0, 2).join(" / ") || "表格数据",
                        columns: aHead.map(function (h, i) { return { name: "C" + i, label: h || ("列" + (i + 1)) }; }),
                        rows: aRows
                };
        }

        /** 数据集 → 分隔文本（CSV 用逗号且加引号转义；复制用制表符，可直接粘贴 Excel） */
        function toDelimited(oDs, sSep) {
                var q = function (v) {
                        var s = v === null || v === undefined ? "" : String(v);
                        return sSep === "," && /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s.replace(/[\t\r\n]+/g, " ");
                };
                var aLines = [(oDs.columns || []).map(function (c, i) { return q(colLabel(oDs, i)); }).join(sSep)];
                (oDs.rows || []).forEach(function (r) {
                        aLines.push((oDs.columns || []).map(function (_, i) { return q(r[i]); }).join(sSep));
                });
                return aLines.join(sSep === "," ? "\r\n" : "\n");
        }

        return {
                TYPES: TYPES,
                PALETTES: PALETTE_LIST,
                analyze: analyze,
                prepare: prepare,
                render: render,
                standalone: standalone,
                fromTable: fromTable,
                toDelimited: toDelimited,
                colLabel: colLabel,
                typeText: function (sKey) {
                        var o = TYPES.filter(function (t) { return t.key === sKey; })[0];
                        return o ? o.text : sKey;
                }
        };
});
