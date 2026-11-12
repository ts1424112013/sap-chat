*=======================================================================
* 对象:   ZCL_AI_RESULT_LOOKUP
* 用途:   报表执行里关联查表(功能计划书/联合分析/01 §4; 11.5 记录 #02)
*         只读工具 lookup_by_result: 拿当前这份报表结果里某一列的值(如「鴻海料號」),
*         到指定表按关联字段批量查(如 ZIDPMMTLK 的料号字段), 把查到的字段(如 TLK58 = COO)
*         接回结果的每一行, 再按 query_result 同样的 筛选 / 分组 / 聚合 / 排序 返回一张小表
*         ① 关联值清单由后端从结果的全部存储行里取, 不经过模型(1021 个料号让模型抄太慢、易错、会被截断)
*         ② 结果号由 AGENT_SERVICE 给(本轮定位并核对过的那一份), 模型不能指定
*         ③ 不存新结果: 每次追问重新查一次(表读按关联值分批, 很快), 不新增表、不改前端
* 放行:   RPT_TABLE_LOOKUP = X + 用户开通「数据分析」场景 + SQL_ANALYSIS_ENABLED + 用户允许 SQL
*         (ZAI_CHAT_USER-SQL_ALLOWED, 字段存在时) + 本会话有报表结果; 查表本身沿用数据分析的检查:
*         敏感表黑名单(ZCL_AI_SQL_GUARD=>is_sensitive) + 透明表 / 视图 + VIEW_AUTHORITY_CHECK
* 取数:   字段名只认 DDIC 里有的; 值先按字段的转换例程转成内部格式(料号前导零等), 写成字面量
*         (单引号转义)拼进动态 WHERE, 每批 LOOKUP_BATCH 个; 不拼模型给的任何 SQL 文本
* 工具参数(args 对象):
*         {"table":"ZIDPMMTLK","key_field":"<表里的关联字段>","source_column":"<结果里的关联列>",
*          "fields":["TLK58"],"conditions":[{"field":"WERKS","op":"eq","value":"1001"}],
*          + query_result 的 filters / group_by / metrics / columns / sort / limit / offset / purpose}
*         查回的字段在结果里的列名 = 字段名(与原列重名时为 字段名_表名)
* 配置:   ZAI_CHAT_CFG: RPT_TABLE_LOOKUP(X = 开, 默认关) / LOOKUP_MAX_KEYS(5000) /
*         LOOKUP_MAX_ROWS(50000, 表读行数上限) / LOOKUP_BATCH(200)
* 依赖:   ZCL_AI_RESULT_QUERY V1.1 / ZCL_AI_COMBO_SERVICE(norm_key) / ZCL_AI_SQL_GUARD /
*         ZCL_AI_ACCESS / ZCL_AI_REPORT_SERVICE(find_latest_artifact) / ZCL_AI_TASK_SERVICE / ZCL_AI_ODATA_SHAPER
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用); 先激活 ZCL_AI_RESULT_QUERY V1.1
* V1.0    20261105: 首版
* ★ 重贴后核对标记: 有 METHOD allowed / tool_description / run / prepare / to_internal / out_text;
*   "SELECT (" 只在 METHOD prepare; prepare 内有 VIEW_AUTHORITY_CHECK 与 zcl_ai_sql_guard=>is_sensitive(
*=======================================================================
CLASS zcl_ai_result_lookup DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS gc_tool TYPE string VALUE 'lookup_by_result'.

    " 工具开关(RPT_TABLE_LOOKUP = X 才开)
    CLASS-METHODS enabled
      RETURNING VALUE(rv) TYPE abap_bool.

    " 当前用户在这个会话里能不能用(开关 + 数据分析场景 + SQL 开关与用户 + 会话有报表结果)
    CLASS-METHODS allowed
      IMPORTING iv_session_id TYPE string
      RETURNING VALUE(rv)     TYPE abap_bool.

    CLASS-METHODS tool_description
      RETURNING VALUE(rv) TYPE string.

    " 执行一次 lookup_by_result; 出参同 ZCL_AI_RESULT_QUERY=>run
    CLASS-METHODS run
      IMPORTING iv_artifact_id TYPE string
                iv_args_json   TYPE string
                iv_session_id  TYPE string OPTIONAL
      EXPORTING ev_json        TYPE string
                es_ds          TYPE zcl_ai_data_analysis_service=>ty_dataset
                ev_label       TYPE string
                ev_detail      TYPE string
                ev_error       TYPE string.

  PRIVATE SECTION.

    TYPES tt_str TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_fld,
             name     TYPE string,      " DDIC 字段名
             col      TYPE string,      " 接回结果后的列名
             label    TYPE string,
             convexit TYPE string,
             lower    TYPE abap_bool,   " X = 允许小写
             numeric  TYPE abap_bool,
             datatype TYPE string,
             eltype   TYPE REF TO cl_abap_elemdescr,
           END OF ty_fld.
    TYPES tt_fld TYPE STANDARD TABLE OF ty_fld WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_kmap,
             ikey TYPE string,          " 内部格式(表里的值)
             nkey TYPE string,          " 结果里的值 norm_key 后
           END OF ty_kmap.
    TYPES tt_kmap TYPE HASHED TABLE OF ty_kmap WITH UNIQUE KEY ikey.
    TYPES: BEGIN OF ty_hit,
             nkey TYPE string,
             cnt  TYPE i,
             vals TYPE tt_str,
           END OF ty_hit.
    TYPES tt_hit TYPE HASHED TABLE OF ty_hit WITH UNIQUE KEY nkey.
    TYPES: BEGIN OF ty_vc,
             val TYPE string,
             cnt TYPE i,
           END OF ty_vc.
    TYPES tt_vc TYPE HASHED TABLE OF ty_vc WITH UNIQUE KEY val.

    CLASS-METHODS cfg_int
      IMPORTING iv_key     TYPE string
                iv_default TYPE i
                iv_min     TYPE i
                iv_max     TYPE i
      RETURNING VALUE(rv)  TYPE i.
    CLASS-METHODS sql_user_ok
      RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS quote
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS safe_name
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.
    " 字段信息(DDIC); 不存在 → ev_error
    CLASS-METHODS field_info
      IMPORTING iv_tab   TYPE string
                iv_name  TYPE string
                it_dd    TYPE ddfields
      EXPORTING es_fld   TYPE ty_fld
                ev_error TYPE string.
    " 外部值 → 内部格式字符串(转换例程 / NUMC 补零 / 大写); 失败 ev_error
    CLASS-METHODS to_internal
      IMPORTING is_fld   TYPE ty_fld
                iv_val   TYPE string
      EXPORTING ev_int   TYPE string
                ev_error TYPE string.
    " 表里的值 → 显示用文字(有转换例程走 _OUTPUT)
    CLASS-METHODS out_text
      IMPORTING is_fld    TYPE ty_fld
                iv_val    TYPE any
      RETURNING VALUE(rv) TYPE string.
    " 读表 + 接回: 返回接好的数据集与给模型的统计片段
    CLASS-METHODS prepare
      IMPORTING iv_artifact_id TYPE string
                iv_args_json   TYPE string
                iv_session_id  TYPE string
      EXPORTING es_joined      TYPE zcl_ai_odata_shaper=>ty_dataset
                ev_res_text    TYPE string
                ev_label       TYPE string
                ev_head        TYPE string
                ev_extra       TYPE string
                ev_table       TYPE string
                ev_error       TYPE string.

ENDCLASS.



CLASS zcl_ai_result_lookup IMPLEMENTATION.


  METHOD enabled.
    rv = xsdbool( zcl_ai_task_service=>read_cfg_str( 'RPT_TABLE_LOOKUP' ) = 'X' ).
  ENDMETHOD.


  METHOD allowed.
    rv = abap_false.
    IF enabled( ) = abap_false.
      RETURN.
    ENDIF.
    IF zcl_ai_access=>scene_ok( 'DATA' ) = abap_false.
      RETURN.
    ENDIF.
    IF zcl_ai_sql_guard=>is_enabled( ) = abap_false OR sql_user_ok( ) = abap_false.
      RETURN.
    ENDIF.
    IF iv_session_id IS INITIAL
       OR zcl_ai_report_service=>find_latest_artifact( iv_session_id = iv_session_id ) IS INITIAL.
      RETURN.
    ENDIF.
    rv = abap_true.
  ENDMETHOD.


  METHOD tool_description.

    rv = '拿当前这份报表结果里某一列的值, 到指定 SAP 表按关联字段批量查, 把查到的字段接回结果的每一行, '
      && '再在接好的数据上做 筛选 / 分组 / 聚合 / 排序(后端计算, 只读; 只能用本轮正在分析的这一份结果, '
      && '不需要也不能指定结果号; 关联值由后端从全部行里取, 不要自己罗列料号)。'
      && '用户要"这些料号去表 X 查某字段 / 补一列 / 关联表 X"时用本工具; 不知道表里的关联字段名时先 describe_table。'
      && 'args: {"table":"<表名>","key_field":"<表里的关联字段, 如料号字段>","source_column":"<结果里的关联列名或标题>",'
      && '"fields":["<要带回的字段, 最多 10 个>"],'
      && '"conditions":[{"field":"<表字段>","op":"eq|ne|gt|ge|lt|le|in","value":"<值>","values":["<in 用>"]}](可选, 表上的附加条件, 最多 5 个),'
      && '以及 query_result 的 filters / group_by / metrics / columns / sort / limit / offset / purpose(可选, '
      && '作用在接好的数据上; 查回的字段列名 = 字段名, 与原列重名时为 字段名_表名)}。'
      && '原结果列上的 filters 会先筛行再查表(如只查 1AM 开头的料号)。'
      && '返回里 keys_total / keys_hit / keys_miss = 关联值个数 / 表里查到 / 没查到, '
      && 'value_counts = 每个带回字段的取值分布。'
      && '例: {"table":"ZIDPMMTLK","key_field":"MATNR","source_column":"鴻海料號","fields":["TLK58"],'
      && '"filters":[{"column":"鴻海料號","op":"starts_with","value":"1AM"}],'
      && '"group_by":["TLK58"],"metrics":[{"column":"可用庫存","agg":"sum"}],"sort":{"column":"可用庫存","order":"desc"},'
      && '"purpose":"1AM 料号按 COO 汇总可用库存"}'.

  ENDMETHOD.


  METHOD cfg_int.
    DATA lv_val TYPE string.
    rv = iv_default.
    lv_val = zcl_ai_task_service=>read_cfg_str( iv_key ).
    CONDENSE lv_val NO-GAPS.
    IF lv_val IS INITIAL OR lv_val CN '0123456789' OR strlen( lv_val ) > 7.
      RETURN.
    ENDIF.
    rv = lv_val.
    IF rv < iv_min.
      rv = iv_min.
    ELSEIF rv > iv_max.
      rv = iv_max.
    ENDIF.
  ENDMETHOD.


  METHOD sql_user_ok.
    " 同 ZCL_AI_SQL_GUARD 的用户检查: 启用用户; SQL_ALLOWED 字段存在时必须是 X
    SELECT SINGLE * FROM zai_chat_user
      WHERE userid = @sy-uname AND active = 'X'
      INTO @DATA(ls_user).
    IF sy-subrc <> 0.
      rv = abap_false.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT 'SQL_ALLOWED' OF STRUCTURE ls_user TO FIELD-SYMBOL(<lv_allowed>).
    IF sy-subrc = 0.
      rv = xsdbool( <lv_allowed> = 'X' ).
    ELSE.
      rv = abap_true.
    ENDIF.
  ENDMETHOD.


  METHOD quote.
    rv = iv.
    REPLACE ALL OCCURRENCES OF `'` IN rv WITH `''`.
    rv = `'` && rv && `'`.
  ENDMETHOD.


  METHOD safe_name.
    rv = xsdbool( iv IS NOT INITIAL AND strlen( iv ) <= 30
                  AND iv CO 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/' ).
  ENDMETHOD.


  METHOD field_info.

    DATA: lo_td  TYPE REF TO cl_abap_typedescr,
          lv_nm  TYPE string,
          lv_ref TYPE string.
    CLEAR: es_fld, ev_error.
    lv_nm = to_upper( condense( iv_name ) ).
    IF safe_name( lv_nm ) = abap_false OR lv_nm CA '/'.
      ev_error = |字段名「{ iv_name }」不合法|.
      RETURN.
    ENDIF.
    READ TABLE it_dd INTO DATA(ls_d) WITH KEY fieldname = lv_nm.
    IF sy-subrc <> 0 OR ls_d-datatype = 'CLNT'.
      ev_error = |表 { iv_tab } 没有字段 { lv_nm }, 请用 describe_table 确认字段名|.
      RETURN.
    ENDIF.
    lv_ref = |{ iv_tab }-{ lv_nm }|.
    cl_abap_typedescr=>describe_by_name(
      EXPORTING  p_name         = lv_ref
      RECEIVING  p_descr_ref    = lo_td
      EXCEPTIONS type_not_found = 1
                 OTHERS         = 2 ).
    IF sy-subrc <> 0 OR lo_td IS NOT BOUND OR lo_td->kind <> cl_abap_typedescr=>kind_elem.
      ev_error = |字段 { iv_tab }-{ lv_nm } 不是基本类型, 不能用于关联查表|.
      RETURN.
    ENDIF.
    es_fld-eltype   ?= lo_td.
    es_fld-name     = lv_nm.
    es_fld-col      = lv_nm.
    es_fld-label    = COND #( WHEN ls_d-scrtext_m IS NOT INITIAL THEN CONV string( ls_d-scrtext_m )
                              WHEN ls_d-fieldtext IS NOT INITIAL THEN CONV string( ls_d-fieldtext )
                              ELSE lv_nm ).
    es_fld-convexit = condense( CONV string( ls_d-convexit ) ).
    es_fld-lower    = xsdbool( ls_d-lowercase IS NOT INITIAL ).
    es_fld-datatype = condense( CONV string( ls_d-datatype ) ).
    CASE ls_d-inttype.
      WHEN 'P' OR 'I' OR 'F' OR 'b' OR 's' OR '8' OR 'a' OR 'e'.
        es_fld-numeric = abap_true.
    ENDCASE.

  ENDMETHOD.


  METHOD to_internal.

    DATA: lr_v  TYPE REF TO data,
          lv_fm TYPE string,
          lv_rc TYPE i.
    FIELD-SYMBOLS <lv_v> TYPE any.
    CLEAR: ev_int, ev_error.

    DATA(lv_in) = condense( iv_val ).
    IF strlen( lv_in ) > 60 OR lv_in CA cl_abap_char_utilities=>cr_lf.
      ev_error = |值 { lv_in } 太长或含换行|.
      RETURN.
    ENDIF.
    IF is_fld-lower = abap_false.
      lv_in = to_upper( lv_in ).
    ENDIF.
    IF ( is_fld-datatype = 'NUMC' OR is_fld-datatype = 'DATS' OR is_fld-datatype = 'TIMS' )
       AND lv_in IS NOT INITIAL AND lv_in CN '0123456789'.
      ev_error = |字段 { is_fld-name } 的值必须是数字(收到 { lv_in })|.
      RETURN.
    ENDIF.

    CREATE DATA lr_v TYPE HANDLE is_fld-eltype.
    ASSIGN lr_v->* TO <lv_v>.
    IF is_fld-convexit IS NOT INITIAL AND lv_in IS NOT INITIAL.
      lv_fm = |CONVERSION_EXIT_{ is_fld-convexit }_INPUT|.
      TRY.
          CALL FUNCTION lv_fm
            EXPORTING
              input  = lv_in
            IMPORTING
              output = <lv_v>
            EXCEPTIONS
              OTHERS = 1.
          lv_rc = sy-subrc.
        CATCH cx_root.
          lv_rc = 9.
      ENDTRY.
      IF lv_rc <> 0.
        ev_error = |值 { lv_in } 转换失败(转换例程 { is_fld-convexit })|.
        RETURN.
      ENDIF.
    ELSE.
      TRY.
          <lv_v> = lv_in.
        CATCH cx_root.
          ev_error = |值 { lv_in } 不能放进字段 { is_fld-name }|.
          RETURN.
      ENDTRY.
    ENDIF.
    ev_int = |{ <lv_v> }|.

  ENDMETHOD.


  METHOD out_text.

    DATA: lv_out TYPE c LENGTH 255,
          lv_fm  TYPE string.
    IF is_fld-convexit IS NOT INITIAL AND iv_val IS NOT INITIAL.
      lv_fm = |CONVERSION_EXIT_{ is_fld-convexit }_OUTPUT|.
      TRY.
          CALL FUNCTION lv_fm
            EXPORTING
              input  = iv_val
            IMPORTING
              output = lv_out
            EXCEPTIONS
              OTHERS = 1.
          IF sy-subrc = 0.
            rv = condense( CONV string( lv_out ) ).
            RETURN.
          ENDIF.
        CATCH cx_root.
          CLEAR lv_out.
      ENDTRY.
    ENDIF.
    rv = condense( |{ iv_val }| ).

  ENDMETHOD.


  METHOD prepare.

    DATA: lo       TYPE REF TO zcl_ai_odata_shaper,
          ls_src   TYPE zcl_ai_odata_shaper=>ty_dataset,
          lv_rid   TYPE string,
          lv_sess  TYPE string,
          lv_tab   TYPE string,
          lv_scol  TYPE string,
          lv_sci   TYPE i,
          lt_dd    TYPE ddfields,
          lo_sd    TYPE REF TO cl_abap_structdescr,
          ls_key   TYPE ty_fld,
          ls_fld   TYPE ty_fld,
          lt_fld   TYPE tt_fld,
          lv_err   TYPE string,
          lt_cond  TYPE tt_str,
          lv_int   TYPE string,
          lt_kmap  TYPE tt_kmap,
          ls_kmap  TYPE ty_kmap,
          lt_keys  TYPE tt_str,
          lt_hit   TYPE tt_hit,
          ls_hit   TYPE ty_hit,
          lv_nkey  TYPE string,
          lv_cell  TYPE string.
    CLEAR: es_joined, ev_res_text, ev_label, ev_head, ev_extra, ev_table, ev_error.

    " ---- 1. 放行条件(调用前路由已核过一次, 这里再核, 防止绕过) ----
    IF enabled( ) = abap_false.
      ev_error = '关联查表未开启(ZAI_CHAT_CFG: RPT_TABLE_LOOKUP = X)'.
      RETURN.
    ENDIF.
    IF zcl_ai_access=>scene_ok( 'DATA' ) = abap_false.
      ev_error = '关联查表需要「数据分析」场景的使用权限'.
      RETURN.
    ENDIF.
    IF zcl_ai_sql_guard=>is_enabled( ) = abap_false OR sql_user_ok( ) = abap_false.
      ev_error = '当前用户未开通表数据查询(SQL_ANALYSIS_ENABLED / 用户 SQL 权限)'.
      RETURN.
    ENDIF.

    " ---- 2. 参数 ----
    CREATE OBJECT lo.
    IF lo->parse( COND #( WHEN iv_args_json IS INITIAL THEN `{}` ELSE iv_args_json ) ) = abap_false.
      ev_error = |args 不是合法 JSON: { lo->get_error( ) }|.
      RETURN.
    ENDIF.
    DATA(lv_root) = lo->root( ).
    IF lo->kind( lv_root ) <> 'O'.
      ev_error = 'args 必须是 JSON 对象'.
      RETURN.
    ENDIF.
    lv_tab  = to_upper( condense( lo->text( lo->child( iv_id = lv_root iv_name = 'table' ) ) ) ).
    lv_scol = condense( lo->text( lo->child( iv_id = lv_root iv_name = 'source_column' ) ) ).
    DATA(lv_keyn) = to_upper( condense( lo->text( lo->child( iv_id = lv_root iv_name = 'key_field' ) ) ) ).
    IF lv_tab IS INITIAL OR lv_scol IS INITIAL OR lv_keyn IS INITIAL.
      ev_error = 'table / key_field / source_column 都必须给'.
      RETURN.
    ENDIF.
    ev_table = lv_tab.

    " ---- 3. 表核对: 名字 / 敏感表 / 透明表或视图 / SAP 表权限 ----
    IF safe_name( lv_tab ) = abap_false.
      ev_error = |表名「{ lv_tab }」不合法|.
      RETURN.
    ENDIF.
    IF zcl_ai_sql_guard=>is_sensitive( lv_tab ) = abap_true.
      ev_error = |表 { lv_tab } 属于受保护表, 不允许查询|.
      RETURN.
    ENDIF.
    SELECT SINGLE tabname FROM dd02l
      WHERE tabname = @lv_tab AND as4local = 'A' AND tabclass IN ( 'TRANSP', 'VIEW' )
      INTO @DATA(lv_found).
    IF sy-subrc <> 0.
      ev_error = |表 { lv_tab } 不存在或不是透明表 / 视图, 请用 describe_table 确认表名|.
      RETURN.
    ENDIF.
    DATA lv_vname TYPE dd02v-tabname.
    lv_vname = lv_tab.
    CALL FUNCTION 'VIEW_AUTHORITY_CHECK'
      EXPORTING
        view_name                = lv_vname
      EXCEPTIONS
        no_authority             = 1
        no_clientindep_authority = 2
        table_not_found          = 3
        OTHERS                   = 4.
    IF sy-subrc <> 0.
      ev_error = |没有权限读取表 { lv_tab } (需要 S_TABU_NAM/S_TABU_DIS 显示权限)|.
      RETURN.
    ENDIF.
    TRY.
        lo_sd ?= cl_abap_typedescr=>describe_by_name( lv_tab ).
        lt_dd = lo_sd->get_ddic_field_list( p_langu = sy-langu ).
      CATCH cx_root.
        ev_error = |读取表 { lv_tab } 的结构失败|.
        RETURN.
    ENDTRY.

    " ---- 4. 字段 ----
    field_info( EXPORTING iv_tab = lv_tab iv_name = lv_keyn it_dd = lt_dd
                IMPORTING es_fld = ls_key ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF ls_key-numeric = abap_true.
      ev_error = |关联字段 { ls_key-name } 是数值类型, 请用代码 / 编号类字段关联|.
      RETURN.
    ENDIF.
    DATA(lt_fk) = lo->kids( lo->child( iv_id = lv_root iv_name = 'fields' ) ).
    IF lt_fk IS INITIAL.
      ev_error = 'fields 至少给一个要带回的字段'.
      RETURN.
    ENDIF.
    IF lines( lt_fk ) > 10.
      ev_error = 'fields 最多 10 个'.
      RETURN.
    ENDIF.

    " ---- 5. 原结果: 全部存储行; 关联列 ----
    DATA(lv_combo) = xsdbool( iv_session_id IS NOT INITIAL
                              AND zcl_ai_combo_service=>is_combo( iv_artifact_id ) = abap_true ).
    IF lv_combo = abap_true.
      zcl_ai_combo_service=>analysis_context(
        EXPORTING iv_artifact_id = iv_artifact_id iv_session_id = iv_session_id iv_browser = abap_true
        IMPORTING es_data = ls_src ev_label = ev_label ev_error = ev_error ).
      IF ev_error IS INITIAL AND ls_src-truncated = abap_true.
        ev_error = '联合结果的明细有截断，请缩小来源范围后重新组合再查表'.
      ENDIF.
    ELSE.
      zcl_ai_result_query=>load_dataset(
        EXPORTING iv_artifact_id = iv_artifact_id
        IMPORTING es_ds          = ls_src
                  ev_label       = ev_label
                  ev_report_id   = lv_rid
                  ev_session_id  = lv_sess
                  ev_error       = ev_error ).
    ENDIF.
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    lv_sci = zcl_ai_result_query=>find_col( is_ds = ls_src iv_name = lv_scol ).
    IF lv_sci = 0.
      ev_error = |结果里没有列「{ lv_scol }」。可用的列: { zcl_ai_result_query=>col_list( ls_src ) }|.
      RETURN.
    ENDIF.

    LOOP AT lt_fk INTO DATA(lv_fid).
      field_info( EXPORTING iv_tab = lv_tab iv_name = lo->text( lv_fid ) it_dd = lt_dd
                  IMPORTING es_fld = ls_fld ev_error = ev_error ).
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
      IF line_exists( lt_fld[ name = ls_fld-name ] ).
        CONTINUE.
      ENDIF.
      " 列名与原结果重名时加表名
      IF zcl_ai_result_query=>find_col( is_ds = ls_src iv_name = ls_fld-col ) > 0.
        ls_fld-col = |{ ls_fld-name }_{ lv_tab }|.
        REPLACE ALL OCCURRENCES OF '/' IN ls_fld-col WITH '_'.
      ENDIF.
      ls_fld-label = |{ ls_fld-label }·{ lv_tab }|.
      APPEND ls_fld TO lt_fld.
    ENDLOOP.

    " ---- 6. 接好后的列结构; 按原结果列上的 filters 先筛行(整个 args 在这里按列核对) ----
    es_joined-columns = ls_src-columns.
    LOOP AT lt_fld INTO ls_fld.
      APPEND VALUE #( name = ls_fld-col label = ls_fld-label is_numeric = ls_fld-numeric ) TO es_joined-columns.
    ENDLOOP.
    zcl_ai_result_query=>prefilter_rows(
      EXPORTING is_schema    = es_joined
                iv_args_json = iv_args_json
                iv_max_ci    = lines( ls_src-columns )
      IMPORTING ev_error     = ev_error
      CHANGING  ct_rows      = ls_src-rows ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.

    " ---- 7. 表上的附加条件 ----
    DATA(lt_ck) = lo->kids( lo->child( iv_id = lv_root iv_name = 'conditions' ) ).
    IF lines( lt_ck ) > 5.
      ev_error = 'conditions 最多 5 个'.
      RETURN.
    ENDIF.
    LOOP AT lt_ck INTO DATA(lv_cid).
      DATA: ls_cf   TYPE ty_fld,
            lv_op   TYPE string,
            lt_cv   TYPE tt_str,
            lt_cq   TYPE tt_str,
            lv_cval TYPE string.
      CLEAR: ls_cf, lt_cv, lt_cq.
      field_info( EXPORTING iv_tab = lv_tab iv_name = lo->text( lo->child( iv_id = lv_cid iv_name = 'field' ) ) it_dd = lt_dd
                  IMPORTING es_fld = ls_cf ev_error = ev_error ).
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
      lv_op = to_lower( condense( lo->text( lo->child( iv_id = lv_cid iv_name = 'op' ) ) ) ).
      IF lv_op IS INITIAL.
        lv_op = 'eq'.
      ENDIF.
      DATA(lt_cvk) = lo->kids( lo->child( iv_id = lv_cid iv_name = 'values' ) ).
      LOOP AT lt_cvk INTO DATA(lv_cvid).
        APPEND lo->text( lv_cvid ) TO lt_cv.
      ENDLOOP.
      lv_cval = lo->text( lo->child( iv_id = lv_cid iv_name = 'value' ) ).
      IF lt_cv IS INITIAL.
        APPEND lv_cval TO lt_cv.
      ENDIF.
      IF lines( lt_cv ) > 50.
        ev_error = 'conditions 里 values 最多 50 个'.
        RETURN.
      ENDIF.
      LOOP AT lt_cv INTO lv_cval.
        to_internal( EXPORTING is_fld = ls_cf iv_val = lv_cval
                     IMPORTING ev_int = lv_int ev_error = ev_error ).
        IF ev_error IS NOT INITIAL.
          RETURN.
        ENDIF.
        APPEND quote( lv_int ) TO lt_cq.
      ENDLOOP.
      CASE lv_op.
        WHEN 'eq' OR '='.
          APPEND |{ ls_cf-name } = { lt_cq[ 1 ] }| TO lt_cond.
        WHEN 'ne' OR '<>' OR '!='.
          APPEND |{ ls_cf-name } <> { lt_cq[ 1 ] }| TO lt_cond.
        WHEN 'gt' OR '>'.
          APPEND |{ ls_cf-name } > { lt_cq[ 1 ] }| TO lt_cond.
        WHEN 'ge' OR '>='.
          APPEND |{ ls_cf-name } >= { lt_cq[ 1 ] }| TO lt_cond.
        WHEN 'lt' OR '<'.
          APPEND |{ ls_cf-name } < { lt_cq[ 1 ] }| TO lt_cond.
        WHEN 'le' OR '<='.
          APPEND |{ ls_cf-name } <= { lt_cq[ 1 ] }| TO lt_cond.
        WHEN 'in'.
          APPEND |{ ls_cf-name } IN ( { concat_lines_of( table = lt_cq sep = `, ` ) } )| TO lt_cond.
        WHEN OTHERS.
          ev_error = |conditions 不认识的 op { lv_op }(可用 eq ne gt ge lt le in)|.
          RETURN.
      ENDCASE.
    ENDLOOP.

    " ---- 8. 关联值: 筛选后各行的关联列去重, 转内部格式 ----
    DATA(lv_maxk) = cfg_int( iv_key = 'LOOKUP_MAX_KEYS' iv_default = 5000 iv_min = 100 iv_max = 20000 ).
    DATA lv_bad TYPE i.
    LOOP AT ls_src-rows INTO DATA(ls_row).
      CLEAR lv_cell.
      READ TABLE ls_row-cells INTO lv_cell INDEX lv_sci.
      lv_cell = condense( lv_cell ).
      IF lv_cell IS INITIAL.
        CONTINUE.
      ENDIF.
      to_internal( EXPORTING is_fld = ls_key iv_val = lv_cell
                   IMPORTING ev_int = lv_int ev_error = lv_err ).
      IF lv_err IS NOT INITIAL.
        lv_bad = lv_bad + 1.
        CONTINUE.
      ENDIF.
      IF line_exists( lt_kmap[ ikey = lv_int ] ).
        CONTINUE.
      ENDIF.
      IF lines( lt_kmap ) >= lv_maxk.
        ev_error = |关联值超过 { lv_maxk } 个(LOOKUP_MAX_KEYS), 请先用 filters 缩小范围|.
        RETURN.
      ENDIF.
      INSERT VALUE #( ikey = lv_int
                      nkey = COND #( WHEN lv_combo = abap_true THEN lv_int
                                     ELSE zcl_ai_combo_service=>norm_key( lv_cell ) ) ) INTO TABLE lt_kmap.
      APPEND lv_int TO lt_keys.
    ENDLOOP.
    IF lt_keys IS INITIAL.
      ev_error = |筛选后结果列「{ lv_scol }」没有可用的关联值| &&
                 COND string( WHEN lv_bad > 0 THEN |({ lv_bad } 个值转换失败, 如 { lv_err })| ELSE `` ).
      RETURN.
    ENDIF.

    " ---- 9. 分批读表(动态结构 = 关联字段 + 带回字段) ----
    DATA: lt_comp  TYPE cl_abap_structdescr=>component_table,
          lt_sel   TYPE tt_str,
          lo_line  TYPE REF TO cl_abap_structdescr,
          lo_ttab  TYPE REF TO cl_abap_tabledescr,
          lr_tab   TYPE REF TO data,
          lt_q     TYPE tt_str,
          lv_where TYPE string,
          lv_sel   TYPE string,
          lv_left  TYPE i,
          lv_read  TYPE i,
          lv_fi    TYPE i,
          lv_ik    TYPE string,
          lv_to    TYPE i.
    FIELD-SYMBOLS: <lt_db> TYPE STANDARD TABLE,
                   <ls_db> TYPE any,
                   <lv_c>  TYPE any.
    APPEND VALUE #( name = ls_key-name type = ls_key-eltype ) TO lt_comp.
    APPEND ls_key-name TO lt_sel.
    LOOP AT lt_fld INTO ls_fld.
      IF ls_fld-name <> ls_key-name.
        APPEND VALUE #( name = ls_fld-name type = ls_fld-eltype ) TO lt_comp.
        APPEND ls_fld-name TO lt_sel.
      ENDIF.
    ENDLOOP.
    TRY.
        lo_line = cl_abap_structdescr=>create( lt_comp ).
        lo_ttab = cl_abap_tabledescr=>create( p_line_type = lo_line ).
        CREATE DATA lr_tab TYPE HANDLE lo_ttab.
      CATCH cx_root.
        ev_error = '构造读表结构失败'.
        RETURN.
    ENDTRY.
    ASSIGN lr_tab->* TO <lt_db>.
    lv_sel = concat_lines_of( table = lt_sel sep = `, ` ).

    DATA(lv_batch) = cfg_int( iv_key = 'LOOKUP_BATCH' iv_default = 200 iv_min = 20 iv_max = 1000 ).
    DATA(lv_maxr)  = cfg_int( iv_key = 'LOOKUP_MAX_ROWS' iv_default = 50000 iv_min = 1000 iv_max = 200000 ).
    DATA(lv_extra_w) = concat_lines_of( table = lt_cond sep = ` AND ` ).
    DATA(lv_cap) = abap_false.
    DATA(lv_n) = lines( lt_keys ).
    DATA(lv_from) = 1.
    WHILE lv_from <= lv_n.
      CLEAR lt_q.
      lv_to = lv_from + lv_batch - 1.
      IF lv_to > lv_n.
        lv_to = lv_n.
      ENDIF.
      LOOP AT lt_keys INTO lv_ik FROM lv_from TO lv_to.
        APPEND quote( lv_ik ) TO lt_q.
      ENDLOOP.
      lv_from = lv_from + lv_batch.
      lv_where = |{ ls_key-name } IN ( { concat_lines_of( table = lt_q sep = `, ` ) } )|.
      IF lv_extra_w IS NOT INITIAL.
        lv_where = |{ lv_where } AND { lv_extra_w }|.
      ENDIF.
      lv_left = lv_maxr - lv_read.
      IF lv_left <= 0.
        lv_cap = abap_true.
        EXIT.
      ENDIF.
      CLEAR <lt_db>.
      TRY.
          SELECT (lv_sel) FROM (lv_tab) WHERE (lv_where)
            INTO CORRESPONDING FIELDS OF TABLE @<lt_db> UP TO @lv_left ROWS.
        CATCH cx_root INTO DATA(lx_sql).
          ev_error = |读表 { lv_tab } 失败: { lx_sql->get_text( ) }|.
          RETURN.
      ENDTRY.
      lv_read = lv_read + lines( <lt_db> ).

      LOOP AT <lt_db> ASSIGNING <ls_db>.
        ASSIGN COMPONENT ls_key-name OF STRUCTURE <ls_db> TO <lv_c>.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        READ TABLE lt_kmap INTO ls_kmap WITH TABLE KEY ikey = |{ <lv_c> }|.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        READ TABLE lt_hit ASSIGNING FIELD-SYMBOL(<ls_hit>) WITH TABLE KEY nkey = ls_kmap-nkey.
        IF sy-subrc <> 0.
          CLEAR ls_hit.
          ls_hit-nkey = ls_kmap-nkey.
          DO lines( lt_fld ) TIMES.
            APPEND `` TO ls_hit-vals.
          ENDDO.
          INSERT ls_hit INTO TABLE lt_hit ASSIGNING <ls_hit>.
        ENDIF.
        <ls_hit>-cnt = <ls_hit>-cnt + 1.
        IF lv_combo = abap_true AND <ls_hit>-cnt > 1.
          ev_error = |表 { lv_tab } 有多个匹配记录，请增加表上的筛选条件以唯一定位数据|.
          RETURN.
        ENDIF.
        " 同一关联值多行: 每个字段取第一个非空值
        LOOP AT lt_fld INTO ls_fld.
          lv_fi = sy-tabix.
          READ TABLE <ls_hit>-vals ASSIGNING FIELD-SYMBOL(<lv_hv>) INDEX lv_fi.
          IF sy-subrc = 0 AND <lv_hv> IS INITIAL.
            ASSIGN COMPONENT ls_fld-name OF STRUCTURE <ls_db> TO <lv_c>.
            IF sy-subrc = 0.
              <lv_hv> = out_text( is_fld = ls_fld iv_val = <lv_c> ).
            ENDIF.
          ENDIF.
        ENDLOOP.
      ENDLOOP.
    ENDWHILE.
    IF lv_combo = abap_true AND ( lv_cap = abap_true OR lv_read >= lv_maxr ).
      ev_error = |表 { lv_tab } 已读到行数上限 { lv_maxr }，请缩小筛选范围后再查表|.
      RETURN.
    ENDIF.

    " ---- 10. 接回结果每一行; 统计 ----
    DATA: lt_vc    TYPE tt_vc,
          lv_hitk  TYPE i,
          lv_dup   TYPE i,
          lt_miss  TYPE tt_str,
          lt_parts TYPE tt_str,
          lt_vcj   TYPE tt_str.
    LOOP AT ls_src-rows INTO ls_row.
      CLEAR: lv_cell, lv_nkey.
      READ TABLE ls_row-cells INTO lv_cell INDEX lv_sci.
      lv_cell = condense( lv_cell ).
      IF lv_cell IS NOT INITIAL.
        IF lv_combo = abap_true.
          to_internal( EXPORTING is_fld = ls_key iv_val = lv_cell
                       IMPORTING ev_int = lv_nkey ev_error = lv_err ).
        ELSE.
          lv_nkey = zcl_ai_combo_service=>norm_key( lv_cell ).
        ENDIF.
      ENDIF.
      READ TABLE lt_hit INTO ls_hit WITH TABLE KEY nkey = lv_nkey.
      IF sy-subrc <> 0.
        CLEAR ls_hit.
      ENDIF.
      DO lines( lt_fld ) TIMES.
        CLEAR lv_cell.
        READ TABLE ls_hit-vals INTO lv_cell INDEX sy-index.
        APPEND lv_cell TO ls_row-cells.
      ENDDO.
      APPEND ls_row TO es_joined-rows.
    ENDLOOP.
    es_joined-total     = lines( es_joined-rows ).
    es_joined-truncated = ls_src-truncated.

    LOOP AT lt_kmap INTO ls_kmap.
      READ TABLE lt_hit INTO ls_hit WITH TABLE KEY nkey = ls_kmap-nkey.
      IF sy-subrc = 0.
        lv_hitk = lv_hitk + 1.
        IF ls_hit-cnt > 1.
          lv_dup = lv_dup + 1.
        ENDIF.
      ELSEIF lines( lt_miss ) < 10.
        APPEND ls_kmap-nkey TO lt_miss.
      ENDIF.
    ENDLOOP.

    " 每个带回字段的取值分布(前 10, 按行数)
    DATA(lv_base) = lines( ls_src-columns ).
    LOOP AT lt_fld INTO ls_fld.
      lv_fi = sy-tabix.
      CLEAR: lt_vc, lt_parts.
      LOOP AT es_joined-rows INTO ls_row.
        CLEAR lv_cell.
        READ TABLE ls_row-cells INTO lv_cell INDEX lv_base + lv_fi.
        READ TABLE lt_vc ASSIGNING FIELD-SYMBOL(<ls_vc>) WITH TABLE KEY val = lv_cell.
        IF sy-subrc = 0.
          <ls_vc>-cnt = <ls_vc>-cnt + 1.
        ELSE.
          INSERT VALUE #( val = lv_cell cnt = 1 ) INTO TABLE lt_vc.
        ENDIF.
      ENDLOOP.
      DATA lt_vcs TYPE STANDARD TABLE OF ty_vc WITH DEFAULT KEY.
      lt_vcs = lt_vc.
      SORT lt_vcs BY cnt DESCENDING val ASCENDING.
      LOOP AT lt_vcs INTO DATA(ls_vcs) TO 10.
        APPEND |\{"value":{ zcl_ai_odata_shaper=>json_str( COND #( WHEN ls_vcs-val IS INITIAL THEN `(空)` ELSE ls_vcs-val ) ) },| &&
               |"rows":{ ls_vcs-cnt }\}| TO lt_parts.
      ENDLOOP.
      APPEND |{ zcl_ai_odata_shaper=>json_str( ls_fld-col ) }:\{"distinct":{ lines( lt_vc ) },| &&
             |"top":[{ concat_lines_of( table = lt_parts sep = `,` ) }]\}| TO lt_vcj.
    ENDLOOP.

    DATA(lv_miss_j) = ``.
    LOOP AT lt_miss INTO lv_cell.
      lv_miss_j = COND #( WHEN lv_miss_j IS INITIAL THEN zcl_ai_odata_shaper=>json_str( lv_cell )
                          ELSE lv_miss_j && `,` && zcl_ai_odata_shaper=>json_str( lv_cell ) ).
    ENDLOOP.
    DATA(lv_cols_j) = ``.
    LOOP AT lt_fld INTO ls_fld.
      lv_cols_j = COND #( WHEN lv_cols_j IS INITIAL THEN zcl_ai_odata_shaper=>json_str( ls_fld-col )
                          ELSE lv_cols_j && `,` && zcl_ai_odata_shaper=>json_str( ls_fld-col ) ).
    ENDLOOP.

    ev_head = |关联查表 { lv_tab }: { lines( lt_kmap ) } 个关联值, 查到 { lv_hitk } 个, 没查到 { lines( lt_kmap ) - lv_hitk } 个|.
    IF lv_dup > 0.
      ev_head = |{ ev_head }, { lv_dup } 个在表里有多条记录(取第一条非空值)|.
    ENDIF.
    IF lv_cap = abap_true OR lv_read >= lv_maxr.
      ev_head = |{ ev_head }; 表读达到上限 { lv_maxr } 行, 结果可能不全|.
    ENDIF.
    ev_res_text = |{ zcl_ai_task_service=>short_id( iv_artifact_id ) }「{ ev_label }」关联 { lv_tab }|.
    ev_extra =
      |"lookup":\{"table":{ zcl_ai_odata_shaper=>json_str( lv_tab ) },"key_field":{ zcl_ai_odata_shaper=>json_str( ls_key-name ) },| &&
      |"source_column":{ zcl_ai_odata_shaper=>json_str( lv_scol ) },"rows_used":{ lines( ls_src-rows ) },| &&
      |"keys_total":{ lines( lt_kmap ) },"keys_hit":{ lv_hitk },"keys_miss":{ lines( lt_kmap ) - lv_hitk },| &&
      |"keys_bad":{ lv_bad },"keys_multi_rows":{ lv_dup },"table_rows_read":{ lv_read },| &&
      |"capped":{ COND string( WHEN lv_cap = abap_true OR lv_read >= lv_maxr THEN `true` ELSE `false` ) },| &&
      |"miss_sample":[{ lv_miss_j }],"new_columns":[{ lv_cols_j }],| &&
      |"value_counts":\{{ concat_lines_of( table = lt_vcj sep = `,` ) }\}\},|.

  ENDMETHOD.


  METHOD run.

    DATA: ls_joined TYPE zcl_ai_odata_shaper=>ty_dataset,
          lv_res    TYPE string,
          lv_label  TYPE string,
          lv_head   TYPE string,
          lv_extra  TYPE string,
          lv_tab    TYPE string.
    CLEAR: ev_json, es_ds, ev_label, ev_detail, ev_error.

    prepare( EXPORTING iv_artifact_id = iv_artifact_id
                       iv_args_json   = iv_args_json
                       iv_session_id  = iv_session_id
             IMPORTING es_joined      = ls_joined
                       ev_res_text    = lv_res
                       ev_label       = lv_label
                       ev_head        = lv_head
                       ev_extra       = lv_extra
                       ev_table       = lv_tab
                       ev_error       = ev_error ).
    IF ev_error IS NOT INITIAL.
      ev_label = |关联查表失败: { ev_error }|.
      ev_json  = |\{"ok":false,"error":{ zcl_ai_odata_shaper=>json_str( ev_error ) },| &&
                 |"hint":"改正 args 后可以再调一次, 或直接 action=final 如实说明"\}|.
      RETURN.
    ENDIF.

    zcl_ai_result_query=>query_dataset(
      EXPORTING is_ds        = ls_joined
                iv_args_json = iv_args_json
                iv_res_text  = lv_res
                iv_source    = |LOOKUP:{ lv_tab }|
                iv_label     = |{ lv_label } + { lv_tab }|
                iv_extra     = lv_extra
      IMPORTING ev_json      = ev_json
                es_ds        = es_ds
                ev_label     = ev_label
                ev_detail    = ev_detail
                ev_error     = ev_error ).
    IF ev_error IS INITIAL.
      ev_label  = |{ lv_head }; { ev_label }|.
      ev_detail = |{ lv_head }; { ev_detail }|.
    ELSE.
      ev_label = |关联查表失败: { ev_error }|.
    ENDIF.

  ENDMETHOD.


ENDCLASS.
