---
name: sap-pp
description: "PP 生产计划：问 BOM、工作中心、工艺路线、生产订单、MRP、ATP 可用性检查、MTO 可配置 BOM 的事务码、表、BAPI 和配置，COOIS 增强时用。"
metadata:
  scenes: "DATA,CODE"
  order: 60
  title: "PP 生产计划"
  source: "sap-trench（github.com/shrek-abaper/sap-functional-skill，MIT）references/pp.md"
---

# PP 生产计划

## 怎么用

- 先在下面的「内容」里找和问题对应的部分，再回答。回答按五段写：【问题定性】【根本原因】【解决方案】【注意事项】【参考工具】；简单的查询（问一个事务码、一张表）直接答，不用套五段。
- 说清适用版本（ECC / S/4HANA）。生产订单表 `AUFK`/`AFKO`/`AFPO` 不变；MRP 在 S/4 默认是 MRP Live（`MD01N`）；物料凭证看 `MATDOC`。
- 这是知识，不是工具：不要说已经执行了 BAPI、事务码或改了配置。用户想看实际数据时，普通用户请他用报表；能用表结构 / 只读查询工具的，先查表结构再查。
- 内容是项目经验，可能和本公司的配置不同；涉及改配置、传输、生产操作的，提醒先在开发或测试系统验证。

## 内容

---

## 一、常用事务码

### BOM 管理
| 事务码 | 用途 |
|---|---|
| `CS01/CS02/CS03` | 创建/更改/显示物料 BOM |
| `CS15` | 反查 BOM（物料在哪些 BOM 中被使用）|
| `CSMB` | BOM 浏览器 |
| `CSAB` | 浏览销售订单 BOM |
| `CS40` | 普通物料关联可配置物料 |

### 工作中心
| 事务码 | 用途 |
|---|---|
| `CR01/CR02/CR03` | 创建/更改/显示工作中心 |
| `CR11/CR12/CR13` | 增加/更改/显示能力（Capacity）|
| `CR05` | 工作中心清单 |
| `CR06` | 工作中心分配到成本中心 |

### 工艺路线
| 事务码 | 用途 |
|---|---|
| `CA01/CA02/CA03` | 创建/更改/显示工艺路线 |
| `CA11/CA12/CA13` | 创建/更改/显示参照工序集 |
| `CA21/CA22/CA23` | 创建/更改/显示定额工艺路线 |

### 生产订单
| 事务码 | 用途 |
|---|---|
| `CO01/CO02/CO03` | 创建/更改/显示生产订单 |
| `COR1/COR2/COR3` | 创建/更改/显示流程订单 |
| `COOIS` | 生产订单信息系统（报表）|

### MRP / ATP
| 事务码 | 用途 |
|---|---|
| `MD04` | 库存/需求情况（MRP 元素列表）|
| `MD09` | 需求追溯（溯源至 SO/独立需求）|
| `CO09` | 可用性总览 |

### MTO 变式配置
| 事务码 | 用途 |
|---|---|
| `CT04` | 创建/维护特征（Characteristic）|
| `CL02` | 创建/维护分类 |
| `CU01` | 创建依赖关系 |
| `CU41` | 维护配置文件（Configuration Profile）|
| `CU50` | 测试配置 |

---

## 二、关键数据表

| 表名 | 内容 |
|---|---|
| `AUFK` | 生产订单主数据（抬头）|
| `AFKO` | 生产订单操作（工艺路线信息）|
| `AFPO` | 生产订单行项目（数量/物料/工厂）|
| `RESB` | 预留/依赖需求（BOM 组件）|
| `MAST` | 物料与 BOM 的关联关系 |
| `STKO` | BOM 抬头 |
| `STPO` | BOM 行项目（组件列表）|
| `PLKO` | 工艺路线抬头 |
| `PLPO` | 工艺路线工序（工作中心/标准工时）|
| `CRHD` | 工作中心主数据抬头 |
| `MDEZ` | MRP 需求/库存元素（ATP 函数返回）|

---

## 三、主要 BAPI / 函数

### BAPI_PRODORD_CREATE（创建生产订单）

```abap
DATA: gs_order TYPE bapi_pp_order_create.

gs_order-material         = lw_matnr.
gs_order-plant            = lw_werks.
gs_order-planning_plant   = lw_werks.
gs_order-basic_start_date = lw_gstrp.
gs_order-basic_end_date   = lw_gstrp.
gs_order-quantity         = lw_bdmng.
gs_order-order_type       = 'PP01'.

CALL FUNCTION 'BAPI_PRODORD_CREATE'
  EXPORTING
    orderdata    = gs_order
  IMPORTING
    return       = gs_return
    order_number = gv_order_number.

" 订单下达
CALL FUNCTION 'BAPI_PRODORD_RELEASE'
  TABLES
    orders        = gt_bapi_order_key
    detail_return = gt_order_return.

CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'.
```

### MD_STOCK_REQUIREMENTS_LIST_API（读取 MD04 可用数量）

```abap
DATA: lt_mdez TYPE TABLE OF mdez.

CALL FUNCTION 'MD_STOCK_REQUIREMENTS_LIST_API'
  EXPORTING
    matnr = lv_matnr
    werks = lv_werks
  TABLES
    mdezx = lt_mdez.

" 最后一行的 mng02 = 当前可用数量
READ TABLE lt_mdez ASSIGNING FIELD-SYMBOL(<fs>) INDEX lines( lt_mdez ).
lv_atp_qty = <fs>-mng02.
```

> ⚠️ 有时最后一行 MRP 元素为 `StLcSt`（库位库存），此时不是可用数量，需按实际业务过滤

### MD_PEGGING_NODIALOG（需求追溯，MD09）
根据批次/采购订单，向上追溯到销售订单或独立需求

---

## 四、ATP 可用性检查配置

### 核心概念
- **Checking Group**（检查组）：物料主数据销售视图维护，决定参与哪类ATP检查
- **Checking Rule**：A=生产订单，B=交货
- **Scope of Check**：由 Checking Group + Rule 组合决定检查范围

### Scope of Check 关键选项
| 编号 | 含义 |
|---|---|
| 1~13 | 库存/在途/收货/发货等标准元素 |
| 14 | 其他物料生产订单产生的预留 |
| 15 | 库存转储订单（STO）|
| 16 | 计划订单 |
| 17 | 生产订单 |
| 18 | 不参考补货提前期（RLT）|
| 21 | 控制确认日期能否在过去/未来 |

### 配置路径
```
SPRO → Production → Shop Floor Control → Operations
  → Availability Check → Define Checking Control
  → Availability Check → Define Scope of Check
```

---

## 五、MTO 变式可配置 BOM

### 完整实现步骤
```
CT04  → 创建特征（如颜色、规格）
CL02  → 创建分类，分配特征
CU01  → 创建依赖关系（条件选择组件）
CS01  → 创建超级BOM（物料类型 KMAT，策略组25）
CU41  → 维护配置文件
CU50  → 测试配置结果
CS40  → 将普通物料与 KMAT 关联
```

**依赖关系示例**：
```
条件（Selection Condition）：Z101 = 'Z1'
→ 选择该特征值时，包含对应的 BOM 组件
```

**下单时**：VA01 行项目中选择特征值，系统根据依赖关系自动确定 BOM 组成

---

## 六、增强实现

### COOIS 自定义字段（BAdI WORKORDER_INFOSYSTEM）
**场景**：在 COOIS 生产订单报表中添加自定义字段（如质检结果）

```
1. SE11 → 创建 DDIC 结构（如 ZCOOIS_CUSTOM_DATA）含自定义字段
2. 将结构附加到 IOHEADER_DELAY
3. SE38 → 执行 RCNCT000、RCOTX000（刷新元数据）
4. SE19 → 创建 BAdI WORKORDER_INFOSYSTEM 实现
5. 实现方法 TABLES_MODIFY_LAY → 填充自定义字段数据
```

### 序列号相关增强（IQSM000x）
| 增强 | 用途 |
|---|---|
| `IQSM0001` | 自动序列号分配 |
| `IQSM0002` | 复制对象列表时校验 |
| `IQSM0007` | 货物移动存在序列号时的用户出口 |
| `IQSM0008` | 序列号字符串格式校验 |
