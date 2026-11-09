---
name: abap-syntax-755
description: "ABAP 7.55 语法边界：要写、改或审查 ABAP 代码，需要确认某个写法在本系统（ABAP 7.55）能不能用、新旧写法怎么换、为什么激活报语法错时用。列出 7.55 能用的新语法（内联声明、构造表达式、新 Open SQL、FOR / REDUCE、ENUM、CTE 等）和不能用的（7.57 的 FINAL( ) 等），以及 ABAP Cloud 限制不适用。"
metadata:
  order: 170
  title: "ABAP 7.55 语法边界"
  source: "参考 superclaude-for-sap common/abap-release-reference.md（github.com/babamba2/superclaude-for-sap，MIT），按本系统 7.55 重写并核对"
---

# ABAP 7.55 语法边界

本系统：**SAP_BASIS 7.55（ABAP Platform 2020），本地部署**。写出的代码必须能在 7.55 上激活。

## 三条原则

1. **7.55 及以前的语法都能用**，新代码优先用现代写法；已有代码能正常工作，不为了风格去降级或强行升级。
2. **7.56 及以后的语法不能用**（最常见的是 7.57 的 `FINAL( )`）。拿不准某个写法从哪个版本开始有时，**先用 `adt_syntax_check` 检查**（把代码作为 source 交给它，只检查、不保存），不要凭记忆下结论。
3. **ABAP Cloud 的限制不适用**：可以直接读标准表（如 MARA、VBAK、MATDOC、ACDOCA）、调用未发布的函数和 BAPI、用 SUBMIT、CALL TRANSACTION 等。但表结构以本系统为准（S/4：物料凭证 `MATDOC`、财务 `ACDOCA`、业务伙伴 `BUT000`；拿不准用 `describe_table` 或 ADT 看）。

## 什么时候开始有（7.55 都能用）

| 版本 | 语法 |
|---|---|
| 7.02 | 字符串模板 `\|…{ var }…\|`、字符串函数（`condense( )`、`to_upper( )`、`substring( )` 等）、`boolc( )`、操作数位置上的表达式 |
| 7.40 SP02 | 内联声明 `DATA( )`、`FIELD-SYMBOL( )`；构造表达式 `NEW`、`VALUE`、`REF`、`CONV`、`CAST`、`EXACT`、`COND`、`SWITCH`；表表达式 `itab[ … ]`；`line_exists( )`、`line_index( )` |
| 7.40 SP05 | 新 Open SQL 写法：字段用逗号分隔、主机变量加 `@`；SQL 里的 `CASE`、`COALESCE`、算术；`CORRESPONDING` 运算符；内表的 `MOVE-CORRESPONDING` |
| 7.40 SP08 | `FOR` 表达式、`REDUCE`、`FILTER`；`LOOP AT … GROUP BY`；SELECT 里内联声明 `INTO TABLE @DATA( … )`；`xsdbool( )` |
| 7.50 | 主机表达式 `@( … )`；`UNION`；`IS INSTANCE OF`、`CASE TYPE OF`；测试缝 `TEST-SEAM`；CDS 表函数（AMDP） |
| 7.51 | `ENUM` 枚举类型；公用表表达式 `WITH`（CTE）；SELECT 的 `OFFSET` |
| 7.52 | 以内表为数据源 `SELECT … FROM @itab` |
| 7.54 | `UTCLONG` 类型；SQL 窗口表达式 `OVER( … )`；RAP / EML（本系统一般不用） |

**不能用（7.55 之后）**：`FINAL( )` 不可变内联声明（7.57）以及 7.56 之后新增的其他语法。不确定的一律先做语法检查。

## 常见报错和写法

- **新旧 Open SQL 不能混写**：一条 SELECT 里只要用了新写法（逗号分隔、`@`、SQL 表达式、`INTO @DATA( )`），就进入严格模式：**所有**主机变量都要加 `@`，字段之间都要用逗号，`INTO` 写在字段列表之后（或句末）。

  ```abap
  " ✓ 新写法（7.55 推荐）
  SELECT matnr, werks, labst
    FROM mard
    WHERE werks = @lv_werks
    INTO TABLE @DATA(lt_stock)
    UP TO 100 ROWS.

  " ✗ 混写：报语法错
  SELECT matnr werks labst FROM mard INTO TABLE @lt_stock WHERE werks = lv_werks.
  ```

- **表表达式找不到行会抛异常**（`CX_SY_ITAB_LINE_NOT_FOUND`）：可能找不到时用 `VALUE #( itab[ … ] OPTIONAL )` 或 `DEFAULT`，或先 `line_exists( )`。

  ```abap
  DATA(lv_qty) = VALUE #( lt_items[ posnr = '000010' ]-menge OPTIONAL ).
  IF line_exists( lt_items[ posnr = '000010' ] ).
    " …
  ENDIF.
  ```

- **内联声明的作用域是整个方法 / 子程序**，不是只在 LOOP 或 IF 里；同名变量在同一方法里不能用 `DATA( )` 声明两次。
- **`FOR` / `REDUCE` / 分组循环**：

  ```abap
  DATA(lt_matnr) = VALUE string_table( FOR ls_line IN lt_items WHERE ( menge > 0 )
                                       ( CONV string( ls_line-matnr ) ) ).
  DATA(lv_total) = REDUCE i( INIT sum = 0 FOR ls_line IN lt_items NEXT sum = sum + ls_line-menge ).

  LOOP AT lt_items INTO DATA(ls_item) GROUP BY ( matnr = ls_item-matnr ) ASSIGNING FIELD-SYMBOL(<group>).
    DATA(lv_sum) = REDUCE i( INIT s = 0 FOR m IN GROUP <group> NEXT s = s + m-menge ).
  ENDLOOP.
  ```

- **SQL 表达式**（7.55 都能用）：

  ```abap
  SELECT vbeln,
         CASE WHEN netwr > 10000 THEN 'HIGH' WHEN netwr > 1000 THEN 'MED' ELSE 'LOW' END AS priority,
         COALESCE( augru, '00' ) AS augru
    FROM vbak
    WHERE erdat >= @lv_from
    INTO TABLE @DATA(lt_result)
    UP TO 100 ROWS.
  ```

- **数字和日期**：除法要整数结果用 `DIV`，小数用 `DIVISION( a, b, 2 )`（SQL 里）；日期差在 SQL 里用 `DATS_DAYS_BETWEEN( )`，ABAP 里日期直接相减得到天数。

## 注意

- 这里讲的是**写程序**用的语法。灵犀里给 IT 用的只读 SQL 查询工具只接受**一条** SELECT，不能用 `WITH`、`UNION` 等多语句写法，两者不要混淆。
- 改写或新写的代码交给用户前，能检查的都用 `adt_syntax_check` 检查一遍，把检查结果（通过 / 错误行号）一起告诉用户。
- 只给代码和建议，不去改 SAP 里的代码。
