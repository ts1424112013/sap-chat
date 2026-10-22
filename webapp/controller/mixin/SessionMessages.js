sap.ui.define([
        "zai/chat/service/ChatService"
], function (ChatService) {
        "use strict";

        // 仅保存本次页面生命周期内的消息数据，不缓存 UI5 控件或写入浏览器存储。
        return {
                _clearSessionMessages: function () {
                        Object.keys(this._mRuns || {}).forEach(function (k) {
                                this._stopRun("stopped", this._mRuns[k]);
                        }, this);
                        this._releaseBusy();
                        this._mRuns = Object.create(null);
                        this._mSessionMessages = Object.create(null);
                        this._mFocusArt = {};
                        this._sMessagesSession = null;
                        var oCtx = this.getView().getModel("chat").getProperty("/currentSession") || {};
                        this._activateSessionMessages(oCtx.id || "", oCtx.mode || "CHAT");
                },

                _sessionMessageState: function (sSid) {
                        var oState = this._mSessionMessages && this._mSessionMessages[sSid];
                        if (oState && this._sMessagesSession === sSid) {
                                var oChat = this.getView().getModel("chat");
                                oState.messages = oChat.getProperty("/messages") || [];
                                oState.currentTask = oChat.getProperty("/currentTask");
                                oState.taskBadge = oChat.getProperty("/taskBadge") || "";
                                oState.taskBadgeState = oChat.getProperty("/taskBadgeState") || "None";
                                oState.taskBadgeTip = oChat.getProperty("/taskBadgeTip") || "";
                        }
                        return oState;
                },

                _activateSessionMessages: function (sSid, sMode) {
                        if (this._sMessagesSession === sSid) { return; }
                        var oPrev = this._sessionMessageState(this._sMessagesSession);
                        if (oPrev) {
                                // 被中断的普通回复仍需回读后端，不能永久停留在占位/半截打字状态。
                                oPrev.refresh = oPrev.messages.some(function (m) { return m.streaming || m.waiting || m.requestPending; });
                                oPrev.loaded = oPrev.loaded || oPrev.messages.length > 0;
                        }
                        this._releaseBusy();
                        this._mSessionMessages = this._mSessionMessages || Object.create(null);
                        var oState = this._mSessionMessages[sSid];
                        if (!oState) {
                                oState = this._mSessionMessages[sSid] = {
                                        messages: [], loaded: false, version: 0, mode: sMode,
                                        currentTask: null, taskBadge: ""
                                };
                        }
                        this._sMessagesSession = sSid;
                        // 宿主控件随列表销毁重建；缓存只保留消息条目和稳定 uid。
                        this._mAskHosts = {};
                        var oChat = this.getView().getModel("chat");
                        oChat.setProperty("/messages", oState.messages);
                        oChat.setProperty("/currentTask", oState.currentTask);
                        oChat.setProperty("/taskBadge", oState.taskBadge);
                        oChat.setProperty("/taskBadgeState", oState.taskBadgeState || "None");
                        oChat.setProperty("/taskBadgeTip", oState.taskBadgeTip || "");
                },

                /** 回读被中断的回复时复用已有条目，并把本地报表结果留在原来的位置。 */
                _mergeSessionHistory: function (aHistory, aCached) {
                        var aOut = [], iNext = 0;
                        aCached.forEach(function (oEntry) {
                                if (oEntry.localResult) {
                                        aOut.push(oEntry);
                                        return;
                                }
                                if (oEntry.waiting || oEntry.requestPending || oEntry.streaming) { return; }
                                var iMatch = -1;
                                for (var i = iNext; i < aHistory.length; i++) {
                                        if (aHistory[i].role === oEntry.role && aHistory[i].raw === oEntry.raw) {
                                                iMatch = i;
                                                break;
                                        }
                                }
                                if (iMatch >= 0) {
                                        aOut = aOut.concat(aHistory.slice(iNext, iMatch), [oEntry]);
                                        iNext = iMatch + 1;
                                }
                        });
                        return aOut.concat(aHistory.slice(iNext));
                },

                _readSessionHistory: function (sSid, bAgent) {
                        var that = this;
                        var oState = this._sessionMessageState(sSid);
                        if (!oState) { return Promise.resolve(); }
                        var fnShow = function () {
                                if (that._sMessagesSession !== sSid) { return; }
                                that.getView().getModel("chat").setProperty("/messages", oState.messages);
                                that._setViewLayout(bAgent || oState.messages.length > 0);
                                that._scrollToBottom();
                                setTimeout(function () { that._highlightCodeBlocks(); }, 150);
                        };
                        fnShow();
                        if (oState.loaded && !oState.refresh) { return Promise.resolve(); }
                        var iVersion = oState.version;
                        var oRead = oState.read = {};
                        return ChatService.getHistory(sSid).then(function (aRows) {
                                // 删除会话、再次加载或加载期间发送了新消息，旧响应都不能覆盖它。
                                if (!that._mSessionMessages || that._mSessionMessages[sSid] !== oState ||
                                        oState.read !== oRead || oState.version !== iVersion) { return; }
                                var aHistory = aRows.map(function (oRow) {
                                        var oEntry = that._buildEntry(oRow.Role, oRow.Content, oRow.CreatedAt, "");
                                        if (bAgent && oRow.Role === "assistant") {
                                                oEntry.sender = that._rb().getText("agentSender");
                                        }
                                        return oEntry;
                                });
                                // 后台结果可能在读历史期间刚写入，合并时取最新缓存。
                                that._sessionMessageState(sSid);
                                oState.messages = that._mergeSessionHistory(aHistory, oState.messages);
                                oState.loaded = true;
                                oState.refresh = false;
                                fnShow();
                        });
                },

                _appendSessionEntry: function (sSid, oEntry) {
                        var oState = this._sessionMessageState(sSid);
                        if (!oState) { return false; }   // 会话已删除，不让迟到结果复活它
                        oState.messages.push(oEntry);
                        if (this._sMessagesSession === sSid) {
                                this.getView().getModel("chat").setProperty("/messages", oState.messages.slice());
                                this._setViewLayout(true);
                                this._scrollToBottom();
                        }
                        return true;
                }
        };
});
