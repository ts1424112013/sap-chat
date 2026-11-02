*=======================================================================
* 对象:   ZCL_AI_CODE_PROVIDER
* 用途:   读 ABAP 对象源码(程序 / 类 / 函数组 / 函数模块)与表结构, 供 Agent 代码分析
* V1.1    20261102(功能计划书/RFC函数执行/01 §5): 认函数模块名 ——
*         ① detect_objtype: TADIR 找不到时查 TFDIR, 命中 = FUNC;
*         ② FUNC 只返回这一个函数: 接口摘要(FUPARAREF: 参数 / 类型 / 必填 / 默认值 / 例外,
*           参数说明读 FUNCT, 动态列名读, 读不到只是没有说明) + 函数本体 include 源码;
*         ③ 新公开方法 function_include(TFDIR-PNAME + INCLUDE → L<组>U<nn>, 支持 /命名空间/),
*           ZCL_AI_RFC_EXEC 写入类检查共用; object_exists 也认函数模块
* ★ 重贴后核对标记: 有 METHOD read_function 与 METHOD function_include;
*   get_source 的 CASE 有 WHEN 'FUNC'; detect_objtype 里有 FROM tfdir
*=======================================================================
CLASS zcl_ai_code_provider DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS: gc_max_lines TYPE i VALUE 6000.

    TYPES: BEGIN OF ty_source,
             objtype   TYPE string,      " PROG / CLAS / FUGR / TABL / VIEW
             source    TYPE string,      " 带行号与分隔线的完整源码
             lines     TYPE i,           " 返回的总行数(含分隔线)
             truncated TYPE abap_bool,   " 是否因超过行数上限被截断
             error     TYPE string,      " 非空 = 提取失败原因
           END OF ty_source.

    CLASS-METHODS get_source
      IMPORTING iv_name          TYPE clike
                iv_max_lines     TYPE i DEFAULT gc_max_lines
      RETURNING VALUE(rs_source) TYPE ty_source.

    CLASS-METHODS object_exists
      IMPORTING iv_name          TYPE string
      RETURNING VALUE(rv_exists) TYPE abap_bool.

    CLASS-METHODS resolve_tcode
      IMPORTING iv_tcode TYPE string
      EXPORTING ev_prog  TYPE string.

    " V1.1: 函数模块本体 include 名(TFDIR-PNAME = SAPL<组>, INCLUDE = 两位序号)
    CLASS-METHODS function_include
      IMPORTING iv_pname   TYPE clike
                iv_include TYPE clike
      RETURNING VALUE(rv)  TYPE string.

  PROTECTED SECTION.
  PRIVATE SECTION.

    TYPES: BEGIN OF ty_line,
             text TYPE c LENGTH 255,
           END OF ty_line.
    TYPES tt_lines TYPE STANDARD TABLE OF ty_line WITH DEFAULT KEY.
    TYPES tt_names TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    TYPES: tt_dfies TYPE STANDARD TABLE OF dfies WITH DEFAULT KEY.

    CONSTANTS: gc_dep_max TYPE i VALUE 2.     " INCLUDE 递归展开深度

    CLASS-METHODS detect_objtype
      IMPORTING VALUE(iv_name) TYPE string
      EXPORTING ev_objtype     TYPE string
                ev_canonical   TYPE string.

    CLASS-METHODS read_structure
      IMPORTING iv_name        TYPE string
      EXPORTING et_lines       TYPE tt_lines
                ev_error       TYPE string.

    CLASS-METHODS read_function
      IMPORTING iv_name  TYPE string
      EXPORTING et_lines TYPE tt_lines
                ev_error TYPE string.

    CLASS-METHODS read_report_plain
      IMPORTING iv_prog  TYPE clike
      EXPORTING et_lines TYPE tt_lines
                ev_found TYPE abap_bool.

    CLASS-METHODS expand_includes
      IMPORTING iv_prog    TYPE string
                iv_depth   TYPE i
      CHANGING  ct_out     TYPE tt_lines
                ct_visited TYPE tt_names.

    CLASS-METHODS append_block
      IMPORTING iv_banner TYPE string
                it_lines  TYPE tt_lines
      CHANGING  ct_out    TYPE tt_lines.

    CLASS-METHODS finalize
      IMPORTING it_lines        TYPE tt_lines
                iv_max_lines    TYPE i DEFAULT gc_max_lines
      EXPORTING es_source       TYPE ty_source.

ENDCLASS.

CLASS zcl_ai_code_provider IMPLEMENTATION.

  METHOD get_source.

    DATA: lv_name      TYPE string,
          lv_objtype   TYPE string,
          lv_canonical TYPE string,
          lt_out       TYPE tt_lines,
          lt_all       TYPE tt_names.

    CLEAR rs_source.
    lv_name = to_upper( iv_name ).
    CONDENSE lv_name.

    IF lv_name IS INITIAL OR strlen( lv_name ) > 40.
      rs_source-error = '对象名为空或超过 40 个字符'.
      RETURN.
    ENDIF.

    " V14 安全修复：读源码前校验 S_DEVELOP(ACTVT 03) 权限
    AUTHORITY-CHECK OBJECT 'S_DEVELOP'
      ID 'DEVCLASS' FIELD '*'
      ID 'OBJTYPE'  FIELD 'PROG'
      ID 'ACTVT'    FIELD '03'.
    IF sy-subrc <> 0.
      rs_source-error = |没有权限读取源码(需要 S_DEVELOP 权限)|.
      RETURN.
    ENDIF.

    detect_objtype(
      EXPORTING iv_name      = lv_name
      IMPORTING ev_objtype   = lv_objtype
                ev_canonical = lv_canonical ).

    CASE lv_objtype.

      WHEN 'PROG'.
        expand_includes( EXPORTING iv_prog = lv_name iv_depth = 1
                         CHANGING ct_out = lt_out ct_visited = lt_all ).

      WHEN 'CLAS'.
        DATA(lv_pattern) = |{ lv_name }=%|.
        SELECT name FROM trdir
          WHERE name LIKE @lv_pattern
          INTO TABLE @DATA(lt_incl).
        IF sy-subrc <> 0.
          rs_source-error = |未找到类 { lv_name }(检查名称或权限)|.
          RETURN.
        ENDIF.
        DATA: BEGIN OF ls_sort,
                prio TYPE i,
                name TYPE string,
              END OF ls_sort,
              lt_sort LIKE STANDARD TABLE OF ls_sort.
        LOOP AT lt_incl ASSIGNING FIELD-SYMBOL(<fs_incl>).
          DATA(lv_prog) = <fs_incl>-name.
          DATA(lv_suf)  = lv_prog.
          SHIFT lv_suf LEFT UP TO '='.
          REPLACE ALL OCCURRENCES OF '=' IN lv_suf WITH ``.
          ls_sort-name = lv_prog.
          ls_sort-prio = COND #( WHEN lv_suf = 'CP'    THEN 1
                                 WHEN lv_suf = 'CCDEF' THEN 2
                                 WHEN lv_suf = 'CCIMP' THEN 3
                                 WHEN lv_suf = 'CU'    THEN 4
                                 WHEN lv_suf = 'CI'    THEN 5
                                 WHEN lv_suf = 'CO'    THEN 6
                                 ELSE 10 ).
          APPEND ls_sort TO lt_sort.
        ENDLOOP.
        SORT lt_sort BY prio ASCENDING name ASCENDING.
        LOOP AT lt_sort INTO ls_sort.
          read_report_plain( EXPORTING iv_prog = ls_sort-name
                             IMPORTING et_lines = DATA(lt_cls) ev_found = DATA(lv_ok) ).
          IF lv_ok = abap_true.
            append_block( EXPORTING iv_banner = |===== 类包含: { ls_sort-name } =====|
                                    it_lines  = lt_cls
                          CHANGING  ct_out    = lt_out ).
          ENDIF.
        ENDLOOP.

      WHEN 'FUGR'.
        read_report_plain( EXPORTING iv_prog = |SAPL{ lv_name }|
                           IMPORTING et_lines = DATA(lt_main) ev_found = lv_ok ).
        IF lv_ok = abap_false.
          rs_source-error = |未找到函数组 { lv_name }|.
          RETURN.
        ENDIF.
        append_block( EXPORTING iv_banner = |===== 函数组主程序: SAPL{ lv_name } =====|
                                it_lines  = lt_main
                      CHANGING  ct_out    = lt_out ).
        DATA(lv_fg_pattern) = |L{ lv_name }%|.
        SELECT name FROM trdir
          WHERE name LIKE @lv_fg_pattern
          ORDER BY name ASCENDING
          INTO TABLE @lt_incl.
        LOOP AT lt_incl ASSIGNING FIELD-SYMBOL(<fs_fg>).
          IF <fs_fg>-name CS |{ lv_name }TOP|.
            read_report_plain( EXPORTING iv_prog = <fs_fg>-name
                               IMPORTING et_lines = lt_cls ev_found = lv_ok ).
            IF lv_ok = abap_true.
              append_block( EXPORTING iv_banner = |===== 全局数据: { <fs_fg>-name } =====|
                                      it_lines  = lt_cls
                            CHANGING  ct_out    = lt_out ).
            ENDIF.
            DELETE lt_incl WHERE name = <fs_fg>-name.
            EXIT.
          ENDIF.
        ENDLOOP.
        LOOP AT lt_incl ASSIGNING <fs_fg>.
          read_report_plain( EXPORTING iv_prog = <fs_fg>-name
                             IMPORTING et_lines = lt_cls ev_found = lv_ok ).
          IF lv_ok = abap_true.
            append_block( EXPORTING iv_banner = |===== 包含: { <fs_fg>-name } =====|
                                    it_lines  = lt_cls
                          CHANGING  ct_out    = lt_out ).
          ENDIF.
        ENDLOOP.

      WHEN 'FUNC'.
        read_function(
          EXPORTING iv_name  = lv_name
          IMPORTING et_lines = DATA(lt_func)
                    ev_error = DATA(lv_func_err) ).
        IF lv_func_err IS NOT INITIAL.
          rs_source-error = lv_func_err.
          RETURN.
        ENDIF.
        APPEND LINES OF lt_func TO lt_out.

      WHEN 'TABL' OR 'VIEW'.
        read_structure(
          EXPORTING iv_name  = lv_name
          IMPORTING et_lines = DATA(lt_ddic)
                    ev_error = DATA(lv_ddic_err) ).
        IF lv_ddic_err IS NOT INITIAL.
          rs_source-error = lv_ddic_err.
          RETURN.
        ENDIF.
        APPEND LINES OF lt_ddic TO lt_out.

      WHEN OTHERS.
        read_report_plain( EXPORTING iv_prog = lv_name
                           IMPORTING et_lines = lt_main ev_found = lv_ok ).
        IF lv_ok = abap_true.
          lv_objtype = 'PROG'.
          append_block( EXPORTING iv_banner = |===== 源码: { lv_name } =====|
                                  it_lines  = lt_main
                        CHANGING  ct_out    = lt_out ).
        ELSE.
          rs_source-error = |不支持的对象类型或对象不存在: { lv_name }|. " 支持PROG/CLAS/FUGR/FUNC
          RETURN.
        ENDIF.
    ENDCASE.

    IF lines( lt_out ) = 0.
      rs_source-error = '源码为空或读取失败'.
      RETURN.
    ENDIF.

    finalize( EXPORTING it_lines     = lt_out
                        iv_max_lines = iv_max_lines
              IMPORTING es_source    = rs_source ).
    rs_source-objtype = lv_objtype.

  ENDMETHOD.

  METHOD object_exists.

    SELECT SINGLE object FROM tadir
      WHERE pgmid = 'R3TR' AND obj_name = @iv_name
        AND object IN ( 'PROG', 'CLAS', 'FUGR', 'TABL', 'VIEW' )
      INTO @DATA(lv_obj).

    rv_exists = xsdbool( sy-subrc = 0 ).
    IF rv_exists = abap_false.
      SELECT SINGLE funcname FROM tfdir
        WHERE funcname = @iv_name
        INTO @DATA(lv_fn).
      rv_exists = xsdbool( sy-subrc = 0 ).
    ENDIF.

  ENDMETHOD.

  METHOD resolve_tcode.

    CLEAR ev_prog.

    SELECT SINGLE pgmna FROM tstc
      WHERE tcode = @iv_tcode
      INTO @DATA(lv_pgmna).

    IF sy-subrc = 0 AND lv_pgmna IS NOT INITIAL.
      ev_prog = lv_pgmna.
    ENDIF.

  ENDMETHOD.

  METHOD read_structure.

    DATA: lt_dfies TYPE tt_dfies,
          ls_line  TYPE ty_line.

    CLEAR: et_lines, ev_error.

    CALL FUNCTION 'DDIF_FIELDINFO_GET'
      EXPORTING
        tabname        = CONV ddobjname( iv_name )
        langu          = sy-langu
      TABLES
        dfies_tab      = lt_dfies
      EXCEPTIONS
        not_found      = 1
        internal_error = 2
        OTHERS         = 3.

    IF sy-subrc <> 0 OR lines( lt_dfies ) = 0.
      ev_error = |未找到表/结构 { iv_name }(检查名称或权限)|.
      RETURN.
    ENDIF.

    SELECT SINGLE ddtext FROM dd02t
      WHERE tabname = @iv_name AND ddlanguage = @sy-langu
      INTO @DATA(lv_ddtext).

    append_block( EXPORTING iv_banner = |===== 表结构: { iv_name }(共 { lines( lt_dfies ) } 个字段) =====|
                            it_lines  = VALUE #( )
                  CHANGING  ct_out    = et_lines ).

    IF lv_ddtext IS NOT INITIAL.
      ls_line-text = |描述: { lv_ddtext }|.
      APPEND ls_line TO et_lines.
    ENDIF.

    ls_line-text = |列清单: FIELDNAME / KEY / DATATYPE / LEN / DEC / ROLLNAME / 字段说明|.
    APPEND ls_line TO et_lines.

    LOOP AT lt_dfies INTO DATA(ls_dfies).
      ls_line-text =
        |{ ls_dfies-fieldname WIDTH = 32 }| &&
        |{ COND #( WHEN ls_dfies-keyflag = 'X' THEN 'KEY  ' ELSE '     ' ) }| &&
        |{ ls_dfies-datatype WIDTH = 10 }| &&
        |{ ls_dfies-leng ALIGN = RIGHT WIDTH = 7 } | &&
        |{ ls_dfies-decimals ALIGN = RIGHT WIDTH = 3 } | &&
        |{ ls_dfies-rollname WIDTH = 32 }| &&
        |{ ls_dfies-fieldtext }|.
      APPEND ls_line TO et_lines.
    ENDLOOP.

  ENDMETHOD.

  METHOD detect_objtype.

    CLEAR: ev_objtype, ev_canonical.
    ev_canonical = iv_name.

    SELECT SINGLE object FROM tadir
      WHERE pgmid = 'R3TR' AND obj_name = @iv_name
        AND object IN ( 'PROG', 'CLAS', 'FUGR', 'TABL', 'VIEW' )
      INTO @DATA(lv_obj).

    IF sy-subrc = 0.
      ev_objtype = lv_obj.
      RETURN.
    ENDIF.

    " V1.1: 函数模块不在 TADIR 的 R3TR 层(属于函数组), 查 TFDIR
    SELECT SINGLE funcname FROM tfdir
      WHERE funcname = @iv_name
      INTO @DATA(lv_fname).
    IF sy-subrc = 0.
      ev_objtype = 'FUNC'.
    ELSE.
      ev_objtype = 'UNKNOWN'.
    ENDIF.

  ENDMETHOD.

  METHOD function_include.

    DATA: lv_p      TYPE string,
          lv_off    TYPE i,
          lv_goff   TYPE i,
          lv_prefix TYPE string,
          lv_group  TYPE string.

    lv_p = to_upper( condense( val = CONV string( iv_pname ) ) ).
    FIND 'SAPL' IN lv_p MATCH OFFSET lv_off.
    IF sy-subrc <> 0.
      CLEAR rv.
      RETURN.
    ENDIF.
    IF lv_off > 0.
      lv_prefix = substring( val = lv_p len = lv_off ).
    ENDIF.
    lv_goff  = lv_off + 4.
    lv_group = substring( val = lv_p off = lv_goff ).
    rv = |{ lv_prefix }L{ lv_group }U{ condense( val = CONV string( iv_include ) ) }|.

  ENDMETHOD.

  METHOD read_function.

    TYPES: BEGIN OF ty_txt,
             parameter TYPE c LENGTH 30,
             stext     TYPE c LENGTH 80,
           END OF ty_txt.
    DATA: lt_txt   TYPE STANDARD TABLE OF ty_txt WITH DEFAULT KEY,
          lv_cols  TYPE string VALUE `PARAMETER, STEXT`,
          lv_tab   TYPE string VALUE `FUNCT`,
          lv_where TYPE string,
          lv_inc   TYPE string,
          lv_group TYPE string,
          lv_kind  TYPE string,
          lv_txt   TYPE string,
          lv_req   TYPE string,
          ls_line  TYPE ty_line,
          lt_head  TYPE tt_lines,
          lt_types TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    CLEAR: et_lines, ev_error.

    SELECT SINGLE pname, include, fmode FROM tfdir
      WHERE funcname = @iv_name
      INTO @DATA(ls_dir).
    IF sy-subrc <> 0.
      ev_error = |未找到函数模块 { iv_name }|.
      RETURN.
    ENDIF.

    lv_inc = function_include( iv_pname = ls_dir-pname iv_include = ls_dir-include ).
    lv_group = ls_dir-pname.
    REPLACE FIRST OCCURRENCE OF 'SAPL' IN lv_group WITH ``.

    SELECT parameter, paramtype, pposition, structure, defaultval, optional
      FROM fupararef
      WHERE funcname = @iv_name AND r3state = 'A'
      ORDER BY paramtype, pposition
      INTO TABLE @DATA(lt_par).

    " 参数说明: FUNCT 列名未在本系统实测, 动态读, 读不到只是不显示说明
    lv_where = |FUNCNAME = '{ iv_name }' AND SPRAS = '{ sy-langu }'|.
    TRY.
        SELECT (lv_cols) FROM (lv_tab) WHERE (lv_where) INTO TABLE @lt_txt.
      CATCH cx_sy_dynamic_osql_error.
        CLEAR lt_txt.
    ENDTRY.

    ls_line-text = |函数组: { lv_group }    远程启用(RFC): { COND string( WHEN ls_dir-fmode = 'R' THEN '是' ELSE '否' ) }|.
    APPEND ls_line TO lt_head.
    ls_line-text = |接口: 种类 / 参数 / 类型 / 必填 / 默认值 / 说明|.
    APPEND ls_line TO lt_head.

    lt_types = VALUE #( ( `I` ) ( `E` ) ( `C` ) ( `T` ) ( `X` ) ).
    LOOP AT lt_types INTO DATA(lv_t).
      lv_kind = SWITCH string( lv_t WHEN 'I' THEN 'IMPORTING'
                                    WHEN 'E' THEN 'EXPORTING'
                                    WHEN 'C' THEN 'CHANGING'
                                    WHEN 'T' THEN 'TABLES'
                                    ELSE 'EXCEPTIONS' ).
      LOOP AT lt_par INTO DATA(ls_par) WHERE paramtype = lv_t.
        CLEAR lv_txt.
        READ TABLE lt_txt INTO DATA(ls_txt) WITH KEY parameter = ls_par-parameter.
        IF sy-subrc = 0.
          lv_txt = ls_txt-stext.
        ENDIF.
        IF lv_t = 'X'.
          ls_line-text = |  { lv_kind WIDTH = 11 }{ ls_par-parameter WIDTH = 31 }{ lv_txt }|.
        ELSE.
          lv_req = COND #( WHEN lv_t = 'E' THEN ''
                           WHEN ls_par-optional = 'X' OR ls_par-defaultval IS NOT INITIAL THEN '选填'
                           ELSE '必填' ).
          ls_line-text = |  { lv_kind WIDTH = 11 }{ ls_par-parameter WIDTH = 31 }| &&
                         |{ ls_par-structure WIDTH = 31 }{ lv_req WIDTH = 5 }| &&
                         |{ COND string( WHEN ls_par-defaultval IS NOT INITIAL THEN |默认 { ls_par-defaultval } | ) }{ lv_txt }|.
        ENDIF.
        APPEND ls_line TO lt_head.
      ENDLOOP.
    ENDLOOP.
    IF lt_par IS INITIAL.
      ls_line-text = '  (没有参数)'.
      APPEND ls_line TO lt_head.
    ENDIF.

    append_block( EXPORTING iv_banner = |===== 函数模块: { iv_name } =====|
                            it_lines  = lt_head
                  CHANGING  ct_out    = et_lines ).

    read_report_plain( EXPORTING iv_prog  = lv_inc
                       IMPORTING et_lines = DATA(lt_src) ev_found = DATA(lv_ok) ).
    IF lv_ok = abap_false.
      ev_error = |函数模块 { iv_name } 的源码 include { lv_inc } 读取失败|.
      RETURN.
    ENDIF.
    append_block( EXPORTING iv_banner = |===== 函数源码: { lv_inc } =====|
                            it_lines  = lt_src
                  CHANGING  ct_out    = et_lines ).

  ENDMETHOD.

  METHOD read_report_plain.

    CLEAR: et_lines, ev_found.
    DATA lt_lines TYPE tt_lines.

    SELECT SINGLE name FROM trdir INTO @DATA(lv_name) WHERE name = @iv_prog.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    READ REPORT lv_name INTO lt_lines.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    et_lines = lt_lines.
    ev_found = abap_true.

  ENDMETHOD.

  METHOD expand_includes.

    DATA: lv_cond TYPE string,
          lv_inc  TYPE string.

    IF iv_depth > gc_dep_max.
      RETURN.
    ENDIF.
    READ TABLE ct_visited TRANSPORTING NO FIELDS WITH KEY table_line = iv_prog.
    IF sy-subrc = 0.
      RETURN.
    ENDIF.
    APPEND iv_prog TO ct_visited.

    read_report_plain( EXPORTING iv_prog = iv_prog
                       IMPORTING et_lines = DATA(lt_lines) ev_found = DATA(lv_ok) ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.

    append_block( EXPORTING iv_banner = |===== 源码: { iv_prog } =====|
                            it_lines  = lt_lines
                  CHANGING  ct_out    = ct_out ).

    LOOP AT lt_lines INTO DATA(ls_line).
      lv_cond = ls_line-text.
      CONDENSE lv_cond.
      IF lv_cond IS INITIAL.
        CONTINUE.
      ENDIF.
      IF lv_cond(1) = '*'.          " 跳过注释行
        CONTINUE.
      ENDIF.
      CLEAR lv_inc.
      FIND REGEX '^\s*INCLUDE\s+([A-Z0-9_]+)' IN lv_cond IGNORING CASE SUBMATCHES lv_inc.
      IF sy-subrc <> 0 OR lv_inc IS INITIAL.
        CONTINUE.
      ENDIF.
      IF lv_inc = 'TYPE' OR lv_inc = 'LIKE' OR lv_inc = 'STRUCTURE' OR lv_inc = iv_prog.
        CONTINUE.
      ENDIF.
      IF lv_inc CP 'Z*' OR lv_inc CP 'Y*' OR lv_inc CP 'L*'.
        expand_includes( EXPORTING iv_prog = lv_inc iv_depth = iv_depth + 1
                         CHANGING ct_out = ct_out ct_visited = ct_visited ).
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD append_block.

    DATA ls_line TYPE ty_line.

    ls_line-text = '**************************************************************************'.
    APPEND ls_line TO ct_out.
    ls_line-text = iv_banner.
    APPEND ls_line TO ct_out.
    ls_line-text = '**************************************************************************'.
    APPEND ls_line TO ct_out.
    APPEND LINES OF it_lines TO ct_out.

  ENDMETHOD.

  METHOD finalize.

    DATA: lv_num  TYPE string,
          lv_trim TYPE string,
          lv_max  TYPE i.

    lv_max = COND #( WHEN iv_max_lines > 0 THEN iv_max_lines ELSE gc_max_lines ).

    CLEAR es_source.
    es_source-lines = lines( it_lines ).

    LOOP AT it_lines INTO DATA(ls_line).
      IF es_source-lines > lv_max AND sy-tabix > lv_max.
        es_source-truncated = abap_true.
        EXIT.
      ENDIF.
      lv_trim = ls_line-text.
      SHIFT lv_trim RIGHT DELETING TRAILING space. " 仅去尾部空格, 保留缩进
      lv_num = |{ sy-tabix WIDTH = 6 ALIGN = RIGHT }|.
      es_source-source = |{ es_source-source }{ lv_num } { lv_trim }\n|.
    ENDLOOP.

    IF es_source-truncated = abap_true.
      es_source-source = es_source-source &&
        |……\n[注意: 源码共 { es_source-lines } 行, 已截断至 { lv_max } 行送入大模型]\n|.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
