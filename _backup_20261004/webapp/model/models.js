sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"sap/ui/Device"
], function (JSONModel, Device) {
	"use strict";

	return {

		/**
		 * 创建设备模型（桌面/系统信息），供视图做响应式绑定
		 * @returns {sap.ui.model.json.JSONModel} 设备模型
		 */
		createDeviceModel: function () {
			var oModel = new JSONModel(Device);
			oModel.setDefaultBindingMode("OneWay");
			return oModel;
		}
	};
});
