*=======================================================================
* 对象:   ZCL_AI_VALUE_HELP
* 用途:   参数卡搜索帮助(F4)(设计: 功能计划书/参数搜索帮助/01-方案 V1.0) ——
*         前端只给「报表编号 + 参数编号 + 关键字」, 表 / 字段由本类从登记里推出,
*         不接受前端传表名。取值顺序(取到就停):
*           ① 域固定值(DD07L / DD07T)
*           ② 标准搜索帮助: 表字段 F4IF_DETERMINE_SEARCHHELP, 只有数据元素时
*              DD04L-SHLPNAME + F4IF_GET_SHLP_DESCR; 集合帮助展开取第一个基本帮助;
*              F4IF_SELECT_VALUES 无弹窗取值, 不调出口(出口可能弹窗, HTTP 会话里会 dump)
*           ③ 检查表 / 域值表(有文本表读当前语言文字, 没有取检查表里第一个较长字符列)
*         字典参照: ZAI_RPT_PARAM-REF_FIELD(扫描器 V1.2 写, 列按名动态读, SE11 没加
*         这列也能激活); 没有时现场取 —— 报表走 ZCL_AI_RPT_SCANNER=>scan, 函数读 FUPARAREF
* 安全:   登记必须存在且活动; 报表授权动态调 ZCL_AI_ACCESS=>REPORT_OK(类不存在 = 跳过);
*         候选值本身和 GUI 的 F4 一样不另做权限过滤; 关键字转义后才拼进动态 WHERE
* 依赖:   ZCL_AI_RPT_SCANNER V1.2(ty_param-ref_field, 先激活)
* 安装:   SE24 -> 新建类 ZCL_AI_VALUE_HELP -> 源代码视图整类粘贴 (ABAP 7.50)
* V1.0    20261103: 首版
* ★ 核对标记: 有 METHOD meta / search / search_ref / by_fixed / by_shlp / by_check;
*   by_shlp 里 call_shlp_exit = ' '; 全文没有 FIND PCRE; 方法之间没有注释
* V1.1    20261104(功能计划书/RFC函数执行/05-表参数粘贴数据方案): 元数据给函数表参数
*         (SEL_KIND T)带 columns(ZCL_AI_RFC_EXEC=>table_columns, 参数卡列说明 / 粘贴对字段);
*         依赖 ZCL_AI_RFC_EXEC V1.2
* ★ 核对标记 V1.1: meta 里有 zcl_ai_rfc_exec=>table_columns(
*=======================================================================
CLASS zcl_ai_value_help DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS: gc_max     TYPE i VALUE 100,
               gc_max_cap TYPE i VALUE 200.

    TYPES: BEGIN OF ty_item,
             key     TYPE string,    " 内部格式(填进输入框 / 提交用)
             display TYPE string,    " 输出格式(去前导零等, 列表里显示)
             text    TYPE string,
           END OF ty_item.
    TYPES tt_item TYPE STANDARD TABLE OF ty_item WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_mparam,
             param_id TYPE string,
             has_help TYPE abap_bool,
             label    TYPE string,   " 字典文字(登记里没有名称时前端用它)
             ref      TYPE string,
             columns  TYPE zcl_ai_rfc_exec=>tt_tcol,   " V1.1: 表参数的列
           END OF ty_mparam.
    TYPES tt_mparam TYPE STANDARD TABLE OF ty_mparam WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_meta,
             report_id TYPE string,
             params    TYPE tt_mparam,
             error     TYPE string,
             message   TYPE string,
           END OF ty_meta.

    TYPES: BEGIN OF ty_result,
             report_id   TYPE string,
             param_id    TYPE string,
             query       TYPE string,
             source      TYPE string,   " FIXED / SHLP / CHECK
             source_name TYPE string,   " 域名 / 搜索帮助名 / 检查表名
             key_label   TYPE string,
             text_label  TYPE string,
             items       TYPE tt_item,
             truncated   TYPE abap_bool,
             error       TYPE string,
             message     TYPE string,
           END OF ty_result.

    CLASS-METHODS meta
      IMPORTING iv_report_id TYPE string
      RETURNING VALUE(rs)    TYPE ty_meta.

    CLASS-METHODS search
      IMPORTING iv_report_id TYPE string
                iv_param_id  TYPE string
                iv_query     TYPE string OPTIONAL
                iv_max       TYPE i DEFAULT gc_max
      RETURNING VALUE(rs)    TYPE ty_result.

    CLASS-METHODS search_ref
      IMPORTING iv_ref    TYPE string
                iv_query  TYPE string OPTIONAL
                iv_max    TYPE i DEFAULT gc_max
      RETURNING VALUE(rs) TYPE ty_result.

    CLASS-METHODS has_help
      IMPORTING iv_ref    TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.

  PROTECTED SECTION.
  PRIVATE SECTION.

    TYPES: BEGIN OF ty_ref,
             param_id TYPE string,
             ref      TYPE string,
             label    TYPE string,
             skip     TYPE abap_bool,   " 复选框 / 单选组 / 日期: 不需要搜索帮助
             is_table TYPE abap_bool,   " V1.1: 函数表参数(SEL_KIND T)
           END OF ty_ref.
    TYPES tt_ref TYPE STANDARD TABLE OF ty_ref WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_dd,
             ok        TYPE abap_bool,
             tab       TYPE string,
             fld       TYPE string,
             rollname  TYPE string,
             domname   TYPE string,
             checktab  TYPE string,
             entitytab TYPE string,
             convexit  TYPE string,
             label     TYPE string,
             shlp      TYPE string,
             shlpfield TYPE string,
           END OF ty_dd.

    TYPES: BEGIN OF ty_kt,
             k TYPE c LENGTH 255,
             t TYPE c LENGTH 255,
           END OF ty_kt.
    TYPES tt_kt TYPE STANDARD TABLE OF ty_kt WITH DEFAULT KEY.

    CLASS-METHODS report_refs
      IMPORTING iv_report_id TYPE string
      EXPORTING et_refs      TYPE tt_ref
                ev_error     TYPE string.
    CLASS-METHODS access_error
      IMPORTING iv_report_id TYPE string
      RETURNING VALUE(rv)    TYPE string.
    CLASS-METHODS resolve
      IMPORTING iv_ref    TYPE string
                iv_depth  TYPE i DEFAULT 0
      RETURNING VALUE(rs) TYPE ty_dd.
    CLASS-METHODS by_fixed
      IMPORTING is_dd    TYPE ty_dd
                iv_query TYPE string
                iv_max   TYPE i
      CHANGING  cs       TYPE ty_result.
    CLASS-METHODS get_shlp
      IMPORTING is_dd   TYPE ty_dd
      EXPORTING es_shlp TYPE shlp_descr
                ev_key  TYPE string
                ev_note TYPE string.
    CLASS-METHODS by_shlp
      IMPORTING is_dd    TYPE ty_dd
                iv_query TYPE string
                iv_max   TYPE i
      CHANGING  cs       TYPE ty_result.
    CLASS-METHODS shlp_select
      IMPORTING is_shlp  TYPE shlp_descr
                iv_field TYPE string
                iv_low   TYPE string
                iv_key   TYPE string
                iv_text  TYPE string
                iv_max   TYPE i
      CHANGING  ct_kt    TYPE tt_kt
                cv_note  TYPE string.
    CLASS-METHODS by_check
      IMPORTING is_dd    TYPE ty_dd
                iv_query TYPE string
                iv_max   TYPE i
      CHANGING  cs       TYPE ty_result.
    CLASS-METHODS add_kt
      IMPORTING it_kt  TYPE tt_kt
                iv_max TYPE i
      CHANGING  ct_kt  TYPE tt_kt.
    CLASS-METHODS fill_items
      IMPORTING it_kt       TYPE tt_kt
                iv_rollname TYPE string
                iv_convexit TYPE string
                iv_max      TYPE i
      CHANGING  cs          TYPE ty_result.
    CLASS-METHODS out_value
      IMPORTING iv_value    TYPE clike
                iv_rollname TYPE string
      RETURNING VALUE(rv)   TYPE string.
    CLASS-METHODS hit
      IMPORTING iv_key    TYPE clike
                iv_text   TYPE clike
                iv_query  TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS like_pat
      IMPORTING iv_query  TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS clean_query
      IMPORTING iv_query  TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS cut
      IMPORTING iv_s      TYPE string
                iv_off    TYPE i
                iv_len    TYPE i
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS zcl_ai_value_help IMPLEMENTATION.


  METHOD meta.

    DATA: lt_refs TYPE tt_ref,
          ls_ref  TYPE ty_ref,
          ls_mp   TYPE ty_mparam,
          ls_dd   TYPE ty_dd,
          lv_err  TYPE string.

    rs-report_id = to_upper( condense( iv_report_id ) ).
    rs-error = access_error( rs-report_id ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    report_refs( EXPORTING iv_report_id = rs-report_id
                 IMPORTING et_refs      = lt_refs
                           ev_error     = lv_err ).
    IF lv_err IS NOT INITIAL.
      rs-error = lv_err.
      RETURN.
    ENDIF.

    LOOP AT lt_refs INTO ls_ref.
      CLEAR: ls_mp, ls_dd.
      ls_mp-param_id = ls_ref-param_id.
      ls_mp-ref      = ls_ref-ref.
      IF ls_ref-ref IS NOT INITIAL.
        ls_dd = resolve( ls_ref-ref ).
        ls_mp-label = ls_dd-label.
        IF ls_ref-skip = abap_false.
          ls_mp-has_help = has_help( ls_ref-ref ).
        ENDIF.
      ENDIF.
      IF ls_ref-label IS NOT INITIAL.
        ls_mp-label = ls_ref-label.
      ENDIF.
      IF ls_ref-is_table = abap_true AND ls_ref-ref IS NOT INITIAL.
        ls_mp-columns = zcl_ai_rfc_exec=>table_columns( ls_ref-ref ).
        CLEAR ls_mp-label.
        IF ls_ref-label IS NOT INITIAL.
          ls_mp-label = ls_ref-label.
        ENDIF.
      ENDIF.
      APPEND ls_mp TO rs-params.
    ENDLOOP.
    rs-message = |{ lines( rs-params ) } 个参数|.

  ENDMETHOD.


  METHOD search.

    DATA: lt_refs TYPE tt_ref,
          lv_err  TYPE string,
          lv_pid  TYPE string.

    rs-report_id = to_upper( condense( iv_report_id ) ).
    lv_pid       = to_upper( condense( iv_param_id ) ).
    rs-param_id  = lv_pid.
    rs-query     = iv_query.
    rs-error = access_error( rs-report_id ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    report_refs( EXPORTING iv_report_id = rs-report_id
                 IMPORTING et_refs      = lt_refs
                           ev_error     = lv_err ).
    IF lv_err IS NOT INITIAL.
      rs-error = lv_err.
      RETURN.
    ENDIF.
    READ TABLE lt_refs INTO DATA(ls_ref) WITH KEY param_id = lv_pid.
    IF sy-subrc <> 0.
      rs-error = |报表 { rs-report_id } 没有参数 { lv_pid }|.
      RETURN.
    ENDIF.
    IF ls_ref-ref IS INITIAL.
      rs-error = |参数 { lv_pid } 没有字典参照, 没有搜索帮助|.
      RETURN.
    ENDIF.

    DATA(ls_res) = search_ref( iv_ref = ls_ref-ref iv_query = iv_query iv_max = iv_max ).
    ls_res-report_id = rs-report_id.
    ls_res-param_id  = lv_pid.
    rs = ls_res.

  ENDMETHOD.


  METHOD search_ref.

    DATA: ls_dd  TYPE ty_dd,
          lv_q   TYPE string,
          lv_max TYPE i.

    rs-query = iv_query.
    lv_q   = clean_query( iv_query ).
    lv_max = iv_max.
    IF lv_max <= 0.
      lv_max = gc_max.
    ELSEIF lv_max > gc_max_cap.
      lv_max = gc_max_cap.
    ENDIF.

    ls_dd = resolve( iv_ref ).
    IF ls_dd-ok = abap_false.
      rs-error = |字典参照 { iv_ref } 解析不了|.
      RETURN.
    ENDIF.
    rs-key_label = ls_dd-label.

    by_fixed( EXPORTING is_dd = ls_dd iv_query = lv_q iv_max = lv_max CHANGING cs = rs ).
    IF rs-source IS INITIAL.
      by_shlp( EXPORTING is_dd = ls_dd iv_query = lv_q iv_max = lv_max CHANGING cs = rs ).
    ENDIF.
    IF rs-source IS INITIAL.
      by_check( EXPORTING is_dd = ls_dd iv_query = lv_q iv_max = lv_max CHANGING cs = rs ).
    ENDIF.

    IF rs-items IS INITIAL.
      rs-message = COND #( WHEN lv_q IS NOT INITIAL THEN |没有匹配「{ lv_q }」的值|
                           ELSE `没有可选值` ) && rs-message.
    ELSEIF rs-truncated = abap_true.
      rs-message = |只显示前 { lv_max } 条, 输入关键字可以缩小范围|.
    ELSE.
      rs-message = |共 { lines( rs-items ) } 条|.
    ENDIF.

  ENDMETHOD.


  METHOD has_help.

    DATA: ls_dd   TYPE ty_dd,
          lv_cnt  TYPE i,
          ls_shlp TYPE shlp_descr,
          lv_key  TYPE string,
          lv_note TYPE string.

    ls_dd = resolve( iv_ref ).
    IF ls_dd-ok = abap_false.
      RETURN.
    ENDIF.
    IF ls_dd-checktab IS NOT INITIAL OR ls_dd-entitytab IS NOT INITIAL OR ls_dd-shlp IS NOT INITIAL.
      rv = abap_true.
      RETURN.
    ENDIF.
    IF ls_dd-domname IS NOT INITIAL.
      SELECT COUNT(*) FROM dd07l
        WHERE domname = @ls_dd-domname AND as4local = 'A'
        INTO @lv_cnt.
      IF lv_cnt > 0.
        rv = abap_true.
        RETURN.
      ENDIF.
    ENDIF.
    IF ls_dd-tab IS NOT INITIAL.
      get_shlp( EXPORTING is_dd = ls_dd IMPORTING es_shlp = ls_shlp ev_key = lv_key ev_note = lv_note ).
      IF ls_shlp-shlpname IS NOT INITIAL AND lv_key IS NOT INITIAL.
        rv = abap_true.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD report_refs.

    TYPES: BEGIN OF ty_rf,
             param_id  TYPE zai_rpt_param-param_id,
             ref_field TYPE c LENGTH 61,
           END OF ty_rf.
    TYPES: BEGIN OF ty_fp,
             parameter TYPE c LENGTH 30,
             structure TYPE c LENGTH 132,
           END OF ty_fp.
    DATA: lt_rf    TYPE STANDARD TABLE OF ty_rf WITH DEFAULT KEY,
          lv_rcols TYPE string VALUE `PARAM_ID, REF_FIELD`,
          lt_fp    TYPE STANDARD TABLE OF ty_fp WITH DEFAULT KEY,
          lv_fm    TYPE c LENGTH 30,
          ls_ref   TYPE ty_ref,
          lv_need  TYPE abap_bool,
          lv_kind  TYPE string,
          lv_dt    TYPE string,
          lv_sk    TYPE string,
          lv_lbl   TYPE string,
          ls_draft TYPE zcl_ai_rpt_scanner=>ty_draft.
    FIELD-SYMBOLS <ls_ref> TYPE ty_ref.

    CLEAR: et_refs, ev_error.

    SELECT SINGLE config_version, report_kind, progname FROM zai_rpt_def
      WHERE report_id = @iv_report_id AND active = 'X'
      INTO @DATA(ls_def).
    IF sy-subrc <> 0.
      ev_error = |报表 { iv_report_id } 没有登记或已停用|.
      RETURN.
    ENDIF.
    lv_kind = to_upper( condense( CONV string( ls_def-report_kind ) ) ).

    SELECT param_id, abap_name, display_label, data_type, sel_kind FROM zai_rpt_param
      WHERE report_id = @iv_report_id
        AND config_version = @ls_def-config_version
        AND active = 'X'
      ORDER BY sort_no, param_id
      INTO TABLE @DATA(lt_par).

    TRY.
        SELECT (lv_rcols) FROM zai_rpt_param
          WHERE report_id = @iv_report_id
            AND config_version = @ls_def-config_version
            AND active = 'X'
          INTO CORRESPONDING FIELDS OF TABLE @lt_rf.
      CATCH cx_sy_dynamic_osql_error cx_sy_open_sql_db.
        CLEAR lt_rf.
    ENDTRY.

    LOOP AT lt_par INTO DATA(ls_par).
      CLEAR ls_ref.
      ls_ref-param_id = to_upper( condense( CONV string( ls_par-param_id ) ) ).
      lv_dt = to_upper( condense( CONV string( ls_par-data_type ) ) ).
      lv_sk = to_upper( condense( CONV string( ls_par-sel_kind ) ) ).
      IF lv_sk = 'C' OR lv_sk = 'R' OR lv_sk = 'F' OR lv_dt = 'BOOL' OR lv_dt = 'ENUM' OR lv_dt CS 'DAT'.
        ls_ref-skip = abap_true.
      ENDIF.
      IF lv_sk = 'T'.
        ls_ref-skip     = abap_true.
        ls_ref-is_table = abap_true.
      ENDIF.
      lv_lbl = condense( CONV string( ls_par-display_label ) ).
      IF lv_lbl IS NOT INITIAL
         AND to_upper( lv_lbl ) <> ls_ref-param_id
         AND to_upper( lv_lbl ) <> to_upper( condense( CONV string( ls_par-abap_name ) ) ).
        ls_ref-label = lv_lbl.
      ENDIF.
      READ TABLE lt_rf INTO DATA(ls_rf) WITH KEY param_id = ls_par-param_id.
      IF sy-subrc = 0.
        ls_ref-ref = to_upper( condense( CONV string( ls_rf-ref_field ) ) ).
      ENDIF.
      IF ls_ref-ref IS INITIAL AND ( ls_ref-skip = abap_false OR ls_ref-is_table = abap_true ).
        lv_need = abap_true.
      ENDIF.
      APPEND ls_ref TO et_refs.
    ENDLOOP.

    IF lv_need = abap_false OR ls_def-progname IS INITIAL.
      RETURN.
    ENDIF.

    " 老登记没有 REF_FIELD: 现场取(函数读 FUPARAREF; 报表扫一遍源码)
    IF lv_kind = 'FUNC'.
      lv_fm = to_upper( condense( CONV string( ls_def-progname ) ) ).
      SELECT parameter, structure FROM fupararef
        WHERE funcname = @lv_fm AND r3state = 'A'
        INTO TABLE @lt_fp.
      LOOP AT et_refs ASSIGNING <ls_ref> WHERE ref IS INITIAL AND ( skip = abap_false OR is_table = abap_true ).
        READ TABLE lt_par INTO ls_par WITH KEY param_id = CONV zai_rpt_param-param_id( <ls_ref>-param_id ).
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        READ TABLE lt_fp INTO DATA(ls_fp) WITH KEY parameter = to_upper( condense( CONV string( ls_par-abap_name ) ) ).
        IF sy-subrc = 0.
          <ls_ref>-ref = to_upper( condense( CONV string( ls_fp-structure ) ) ).
        ENDIF.
      ENDLOOP.
    ELSE.
      ls_draft = zcl_ai_rpt_scanner=>scan( iv_prog = CONV string( ls_def-progname ) ).
      LOOP AT et_refs ASSIGNING <ls_ref> WHERE ref IS INITIAL AND skip = abap_false.
        READ TABLE ls_draft-params INTO DATA(ls_dp) WITH KEY param_id = <ls_ref>-param_id.
        IF sy-subrc = 0.
          <ls_ref>-ref = ls_dp-ref_field.
          IF <ls_ref>-label IS INITIAL AND ls_dp-display_label IS NOT INITIAL
             AND to_upper( ls_dp-display_label ) <> <ls_ref>-param_id.
            <ls_ref>-label = ls_dp-display_label.
          ENDIF.
        ENDIF.
      ENDLOOP.
    ENDIF.

  ENDMETHOD.


  METHOD access_error.

    DATA: lv_rid TYPE zai_rpt_def-report_id,
          lv_ok  TYPE abap_bool.

    IF iv_report_id IS INITIAL.
      rv = '没有报表编号'.
      RETURN.
    ENDIF.
    lv_rid = iv_report_id.
    SELECT SINGLE report_id FROM zai_rpt_def
      WHERE report_id = @lv_rid AND active = 'X'
      INTO @DATA(lv_hit).
    IF sy-subrc <> 0.
      rv = |报表 { iv_report_id } 没有登记或已停用|.
      RETURN.
    ENDIF.

    " 报表授权(用户权限批没上时类不存在 → 跳过)
    TRY.
        CALL METHOD ('ZCL_AI_ACCESS')=>('REPORT_OK')
          EXPORTING
            iv_src_type  = `REPORT`
            iv_report_id = iv_report_id
          RECEIVING
            rv           = lv_ok.
        IF lv_ok = abap_false.
          rv = |没有报表 { iv_report_id } 的使用权限|.
        ENDIF.
      CATCH cx_sy_dyn_call_error.
        CLEAR rv.
    ENDTRY.

  ENDMETHOD.


  METHOD resolve.

    DATA: lv_ref   TYPE string,
          lv_off   TYPE i,
          lv_tab   TYPE ddobjname,
          lv_fld   TYPE dfies-fieldname,
          lv_lfld  TYPE dfies-lfieldname,
          ls_df    TYPE dfies,
          lo_type  TYPE REF TO cl_abap_typedescr,
          lo_elem  TYPE REF TO cl_abap_elemdescr,
          lo_str   TYPE REF TO cl_abap_structdescr,
          lo_tab   TYPE REF TO cl_abap_tabledescr,
          lt_flds  TYPE ddfields,
          lv_roll  TYPE dd04l-rollname,
          lv_dom   TYPE dd01l-domname.

    lv_ref = to_upper( condense( iv_ref ) ).
    IF lv_ref IS INITIAL OR iv_depth > 2.
      RETURN.
    ENDIF.
    IF lv_ref CP 'SY-*'.
      REPLACE FIRST OCCURRENCE OF 'SY-' IN lv_ref WITH 'SYST-'.
    ENDIF.

    FIND FIRST OCCURRENCE OF '-' IN lv_ref MATCH OFFSET lv_off.
    IF sy-subrc = 0 AND lv_off > 0.
      lv_tab  = substring( val = lv_ref len = lv_off ).
      lv_fld  = substring( val = lv_ref off = lv_off + 1 ).
      lv_lfld = lv_fld.
      CALL FUNCTION 'DDIF_FIELDINFO_GET'
        EXPORTING
          tabname        = lv_tab
          fieldname      = lv_fld
          langu          = sy-langu
          lfieldname     = lv_lfld
        IMPORTING
          dfies_wa       = ls_df
        EXCEPTIONS
          not_found      = 1
          internal_error = 2
          OTHERS         = 3.
      IF sy-subrc <> 0 OR ls_df-rollname IS INITIAL.
        RETURN.
      ENDIF.
      rs-tab      = lv_tab.
      rs-fld      = lv_fld.
      rs-checktab = ls_df-checktable.
    ELSE.
      cl_abap_typedescr=>describe_by_name(
        EXPORTING  p_name         = lv_ref
        RECEIVING  p_descr_ref    = lo_type
        EXCEPTIONS type_not_found = 1
                   OTHERS         = 2 ).
      IF sy-subrc <> 0 OR lo_type IS NOT BOUND.
        RETURN.
      ENDIF.
      " 范围表 / 范围结构 → 取 LOW 的数据元素
      IF lo_type->kind = cl_abap_typedescr=>kind_table.
        lo_tab ?= lo_type.
        lo_type = lo_tab->get_table_line_type( ).
      ENDIF.
      IF lo_type->kind = cl_abap_typedescr=>kind_struct.
        lo_str ?= lo_type.
        lo_str->get_ddic_field_list(
          RECEIVING  p_field_list = lt_flds
          EXCEPTIONS not_found    = 1
                     no_ddic_type = 2
                     OTHERS       = 3 ).
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.
        READ TABLE lt_flds INTO ls_df WITH KEY fieldname = 'LOW'.
        IF sy-subrc <> 0 OR ls_df-rollname IS INITIAL.
          RETURN.
        ENDIF.
        rs = resolve( iv_ref = CONV string( ls_df-rollname ) iv_depth = iv_depth + 1 ).
        RETURN.
      ENDIF.
      IF lo_type->kind <> cl_abap_typedescr=>kind_elem.
        RETURN.
      ENDIF.
      lo_elem ?= lo_type.
      lo_elem->get_ddic_field(
        EXPORTING  p_langu      = sy-langu
        RECEIVING  p_flddescr   = ls_df
        EXCEPTIONS not_found    = 1
                   no_ddic_type = 2
                   OTHERS       = 3 ).
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      IF ls_df-rollname IS INITIAL.
        ls_df-rollname = lv_ref.
      ENDIF.
    ENDIF.

    rs-ok       = abap_true.
    rs-rollname = ls_df-rollname.
    rs-domname  = ls_df-domname.
    rs-convexit = ls_df-convexit.
    rs-label    = condense( COND string( WHEN ls_df-scrtext_m IS NOT INITIAL THEN CONV string( ls_df-scrtext_m )
                                         ELSE CONV string( ls_df-fieldtext ) ) ).

    lv_roll = rs-rollname.
    SELECT SINGLE shlpname, shlpfield FROM dd04l
      WHERE rollname = @lv_roll AND as4local = 'A'
      INTO ( @DATA(lv_sh), @DATA(lv_shf) ).
    IF sy-subrc = 0.
      rs-shlp      = lv_sh.
      rs-shlpfield = lv_shf.
    ENDIF.
    IF rs-domname IS NOT INITIAL.
      lv_dom = rs-domname.
      SELECT SINGLE entitytab FROM dd01l
        WHERE domname = @lv_dom AND as4local = 'A'
        INTO @DATA(lv_ent).
      IF sy-subrc = 0.
        rs-entitytab = lv_ent.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD by_fixed.

    DATA: lt_kt TYPE tt_kt,
          ls_kt TYPE ty_kt,
          lv_t  TYPE dd07t-ddtext.

    IF is_dd-domname IS INITIAL.
      RETURN.
    ENDIF.
    SELECT domvalue_l, valpos FROM dd07l
      WHERE domname = @is_dd-domname AND as4local = 'A'
      ORDER BY valpos
      INTO TABLE @DATA(lt_v).
    IF lt_v IS INITIAL.
      RETURN.
    ENDIF.
    LOOP AT lt_v INTO DATA(ls_v).
      IF ls_v-domvalue_l IS INITIAL.
        CONTINUE.
      ENDIF.
      CLEAR lv_t.
      SELECT SINGLE ddtext FROM dd07t
        WHERE domname = @is_dd-domname AND ddlanguage = @sy-langu
          AND as4local = 'A' AND valpos = @ls_v-valpos
        INTO @lv_t.
      IF hit( iv_key = ls_v-domvalue_l iv_text = lv_t iv_query = iv_query ) = abap_false.
        CONTINUE.
      ENDIF.
      ls_kt-k = ls_v-domvalue_l.
      ls_kt-t = lv_t.
      APPEND ls_kt TO lt_kt.
    ENDLOOP.

    cs-source      = 'FIXED'.
    cs-source_name = is_dd-domname.
    cs-text_label  = '说明'.
    fill_items( EXPORTING it_kt = lt_kt iv_rollname = `` iv_convexit = `` iv_max = iv_max
                CHANGING  cs = cs ).

  ENDMETHOD.


  METHOD get_shlp.

    DATA: lv_tab   TYPE tabname,
          lv_fld   TYPE fieldname,
          lv_name  TYPE shlpname,
          lt_shlp  TYPE shlp_desct,
          ls_one   TYPE shlp_descr,
          lv_rc    TYPE i.

    CLEAR: es_shlp, ev_key, ev_note.

    IF is_dd-tab IS NOT INITIAL AND is_dd-fld IS NOT INITIAL.
      lv_tab = is_dd-tab.
      lv_fld = is_dd-fld.
      TRY.
          CALL FUNCTION 'F4IF_DETERMINE_SEARCHHELP'
            EXPORTING
              tabname           = lv_tab
              fieldname         = lv_fld
            IMPORTING
              shlp              = es_shlp
            EXCEPTIONS
              field_not_found   = 1
              no_help_for_field = 2
              inconsistent_help = 3
              OTHERS            = 4.
          lv_rc = sy-subrc.
        CATCH cx_sy_dyn_call_error INTO DATA(lx1).
          lv_rc = 9.
          ev_note = |; 搜索帮助判断失败({ lx1->get_text( ) })|.
      ENDTRY.
      IF lv_rc <> 0.
        CLEAR es_shlp.
      ENDIF.
    ENDIF.

    IF es_shlp-shlpname IS INITIAL AND is_dd-shlp IS NOT INITIAL.
      lv_name = is_dd-shlp.
      TRY.
          CALL FUNCTION 'F4IF_GET_SHLP_DESCR'
            EXPORTING
              shlpname = lv_name
              shlptype = 'SH'
            IMPORTING
              shlp     = es_shlp.
        CATCH cx_sy_dyn_call_error INTO DATA(lx2).
          CLEAR es_shlp.
          ev_note = |; 搜索帮助读取失败({ lx2->get_text( ) })|.
      ENDTRY.
      IF is_dd-shlpfield IS NOT INITIAL.
        LOOP AT es_shlp-interface ASSIGNING FIELD-SYMBOL(<ls_if>).
          CLEAR <ls_if>-f4field.
          IF <ls_if>-shlpfield = is_dd-shlpfield.
            <ls_if>-f4field = 'X'.
          ENDIF.
        ENDLOOP.
      ENDIF.
    ENDIF.

    IF es_shlp-shlpname IS INITIAL.
      RETURN.
    ENDIF.

    " 集合搜索帮助 → 展开, 取第一个和本字段有映射的基本帮助
    IF es_shlp-intdescr-issimple <> 'X'.
      TRY.
          CALL FUNCTION 'F4IF_EXPAND_SEARCHHELP'
            EXPORTING
              shlp_top = es_shlp
            IMPORTING
              shlp_tab = lt_shlp.
        CATCH cx_sy_dyn_call_error INTO DATA(lx3).
          CLEAR lt_shlp.
          ev_note = |; 集合搜索帮助展开失败({ lx3->get_text( ) })|.
      ENDTRY.
      CLEAR es_shlp.
      LOOP AT lt_shlp INTO ls_one.
        LOOP AT ls_one-interface TRANSPORTING NO FIELDS WHERE f4field = 'X'.
          EXIT.
        ENDLOOP.
        IF sy-subrc = 0.
          es_shlp = ls_one.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF es_shlp-shlpname IS INITIAL.
        READ TABLE lt_shlp INTO es_shlp INDEX 1.
      ENDIF.
      IF es_shlp-shlpname IS INITIAL.
        RETURN.
      ENDIF.
    ENDIF.

    " 字段描述没带全时补读一次
    IF es_shlp-fielddescr IS INITIAL.
      lv_name = es_shlp-shlpname.
      TRY.
          CALL FUNCTION 'F4IF_GET_SHLP_DESCR'
            EXPORTING
              shlpname = lv_name
              shlptype = es_shlp-shlptype
            IMPORTING
              shlp     = ls_one.
          es_shlp-fielddescr = ls_one-fielddescr.
          es_shlp-fieldprop  = ls_one-fieldprop.
        CATCH cx_sy_dyn_call_error.
          CLEAR ls_one.
      ENDTRY.
    ENDIF.

    READ TABLE es_shlp-interface INTO DATA(ls_if1) WITH KEY f4field = 'X'.
    IF sy-subrc = 0.
      ev_key = ls_if1-shlpfield.
    ELSE.
      LOOP AT es_shlp-interface INTO ls_if1 WHERE valfield IS NOT INITIAL.
        ev_key = ls_if1-shlpfield.
        EXIT.
      ENDLOOP.
    ENDIF.
    IF ev_key IS INITIAL.
      READ TABLE es_shlp-interface INTO ls_if1 INDEX 1.
      IF sy-subrc = 0.
        ev_key = ls_if1-shlpfield.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD by_shlp.

    DATA: ls_shlp  TYPE shlp_descr,
          lv_key   TYPE string,
          lv_text  TYPE string,
          lv_note  TYPE string,
          lt_kt    TYPE tt_kt,
          lv_up    TYPE string,
          lv_roll  TYPE string,
          lv_conv  TYPE string,
          lt_prop  TYPE ddshfprops.

    get_shlp( EXPORTING is_dd = is_dd IMPORTING es_shlp = ls_shlp ev_key = lv_key ev_note = lv_note ).
    cs-message = cs-message && lv_note.
    IF ls_shlp-shlpname IS INITIAL OR lv_key IS INITIAL.
      RETURN.
    ENDIF.

    " 文字列: 列表里第一个较长的字符列(不是编号列)
    lt_prop = ls_shlp-fieldprop.
    SORT lt_prop BY shlplispos.
    LOOP AT lt_prop INTO DATA(ls_prop) WHERE shlplispos > 0 AND fieldname <> lv_key.
      READ TABLE ls_shlp-fielddescr INTO DATA(ls_fd) WITH KEY fieldname = ls_prop-fieldname.
      IF sy-subrc = 0 AND ls_fd-inttype = 'C' AND ls_fd-leng >= 10.
        lv_text = ls_prop-fieldname.
        cs-text_label = condense( COND string( WHEN ls_fd-scrtext_m IS NOT INITIAL THEN CONV string( ls_fd-scrtext_m )
                                               ELSE CONV string( ls_fd-fieldtext ) ) ).
        EXIT.
      ENDIF.
    ENDLOOP.
    READ TABLE ls_shlp-fielddescr INTO ls_fd WITH KEY fieldname = lv_key.
    IF sy-subrc = 0.
      lv_roll = ls_fd-rollname.
      lv_conv = ls_fd-convexit.
      IF cs-key_label IS INITIAL.
        cs-key_label = condense( CONV string( ls_fd-scrtext_m ) ).
      ENDIF.
    ENDIF.

    IF iv_query IS INITIAL.
      shlp_select( EXPORTING is_shlp = ls_shlp iv_field = `` iv_low = `` iv_key = lv_key iv_text = lv_text
                             iv_max = iv_max
                   CHANGING  ct_kt = lt_kt cv_note = lv_note ).
    ELSE.
      lv_up = to_upper( iv_query ).
      shlp_select( EXPORTING is_shlp = ls_shlp iv_field = lv_key iv_low = |*{ lv_up }*| iv_key = lv_key
                             iv_text = lv_text iv_max = iv_max
                   CHANGING  ct_kt = lt_kt cv_note = lv_note ).
      IF lines( lt_kt ) <= iv_max AND lv_text IS NOT INITIAL.
        shlp_select( EXPORTING is_shlp = ls_shlp iv_field = lv_text iv_low = |*{ iv_query }*| iv_key = lv_key
                               iv_text = lv_text iv_max = iv_max
                     CHANGING  ct_kt = lt_kt cv_note = lv_note ).
        IF lines( lt_kt ) <= iv_max AND lv_up <> iv_query.
          shlp_select( EXPORTING is_shlp = ls_shlp iv_field = lv_text iv_low = |*{ lv_up }*| iv_key = lv_key
                                 iv_text = lv_text iv_max = iv_max
                       CHANGING  ct_kt = lt_kt cv_note = lv_note ).
        ENDIF.
      ENDIF.
    ENDIF.

    IF lt_kt IS INITIAL.
      cs-message = cs-message && lv_note.
      CLEAR cs-text_label.
      RETURN.
    ENDIF.
    cs-source      = 'SHLP'.
    cs-source_name = ls_shlp-shlpname.
    fill_items( EXPORTING it_kt = lt_kt iv_rollname = lv_roll iv_convexit = lv_conv iv_max = iv_max
                CHANGING  cs = cs ).

  ENDMETHOD.


  METHOD shlp_select.

    DATA: ls_s    TYPE shlp_descr,
          ls_sel  TYPE ddshselopt,
          lt_rec  TYPE STANDARD TABLE OF seahlpres WITH DEFAULT KEY,
          lt_desc TYPE STANDARD TABLE OF dfies WITH DEFAULT KEY,
          lt_new  TYPE tt_kt,
          ls_kt   TYPE ty_kt,
          lv_rec  TYPE string,
          lv_max  TYPE i,
          lv_cs   TYPE i,
          ls_dk   TYPE dfies,
          ls_dt   TYPE dfies.

    ls_s = is_shlp.
    IF iv_field IS NOT INITIAL.
      ls_sel-shlpname  = ls_s-shlpname.
      ls_sel-shlpfield = iv_field.
      ls_sel-sign      = 'I'.
      ls_sel-option    = 'CP'.
      ls_sel-low       = iv_low.
      APPEND ls_sel TO ls_s-selopt.
    ENDIF.
    lv_max = iv_max + 1.

    TRY.
        CALL FUNCTION 'F4IF_SELECT_VALUES'
          EXPORTING
            shlp           = ls_s
            maxrows        = lv_max
            call_shlp_exit = ' '
          TABLES
            record_tab     = lt_rec
            recdescr_tab   = lt_desc.
      CATCH cx_sy_dyn_call_error INTO DATA(lx).
        cv_note = |; 搜索帮助 { ls_s-shlpname } 取值失败({ lx->get_text( ) })|.
        RETURN.
    ENDTRY.

    IF lt_desc IS INITIAL.
      lt_desc = ls_s-fielddescr.
    ENDIF.
    READ TABLE lt_desc INTO ls_dk WITH KEY fieldname = iv_key.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    IF iv_text IS NOT INITIAL.
      READ TABLE lt_desc INTO ls_dt WITH KEY fieldname = iv_text.
    ENDIF.
    lv_cs = cl_abap_char_utilities=>charsize.

    LOOP AT lt_rec INTO DATA(ls_rec).
      lv_rec = ls_rec-string.
      CLEAR ls_kt.
      ls_kt-k = cut( iv_s = lv_rec iv_off = ls_dk-offset / lv_cs iv_len = ls_dk-leng ).
      IF ls_dt-fieldname IS NOT INITIAL.
        ls_kt-t = cut( iv_s = lv_rec iv_off = ls_dt-offset / lv_cs iv_len = ls_dt-leng ).
      ENDIF.
      IF ls_kt-k IS NOT INITIAL.
        APPEND ls_kt TO lt_new.
      ENDIF.
    ENDLOOP.
    add_kt( EXPORTING it_kt = lt_new iv_max = iv_max CHANGING ct_kt = ct_kt ).

  ENDMETHOD.


  METHOD by_check.

    DATA: lv_ct    TYPE dd03l-tabname,
          lv_tt    TYPE dd03l-tabname,
          lv_src   TYPE string,
          lv_keyf  TYPE string,
          lv_txtf  TYPE string,
          lv_lang  TYPE string,
          lv_cols  TYPE string,
          lv_where TYPE string,
          lv_order TYPE string,
          lv_pat   TYPE string,
          lv_patu  TYPE string,
          lv_max   TYPE i,
          lt_kt    TYPE tt_kt,
          lv_dom   TYPE dd03l-domname,
          lv_roll  TYPE string,
          lv_conv  TYPE string.

    lv_ct = COND #( WHEN is_dd-checktab IS NOT INITIAL THEN is_dd-checktab ELSE is_dd-entitytab ).
    IF lv_ct IS INITIAL OR lv_ct = '*'.
      RETURN.
    ENDIF.
    lv_dom = is_dd-domname.

    " 检查表里和本字段同域的主键列
    SELECT fieldname, position FROM dd03l
      WHERE tabname = @lv_ct AND as4local = 'A' AND keyflag = 'X' AND domname = @lv_dom
      ORDER BY position
      INTO TABLE @DATA(lt_kf).
    READ TABLE lt_kf INTO DATA(ls_kf) INDEX 1.
    IF sy-subrc = 0.
      lv_keyf = ls_kf-fieldname.
    ELSEIF is_dd-fld IS NOT INITIAL.
      SELECT SINGLE fieldname FROM dd03l
        WHERE tabname = @lv_ct AND as4local = 'A' AND fieldname = @is_dd-fld
        INTO @DATA(lv_same).
      IF sy-subrc = 0.
        lv_keyf = lv_same.
      ENDIF.
    ENDIF.
    IF lv_keyf IS INITIAL.
      RETURN.
    ENDIF.

    " 文本表(同键 + 语言列)
    SELECT SINGLE tabname FROM dd08l
      WHERE checktable = @lv_ct AND frkart = 'TEXT' AND as4local = 'A'
      INTO @lv_tt.
    IF sy-subrc = 0 AND lv_tt IS NOT INITIAL.
      SELECT fieldname, keyflag, domname, inttype, leng, position FROM dd03l
        WHERE tabname = @lv_tt AND as4local = 'A'
        ORDER BY position
        INTO TABLE @DATA(lt_tf).
      LOOP AT lt_tf INTO DATA(ls_tf) WHERE keyflag = 'X' AND domname = 'SPRAS'.
        lv_lang = ls_tf-fieldname.
        EXIT.
      ENDLOOP.
      LOOP AT lt_tf INTO ls_tf WHERE keyflag = space AND inttype = 'C'.
        IF ls_tf-fieldname(1) <> '.'.
          lv_txtf = ls_tf-fieldname.
          EXIT.
        ENDIF.
      ENDLOOP.
      READ TABLE lt_tf TRANSPORTING NO FIELDS WITH KEY fieldname = CONV dd03l-fieldname( lv_keyf ).
      IF lv_lang IS INITIAL OR lv_txtf IS INITIAL OR sy-subrc <> 0.
        CLEAR: lv_tt, lv_txtf, lv_lang.
      ENDIF.
    ELSE.
      CLEAR lv_tt.
    ENDIF.
    IF lv_tt IS INITIAL.
      SELECT fieldname, keyflag, inttype, leng, position FROM dd03l
        WHERE tabname = @lv_ct AND as4local = 'A' AND keyflag = @space AND inttype = 'C'
        ORDER BY position
        INTO TABLE @DATA(lt_cf).
      LOOP AT lt_cf INTO DATA(ls_cf) WHERE leng >= 10.
        IF ls_cf-fieldname(1) <> '.'.
          lv_txtf = ls_cf-fieldname.
          EXIT.
        ENDIF.
      ENDLOOP.
      lv_src = lv_ct.
    ELSE.
      lv_src = lv_tt.
    ENDIF.

    lv_cols = |{ lv_keyf } AS k|.
    IF lv_txtf IS NOT INITIAL.
      lv_cols = lv_cols && |, { lv_txtf } AS t|.
    ENDIF.
    IF lv_lang IS NOT INITIAL.
      lv_where = |{ lv_lang } = '{ sy-langu }'|.
    ENDIF.
    IF iv_query IS NOT INITIAL.
      lv_pat  = like_pat( iv_query ).
      lv_patu = like_pat( to_upper( iv_query ) ).
      DATA(lv_qw) = |{ lv_keyf } LIKE '{ lv_patu }' ESCAPE '#'|.
      IF lv_txtf IS NOT INITIAL.
        lv_qw = lv_qw && | OR { lv_txtf } LIKE '{ lv_pat }' ESCAPE '#'|.
        IF lv_pat <> lv_patu.
          lv_qw = lv_qw && | OR { lv_txtf } LIKE '{ lv_patu }' ESCAPE '#'|.
        ENDIF.
      ENDIF.
      lv_where = COND #( WHEN lv_where IS INITIAL THEN |( { lv_qw } )|
                         ELSE |{ lv_where } AND ( { lv_qw } )| ).
    ENDIF.
    lv_order = `k`.
    lv_max   = iv_max + 1.

    TRY.
        SELECT DISTINCT (lv_cols) FROM (lv_src)
          WHERE (lv_where)
          ORDER BY (lv_order)
          INTO CORRESPONDING FIELDS OF TABLE @lt_kt
          UP TO @lv_max ROWS.
      CATCH cx_sy_dynamic_osql_error cx_sy_open_sql_db INTO DATA(lx).
        cs-message = cs-message && |; 检查表 { lv_src } 读取失败({ lx->get_text( ) })|.
        RETURN.
    ENDTRY.

    " 文本表没有当前语言文字时退回检查表本身的键
    IF lt_kt IS INITIAL AND lv_tt IS NOT INITIAL AND iv_query IS INITIAL.
      lv_cols = |{ lv_keyf } AS k|.
      TRY.
          SELECT DISTINCT (lv_cols) FROM (lv_ct)
            ORDER BY (lv_order)
            INTO CORRESPONDING FIELDS OF TABLE @lt_kt
            UP TO @lv_max ROWS.
        CATCH cx_sy_dynamic_osql_error cx_sy_open_sql_db.
          CLEAR lt_kt.
      ENDTRY.
    ENDIF.

    IF lt_kt IS INITIAL.
      RETURN.
    ENDIF.
    SELECT SINGLE rollname FROM dd03l
      WHERE tabname = @lv_ct AND fieldname = @lv_keyf AND as4local = 'A'
      INTO @DATA(lv_kroll).
    IF sy-subrc = 0.
      lv_roll = lv_kroll.
    ENDIF.
    lv_conv = is_dd-convexit.
    cs-source      = 'CHECK'.
    cs-source_name = lv_src.
    IF lv_txtf IS NOT INITIAL.
      cs-text_label = '名称'.
    ENDIF.
    fill_items( EXPORTING it_kt = lt_kt iv_rollname = lv_roll iv_convexit = lv_conv iv_max = iv_max
                CHANGING  cs = cs ).

  ENDMETHOD.


  METHOD add_kt.

    LOOP AT it_kt INTO DATA(ls_kt).
      IF lines( ct_kt ) > iv_max.
        EXIT.
      ENDIF.
      READ TABLE ct_kt TRANSPORTING NO FIELDS WITH KEY k = ls_kt-k.
      IF sy-subrc <> 0.
        APPEND ls_kt TO ct_kt.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD fill_items.

    DATA ls_it TYPE ty_item.

    CLEAR cs-items.
    LOOP AT it_kt INTO DATA(ls_kt).
      IF lines( cs-items ) >= iv_max.
        cs-truncated = abap_true.
        EXIT.
      ENDIF.
      CLEAR ls_it.
      ls_it-key  = condense( CONV string( ls_kt-k ) ).
      ls_it-text = condense( CONV string( ls_kt-t ) ).
      ls_it-display = ls_it-key.
      IF iv_convexit IS NOT INITIAL AND iv_rollname IS NOT INITIAL.
        ls_it-display = out_value( iv_value = ls_kt-k iv_rollname = iv_rollname ).
        IF ls_it-display IS INITIAL.
          ls_it-display = ls_it-key.
        ENDIF.
      ENDIF.
      APPEND ls_it TO cs-items.
    ENDLOOP.

  ENDMETHOD.


  METHOD out_value.

    DATA: lr  TYPE REF TO data,
          lv_c TYPE c LENGTH 255.
    FIELD-SYMBOLS <lv> TYPE any.

    TRY.
        CREATE DATA lr TYPE (iv_rollname).
        ASSIGN lr->* TO <lv>.
        <lv> = iv_value.
        WRITE <lv> TO lv_c.
        rv = condense( CONV string( lv_c ) ).
      CATCH cx_sy_create_data_error cx_sy_conversion_error.
        CLEAR rv.
    ENDTRY.

  ENDMETHOD.


  METHOD hit.

    DATA: lv_k TYPE string,
          lv_t TYPE string,
          lv_q TYPE string.

    IF iv_query IS INITIAL.
      rv = abap_true.
      RETURN.
    ENDIF.
    lv_k = to_upper( iv_key ).
    lv_t = to_upper( iv_text ).
    lv_q = to_upper( iv_query ).
    IF lv_k CS lv_q OR lv_t CS lv_q.
      rv = abap_true.
    ENDIF.

  ENDMETHOD.


  METHOD like_pat.

    DATA lv TYPE string.

    lv = iv_query.
    REPLACE ALL OCCURRENCES OF '#' IN lv WITH '##'.
    REPLACE ALL OCCURRENCES OF '%' IN lv WITH '#%'.
    REPLACE ALL OCCURRENCES OF '_' IN lv WITH '#_'.
    lv = cl_abap_dyn_prg=>escape_quotes( lv ).
    rv = |%{ lv }%|.

  ENDMETHOD.


  METHOD clean_query.

    rv = iv_query.
    REPLACE ALL OCCURRENCES OF '*' IN rv WITH ``.
    REPLACE ALL OCCURRENCES OF '+' IN rv WITH ``.
    rv = condense( rv ).
    IF strlen( rv ) > 40.
      rv = substring( val = rv len = 40 ).
    ENDIF.

  ENDMETHOD.


  METHOD cut.

    DATA lv_len TYPE i.

    IF iv_off < 0 OR iv_off >= strlen( iv_s ) OR iv_len <= 0.
      RETURN.
    ENDIF.
    lv_len = iv_len.
    IF iv_off + lv_len > strlen( iv_s ).
      lv_len = strlen( iv_s ) - iv_off.
    ENDIF.
    rv = condense( substring( val = iv_s off = iv_off len = lv_len ) ).

  ENDMETHOD.

ENDCLASS.
