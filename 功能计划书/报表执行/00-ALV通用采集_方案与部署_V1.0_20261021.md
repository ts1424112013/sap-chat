# 报表执行重构：ALV 通用采集（报表程序零改动）

> 日期：2026-10-21 ｜ 状态：**已编码，未部署** ｜ 范围：**只取 ALV 数据交给模型分析**（经典 WRITE 列表 / Excel / 邮件 / 落库等输出不在范围内）

## 1. 改了什么

| 以前 | 现在 |
|---|---|
| 每个 TCode 报表都要改代码：加 `P_AICAP` / `P_RUNID` 两个 NO-DISPLAY 参数，写一段 `FORM ai_capture`，手工列出结果结构（ZRMM_IDP_0702 就是这样改的） | **报表程序一行不改**。登记 `ZAI_RPT_DEF` / `ZAI_RPT_PARAM` 就能执行并拿到 ALV 结果 |
| 后台作业直接跑业务报表，靠程序自己落 `ZAI_RPT_RESULT` | 后台作业跑 `ZAI_RPT_RUNNER`，由它 `SUBMIT` 业务报表（`AND RETURN`）、**抑制 ALV 显示**、从 `CL_SALV_BS_RUNTIME_INFO` 取回 ALV 输出表，再统一落 `ZAI_RPT_RESULT` |
| 结果列标题 = 字段名 | 列标题取自 ALV 字段目录（如 `Part Name`、`樓層`），模型更容易读懂 |

下游全部不动：`ZAI_RPT_RESULT` → `read_result` → 结果索引 `ZAI_ARTIFACT` → 前端表格 / 交给模型分析，链路与之前一致。前端无改动。

```
前端 StartReportRun
  → REPORT_SERVICE.start_run（校验、冻结参数到 ZAI_RPT_RUN）
  → EXEC_SAP.submit：JOB_OPEN → SUBMIT ZAI_RPT_RUNNER（只带运行号）→ JOB_CLOSE
       ┌───────────────── 后台作业内 ─────────────────┐
       │ ZAI_RPT_RUNNER → EXEC_SAP.run_captured        │
       │   读运行记录 + 复核登记/归属 → build_seltab    │
       │   → ZCL_AI_ALV_CAPTURE.run                     │
       │       cl_salv_bs_runtime_info=>set(display=否) │
       │       SUBMIT <业务报表> WITH SELECTION-TABLE   │
       │       取回 ALV 表 + 列标题 → 逐行 JSON         │
       │   → 写 ZAI_RPT_RESULT（0 行=元数据，1.. 数据） │
       └────────────────────────────────────────────────┘
  → poll（TBTCO 状态）→ READY → read_result → 前端 / 模型
```

## 2. 新增 / 修改对象

| 对象 | 类型 | 说明 |
|---|---|---|
| `ZCL_AI_ALV_CAPTURE` | SE24 类（新） | 通用采集引擎，只依赖标准类；也可被别处直接调用：`zcl_ai_alv_capture=>run( iv_program it_seltab ... )` |
| `ZCL_AI_ALV_LABELS` | SE24 类（新） | 读 ALV 字段目录的列标题。**可选**：它引用的 `get_metadata` 签名在本系统未核对，故隔离成单独的类，由采集类动态调用；它激活失败或不存在，只丢列标题（退化为字段名），照常取数 |
| `ZCL_AI_REPORT_EXEC_SAP` | SE24 类（改，V1.1） | `submit` 改跑运行器；新增 `run_captured`；`poll` 识别采集失败；`read_result` 读元数据行 |
| `ZAI_RPT_RUNNER` | SE38 可执行程序（新） | 作业入口，约 5 行。程序名与参数不取自选择屏，只读运行记录，并复核登记，手工运行也无法借它执行任意程序 |
| `ZAI_TEST_ALV_CAPTURE` | SE38 可执行程序（新，验证用） | 对任意报表跑一遍采集并打印列 / 前几行，不经过 AI 助手 |

**不新增 SE11 对象，不改 `ZCL_AI_REPORT_SERVICE`、DPC、前端。** 旧的 `ZRMM_IDP_0702` 不用改也不用回退（见 §7）。

## 3. 你给的 8 个程序的适配核对

结论：**7 个走 `REUSE_ALV_GRID_DISPLAY`（0021 另有 `REUSE_ALV_LIST_DISPLAY`），`ZRMM_IDP_0018` 走 `CL_SALV_TABLE`（`display2`），都在标准采集口覆盖范围内，理论上零改动可取**。以下按源码走查（未在 SAP 上跑过，以 §6 的现场验证为准）。

| 程序 | 取数后的出口 | 登记时要注意 |
|---|---|---|
| `ZRSD_IDP_0012` | `write_alv` → ALV Grid | `p_plant` 是 SELECT-OPTION（必填，`SEL_KIND=S`），经 `ZRFC_MM_IDP_0104` 过工厂权限；无权限 `MESSAGE i` + `STOP` → 无 ALV（见 §5） |
| `ZRSD_IDP_0033` | ALV Grid（带抬头 `REUSE_ALV_COMMENTARY_WRITE`） | 抬头事件在抑制显示时不触发，不影响数据；`CALL TRANSACTION 'VA03'` 只在 ALV 点击回调里，不会触发 |
| `ZRMM_IDP_0129_A` | ALV Grid | `p_werks` 必填；无数据时 `MESSAGE i` + `STOP` |
| `ZRMM_IDP_0003C` | `p_alv` 时 `write_alv` | ⚠ 输出方式单选组 `gp3` 里 `p_bakjob`（写 FTP 文件）/ `p_format`（Excel OLE）/ `p_bi`（发 BI）/ `p_cache`、`p_global`（`MODIFY` 缓存表）**一律不要登记**；`p_alv` 本身 `DEFAULT 'X'`，不登记即走 ALV。`p_proc`（并行数）不登记，默认 1 |
| `ZRMM_IDP_0018` | `p_alv` 时 `display2` → `CL_SALV_TABLE`（旧的 `call_alv_for_list` 已被注释掉） | ⚠ `p_send` / `p_mail` / `p_sbt`（发邮件）不要登记；`p_alv` 默认 `X` |
| `ZRSD_IDP_0021` | ALV Grid / List | `BAPI_GOODSMVT_CREATE`（建调拨单）只在 ALV 工具栏 `&CREATE` 回调里，抑制显示后不会触发。`h1–h4`、`r1/r2` 单选组没有默认值，需要时登记为 BOOL 参数 |
| `ZRMM_IDP_0159` | ALV Grid | `sdocyear` 必填；`alv_def`（ALV 布局变式）不需要登记 |
| `ZRMM_IDP_0161` | ALV Grid（`s_down` 只决定走哪个 ALV 调用） | 双击进入的 `CALL SCREEN 2000`（`UPDATE` / `DELETE zidpmmtlk`）是 ALV 回调，抑制显示后不会触发；无数据时 `MESSAGE i888` 且不调 ALV → 无 ALV（见 §5） |

通用登记要点：

- `ZAI_RPT_DEF`：`PROGNAME` = 程序名（如 `ZRSD_IDP_0012`），`EXEC_ENABLED='X'`，`ACTIVE='X'`，`MAX_ROWS` = 给前端 / 模型的样例行数。
- `ZAI_RPT_PARAM`：`ABAP_NAME` = 选择屏名称，`SEL_KIND`：`P`=PARAMETER、`S`=SELECT-OPTION，`REQUIRED` 对应 `OBLIGATORY`；SELECT-OPTION 日期范围登记为 `DATE` + `RANGE_ALLOWED='X'`，前端传 `"20261001,20261009"` → `BT`。
- **只登记业务条件，不登记输出方式 / 下载 / 邮件 / 上传 / 删除类选项**：这是目前唯一的"防误操作"手段（白名单 = 登记了才会下发）。
- 值需是内部格式（物料号补零等由登记 / 前端负责，本次不动）。
- 已有的限制，这次没动：程序里 `DEFAULT 'X'` 的单选按钮无法通过配置关闭（空值不下发，保持程序默认）。

## 4. 部署顺序

| 步骤 | 对象 | 备注 |
|---|---|---|
| 1 | SE24 `ZCL_AI_ALV_LABELS` | 整类粘贴。**激活报 `s_type_metadata` / `get_metadata` 相关错误 → 先不管，留未激活即可**，把报错发我（只影响列标题） |
| 2 | SE24 `ZCL_AI_ALV_CAPTURE` | 整类粘贴并激活 |
| 3 | SE24 `ZCL_AI_REPORT_EXEC_SAP`（V1.1） | 整类替换。贴后核对：`submit` 内有 `lv_runner` / `ZAI_RPT_RUNNER`；PUBLIC SECTION 有 `run_captured`；`read_result` 输出仍以 `{"columns":` 开头 |
| 4 | SE38 `ZAI_RPT_RUNNER`（类型 1） | 贴 `backend-abap/ZAI_RPT_RUNNER.abap` |
| 5 | SE38 `ZAI_TEST_ALV_CAPTURE`（类型 1） | 贴 `backend-abap/tests/ZAI_TEST_ALV_CAPTURE.abap` |
| 6 | 按 §6 验证 | 通过后再用 AI 助手跑一次登记报表 |

仍需 `REPORT_EXEC_REAL='X'`（走真实作业）；未部署运行器时，`submit` 会直接提示"ZAI_RPT_RUNNER 未部署"而不是留下空作业。

## 5. 结果语义（含失败）

| 情况 | 表现 |
|---|---|
| 正常取到 ALV | READY，行数 = ALV 总行数；入库最多 20,000 行，超出时摘要 `truncated=true`；前端样例行数仍受 `MAX_ROWS` 约束 |
| ALV 有表头但 0 行 | READY，0 行（有效的空结果） |
| 报表没走到 ALV（无数据 `STOP`、无权限 `STOP`、程序提前结束） | READY，0 行，摘要 `note` 写明原因范围，供前端 / 模型如实说明；具体原因看 SM37 作业日志 |
| 登记停用 / 程序名与登记不符 / 运行不属于作业用户 / 参数构建失败 / SUBMIT 异常 / 落表失败 | FAILED，原因写 `ZAI_RPT_RUN.ERROR_MESSAGE`，前端步骤条直接显示 |
| 报表里 `MESSAGE TYPE E/A` 或运行时错误 | 作业被取消 → FAILED（与以前相同；程序可选加 `p_aicap` 把"缺参数"升级成 `E`，见 §7） |

## 6. 现场验证（先做这一步再用 AI 助手）

`cl_salv_bs_runtime_info` 抑制显示 + 取数在**后台作业**里的表现是整个方案的唯一未验证假设，请按下面两步：

1. 在目标报表（建议先 `ZRMM_IDP_0129_A`，参数最少）选择屏填好条件，保存一个变式（如 `ZAI_T1`）。
2. `SA38` 前台运行 `ZAI_TEST_ALV_CAPTURE`：`P_PROG=ZRMM_IDP_0129_A`、`P_VARI=ZAI_T1`。
   - 期望：`已捕获 ALV: X`、列数与 ALV 一致、前几行 JSON 正确；"有标题的列"> 0 表示列标题取到了。
   - 前台运行时**不应弹出 ALV**；若弹出了，说明该报表的 ALV 不走标准采集口（把程序名发我）。
3. `SM36` 建一个后台作业跑同一程序、同一变式，到 `SM37` 看作业日志 / spool，应得到同样的输出（线上跑的就是后台作业，这一步才是验收）。
4. 再用 AI 助手执行一个登记报表，核对：`ZAI_RPT_RESULT` 有 `LINE_INDEX=0` 的元数据行 + 数据行；前端表格列标题正确；"交给模型分析"能读到数据。

## 7. 回退与兼容

- **回退开关**：`ZAI_CHAT_CFG` 键 `REPORT_CAPTURE_LEGACY='X'` → 恢复旧口径（作业直接跑业务报表并下发 `P_RUNID`，要求程序端有 `ai_capture`）。立即生效，无需重新部署。
- `ZRMM_IDP_0702` 保持现状即可：新口径下不下发 `P_RUNID`，它的 `ai_capture` 因 `P_RUNID` 为空直接返回，不会双写；`P_AICAP='X'` 仍会下发，它的"工厂为空 → `MESSAGE TYPE E`"保护照旧生效。
- **"改很少量的代码"的情形**：某报表想让"缺必填参数 / 无数据"直接判失败而不是 0 行，只需在程序里加一个 `PARAMETERS p_aicap TYPE c NO-DISPLAY.`，并在对应处 `IF p_aicap = 'X'. MESSAGE '…' TYPE 'E'. ENDIF.`（0702 就是这样，约 5 行）。

## 8. 已知边界

- 一次只取一份 ALV：报表在一次运行中多次调用 ALV，以最后一次为准。
- 自建 `CL_GUI_ALV_GRID`（放在 Custom Container 里）的报表不走标准采集口，取不到；需改成 `REUSE_ALV_*` / `CL_SALV_TABLE`，或单独做适配。
- 技术字段名以数字开头的 ALV 会让标准类动态建表失败（社区已知问题），此时作业会因运行时错误被取消 → FAILED。
- 行 JSON 用 `/ui2/cl_json` 序列化（与旧口径一致）：日期为 `YYYY-MM-DD`，数值为 JSON 数字，`N` 型保持字符串；ALV 输出表里若带内表 / 引用类型的列（如 `COLTAB`）已被跳过。
- 抑制显示后，ALV 的用户命令回调（双击 / 工具栏）不会被触发，所以 0021 的"建调拨单"、0161 的"维护"之类的写操作不会被误触发——但这是 `REUSE_ALV_*` 的行为推断，§6 的验证里请顺带确认 `ZRSD_IDP_0021` 没有产生物料凭证。
