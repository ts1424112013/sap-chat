sap.ui.define([
        "zai/chat/utils/ToastStack"
], function (ToastStack) {
        "use strict";

        /**
         * 应用内轻提示（20261025，替换 sap.m.MessageToast 的默认外观：白底灰边大框、压在内容上）
         * ---------------------------------------------------------------
         * 用法与 MessageToast 相同：show(sText, { duration, kind })。各文件只把依赖从 "sap/m/MessageToast"
         * 换成本模块（参数名仍叫 MessageToast），调用处一行不用改。
         * 外观与「撤销」卡片同一套：反色小卡 + 左侧圆形状态图标，对话区底部居中（与欢迎卡片、撤销卡片同一个栈，
         * 对话态浮在输入框上方，不再盖住首页的建议标签）；悬停暂停计时，点一下收起。
         * kind：ok / warn / info；不传时按文案判断（失败 / 不能 / 请先… → warn；已… / 成功 / 完成 → ok；其余 info）。
         * 同一句提示还在显示时再出现，不再叠一张，只把原来那张弹一下；最多同时 3 张，多了先收最早的。
         * 样式 .appToast / .atIco / .atText（style-gale.css 末尾）
         */

        var ICONS = {
                ok: '<path d="M6 12.4l4 4L18 8.2"/>',
                warn: '<path d="M12 7.2v6.2"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
                info: '<circle cx="12" cy="7.6" r=".6" fill="currentColor"/><path d="M12 11v6"/>'
        };
        var RE_WARN = /失败|错误|无法|不能|不支持|超过|请先|必填|不可|未能|不足|已存在|过期|拒绝|出错|异常|超时|稍候|仍在|不适合|error|fail|denied|invalid|timeout/i;
        var RE_OK = /^已|已(保存|复制|导出|添加|删除|更新|切换|取消|开通|停用|提交|撤回|重命名)|成功|完成/;
        var MAX_LIVE = 3;
        var aLive = [];

        /** 有些调用处按旧习惯先做了 HTML 转义；这里按纯文本显示，先还原成原字符 */
        function unescape(s) {
                return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
        }

        function kindOf(s) {
                if (RE_WARN.test(s)) {
                        return "warn";
                }
                return RE_OK.test(s) ? "ok" : "info";
        }

        function hide(oItem) {
                aLive = aLive.filter(function (o) { return o !== oItem; });
                ToastStack.dismiss(oItem.el);
        }

        return {
                show: function (sText, mOpt) {
                        if (typeof document === "undefined") {
                                return;
                        }
                        mOpt = mOpt || {};
                        var s = unescape(String(sText === null || sText === undefined ? "" : sText)).trim();
                        if (!s) {
                                return;
                        }
                        var oSame = aLive.filter(function (o) { return o.text === s && o.el.isConnected && !o.el.classList.contains("is-leaving"); })[0];
                        if (oSame) {
                                oSame.el.classList.remove("is-bump");
                                void oSame.el.offsetWidth;
                                oSame.el.classList.add("is-bump");
                                return;
                        }
                        while (aLive.length >= MAX_LIVE) {
                                hide(aLive[0]);
                        }
                        var sKind = ICONS[mOpt.kind] ? mOpt.kind : kindOf(s);
                        var oCard = document.createElement("div");
                        oCard.className = "appToast appToast--" + sKind;
                        oCard.setAttribute("role", sKind === "warn" ? "alert" : "status");
                        oCard.setAttribute("aria-live", sKind === "warn" ? "assertive" : "polite");
                        var oIco = document.createElement("span");
                        oIco.className = "atIco";
                        oIco.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
                                'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[sKind] + "</svg>";
                        var oText = document.createElement("span");
                        oText.className = "atText";
                        oText.textContent = s;
                        oCard.appendChild(oIco);
                        oCard.appendChild(oText);

                        var oItem = { el: oCard, text: s };
                        aLive.push(oItem);
                        oCard.addEventListener("click", function () { hide(oItem); });
                        ToastStack.mount(oCard, { edge: "bottom" });
                        // 默认 2.6 秒；需要读一读的（警示）给 4 秒；调用方传了 duration 以调用方为准
                        ToastStack.autoDismiss(oCard, mOpt.duration || (sKind === "warn" ? 4000 : 2600), function () { hide(oItem); });
                }
        };
});
