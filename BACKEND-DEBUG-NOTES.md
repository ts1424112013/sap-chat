# BACKEND-DEBUG-NOTES（V8 现行版）

> 2026-09-03 精简重写：**历史已解决问题已删除**（V5.x 认证时序、代理模式、
> append_msg 并发主键冲突等均已修复并内置，详见 CHANGE-HIGHLIGHTS.md 存档）。
> 本手册只保留：现行认证模型、排查工具、常见错误速查、验证清单。

---

## 一、现行认证模型（V8，排查前必读）

```
登录框 → Basic(账号:网关密码) → POST /Login
            ├─ 网关层：SU01 标准验密（密码错 = 401，业务代码不执行）
            └─ 业务层：ZAI_CHAT_USER 授权表
                       ├─ 已登记且 ACTIVE='X' → 返回 Role（ADMIN/USER）
                       └─ 未登记/停用 → "该账号未开通 SAP AI 使用权限"
登录成功后：同一账密自动注入 OData Basic 头（localStorage zaiChat-sapAuth）
```

由此得到判别原则：
- **401 = 网关认证失败**（账密错/SU01 锁定）→ 与权限表无关；
- **"未开通权限" = 网关验密已过、授权表没这个人** → 找管理员开通；
- **"该操作仅管理员可执行" = 已登录但角色是 USER** → 属正常权限拦截，非故障。

## 二、排查工具

| 工具 | 用途 |
|---|---|
| `/IWFND/GW_CLIENT` | 网关侧直接调 Function Import / EntitySet，绕开前端排查后端问题 |
| `/IWFND/ERROR_LOG` | 网关错误日志（找 404/500 的根因与短文本） |
| 浏览器 F12 → Network | 看请求实际 URL、状态码、请求头 Authorization 是否携带 |
| SE16 / SE16N | 查 ZAI_CHAT_USER / ROLE / PROMPT / CFG / MODEL_CFG 表数据 |

## 三、常见错误速查（V8）

| 症状 | 根因 | 处理 |
|---|---|---|
| 登录提示"登录服务暂不可用" | `Login` FI 未创建 / 运行时未重新生成 / 服务未激活 | 按增量指南第二步重做；/IWFND/GW_CLIENT 直调验证 |
| 调任何 V8 接口 404 | FI 名称与 SEGW 不一致（RolesList 等 9 个，大小写不敏感但拼写必须一致） | 核对 SEGW FI 清单；确认运行时已重新生成 |
| 401（登录前） | SU01 密码错/锁定；或代理模式 ui5.yaml 凭据过期 | 用浏览器直访服务地址验证账密 |
| "该账号未开通..." | ZAI_CHAT_USER 无此人或 ACTIVE≠'X' | SE16 补记录（管理员从用户管理页签开通） |
| "该操作仅管理员可执行" | 当前账号 ROLE≠ADMIN | 正常权限拦截；管理员在用户管理调整角色 |
| RolesList 返回空 | 表无启用数据（ACTIVE≠'X'被过滤） | SE16 检查 ACTIVE 字段 |
| SaveRoles/SavePrompts 报 JSON 解析失败 | 前端传 JSON 文本，后端 /ui2/cl_json 反序列化失败 | 检查 FI 参数是否完整传到（v8_param 按名匹配） |
| 配置后端地址后 admin 仍能登录 | INITIALIZED 未写入 | SE16 查 ZAI_CHAT_CFG 是否有 INITIALIZED='X'；确认 v8_save_config 联动代码已粘贴 |
| 登录成功但消息列表 401 | Basic 未注入（localStorage zaiChat-sapAuth 为空） | 前端 appLogin 成功必然注入；若手动清过缓存则重新登录 |
| 直连模式（后端地址填了）接口报 CORS/网络错 | 浏览器直连网关被跨域拦截 | 后端地址**留空走本地代理**，或在网关侧放行 CORS |
| 提问带 Z 对象名直接报"源码提取失败" | 后端还是旧版 ZCL_AI_CHAT_SERVICE | 用仓库最新版整类重新粘贴激活（V1.5 已降级为纯对话） |

## 四、运行模式与数据存放（现行）

| | 演示模式（mock） | 后端模式（backend） |
|---|---|---|
| 会话/消息 | 浏览器 localStorage `zaiChat.mockData` | ZAI_CHAT_SESS / ZAI_CHAT_MSG（按用户隔离） |
| 角色 | `zaiChat-roles` | ZAI_CHAT_ROLE（经 RolesList/SaveRoles） |
| 泡泡 | `zaiChat-quickPrompts` | ZAI_CHAT_PROMPT |
| 用户/权限 | `zaiChat.mockUsers`（仅演示） | ZAI_CHAT_USER |
| 登录 | 本地校验（admin 初始 123456 / 演示身份） | 网关 Basic + 授权表 |
| 多标签页 | storage 事件同步（角色/泡泡/登录态） | 天然共享（同一后端表） |

## 五、联调验证清单（每次后端增量发布后按序执行）

1. `/IWFND/GW_CLIENT` 逐个直调 V8 九个接口（对照 `ZAI_CHAT_V8_ADMIN.abap` 文件尾清单）；
2. 前端登录：admin 路径（仅未初始化环境）或真实 SU01 账号；
3. 管理员：改一个角色名 → 刷新/另开浏览器确认共享；加一条泡泡 → 回首页可见；
4. 普通用户（USER）：确认无＋泡泡、角色只读、设置不可编辑；
5. 提问带一个**不存在的 Z 对象名** → 应得到正常回复 + meta"对象不存在，已按普通对话处理"（V1.5）；
6. 提问带一个**真实存在的** Z 对象名 → 回复带源码分析（验证 V1.5 未误伤正常路径）。

## 六、安全注意事项（持续有效）

- 授权表不存密码：密码真伪永远由网关（SU01 策略）裁决；
- 管理 action 双保险：前端隐藏 + `v8_require_admin` 硬校验；
- 前端登录失败限速：5 次锁 60 秒（`zaiChat.loginLockTs`）；建议网关侧再配 IP 限速；
- 初始管理员 admin/123456：仅初始化窗口 + 首登强制改密；INITIALIZED='X' 后永久失效；
  **生产环境发布后应尽快完成首次配置，缩短弱口令窗口期**；
- API Key 仍存 ZAI_MODEL_CFG（后端侧），前端只在模型管理里读写，不落浏览器。

---

## 附：历史已解决问题归档说明

以下问题均已修复并内置到当前代码，排查时**无需再怀疑**；细节过程见
《CHANGE-HIGHLIGHTS.md》对应版本章节：

| 问题 | 修复版本 | 位置 |
|---|---|---|
| ODataModel 构造后才 setHeaders 导致 metadata 401 卡死 | V5.2 | ChatService._getModel（构造参数携带凭据） |
| 直连/代理模式认证头不生效 | V5.1~V5.2 | ChatService 统一 _basicHeader 注入 |
| 多窗口并发发消息 append_msg 主键冲突丢消息 | 后端 V1.4 | ZCL_AI_CHAT_SERVICE.append_msg（MAX+1） |
| detect_program 正则 \b 异常 | V1.3 | ZCL_AI_CHAT_SERVICE（已换实现） |
| MAX_TOKENS=0 被云端拒绝 / Ollama 默认 128 截断 | V1.2 | ZCL_AI_LLM_CLIENT |
| UI5 1.15x 移除 addLayoutData | 固定引导 1.130.0 | index.html |
| 泡泡/角色管理弹窗底色透明 | V8 | style.css（.sapMDialog 显式底色） |
