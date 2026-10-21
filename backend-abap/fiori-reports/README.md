# Fiori 报表登记文件（一张报表一个 JSON）

用 SE38 `ZAI_FRPT_MAINT` 导入（`P_IMP`，先勾 `P_TEST` 校验，再去掉勾保存），导出用 `P_EXP`。只有 `ZAI_CHAT_USER` 角色为 ADMIN 的账号能保存。设计见 `功能计划书/Fiori报表分析/01-方案与开发计划`（§4.2 参数 → `$filter`，§4.3 返回结构，§5 表结构）。

`SHIPMENT.json` 是 shipment 報表的登记文件（2026-10-21 按真实抓包填）：維度 → `Group`，日期 → `BegDat` / `EndDat` 都用 `eq`，`active = "X"`；SITE / MODEL / REGION / BU 的 `odataProp` 还空着（只校验、不进 `$filter`），等从 `$metadata` 查到属性名再补。

> 需要 `ZCL_AI_FIORI_REPORT_SERVICE` **V1.0.1** + `ZAI_FRPT_MAINT` **V1.1**（2026-10-21）。V1.0 有个 bug：不管 JSON 写得对不对，导入都报"reportId 必填 / paramId 必填"。

## 新增一张报表

1. **抓请求**：在 Fiori 页面按 F12 → Network，点查询，找到 OData 请求（多数在 `$batch` 的 Payload 里，形如 `GET DynamiFIELDSet?$filter=...&$expand=...`）。把整行抄下来。
2. **写登记文件**：复制 `SHIPMENT.json` 改一份（一张报表一个文件）。从抓到的请求里抄：
   - 服务路径 → `servicePath`（`/sap/opu/odata/sap/<服务名>`）；`?` 前面的实体集 → `entitySet`；`$expand=` 后面 → `expandNav`。
   - `$filter` 里每个条件 → 一个参数：
     - `Site eq 'HHZZ'` → `odataProp: "Site"`、`filterOp: "IN"`（多值）或 `"EQ"`、`valueFmt: "STRING"`
     - `BegDat ge datetime'2026-10-01T00:00:00' and EndDat le datetime'...'` → `odataProp: "BegDat"`、`odataPropTo: "EndDat"`、`filterOp: "BT2"`、`valueFmt: "DATETIME"`（两端都是 `eq` 就再写 `opFrom: "eq"`、`opTo: "eq"`）
     - 日期如果是 `BegDat eq '20261001'` 这种不带 `datetime` 的，`valueFmt` 改成 `"STRING"`
   - 还不知道属性名的参数，`odataProp` 先留空（只校验、不进 `$filter`）。
   - 给必填参数配上默认值（`defaultType`），第 3 步才能预演和试取。
3. **校验 + 试取**：SE38 `ZAI_FRPT_MAINT` → 选「导入登记 JSON」→ F4 选文件 → **勾着**「只校验不保存」和「试取一次」→ F8。看三段输出：
   - **参数一览**：每个参数映射到哪个 OData 属性、默认值是什么；
   - **按默认值预演**：拼出来的 `$filter` 和 URI —— 和第 1 步抓到的请求**逐项对**（属性名、`eq/ge/le`、值的写法）；
   - **试取一次**：真实调用一次（只读），打印 HTTP 码、列、前几行和后端统计 —— 和 Fiori 页面同条件的数字对上。
4. **保存**：去掉「只校验不保存」的勾，再 F8。选「列出已登记报表」确认。
5. **前端**：`ZAI_CHAT_CFG` 里 `FIORI_ENABLED = X` 时，前端「Fiori 报表」目录里就能看到它（`active = "X"`）→ 点开取数，再和 Fiori 页面对一次。

改已登记的报表：选「导出登记 JSON」，填报表编号，「JSON 文件」填一个保存路径（不填就打印到屏幕）→ 改 → 照第 3、4 步导回去（整份覆盖，参数以文件为准）。

## 导入报错怎么看

报错会一次列出全部问题，每条指明是哪个字段、读到的值是什么：

| 报错 | 原因 |
|---|---|
| `reportId「」必填…` / `第 N 个参数: paramId「」必填…` | 键名写错（区分大小写，是 `reportId` / `paramId`），或值是空的 |
| `reportId「ship-ment」…只能是大写字母、数字、下划线` | 值里有不允许的字符 |
| `只有 ADMIN 可以维护 Fiori 报表登记` | 当前 SAP 账号在 `ZAI_CHAT_USER` 里的角色不是 ADMIN |
| `不是合法 JSON` | 多了 / 少了逗号、引号、括号（可以先拿 JSON 校验工具检查） |
| 预演里写"默认值不全, 没法预演" | 必填参数没有默认值 —— 补 `defaultType`，或者直接保存后到前端填参数 |
| 试取 HTTP 400 / 404 | `$filter` 属性名或值的写法和服务要的不一样 —— 对着第 1 步抓到的请求改 |
| 试取"转换失败" | `shape` / `shapeCfg` 和返回结构对不上 —— 看打印出来的"响应开头"对照 `shapeCfg` 的路径 |

## 字段

**报表**

| 字段 | 必填 | 说明 |
|---|---|---|
| `reportId` | 是 | 内部编号，大写字母 / 数字 / 下划线，≤ 30 |
| `reportName` | 是 | 显示名，**全表唯一**（目录点选按它精确匹配），≤ 120 |
| `category` | | 业务分类（目录页签），如 销量分析 / 采购 / 生产 |
| `keywords` | | 关键词，逗号分隔（一句话找报表用） |
| `description` | | 目录里的一行说明 |
| `servicePath` | 是 | `/sap/opu/odata/sap/<服务名>`，末尾不要 `/` |
| `entitySet` | 是 | 实体集名 |
| `expandNav` | | `$expand` 的导航属性（多个用逗号） |
| `extraQuery` | | 固定查询项，如 `$select=A,B`；不能含 `$filter` / `$format` / 空格 |
| `shape` | 是 | `FLAT` / `PIVOT` / `EXPAND` |
| `shapeCfg` | | 结构配置（JSON 对象，见下） |
| `maxRows` | | 本报表落库行数上限，0 = 用全局 `FIORI_MAX_ROWS` |
| `analyzeEnabled` | | `"X"` = 允许「交给模型分析」 |
| `sortNo` | | 目录排序 |
| `active` | | `"X"` = 目录里显示、可取数 |

**`shapeCfg`**

| 形状 | 键（括号里是默认值） |
|---|---|
| `PIVOT` | `colList`（`d.results`）、`colName`（`Name`）、`colLabel`（`Description`）、`colOrder`（`Position`）、`valueList`（`DynamicDataSet.results`）、`valueField`（`Value`） |
| `FLAT` | `rowList`（`d.results`）、`columns`：`[{"prop":"Werks","label":"工厂"}]`，不配 = 第一行的全部标量属性 |
| `EXPAND` | `rowList`（`d.results`）、`itemList`（必填，如 `ToItems.results`）、`headerCols`、`itemCols`（必填） |

**参数（`params` 数组）**

| 字段 | 说明 |
|---|---|
| `paramId` | 大写字母 / 数字 / 下划线，报表内唯一 |
| `label` | 参数卡上的标签 |
| `dataType` | `CHAR` / `DATE` / `NUM` / `ENUM`（`ENUM` 必须给 `enum`） |
| `typeLength` | 长度上限，超长**拒绝不截断**（0 = 不限） |
| `required` / `multiValue` / `rangeAllowed` | `"X"` / 空 |
| `commonKey` | 共同参数标识（多选合并卡用，G3） |
| `odataProp` | `$filter` 属性名；**空 = 只校验、不进 `$filter`** |
| `odataPropTo` | `BT2` 的终点属性 |
| `filterOp` | `EQ` / `IN` / `BT`（同一属性 ge+le）/ `BT2`（起止两个属性）/ `SUBSTR` |
| `opFrom` / `opTo` | `BT2` 两端运算符，默认 `ge` / `le` |
| `valueFmt` | `STRING`（`'v'`）/ `DATETIME`（`datetime'YYYY-MM-DDT00:00:00'`）/ `INT` / `DECIMAL`（`12.5M`） |
| `enum` | `[{"key":"SHMODE","text":"ship mode"}]`，参数卡显示成可点选的标签，提交 key |
| `defaultType` | `NONE` / `STATIC`（用 `defaultValue`）/ `TODAY` / `MONTH_START` / `MONTH_END` / `THIS_MONTH`（范围：本月 1 日 ~ 月末） |
| `defaultValue` | `STATIC` 的值；范围写 `从,至` |
| `helpText` | 参数卡上的提示 |
| `sortNo` / `active` | 排序 / `"X"` 启用 |
