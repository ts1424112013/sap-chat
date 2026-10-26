sap.ui.define([
        "sap/ui/core/Control",
        "zai/chat/control/LingXiArtwork"
], function (Control, Artwork) {
        "use strict";

        var aInstances = [];
        var bMotionHooks = false;
        var oReducedMotion;

        function state(sValue) { return sValue === "thinking" || sValue === "running" ? sValue : "idle"; }

        function applyState(oDom, sState) {
                ["idle", "thinking", "running"].forEach(function (s) { oDom.classList.remove("lingxiMark--" + s); });
                oDom.classList.add("lingxiMark--" + sState);
                oDom.setAttribute("data-state", sState);
        }

        function bindMotionHooks() {
                if (bMotionHooks || typeof document === "undefined") { return; }
                bMotionHooks = true;
                oReducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
                var fnVisibility = function () {
                        document.documentElement.classList.toggle("lingxiMotionPaused", document.hidden);
                        aInstances.forEach(function (oControl) {
                                (oControl._aSettling || []).forEach(function (a) { document.hidden ? a.pause() : a.play(); });
                        });
                };
                document.addEventListener("visibilitychange", fnVisibility);
                fnVisibility();
                if (oReducedMotion) {
                        var fnReduce = function () {
                                if (!oReducedMotion.matches) { return; }
                                aInstances.forEach(function (oControl) {
                                        oControl._cancelMotion();
                                        var oDom = oControl.getDomRef();
                                        if (oDom) { applyState(oDom, state(oControl.getState())); }
                                });
                        };
                        if (oReducedMotion.addEventListener) { oReducedMotion.addEventListener("change", fnReduce); }
                        else { oReducedMotion.addListener(fnReduce); }
                }
        }

        var LingXiMark = Control.extend("zai.chat.control.LingXiMark", {
                metadata: {
                        properties: {
                                size: { type: "sap.ui.core.CSSSize", defaultValue: "32px" },
                                state: { type: "string", defaultValue: "idle" }
                        }
                },

                init: function () {
                        this._sArtworkId = Artwork.nextId();
                        this._iMotionToken = 0;
                        this._aSettling = [];
                        aInstances.push(this);
                        bindMotionHooks();
                },

                _cancelMotion: function () {
                        this._iMotionToken++;
                        (this._aSettling || []).forEach(function (a) { a.cancel(); });
                        this._aSettling = [];
                },

                onBeforeRendering: function () { this._cancelMotion(); },

                exit: function () {
                        this._cancelMotion();
                        var i = aInstances.indexOf(this);
                        if (i >= 0) { aInstances.splice(i, 1); }
                },

                // 只切状态，不重建 SVG；计时文字更新不会重启动画。
                setState: function (sValue) {
                        var sNext = state(sValue);
                        var sOld = state(this.getState());
                        this.setProperty("state", sNext, true);
                        var oDom = this.getDomRef();
                        if (!oDom || sOld === sNext) { return this; }
                        var aFrames = Array.prototype.map.call(oDom.querySelectorAll(".lingxiPart"), function (el) {
                                return { element: el, transform: window.getComputedStyle(el).transform };
                        });
                        this._cancelMotion();
                        var iToken = this._iMotionToken;
                        var that = this;
                        applyState(oDom, "idle");
                        var bCanSettle = sOld !== "idle" && !document.hidden && !(oReducedMotion && oReducedMotion.matches);
                        if (bCanSettle) {
                                aFrames.forEach(function (f) {
                                        if (f.transform !== "none" && f.element.animate) {
                                                that._aSettling.push(f.element.animate([
                                                        { transform: f.transform }, { transform: "none" }
                                                ], { duration: 380, easing: "cubic-bezier(.2,.7,.2,1)", fill: "both" }));
                                        }
                                });
                        }
                        if (!this._aSettling.length) { applyState(oDom, sNext); return this; }
                        var aSettling = this._aSettling.slice();
                        Promise.all(aSettling.map(function (a) { return a.finished.catch(function () {}); })).then(function () {
                                aSettling.forEach(function (a) { a.cancel(); });
                                if (that._iMotionToken !== iToken || that.getDomRef() !== oDom) { return; }
                                that._aSettling = [];
                                applyState(oDom, sNext);
                        });
                        return this;
                },

                renderer: {
                        apiVersion: 2,
                        render: function (oRm, oControl) {
                                var sState = state(oControl.getState());
                                oRm.openStart("span", oControl).class("lingxiMark").class("lingxiMark--" + sState)
                                        .style("width", oControl.getSize()).style("height", oControl.getSize())
                                        .attr("data-state", sState).attr("aria-hidden", "true").openEnd();
                                Artwork.render(oRm, oControl._sArtworkId);
                                oRm.close("span");
                        }
                }
        });

        // UI5 树外的欢迎提示与正式控件共用同一份 SVG。
        LingXiMark.createElement = function (sSize, sExtraClass) {
                bindMotionHooks();
                var oRoot = document.createElement("span");
                oRoot.className = "lingxiMark lingxiMark--idle" + (sExtraClass ? " " + sExtraClass : "");
                oRoot.style.width = sSize;
                oRoot.style.height = sSize;
                oRoot.setAttribute("data-state", "idle");
                oRoot.setAttribute("aria-hidden", "true");
                oRoot.appendChild(Artwork.createElement());
                return oRoot;
        };

        return LingXiMark;
});
