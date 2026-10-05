sap.ui.define([
	"sap/ui/core/UIComponent",
	"zai/chat/model/models"
], function (UIComponent, models) {
	"use strict";

	/**
	 * 应用组件：加载 manifest、设备模型。
	 * 业务数据模型(chat/settings)由控制器初始化，OData 模型由 ChatService 按需惰性创建。
	 */
	return UIComponent.extend("zai.chat.Component", {

		metadata: {
			manifest: "json"
		},

		/**
		 * 组件初始化
		 * @public
		 */
		init: function () {
			// 调用父类初始化（加载 rootView、i18n 模型等）
			UIComponent.prototype.init.apply(this, arguments);

			// 设备模型：用于响应式布局判断（桌面/平板/手机）
			this.setModel(models.createDeviceModel(), "device");
		}
	});
});
