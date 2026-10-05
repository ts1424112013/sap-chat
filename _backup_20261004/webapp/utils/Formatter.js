sap.ui.define([], function () {
        "use strict";

        /**
         * 文本格式化工具集
         * 职责：HTML 转义 + 轻量 Markdown 转 HTML（用于聊天气泡渲染）
         *
         * 安全说明：所有内容在进入 HTML 前【先整体转义】，
         * 之后插入的标签全部由本文件构造，不存在 XSS 注入路径。
         */
        var Formatter = {

                /**
                 * HTML 特殊字符转义
                 * @param {string} sText 原始文本
                 * @returns {string} 转义后的文本
                 */
                escapeHtml: function (sText) {
                        if (sText === undefined || sText === null) {
                                return "";
                        }
                        return String(sText)
                                .replace(/&/g, "&amp;")
                                .replace(/</g, "&lt;")
                                .replace(/>/g, "&gt;")
                                .replace(/"/g, "&quot;")
                                .replace(/'/g, "&#39;");
                },

                /**
                 * 轻量 Markdown 转 HTML
                 * 支持：围栏代码块```、行内代码`x`、粗体、斜体、标题、
                 *       无序/有序列表、引用、链接、图片![alt](url)、
                 *       表格(| a | b | + |---|---| 分隔行)、换行
                 * @param {string} sMarkdown Markdown 文本
                 * @returns {string} HTML 文本
                 */
                markdownToHtml: function (sMarkdown) {
                        var that = this;
                        if (!sMarkdown) {
                                return "";
                        }

                        // 1. 整体转义（关键安全步骤）
                        var sEscaped = this.escapeHtml(sMarkdown);

                        // 2. 按围栏代码块切分：代码块内容保持原样，仅文本段做行内格式化
                        //    正则作用于已转义文本，``` 不含特殊字符，可正常匹配
                        var aSegments = sEscaped.split(/(```[\w-]*\r?\n[\s\S]*?```)/g);
                        var aHtml = [];

                        aSegments.forEach(function (sSeg) {
                                if (!sSeg) {
                                        return;
                                }
                                var mCode = sSeg.match(/^```([\w-]*)\r?\n([\s\S]*?)```$/);
                                if (mCode) {
                                        // 围栏代码块 → 带复制按钮的包裹层 + <pre><code>
                                        //（携带语言标记，供 CSS 角标与 highlight.js 使用；
                                        //  复制按钮为原生元素，事件由控制器在 document 上委托处理）
                                        aHtml.push(
                                                '<div class="codeWrap">' +
                                                '<button type="button" class="codeCopyBtn" title="复制代码">复制</button>' +
                                                "<pre" + (mCode[1] ? ' data-lang="' + mCode[1] + '"' : "") +
                                                "><code" + (mCode[1] ? ' class="language-' + mCode[1] + '"' : "") + ">" +
                                                mCode[2].replace(/\r?\n$/, "") + "</code></pre></div>"
                                        );
                                } else {
                                        aHtml.push(that._formatInline(sSeg));
                                }
                        });

                        return aHtml.join("");
                },

                /**
                 * 文本段行内格式化（代码块之外的 Markdown 元素）
                 * @param {string} sText 已转义的文本段
                 * @returns {string} HTML
                 */
                _formatInline: function (sText) {
                        var that = this;

                        // ---- V10: Markdown 表格（表头行 + |---|---| 分隔行 + 数据行）----
                        // 连续的 | 行先收集，出现合法分隔行即整块转 <table>；
                        // 流式输出期间分隔行未生成前按普通文本渲染（不完整表格不闪断）
                        var aTableBuf = [];

                        function isPipeRow(sLine) {
                                return /^\s*\|.*\|\s*$/.test(sLine);
                        }

                        function isSepRow(sLine) {
                                // 形如 | --- | :---: | 的分隔行：仅含 | - : 与空白，且至少一个 -
                                return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(sLine) &&
                                        sLine.indexOf("-") >= 0 && sLine.indexOf("|") >= 0;
                        }

                        function flushTable() {
                                if (!aTableBuf.length) {
                                        return;
                                }
                                if (aTableBuf.length >= 2 && isSepRow(aTableBuf[1])) {
                                        var fnCells = function (sRow) {
                                                return sRow.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
                                        };
                                        var aHead = fnCells(aTableBuf[0]);
                                        var sHtml = '<div class="mdTableWrap"><table class="mdTable"><thead><tr>';
                                        aHead.forEach(function (sCell) {
                                                sHtml += "<th>" + that._inline(sCell.trim()) + "</th>";
                                        });
                                        sHtml += "</tr></thead><tbody>";
                                        for (var i = 2; i < aTableBuf.length; i++) {
                                                var aCells = fnCells(aTableBuf[i]);
                                                sHtml += "<tr>";
                                                aHead.forEach(function (sUnused, idx) {
                                                        sHtml += "<td>" + that._inline((aCells[idx] || "").trim()) + "</td>";
                                                });
                                                sHtml += "</tr>";
                                        }
                                        sHtml += "</tbody></table></div>";
                                        aOut.push(sHtml);
                                } else {
                                        // 不是合法表格 → 还原为普通段落（竖线转义避免被再次解析）
                                        aTableBuf.forEach(function (sRow) {
                                                aOut.push("<p>" + that._inline(sRow.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").join("&#124;")) + "</p>");
                                        });
                                }
                                aTableBuf = [];
                        }

                        // 按"块"切分：连续行组成段落/列表/引用/表格
                        var aLines = sText.split(/\r?\n/);
                        var aOut = [];
                        var sListType = null; // "ul" | "ol" | null
                        var sQuoteOpen = false;
                        var sParaBuf = [];

                        function flushPara() {
                                if (sParaBuf.length) {
                                        aOut.push("<p>" + sParaBuf.join("<br/>") + "</p>");
                                        sParaBuf = [];
                                }
                        }

                        function closeList() {
                                if (sListType) {
                                        aOut.push("</" + sListType + ">");
                                        sListType = null;
                                }
                        }

                        function closeQuote() {
                                if (sQuoteOpen) {
                                        aOut.push("</blockquote>");
                                        sQuoteOpen = false;
                                }
                        }

                        function flushBlocks() {
                                flushTable();
                                flushPara();
                        }

                        aLines.forEach(function (sLine) {
                                var s = sLine;

                                // 表格行：先收集（表头/分隔/数据行），遇到普通行时整体输出
                                if (isPipeRow(s)) {
                                        flushPara(); closeList(); closeQuote();
                                        aTableBuf.push(s.trim());
                                        return;
                                }
                                flushTable();

                                // 标题 # ~ ######
                                var mHead = s.match(/^(#{1,6})\s+(.*)$/);
                                if (mHead) {
                                        flushPara(); closeList(); closeQuote();
                                        var iLevel = mHead[1].length;
                                        aOut.push("<h" + iLevel + ">" + that._inline(mHead[2]) + "</h" + iLevel + ">");
                                        return;
                                }

                                // 无序列表
                                var mUl = s.match(/^\s*[-*]\s+(.*)$/);
                                if (mUl) {
                                        flushPara(); closeQuote();
                                        if (sListType !== "ul") { closeList(); aOut.push("<ul>"); sListType = "ul"; }
                                        aOut.push("<li>" + that._inline(mUl[1]) + "</li>");
                                        return;
                                }

                                // 有序列表
                                var mOl = s.match(/^\s*\d+[.)]\s+(.*)$/);
                                if (mOl) {
                                        flushPara(); closeQuote();
                                        if (sListType !== "ol") { closeList(); aOut.push("<ol>"); sListType = "ol"; }
                                        aOut.push("<li>" + that._inline(mOl[1]) + "</li>");
                                        return;
                                }

                                // 引用
                                var mQuote = s.match(/^\s*&gt;\s?(.*)$/); // ">" 已被转义为 &gt;
                                if (mQuote) {
                                        flushPara(); closeList();
                                        if (!sQuoteOpen) { aOut.push("<blockquote>"); sQuoteOpen = true; }
                                        aOut.push("<p>" + that._inline(mQuote[1]) + "</p>");
                                        return;
                                }

                                // 空行：段落结束
                                if (!s.trim()) {
                                        flushPara(); closeList(); closeQuote();
                                        return;
                                }

                                // 普通文本行 → 累积为段落
                                closeList(); closeQuote();
                                sParaBuf.push(that._inline(s));
                        });

                        flushTable(); flushPara(); closeList(); closeQuote();
                        return aOut.join("");
                },

                /**
                 * 行内元素：行内代码、粗体、斜体、图片、链接
                 * V10: 支持 ![alt](url) 图片（http/https/data:image 协议白名单），
                 *      必须先于链接规则执行（否则会被当作 [text](url) 吃掉 !）
                 * @param {string} sText 已转义文本
                 * @returns {string} HTML
                 */
                _inline: function (sText) {
                        return sText
                                .replace(/`([^`\n]+)`/g, "<code>$1</code>")
                                .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
                                .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
                                .replace(/!\[([^\]]*)\]\((https?:[^)\s]+|data:image\/[^)\s]+)\)/g, function (sAll, sAlt, sSrc) {
                                        // src/alt 均来自整体转义后的文本，属性内已无裸引号，无 XSS 路径
                                        return '<img class="mdImg" src="' + sSrc + '" alt="' + sAlt + '" loading="lazy"/>';
                                })
                                .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
                },

                /**
                 * 时间格式化：YYYYMMDDHHMMSS → MM-dd HH:mm
                 * @param {string} sTime ABAP 14 位时间戳或空（空则取当前时间）
                 * @returns {string} 展示文本
                 */
                formatTime: function (sTime) {
                        var s = String(sTime || "");
                        if (/^\d{14}$/.test(s)) {
                                return s.substring(4, 6) + "-" + s.substring(6, 8) + " " +
                                        s.substring(8, 10) + ":" + s.substring(10, 12);
                        }
                        var d = new Date();
                        var p = function (n) { return (n < 10 ? "0" : "") + n; };
                        return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
                },

                /* =========================================================
                 * V1.3：数据分析辅助（数值/图表格式化）
                 * 所有输出仅用于 Formatter.escapeHtml 之后的展示路径，
                 * 不产生任何 HTML 标签，无注入面
                 * ========================================================= */

                /**
                 * 安全取数：任意单元格 → 有限数字（用于图表 y 值/占比计算）
                 * @param {*} v 单元格原始值
                 * @returns {number} 非有限值返回 0
                 */
                toNumber: function (v) {
                        if (typeof v === "number") {
                                return isFinite(v) ? v : 0;
                        }
                        var n = parseFloat(String(v === null || v === undefined ? "" : v).replace(/,/g, ""));
                        return isFinite(n) ? n : 0;
                },

                /**
                 * 指标数值格式化：千分位分隔，最多保留 2 位小数（尾零去除）
                 * @param {*} v 数值或数字字符串
                 * @returns {string} 展示文本（如 12,340 / 3.5）
                 */
                formatMetricNumber: function (v) {
                        var n = this.toNumber(v);
                        var aParts = (Math.round(n * 100) / 100).toString().split(".");
                        aParts[0] = aParts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
                        return aParts.join(".");
                },

                /**
                 * 坐标轴"友好上限"：向上取整到 1/2/5×10^k（图表 y 轴刻度）
                 * @param {number} n 数据最大值（非正数返回 1）
                 * @returns {number}
                 */
                niceAxisMax: function (n) {
                        var v = this.toNumber(n);
                        if (v <= 0) {
                                return 1;
                        }
                        var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
                        var d = v / p;
                        var m = d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10;
                        return m * p;
                }
        };

        return Formatter;
});
