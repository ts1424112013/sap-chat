*=======================================================================
* 对象:   ZCL_AI_ALV_LABELS
* 用途:   读取 ALV 字段目录的列标题(可选增强, 取不到只丢标题, 不影响取数)
*         —— 由 ZCL_AI_ALV_CAPTURE 在 SUBMIT 之后、clear_all 之前动态调用
* 为何单独成类: cl_salv_bs_runtime_info=>get_metadata 及其元数据结构类型
*         (s_type_metadata)在本系统未经核对, 隔离在这里 ——
*         万一激活报错, 只需把本类留空/不激活, 采集类照常取数(列标题退化为字段名)
* 依赖:   CL_SALV_BS_RUNTIME_INFO(标准类)
* 安装:   SE24 -> 整类源代码替换粘帖 (ABAP 7.50, 755 已核对)
* V1.0    20261021: 首版
* ★ 重贴后核对标记: read 内 get_metadata 为静态调用; 全文无方法间注释
*=======================================================================
CLASS zcl_ai_alv_labels DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.
    " 三张并行表(下标一一对应): 字段名(大写) / 列标题 / 技术列标记('X'=ALV 里不展示的技术列)
    CLASS-METHODS read
      EXPORTING et_name  TYPE string_table
                et_label TYPE string_table
                et_tech  TYPE string_table.

  PRIVATE SECTION.
    CLASS-METHODS txt
      IMPORTING is_fc     TYPE any
                iv_comp   TYPE string
      RETURNING VALUE(rv) TYPE string.
ENDCLASS.



CLASS zcl_ai_alv_labels IMPLEMENTATION.


  METHOD read.
    DATA: ls_meta TYPE cl_salv_bs_runtime_info=>s_type_metadata,
          lo_ms   TYPE REF TO cl_abap_structdescr,
          lo_td   TYPE REF TO cl_abap_typedescr,
          lo_tabd TYPE REF TO cl_abap_tabledescr,
          lo_ld   TYPE REF TO cl_abap_datadescr,
          lo_ls   TYPE REF TO cl_abap_structdescr,
          lt_cand TYPE string_table,
          lv_cand TYPE string,
          lv_name TYPE string,
          lv_lbl  TYPE string,
          lv_tech TYPE string,
          lv_has  TYPE abap_bool.
    FIELD-SYMBOLS: <comp> TYPE any,
                   <fcat> TYPE STANDARD TABLE,
                   <fc>   TYPE any.
    CLEAR: et_name, et_label, et_tech.

    lt_cand = VALUE #( ( `REPTEXT` ) ( `COLTEXT` ) ( `SCRTEXT_L` ) ( `SELTEXT_L` )
                       ( `SCRTEXT_M` ) ( `SELTEXT_M` ) ( `SCRTEXT_S` ) ( `SELTEXT_S` )
                       ( `REPTEXT_DDIC` ) ( `SELTEXT` ) ).

    TRY.
        ls_meta = cl_salv_bs_runtime_info=>get_metadata( ).
        lo_ms ?= cl_abap_typedescr=>describe_by_data( ls_meta ).

        LOOP AT lo_ms->components INTO DATA(ls_mc).
          ASSIGN COMPONENT ls_mc-name OF STRUCTURE ls_meta TO <comp>.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          lo_td = cl_abap_typedescr=>describe_by_data( <comp> ).
          IF lo_td->kind <> cl_abap_typedescr=>kind_table.
            CONTINUE.
          ENDIF.
          lo_tabd ?= lo_td.
          lo_ld = lo_tabd->get_table_line_type( ).
          IF lo_ld->kind <> cl_abap_typedescr=>kind_struct.
            CONTINUE.
          ENDIF.
          lo_ls ?= lo_ld.

          " 字段目录判定: 行结构有 FIELDNAME 且有任一标题列(排序/过滤表没有标题列)
          READ TABLE lo_ls->components TRANSPORTING NO FIELDS WITH KEY name = 'FIELDNAME'.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          lv_has = abap_false.
          LOOP AT lt_cand INTO lv_cand.
            READ TABLE lo_ls->components TRANSPORTING NO FIELDS WITH KEY name = lv_cand.
            IF sy-subrc = 0.
              lv_has = abap_true.
              EXIT.
            ENDIF.
          ENDLOOP.
          IF lv_has = abap_false.
            CONTINUE.
          ENDIF.

          ASSIGN <comp> TO <fcat>.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.

          LOOP AT <fcat> ASSIGNING <fc>.
            lv_name = to_upper( txt( is_fc = <fc> iv_comp = `FIELDNAME` ) ).
            IF lv_name IS INITIAL.
              CONTINUE.
            ENDIF.
            CLEAR lv_lbl.
            LOOP AT lt_cand INTO lv_cand.
              lv_lbl = txt( is_fc = <fc> iv_comp = lv_cand ).
              IF lv_lbl IS NOT INITIAL.
                EXIT.
              ENDIF.
            ENDLOOP.
            lv_tech = txt( is_fc = <fc> iv_comp = `TECH` ).
            APPEND lv_name TO et_name.
            APPEND lv_lbl  TO et_label.
            APPEND lv_tech TO et_tech.
          ENDLOOP.
          EXIT.
        ENDLOOP.
      CATCH cx_root.
        CLEAR: et_name, et_label, et_tech.
    ENDTRY.
  ENDMETHOD.


  METHOD txt.
    FIELD-SYMBOLS <v> TYPE any.
    CLEAR rv.
    ASSIGN COMPONENT iv_comp OF STRUCTURE is_fc TO <v>.
    IF sy-subrc = 0.
      rv = <v>.
      CONDENSE rv.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
