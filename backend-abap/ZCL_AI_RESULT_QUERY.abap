*=======================================================================
* 对象:   ZCL_AI_RESULT_QUERY
* 用途:   报表结果分析用全量数据(11.4 进度: ZDPSD021 共 1727 行, 模型只看到前 8000
*         字符约 40 行, 给出的「库存最高前 10」是错的)
*         ① context: 给模型的结果数据 —— 行数不多就给全部明细; 否则给后端在全部存储行上
*            算好的统计 + 分组汇总 + 按主要数值列排出的最大 / 最小各 N 行
*         ② 只读工具 query_result: 模型给 筛选 / 分组 / 聚合 / 排序 / 取前 N,
*            后端在全部存储行上算, 只回一张小表(同时进前端表格)
*         只能查本轮已定位并核对过的那一份结果: 结果号由 AGENT_SERVICE 给, 模型不能指定
* 来源:   ZCL_AI_COMBO_SERVICE=>load_result(报表执行 ZAI_RPT_RESULT / Fiori ZAI_FRPT_DATA;
*         核对: 本人的 + AVAILABLE + 运行 READY + 报表授权; Fiori 还要求 ANALYZE_ENABLED)
*         同一次请求内按结果号缓存(工具多次调用不重复读表)
* 工具参数(args 对象, 列可写列名或列标题):
*         {"filters":[{"column":"倉碼","op":"eq","value":"S33F"}],
*          "group_by":["鴻海料號"],
*          "metrics":[{"column":"庫存","agg":"sum"}],
*          "columns":["鴻海料號","庫存"],            (只在不分组、不聚合时用)
*          "sort":{"column":"庫存","order":"desc"},
*          "limit":10, "offset":0, "purpose":"库存最高前 10 料号"}
*         offset = 跳过排序后的前几行(翻页; 返回里有 total / more / next_offset)
*         op: eq ne gt ge lt le contains not_contains starts_with in not_in empty not_empty
*         agg: sum avg max min count count_distinct(count 不给 column = 行数)
* 配置:   ZAI_CHAT_CFG: RESULT_QUERY_ENABLED(N = 关工具, 默认开) /
*         RESULT_QRY_MAX_ROWS(20000, 读取上限) / RESULT_QUERY_MAX_OUT(100, 工具最多返回行数) /
*         RESULT_CTX_ALL_ROWS(150, 不超过就给全部明细) / RESULT_CTX_EDGE(10) /
*         RESULT_CTX_GROUPS(30) / RESULT_CTX_CHARS(24000)
* 依赖:   ZCL_AI_COMBO_SERVICE V1.0.2 / ZCL_AI_ODATA_SHAPER / ZCL_AI_FIORI_REPORT_SERVICE(compute_stats) /
*         ZCL_AI_DATA_ANALYSIS_SERVICE(ty_dataset / build_datasets_json) / ZCL_AI_TASK_SERVICE
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用)
* V1.0    20261104: 首版
* V1.0.1  20261104: 翻页 —— 新参数 offset(跳过排序后的前几行, 默认 0); 返回加 total / offset /
*         returned / more / next_offset. 一页放不进回填模型的字符上限时, 这一页缩到模型实际看到的
*         行数(前端表格同步), next_offset 按它算, 翻页不会漏行
* V1.1    20261105(功能计划书/联合分析/01 §4): 给关联查表 ZCL_AI_RESULT_LOOKUP 复用 ——
*         ① run 的查询主体挪到新公共方法 query_dataset(传入任意数据集; run = load + query_dataset,
*            行为不变); 新可选参数 iv_extra = 插在 "dataset" 前的 JSON 片段(以逗号结尾)
*         ② 新公共方法 load_dataset(= load) / prefilter_rows(只按前 iv_max_ci 列上的筛选条件先筛行)
*         ③ find_col / col_list 挪到公共区
* ★ 重贴后核对标记: 有 METHOD context / run / query_dataset / load_dataset / prefilter_rows /
*   execute / parse_query / sort_rows / load; ty_query 有 offset; query_dataset 内有 next_offset 与 "rows_sent":;
*   execute 内有 count_distinct; context 内有 zcl_ai_combo_service=>group_json(
*=======================================================================
CLASS zcl_ai_result_query DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS gc_tool TYPE string VALUE 'query_result'.

    " 工具开关(默认开; RESULT_QUERY_ENABLED = N 关)
    CLASS-METHODS enabled
      RETURNING VALUE(rv) TYPE abap_bool.

    " 给模型看的工具说明(TOOL_REGISTRY 注册用)
    CLASS-METHODS tool_description
      RETURNING VALUE(rv) TYPE string.

    " 结果数据上下文(只是数据部分; 标题与使用规则由调用方拼)
    " ev_all = X: 全部明细都在上下文里, 不需要工具
    CLASS-METHODS context
      IMPORTING iv_artifact_id  TYPE string
                iv_need_analyze TYPE abap_bool DEFAULT abap_false
      EXPORTING ev_text         TYPE string
                ev_label        TYPE string
                ev_report_id    TYPE string
                ev_session_id   TYPE string
                ev_rows         TYPE i
                ev_all          TYPE abap_bool
                ev_error        TYPE string.

    " 执行一次 query_result(iv_args_json = 模型给的 args 对象)
    " ev_json 回给模型(失败也有, ok:false + 原因); es_ds 进前端表格(失败为空)
    CLASS-METHODS run
      IMPORTING iv_artifact_id  TYPE string
                iv_args_json    TYPE string
                iv_need_analyze TYPE abap_bool DEFAULT abap_false
      EXPORTING ev_json         TYPE string
                es_ds           TYPE zcl_ai_data_analysis_service=>ty_dataset
                ev_label        TYPE string
                ev_detail       TYPE string
                ev_error        TYPE string.

    " V1.1: 在给定数据集上执行一次查询(args 同 query_result); run = load + 本方法
    " iv_res_text = 回给模型的结果说明; iv_source = 数据集来源标记; iv_label = 默认标题前缀;
    " iv_extra = 插在 "dataset" 之前的 JSON 片段(必须以逗号结尾, 可空)
    CLASS-METHODS query_dataset
      IMPORTING is_ds        TYPE zcl_ai_odata_shaper=>ty_dataset
                iv_args_json TYPE string
                iv_res_text  TYPE string
                iv_source    TYPE string
                iv_label     TYPE string
                iv_extra     TYPE string OPTIONAL
      EXPORTING ev_json      TYPE string
                es_ds        TYPE zcl_ai_data_analysis_service=>ty_dataset
                ev_label     TYPE string
                ev_detail    TYPE string
                ev_error     TYPE string.

    " V1.1: 读一份结果的全部存储行(核对同 query_result; 同一请求按结果号缓存)
    CLASS-METHODS load_dataset
      IMPORTING iv_artifact_id  TYPE string
                iv_need_analyze TYPE abap_bool DEFAULT abap_false
      EXPORTING es_ds           TYPE zcl_ai_odata_shaper=>ty_dataset
                ev_label        TYPE string
                ev_report_id    TYPE string
                ev_session_id   TYPE string
                ev_error        TYPE string.

    " V1.1: 按 args 里的 filters 先筛行 —— 整个 args 按 is_schema 的列核对(错列名照常报错),
    " 但只用落在前 iv_max_ci 列上的筛选条件(关联查表: 原结果的列在前, 查回的字段在后)
    CLASS-METHODS prefilter_rows
      IMPORTING is_schema    TYPE zcl_ai_odata_shaper=>ty_dataset
                iv_args_json TYPE string
                iv_max_ci    TYPE i
      EXPORTING ev_error     TYPE string
      CHANGING  ct_rows      TYPE zcl_ai_odata_shaper=>tt_row.

    " 列名或列标题 → 列下标(没有 = 0); V1.1 起公开
    CLASS-METHODS find_col
      IMPORTING is_ds     TYPE zcl_ai_odata_shaper=>ty_dataset
                iv_name   TYPE string
      RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS col_list
      IMPORTING is_ds     TYPE zcl_ai_odata_shaper=>ty_dataset
      RETURNING VALUE(rv) TYPE string.

  PRIVATE SECTION.

    TYPES tt_str TYPE zcl_ai_combo_service=>tt_str.
    TYPES tt_int TYPE zcl_ai_combo_service=>tt_int.
    TYPES: BEGIN OF ty_filter,
             ci     TYPE i,
             op     TYPE string,
             value  TYPE string,
             values TYPE tt_str,
           END OF ty_filter.
    TYPES tt_filter TYPE STANDARD TABLE OF ty_filter WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_metric,
             ci    TYPE i,          " 0 = 行数(count 不给列)
             agg   TYPE string,     " SUM / AVG / MAX / MIN / COUNT / COUNT_DISTINCT
             name  TYPE string,     " 输出列名
             label TYPE string,     " 输出列标题
           END OF ty_metric.
    TYPES tt_metric TYPE STANDARD TABLE OF ty_metric WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_query,
             filters   TYPE tt_filter,
             group_by  TYPE tt_int,
             metrics   TYPE tt_metric,
             columns   TYPE tt_int,
             sort_name TYPE string,
             sort_desc TYPE abap_bool,
             limit     TYPE i,
             offset    TYPE i,          " V1.0.1: 跳过排序后的前几行(翻页)
             purpose   TYPE string,
             text      TYPE string,     " 规范化后的查询说明(步骤条 / 回给模型)
           END OF ty_query.

    CLASS-DATA: gv_cache_art   TYPE string,
                gs_cache_ds    TYPE zcl_ai_odata_shaper=>ty_dataset,
                gv_cache_label TYPE string,
                gv_cache_rid   TYPE string,
                gv_cache_sess  TYPE string.

    CLASS-METHODS cfg_int
      IMPORTING iv_key     TYPE string
                iv_default TYPE i
                iv_min     TYPE i
                iv_max     TYPE i
      RETURNING VALUE(rv)  TYPE i.
    CLASS-METHODS js
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS norm
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS load
      IMPORTING iv_artifact_id  TYPE string
                iv_need_analyze TYPE abap_bool
      EXPORTING es_ds           TYPE zcl_ai_odata_shaper=>ty_dataset
                ev_label        TYPE string
                ev_report_id    TYPE string
                ev_session_id   TYPE string
                ev_error        TYPE string.
    CLASS-METHODS col_label
      IMPORTING is_ds     TYPE zcl_ai_odata_shaper=>ty_dataset
                iv_ci     TYPE i
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS parse_query
      IMPORTING is_ds    TYPE zcl_ai_odata_shaper=>ty_dataset
                iv_json  TYPE string
      EXPORTING es_q     TYPE ty_query
                ev_error TYPE string.
    " 两个值比较: -1 / 0 / 1(都是数值按数值比, 否则按大写文字比)
    CLASS-METHODS compare
      IMPORTING iv_a      TYPE string
                iv_b      TYPE string
      RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS row_pass
      IMPORTING is_row     TYPE zcl_ai_odata_shaper=>ty_row
                it_filters TYPE tt_filter
      RETURNING VALUE(rv)  TYPE abap_bool.
    " 按第 iv_ci 列排序(数值列按数值; 空值总在最后; 同值保持原顺序)
    CLASS-METHODS sort_rows
      IMPORTING iv_ci   TYPE i
                iv_desc TYPE abap_bool
      CHANGING  cs_ds   TYPE zcl_ai_odata_shaper=>ty_dataset.
    CLASS-METHODS execute
      IMPORTING is_ds      TYPE zcl_ai_odata_shaper=>ty_dataset
                is_q       TYPE ty_query
      EXPORTING es_out     TYPE zcl_ai_odata_shaper=>ty_dataset
                ev_matched TYPE i
                ev_error   TYPE string.
    " 主要数值列: 取值最多的数值列(工厂 1000 / 2000 这类代码取值很少)
    CLASS-METHODS main_measure
      IMPORTING is_ds     TYPE zcl_ai_odata_shaper=>ty_dataset
      RETURNING VALUE(rv) TYPE i.
    " 前 iv_n 行 → 行 JSON 对象数组
    CLASS-METHODS rows_json
      IMPORTING is_ds     TYPE zcl_ai_odata_shaper=>ty_dataset
                iv_n      TYPE i
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS to_analysis
      IMPORTING is_ds     TYPE zcl_ai_odata_shaper=>ty_dataset
                iv_name   TYPE string
                iv_source TYPE string
      RETURNING VALUE(rs) TYPE zcl_ai_data_analysis_service=>ty_dataset.

ENDCLASS.



CLASS zcl_ai_result_query IMPLEMENTATION.


  METHOD enabled.
    rv = xsdbool( zcl_ai_task_service=>read_cfg_str( 'RESULT_QUERY_ENABLED' ) <> 'N' ).
  ENDMETHOD.


  METHOD tool_description.

    rv = '在当前这份报表结果的全部存储行上做筛选 / 分组 / 聚合 / 排序 / 取前 N(后端计算, 只读; '
      && '只能查本轮正在分析的这一份结果, 不需要也不能指定结果号)。'
      && '上下文里只有统计、汇总和举例行时, 凡是要排名、Top N、按某列汇总、筛选计数、'
      && '查某个值的明细, 都先调用本工具, 不要用举例行推算全量结论。'
      && 'args: {"filters":[{"column":"<列名或列标题>","op":"eq|ne|gt|ge|lt|le|contains|not_contains|'
      && 'starts_with|in|not_in|empty|not_empty","value":"<值>","values":["<in 用>"]}],'
      && '"group_by":["<列>"],"metrics":[{"column":"<列>","agg":"sum|avg|max|min|count|count_distinct"}],'
      && '"columns":["<不分组时要返回的列, 不给=全部列>"],"sort":{"column":"<列或聚合列>","order":"desc|asc"},'
      && '"limit":<返回行数, 默认 20>,"offset":<跳过排序后的前几行, 翻页用, 默认 0>,'
      && '"purpose":"<一句话说明, 作为结果标题>"}。'
      && '返回里 total = 符合条件的总行数(分组时是总组数), more = true 表示后面还有; '
      && '用户要"后面的 / 下一页"时, 用同样的条件再调一次, offset 填上次返回的 next_offset。'
      && '例: 库存最高前 10 料号 = {"group_by":["鴻海料號"],"metrics":[{"column":"庫存","agg":"sum"}],'
      && '"sort":{"column":"庫存","order":"desc"},"limit":10,"purpose":"库存最高前 10 料号"}; '
      && '只看明细排序 = {"columns":["鴻海料號","倉碼","庫存"],"sort":{"column":"庫存","order":"desc"},"limit":10}。'
      && 'count 不给 column 时是行数; 分组不给 metrics 时自动按行数统计。'.

  ENDMETHOD.


  METHOD cfg_int.
    DATA lv_val TYPE string.
    rv = iv_default.
    lv_val = zcl_ai_task_service=>read_cfg_str( iv_key ).
    CONDENSE lv_val NO-GAPS.
    IF lv_val IS INITIAL OR lv_val CN '0123456789'.
      RETURN.
    ENDIF.
    TRY.
        rv = lv_val.
      CATCH cx_root.
        rv = iv_default.
        RETURN.
    ENDTRY.
    IF rv < iv_min.
      rv = iv_min.
    ELSEIF rv > iv_max.
      rv = iv_max.
    ENDIF.
  ENDMETHOD.


  METHOD js.
    rv = zcl_ai_odata_shaper=>json_str( iv ).
  ENDMETHOD.


  METHOD norm.
    rv = to_upper( condense( val = iv del = ` ` ) ).
    REPLACE ALL OCCURRENCES OF ` ` IN rv WITH ``.
  ENDMETHOD.


  METHOD load.

    CLEAR: es_ds, ev_label, ev_report_id, ev_session_id, ev_error.
    DATA(lv_art) = to_upper( condense( iv_artifact_id ) ).
    IF lv_art IS INITIAL.
      ev_error = '缺少结果编号'.
      RETURN.
    ENDIF.
    IF lv_art = gv_cache_art AND gv_cache_art IS NOT INITIAL.
      es_ds         = gs_cache_ds.
      ev_label      = gv_cache_label.
      ev_report_id  = gv_cache_rid.
      ev_session_id = gv_cache_sess.
      RETURN.
    ENDIF.

    " 类型先核一遍: 只认报表执行与 Fiori 报表的结果(组合结果 / 数据分析结果另有链路)
    DATA lv_art_k TYPE zai_artifact-artifact_id.
    lv_art_k = lv_art.
    SELECT SINGLE artifact_type FROM zai_artifact
      WHERE artifact_id = @lv_art_k AND owner = @sy-uname
      INTO @DATA(lv_type).
    IF sy-subrc <> 0.
      ev_error = '结果不存在或不属于当前用户'.
      RETURN.
    ENDIF.
    IF lv_type <> 'REPORT_RESULT' AND lv_type <> 'FIORI_RESULT'.
      ev_error = '该结果不是报表运行产物, 请走数据分析链路'.
      RETURN.
    ENDIF.

    DATA lv_type_s TYPE string.
    zcl_ai_combo_service=>load_result(
      EXPORTING iv_artifact_id  = lv_art
                iv_max_rows     = cfg_int( iv_key = 'RESULT_QRY_MAX_ROWS' iv_default = 20000
                                           iv_min = 100 iv_max = 100000 )
                iv_need_analyze = iv_need_analyze
      IMPORTING es_ds           = es_ds
                ev_type         = lv_type_s
                ev_report_id    = ev_report_id
                ev_label        = ev_label
                ev_session_id   = ev_session_id
                ev_error        = ev_error ).
    IF ev_error IS NOT INITIAL.
      CLEAR es_ds.
      RETURN.
    ENDIF.

    gv_cache_art   = lv_art.
    gs_cache_ds    = es_ds.
    gv_cache_label = ev_label.
    gv_cache_rid   = ev_report_id.
    gv_cache_sess  = ev_session_id.

  ENDMETHOD.


  METHOD find_col.

    DATA(lv_n) = norm( iv_name ).
    IF lv_n IS INITIAL.
      RETURN.
    ENDIF.
    " 先按列名, 再按列标题(标题可能重名, 取第一个)
    LOOP AT is_ds-columns INTO DATA(ls_c).
      IF norm( ls_c-name ) = lv_n.
        rv = sy-tabix.
        RETURN.
      ENDIF.
    ENDLOOP.
    LOOP AT is_ds-columns INTO ls_c.
      IF norm( ls_c-label ) = lv_n.
        rv = sy-tabix.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD col_list.

    DATA lt_p TYPE tt_str.
    LOOP AT is_ds-columns INTO DATA(ls_c).
      IF ls_c-label IS NOT INITIAL AND ls_c-label <> ls_c-name.
        APPEND |{ ls_c-name }({ ls_c-label })| TO lt_p.
      ELSE.
        APPEND ls_c-name TO lt_p.
      ENDIF.
    ENDLOOP.
    rv = concat_lines_of( table = lt_p sep = `, ` ).

  ENDMETHOD.


  METHOD col_label.

    READ TABLE is_ds-columns INTO DATA(ls_c) INDEX iv_ci.
    IF sy-subrc = 0.
      rv = COND #( WHEN ls_c-label IS NOT INITIAL THEN ls_c-label ELSE ls_c-name ).
    ENDIF.

  ENDMETHOD.


  METHOD parse_query.

    DATA: lo      TYPE REF TO zcl_ai_odata_shaper,
          ls_f    TYPE ty_filter,
          ls_m    TYPE ty_metric,
          lv_name TYPE string,
          lv_ci   TYPE i,
          lv_id   TYPE i,
          lt_txt  TYPE tt_str,
          lv_lim  TYPE string.
    CLEAR: es_q, ev_error.

    CREATE OBJECT lo.
    IF lo->parse( COND #( WHEN iv_json IS INITIAL THEN `{}` ELSE iv_json ) ) = abap_false.
      ev_error = |args 不是合法 JSON: { lo->get_error( ) }|.
      RETURN.
    ENDIF.
    DATA(lv_root) = lo->root( ).
    IF lo->kind( lv_root ) <> 'O'.
      ev_error = 'args 必须是 JSON 对象'.
      RETURN.
    ENDIF.

    " ---- filters ----
    lv_id = lo->child( iv_id = lv_root iv_name = 'filters' ).
    DATA(lt_kf) = lo->kids( lv_id ).
    LOOP AT lt_kf INTO DATA(lv_fid).
      IF sy-tabix > 10.
        ev_error = '筛选条件最多 10 个'.
        RETURN.
      ENDIF.
      CLEAR ls_f.
      lv_name = lo->text( lo->child( iv_id = lv_fid iv_name = 'column' ) ).
      ls_f-ci = find_col( is_ds = is_ds iv_name = lv_name ).
      IF ls_f-ci = 0.
        ev_error = |筛选列「{ lv_name }」不存在。可用的列: { col_list( is_ds ) }|.
        RETURN.
      ENDIF.
      ls_f-op = to_lower( condense( lo->text( lo->child( iv_id = lv_fid iv_name = 'op' ) ) ) ).
      IF ls_f-op IS INITIAL.
        ls_f-op = 'eq'.
      ENDIF.
      CASE ls_f-op.
        WHEN '=' OR '=='.   ls_f-op = 'eq'.
        WHEN '!=' OR '<>'.  ls_f-op = 'ne'.
        WHEN '>'.           ls_f-op = 'gt'.
        WHEN '>='.          ls_f-op = 'ge'.
        WHEN '<'.           ls_f-op = 'lt'.
        WHEN '<='.          ls_f-op = 'le'.
        WHEN 'like'.        ls_f-op = 'contains'.
      ENDCASE.
      IF ls_f-op <> 'eq' AND ls_f-op <> 'ne' AND ls_f-op <> 'gt' AND ls_f-op <> 'ge'
         AND ls_f-op <> 'lt' AND ls_f-op <> 'le' AND ls_f-op <> 'contains'
         AND ls_f-op <> 'not_contains' AND ls_f-op <> 'starts_with'
         AND ls_f-op <> 'in' AND ls_f-op <> 'not_in'
         AND ls_f-op <> 'empty' AND ls_f-op <> 'not_empty'.
        ev_error = |不认识的筛选操作 { ls_f-op }(可用 eq ne gt ge lt le contains not_contains starts_with in not_in empty not_empty)|.
        RETURN.
      ENDIF.
      ls_f-value = condense( lo->text( lo->child( iv_id = lv_fid iv_name = 'value' ) ) ).
      DATA(lv_vid) = lo->child( iv_id = lv_fid iv_name = 'values' ).
      DATA(lt_kv) = lo->kids( lv_vid ).
      LOOP AT lt_kv INTO DATA(lv_v1).
        APPEND condense( lo->text( lv_v1 ) ) TO ls_f-values.
      ENDLOOP.
      IF ( ls_f-op = 'in' OR ls_f-op = 'not_in' ) AND ls_f-values IS INITIAL AND ls_f-value IS NOT INITIAL.
        SPLIT ls_f-value AT ',' INTO TABLE ls_f-values.
        LOOP AT ls_f-values ASSIGNING FIELD-SYMBOL(<lv_sv>).
          <lv_sv> = condense( <lv_sv> ).
        ENDLOOP.
      ENDIF.
      IF ( ls_f-op = 'in' OR ls_f-op = 'not_in' ) AND ls_f-values IS INITIAL.
        ev_error = |筛选 { ls_f-op } 需要 values 数组|.
        RETURN.
      ENDIF.
      APPEND ls_f TO es_q-filters.
      APPEND |{ col_label( is_ds = is_ds iv_ci = ls_f-ci ) } { ls_f-op } | &&
             COND string( WHEN ls_f-values IS NOT INITIAL
                          THEN concat_lines_of( table = ls_f-values sep = `/` ) ELSE ls_f-value )
        TO lt_txt.
    ENDLOOP.
    IF lt_txt IS NOT INITIAL.
      es_q-text = |筛选 { concat_lines_of( table = lt_txt sep = `, ` ) }|.
    ENDIF.

    " ---- group_by ----
    lv_id = lo->child( iv_id = lv_root iv_name = 'group_by' ).
    IF lv_id = 0.
      lv_id = lo->child( iv_id = lv_root iv_name = 'groupBy' ).
    ENDIF.
    CLEAR lt_txt.
    IF lo->kind( lv_id ) = 'S'.
      lv_name = lo->text( lv_id ).
      lv_ci = find_col( is_ds = is_ds iv_name = lv_name ).
      IF lv_ci = 0.
        ev_error = |分组列「{ lv_name }」不存在。可用的列: { col_list( is_ds ) }|.
        RETURN.
      ENDIF.
      APPEND lv_ci TO es_q-group_by.
      APPEND col_label( is_ds = is_ds iv_ci = lv_ci ) TO lt_txt.
    ELSE.
      DATA(lt_kg) = lo->kids( lv_id ).
      LOOP AT lt_kg INTO DATA(lv_gid).
        lv_name = lo->text( lv_gid ).
        lv_ci = find_col( is_ds = is_ds iv_name = lv_name ).
        IF lv_ci = 0.
          ev_error = |分组列「{ lv_name }」不存在。可用的列: { col_list( is_ds ) }|.
          RETURN.
        ENDIF.
        IF lines( es_q-group_by ) >= 3.
          ev_error = '分组列最多 3 个'.
          RETURN.
        ENDIF.
        APPEND lv_ci TO es_q-group_by.
        APPEND col_label( is_ds = is_ds iv_ci = lv_ci ) TO lt_txt.
      ENDLOOP.
    ENDIF.
    IF lt_txt IS NOT INITIAL.
      es_q-text = COND #( WHEN es_q-text IS INITIAL THEN `` ELSE es_q-text && `; ` ) &&
                  |按 { concat_lines_of( table = lt_txt sep = ` + ` ) } 分组|.
    ENDIF.

    " ---- metrics ----
    lv_id = lo->child( iv_id = lv_root iv_name = 'metrics' ).
    CLEAR lt_txt.
    DATA(lt_km) = lo->kids( lv_id ).
    LOOP AT lt_km INTO DATA(lv_mid).
      IF lines( es_q-metrics ) >= 6.
        ev_error = '聚合最多 6 个'.
        RETURN.
      ENDIF.
      CLEAR ls_m.
      ls_m-agg = to_upper( condense( lo->text( lo->child( iv_id = lv_mid iv_name = 'agg' ) ) ) ).
      IF ls_m-agg IS INITIAL.
        ls_m-agg = 'SUM'.
      ENDIF.
      CASE ls_m-agg.
        WHEN 'AVERAGE' OR 'MEAN'.  ls_m-agg = 'AVG'.
        WHEN 'DISTINCT' OR 'COUNTDISTINCT' OR 'DISTINCT_COUNT'.  ls_m-agg = 'COUNT_DISTINCT'.
        WHEN 'TOTAL'.  ls_m-agg = 'SUM'.
      ENDCASE.
      IF ls_m-agg <> 'SUM' AND ls_m-agg <> 'AVG' AND ls_m-agg <> 'MAX' AND ls_m-agg <> 'MIN'
         AND ls_m-agg <> 'COUNT' AND ls_m-agg <> 'COUNT_DISTINCT'.
        ev_error = |不认识的聚合 { ls_m-agg }(可用 sum avg max min count count_distinct)|.
        RETURN.
      ENDIF.
      lv_name = lo->text( lo->child( iv_id = lv_mid iv_name = 'column' ) ).
      IF lv_name IS INITIAL OR lv_name = '*'.
        IF ls_m-agg <> 'COUNT'.
          ev_error = |聚合 { to_lower( ls_m-agg ) } 需要给 column|.
          RETURN.
        ENDIF.
        ls_m-ci    = 0.
        ls_m-name  = 'ROW_COUNT'.
        ls_m-label = '行数'.
      ELSE.
        ls_m-ci = find_col( is_ds = is_ds iv_name = lv_name ).
        IF ls_m-ci = 0.
          ev_error = |聚合列「{ lv_name }」不存在。可用的列: { col_list( is_ds ) }|.
          RETURN.
        ENDIF.
        READ TABLE is_ds-columns INTO DATA(ls_mc) INDEX ls_m-ci.
        IF ( ls_m-agg = 'SUM' OR ls_m-agg = 'AVG' ) AND ls_mc-is_numeric = abap_false.
          ev_error = |列「{ col_label( is_ds = is_ds iv_ci = ls_m-ci ) }」不是数值列, 不能 { to_lower( ls_m-agg ) }; | &&
                     |可以用 count / count_distinct / max / min|.
          RETURN.
        ENDIF.
        ls_m-name  = |{ ls_mc-name }_{ ls_m-agg }|.
        ls_m-label = |{ col_label( is_ds = is_ds iv_ci = ls_m-ci ) }(| &&
                     SWITCH string( ls_m-agg WHEN 'SUM' THEN `合计` WHEN 'AVG' THEN `平均`
                                             WHEN 'MAX' THEN `最大` WHEN 'MIN' THEN `最小`
                                             WHEN 'COUNT' THEN `非空个数` ELSE `不同值个数` ) && `)`.
      ENDIF.
      APPEND ls_m TO es_q-metrics.
      APPEND ls_m-label TO lt_txt.
    ENDLOOP.
    " 分组但没给聚合 → 按行数统计
    IF es_q-group_by IS NOT INITIAL AND es_q-metrics IS INITIAL.
      APPEND VALUE #( ci = 0 agg = 'COUNT' name = 'ROW_COUNT' label = '行数' ) TO es_q-metrics.
      APPEND `行数` TO lt_txt.
    ENDIF.
    IF lt_txt IS NOT INITIAL.
      es_q-text = COND #( WHEN es_q-text IS INITIAL THEN `` ELSE es_q-text && `; ` ) &&
                  |统计 { concat_lines_of( table = lt_txt sep = `、` ) }|.
    ENDIF.

    " ---- columns(只在明细时用) ----
    lv_id = lo->child( iv_id = lv_root iv_name = 'columns' ).
    DATA(lt_kc) = lo->kids( lv_id ).
    LOOP AT lt_kc INTO DATA(lv_cid).
      lv_name = lo->text( lv_cid ).
      lv_ci = find_col( is_ds = is_ds iv_name = lv_name ).
      IF lv_ci = 0.
        ev_error = |返回列「{ lv_name }」不存在。可用的列: { col_list( is_ds ) }|.
        RETURN.
      ENDIF.
      READ TABLE es_q-columns TRANSPORTING NO FIELDS WITH KEY table_line = lv_ci.
      IF sy-subrc <> 0 AND lines( es_q-columns ) < 30.
        APPEND lv_ci TO es_q-columns.
      ENDIF.
    ENDLOOP.

    " ---- sort: {"column","order"} / [{...}](取第一个) / "列名" ----
    lv_id = lo->child( iv_id = lv_root iv_name = 'sort' ).
    IF lv_id = 0.
      lv_id = lo->child( iv_id = lv_root iv_name = 'order_by' ).
    ENDIF.
    IF lo->kind( lv_id ) = 'A'.
      DATA(lt_ks) = lo->kids( lv_id ).
      READ TABLE lt_ks INTO lv_id INDEX 1.
      IF sy-subrc <> 0.
        lv_id = 0.
      ENDIF.
    ENDIF.
    es_q-sort_desc = abap_true.
    IF lo->kind( lv_id ) = 'S'.
      es_q-sort_name = condense( lo->text( lv_id ) ).
    ELSEIF lo->kind( lv_id ) = 'O'.
      es_q-sort_name = condense( lo->text( lo->child( iv_id = lv_id iv_name = 'column' ) ) ).
      DATA(lv_ord) = to_lower( condense( lo->text( lo->child( iv_id = lv_id iv_name = 'order' ) ) ) ).
      DATA(lv_dsc) = to_lower( lo->text( lo->child( iv_id = lv_id iv_name = 'desc' ) ) ).
      IF lv_ord = 'asc' OR lv_dsc = 'false'.
        es_q-sort_desc = abap_false.
      ENDIF.
    ENDIF.

    " ---- limit ----
    lv_lim = lo->text( lo->child( iv_id = lv_root iv_name = 'limit' ) ).
    IF lv_lim IS INITIAL.
      lv_lim = lo->text( lo->child( iv_id = lv_root iv_name = 'top' ) ).
    ENDIF.
    CONDENSE lv_lim NO-GAPS.
    es_q-limit = 20.
    IF lv_lim IS NOT INITIAL AND lv_lim CO '0123456789'.
      TRY.
          es_q-limit = lv_lim.
        CATCH cx_root.
          es_q-limit = 20.
      ENDTRY.
    ENDIF.
    DATA(lv_maxo) = cfg_int( iv_key = 'RESULT_QUERY_MAX_OUT' iv_default = 100 iv_min = 10 iv_max = 1000 ).
    IF es_q-limit < 1.
      es_q-limit = 20.
    ELSEIF es_q-limit > lv_maxo.
      es_q-limit = lv_maxo.
    ENDIF.

    " ---- offset(V1.0.1: 翻页) ----
    DATA(lv_off) = lo->text( lo->child( iv_id = lv_root iv_name = 'offset' ) ).
    IF lv_off IS INITIAL.
      lv_off = lo->text( lo->child( iv_id = lv_root iv_name = 'skip' ) ).
    ENDIF.
    CONDENSE lv_off NO-GAPS.
    es_q-offset = 0.
    IF lv_off IS NOT INITIAL AND lv_off CO '0123456789' AND strlen( lv_off ) <= 7.
      es_q-offset = lv_off.
    ENDIF.

    es_q-purpose = lo->text( lo->child( iv_id = lv_root iv_name = 'purpose' ) ).

  ENDMETHOD.


  METHOD compare.

    DATA: lv_a  TYPE decfloat34,
          lv_b  TYPE decfloat34,
          lv_ao TYPE abap_bool,
          lv_bo TYPE abap_bool.
    zcl_ai_combo_service=>to_num( EXPORTING iv = iv_a IMPORTING ev_num = lv_a ev_ok = lv_ao ).
    zcl_ai_combo_service=>to_num( EXPORTING iv = iv_b IMPORTING ev_num = lv_b ev_ok = lv_bo ).
    IF lv_ao = abap_true AND lv_bo = abap_true.
      rv = COND #( WHEN lv_a < lv_b THEN -1 WHEN lv_a > lv_b THEN 1 ELSE 0 ).
      RETURN.
    ENDIF.
    DATA(lv_sa) = to_upper( condense( iv_a ) ).
    DATA(lv_sb) = to_upper( condense( iv_b ) ).
    rv = COND #( WHEN lv_sa < lv_sb THEN -1 WHEN lv_sa > lv_sb THEN 1 ELSE 0 ).

  ENDMETHOD.


  METHOD row_pass.

    DATA: lv_cell TYPE string,
          lv_up   TYPE string,
          lv_vup  TYPE string,
          lv_len  TYPE i,
          lv_hit  TYPE abap_bool.
    rv = abap_true.
    LOOP AT it_filters INTO DATA(ls_f).
      CLEAR lv_cell.
      READ TABLE is_row-cells INTO lv_cell INDEX ls_f-ci.
      lv_cell = condense( lv_cell ).
      lv_up   = to_upper( lv_cell ).
      lv_vup  = to_upper( ls_f-value ).
      CASE ls_f-op.
        WHEN 'empty'.
          lv_hit = xsdbool( lv_cell IS INITIAL ).
        WHEN 'not_empty'.
          lv_hit = xsdbool( lv_cell IS NOT INITIAL ).
        WHEN 'eq'.
          lv_hit = xsdbool( compare( iv_a = lv_cell iv_b = ls_f-value ) = 0 ).
        WHEN 'ne'.
          lv_hit = xsdbool( compare( iv_a = lv_cell iv_b = ls_f-value ) <> 0 ).
        WHEN 'gt'.
          lv_hit = xsdbool( lv_cell IS NOT INITIAL AND compare( iv_a = lv_cell iv_b = ls_f-value ) > 0 ).
        WHEN 'ge'.
          lv_hit = xsdbool( lv_cell IS NOT INITIAL AND compare( iv_a = lv_cell iv_b = ls_f-value ) >= 0 ).
        WHEN 'lt'.
          lv_hit = xsdbool( lv_cell IS NOT INITIAL AND compare( iv_a = lv_cell iv_b = ls_f-value ) < 0 ).
        WHEN 'le'.
          lv_hit = xsdbool( lv_cell IS NOT INITIAL AND compare( iv_a = lv_cell iv_b = ls_f-value ) <= 0 ).
        WHEN 'contains'.
          lv_hit = xsdbool( lv_vup IS INITIAL OR lv_up CS lv_vup ).
        WHEN 'not_contains'.
          lv_hit = xsdbool( lv_vup IS NOT INITIAL AND lv_up NS lv_vup ).
        WHEN 'starts_with'.
          lv_hit = abap_false.
          lv_len = strlen( lv_vup ).
          IF strlen( lv_up ) >= lv_len.
            lv_hit = xsdbool( substring( val = lv_up len = lv_len ) = lv_vup ).
          ENDIF.
        WHEN 'in' OR 'not_in'.
          lv_hit = abap_false.
          LOOP AT ls_f-values INTO DATA(lv_v).
            IF compare( iv_a = lv_cell iv_b = lv_v ) = 0.
              lv_hit = abap_true.
              EXIT.
            ENDIF.
          ENDLOOP.
          IF ls_f-op = 'not_in'.
            lv_hit = xsdbool( lv_hit = abap_false ).
          ENDIF.
        WHEN OTHERS.
          lv_hit = abap_false.
      ENDCASE.
      IF lv_hit = abap_false.
        rv = abap_false.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD sort_rows.

    TYPES: BEGIN OF ty_s,
             empty TYPE i,            " 0 有值 / 1 空(空值总在最后)
             num   TYPE decfloat34,
             str   TYPE string,
             idx   TYPE i,
           END OF ty_s.
    DATA: lt_s   TYPE STANDARD TABLE OF ty_s WITH DEFAULT KEY,
          ls_s   TYPE ty_s,
          lt_new TYPE zcl_ai_odata_shaper=>tt_row,
          lv_v   TYPE string,
          lv_ok  TYPE abap_bool,
          lv_all_num TYPE abap_bool VALUE abap_true.

    IF iv_ci <= 0 OR iv_ci > lines( cs_ds-columns ).
      RETURN.
    ENDIF.
    LOOP AT cs_ds-rows INTO DATA(ls_row).
      CLEAR: ls_s, lv_v.
      ls_s-idx = sy-tabix.
      READ TABLE ls_row-cells INTO lv_v INDEX iv_ci.
      lv_v = condense( lv_v ).
      IF lv_v IS INITIAL.
        ls_s-empty = 1.
      ELSE.
        zcl_ai_combo_service=>to_num( EXPORTING iv = lv_v IMPORTING ev_num = ls_s-num ev_ok = lv_ok ).
        IF lv_ok = abap_false.
          lv_all_num = abap_false.
        ENDIF.
        ls_s-str = to_upper( lv_v ).
      ENDIF.
      APPEND ls_s TO lt_s.
    ENDLOOP.

    " 有一个非空值不是数字 → 整列按文字排
    IF lv_all_num = abap_true.
      IF iv_desc = abap_true.
        SORT lt_s BY empty ASCENDING num DESCENDING idx ASCENDING.
      ELSE.
        SORT lt_s BY empty ASCENDING num ASCENDING idx ASCENDING.
      ENDIF.
    ELSE.
      IF iv_desc = abap_true.
        SORT lt_s BY empty ASCENDING str DESCENDING idx ASCENDING.
      ELSE.
        SORT lt_s BY empty ASCENDING str ASCENDING idx ASCENDING.
      ENDIF.
    ENDIF.

    LOOP AT lt_s INTO ls_s.
      READ TABLE cs_ds-rows INTO ls_row INDEX ls_s-idx.
      APPEND ls_row TO lt_new.
    ENDLOOP.
    cs_ds-rows = lt_new.

  ENDMETHOD.


  METHOD execute.

    TYPES tt_dec TYPE STANDARD TABLE OF decfloat34 WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_g,
             gkey TYPE string,
             keys TYPE tt_str,
             n    TYPE i,
             vals TYPE tt_dec,        " 合计 / 最大 / 最小
             cnts TYPE tt_int,        " 参与计算的个数(avg / count / count_distinct)
             has  TYPE tt_int,        " 1 = 已有值(max / min 初值)
             ord  TYPE i,             " 首次出现顺序
           END OF ty_g.
    DATA: ls_flt   TYPE zcl_ai_odata_shaper=>ty_dataset,
          ls_col   TYPE zcl_ai_odata_shaper=>ty_column,
          ls_orow  TYPE zcl_ai_odata_shaper=>ty_row,
          lt_g     TYPE HASHED TABLE OF ty_g WITH UNIQUE KEY gkey,
          lt_gs    TYPE STANDARD TABLE OF ty_g WITH DEFAULT KEY,
          ls_g     TYPE ty_g,
          lt_seen  TYPE HASHED TABLE OF string WITH UNIQUE KEY table_line,
          lt_cols  TYPE tt_int,
          lv_v     TYPE string,
          lv_d     TYPE decfloat34,
          lv_ok    TYPE abap_bool,
          lv_ci    TYPE i,
          lv_mi    TYPE i,
          lv_sci   TYPE i,
          lv_total TYPE i.
    FIELD-SYMBOLS: <ls_g> TYPE ty_g,
                   <lv_d> TYPE decfloat34,
                   <lv_c> TYPE i,
                   <lv_h> TYPE i.
    CLEAR: es_out, ev_matched, ev_error.

    " ---- 1. 筛选 ----
    ls_flt-columns = is_ds-columns.
    LOOP AT is_ds-rows INTO DATA(ls_row).
      IF row_pass( is_row = ls_row it_filters = is_q-filters ) = abap_true.
        APPEND ls_row TO ls_flt-rows.
      ENDIF.
    ENDLOOP.
    ev_matched = lines( ls_flt-rows ).

    " ---- 2a. 明细: 排序 → 取前 N → 只留要的列 ----
    IF is_q-group_by IS INITIAL AND is_q-metrics IS INITIAL.
      IF is_q-sort_name IS NOT INITIAL.
        lv_sci = find_col( is_ds = ls_flt iv_name = is_q-sort_name ).
        IF lv_sci = 0.
          ev_error = |排序列「{ is_q-sort_name }」不存在。可用的列: { col_list( is_ds ) }|.
          RETURN.
        ENDIF.
        sort_rows( EXPORTING iv_ci = lv_sci iv_desc = is_q-sort_desc CHANGING cs_ds = ls_flt ).
      ENDIF.
      lt_cols = is_q-columns.
      IF lt_cols IS INITIAL.
        LOOP AT is_ds-columns TRANSPORTING NO FIELDS.
          APPEND sy-tabix TO lt_cols.
        ENDLOOP.
      ELSEIF lv_sci > 0.
        " 排序列没选上也带上(不然看不出排序依据)
        READ TABLE lt_cols TRANSPORTING NO FIELDS WITH KEY table_line = lv_sci.
        IF sy-subrc <> 0.
          APPEND lv_sci TO lt_cols.
        ENDIF.
      ENDIF.
      LOOP AT lt_cols INTO lv_ci.
        READ TABLE is_ds-columns INTO ls_col INDEX lv_ci.
        APPEND ls_col TO es_out-columns.
      ENDLOOP.
      LOOP AT ls_flt-rows INTO ls_row.
        IF sy-tabix <= is_q-offset.
          CONTINUE.
        ENDIF.
        IF sy-tabix > is_q-offset + is_q-limit.
          EXIT.
        ENDIF.
        CLEAR ls_orow.
        LOOP AT lt_cols INTO lv_ci.
          CLEAR lv_v.
          READ TABLE ls_row-cells INTO lv_v INDEX lv_ci.
          APPEND lv_v TO ls_orow-cells.
        ENDLOOP.
        APPEND ls_orow TO es_out-rows.
      ENDLOOP.
      es_out-total     = ev_matched.
      es_out-truncated = xsdbool( ev_matched > is_q-offset + lines( es_out-rows ) ).
      RETURN.
    ENDIF.

    " ---- 2b. 分组聚合(不分组 = 整体一行) ----
    LOOP AT ls_flt-rows INTO ls_row.
      CLEAR ls_g.
      LOOP AT is_q-group_by INTO lv_ci.
        CLEAR lv_v.
        READ TABLE ls_row-cells INTO lv_v INDEX lv_ci.
        lv_v = condense( lv_v ).
        APPEND lv_v TO ls_g-keys.
        ls_g-gkey = ls_g-gkey && lv_v && |\t|.
      ENDLOOP.
      READ TABLE lt_g ASSIGNING <ls_g> WITH TABLE KEY gkey = ls_g-gkey.
      IF sy-subrc <> 0.
        LOOP AT is_q-metrics TRANSPORTING NO FIELDS.
          APPEND 0 TO ls_g-vals.
          APPEND 0 TO ls_g-cnts.
          APPEND 0 TO ls_g-has.
        ENDLOOP.
        ls_g-ord = lines( lt_g ) + 1.
        INSERT ls_g INTO TABLE lt_g ASSIGNING <ls_g>.
      ENDIF.
      <ls_g>-n = <ls_g>-n + 1.

      LOOP AT is_q-metrics INTO DATA(ls_m).
        lv_mi = sy-tabix.
        READ TABLE <ls_g>-vals ASSIGNING <lv_d> INDEX lv_mi.
        READ TABLE <ls_g>-cnts ASSIGNING <lv_c> INDEX lv_mi.
        READ TABLE <ls_g>-has  ASSIGNING <lv_h> INDEX lv_mi.
        IF ls_m-ci = 0.
          <lv_c> = <lv_c> + 1.
          CONTINUE.
        ENDIF.
        CLEAR lv_v.
        READ TABLE ls_row-cells INTO lv_v INDEX ls_m-ci.
        lv_v = condense( lv_v ).
        IF lv_v IS INITIAL.
          CONTINUE.
        ENDIF.
        CASE ls_m-agg.
          WHEN 'COUNT'.
            <lv_c> = <lv_c> + 1.
          WHEN 'COUNT_DISTINCT'.
            INSERT |{ <ls_g>-gkey }\n{ lv_mi }\n{ lv_v }| INTO TABLE lt_seen.
            IF sy-subrc = 0.
              <lv_c> = <lv_c> + 1.
            ENDIF.
          WHEN 'SUM' OR 'AVG'.
            zcl_ai_combo_service=>to_num( EXPORTING iv = lv_v IMPORTING ev_num = lv_d ev_ok = lv_ok ).
            IF lv_ok = abap_true.
              <lv_d> = <lv_d> + lv_d.
              <lv_c> = <lv_c> + 1.
            ENDIF.
          WHEN 'MAX' OR 'MIN'.
            zcl_ai_combo_service=>to_num( EXPORTING iv = lv_v IMPORTING ev_num = lv_d ev_ok = lv_ok ).
            IF lv_ok = abap_true.
              IF <lv_h> = 0
                 OR ( ls_m-agg = 'MAX' AND lv_d > <lv_d> )
                 OR ( ls_m-agg = 'MIN' AND lv_d < <lv_d> ).
                <lv_d> = lv_d.
              ENDIF.
              <lv_h> = 1.
              <lv_c> = <lv_c> + 1.
            ENDIF.
        ENDCASE.
      ENDLOOP.
    ENDLOOP.

    " 不分组且没有行: 仍给一行(行数 0)
    IF is_q-group_by IS INITIAL AND lt_g IS INITIAL.
      CLEAR ls_g.
      LOOP AT is_q-metrics TRANSPORTING NO FIELDS.
        APPEND 0 TO ls_g-vals.
        APPEND 0 TO ls_g-cnts.
        APPEND 0 TO ls_g-has.
      ENDLOOP.
      INSERT ls_g INTO TABLE lt_g.
    ENDIF.

    " 输出列: 分组列 + 聚合列
    LOOP AT is_q-group_by INTO lv_ci.
      READ TABLE is_ds-columns INTO ls_col INDEX lv_ci.
      APPEND ls_col TO es_out-columns.
    ENDLOOP.
    LOOP AT is_q-metrics INTO ls_m.
      CLEAR ls_col.
      ls_col-name       = ls_m-name.
      ls_col-label      = ls_m-label.
      ls_col-is_numeric = abap_true.
      APPEND ls_col TO es_out-columns.
    ENDLOOP.

    " 输出行(先按首次出现顺序)
    LOOP AT lt_g INTO ls_g.
      APPEND ls_g TO lt_gs.
    ENDLOOP.
    SORT lt_gs BY ord ASCENDING.
    LOOP AT lt_gs INTO ls_g.
      CLEAR ls_orow.
      LOOP AT ls_g-keys INTO lv_v.
        APPEND lv_v TO ls_orow-cells.
      ENDLOOP.
      LOOP AT is_q-metrics INTO ls_m.
        lv_mi = sy-tabix.
        READ TABLE ls_g-vals INTO lv_d INDEX lv_mi.
        READ TABLE ls_g-cnts INTO DATA(lv_cnt) INDEX lv_mi.
        CASE ls_m-agg.
          WHEN 'COUNT' OR 'COUNT_DISTINCT'.
            lv_v = |{ lv_cnt }|.
          WHEN 'SUM'.
            lv_v = zcl_ai_combo_service=>num_out( lv_d ).
          WHEN 'AVG'.
            lv_v = COND #( WHEN lv_cnt > 0 THEN zcl_ai_combo_service=>num_out( lv_d / lv_cnt ) ELSE `` ).
          WHEN OTHERS.
            lv_v = COND #( WHEN lv_cnt > 0 THEN zcl_ai_combo_service=>num_out( lv_d ) ELSE `` ).
        ENDCASE.
        APPEND lv_v TO ls_orow-cells.
      ENDLOOP.
      APPEND ls_orow TO es_out-rows.
    ENDLOOP.
    lv_total = lines( es_out-rows ).

    " 排序: 给了就按给的(输出列名 / 标题, 或聚合的原列名); 没给按第一个聚合列从大到小
    lv_sci = 0.
    IF is_q-sort_name IS NOT INITIAL.
      lv_sci = find_col( is_ds = es_out iv_name = is_q-sort_name ).
      IF lv_sci = 0.
        DATA(lv_src_ci) = find_col( is_ds = is_ds iv_name = is_q-sort_name ).
        IF lv_src_ci > 0.
          LOOP AT is_q-metrics INTO ls_m WHERE ci = lv_src_ci.
            lv_sci = lines( is_q-group_by ) + sy-tabix.
            EXIT.
          ENDLOOP.
          IF lv_sci = 0.
            LOOP AT is_q-group_by INTO lv_ci.
              IF lv_ci = lv_src_ci.
                lv_sci = sy-tabix.
                EXIT.
              ENDIF.
            ENDLOOP.
          ENDIF.
        ENDIF.
        IF lv_sci = 0.
          ev_error = |排序列「{ is_q-sort_name }」既不是分组列也不是聚合列。输出列: { col_list( es_out ) }|.
          CLEAR es_out.
          RETURN.
        ENDIF.
      ENDIF.
      sort_rows( EXPORTING iv_ci = lv_sci iv_desc = is_q-sort_desc CHANGING cs_ds = es_out ).
    ELSEIF is_q-group_by IS NOT INITIAL.
      sort_rows( EXPORTING iv_ci = lines( is_q-group_by ) + 1 iv_desc = abap_true CHANGING cs_ds = es_out ).
    ENDIF.

    " V1.0.1: 先跳过 offset, 再取前 limit
    DATA(lv_skip) = nmin( val1 = is_q-offset val2 = lines( es_out-rows ) ).
    IF lv_skip > 0.
      DELETE es_out-rows FROM 1 TO lv_skip.
    ENDIF.
    IF lines( es_out-rows ) > is_q-limit.
      DELETE es_out-rows FROM is_q-limit + 1.
    ENDIF.
    es_out-total     = lv_total.
    es_out-truncated = xsdbool( lv_total > is_q-offset + lines( es_out-rows ) ).

  ENDMETHOD.


  METHOD main_measure.

    DATA: lt_dist TYPE HASHED TABLE OF string WITH UNIQUE KEY table_line,
          lv_v    TYPE string,
          lv_best TYPE i VALUE -1.
    LOOP AT is_ds-columns INTO DATA(ls_c) WHERE is_numeric = abap_true.
      DATA(lv_ci) = sy-tabix.
      CLEAR lt_dist.
      LOOP AT is_ds-rows INTO DATA(ls_row).
        READ TABLE ls_row-cells INTO lv_v INDEX lv_ci.
        IF sy-subrc = 0 AND lv_v IS NOT INITIAL.
          INSERT lv_v INTO TABLE lt_dist.
          IF lines( lt_dist ) > 1000.
            EXIT.
          ENDIF.
        ENDIF.
      ENDLOOP.
      IF lines( lt_dist ) > lv_best.
        lv_best = lines( lt_dist ).
        rv = lv_ci.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD rows_json.

    DATA lt_p TYPE tt_str.
    DO nmin( val1 = iv_n val2 = lines( is_ds-rows ) ) TIMES.
      APPEND zcl_ai_odata_shaper=>row_json( is_ds = is_ds iv_index = sy-index ) TO lt_p.
    ENDDO.
    rv = |[{ concat_lines_of( table = lt_p sep = `,` ) }]|.

  ENDMETHOD.


  METHOD to_analysis.

    DATA: ls_col   TYPE zcl_ai_data_analysis_service=>ty_column,
          lt_cells TYPE zcl_ai_data_analysis_service=>tt_cells.
    CLEAR rs.
    rs-name       = iv_name.
    rs-status     = 'OK'.
    rs-source     = iv_source.
    rs-total_rows = is_ds-total.
    rs-truncated  = is_ds-truncated.
    LOOP AT is_ds-columns INTO DATA(ls_c).
      CLEAR ls_col.
      ls_col-name    = ls_c-name.
      ls_col-label   = ls_c-label.
      ls_col-numeric = ls_c-is_numeric.
      APPEND ls_col TO rs-columns.
    ENDLOOP.
    LOOP AT is_ds-rows INTO DATA(ls_r).
      lt_cells = ls_r-cells.
      APPEND lt_cells TO rs-rows.
    ENDLOOP.

  ENDMETHOD.


  METHOD load_dataset.
    load( EXPORTING iv_artifact_id  = iv_artifact_id
                    iv_need_analyze = iv_need_analyze
          IMPORTING es_ds           = es_ds
                    ev_label        = ev_label
                    ev_report_id    = ev_report_id
                    ev_session_id   = ev_session_id
                    ev_error        = ev_error ).
  ENDMETHOD.


  METHOD prefilter_rows.

    DATA: ls_q    TYPE ty_query,
          lt_f    TYPE tt_filter,
          ls_row  TYPE zcl_ai_odata_shaper=>ty_row,
          lt_keep TYPE zcl_ai_odata_shaper=>tt_row.
    CLEAR ev_error.
    parse_query( EXPORTING is_ds = is_schema iv_json = iv_args_json
                 IMPORTING es_q = ls_q ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    LOOP AT ls_q-filters INTO DATA(ls_f) WHERE ci <= iv_max_ci.
      APPEND ls_f TO lt_f.
    ENDLOOP.
    IF lt_f IS INITIAL.
      RETURN.
    ENDIF.
    LOOP AT ct_rows INTO ls_row.
      IF row_pass( is_row = ls_row it_filters = lt_f ) = abap_true.
        APPEND ls_row TO lt_keep.
      ENDIF.
    ENDLOOP.
    ct_rows = lt_keep.

  ENDMETHOD.


  METHOD context.

    DATA: ls_ds    TYPE zcl_ai_odata_shaper=>ty_dataset,
          ls_sort  TYPE zcl_ai_odata_shaper=>ty_dataset,
          lt_by    TYPE tt_int,
          lv_rows  TYPE string,
          lv_grp   TYPE string,
          lv_top   TYPE string,
          lv_bot   TYPE string,
          lv_src   TYPE string,
          lv_tool  TYPE string.
    CLEAR: ev_text, ev_label, ev_report_id, ev_session_id, ev_rows, ev_all, ev_error.

    load( EXPORTING iv_artifact_id  = iv_artifact_id
                    iv_need_analyze = iv_need_analyze
          IMPORTING es_ds           = ls_ds
                    ev_label        = ev_label
                    ev_report_id    = ev_report_id
                    ev_session_id   = ev_session_id
                    ev_error        = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.

    DATA(lv_n) = lines( ls_ds-rows ).
    ev_rows = nmax( val1 = ls_ds-total val2 = lv_n ).
    lv_src = COND #( WHEN ls_ds-truncated = abap_true
                     THEN |共 { ev_rows } 行, 后端只存了 { lv_n } 行(来源已截断, 以下按存储的 { lv_n } 行计算, 结论要说明是部分数据)|
                     ELSE |共 { lv_n } 行(全部已存储)| ).
    DATA(lv_maxc) = cfg_int( iv_key = 'RESULT_CTX_CHARS' iv_default = 24000 iv_min = 4000 iv_max = 200000 ).
    DATA(lv_cols) = zcl_ai_odata_shaper=>schema_json( ls_ds ).

    " ---- 行数不多: 给全部明细(放得下的话) ----
    IF lv_n <= cfg_int( iv_key = 'RESULT_CTX_ALL_ROWS' iv_default = 150 iv_min = 10 iv_max = 2000 ).
      lv_rows = rows_json( is_ds = ls_ds iv_n = lv_n ).
      IF strlen( lv_rows ) + strlen( lv_cols ) < lv_maxc - 1500.
        ev_all  = abap_true.
        ev_text = |{ lv_src }。\n列定义: { lv_cols }\n全部明细(JSON 数组, { lv_n } 行): { lv_rows }|.
        RETURN.
      ENDIF.
    ENDIF.

    " ---- 行数多: 后端在全部存储行上算好的统计 / 汇总 / 排序举例 ----
    DATA(lv_stats) = zcl_ai_fiori_report_service=>compute_stats( ls_ds ).
    lt_by = zcl_ai_combo_service=>auto_group( is_ds = ls_ds it_prefer = VALUE #( ) ).
    IF lt_by IS NOT INITIAL.
      lv_grp = zcl_ai_combo_service=>group_json(
                 is_ds   = ls_ds
                 it_by   = lt_by
                 it_skip = VALUE #( )
                 iv_max  = cfg_int( iv_key = 'RESULT_CTX_GROUPS' iv_default = 30 iv_min = 5 iv_max = 500 ) ).
      lv_grp = |分组汇总(全量计算; by = 分组列, measures = 合计的数值列, groups = 各组行数 n 与合计 sums, other = 其余组合并): { lv_grp }\n|.
    ENDIF.

    DATA(lv_edge) = cfg_int( iv_key = 'RESULT_CTX_EDGE' iv_default = 10 iv_min = 1 iv_max = 100 ).
    DATA(lv_main) = main_measure( ls_ds ).
    IF lv_main > 0.
      DATA(lv_mlbl) = col_label( is_ds = ls_ds iv_ci = lv_main ).
      ls_sort = ls_ds.
      sort_rows( EXPORTING iv_ci = lv_main iv_desc = abap_true CHANGING cs_ds = ls_sort ).
      lv_top = rows_json( is_ds = ls_sort iv_n = lv_edge ).
      sort_rows( EXPORTING iv_ci = lv_main iv_desc = abap_false CHANGING cs_ds = ls_sort ).
      lv_bot = rows_json( is_ds = ls_sort iv_n = lv_edge ).
      lv_top = |按「{ lv_mlbl }」从大到小的前 { lv_edge } 行(全量排序, 是明细行不是按料号等汇总后的结果): { lv_top }\n| &&
               |按「{ lv_mlbl }」从小到大的前 { lv_edge } 行(全量排序): { lv_bot }\n|.
    ELSE.
      lv_top = |前 { lv_edge } 行明细(举例, 不是全部): { rows_json( is_ds = ls_ds iv_n = lv_edge ) }\n|.
    ENDIF.

    IF enabled( ) = abap_true.
      lv_tool = |其余明细不在上下文里。需要别的排名 / Top N / 按某列汇总 / 筛选计数 / 查某个值的明细时, | &&
                |调用工具 { gc_tool }(后端在全部 { lv_n } 行上计算), 不要用上面的举例行推算全量结论。|.
    ELSE.
      lv_tool = |其余明细不在上下文里; 统计与汇总以外的问题, 如实说明只能基于上面的统计、汇总和举例行。|.
    ENDIF.

    ev_text = |{ lv_src }。\n| &&
              |列定义: { lv_cols }\n| &&
              |后端统计(全量计算, 请直接引用, 不要自己重算; numeric = 各数值列合计 / 最大 / 最小, | &&
              |top = 第一个文字列按最后一个数值列的前 10 名与占比): { lv_stats }\n| &&
              lv_grp && lv_top && lv_tool.
    IF strlen( ev_text ) > lv_maxc.
      ev_text = substring( val = ev_text len = lv_maxc ) &&
                |\n(数据说明超过 { lv_maxc } 字符, 已截断; 只依据上面完整出现的数字回答, 其余用工具 { gc_tool } 查)|.
    ENDIF.

  ENDMETHOD.


  METHOD run.

    DATA: ls_ds    TYPE zcl_ai_odata_shaper=>ty_dataset,
          lv_label TYPE string,
          lv_rid   TYPE string,
          lv_sess  TYPE string.
    CLEAR: ev_json, es_ds, ev_label, ev_detail, ev_error.

    IF enabled( ) = abap_false.
      ev_error = '结果查询工具已关闭(RESULT_QUERY_ENABLED = N)'.
    ENDIF.
    IF ev_error IS INITIAL.
      load( EXPORTING iv_artifact_id  = iv_artifact_id
                      iv_need_analyze = iv_need_analyze
            IMPORTING es_ds           = ls_ds
                      ev_label        = lv_label
                      ev_report_id    = lv_rid
                      ev_session_id   = lv_sess
                      ev_error        = ev_error ).
    ENDIF.
    IF ev_error IS NOT INITIAL.
      ev_label = |结果查询失败: { ev_error }|.
      ev_json  = |\{"ok":false,"error":{ js( ev_error ) },| &&
                 |"hint":"改正 args 后可以再调一次, 或直接 action=final 如实说明"\}|.
      RETURN.
    ENDIF.

    " V1.1: 查询主体挪到 query_dataset(关联查表 ZCL_AI_RESULT_LOOKUP 复用)
    query_dataset( EXPORTING is_ds       = ls_ds
                             iv_args_json = iv_args_json
                             iv_res_text  = |{ zcl_ai_task_service=>short_id( iv_artifact_id ) }「{ lv_label }」|
                             iv_source    = |RESULT:{ zcl_ai_task_service=>short_id( iv_artifact_id ) }|
                             iv_label     = lv_label
                   IMPORTING ev_json      = ev_json
                             es_ds        = es_ds
                             ev_label     = ev_label
                             ev_detail    = ev_detail
                             ev_error     = ev_error ).

  ENDMETHOD.


  METHOD query_dataset.

    DATA: ls_q     TYPE ty_query,
          ls_out   TYPE zcl_ai_odata_shaper=>ty_dataset,
          lv_match TYPE i.
    CLEAR: ev_json, es_ds, ev_label, ev_detail, ev_error.

    parse_query( EXPORTING is_ds = is_ds iv_json = iv_args_json
                 IMPORTING es_q = ls_q ev_error = ev_error ).
    IF ev_error IS INITIAL.
      execute( EXPORTING is_ds = is_ds is_q = ls_q
               IMPORTING es_out = ls_out ev_matched = lv_match ev_error = ev_error ).
    ENDIF.

    IF ev_error IS NOT INITIAL.
      ev_label = |结果查询失败: { ev_error }|.
      ev_json  = |\{"ok":false,"error":{ js( ev_error ) },| &&
                 |"hint":"改正 args 后可以再调一次, 或直接 action=final 如实说明"\}|.
      RETURN.
    ENDIF.

    " 查询说明: 筛选 / 分组 / 统计 + 排序 + 取前 N
    DATA(lv_text) = ls_q-text.
    IF ls_q-sort_name IS NOT INITIAL.
      lv_text = COND #( WHEN lv_text IS INITIAL THEN `` ELSE lv_text && `; ` ) &&
                |按 { ls_q-sort_name } { COND string( WHEN ls_q-sort_desc = abap_true THEN `从大到小` ELSE `从小到大` ) }|.
    ENDIF.
    lv_text = COND #( WHEN lv_text IS INITIAL THEN `` ELSE lv_text && `; ` ) &&
              COND string( WHEN ls_q-offset > 0
                           THEN |跳过前 { ls_q-offset } 行, 取 { ls_q-limit } 行|
                           ELSE |取前 { ls_q-limit } 行| ).
    ev_detail = lv_text.

    DATA(lv_name) = COND string( WHEN ls_q-purpose IS NOT INITIAL THEN ls_q-purpose
                                 ELSE |{ iv_label } 查询| ).
    es_ds = to_analysis( is_ds     = ls_out
                         iv_name   = lv_name
                         iv_source = iv_source ).

    DATA: lv_res  TYPE string,
          lv_note TYPE string,
          lv_dsj  TYPE string,
          lv_sent TYPE string,
          lv_keep TYPE i,
          ls_feed TYPE zcl_ai_data_analysis_service=>ty_dataset.
    lv_res = iv_res_text.
    IF is_ds-truncated = abap_true.
      lv_note = |来源已截断: 共 { is_ds-total } 行, 只存了 { lines( is_ds-rows ) } 行, 结论要说明是部分数据|.
      lv_note = |"note":{ js( lv_note ) },|.
    ENDIF.

    " 回填模型: 只写这一页(总数 / 翻页另给); 一页放不进字符上限时, 这一页缩到模型实际看到的行数
    " (前端表格同步), 翻页从模型没看到的那一行接着取, 不漏行
    ls_feed = es_ds.
    ls_feed-total_rows = lines( ls_feed-rows ).
    ls_feed-truncated  = abap_false.
    lv_dsj = zcl_ai_data_analysis_service=>build_datasets_json(
               it_datas     = VALUE #( ( ls_feed ) )
               iv_max_chars = zcl_ai_agent_guard=>gc_max_result_chars - 1000 ).
    FIND REGEX '"rows_sent":([0-9]+)' IN lv_dsj SUBMATCHES lv_sent.
    IF sy-subrc = 0.
      lv_keep = lv_sent.
      IF lv_keep > 0 AND lv_keep < lines( es_ds-rows ).
        DELETE es_ds-rows FROM lv_keep + 1.
        DELETE ls_out-rows FROM lv_keep + 1.
        ls_feed = es_ds.
        ls_feed-total_rows = lines( ls_feed-rows ).
        ls_feed-truncated  = abap_false.
        lv_dsj = zcl_ai_data_analysis_service=>build_datasets_json(
                   it_datas     = VALUE #( ( ls_feed ) )
                   iv_max_chars = zcl_ai_agent_guard=>gc_max_result_chars - 1000 ).
      ENDIF.
    ENDIF.
    es_ds-truncated = xsdbool( ls_out-total > ls_q-offset + lines( es_ds-rows ) ).

    DATA(lv_ret)  = lines( es_ds-rows ).
    DATA(lv_next) = ls_q-offset + lv_ret.
    DATA(lv_more) = xsdbool( ls_out-total > lv_next ).
    DATA(lv_page) = |"total":{ ls_out-total },"offset":{ ls_q-offset },"returned":{ lv_ret },| &&
                    |"more":{ COND string( WHEN lv_more = abap_true THEN `true` ELSE `false` ) },|.
    IF lv_more = abap_true.
      lv_page = lv_page && |"next_offset":{ lv_next },|.
    ENDIF.

    ev_label = |结果查询: { lv_name }, 扫描 { lines( is_ds-rows ) } 行, 命中 { lv_match } 行, | &&
               COND string( WHEN ls_q-offset > 0
                            THEN |返回第 { ls_q-offset + 1 }-{ lv_next } 行(共 { ls_out-total } 行)|
                            ELSE |返回 { lv_ret } 行(共 { ls_out-total } 行)| ).

    ev_json = |\{"ok":true,"result":{ js( lv_res ) },| &&
              |"rows_scanned":{ lines( is_ds-rows ) },"rows_matched":{ lv_match },| &&
              lv_page && |"query":{ js( lv_text ) },| &&
              lv_note && iv_extra && |"dataset":{ lv_dsj }\}|.

  ENDMETHOD.


ENDCLASS.
