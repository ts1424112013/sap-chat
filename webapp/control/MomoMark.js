sap.ui.define([
        "sap/ui/core/Control"
], function (Control) {
        "use strict";

        function image(sContent) {
                return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
                        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">' + sContent + "</svg>");
        }

        // 与 images/momo-mark.svg 共用轮廓；图层各自使用 SVG 图片，渐变 ID 不会在多个头像之间冲突。
        var sFoam = "M8.2 37.7C9.6 30.7 15.1 21.3 21.7 21.3C27.1 21.3 29.6 25.1 32.4 29.9C34.6 33.6 36.5 33.9 39.3 30.6C43.3 25.9 47.3 24.8 51.5 28.8C56.2 33.4 58 39.4 55.1 44.3C51.8 49.9 46.2 49 41.5 45.2L35.2 40.1C33.4 38.8 31.6 38.9 29.3 40.6C24.1 44.7 19.6 48.2 14.1 47.2C8.7 46.3 6.9 43 8.2 37.7Z";
        var mImages = {
                face: image('<defs><linearGradient id="foam" x1="8" y1="48" x2="55" y2="23" gradientUnits="userSpaceOnUse"><stop stop-color="#8263F2"/><stop offset=".32" stop-color="#528CF7"/><stop offset=".66" stop-color="#31C9E2"/><stop offset="1" stop-color="#75EFC7"/></linearGradient></defs><path fill="url(#foam)" d="' + sFoam + '"/>'),
                drop: image('<defs><linearGradient id="drop" x1="44" y1="19" x2="50" y2="17" gradientUnits="userSpaceOnUse"><stop stop-color="#7896FF"/><stop offset="1" stop-color="#42D9E4"/></linearGradient></defs><circle cx="47" cy="18.4" r="3.4" fill="url(#drop)"/>'),
                left: image('<ellipse cx="18.5" cy="36.6" rx="5.15" ry="6.3" fill="#24424D"/>'),
                right: image('<ellipse cx="45.5" cy="39.4" rx="3.9" ry="4.2" fill="#24424D"/>')
        };

        function state(sValue) {
                return sValue === "thinking" ? sValue : "idle";
        }
        function layer(oRm, sName, sClass) {
                oRm.voidStart("img").class("momoLayer");
                sClass.split(" ").forEach(function (sToken) { oRm.class(sToken); });
                oRm.attr("src", mImages[sName]).attr("alt", "").attr("draggable", "false").voidEnd();
        }

        return Control.extend("zai.chat.control.MomoMark", {
                metadata: {
                        properties: {
                                size: { type: "sap.ui.core.CSSSize", defaultValue: "32px" },
                                state: { type: "string", defaultValue: "idle" }
                        }
                },

                // 绑定属性变化只切换表情，计时刷新不会重建图片、重启正在播放的动画。
                setState: function (sValue) {
                        var sNext = state(sValue);
                        var sOld = state(this.getState());
                        this.setProperty("state", sNext, true);
                        var oDom = this.getDomRef();
                        if (oDom && sOld !== sNext) {
                                oDom.classList.remove("momoMark--" + sOld);
                                oDom.classList.add("momoMark--" + sNext);
                        }
                        return this;
                },

                renderer: {
                        apiVersion: 2,
                        render: function (oRm, oControl) {
                                oRm.openStart("span", oControl).class("momoMark").class("momoMark--" + state(oControl.getState()))
                                        .style("width", oControl.getSize()).style("height", oControl.getSize())
                                        .attr("aria-hidden", "true").openEnd();
                                layer(oRm, "face", "momoFace");
                                oRm.openStart("span").class("momoDropTravel").openEnd();
                                layer(oRm, "drop", "momoDrop");
                                oRm.close("span");
                                oRm.openStart("span").class("momoGaze").openEnd();
                                layer(oRm, "left", "momoEye momoEyeLeft");
                                layer(oRm, "right", "momoEye momoEyeRight");
                                oRm.close("span").close("span");
                        }
                }
        });
});
