sap.ui.define([], function () {
        "use strict";

        /**
         * 提示栈（20261025）：欢迎卡片、后端不可达提示等自绘浮层共用
         * ---------------------------------------------------------------
         *   mount(el, { edge, first })
         *        edge="top"（默认）对话区顶部居中，如后端不可达提示；
         *        edge="bottom"  对话区底部居中，如欢迎卡片；
         *        两个栈都避开侧栏、在对话区里居中，与输入框对齐；对话态底部有输入框时，
         *        底部栈浮在输入框上方。历史会话是异步加载的、侧栏可收起，所以栈存在期间
         *        每 250ms 复核一次位置（CSS 过渡让它滑过去），栈清空即停
         *        first=true 插到栈的最前面（重要提示在上）
         *   autoDismiss(el, ms, fn)  到时调 fn；鼠标悬停 / 键盘焦点在卡片内时暂停计时
         *   dismiss(el)              播放卡片自己的 .is-leaving 离场动画，再收起高度，
         *                            同栈其余卡片顺滑补位，不跳动
         * 计时用 JS 而不是 CSS 动画的 animationend：全局"减弱动效"规则会把所有动画
         * 压到 0.01ms，靠动画计时的卡片会一出现就消失。
         */

        var mStacks = {};
        var LEAVE_MS = 240;
        var COLLAPSE_MS = 260;

        /** 提示栈避开侧栏、在对话区里居中；手机端侧栏是浮层（absolute），不避让 */
        function alignToMain(oS) {
                var iLeft = 16;
                var oSide = document.querySelector(".sideBar");
                if (oSide && window.getComputedStyle(oSide).position !== "absolute") {
                        var r = oSide.getBoundingClientRect();
                        if (r.width > 0 && r.right > 0 && r.right < window.innerWidth * 0.6) {
                                iLeft = Math.round(r.right) + 16;
                        }
                }
                oS.style.left = iLeft + "px";
        }

        /** 底部栈：默认离底 40px；对话态输入框可见时浮在它上方 12px */
        function placeBottom(oS) {
                var iBottom = 40;
                var oDock = document.querySelector(".inputDock");
                if (oDock) {
                        var r = oDock.getBoundingClientRect();
                        if (r.height > 0) {
                                iBottom = Math.max(iBottom, Math.round(window.innerHeight - r.top) + 12);
                        }
                }
                oS.style.bottom = iBottom + "px";
        }

        function place(oS, sEdge) {
                alignToMain(oS);
                if (sEdge === "bottom") { placeBottom(oS); }
        }

        function stack(sEdge) {
                var oS = mStacks[sEdge];
                if (!oS || !oS.isConnected) {
                        oS = document.createElement("div");
                        oS.className = "toastStack toastStack--" + sEdge;
                        place(oS, sEdge);   // 插入前定好位置，首帧不触发过渡
                        document.body.appendChild(oS);
                        mStacks[sEdge] = oS;
                        var iWatch = setInterval(function () {
                                if (!oS.isConnected) { clearInterval(iWatch); return; }
                                place(oS, sEdge);
                        }, 250);
                } else {
                        place(oS, sEdge);
                }
                return oS;
        }

        return {
                mount: function (oEl, mOpt) {
                        mOpt = mOpt || {};
                        var oS = stack(mOpt.edge === "bottom" ? "bottom" : "top");
                        if (mOpt.first && oS.firstChild) {
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
                                        var oS = oEl.parentNode;
                                        oEl.remove();
                                        if (oS && !oS.firstChild) { oS.remove(); }
                                }, COLLAPSE_MS);
                        }, LEAVE_MS);
                }
        };
});
