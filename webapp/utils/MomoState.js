sap.ui.define([], function () {
        "use strict";

        return {
                activity: function (bBusy, sActivity) {
                        return bBusy || sActivity ? "thinking" : "idle";
                },

                // 只在实际处理时播放；文字结束且没有后台报表执行时恢复原始图标。
                message: function (bWaiting, bStreaming, bPending, sRunPhase, bStopped) {
                        if (bStopped) { return "idle"; }
                        if (bWaiting || bStreaming || bPending || sRunPhase === "active") { return "thinking"; }
                        return "idle";
                }
        };
});
