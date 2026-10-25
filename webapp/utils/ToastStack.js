sap.ui.define([], function () {
        "use strict";

        /**
         * 顶部提示栈（20261025）：欢迎卡片、后端不可达提示等自绘浮层共用
         * ---------------------------------------------------------------
         *   mount(el, bTop)          放进屏幕顶部居中的栈；bTop=true 插到最上面（重要提示在上）
         *   autoDismiss(el, ms, fn)  到时调 fn；鼠标悬停 / 键盘焦点在卡片内时暂停计时
         *   dismiss(el)              播放卡片自己的 .is-leaving 离场动画，再收起高度，
         *                            下方卡片顺滑上移，不跳动
         * 计时用 JS 而不是 CSS 动画的 animationend：全局"减弱动效"规则会把所有动画
         * 压到 0.01ms，靠动画计时的卡片会一出现就消失。
         */

        var oStack = null;
        var LEAVE_MS = 240;
        var COLLAPSE_MS = 260;

        function stack() {
                if (!oStack || !oStack.isConnected) {
                        oStack = document.createElement("div");
                        oStack.className = "toastStack";
                        document.body.appendChild(oStack);
                }
                return oStack;
        }

        return {
                mount: function (oEl, bTop) {
                        var oS = stack();
                        if (bTop && oS.firstChild) {
                                oS.insertBefore(oEl, oS.firstChild);
                        } else {
                                oS.appendChild(oEl);
                        }
                },

                autoDismiss: function (oEl, iMs, fnDone) {
                        var iLeft = iMs, iStart = 0, iTimer = 0;
                        var fnRun = function () {
                                if (iTimer || !oEl.isConnected) { return; }
                                iStart = Date.now();
                                iTimer = setTimeout(fnDone, Math.max(iLeft, 400));
                        };
                        var fnPause = function () {
                                if (!iTimer) { return; }
                                clearTimeout(iTimer);
                                iTimer = 0;
                                iLeft -= Date.now() - iStart;
                        };
                        oEl.addEventListener("mouseenter", fnPause);
                        oEl.addEventListener("focusin", fnPause);
                        oEl.addEventListener("mouseleave", function () {
                                if (!oEl.contains(document.activeElement)) { fnRun(); }
                        });
                        oEl.addEventListener("focusout", function (e) {
                                if (!oEl.contains(e.relatedTarget) && !oEl.matches(":hover")) { fnRun(); }
                        });
                        fnRun();
                },

                dismiss: function (oEl) {
                        if (!oEl.parentNode || oEl.classList.contains("is-leaving")) { return; }
                        oEl.classList.add("is-leaving");
                        setTimeout(function () {
                                oEl.style.height = oEl.offsetHeight + "px";
                                void oEl.offsetHeight;   // 先定住当前高度，再过渡到 0
                                oEl.classList.add("is-collapsing");
                                setTimeout(function () {
                                        oEl.remove();
                                        if (oStack && !oStack.firstChild) {
                                                oStack.remove();
                                                oStack = null;
                                        }
                                }, COLLAPSE_MS);
                        }, LEAVE_MS);
                }
        };
});
