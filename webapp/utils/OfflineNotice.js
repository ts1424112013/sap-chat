sap.ui.define([
        "zai/chat/utils/ToastStack"
], function (ToastStack) {
        "use strict";

        /**
         * 后端不可达 → 降级演示模式的提示（20261025，替换原 MessageToast）
         * ---------------------------------------------------------------
         * 两种形态，同一套样式（.offNotice*，style-gale.css 末尾）：
         *   show(o)          已登录：屏幕顶部居中的浮动卡片（放在 ToastStack 最上面），
         *                    默认 10 秒后自动收起，鼠标悬停暂停计时（底部进度条同步暂停）
         *   createInline(o)  未登录：嵌进登录卡片的提示条，附本地管理员账号
         * 「重新连接」调用 o.onRetry(fnDone)，fnDone(true) 时刷新页面回到后端模式，
         * fnDone(false) 时按钮短暂显示"仍未连通"。
         * 文案全部经 textContent 写入，不拼 HTML。
         */

        var SVG_NS = "http://www.w3.org/2000/svg";
        var ICONS = {
                cloudOff: ["M2 2l20 20",
                        "M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2",
                        "M21.5 16.5A4.5 4.5 0 0 0 17.5 10h-1.8A7 7 0 0 0 10 5.1"],
                retry: ["M21 12a9 9 0 1 1-2.6-6.4L21 8", "M21 3v5h-5"],
                close: ["M6 6l12 12", "M18 6L6 18"]
        };

        function icon(sName, sClass) {
                var oSvg = document.createElementNS(SVG_NS, "svg");
                oSvg.setAttribute("viewBox", "0 0 24 24");
                oSvg.setAttribute("aria-hidden", "true");
                oSvg.setAttribute("class", sClass);
                ICONS[sName].forEach(function (d) {
                        var oPath = document.createElementNS(SVG_NS, "path");
                        oPath.setAttribute("d", d);
                        oSvg.appendChild(oPath);
                });
                return oSvg;
        }

        function el(sTag, sClass, sText) {
                var o = document.createElement(sTag);
                if (sClass) { o.className = sClass; }
                if (sText) { o.textContent = sText; }
                return o;
        }

        /** 「重新连接」按钮：检测中禁用；失败短暂提示后复原；成功刷新页面 */
        function retryButton(o, bCompact) {
                var oBtn = el("button", "offNoticeRetry" + (bCompact ? " offNoticeRetry--link" : ""));
                oBtn.type = "button";
                var oLabel = el("span", "", o.retryText);
                if (!bCompact) { oBtn.appendChild(icon("retry", "offNoticeRetryIco")); }
                oBtn.appendChild(oLabel);
                var iTimer = 0;
                oBtn.addEventListener("click", function () {
                        if (oBtn.disabled || typeof o.onRetry !== "function") { return; }
                        clearTimeout(iTimer);
                        oBtn.disabled = true;
                        oBtn.classList.remove("is-fail");
                        oBtn.classList.add("is-busy");
                        oLabel.textContent = o.retryingText;
                        o.onRetry(function (bOk) {
                                if (bOk) {
                                        window.location.reload();
                                        return;
                                }
                                oBtn.disabled = false;
                                oBtn.classList.remove("is-busy");
                                oBtn.classList.add("is-fail");
                                oLabel.textContent = o.retryFailText;
                                iTimer = setTimeout(function () {
                                        oBtn.classList.remove("is-fail");
                                        oLabel.textContent = o.retryText;
                                }, 2400);
                        });
                });
                return oBtn;
        }

        var oCurrent = null;   // 同一时刻只留一张浮动卡片

        return {
                /**
                 * 浮动卡片（已登录时用）
                 * @param {object} o { title, body, retryText, retryingText, retryFailText, closeText, onRetry, duration }
                 */
                show: function (o) {
                        if (oCurrent) { ToastStack.dismiss(oCurrent); }
                        var oCard = el("div", "offNotice offNotice--float");
                        oCard.setAttribute("role", "status");
                        oCard.setAttribute("aria-live", "polite");

                        var oIco = el("div", "offNoticeIco");
                        oIco.appendChild(icon("cloudOff", "offNoticeIcoSvg"));
                        var oMain = el("div", "offNoticeMain");
                        oMain.appendChild(el("div", "offNoticeTitle", o.title));
                        oMain.appendChild(el("div", "offNoticeBody", o.body));
                        var oActs = el("div", "offNoticeActs");
                        oActs.appendChild(retryButton(o, false));
                        oMain.appendChild(oActs);

                        var oClose = el("button", "offNoticeClose");
                        oClose.type = "button";
                        oClose.setAttribute("aria-label", o.closeText);
                        oClose.title = o.closeText;
                        oClose.appendChild(icon("close", "offNoticeCloseIco"));

                        var oTimer = el("i", "offNoticeTimer");
                        oTimer.style.animationDuration = (o.duration || 10000) + "ms";

                        oCard.appendChild(oIco);
                        oCard.appendChild(oMain);
                        oCard.appendChild(oClose);
                        oCard.appendChild(oTimer);

                        var fnHide = function () {
                                ToastStack.dismiss(oCard);
                                if (oCurrent === oCard) { oCurrent = null; }
                        };
                        oClose.addEventListener("click", fnHide);

                        ToastStack.mount(oCard, true);
                        ToastStack.autoDismiss(oCard, o.duration || 10000, fnHide);
                        oCurrent = oCard;
                        return { hide: fnHide };
                },

                /**
                 * 登录卡片内的提示条（未登录时用），返回 DOM 节点
                 * @param {object} o { title, credUser, credUserLabel, credPass, credPassLabel, retryText, retryingText, retryFailText, onRetry }
                 */
                createInline: function (o) {
                        var oBox = el("div", "offNotice offNotice--inline");
                        oBox.setAttribute("role", "status");
                        var oIco = el("div", "offNoticeIco");
                        oIco.appendChild(icon("cloudOff", "offNoticeIcoSvg"));
                        var oMain = el("div", "offNoticeMain");
                        var oHead = el("div", "offNoticeHead");
                        oHead.appendChild(el("span", "offNoticeTitle", o.title));
                        oHead.appendChild(retryButton(o, true));
                        oMain.appendChild(oHead);

                        var oCreds = el("div", "offNoticeCreds");
                        oCreds.appendChild(el("span", "", o.credUserLabel));
                        oCreds.appendChild(el("code", "", o.credUser));
                        oCreds.appendChild(el("span", "offNoticeSep", "·"));
                        oCreds.appendChild(el("span", "", o.credPassLabel));
                        oCreds.appendChild(el("code", "", o.credPass));
                        oMain.appendChild(oCreds);

                        oBox.appendChild(oIco);
                        oBox.appendChild(oMain);
                        return oBox;
                }
        };
});
