*=======================================================================
* 对象:   ZCL_AI_ALV_CAPTURE
* 用途:   通用 ALV 数据采集 —— SUBMIT 任意报表程序(AND RETURN), 抑制 ALV 显示,
*         取回 ALV 输出表, 报表程序零改动(REUSE_ALV_GRID/LIST_DISPLAY 与
*         CL_SALV_TABLE 都走 CL_SALV_BS_RUNTIME_INFO 这条标准采集口)
* 范围:   只取 ALV 数据(行 JSON + 列标题); 不处理经典 WRITE 列表 / Excel / 邮件
* 约定:   - 一次只取一份 ALV(报表多次调用 ALV 时以最后一次为准)
*         - 报表没有走到 ALV(无数据 / 无权限 STOP / 提前结束)= ev_captured 空,
*           不是错误; 只有 SUBMIT 本身异常才写 ev_error
*         - 行 JSON 与旧 P_AICAP 落表口径一致: /ui2/cl_json 序列化,
*           compress = abap_false(初始值字段保留键), 键 = 字段名大写
* 依赖:   CL_SALV_BS_RUNTIME_INFO / ZCL_AI_ALV_LABELS(可选, 动态调用)
* 调用方: ZCL_AI_REPORT_EXEC_SAP=>run_captured(后台作业内) /
*         ZAI_TEST_ALV_CAPTURE(SE38 验证程序)
* 安装:   SE24 -> 整类源代码替换粘帖 (ABAP 7.50, 755 已核对)
* V1.0    20261021: 首版
* ★ 重贴后核对标记: run 内 SUBMIT 之后先 get_labels 再 clear_all;
*   全文无方法间注释
*=======================================================================
CLASS zcl_ai_alv_capture DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.
    TYPES: BEGIN OF ty_col,
             name  TYPE string,
             label TYPE string,
           END OF ty_col.
    TYPES tt_col TYPE STANDARD TABLE OF ty_col WITH DEFAULT KEY.

    " iv_variant 非空: 先套报表变式, 再用 it_seltab 覆盖(WITH 优先于变式)
    " et_rows: 每元素 = 一行 ALV 数据的 JSON, 最多 iv_max_rows 行; 总行数见 ev_total
    CLASS-METHODS run
      IMPORTING iv_program  TYPE progname
                it_seltab   TYPE rsparams_tt
                iv_variant  TYPE raldb_vari OPTIONAL
                iv_max_rows TYPE i DEFAULT 20000
      EXPORTING ev_captured TYPE abap_bool
                ev_total    TYPE i
                et_cols     TYPE tt_col
                et_rows     TYPE string_table
                ev_error    TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS get_labels
      EXPORTING et_name  TYPE string_table
                et_label TYPE string_table
                et_tech  TYPE string_table.
ENDCLASS.



CLASS zcl_ai_alv_capture IMPLEMENTATION.


  METHOD run.
    DATA: lr_data  TYPE REF TO data,
          lt_name  TYPE string_table,
          lt_label TYPE string_table,
          lt_tech  TYPE string_table,
          ls_col   TYPE ty_col,
          lv_n     TYPE i,
          lv_idx   TYPE i,
          lv_rc    TYPE sysubrc,
          lv_json  TYPE string,
          lv_lbl   TYPE string,
          lv_tech  TYPE string,
          lv_cname TYPE string,
          lo_td    TYPE REF TO cl_abap_typedescr,
          lo_tab   TYPE REF TO cl_abap_tabledescr,
          lo_row   TYPE REF TO cl_abap_datadescr,
          lo_sd    TYPE REF TO cl_abap_structdescr.
    FIELD-SYMBOLS: <tab> TYPE ANY TABLE,
                   <row> TYPE any.
    CLEAR: ev_captured, ev_total, et_cols, et_rows, ev_error.

    cl_salv_bs_runtime_info=>set(
      display  = abap_false
      metadata = abap_true
      data     = abap_true ).

    TRY.
        IF iv_variant IS NOT INITIAL.
          SUBMIT (iv_program) USING SELECTION-SET iv_variant
            WITH SELECTION-TABLE it_seltab
            AND RETURN.
        ELSE.
          SUBMIT (iv_program)
            WITH SELECTION-TABLE it_seltab
            AND RETURN.
        ENDIF.
        lv_rc = sy-subrc.
      CATCH cx_root INTO DATA(lx_sub).
        cl_salv_bs_runtime_info=>clear_all( ).
        ev_error = |程序 { iv_program } 执行异常: { lx_sub->get_text( ) }|.
        RETURN.
    ENDTRY.

    TRY.
        cl_salv_bs_runtime_info=>get_data_ref( IMPORTING r_data = lr_data ).
      CATCH cx_salv_bs_sc_runtime_info.
        CLEAR lr_data.
    ENDTRY.

    IF lr_data IS BOUND.
      get_labels( IMPORTING et_name  = lt_name
                            et_label = lt_label
                            et_tech  = lt_tech ).
    ENDIF.
    cl_salv_bs_runtime_info=>clear_all( ).

    IF lr_data IS NOT BOUND.
      IF lv_rc <> 0.
        ev_error = |程序 { iv_program } 结束代码 { lv_rc }, 未产生 ALV 输出|.
      ENDIF.
      RETURN.
    ENDIF.

    ASSIGN lr_data->* TO <tab>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    ev_captured = abap_true.
    ev_total    = lines( <tab> ).

    TRY.
        lo_td  = cl_abap_typedescr=>describe_by_data( <tab> ).
        lo_tab ?= lo_td.
        lo_row = lo_tab->get_table_line_type( ).
        lo_sd  ?= lo_row.
      CATCH cx_root.
        ev_error = 'ALV 输出表的行类型不是结构, 无法逐列解析'.
        RETURN.
    ENDTRY.

    " 列 = 结构的平层标量组件(跳过嵌套结构 / 内表 / 引用); 标题取字段目录, 取不到用字段名
    LOOP AT lo_sd->components INTO DATA(ls_comp).
      CASE ls_comp-type_kind.
        WHEN 'h' OR 'l' OR 'r' OR 'm' OR 'u' OR 'v'.
          CONTINUE.
      ENDCASE.
      lv_cname = ls_comp-name.
      lv_idx = 0.
      READ TABLE lt_name TRANSPORTING NO FIELDS WITH KEY table_line = to_upper( lv_cname ).
      IF sy-subrc = 0.
        lv_idx = sy-tabix.
      ENDIF.
      CLEAR: lv_lbl, lv_tech.
      IF lv_idx > 0.
        READ TABLE lt_label INTO lv_lbl INDEX lv_idx.
        READ TABLE lt_tech INTO lv_tech INDEX lv_idx.
      ENDIF.
      IF lv_tech = 'X'.
        CONTINUE.
      ENDIF.
      CLEAR ls_col.
      ls_col-name  = lv_cname.
      ls_col-label = COND #( WHEN lv_lbl IS INITIAL THEN lv_cname ELSE lv_lbl ).
      APPEND ls_col TO et_cols.
    ENDLOOP.

    LOOP AT <tab> ASSIGNING <row>.
      lv_n = lv_n + 1.
      IF lv_n > iv_max_rows.
        EXIT.
      ENDIF.
      lv_json = /ui2/cl_json=>serialize( data = <row> compress = abap_false ).
      APPEND lv_json TO et_rows.
    ENDLOOP.
  ENDMETHOD.


  METHOD get_labels.
    DATA: lv_cls  TYPE string VALUE `ZCL_AI_ALV_LABELS`,
          lv_meth TYPE string VALUE `READ`.
    CLEAR: et_name, et_label, et_tech.
    TRY.
        CALL METHOD (lv_cls)=>(lv_meth)
          IMPORTING
            et_name  = et_name
            et_label = et_label
            et_tech  = et_tech.
      CATCH cx_root.
        CLEAR: et_name, et_label, et_tech.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
