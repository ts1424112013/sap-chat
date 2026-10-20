sap.ui.define([
        "sap/ui/model/json/JSONModel",
        "sap/m/MessageToast",
        "zai/chat/service/ChatService",
        "zai/chat/utils/Formatter"
], function (JSONModel, MessageToast, ChatService, Formatter) {
        "use strict";

        /**
         * =====================================================================
         * App 控制器拆分块：设置对话框与模型管理
         * =====================================================================
         * 设置对话框（账号、用户开通/停用、超长源码分块开关、连接模式与持久化）
         * 与模型管理页签（模型表格、新增/编辑/保存、连通性测试）。
         * 以 mixin 方式并入 zai.chat.controller.App（方法里的 this 就是控制器）；
         * 20261011（改进清单 FE-09）从 App.controller.js 原样搬出，逻辑未改。
         * =====================================================================
         */
        return {

                /* =========================================================
                 * 设置对话框
                 * ========================================================= */

                onOpenSettings: function () {
                        var that = this;
                        if (!this._oSettingsDialog) {
                                this._oSettingsDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.SettingsDialog", this);
                                this.getView().addDependent(this._oSettingsDialog);
                        }
                        // V8：登录账号信息 + 权限（页签/编辑能力按角色显隐）
                        var oUser = ChatService.getAppUser() || {};
                        var oSettings = this.getView().getModel("settings");
                        oSettings.setProperty("/isAdmin", ChatService.isAdmin());
                        oSettings.setProperty("/loginUserId", (oUser.userId || "") + (oUser.role === "ADMIN" ? " · " + this._rb().getText("roleAdminTag") : ""));
                        this._oSettingsDialog.open();

                        // V8：刷新用户管理页签（仅管理员）
                        if (ChatService.isAdmin()) {
                                this._refreshUserTable();
                        }

                        // V10：读取超长源码分块分析全局开关（LONG_SRC_CHUNK）
                        // 注：代码权限已改为模型级（模型编辑里的「USER 禁看源码」），不再有全局开关
                        ChatService.getConfigValue("LONG_SRC_CHUNK").then(function (sVal) {
                                oSettings.setProperty("/chunkMode", sVal === "X");
                        }).catch(function () { /* 读不到保持默认关 */ });

                        // 20261011：Agent 可用模型白名单（管理员维护；空 = 不限制）
                        ChatService.getAgentModelRules().then(function (m) {
                                oSettings.setProperty("/agentRules", m || {});
                        }).catch(function () { oSettings.setProperty("/agentRules", {}); });

                        // 刷新模型管理页签列表
                        if (ChatService.getMode() === "backend") {
                                ChatService.getModels().then(function (aModels) {
                                        that._fillModelTable(aModels);
                                }).catch(function (sErr) {
                                        that._fillModelTable([]);
                                        MessageToast.show(Formatter.escapeHtml(String(sErr)));
                                });
                        } else {
                                this._fillModelTable([]);
                        }
                },

                /** V8：用户管理（管理员）——列表刷新 */
                _refreshUserTable: function () {
                        var oSettings = this.getView().getModel("settings");
                        var oRB = this._rb();
                        ChatService.getUsersData().then(function (aUsers) {
                                oSettings.setProperty("/userList", aUsers.map(function (u) {
                                        return {
                                                UserId: u.UserId,
                                                UserName: u.UserName || "",
                                                Role: oRB.getText(u.Role === "ADMIN" ? "userRoleAdminLabel" : "userRoleUserLabel"),
                                                RoleRaw: u.Role,
                                                ActiveState: u.Active === "X" ? "Success" : "Error",
                                                IsActive: oRB.getText(u.Active === "X" ? "userActive" : "userInactive")
                                        };
                                }));
                        }).catch(function () {
                                oSettings.setProperty("/userList", []);
                        });
                },

                /** V8：开通用户（管理员）：SAP 现存用户赋权 + 初始密码（首次登录提示修改） */
                onAddUser: function () {
                        var that = this;
                        var oSettings = this.getView().getModel("settings");
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var sId = (oSettings.getProperty("/newUserId") || "").trim();
                        if (!sId) {
                                // 20261019（FE-13）：这里只缺账号，原来误用了登录框的"用户名与密码均必填"
                                MessageToast.show(oRB.getText("userIdRequired"));
                                return;
                        }
                        ChatService.saveUserData({
                                UserId: sId,
                                UserName: oSettings.getProperty("/newUserName") || "",
                                Role: oSettings.getProperty("/newUserRole") || "USER",
                                Active: "X",
                                Password: oSettings.getProperty("/newUserPwd") || "123456"
                        }).then(function () {
                                oSettings.setProperty("/newUserId", "");
                                oSettings.setProperty("/newUserName", "");
                                oSettings.setProperty("/newUserPwd", "");
                                that._refreshUserTable();
                                MessageToast.show(oRB.getText("userAdded"));
                        }).catch(function (oErr) {
                                // 20261019（FE-02）：显示后端原话（如"SU01 中不存在用户 …"），不再一律"服务调用失败"
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || oRB.getText("errService")));
                        });
                },

                /** V8：停用用户（管理员） */
                onDeleteUser: function (oEvent) {
                        var that = this;
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var sId = oEvent.getSource().data("userId");
                        if (!sId) { return; }
                        // 20261019：停用时带上原姓名与角色 —— 后端按传入值整行 UPDATE，只传 UserId 会把
                        // 姓名清空、角色改成 USER（saveUserData 的默认值）
                        var oRow = (this.getView().getModel("settings").getProperty("/userList") || [])
                                .filter(function (u) { return u.UserId === sId; })[0] || {};
                        ChatService.saveUserData({ UserId: sId, UserName: oRow.UserName || "", Role: oRow.RoleRaw || "USER", Active: "" }).then(function () {
                                that._refreshUserTable();
                                MessageToast.show(oRB.getText("userDeleted"));
                        }).catch(function (oErr) {
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || oRB.getText("errService")));
                        });
                },

                /** V8：退出登录（清除本地登录态与网关凭据，回到登录框） */
                onAppLogout: function () {
                        ChatService.appLogout();
                        if (this._oSettingsDialog) {
                                this._oSettingsDialog.close();
                        }
                        this._authCloseAll();
                        this._openAppLogin();
                },

                onCloseSettings: function () {
                        if (this._oSettingsDialog) {
                                this._oSettingsDialog.close();
                        }
                },

                /**
                 * V10：全局开关「超长源码分块分析」（ZAI_CHAT_CFG LONG_SRC_CHUNK）。
                 * 开启后 >6000 行的源码按 2000 行/块先逐块摘要再级联作答。
                 * （代码权限为模型级开关，在模型编辑里逐模型配置，无全局开关）
                 */
                onChunkModeChange: function (oEvent) {
                        var that = this;
                        var bOn = oEvent.getSource().getState();
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        ChatService.saveConfigValue("LONG_SRC_CHUNK", bOn ? "X" : "").then(function () {
                                MessageToast.show(oRB.getText(bOn ? "chunkOn" : "chunkOff"));
                        }).catch(function (oErr) {
                                that.getView().getModel("settings").setProperty("/chunkMode", !bOn);
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                        });
                },

                /** 连接模式切换：mock ↔ backend，切换后重新加载 */
                onModeChange: function (oEvent) {
                        var oSettings = this.getView().getModel("settings");
                        oSettings.setProperty("/mode", oEvent.getSource().getSelectedKey());
                        this._applySettings();
                },

                /** 应用连接设置（由 onModeChange / onOpenSettings 后的手动保存触发） */
                _applySettings: function () {
                        var oSettings = this.getView().getModel("settings");
                        ChatService.setConfig({
                                mode: oSettings.getProperty("/mode"),
                                host: oSettings.getProperty("/host"),
                                path: oSettings.getProperty("/path")
                        });
                        this._persistSettings();
                        this._loadModels();
                        this._loadHistory();
                        // 模式切换后：会话存储源不同（本地 ↔ ZAI_CHAT_SESS），同步刷新
                        this._refreshSessions();
                        this._updateModeBadge();
                },

                /** 持久化连接配置与会话 ID */
                _persistSettings: function () {
                        var oSettings = this.getView().getModel("settings");
                        this._oStorage.put("settings", {
                                mode: oSettings.getProperty("/mode"),
                                host: oSettings.getProperty("/host"),
                                path: oSettings.getProperty("/path"),
                                sessionId: oSettings.getProperty("/sessionId"),
                                // V12：工作模式与 Agent 对话会话记忆（刷新后恢复正确模式）
                                agentSessionId: oSettings.getProperty("/agentSessionId") || "",
                                workspaceMode: this.getView().getModel("chat").getProperty("/workspaceMode") === "AGENT"
                                        ? "AGENT" : "CHAT"
                        });
                },

                /* =========================================================
                 * 模型管理（设置对话框-模型管理页签）
                 * ========================================================= */

                /** 填充模型表格 */
                _fillModelTable: function (aModels) {
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        var aRows = (aModels || []).map(function (m) {
                                return {
                                        ModelId: m.ModelId,
                                        ModelName: m.ModelName,
                                        ModelType: m.ModelType,
                                        EndpointUrl: m.EndpointUrl,
                                        IsActive: m.IsActive === "X" ? oRB.getText("activeYes") : oRB.getText("activeNo"),
                                        ActiveState: m.IsActive === "X" ? "Success" : "None",
                                        SkipSource: m.SkipSource || "",       // V10：保留源码分析开关状态供编辑回填
                                        UserHideSrc: m.UserHideSrc || ""      // V10：保留 USER 禁看开关状态供编辑回填
                                };
                        });
                        this.getView().getModel("settings").setProperty("/modelList", aRows);
                },

                /** 新增模型：打开编辑对话框（空表单） */
                onAddModel: function () {
                        this._sEditingModelId = null;
                        var oMe = new JSONModel({
                                ModelId: "", ModelName: "", ModelDesc: "", ModelType: "OLLAMA",
                                EndpointUrl: "", Destination: "", ApiModel: "", ApiKey: "",
                                AuthType: "NONE", Temperature: "0.3", MaxTokens: "4096",
                                TimeoutSec: "300", ActiveBool: true,
                                SkipSourceBool: false,   // V10：默认参与源码分析
                                UserHideSrcBool: false   // V10：默认 USER 也可看源码分析
                        });
                        this.getView().setModel(oMe, "me");
                        this._openModelDialog();
                },

                /** 编辑模型：回填表单（API Key 不回显，留空表示不修改） */
                onEditModel: function (oEvent) {
                        var that = this;
                        var sModelId = oEvent.getSource().data("modelId");
                        var oSrc = this.getView().getModel("settings").getProperty("/modelList")
                                .filter(function (m) { return m.ModelId === sModelId; })[0];
                        if (!oSrc) {
                                return;
                        }
                        // 从服务取完整配置（后端模式）
                        if (ChatService.getMode() === "backend") {
                                ChatService.getModels().then(function (aModels) {
                                        var oFull = aModels.filter(function (m) { return m.ModelId === sModelId; })[0];
                                        that._openModelEdit(oFull || oSrc, sModelId);
                                });
                        } else {
                                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("mockNotice"));
                        }
                },

                _openModelEdit: function (oFull, sModelId) {
                        this._sEditingModelId = sModelId;
                        var oMe = new JSONModel({
                                ModelId: oFull.ModelId || "",
                                ModelName: oFull.ModelName || "",
                                ModelDesc: oFull.ModelDesc || "",
                                ModelType: oFull.ModelType || "OLLAMA",
                                EndpointUrl: oFull.EndpointUrl || "",
                                Destination: oFull.Destination || "",
                                ApiModel: oFull.ApiModel || "",
                                ApiKey: "", // 安全：不回显
                                AuthType: oFull.AuthType || "NONE",
                                Temperature: oFull.Temperature || "0.3",
                                MaxTokens: oFull.MaxTokens || "4096",
                                TimeoutSec: oFull.TimeoutSec || "300",
                                ActiveBool: (oFull.IsActive === "X"),
                                // V10：源码分析开关（X = 跳过源码提取，对所有人生效）
                                SkipSourceBool: (oFull.SkipSource !== "X"),
                                // V10：USER 禁看源码（X = USER 用此模型仅见程式用途说明）
                                UserHideSrcBool: (oFull.UserHideSrc === "X")
                        });
                        this.getView().setModel(oMe, "me");
                        this._openModelDialog();
                },

                _openModelDialog: function () {
                        if (!this._oModelDialog) {
                                this._oModelDialog = sap.ui.xmlfragment(this.getView().getId(), "zai.chat.view.ModelEditDialog", this);
                                this.getView().addDependent(this._oModelDialog);
                        }
                        this._oModelDialog.open();
                },

                onCancelModel: function () {
                        if (this._oModelDialog) {
                                this._oModelDialog.close();
                        }
                },

                /** 保存模型配置 → OData 函数导入 SaveModelCfg（upsert 到 Z 表） */
                onSaveModel: function () {
                        var that = this;
                        var oMe = this.getView().getModel("me");
                        var oRB = this.getView().getModel("i18n").getResourceBundle();

                        var sModelId = (oMe.getProperty("/ModelId") || "").trim().toUpperCase();
                        if (!sModelId) {
                                MessageToast.show(oRB.getText("modelIdRequired"));
                                return;
                        }

                        ChatService.saveModelCfg({
                                ModelId: sModelId,
                                ModelName: (oMe.getProperty("/ModelName") || "").trim(),
                                ModelDesc: oMe.getProperty("/ModelDesc") || "",
                                ModelType: oMe.getProperty("/ModelType") || "OLLAMA",
                                EndpointUrl: (oMe.getProperty("/EndpointUrl") || "").trim(),
                                Destination: (oMe.getProperty("/Destination") || "").trim(),
                                ApiModel: (oMe.getProperty("/ApiModel") || "").trim(),
                                ApiKey: oMe.getProperty("/ApiKey") || "", // 留空 = 不修改旧 Key
                                AuthType: oMe.getProperty("/AuthType") || "NONE",
                                Temperature: oMe.getProperty("/Temperature") || "",
                                MaxTokens: oMe.getProperty("/MaxTokens") || "",
                                TimeoutSec: oMe.getProperty("/TimeoutSec") || "",
                                IsActive: oMe.getProperty("/ActiveBool") ? "X" : "",
                                // V10：源码分析开关（勾选 = 参与解析；取消 = 后端跳过源码提取）
                                SkipSource: oMe.getProperty("/SkipSourceBool") ? "" : "X",
                                // V10：USER 禁看源码（勾选 = USER 用此模型不下发源码）
                                UserHideSrc: oMe.getProperty("/UserHideSrcBool") ? "X" : ""
                        }).then(function () {
                                that._oModelDialog.close();
                                MessageToast.show(oRB.getText("toastModelSaved"));
                                // 刷新下拉框与表格
                                that._applySettings();
                                ChatService.getModels().then(function (aModels) {
                                        that._fillModelTable(aModels);
                                });
                        }).catch(function (oErr) {
                                MessageToast.show(Formatter.escapeHtml((oErr && oErr.message) || String(oErr)));
                        });
                },

                /**
                 * V5：模型连通性测试（设置-模型管理表格"测试"按钮）。
                 * 后端 TestModel 发最小请求验证 网络/地址/鉴权/模型名，返回耗时与错误原因。
                 */
                onTestModel: function (oEvent) {
                        var sId = oEvent.getSource().data("modelId");
                        var oRB = this.getView().getModel("i18n").getResourceBundle();
                        if (!sId) {
                                return;
                        }
                        if (ChatService.getMode() !== "backend") {
                                MessageToast.show(oRB.getText("mockTest"));
                                return;
                        }
                        MessageToast.show(sId + "：" + oRB.getText("testing"));
                        ChatService.testModel(sId).then(function (oRes) {
                                if (oRes.success) {
                                        sap.m.MessageBox.information(sId + "\n" + oRes.message, { title: oRB.getText("testConn") });
                                } else {
                                        sap.m.MessageBox.error(sId + "\n" + oRes.message, { title: oRB.getText("testConn") });
                                }
                        }).catch(function (oErr) {
                                sap.m.MessageBox.error(sId + "\n" + ((oErr && oErr.message) || String(oErr)), { title: oRB.getText("testConn") });
                        });
                }
        };
});
