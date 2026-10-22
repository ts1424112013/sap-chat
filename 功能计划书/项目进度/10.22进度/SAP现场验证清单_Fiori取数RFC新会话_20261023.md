# SAP 现场验证清单 · Fiori 取数改走 RFC 新会话（2026-10-23）

> **目的**：在 A4Q（client 970）上部署 `ZCL_AI_ODATA_CLIENT` V1.3 + 函数模块 `Z_AI_ODATA_GET`，证明 Fiori 取数**不建 SM59**也能正常、且身份仍是当前用户。
> **预计**：40 分钟（部署 15 + 验证 20 + 收尾 5）。
> **依据**：`docs/03-后端实施文档.md` 〇-D；仓库提交 `8ab7914` + `bfecf77`。原因分析见同目录《AI对话助手_双链排障实录_20261022.docx》。
>
> **三条规矩**
> 1. 按顺序做，**每一步都对照“期望”**；不符合就停下，翻到最后的「失败怎么办」。
> 2. 第 1、2 节不改任何配置，线上行为不受影响；**真正切换只在 3.1 改一个配置值**，随时能改回去。
> 3. 每一步的结果填进最后的「回传记录表」，有异常就截图。

---

## 0. 动手前（5 分钟）

- [ ] **代码版本对**：拿到的是 `bfecf77` 版——
  - `backend-abap/ZCL_AI_ODATA_CLIENT.abap`：406 行，文件头有 `V1.3    20261022`
  - `backend-abap/Z_AI_ODATA_GET.abap`：文件头有 `V1.0    20261022`
  - `backend-abap/tests/ZAI_TEST_ODATA_INTERNAL.abap`：文件头有 `V1.1 20261022`
- [ ] **记下现在的配置**（SE16 `ZAI_CHAT_CFG`），填进回传表：

  | 键 | 现在的值 | 说明 |
  |---|---|---|
  | `FIORI_HTTP_DEST` | ______ | 空 = 现在走的是会 500 的直接内部调用；`TEST_Fiori` = 走 SM59 |
  | `FIORI_SELF_URL` | ______ | 现场加的，V1.3 不再读，3.1 删掉 |
  | `FIORI_ENABLED` | ______ | 应为 `X` |
  | `REPORT_CAPTURE_LEGAC` | ______ | 现场误建的截断键，应已删除；还在就删 |

  > 如果 `FIORI_HTTP_DEST` 现在是**空**：做完 1.1 之后，前端取数会立刻改走新通道，到 1.4 函数模块建好之前会提示“取数通道未部署”（友好提示，不是 500）。不想让别人看到这条提示，就先把它临时填成 `TEST_Fiori`，3.1 再清空。

- [ ] **备份**：SE24 打开 `ZCL_AI_ODATA_CLIENT` → 源代码模式 → 全选复制 → 存成本地文件 `ZCL_AI_ODATA_CLIENT_V1.2a_backup_20261023.txt`（回滚用）。
- [ ] **记下起点时间**：ST22 和 `/IWFND/ERROR_LOG` 各看一眼，记下最后一条的时间 ______。后面只看这个时间之后的新记录。

---

## 1. 部署（15 分钟）

- [ ] **1.1 SE24 重贴 `ZCL_AI_ODATA_CLIENT` V1.3**：源代码模式全选替换 → 按下面核对 → 激活。
  - PUBLIC SECTION 有 `get` / `http_get` / `check_uri` / `set_authorization` / `set_hdr_names`
  - `METHOD via_rfc` 里有 `DESTINATION 'NONE'` 和 `RFC_CONNECTION_CLOSE`
  - `METHOD http_get` 里有 `create_internal` 和 `create_by_destination`；有 `propertytype_logon_popup = if_http_client=>co_disabled`
  - 全文搜不到 `create_by_url`、`FIORI_SELF_URL`

- [ ] **1.2 三个引用者做语法检查**（Ctrl+F2，每个都应提示“无语法错误”）：
  - SE24 `ZCL_ZAI_CHAT_DPC_EXT`
  - SE24 `ZCL_AI_FIORI_REPORT_SERVICE`
  - SE38 `ZAI_FRPT_MAINT`

  > 任何一个报错：**立刻**把 0 步的备份贴回 `ZCL_AI_ODATA_CLIENT` 并激活，截图报错原文发回来，今天先到这里。（这一步防的是现场版本里还有仓库不知道的引用。）

- [ ] **1.3 SE80 新建函数组 `ZAI_ODATA`**：SE80 → 下拉选「函数组」→ 输入 `ZAI_ODATA` 回车 → 创建 → 短文本 `AI 助手 Fiori 取数` → 包和传输请求与 1.1 相同（**不要 `$TMP`**）→ 右键激活。

- [ ] **1.4 SE37 新建函数模块 `Z_AI_ODATA_GET`**（函数组 `ZAI_ODATA`，短文本 `Fiori 取数 RFC 新会话`）：
  - **「属性」页**：处理类型选 **远程启用模块** ★
  - **「导入」页**（每行都勾「值传递」）：

    | 参数名 | 类型 | 关联类型 | 缺省值 | 可选 | 值传递 |
    |---|---|---|---|---|---|
    | `IV_URI` | TYPE | `STRING` | | | ✓ |
    | `IV_TIMEOUT` | TYPE | `INT4` | `60` | ✓ | ✓ |
    | `IV_MAX_BYTES` | TYPE | `INT4` | `20971520` | ✓ | ✓ |

  - **「导出」页**（每行都勾「值传递」）：

    | 参数名 | 类型 | 关联类型 | 值传递 |
    |---|---|---|---|
    | `EV_CODE` | TYPE | `INT4` | ✓ |
    | `EV_REASON` | TYPE | `STRING` | ✓ |
    | `EV_BODY` | TYPE | `STRING` | ✓ |
    | `EV_BYTES` | TYPE | `INT4` | ✓ |
    | `EV_ERROR` | TYPE | `STRING` | ✓ |

  - **「例外」页**：不建。
  - **「源代码」页**：在系统生成的 `FUNCTION z_ai_odata_get.` 和 `ENDFUNCTION.` 之间（接口注释块下面）贴入：

    ```abap
      DATA ls_resp TYPE zcl_ai_odata_client=>ty_response.

      " iv_dest 不传 = create_internal(本会话没有外层网关请求)
      ls_resp = zcl_ai_odata_client=>http_get( iv_uri       = iv_uri
                                               iv_timeout   = iv_timeout
                                               iv_max_bytes = iv_max_bytes ).
      ev_code   = ls_resp-http_code.
      ev_reason = ls_resp-reason.
      ev_body   = ls_resp-body.
      ev_bytes  = ls_resp-bytes.
      ev_error  = ls_resp-error.
    ```
  - 激活。报“远程启用模块的参数必须值传递”→ 回导入 / 导出页补勾。

- [ ] **1.5 SE38 重贴 `ZAI_TEST_ODATA_INTERNAL` V1.1** → 激活。选择屏幕应多出一个 `P_CHAN`。

---

## 2. 关键前提验证 · SE38（5 分钟，不动任何配置）

> 方案里唯一没被证实的前提是：**在 RFC 新会话里，内部调用能像在 SE38 里一样正常**。这一节就是验证它。
> （SE37 单测函数模块是在当前会话里跑的，不经过 RFC，验证不了这一点，所以不用它。）

SE38 运行 `ZAI_TEST_ODATA_INTERNAL`，选择屏幕这样填：

| 字段 | 值 |
|---|---|
| `P_SELF` | **去掉勾** |
| `P_U1` | `/sap/opu/odata/sap/ZAI_CHAT_SRV/FioriReportDefs` |
| `P_U2`–`P_U4` | 空 |
| `P_CHAN` | 见下表 |
| 其余 | 不动 |

- [ ] **2.1 `P_CHAN = RFC`** → F8。**期望**：
  - `通道:` 后面是 `RFC`
  - `HTTP:` 后面是 `200`
  - 响应开头是 JSON：`{"d":{` …（里面能看到 `Success`）
  - 下面红色的“转换失败”**忽略**——这个地址不是报表，只用来测通道
- [ ] **2.2 `P_CHAN = INTERNAL`** → F8。**期望**：`通道: INTERNAL`、`HTTP: 200`（对照组：SE38 里直接调用本来就是好的）。
- [ ] **2.3（可选）`P_CHAN = TEST_Fiori`** → F8。**期望**：`HTTP: 200`（SM59 还在的话）。

**判定**：2.1 是 `HTTP: 200` → 前提成立，继续第 3 节。否则停，看「失败怎么办」。

---

## 3. 前端验证（15 分钟）

- [ ] **3.1 切换**：`ZAI_CHAT_CFG` 里 `FIORI_HTTP_DEST` **清空**（或删行）；`FIORI_SELF_URL` **删行**。改完立即生效。
- [ ] **3.2 取数**：前端（和昨天同一个入口）→ Fiori 报表 → shipment報表 →
  - 維度 = **ship mode**
  - 日期 = **2026-09-01 ~ 2026-09-30**（用已结束的月份，数字不会再变；10 月还在累计，和昨天 17:31 的数对不上）
  - 取数。**期望**：出表格，没有报错。
- [ ] **3.3 对数**：Fiori 里打开 shipment 页面，同样条件查询。**期望**：数字逐项一致。
- [ ] **3.4 运行记录**：SE16 `ZAI_FRPT_RUN`，按 `CREATED_AT` 找刚才那一行（`OWNER` = 自己）。**期望**：`RUN_STATUS = READY`、`HTTP_CODE = 200`、`ERROR_MESSAGE` 为空。记下 `RUN_ID`。
- [ ] **3.5 ST22**：0 步记下的时间之后，**没有** `GETWA_NOT_ASSIGNED` / `/IWCOR/CL_REST_HTTP_HANDLER`。
- [ ] **3.6 `/IWFND/ERROR_LOG`**：0 步记下的时间之后，**没有** `/IWFND/MED101`。
- [ ] **3.7 连取 5 次**：换着条件取（維度 region / BU / SITE，日期 2026-10-01 ~ 2026-10-22 等）。**期望**：每次都出数；做完再看一遍 3.5、3.6，仍然干净。
- [ ] **3.8 回归**：发一条普通聊天消息、执行一次 TCode 报表（如 `ZDPMM702`）。**期望**：都正常。

---

## 4. 身份验证（5 分钟，有合适账号才做）

需要一个账号：已开通 AI 助手（`ZAI_CHAT_USER` 里 `ACTIVE = X`），但**在 Fiori 里打不开 shipment 页面**。没有这样的账号就跳过，在回传表里写“未做”。

- [ ] **4.1** 用这个账号登录前端，按 3.2 的条件取数。**期望**：被拒（提示里有“没有这张报表的权限”或业务报错），`ZAI_FRPT_RUN` 这一行 `FAILED`。即：**Fiori 里看不到的，助手里也取不到**。

---

## 5. 收尾（全部通过后）

- [ ] `FIORI_HTTP_DEST` 保持空。
- [ ] **个人密码**：观察一天没有问题后，SM59 `TEST_Fiori` → 登录与安全 → 清掉个人账号和密码（或整个目标删除）。清掉之后，SM59 退路要重新填账号才能用。
- [ ] **（可选）删 DPC 诊断代码**：SE24 `ZCL_ZAI_CHAT_DPC_EXT` → 方法 `/IWBEP/IF_MGW_APPL_SRV_RUNTIME~EXECUTE_ACTION` → 删掉开头那整段 `TRY. DATA(lt_hdr) = io_tech_request_context->get_request_headers( ). … ENDTRY.` → 激活 → 发一条聊天消息确认正常。**不要整类重贴 DPC_EXT**。
- [ ] **传输**：`ZCL_AI_ODATA_CLIENT`、函数组 `ZAI_ODATA`（R3TR FUGR）、`ZAI_TEST_ODATA_INTERNAL` 放同一个传输请求。`ZAI_CHAT_CFG` 的行每个环境自己维护。
- [ ] 前端 `ChatService.js` 里现场手改的“POST 每次取新令牌”不用现在动，下次正式部署前端时会恢复为仓库版。

---

## 失败怎么办

| 在哪一步 | 看到什么 | 说明 | 怎么做 |
|---|---|---|---|
| 1.2 | 某个对象语法错误 | 现场版本里有仓库不知道的引用 | 贴回备份并激活，报错原文截图发回 |
| 1.4 | 激活报参数必须值传递 | 导入 / 导出页漏勾 | 补勾再激活 |
| 2.1 | `取数通道未部署` | 函数模块没建或没激活 | 回 1.4 |
| 2.1 | `RFC 新会话取数失败 …`，原文含“远程”或 `remote` | 属性页没选远程启用模块 | 回 1.4 属性页 |
| 2.1 | `RFC 新会话取数失败 …`，原文含 `S_RFC`、`RFC authorization` 或“RFC 权限” | 用户缺 RFC 权限 | 请 Basis 给角色加 `S_RFC`：`RFC_TYPE = FUGR`、`RFC_NAME = ZAI_ODATA`、`ACTVT = 16`，再做 2.1 |
| 2.1 | `HTTP: 403`，错误里有 `/IWFND/MED/101` | **新会话里内部调用也被拒，方案前提不成立** | 停，不做第 3 节；`FIORI_HTTP_DEST` 填 `TEST_Fiori` 保证可用；把 2.1 完整输出截图发回 |
| 2.1 | `HTTP: 401` 或其他非 200 | 同上，原因不同 | 同上 |
| 3.2 | 仍报 500，或 ST22 有新 GETWA | 外层请求仍受影响 | `FIORI_HTTP_DEST` 填回 `TEST_Fiori` 恢复取数；ST22 那条 dump 的“调用栈”和“源代码摘录”截图 + `ZAI_FRPT_RUN` 那一行发回 |
| 3.2 | 报 403，错误里有 `MED/101` | 同上 | 同上 |
| 3.2 | 报“RFC 新会话取数失败 …” | 前端用户与 SE38 用户权限不同 | 看原文；`S_RFC` 同 2.1 那行处理 |
| 3.3 | 数字与 Fiori 不一致 | 参数映射或口径问题，与通道无关 | 记下 `RUN_ID` 和 `REQUEST_URI` 发回，不影响本次结论 |
| 4.1 | 无权限账号也取到了数 | 身份不是当前用户（不应发生） | 立刻把 `FIORI_ENABLED` 置空关掉 Fiori 报表，截图发回 |

**一键退回**：任何时候 `FIORI_HTTP_DEST` 填回 `TEST_Fiori`，前端立刻改走 SM59（V1.3 保留这条通道），不用改代码。

---

## 回传记录表（做完拍照或填好发回）

| 项 | 结果 |
|---|---|
| 0 · 原 `FIORI_HTTP_DEST` / `FIORI_SELF_URL` | |
| 0 · 起点时间 | |
| 1.2 · 三个对象语法检查 | |
| 2.1 · `P_CHAN = RFC`：HTTP 码 / 耗时（毫秒） | |
| 2.2 · `P_CHAN = INTERNAL`：HTTP 码 / 耗时 | |
| 2.3 · `P_CHAN = TEST_Fiori`：HTTP 码 / 耗时（可选） | |
| 3.2 · 前端出数？ | |
| 3.3 · 与 Fiori 页面一致？ | |
| 3.4 · `RUN_ID` / `RUN_STATUS` / `HTTP_CODE` / `ELAPSED_MS` | |
| 3.5 · ST22 新 dump？ | |
| 3.6 · ERROR_LOG 新 MED101？ | |
| 3.7 · 5 次结果 | |
| 3.8 · 聊天 / TCode 报表回归 | |
| 4.1 · 无权限账号结果（或“未做”） | |
| 5 · 已做的收尾项 | |
