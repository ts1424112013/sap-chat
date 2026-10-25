sap.ui.define([
        "zai/chat/control/MomoMark",
        "zai/chat/utils/ToastStack"
], function (MomoMark, ToastStack) {
        "use strict";

        /**
         * 登录欢迎卡片（20261025，替换原 MessageToast「欢迎，xxx」）
         * ---------------------------------------------------------------
         * 对话区底部居中（20261025 按用户意见从顶部挪下来）：Momo 头像（弹入、圆点跳两下、眨眼并看向文字）+ 四周小光点迸出
         * + 问候语（按时段）+ 副标题；卡片带缓慢旋转的品牌渐变描边、一道扫光。
         * 样式 .welcomeToast / .wc*（style-gale.css 末尾），头像动效 .momoMark--greet（style-momo.css）。
         */

        // 光点：终点位移（px，从头像边缘飞出）、大小、颜色、延迟 —— 颜色取 Logo 渐变
        var SPARKS = [
                { dx: -36, dy: -18, s: 5, c: "#9180FF", d: 0.32 },
                { dx: -8, dy: -32, s: 4, c: "#5C9BFF", d: 0.38, star: true },
                { dx: 28, dy: -28, s: 5, c: "#31C9E2", d: 0.34 },
                { dx: 40, dy: 2, s: 5, c: "#75EFC7", d: 0.42 },
                { dx: -38, dy: 14, s: 4, c: "#5C9BFF", d: 0.4 },
                { dx: 14, dy: 36, s: 5, c: "#9180FF", d: 0.36, star: true },
                { dx: -18, dy: 34, s: 4, c: "#31C9E2", d: 0.46 }
        ];

        var oCurrent = null;

        function el(sTag, sClass, sText) {
                var o = document.createElement(sTag);
                o.className = sClass;
                if (sText) { o.textContent = sText; }
                return o;
        }

        return {
                /** 当前时段的问候语 key（i18n） */
                greetingKey: function (oDate) {
                        var h = (oDate || new Date()).getHours();
                        if (h >= 5 && h < 11) { return "welcomeMorning"; }
                        if (h >= 11 && h < 13) { return "welcomeNoon"; }
                        if (h >= 13 && h < 18) { return "welcomeAfternoon"; }
                        if (h >= 18 && h < 23) { return "welcomeEvening"; }
                        return "welcomeLate";
                },

                /**
                 * @param {object} o { title, sub, duration }
                 */
                show: function (o) {
                        if (oCurrent) { ToastStack.dismiss(oCurrent); }
                        var oCard = el("div", "welcomeToast");
                        oCard.setAttribute("role", "status");
                        oCard.setAttribute("aria-live", "polite");

                        var oShine = el("span", "wcShine");
                        var oAvatar = el("span", "wcAvatar");
                        SPARKS.forEach(function (p) {
                                var oSpark = el("i", "wcSpark" + (p.star ? " wcSpark--star" : ""));
                                oSpark.style.setProperty("--dx", p.dx + "px");
                                oSpark.style.setProperty("--dy", p.dy + "px");
                                oSpark.style.setProperty("--s", p.s + "px");
                                oSpark.style.setProperty("--c", p.c);
                                oSpark.style.setProperty("--d", p.d + "s");
                                oAvatar.appendChild(oSpark);
                        });
                        oAvatar.appendChild(MomoMark.createElement("38px", "momoMark--greet"));

                        var oText = el("span", "wcText");
                        oText.appendChild(el("span", "wcTitle", o.title));
                        if (o.sub) { oText.appendChild(el("span", "wcSub", o.sub)); }

                        oCard.appendChild(oShine);
                        oCard.appendChild(oAvatar);
                        oCard.appendChild(oText);

                        var fnHide = function () {
                                ToastStack.dismiss(oCard);
                                if (oCurrent === oCard) { oCurrent = null; }
                        };
                        oCard.addEventListener("click", fnHide);   // 点一下即收起

                        ToastStack.mount(oCard, { edge: "bottom" });
                        ToastStack.autoDismiss(oCard, o.duration || 4200, fnHide);
                        oCurrent = oCard;
                        return { hide: fnHide };
                }
        };
});
