# Fiori 报表登记文件（一张报表一个 JSON）

用 SE38 `ZAI_FRPT_MAINT` 导入（`P_IMP`，先勾 `P_TEST` 校验，再去掉勾保存），导出用 `P_EXP`。只有 `ZAI_CHAT_USER` 角色为 ADMIN 的账号能保存。设计见 `功能计划书/Fiori报表分析/01-方案与开发计划`（§4.2 参数 → `$filter`，§4.3 返回结构，§5 表结构）。

`SHIPMENT.json` 是 shipment 報表的模板：**各参数的 `odataProp` 还是空的**（属性名要从 F12 抓到的请求里抄），`active` 为空（目录里先不显示）。按下面"新增一张报表"的步骤填好再导入。

## 新增一张报表

1. 在 Fiori 页面按 F12 → Network，点查询，找到 OData 请求（多数在 `$batch` 的 Payload 里，形如 `GET DynamiFIELDSet?$filter=...&$expand=...`）。
2. 前面补上服务路径（`/sap/opu/odata/sap/<服务名>/`），用 SE38 `ZAI_TEST_ODATA_INTERNAL` 的 `P_U1..P_U4` 调一次：确认 HTTP 200、转换后的行和页面一致（同时完成 G0 验证）。
3. 从 `$filter` 里抄出每个条件的属性名、运算符、值的写法，填进 `params`：
   - `Site eq 'HHZZ'` → `odataProp: "Site"`、`filterOp: "IN"`（多值）或 `"EQ"`、`valueFmt: "STRING"`
   - `BegDat ge datetime'2026-10-01T00:00:00' and EndDat le datetime'...'` → `odataProp: "BegDat"`、`odataPropTo: "EndDat"`、`filterOp: "BT2"`、`valueFmt: "DATETIME"`
4. `active` 改成 `"X"`，导入（先 `P_TEST`）。
5. 前端「Fiori 报表」目录里点这张报表 → 取数，和 Fiori 页面逐项对数。

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
