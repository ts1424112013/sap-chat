# 部署说明：dist-deploy-20261030.zip（10-30 登录 403 修复 + 轻量包）

## 包里改了什么

针对《20261030_QAS_demo7登录链路排障实录》：

1. **换安全令牌改用 XHR**（ChatService `_fetchCsrf`，版本注释 V8.3csrf-xhr）：URL 加时间戳 + `If-Modified-Since: 1970`，不走浏览器缓存的 304；用 XHR 读响应头里的令牌。与现场补丁同一做法，已进 webapp 源码。
2. **登录提示分开**：401 =「账号或密码不正确」；403 =「账号密码已通过，但网关安全令牌校验未通过（403）……」。403 和服务不可用不再计入「5 次失败锁 1 分钟」。
3. **页面由 SAP 提供时（/sap/bc/ui5_ui5/、/sap/bc/bsp/）不再在登录前探测后端**：去掉那条不带凭据、会收到 401 的 `$metadata` 请求（排障实录 3.3）。本地开发（ui5 serve）照旧探测、不通就降级演示模式。

## 文件数

| 包 | 文件数 | 大小 |
|---|---|---|
| 完整 dist（10-29 部署用的） | 10,480 | 140 MB |
| 10-29 精简包 | 2,737 | 46 MB |
| **本包** | **2,055** | 40 MB（zip 10.6 MB） |

去掉的都是浏览器正常使用时不会加载的：.map、-dbg 调试版、.less、测试框架、设计时 designtime、支持助手规则、flexibility（包里没有 sap.ui.fl）、fiori_3 主题、中英以外语言的标准控件文字包。日期数字格式数据（cldr）全部保留。
其他语言的浏览器打开时，标准控件文字（如「无数据」）显示英文；本应用自己的文字本来就只有中文。

## ⚠️ 上传前先做 1 分钟验证（决定传了有没有用）

复核排障实录截图后发现，「fetch 读不到令牌」证据不足：
- 图 9、图 11 的 Login 请求头列表按字母排序，截图停在 `User-Agent`，而 `x-csrf-token` 排在它后面 —— 「请求头没有令牌」看不出来；
- 图 15 只用 XHR + 正确密码拿到了令牌，没有用 fetch 做同条件对照，也没有带令牌发一次 Login；
- 图 9 里服务器下发的 cookie 是 `SAP_SESSIONID_A4Q_970=…; secure; HttpOnly; SameSite=None`，带黄色警示 = 浏览器在 http 页面拒存。SAP 校验 POST 的令牌要配合 cookie，cookie 存不下，令牌对也会 403 Required。

所以本包的 XHR 修复不一定能让登录通过。**先在 QAS 上跑下面这段，看第 ② 行的状态码**（任一同域页面都行，例如直接打开 `http://sapgls4qas.idpbg.efoxconn.com:8000/sap/opu/odata/sap/ZAI_CHAT_SRV/$metadata?sap-client=970`，F12 → Console，先手输 `allow pasting` 再粘贴）：

```js
(async () => {
  const user = prompt('SAP 账号');
  const pass = prompt('密码（这里会明文显示，只在本页用一次）');
  const basic = 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + pass)));
  const base = '/sap/opu/odata/sap/ZAI_CHAT_SRV/';
  const send = (method, url, headers) => new Promise((done) => {
    const x = new XMLHttpRequest();
    x.open(method, url, true);
    Object.keys(headers).forEach((k) => x.setRequestHeader(k, headers[k]));
    x.onloadend = () => done(x);
    x.send();
  });
  const a = await send('GET', base + '$metadata?sap-client=970&_=' + Date.now(),
    { Authorization: basic, 'x-csrf-token': 'fetch', 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' });
  const token = a.getResponseHeader('x-csrf-token') || '';
  console.log('① 换令牌', a.status, token ? '拿到令牌' : '没有令牌');
  const b = await send('POST', base + 'Login?sap-client=970',
    { Authorization: basic, 'x-csrf-token': token, Accept: 'application/json' });
  console.log('② Login', b.status, b.getResponseHeader('x-csrf-token') || '', b.responseText.slice(0, 200));
})();
```

| 结果 | 说明 | 下一步 |
|---|---|---|
| ① 200 拿到令牌，② **200** | 带上令牌就能登录，前端修复够用 | 按下面步骤上传本包 |
| ① 200 拿到令牌，② **403** Required | cookie 问题：令牌对，但服务器拿不到配套 cookie。传本包也还是 403 | 先找 Basis，三选一：① 改用 HTTPS 地址打开（推荐）；② 查 ICM 给 cookie 加 `SameSite=None; Secure` 的改写规则，改成只对 HTTPS 生效，或对比 DEV 的配置；③ QAS 临时验证可在 SICF 的 ZAI_CHAT_SRV 节点设 GUI 参数 `~CHECK_CSRF_TOKEN=0`（关掉该服务的 CSRF 校验，有安全代价，不要带到生产）。改完再跑一次这段 |
| ① **401** | 账号密码不对 | 停手，按排障实录规则 1 先在 SAP GUI 确认账号，不要连续试 |

## 上传步骤

1. 解压 zip，得到一个文件夹（里面直接是 `index.html`、`Component-preload.js`、`resources/` 等）。
2. **建议传到新的 BSP 名（如 ZAI_CHAT_DEMO8）**：确认弹窗里应该只有上传清单，约 2,055 个文件，没有删除项。
   - 如果传到原来的 ZAI_CHAT_DEMO7：更新模式会把本包里没有的几千个文件列成「删除檔案」（都是上面说的调试版 / .map / 其他主题等）。这是本包的预期，但和排障实录规则 4「出现删除清单就取消」冲突，为免现场判断，直接用新 BSP 名更稳。
3. 用时估算：按 10-30 整包 10,480 个文件 6–7 小时折算，本包约 1–1.5 小时。仍建议低峰挂后台，中途不要打断。
4. 传完核对文件数 = 2,055。

## 验证

1. 无痕窗口 + F12 勾 Disable cache，打开 `…/sap/bc/ui5_ui5/sap/<BSP名>/index.html`。
2. 页面直接出登录卡片；登录前 Network 里不应有 `$metadata` 请求。
3. 登录后 Network 应看到：
   - `$metadata?_=<时间戳>`：200，响应头有 `x-csrf-token`
   - `Login`：200，请求头 `x-csrf-token` 和上一条响应里的值相同
4. Network 里 `72-Regular.woff2` 应为 200。10-30 那次 404 是这个文件没传上去（同一次的 `SAP-icons.woff2` 是 200，说明 woff2 能传）；本包里有这个文件（`resources/sap/ui/core/themes/sap_horizon/fonts/`）。
5. 注意：本包没有调试版，URL 加 `sap-ui-debug=true` 会找不到文件。
6. 截 Login 请求头时请滚到底或勾 Raw —— 列表按字母排序，`x-csrf-token` 在 `User-Agent` 后面。

本地已用模拟网关验证（2,055 个文件的包放在 /sap/bc/ui5_ui5/ 路径下）：登录前零请求；密码错提示 401 文案；强制 403 提示新文案；正常登录 200 进入主页；对话 / Agent / 设置页无缺文件。真实 QAS 未验证。
