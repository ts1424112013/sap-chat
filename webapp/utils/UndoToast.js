sap.ui.define([
        "zai/chat/utils/ToastStack"
], function (ToastStack) {
        "use strict";

        /**
         * 可撤销操作的底部提示卡（20261025，删除会话用；替换原 MessageBox 确认框）
         * ---------------------------------------------------------------
         * 对话区底部居中（与欢迎卡片同一个栈）：图标 + 文案 + 「撤销」+ 底部倒计时条。
         * 鼠标悬停 / 键盘焦点在卡片内时计时暂停（ToastStack.autoDismiss），倒计时条一起停。
         *   show({ text, actionText, duration, onAction, onTimeout }) → { hide, commit }
         *     点「撤销」→ onAction，卡片收起，不再调 onTimeout；
         *     到时 → onTimeout，卡片收起；commit() = 立即按到时处理（例如又删了一条）
         * 样式 .undoToast / .ut*（style-gale.css 末尾）
         */

        function el(sTag, sClass, sText) {
                var o = document.createElement(sTag);
                o.className = sClass;
                if (sText) { o.textContent = sText; }
                return o;
        }

        // 垃圾桶图标（线框，跟随文字色）
        var TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

        return {
                show: function (o) {
                        var iMs = o.duration || 5000;
                        var bDone = false;
                        var oCard = el("div", "undoToast");
                        oCard.setAttribute("role", "status");
                        oCard.setAttribute("aria-live", "polite");

                        var oIco = el("span", "utIco");
                        oIco.innerHTML = TRASH_SVG;
                        var oText = el("span", "utText", o.text);
                        var oBtn = el("button", "utAction", o.actionText);
                        oBtn.type = "button";
                        var oTimer = el("span", "utTimer");
                        oTimer.style.animationDuration = iMs + "ms";

                        oCard.appendChild(oIco);
                        oCard.appendChild(oText);
                        oCard.appendChild(oBtn);
                        oCard.appendChild(oTimer);

                        var fnFinish = function (bUndo) {
                                if (bDone) { return; }
                                bDone = true;
                                ToastStack.dismiss(oCard);
                                if (bUndo) {
                                        if (o.onAction) { o.onAction(); }
                                } else if (o.onTimeout) {
                                        o.onTimeout();
                                }
                        };
                        oBtn.addEventListener("click", function () { fnFinish(true); });

                        ToastStack.mount(oCard, { edge: "bottom" });
                        ToastStack.autoDismiss(oCard, iMs, function () { fnFinish(false); });
                        return {
                                commit: function () { fnFinish(false); },
                                hide: function () { fnFinish(true); }
                        };
                }
        };
});
