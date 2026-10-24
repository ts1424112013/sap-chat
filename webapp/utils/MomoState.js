sap.ui.define([], function () {
        "use strict";

        return {
                activity: function (bBusy, sActivity) {
                        return bBusy || sActivity ? "thinking" : "idle";
                },

                // 后台报表仍在执行时，不能因为本轮文字已经回复就露出完成的笑眼。
                message: function (bWaiting, bStreaming, bPending, sStatus, sRunPhase, bLocalResult, bStopped) {
                        if (bStopped) { return "idle"; }
                        if (bWaiting || bStreaming || bPending || sRunPhase === "active") { return "thinking"; }
                        if (sRunPhase) { return sRunPhase === "ready" ? "done" : "idle"; }
                        return sStatus === "OK" || sStatus === "COMPLETED" || bLocalResult ? "done" : "idle";
                }
        };
});
