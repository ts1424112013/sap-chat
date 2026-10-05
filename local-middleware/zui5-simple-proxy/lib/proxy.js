"use strict";

/**
 * =====================================================================
 * zui5-simple-proxy —— 零依赖本地代理中间件
 * =====================================================================
 * 作用: 把应用发出的 /sap 前缀请求转发到配置的 SAP 服务器,
 *       使 localhost:8080 与网关"同源", 从根本上避免 CORS 问题。
 *
 * 为什么自己写: ui5-middleware-simpleproxy v3 依赖 Node 20.12+ 的
 * util.styleText, 在 Node 18 环境下 npm start 直接报错。
 * 本实现只用 Node 内置模块, Node 18 / 20 / 22 均可运行。
 *
 * 用法(应用根目录 ui5.yaml):
 *   server:
 *     customMiddleware:
 *       - name: zui5-simple-proxy
 *         afterMiddleware: compression
 *         mountPath: /sap
 *         configuration:
 *           baseUri: "http://your-sap-host:8000"
 *           # httpHeaders: { Authorization: "Basic xxx" }   可选
 *           # strictSSL: false                              可选(自签名证书)
 * =====================================================================
 */
module.exports = function ({ options }) {
	var http = require("http");
	var https = require("https");
	var URL = require("url").URL;

	var cfg = (options && options.configuration) || {};
	var baseUri = String(cfg.baseUri || "").replace(/\/+$/, "");
	var strictSSL = cfg.strictSSL !== false; // 默认校验证书
	var extraHeaders = cfg.httpHeaders || {};
	var mountPath = (options && options.mountPath) || cfg.mountPath || "";

	// 未配置 baseUri 时直接放行(不代理)
	if (!baseUri) {
		return function (req, res, next) { next(); };
	}

	var base = new URL(baseUri);
	var isHttps = base.protocol === "https:";
	var transport = isHttps ? https : http;

	return function proxy(req, res, next) {
		// connect 挂载在 /sap 时可能已剥掉前缀, 这里补回, 保证原样转发
		var path = req.url;
		if (mountPath && mountPath !== "/" && path.indexOf(mountPath) !== 0) {
			path = mountPath + path;
		}

		var headers = Object.assign({}, req.headers, extraHeaders);
		headers.host = base.host; // 上游期望收到它自己的主机名

		var reqOptions = {
			protocol: base.protocol,
			hostname: base.hostname,
			port: base.port || (isHttps ? 443 : 80),
			method: req.method,
			path: path,
			headers: headers
		};
		if (isHttps && !strictSSL) {
			reqOptions.rejectUnauthorized = false; // 仅开发环境使用
		}

		var upstream = transport.request(reqOptions, function (pres) {
			// 原样回写状态码/响应头(包含 401 -> 浏览器会自动弹登录框)
			res.writeHead(pres.statusCode || 502, pres.headers);
			pres.pipe(res);
		});

		upstream.on("error", function (err) {
			res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("zui5-simple-proxy: 无法连接目标服务器 " + baseUri + "\n" +
				err.message + "\n请检查 ui5.yaml 中 baseUri 是否正确、SAP 服务器是否可达。");
		});

		req.pipe(upstream);
	};
};
