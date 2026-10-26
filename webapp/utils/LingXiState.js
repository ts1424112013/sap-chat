sap.ui.define([], function () {
        "use strict";

        return {
                activity: function (bBusy, bReportRunning, bStreaming) {
                        if (bReportRunning || (bBusy && bStreaming)) { return "running"; }
                        return bBusy ? "thinking" : "idle";
                },

                // 手动停止优先；后台报表执行与正文输出使用加强版运行动效。
                message: function (bWaiting, bStreaming, bPending, sRunPhase, bStopped) {
                        if (bStopped) { return "idle"; }
                        if (sRunPhase === "active") { return "running"; }
                        if (bWaiting || bPending) { return "thinking"; }
                        return bStreaming ? "running" : "idle";
                }
        };
});
