*=======================================================================
* 对象:   ZCL_AI_REPORT_RELAY
* 用途:   报表接力(功能计划书/联合分析/01 §5; 11.5 记录 #01)
*         只读工具 prefill_report: 把当前这份报表结果里某一列的值(如「鴻海料號」, 可先筛选)
*         去重后填进下一张报表的多值 / 范围参数, 生成参数卡 —— **不执行**, 仍由用户在卡上确认提交
*         ① 值清单由后端从结果的全部存储行里取, 不经过模型
*         ② 来源运行里同名的参数(如工廠)一起带入, 卡上标明"来自上一次运行"
*         ③ 卡片本身由 AGENT_SERVICE 的 build_report_intro 生成(登记 / 授权核验同报表卡),
*            本类只算要预填的值, 再用 merge_pending 拼进 pending JSON("values" / "prefill")
* 放行:   RPT_RELAY_ENABLED = X; 报表已登记、启用, 用户有报表授权(ZCL_AI_ACCESS=>report_ok)
* 工具参数(args 对象):
*         {"tcode":"ZDPMM159","target_param":"<参数编号或标题>","source_column":"<结果里的列名或标题>",
*          "filters":[...同 query_result...]}
* 配置:   ZAI_CHAT_CFG: RPT_RELAY_ENABLED(X = 开, 默认关) / RELAY_MAX_VALUES(2000, 超过要求先筛选)
* 依赖:   ZCL_AI_RESULT_QUERY V1.1 / ZCL_AI_REPORT_SERVICE / ZCL_AI_ACCESS / ZCL_AI_COMBO_SERVICE(norm_key) /
*         ZCL_AI_TASK_SERVICE / ZCL_AI_ODATA_SHAPER
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用); 先激活 ZCL_AI_RESULT_QUERY V1.1
* V1.0    20261105: 首版
* ★ 重贴后核对标记: 有 METHOD enabled / tool_description / run / merge_pending / source_params;
*   本类没有 SUBMIT / start_run / INSERT / UPDATE(只算值, 不执行)
*=======================================================================
CLASS zcl_ai_report_relay DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS gc_tool TYPE string VALUE 'prefill_report'.

    " 工具开关(RPT_RELAY_ENABLED = X 才开)
    CLASS-METHODS enabled
      RETURNING VALUE(rv) TYPE abap_bool.

    CLASS-METHODS tool_description
      RETURNING VALUE(rv) TYPE string.

    " 执行一次 prefill_report
    " iv_tcode = 路由认出的目标报表(模型给的 tcode 必须与它一致)
    " ev_json 回给模型; ev_extra = 拼进 pending 的 "values":{...},"prefill":{...}(不带外层括号);
    " ev_note = 写在参数卡回答后面的一句说明
    CLASS-METHODS run
      IMPORTING iv_artifact_id TYPE string
                iv_tcode       TYPE string
                iv_args_json   TYPE string
      EXPORTING ev_json        TYPE string
                ev_extra       TYPE string
                ev_note        TYPE string
                ev_label       TYPE string
                ev_detail      TYPE string
                ev_error       TYPE string.

    " pending JSON {"report_id",...,"params":[...]} 末尾拼上 iv_extra
    CLASS-METHODS merge_pending
      IMPORTING iv_pending    TYPE string
                iv_extra      TYPE string
      RETURNING VALUE(rv)     TYPE string.

  PRIVATE SECTION.

    TYPES tt_str TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_kv,
             name  TYPE string,
             value TYPE string,
           END OF ty_kv.
    TYPES tt_kv TYPE STANDARD TABLE OF ty_kv WITH DEFAULT KEY.

    CLASS-METHODS cfg_int
      IMPORTING iv_key     TYPE string
                iv_default TYPE i
                iv_min     TYPE i
                iv_max     TYPE i
      RETURNING VALUE(rv)  TYPE i.
    CLASS-METHODS js
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.
    " 来源结果那次运行的参数(扁平键值, 键大写); 取不到返回空
    CLASS-METHODS source_params
      IMPORTING iv_artifact_id TYPE string
      EXPORTING et_kv          TYPE tt_kv
                ev_run_id      TYPE string.

ENDCLASS.



CLASS zcl_ai_report_relay IMPLEMENTATION.


  METHOD enabled.
    rv = xsdbool( zcl_ai_task_service=>read_cfg_str( 'RPT_RELAY_ENABLED' ) = 'X' ).
  ENDMETHOD.


  METHOD tool_description.

    rv = '把当前这份报表结果里某一列的值(去重, 可先筛选)填进用户点名的下一张报表的多值参数, 生成参数卡让用户确认提交'
      && '(只预填, 不执行; 值由后端从全部行里取, 不要自己罗列; 只能用本轮正在分析的这一份结果)。'
      && '用户说"根据上面的结果 / 把这些料号带进 / 塞进某报表"时用本工具; 调用成功后不要再调用其他工具, '
      && '直接 action=final 用一两句话说明带入了什么、请用户核对参数卡后提交。'
      && 'args: {"tcode":"<目标报表事务码>","target_param":"<目标报表的参数编号或标题, 必须是多值或范围参数>",'
      && '"source_column":"<结果里的列名或标题>",'
      && '"filters":[{"column":"<结果里的列>","op":"eq|ne|gt|ge|lt|le|contains|not_contains|starts_with|in|not_in|empty|not_empty",'
      && '"value":"<值>"}](可选, 先筛行再取值)}。'
      && '返回 values_count = 带入的值个数; carried = 从来源运行一起带入的同名参数。'
      && '例: {"tcode":"ZDPMM159","target_param":"料號","source_column":"鴻海料號",'
      && '"filters":[{"column":"鴻海料號","op":"starts_with","value":"1AM"}]}'.

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


  METHOD js.
    rv = zcl_ai_odata_shaper=>json_str( iv ).
  ENDMETHOD.


  METHOD source_params.

    DATA: lo     TYPE REF TO zcl_ai_odata_shaper,
          lv_art TYPE zai_artifact-artifact_id.
    CLEAR: et_kv, ev_run_id.
    lv_art = to_upper( condense( iv_artifact_id ) ).
    SELECT SINGLE report_run_id FROM zai_artifact
      WHERE artifact_id = @lv_art AND owner = @sy-uname
      INTO @DATA(lv_run).
    IF sy-subrc <> 0 OR lv_run IS INITIAL.
      RETURN.
    ENDIF.
    ev_run_id = lv_run.
    SELECT SINGLE params_json FROM zai_rpt_run
      WHERE report_run_id = @lv_run AND created_by = @sy-uname
      INTO @DATA(lv_pj).
    IF sy-subrc <> 0 OR lv_pj IS INITIAL.
      RETURN.
    ENDIF.
    CREATE OBJECT lo.
    IF lo->parse( CONV string( lv_pj ) ) = abap_false.
      RETURN.
    ENDIF.
    DATA(lv_root) = lo->root( ).
    IF lo->kind( lv_root ) <> 'O'.
      RETURN.
    ENDIF.
    DATA(lt_ids) = lo->kids( lv_root ).
    LOOP AT lt_ids INTO DATA(lv_id).
      DATA(lv_v) = condense( lo->text( lv_id ) ).
      IF lv_v IS NOT INITIAL.
        APPEND VALUE #( name = to_upper( lo->name_of( lv_id ) ) value = lv_v ) TO et_kv.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD merge_pending.

    rv = iv_pending.
    IF iv_extra IS INITIAL.
      RETURN.
    ENDIF.
    DATA(lv_len) = strlen( rv ).
    IF lv_len < 2.
      RETURN.
    ENDIF.
    DATA(lv_last) = lv_len - 1.
    IF rv+lv_last(1) <> '}'.
      RETURN.
    ENDIF.
    rv = rv(lv_last) && `,` && iv_extra && `}`.

  ENDMETHOD.


  METHOD run.

    DATA: lo      TYPE REF TO zcl_ai_odata_shaper,
          ls_src  TYPE zcl_ai_odata_shaper=>ty_dataset,
          lv_lbl  TYPE string,
          lv_rid  TYPE string,
          lv_sess TYPE string,
          lv_sci  TYPE i,
          lv_cell TYPE string,
          lv_nk   TYPE string,
          lt_seen TYPE HASHED TABLE OF string WITH UNIQUE KEY table_line,
          lt_vals TYPE tt_str,
          lv_bad  TYPE i,
          lt_kv   TYPE tt_kv,
          lv_srun TYPE string,
          lt_carr TYPE tt_str,
          lt_vj   TYPE tt_str,
          lt_pj   TYPE tt_str.
    CLEAR: ev_json, ev_extra, ev_note, ev_label, ev_detail, ev_error.

    DO 1 TIMES.
      IF enabled( ) = abap_false.
        ev_error = '报表接力未开启(ZAI_CHAT_CFG: RPT_RELAY_ENABLED = X)'.
        EXIT.
      ENDIF.

      " ---- 参数 ----
      CREATE OBJECT lo.
      IF lo->parse( COND #( WHEN iv_args_json IS INITIAL THEN `{}` ELSE iv_args_json ) ) = abap_false.
        ev_error = |args 不是合法 JSON: { lo->get_error( ) }|.
        EXIT.
      ENDIF.
      DATA(lv_root) = lo->root( ).
      IF lo->kind( lv_root ) <> 'O'.
        ev_error = 'args 必须是 JSON 对象'.
        EXIT.
      ENDIF.
      DATA(lv_tc)   = to_upper( condense( lo->text( lo->child( iv_id = lv_root iv_name = 'tcode' ) ) ) ).
      DATA(lv_tp)   = condense( lo->text( lo->child( iv_id = lv_root iv_name = 'target_param' ) ) ).
      DATA(lv_scol) = condense( lo->text( lo->child( iv_id = lv_root iv_name = 'source_column' ) ) ).
      DATA(lv_want) = to_upper( condense( iv_tcode ) ).
      IF lv_tc IS INITIAL.
        lv_tc = lv_want.
      ENDIF.
      IF lv_want IS NOT INITIAL AND lv_tc <> lv_want.
        ev_error = |用户点名的报表是 { lv_want }, tcode 不能换成 { lv_tc }|.
        EXIT.
      ENDIF.
      IF lv_tp IS INITIAL OR lv_scol IS INITIAL.
        ev_error = 'target_param / source_column 都必须给'.
        EXIT.
      ENDIF.

      " ---- 目标报表: 登记 / 授权 / 参数 ----
      DATA(ls_def) = zcl_ai_report_service=>get_def_by_tcode( lv_tc ).
      IF ls_def-report_id IS INITIAL.
        ev_error = |报表 { lv_tc } 未登记或已停用|.
        EXIT.
      ENDIF.
      IF zcl_ai_access=>report_ok( iv_src_type  = zcl_ai_access=>gc_src_report
                                   iv_report_id = CONV string( ls_def-report_id ) ) = abap_false.
        ev_error = |没有报表 { lv_tc } 的使用权限|.
        EXIT.
      ENDIF.
      DATA(lt_p) = zcl_ai_report_service=>get_params( iv_report_id      = CONV string( ls_def-report_id )
                                                      iv_config_version = CONV string( ls_def-config_version ) ).
      DATA lv_tid TYPE string.
      DATA lv_tlbl TYPE string.
      CLEAR: lv_tid, lv_tlbl.
      DATA(lv_tpu) = to_upper( lv_tp ).
      LOOP AT lt_p INTO DATA(ls_p).
        IF to_upper( ls_p-param_id ) = lv_tpu OR to_upper( condense( ls_p-display_label ) ) = lv_tpu.
          IF ls_p-multi_value = abap_false AND ls_p-range_allowed = abap_false.
            ev_error = |参数「{ ls_p-display_label }」不是多值参数, 不能带入多个值|.
            EXIT.
          ENDIF.
          lv_tid  = ls_p-param_id.
          lv_tlbl = ls_p-display_label.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF ev_error IS NOT INITIAL.
        EXIT.
      ENDIF.
      IF lv_tid IS INITIAL.
        DATA lt_pl TYPE tt_str.
        CLEAR lt_pl.
        LOOP AT lt_p INTO ls_p WHERE multi_value = abap_true OR range_allowed = abap_true.
          APPEND |{ ls_p-param_id }({ ls_p-display_label })| TO lt_pl.
        ENDLOOP.
        ev_error = |报表 { lv_tc } 没有参数「{ lv_tp }」。可带入多个值的参数: { concat_lines_of( table = lt_pl sep = `, ` ) }|.
        EXIT.
      ENDIF.

      " ---- 来源结果: 全部行 → 筛选 → 取列去重 ----
      zcl_ai_result_query=>load_dataset(
        EXPORTING iv_artifact_id = iv_artifact_id
        IMPORTING es_ds          = ls_src
                  ev_label       = lv_lbl
                  ev_report_id   = lv_rid
                  ev_session_id  = lv_sess
                  ev_error       = ev_error ).
      IF ev_error IS NOT INITIAL.
        EXIT.
      ENDIF.
      lv_sci = zcl_ai_result_query=>find_col( is_ds = ls_src iv_name = lv_scol ).
      IF lv_sci = 0.
        ev_error = |结果里没有列「{ lv_scol }」。可用的列: { zcl_ai_result_query=>col_list( ls_src ) }|.
        EXIT.
      ENDIF.
      zcl_ai_result_query=>prefilter_rows(
        EXPORTING is_schema    = ls_src
                  iv_args_json = iv_args_json
                  iv_max_ci    = lines( ls_src-columns )
        IMPORTING ev_error     = ev_error
        CHANGING  ct_rows      = ls_src-rows ).
      IF ev_error IS NOT INITIAL.
        EXIT.
      ENDIF.
      DATA(lv_max) = cfg_int( iv_key = 'RELAY_MAX_VALUES' iv_default = 2000 iv_min = 10 iv_max = 20000 ).
      LOOP AT ls_src-rows INTO DATA(ls_row).
        CLEAR lv_cell.
        READ TABLE ls_row-cells INTO lv_cell INDEX lv_sci.
        lv_cell = condense( lv_cell ).
        IF lv_cell IS INITIAL.
          CONTINUE.
        ENDIF.
        " 参数卡多值按 , 和 | 拆分: 含这两个字符的值放不进去
        IF lv_cell CA ',|' OR strlen( lv_cell ) > 60.
          lv_bad = lv_bad + 1.
          CONTINUE.
        ENDIF.
        lv_nk = zcl_ai_combo_service=>norm_key( lv_cell ).
        READ TABLE lt_seen TRANSPORTING NO FIELDS WITH TABLE KEY table_line = lv_nk.
        IF sy-subrc = 0.
          CONTINUE.
        ENDIF.
        IF lines( lt_vals ) >= lv_max.
          ev_error = |要带入的值超过 { lv_max } 个(RELAY_MAX_VALUES), 请先用 filters 缩小范围|.
          EXIT.
        ENDIF.
        INSERT lv_nk INTO TABLE lt_seen.
        APPEND lv_cell TO lt_vals.
      ENDLOOP.
      IF ev_error IS NOT INITIAL.
        EXIT.
      ENDIF.
      IF lt_vals IS INITIAL.
        ev_error = |筛选后列「{ lv_scol }」没有可带入的值|.
        EXIT.
      ENDIF.

      " ---- 来源运行里同名的参数一起带入(目标参数本身除外) ----
      source_params( EXPORTING iv_artifact_id = iv_artifact_id
                     IMPORTING et_kv = lt_kv ev_run_id = lv_srun ).
      APPEND |{ js( to_upper( lv_tid ) ) }:{ js( concat_lines_of( table = lt_vals sep = `,` ) ) }| TO lt_vj.
      LOOP AT lt_p INTO ls_p.
        IF to_upper( ls_p-param_id ) = to_upper( lv_tid ).
          CONTINUE.
        ENDIF.
        READ TABLE lt_kv INTO DATA(ls_kv) WITH KEY name = to_upper( ls_p-param_id ).
        IF sy-subrc = 0.
          APPEND |{ js( to_upper( ls_p-param_id ) ) }:{ js( ls_kv-value ) }| TO lt_vj.
          APPEND |{ js( to_upper( ls_p-param_id ) ) }:\{"carried":true\}| TO lt_pj.
          APPEND ls_p-display_label TO lt_carr.
        ENDIF.
      ENDLOOP.
    ENDDO.

    IF ev_error IS NOT INITIAL.
      ev_label = |报表接力失败: { ev_error }|.
      ev_json  = |\{"ok":false,"error":{ js( ev_error ) },| &&
                 |"hint":"改正 args 后可以再调一次, 或直接 action=final 如实说明"\}|.
      RETURN.
    ENDIF.

    DATA(lv_short) = zcl_ai_task_service=>short_id( iv_artifact_id ).
    INSERT |{ js( to_upper( lv_tid ) ) }:\{"count":{ lines( lt_vals ) },"source_column":{ js( lv_scol ) },| &&
           |"source_artifact":{ js( to_upper( condense( iv_artifact_id ) ) ) },"source_short":{ js( lv_short ) },| &&
           |"source_label":{ js( lv_lbl ) },"source_run":{ js( lv_srun ) }\}| INTO lt_pj INDEX 1.
    ev_extra = |"values":\{{ concat_lines_of( table = lt_vj sep = `,` ) }\},| &&
               |"prefill":\{{ concat_lines_of( table = lt_pj sep = `,` ) }\}|.

    ev_note = |已从结果 { lv_short }「{ lv_lbl }」的「{ lv_scol }」列带入 { lines( lt_vals ) } 个值到参数「{ lv_tlbl }」|.
    IF lt_carr IS NOT INITIAL.
      ev_note = |{ ev_note }; 同名参数 { concat_lines_of( table = lt_carr sep = `、` ) } 沿用上一次运行的值|.
    ENDIF.
    IF lv_bad > 0.
      ev_note = |{ ev_note }; { lv_bad } 个值含逗号或过长, 没有带入|.
    ENDIF.
    ev_note = |{ ev_note }。请核对参数卡后提交。|.
    ev_label  = |报表接力: { lv_tc } 参数「{ lv_tlbl }」带入 { lines( lt_vals ) } 个值(来自 { lv_short }「{ lv_scol }」)|.
    ev_detail = ev_label.

    DATA(lv_carr_j) = ``.
    LOOP AT lt_carr INTO DATA(lv_c1).
      lv_carr_j = COND #( WHEN lv_carr_j IS INITIAL THEN js( lv_c1 ) ELSE lv_carr_j && `,` && js( lv_c1 ) ).
    ENDLOOP.
    ev_json = |\{"ok":true,"tcode":{ js( lv_tc ) },"target_param":{ js( lv_tlbl ) },| &&
              |"source_column":{ js( lv_scol ) },"values_count":{ lines( lt_vals ) },"values_skipped":{ lv_bad },| &&
              |"carried":[{ lv_carr_j }],| &&
              |"note":"参数卡已生成, 等用户核对后提交; 不要再调用工具, 直接 action=final 简短说明"\}|.

  ENDMETHOD.


ENDCLASS.
