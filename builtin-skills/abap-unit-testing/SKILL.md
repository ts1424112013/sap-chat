---
name: abap-unit-testing
description: "ABAP 单元测试：要给 ABAP 类或程序写单元测试、建测试类、写断言、做测试替身（模拟依赖）、隔离数据库（SQL / CDS 测试环境）、给老代码加测试缝，或问 ABAP Unit 怎么用时用。"
metadata:
  order: 160
  title: "ABAP 单元测试"
  source: "abap-unit-testing（github.com/likweitan/abap-skills，MIT），去掉了 RAP 部分"
---

# ABAP 单元测试

帮用户写有效的 ABAP Unit 测试：测试类、断言、测试替身、数据库隔离。

本系统是 ABAP 7.55（本地部署）：下面的写法都能用；RAP 业务对象的测试替身用不上，不要推荐。写出的测试代码拿不准能不能激活时，用 `adt_syntax_check` 检查（只检查、不保存）。

## 步骤

1. **先定测什么**：类方法里的业务逻辑 / 依赖数据库的逻辑 / CDS 视图 / 老程序里的一段逻辑。
2. **选做法**：
   - 纯逻辑、没有依赖 → 直接测
   - 有外部依赖（读库、调函数、调接口）→ 构造函数注入 + 测试替身
   - 必须读库 → SQL 测试环境（`cl_osql_test_environment`）
   - CDS 视图 → CDS 测试环境（`cl_cds_test_environment`）
   - 老代码不好拆 → 测试缝（TEST-SEAM / TEST-INJECTION）
3. **按「准备 → 执行 → 断言」写**（Arrange → Act → Assert）。
4. **测试互相独立**：不依赖库里现有的数据，不依赖外部系统，不依赖执行顺序。

看被测代码：有 ADT 工具就用 `adt_read_source` / `adt_structure` 读；没有就请用户贴代码。

## 测试类

```abap
"! ZCL_MY_CLASS 的测试类
CLASS ltc_my_class DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    DATA cut TYPE REF TO zcl_my_class.  "被测对象（Class Under Test）

    CLASS-METHODS class_setup.    "所有测试前执行一次
    CLASS-METHODS class_teardown. "所有测试后执行一次
    METHODS setup.               "每个测试前
    METHODS teardown.            "每个测试后

    METHODS test_calculate_total FOR TESTING.
    METHODS test_validate_input  FOR TESTING.
    METHODS test_empty_input     FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltc_my_class IMPLEMENTATION.

  METHOD class_setup.
  ENDMETHOD.

  METHOD class_teardown.
  ENDMETHOD.

  METHOD setup.
    cut = NEW #( ).   "每个测试都用新的实例
  ENDMETHOD.

  METHOD teardown.
  ENDMETHOD.

  METHOD test_calculate_total.
    " 准备
    DATA(lv_quantity) = 5.
    DATA(lv_price) = CONV decfloat34( '10.50' ).

    " 执行
    DATA(lv_result) = cut->calculate_total(
      iv_quantity = lv_quantity
      iv_price    = lv_price ).

    " 断言
    cl_abap_unit_assert=>assert_equals(
      act = lv_result
      exp = CONV decfloat34( '52.50' )
      msg = '金额应为 数量 × 单价' ).
  ENDMETHOD.

  METHOD test_validate_input.
    cl_abap_unit_assert=>assert_true(
      act = cut->validate_input( 'VALID_INPUT' )
      msg = '合法输入应返回真' ).
  ENDMETHOD.

  METHOD test_empty_input.
    TRY.
        cut->validate_input( '' ).
        cl_abap_unit_assert=>fail( msg = '应当抛出异常' ).
      CATCH zcx_validation_error INTO DATA(lx_error).
        cl_abap_unit_assert=>assert_bound(
          act = lx_error
          msg = '空输入应抛出异常' ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
```

| 属性 | 取值 | 含义 |
|---|---|---|
| `DURATION` | `SHORT` / `MEDIUM` / `LONG` | 预计执行时间；`SHORT` 小于 1 秒 |
| `RISK LEVEL` | `HARMLESS` / `DANGEROUS` / `CRITICAL` | 对系统数据的影响；`HARMLESS` = 不改数据库 |

测试方法加 `FOR TESTING`；加 `RAISING cx_static_check` 时未处理的异常会让测试失败而不是中断。

## 常用断言（CL_ABAP_UNIT_ASSERT）

| 方法 | 用途 | 例子 |
|---|---|---|
| `assert_equals` | 相等 | `assert_equals( act = result exp = 42 )` |
| `assert_true` / `assert_false` | 真 / 假 | `assert_true( act = lv_flag )` |
| `assert_initial` / `assert_not_initial` | 是否为初始值 | `assert_not_initial( act = lt_result )` |
| `assert_bound` / `assert_not_bound` | 引用是否有值 | `assert_bound( act = lo_instance )` |
| `assert_differs` | 不相等 | `assert_differs( act = val1 exp = val2 )` |
| `assert_char_cp` / `assert_char_np` | 字符模式匹配 / 不匹配 | `assert_char_cp( act = lv_text exp = '*error*' )` |
| `assert_number_between` | 数值在范围内 | `assert_number_between( number = val lower = 1 upper = 10 )` |
| `assert_table_contains` / `assert_table_not_contains` | 内表包含 / 不包含某行 | `assert_table_contains( line = wa table = lt_result )` |
| `assert_return_code` | 检查 sy-subrc | `assert_return_code( act = sy-subrc exp = 0 )` |
| `fail` | 直接判失败 | `fail( msg = '不应走到这里' )` |

```abap
" 行数
cl_abap_unit_assert=>assert_equals( act = lines( lt_result ) exp = 3 msg = '应有 3 行' ).

" 异常文本
TRY.
    cut->some_method( ).
    cl_abap_unit_assert=>fail( msg = '应当抛出异常' ).
  CATCH zcx_my_exception INTO DATA(lx).
    cl_abap_unit_assert=>assert_equals( act = lx->get_text( ) exp = '预期的错误信息' ).
ENDTRY.

" 内表里有某个键
cl_abap_unit_assert=>assert_table_contains(
  line  = VALUE zstructure( key_field = 'ABC' )
  table = lt_result
  msg   = '结果里应有 ABC' ).
```

## 依赖注入和测试替身

生产代码通过接口拿依赖，构造函数允许注入；测试时注入自己写的替身。

```abap
" 接口
INTERFACE zif_data_provider.
  METHODS get_data RETURNING VALUE(rt_data) TYPE ztab_data.
ENDINTERFACE.

" 生产类：依赖可注入，不传就用默认实现
CLASS zcl_processor DEFINITION.
  PUBLIC SECTION.
    METHODS constructor IMPORTING io_provider TYPE REF TO zif_data_provider OPTIONAL.
    METHODS process RETURNING VALUE(rv_result) TYPE string.
  PRIVATE SECTION.
    DATA mo_provider TYPE REF TO zif_data_provider.
ENDCLASS.

CLASS zcl_processor IMPLEMENTATION.
  METHOD constructor.
    mo_provider = COND #( WHEN io_provider IS BOUND THEN io_provider
                          ELSE NEW zcl_default_provider( ) ).
  ENDMETHOD.
  METHOD process.
    DATA(lt_data) = mo_provider->get_data( ).
    " 处理数据…
  ENDMETHOD.
ENDCLASS.
```

```abap
" 测试替身
CLASS ltd_data_provider DEFINITION FOR TESTING.
  PUBLIC SECTION.
    INTERFACES zif_data_provider.
    DATA mt_test_data TYPE ztab_data.
ENDCLASS.

CLASS ltd_data_provider IMPLEMENTATION.
  METHOD zif_data_provider~get_data.
    rt_data = mt_test_data.
  ENDMETHOD.
ENDCLASS.

" 用替身的测试
CLASS ltc_processor DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    DATA cut         TYPE REF TO zcl_processor.
    DATA mo_provider TYPE REF TO ltd_data_provider.
    METHODS setup.
    METHODS test_process_with_data FOR TESTING.
ENDCLASS.

CLASS ltc_processor IMPLEMENTATION.
  METHOD setup.
    mo_provider = NEW #( ).
    cut = NEW #( io_provider = mo_provider ).
  ENDMETHOD.

  METHOD test_process_with_data.
    mo_provider->mt_test_data = VALUE #( ( key = '1' value = 'A' ) ( key = '2' value = 'B' ) ).
    DATA(lv_result) = cut->process( ).
    cl_abap_unit_assert=>assert_not_initial( act = lv_result ).
  ENDMETHOD.
ENDCLASS.
```

## 数据库隔离和老代码

- **SQL 测试环境**：`cl_osql_test_environment=>create( i_dependency_list = ... )` 把指定的表 / 视图换成测试替身，测试数据用 `insert_test_data( )` 放进去。
- **CDS 测试环境**：`cl_cds_test_environment=>create( i_for_entity = 'ZI_ENTITY' )` 替换 CDS 视图的全部数据源。
- 两者都是：`class_setup` 里创建，`setup` 里 `clear_doubles( )`，`class_teardown` 里 `destroy( )`。
- **测试缝（老代码）**：生产代码里用 `TEST-SEAM` / `END-TEST-SEAM` 包住要替换的部分，测试里用 `TEST-INJECTION` / `END-TEST-INJECTION` 换掉。新代码优先用构造函数注入。

完整例子见 `references/test-environment-examples.md`。

## 好的测试

- 一个测试只验证一种行为；方法名说清测什么，如 `test_reject_negative_quantity`，不要叫 `test_1`。
- 测试之间互不依赖；外部依赖（库、接口、其他对象）一律用替身。
- 测试类放在类的本地测试包含（ADT 里「Test Classes」页）；测试类前缀 `ltc_`，测试替身前缀 `ltd_`。
- 要测：业务逻辑和计算、校验规则和出错情况、边界值（空、零、最大）。
- 不用测：框架自带的功能、简单的读写属性方法、ABAP 运行时本身的行为。
- 只给测试代码和建议，不去改 SAP 里的代码；运行测试由开发人员在 ADT / SE80 里做。
