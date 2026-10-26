sap.ui.define([], function () {
        "use strict";

        // 已确认的彩色叶翼：控件、欢迎卡片和导出的静态图标共用这份轮廓与配色。
        var iSerial = 0;
        var sViewBox = "0 0 260 268";
        var aParts = [
                {
                        key: "stem", className: "lingxiStem", x1: 15, y1: 200, x2: 160, y2: 160,
                        stops: [[0, "#7563E8"], [0.5, "#508CF0"], [1, "#43C5D6"]],
                        path: "M87 14C101 38 94 58 82 79C74 94 76 127 76 156L76 169C74 190 86 201 108 214L159 234H75C40 234 15 213 15 180V103C15 67 82 65 87 14Z"
                },
                {
                        key: "upper", className: "lingxiUpper", x1: 96, y1: 168, x2: 239, y2: 72,
                        stops: [[0, "#39B5BB"], [0.52, "#63C99D"], [1, "#A9D987"]],
                        path: "M98 158L151 105C178 78 201 72 239 72C215 97 181 124 144 145L102 169C95 173 91 169 98 158Z"
                },
                {
                        key: "lower", className: "lingxiLower", x1: 121, y1: 174, x2: 242, y2: 249,
                        stops: [[0, "#F1AF72"], [0.48, "#EF8D86"], [1, "#DA76A4"]],
                        path: "M120 174C139 164 153 155 169 161C193 170 218 204 240 238C245 246 237 250 225 249C194 246 173 223 148 200L120 174Z"
                }
        ];

        function nextId() { return "lingxi-art-" + (++iSerial); }

        function render(oRm, sPrefix) {
                oRm.openStart("svg").class("lingxiArtwork").attr("xmlns", "http://www.w3.org/2000/svg")
                        .attr("viewBox", sViewBox).attr("focusable", "false").attr("aria-hidden", "true").openEnd();
                oRm.openStart("defs").openEnd();
                aParts.forEach(function (p) {
                        oRm.openStart("linearGradient").attr("id", sPrefix + "-" + p.key)
                                .attr("x1", p.x1).attr("y1", p.y1).attr("x2", p.x2).attr("y2", p.y2)
                                .attr("gradientUnits", "userSpaceOnUse").openEnd();
                        p.stops.forEach(function (s) {
                                oRm.openStart("stop").attr("offset", s[0]).attr("stop-color", s[1]).openEnd().close("stop");
                        });
                        oRm.close("linearGradient");
                });
                oRm.close("defs");
                aParts.forEach(function (p) {
                        oRm.openStart("g").class("lingxiPart").class(p.className).openEnd();
                        oRm.openStart("path").attr("fill", "url(#" + sPrefix + "-" + p.key + ")").attr("d", p.path).openEnd().close("path");
                        oRm.close("g");
                });
                oRm.close("svg");
        }

        // 前缀只接受程序内部的安全标识；不拼接用户输入。
        function svg(sPrefix) {
                sPrefix = sPrefix || nextId();
                if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(sPrefix)) { throw new Error("Invalid artwork prefix"); }
                var s = '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="268" viewBox="' + sViewBox + '" class="lingxiArtwork" role="img" aria-label="灵犀 LingXi"><title>灵犀 LingXi</title><defs>';
                aParts.forEach(function (p) {
                        s += '<linearGradient id="' + sPrefix + "-" + p.key + '" x1="' + p.x1 + '" y1="' + p.y1 + '" x2="' + p.x2 + '" y2="' + p.y2 + '" gradientUnits="userSpaceOnUse">';
                        p.stops.forEach(function (c) { s += '<stop offset="' + c[0] + '" stop-color="' + c[1] + '"/>'; });
                        s += "</linearGradient>";
                });
                s += "</defs>";
                aParts.forEach(function (p) {
                        s += '<g class="lingxiPart ' + p.className + '"><path fill="url(#' + sPrefix + "-" + p.key + ')" d="' + p.path + '"/></g>';
                });
                return s + "</svg>";
        }

        return {
                viewBox: sViewBox,
                parts: aParts,
                nextId: nextId,
                render: render,
                svg: svg,
                createElement: function () {
                        var oTemplate = document.createElement("template");
                        oTemplate.innerHTML = svg();
                        return oTemplate.content.firstElementChild;
                }
        };
});
