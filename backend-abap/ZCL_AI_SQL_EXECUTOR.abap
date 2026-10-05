*=======================================================================
* 对象:   ZCL_AI_SQL_EXECUTOR
* 用途:   动态 SELECT 执行(《SAP动态SQL业务分析_开发计划》§3 方案 A, V1.1)
*         - 校验(ZCL_AI_SQL_GUARD)通过后, 把模型的 Open SQL 拼进生成的
*           子程序池(GENERATE SUBROUTINE POOL), 由后端追加 INTO/UP TO
*         - 编译错误(行号/消息)原样回传, 供模型修正语句
*         - 结果经 RTTI 转为 ZCL_AI_DATA_ANALYSIS_SERVICE=>ty_dataset
*           (与数据分析同一数据集格式 → 前端表格/图表/CSV 免改造)
*         - 回填模型: 最多 200 行明细; 前端数据集含全部取回行
*         - 每次执行写审计表 ZAI_SQL_LOG(动态写入, 表未建时静默跳过,
*           本类激活不依赖该表)
* 依赖:   ZCL_AI_SQL_GUARD, ZCL_AI_DATA_ANALYSIS_SERVICE(仅类型)
* 安装:   SE24 (ABAP 7.50)
* 激活顺序: ZCL_AI_SQL_GUARD -> 本类 -> ZCL_AI_DDIC_TOOLS
*=======================================================================
CLASS zcl_ai_sql_executor DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " 回填模型的最大明细行数(超出时提示模型改用 GROUP BY)
    CONSTANTS: gc_llm_rows TYPE i VALUE 200.

    TYPES: BEGIN OF ty_run,
             status  TYPE string,          " OK / ERROR
             error   TYPE string,
             purpose TYPE string,
             sql     TYPE string,          " 校验通过后的语句
             dataset TYPE zcl_ai_data_analysis_service=>ty_dataset,
           END OF ty_run.

    CLASS-METHODS run_sql
      IMPORTING iv_sql        TYPE string
                iv_purpose    TYPE string DEFAULT ''
                iv_session_id TYPE string DEFAULT ''
      RETURNING VALUE(rs_run) TYPE ty_run.

  PRIVATE SECTION.

    TYPES: ty_srcline TYPE c LENGTH 200,
           tt_source  TYPE STANDARD TABLE OF ty_srcline WITH DEFAULT KEY.

    " 按字面量外的空格断行(≤198字符/行), 不切断字符串常量、不压缩其内空格
    CLASS-METHODS split_source
      IMPORTING iv_code   TYPE string
      EXPORTING et_source TYPE tt_source.

    CLASS-METHODS cells_from_row
      IMPORTING is_struct TYPE any
                io_desc   TYPE REF TO cl_abap_structdescr
      EXPORTING et_cells  TYPE zcl_ai_data_analysis_service=>tt_cells.

    " 动态写审计表(表未建/写入失败时静默跳过, 不影响主流程)
    CLASS-METHODS log_run
      IMPORTING iv_sql        TYPE string
                iv_status     TYPE string
                iv_rows       TYPE i
                iv_error      TYPE string
                iv_session_id TYPE string.

ENDCLASS.

CLASS zcl_ai_sql_executor IMPLEMENTATION.

  METHOD run_sql.

    DATA: lv_t0 TYPE i,
          lv_t1 TYPE i.
    GET RUN TIME FIELD lv_t0.

    CLEAR rs_run.
    rs_run-purpose = iv_purpose.
    rs_run-dataset-name = COND #( WHEN iv_purpose IS NOT INITIAL
                                  THEN iv_purpose ELSE 'SQL查询结果' ).
    rs_run-dataset-source = 'SAP Open SQL'.

    " ---- 1. 校验(开关/词法/表黑名单/表权限) ----
    DATA: lv_clean  TYPE string,
          lt_tables TYPE zcl_ai_sql_guard=>tt_names,
          lv_verr   TYPE string.

    zcl_ai_sql_guard=>validate_sql(
      EXPORTING iv_sql       = iv_sql
      IMPORTING ev_sql_clean = lv_clean
                et_tables    = lt_tables
                ev_error     = lv_verr ).

    IF lv_verr IS NOT INITIAL.
      rs_run-status = 'ERROR'.
      rs_run-error  = lv_verr.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = lv_verr.
      log_run( iv_sql = iv_sql iv_status = 'REJECTED' iv_rows = 0
               iv_error = lv_verr iv_session_id = iv_session_id ).
      RETURN.
    ENDIF.

    rs_run-sql = lv_clean.

    " ---- 2. 行数上限(配置, 硬上限在 GUARD 中收敛) ----
    DATA(lv_max) = zcl_ai_sql_guard=>read_max_rows( ).

    " ---- 3. 拼装子程序池源码 ----
    " 模型语句 + 后端拼接的 INTO/UP TO; 表/字段/语法在编译期即校验
    DATA lv_code TYPE string.
    lv_code =
      |PROGRAM. | &&
      |FORM run_sql USING iv_max TYPE i | &&
      |CHANGING cr_data TYPE REF TO data cv_err TYPE string. | &&
      |TRY. | &&
      |{ lv_clean } | &&
      |INTO TABLE @DATA(lt_result) UP TO @iv_max ROWS. | &&
      |CREATE DATA cr_data LIKE lt_result. | &&
      |FIELD-SYMBOLS <lt_gen> TYPE ANY TABLE. | &&
      |ASSIGN cr_data->* TO <lt_gen>. | &&
      |<lt_gen> = lt_result. | &&
      |CATCH cx_root INTO DATA(lx_gen). | &&
      |cv_err = lx_gen->get_text( ). | &&
      |ENDTRY. | &&
      |ENDFORM.|.

    DATA: lt_source TYPE tt_source.
    split_source( EXPORTING iv_code = lv_code IMPORTING et_source = lt_source ).

    " ---- 4. 生成(编译): 错误原样回给模型修正 ----
    DATA: lv_prog TYPE string,
          lv_msg  TYPE string,
          lv_line TYPE string,
          lv_word TYPE string.

    GENERATE SUBROUTINE POOL lt_source NAME lv_prog
      MESSAGE lv_msg LINE lv_line WORD lv_word.

    IF sy-subrc <> 0.
      rs_run-status = 'ERROR'.
      rs_run-error  = |SQL 编译错误(第 { lv_line } 行): { lv_msg } ({ lv_word }). | &&
                      |请检查表/字段名与 Open SQL 语法后重试|.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = rs_run-error.
      log_run( iv_sql = lv_clean iv_status = 'ERROR' iv_rows = 0
               iv_error = rs_run-error iv_session_id = iv_session_id ).
      RETURN.
    ENDIF.

    " ---- 5. 执行 ----
    DATA: lr_data TYPE REF TO data,
          lv_err  TYPE string.

    PERFORM run_sql IN PROGRAM (lv_prog)
      USING lv_max
      CHANGING lr_data lv_err.

    IF lv_err IS NOT INITIAL.
      rs_run-status = 'ERROR'.
      rs_run-error  = |SQL 执行失败: { lv_err }. 请修正语句后重试|.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = rs_run-error.
      log_run( iv_sql = lv_clean iv_status = 'ERROR' iv_rows = 0
               iv_error = rs_run-error iv_session_id = iv_session_id ).
      RETURN.
    ENDIF.

    IF lr_data IS NOT BOUND.
      rs_run-status = 'ERROR'.
      rs_run-error  = '查询未返回结果对象'.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = rs_run-error.
      RETURN.
    ENDIF.

    " ---- 6. RTTI 转统一数据集 ----
    FIELD-SYMBOLS <lt_data> TYPE ANY TABLE.
    ASSIGN lr_data->* TO <lt_data>.

    TRY.
        DATA(lo_tab) = CAST cl_abap_tabledescr(
                         cl_abap_typedescr=>describe_by_data( <lt_data> ) ).
        DATA(lo_line) = CAST cl_abap_structdescr( lo_tab->get_table_line_type( ) ).

        " 列声明(名称 + 是否数值: I/b/s/8/P/F)
        LOOP AT lo_line->components INTO DATA(ls_comp).
          DATA(lv_numeric) = xsdbool( ls_comp-type_kind = 'I' OR ls_comp-type_kind = 'P'
                                   OR ls_comp-type_kind = 'F' OR ls_comp-type_kind = 'b'
                                   OR ls_comp-type_kind = 's' OR ls_comp-type_kind = '8' ).
          APPEND VALUE zcl_ai_data_analysis_service=>ty_column(
                   name    = ls_comp-name
                   label   = ls_comp-name
                   numeric = lv_numeric )
            TO rs_run-dataset-columns.
        ENDLOOP.

        " 行数据(单元格统一转字符串, 长文本截断到 200 字符)
        LOOP AT <lt_data> ASSIGNING FIELD-SYMBOL(<ls_row>).
          cells_from_row( EXPORTING is_struct = <ls_row>
                                    io_desc   = lo_line
                          IMPORTING et_cells  = DATA(lt_cells) ).
          APPEND lt_cells TO rs_run-dataset-rows.
        ENDLOOP.

      CATCH cx_root INTO DATA(lx_conv).
        rs_run-status = 'ERROR'.
        rs_run-error  = |结果转换失败: { lx_conv->get_text( ) }|.
        rs_run-dataset-status = 'ERROR'.
        rs_run-dataset-error  = rs_run-error.
        log_run( iv_sql = lv_clean iv_status = 'ERROR' iv_rows = 0
                 iv_error = rs_run-error iv_session_id = iv_session_id ).
        RETURN.
    ENDTRY.

    rs_run-dataset-total_rows = lines( rs_run-dataset-rows ).
    rs_run-dataset-status     = 'OK'.
    rs_run-status             = 'OK'.

    GET RUN TIME FIELD lv_t1.
    rs_run-dataset-elapsed_ms = ( lv_t1 - lv_t0 ) / 1000.

    log_run( iv_sql = lv_clean iv_status = 'OK'
             iv_rows = rs_run-dataset-total_rows
             iv_error = '' iv_session_id = iv_session_id ).

  ENDMETHOD.


  METHOD split_source.

    " GENERATE SUBROUTINE POOL 要求定长字符行(c 长度), 且断行不能
    " 切断字符串常量、不能压缩常量内部的连续空格:
    " 逐字符扫描, 只在【字面量外】的空格处断行, 行内内容原样保留
    CLEAR et_source.

    DATA: lv_len     TYPE i,
          lv_i       TYPE i,
          lv_start   TYPE i,        " 当前行起点
          lv_last_sp TYPE i,        " 行内最近一个可断点(字面量外空格)的绝对位置
          lv_open    TYPE abap_bool,
          lv_ch      TYPE c LENGTH 1.

    lv_len = strlen( iv_code ).
    lv_last_sp = -1.

    WHILE lv_i < lv_len.
      lv_ch = iv_code+lv_i(1).

      IF lv_open = abap_true.
        IF lv_ch = `'`.
          IF lv_i + 1 < lv_len AND iv_code+lv_i+1(1) = `'`.
            lv_i = lv_i + 1.            " '' 转义, 跳过第二个引号
          ELSE.
            lv_open = abap_false.
          ENDIF.
        ENDIF.
      ELSEIF lv_ch = `'`.
        lv_open = abap_true.
      ELSEIF lv_ch = ` `.
        lv_last_sp = lv_i.
      ENDIF.

      " 行长达到 198 → 在最近可断点处断行(该空格不保留, 换行即分隔)
      IF lv_i - lv_start >= 198 AND lv_last_sp > lv_start.
        APPEND iv_code+lv_start(lv_last_sp - lv_start) TO et_source.
        lv_start = lv_last_sp + 1.
      ENDIF.

      lv_i = lv_i + 1.
    ENDWHILE.

    IF lv_start < lv_len.
      APPEND iv_code+lv_start TO et_source.
    ENDIF.

  ENDMETHOD.


  METHOD cells_from_row.

    CLEAR et_cells.
    LOOP AT io_desc->components INTO DATA(ls_comp).
      ASSIGN COMPONENT ls_comp-name OF STRUCTURE is_struct
        TO FIELD-SYMBOL(<lv_val>).
      IF sy-subrc <> 0.
        APPEND '' TO et_cells.
        CONTINUE.
      ENDIF.
      CASE ls_comp-type_kind.
        WHEN 'D'.
          DATA lv_d TYPE c LENGTH 8.
          lv_d = <lv_val>.
          APPEND CONV string( lv_d ) TO et_cells.
        WHEN 'T'.
          DATA lv_t TYPE c LENGTH 6.
          lv_t = <lv_val>.
          APPEND CONV string( lv_t ) TO et_cells.
        WHEN OTHERS.
          DATA lv_s TYPE string.
          lv_s = <lv_val>.
          IF strlen( lv_s ) > 200.
            lv_s = lv_s(200) && '…'.
          ENDIF.
          APPEND lv_s TO et_cells.
      ENDCASE.
    ENDLOOP.

  ENDMETHOD.


  METHOD log_run.

    " 动态写审计: 本类激活不依赖 ZAI_SQL_LOG; 表未建时 cx 异常被捕获,
    " 查询结果不受影响(生产环境应尽快建表并监控被拒记录)
    DATA: lr_wa   TYPE REF TO data,
          lv_tab  TYPE c LENGTH 30 VALUE 'ZAI_SQL_LOG'.

    FIELD-SYMBOLS: <ls_log>    TYPE any,
                   <lv_field>  TYPE any.

    TRY.
        CREATE DATA lr_wa TYPE (lv_tab).
        ASSIGN lr_wa->* TO <ls_log>.
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.

        ASSIGN COMPONENT 'QUERY_ID'   OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0.
          GET TIME STAMP FIELD DATA(lv_ts).
          <lv_field> = |SQL{ lv_ts }{ sy-uname }|.
        ENDIF.
        ASSIGN COMPONENT 'USERNAME'   OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = sy-uname. ENDIF.
        ASSIGN COMPONENT 'SQL_TEXT'   OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0.
          <lv_field> = iv_sql.
          IF strlen( <lv_field> ) > 4000.
            <lv_field> = <lv_field>(4000).
          ENDIF.
        ENDIF.
        ASSIGN COMPONENT 'STATUS'     OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_status. ENDIF.
        ASSIGN COMPONENT 'RESULT_ROWS' OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_rows. ENDIF.
        ASSIGN COMPONENT 'ERROR_MSG'  OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_error. ENDIF.
        ASSIGN COMPONENT 'SESSION_ID' OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_session_id. ENDIF.
        ASSIGN COMPONENT 'CREATED_AT' OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = |{ sy-datum }{ sy-uzeit }|. ENDIF.

        INSERT (lv_tab) FROM @<ls_log>.
        IF sy-subrc = 0.
          COMMIT WORK.
        ENDIF.

      CATCH cx_root.
        RETURN.
    ENDTRY.

  ENDMETHOD.

ENDCLASS.
