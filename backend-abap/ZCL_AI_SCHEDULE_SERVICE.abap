*=======================================================================
* 对象:   ZCL_AI_SCHEDULE_SERVICE
* 用途:   定时任务(设计: 功能计划书/定时任务/01-方案与开发计划 V1.1)
*         一个定时任务 = 名称 + 指令 + 场景 + 模型 + 最多 3 个触发 + 可选数据来源
*         (报表执行 / Fiori 报表, 参数来自一次成功运行的结果, 只有日期参数可改成相对日期)
*         · 每个触发以创建人自己的身份建一个 SAP 周期作业(每天 / 每 N 小时),
*           作业步骤 ZAI_SCHED_RUNNER 调 run_one: 今天不该跑(星期 / 日期)就直接结束
*         · run_one: 数据来源(相对日期换算 → start_run 轮询 get_run_status / Fiori run)
*           → 写一条【定时运行】消息 → 有指令就 analyze_agent(聚焦本次结果) → 运行记录
*         · 无人值守时灵犀不决定报表参数(D5): 报表只按保存时的参数跑
* 接口:   save_sched(ScheduleSave) / get_list(ScheduleList) / do_action(ScheduleAction:
*         PAUSE / RESUME / DELETE / RUNNOW / SEEN / ADMIN_STOP / ADMIN_RESUME / PREFILL) /
*         get_runs(ScheduleRuns); run_one(ZAI_SCHED_RUNNER)
* 数据:   ZAI_SCHEDULE(定时任务) / ZAI_SCHED_TRIG(触发) / ZAI_SCHED_RUN(运行记录)
* 配置:   ZAI_CHAT_CFG: SCHED_ENABLED(X = 开) / SCHED_MAX_PER_USER(10) / SCHED_MIN_HOURS(1) /
*         SCHED_WAIT_MIN(30) / SCHED_KEEP_RUNS(30)
* 依赖:   ZCL_AI_REPORT_SERVICE / ZCL_AI_FIORI_REPORT_SERVICE / ZCL_AI_AGENT_SERVICE /
*         ZCL_AI_TASK_SERVICE / ZCL_AI_ACCESS / ZCL_AI_ODATA_SHAPER; SE38 ZAI_SCHED_RUNNER(作业步骤,
*         这里按名字动态 SUBMIT, 激活不检查它)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用); 先建三张表
* 待实测: JOB_CLOSE 的周期参数 PRDDAYS / PRDHOURS(方案 §12 第 1 条)
* V1.0    20261104: 首版
* ★ 重贴后核对标记: 有 METHOD save_sched / get_list / do_action / get_runs / run_one /
*   resolve_params / due_on / next_run / create_jobs / drop_jobs; create_job 里有 prddays = lv_days
*=======================================================================
CLASS zcl_ai_schedule_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES tt_str TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_trig,
             trig_no     TYPE i,
             freq        TYPE string,     " DAILY / WEEKLY / MONTHLY / HOURLY
             run_time    TYPE string,     " HHMM
             weekdays    TYPE string,     " 7 位, 周一到周日, X = 跑
             month_day   TYPE i,          " 1-31; 99 = 最后一天
             every_hours TYPE i,
             next_run    TYPE string,     " YYYYMMDDHHMMSS(服务器时间)
             text        TYPE string,     " 每天 09:00
           END OF ty_trig.
    TYPES tt_trig TYPE STANDARD TABLE OF ty_trig WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_pview,
             param_id  TYPE string,
             label     TYPE string,
             data_type TYPE string,
             is_range  TYPE abap_bool,
             is_multi  TYPE abap_bool,
             value     TYPE string,       " 可含相对日期记号
           END OF ty_pview.
    TYPES tt_pview TYPE STANDARD TABLE OF ty_pview WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_sched,
             sched_id     TYPE string,
             owner        TYPE string,
             name         TYPE string,
             instruction  TYPE string,
             scene        TYPE string,
             model_id     TYPE string,
             src_type     TYPE string,     " 空 / REPORT / FIORI
             report_id    TYPE string,
             report_name  TYPE string,
             params_json  TYPE string,
             params       TYPE tt_pview,
             status       TYPE string,
             stop_note    TYPE string,
             session_id   TYPE string,
             last_run_at  TYPE string,
             last_run_sts TYPE string,
             last_seen_at TYPE string,
             unread       TYPE abap_bool,
             next_run     TYPE string,
             triggers     TYPE tt_trig,
             created_at   TYPE string,
             changed_at   TYPE string,
             from_artifact TYPE string,    " PREFILL: 来源结果号
           END OF ty_sched.
    TYPES tt_sched TYPE STANDARD TABLE OF ty_sched WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_run,
             started_at    TYPE string,
             trig_no       TYPE i,
             status        TYPE string,
             params_used   TYPE string,
             report_run_id TYPE string,
             artifact_id   TYPE string,
             row_count     TYPE i,
             elapsed_ms    TYPE i,
             message       TYPE string,
           END OF ty_run.
    TYPES tt_run TYPE STANDARD TABLE OF ty_run WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_reply,
             message  TYPE string,
             error    TYPE string,     " 非空 = 失败
             is_admin TYPE abap_bool,
             item     TYPE ty_sched,
             items    TYPE tt_sched,
             runs     TYPE tt_run,
           END OF ty_reply.

    CLASS-METHODS enabled
      RETURNING VALUE(rv) TYPE abap_bool.

    " 新建或修改(JSON 里有 schedId 即修改)
    CLASS-METHODS save_sched
      IMPORTING iv_json       TYPE string
                iv_request_id TYPE string
      RETURNING VALUE(rs)     TYPE ty_reply.

    " 列表: iv_scope 空 = 自己的; ALL = 管理员看全部
    CLASS-METHODS get_list
      IMPORTING iv_scope  TYPE string
      RETURNING VALUE(rs) TYPE ty_reply.

    CLASS-METHODS do_action
      IMPORTING iv_sched_id TYPE string
                iv_action   TYPE string
                iv_note     TYPE string
      RETURNING VALUE(rs)   TYPE ty_reply.

    CLASS-METHODS get_runs
      IMPORTING iv_sched_id TYPE string
      RETURNING VALUE(rs)   TYPE ty_reply.

    " 作业步骤入口(ZAI_SCHED_RUNNER; 以创建人身份运行); iv_trig_no = 0 是立即运行
    CLASS-METHODS run_one
      IMPORTING iv_sched_id TYPE string
                iv_trig_no  TYPE i.

    " 参数快照里的相对日期记号 → 具体日期(YYYYMMDD); 其余原样
    CLASS-METHODS resolve_params
      IMPORTING iv_json   TYPE string
                iv_date   TYPE d
      RETURNING VALUE(rv) TYPE string.

    " 一个值(可能是记号): 是记号 → ev_value = 日期, ev_token = X; 记号不认识 → ev_error
    CLASS-METHODS resolve_token
      IMPORTING iv_value TYPE string
                iv_date  TYPE d
      EXPORTING ev_value TYPE string
                ev_token TYPE abap_bool
                ev_error TYPE string.

    " 这一天该不该跑(星期 / 日期规则; 每天和每 N 小时恒为是)
    CLASS-METHODS due_on
      IMPORTING is_trig   TYPE ty_trig
                iv_date   TYPE d
      RETURNING VALUE(rv) TYPE abap_bool.

    " 下次运行时间(YYYYMMDDHHMMSS); 从 iv_date / iv_time 之后算
    CLASS-METHODS next_run
      IMPORTING is_trig   TYPE ty_trig
                iv_date   TYPE d
                iv_time   TYPE t
      RETURNING VALUE(rv) TYPE string.

    " 星期: 0 = 周一 … 6 = 周日
    CLASS-METHODS weekday
      IMPORTING iv_date   TYPE d
      RETURNING VALUE(rv) TYPE i.

    CLASS-METHODS last_day
      IMPORTING iv_date   TYPE d
      RETURNING VALUE(rv) TYPE d.

    CLASS-METHODS trig_text
      IMPORTING is_trig   TYPE ty_trig
      RETURNING VALUE(rv) TYPE string.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_kv,
             name  TYPE string,
             value TYPE string,
           END OF ty_kv.
    TYPES tt_kv TYPE STANDARD TABLE OF ty_kv WITH DEFAULT KEY.
    TYPES tt_db_trig TYPE STANDARD TABLE OF zai_sched_trig WITH DEFAULT KEY.

    CONSTANTS: gc_base_date TYPE d VALUE '20200101'.   " 秒数换算基准(避免 int4 溢出)

    CLASS-METHODS cfg_int
      IMPORTING iv_key     TYPE string
                iv_default TYPE i
                iv_min     TYPE i
                iv_max     TYPE i
      RETURNING VALUE(rv)  TYPE i.
    CLASS-METHODS now14
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS js
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS user_ok
      RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS guid
      RETURNING VALUE(rv) TYPE string.
    " 扁平 JSON 对象 ↔ 键值(保留键的大小写)
    CLASS-METHODS parse_flat
      IMPORTING iv_json   TYPE string
      RETURNING VALUE(rt) TYPE tt_kv.
    CLASS-METHODS flat_json
      IMPORTING it_kv     TYPE tt_kv
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS secs_of
      IMPORTING iv_date   TYPE d
                iv_time   TYPE t
      RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS ts_secs
      IMPORTING iv_ts     TYPE string
      RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS fmt_time
      IMPORTING iv_ts     TYPE string
      RETURNING VALUE(rv) TYPE string.
    " 数据来源: 结果号 → 类型 / 报表 / 参数快照(本人的、可用的结果)
    CLASS-METHODS source_of_artifact
      IMPORTING iv_artifact_id TYPE string
      EXPORTING ev_src_type    TYPE string
                ev_report_id   TYPE string
                ev_params_json TYPE string
                ev_error       TYPE string.
    " 参数显示(标题 / 类型 / 范围多值) —— 报表执行按登记, Fiori 按目录
    CLASS-METHODS param_views
      IMPORTING iv_src_type    TYPE string
                iv_report_id   TYPE string
                iv_params_json TYPE string
      EXPORTING et_views       TYPE tt_pview
                ev_report_name TYPE string.
    " 提交的参数并进基础快照: 只认日期参数, 值必须是日期或认识的记号
    CLASS-METHODS merge_dates
      IMPORTING iv_base_json TYPE string
                iv_new_json  TYPE string
                it_views     TYPE tt_pview
      EXPORTING ev_json      TYPE string
                ev_error     TYPE string.
    CLASS-METHODS parse_triggers
      IMPORTING io_json  TYPE REF TO zcl_ai_odata_shaper
                iv_node  TYPE i
      EXPORTING et_trig  TYPE tt_trig
                ev_error TYPE string.
    CLASS-METHODS to_view
      IMPORTING is_db      TYPE zai_schedule
                iv_detail  TYPE abap_bool
      RETURNING VALUE(rs)  TYPE ty_sched.
    CLASS-METHODS db_trigs
      IMPORTING iv_sched_id TYPE string
      RETURNING VALUE(rt)   TYPE tt_db_trig.
    CLASS-METHODS trig_of_db
      IMPORTING is_db     TYPE zai_sched_trig
      RETURNING VALUE(rs) TYPE ty_trig.
    CLASS-METHODS create_job
      IMPORTING iv_sched_id TYPE string
                is_trig     TYPE ty_trig
                iv_now      TYPE abap_bool DEFAULT abap_false   " X = 立即运行一次(不周期)
      EXPORTING ev_jobname  TYPE string
                ev_jobcount TYPE string
                ev_error    TYPE string.
    CLASS-METHODS create_jobs
      IMPORTING iv_sched_id TYPE string
      EXPORTING ev_error    TYPE string.
    CLASS-METHODS drop_jobs
      IMPORTING iv_sched_id TYPE string.
    CLASS-METHODS write_msg
      IMPORTING iv_session_id TYPE string
                iv_text       TYPE string.
    CLASS-METHODS log_run
      IMPORTING is_db  TYPE zai_schedule
                is_run TYPE ty_run.

ENDCLASS.



CLASS zcl_ai_schedule_service IMPLEMENTATION.


  METHOD enabled.
    rv = xsdbool( zcl_ai_task_service=>read_cfg_str( 'SCHED_ENABLED' ) = 'X' ).
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


  METHOD now14.
    rv = |{ sy-datum }{ sy-uzeit }|.
  ENDMETHOD.


  METHOD js.
    rv = zcl_ai_odata_shaper=>json_str( iv ).
  ENDMETHOD.


  METHOD user_ok.
    SELECT SINGLE userid FROM zai_chat_user
      WHERE userid = @sy-uname AND active = 'X'
      INTO @DATA(lv_user).
    rv = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.


  METHOD guid.
    DATA lv_id TYPE c LENGTH 32.
    CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_32 = lv_id.
    rv = lv_id.
  ENDMETHOD.


  METHOD parse_flat.
    DATA lo TYPE REF TO zcl_ai_odata_shaper.
    CREATE OBJECT lo.
    IF iv_json IS INITIAL OR lo->parse( iv_json ) = abap_false.
      RETURN.
    ENDIF.
    DATA(lv_root) = lo->root( ).
    IF lo->kind( lv_root ) <> 'O'.
      RETURN.
    ENDIF.
    DATA(lt_kids) = lo->kids( lv_root ).
    LOOP AT lt_kids INTO DATA(lv_k).
      APPEND VALUE #( name = lo->name_of( lv_k ) value = lo->text( lv_k ) ) TO rt.
    ENDLOOP.
  ENDMETHOD.


  METHOD flat_json.
    DATA lt_p TYPE tt_str.
    LOOP AT it_kv INTO DATA(ls_kv).
      APPEND |{ js( ls_kv-name ) }:{ js( ls_kv-value ) }| TO lt_p.
    ENDLOOP.
    rv = |\{{ concat_lines_of( table = lt_p sep = `,` ) }\}|.
  ENDMETHOD.


  METHOD secs_of.
    rv = ( iv_date - gc_base_date ) * 86400 + CONV i( iv_time ).
  ENDMETHOD.


  METHOD ts_secs.
    DATA: lv_d TYPE d,
          lv_t TYPE t.
    IF strlen( iv_ts ) < 14.
      RETURN.
    ENDIF.
    IF iv_ts(14) CN '0123456789'.
      RETURN.
    ENDIF.
    lv_d = iv_ts(8).
    lv_t = iv_ts+8(6).
    rv = secs_of( iv_date = lv_d iv_time = lv_t ).
  ENDMETHOD.


  METHOD fmt_time.
    " YYYYMMDDHHMMSS → MM-DD HH:MM
    IF strlen( iv_ts ) >= 12.
      rv = |{ iv_ts+4(2) }-{ iv_ts+6(2) } { iv_ts+8(2) }:{ iv_ts+10(2) }|.
    ENDIF.
  ENDMETHOD.


  METHOD weekday.
    " 1900-01-01 是周一
    DATA lv_base TYPE d VALUE '19000101'.
    rv = ( iv_date - lv_base ) MOD 7.
  ENDMETHOD.


  METHOD last_day.
    DATA: lv_y  TYPE i,
          lv_m  TYPE i,
          lv_nd TYPE d.
    lv_y = iv_date(4).
    lv_m = iv_date+4(2).
    lv_m = lv_m + 1.
    IF lv_m > 12.
      lv_m = 1.
      lv_y = lv_y + 1.
    ENDIF.
    lv_nd = |{ lv_y WIDTH = 4 ALIGN = RIGHT PAD = '0' }{ lv_m WIDTH = 2 ALIGN = RIGHT PAD = '0' }01|.
    rv = lv_nd - 1.
  ENDMETHOD.


  METHOD resolve_token.

    DATA: lv_d   TYPE d,
          lv_n   TYPE i,
          lv_tok TYPE string,
          lv_num TYPE string.
    CLEAR: ev_value, ev_token, ev_error.
    lv_tok = to_upper( condense( iv_value ) ).
    ev_value = iv_value.
    IF lv_tok IS INITIAL.
      RETURN.
    ENDIF.
    IF lv_tok(1) <> '@'.
      RETURN.
    ENDIF.
    CLEAR ev_value.
    ev_token = abap_true.
    lv_d = iv_date.
    CASE lv_tok.
      WHEN '@TODAY'.
      WHEN '@WEEK_START'.
        lv_d = iv_date - weekday( iv_date ).
      WHEN '@MONTH_START'.
        lv_d+6(2) = '01'.
      WHEN '@MONTH_END'.
        lv_d = last_day( iv_date ).
      WHEN '@LMONTH_START'.
        lv_d+6(2) = '01'.
        lv_d = lv_d - 1.
        lv_d+6(2) = '01'.
      WHEN '@LMONTH_END'.
        lv_d+6(2) = '01'.
        lv_d = lv_d - 1.
      WHEN '@YEAR_START'.
        lv_d+4(4) = '0101'.
      WHEN OTHERS.
        " @TODAY-N
        IF strlen( lv_tok ) > 7.
          lv_num = lv_tok+7.
          IF lv_tok(7) <> '@TODAY-'.
            CLEAR lv_num.
          ENDIF.
        ENDIF.
        IF lv_num IS NOT INITIAL.
          IF lv_num CO '0123456789' AND strlen( lv_num ) <= 3.
            lv_n = lv_num.
            IF lv_n BETWEEN 1 AND 366.
              lv_d = iv_date - lv_n.
            ELSE.
              ev_error = |相对日期 { iv_value } 的天数只能是 1-366|.
            ENDIF.
          ELSE.
            ev_error = |不认识的相对日期 { iv_value }|.
          ENDIF.
        ELSE.
          ev_error = |不认识的相对日期 { iv_value }|.
        ENDIF.
    ENDCASE.
    IF ev_error IS INITIAL.
      ev_value = lv_d.
    ENDIF.

  ENDMETHOD.


  METHOD resolve_params.

    " 每个值按逗号拆(范围 low,high / 多值), 逐项换算记号, 再拼回
    DATA: lt_items TYPE tt_str,
          lt_out   TYPE tt_str,
          lv_v     TYPE string,
          lv_tok   TYPE abap_bool,
          lv_err   TYPE string.
    DATA(lt_kv) = parse_flat( iv_json ).
    LOOP AT lt_kv ASSIGNING FIELD-SYMBOL(<ls_kv>).
      IF <ls_kv>-value NS '@'.
        CONTINUE.
      ENDIF.
      SPLIT <ls_kv>-value AT ',' INTO TABLE lt_items.
      CLEAR lt_out.
      LOOP AT lt_items INTO DATA(lv_item).
        resolve_token( EXPORTING iv_value = lv_item iv_date = iv_date
                       IMPORTING ev_value = lv_v ev_token = lv_tok ev_error = lv_err ).
        APPEND COND string( WHEN lv_err IS INITIAL THEN lv_v ELSE lv_item ) TO lt_out.
      ENDLOOP.
      <ls_kv>-value = concat_lines_of( table = lt_out sep = `,` ).
    ENDLOOP.
    rv = flat_json( lt_kv ).

  ENDMETHOD.


  METHOD due_on.

    DATA lv_last TYPE d.
    CASE is_trig-freq.
      WHEN 'DAILY' OR 'HOURLY'.
        rv = abap_true.
      WHEN 'WEEKLY'.
        DATA lv_w7 TYPE c LENGTH 7.
        lv_w7 = is_trig-weekdays.
        DATA(lv_wd) = weekday( iv_date ).
        rv = xsdbool( lv_w7+lv_wd(1) = 'X' ).
      WHEN 'MONTHLY'.
        lv_last = last_day( iv_date ).
        DATA(lv_day) = CONV i( iv_date+6(2) ).
        IF is_trig-month_day = 99.
          rv = xsdbool( iv_date = lv_last ).
        ELSEIF is_trig-month_day > CONV i( lv_last+6(2) ).
          " 31 号在小月 / 二月: 按当月最后一天
          rv = xsdbool( iv_date = lv_last ).
        ELSE.
          rv = xsdbool( lv_day = is_trig-month_day ).
        ENDIF.
      WHEN OTHERS.
        rv = abap_false.
    ENDCASE.

  ENDMETHOD.


  METHOD next_run.

    DATA: lv_t    TYPE t,
          lv_d    TYPE d,
          lv_now  TYPE i,
          lv_c    TYPE i,
          lv_step TYPE i,
          lv_k    TYPE i.
    IF strlen( is_trig-run_time ) < 4.
      RETURN.
    ENDIF.
    lv_t = |{ is_trig-run_time(4) }00|.
    lv_now = secs_of( iv_date = iv_date iv_time = iv_time ).

    IF is_trig-freq = 'HOURLY'.
      lv_step = nmax( val1 = is_trig-every_hours val2 = 1 ) * 3600.
      lv_c = secs_of( iv_date = iv_date iv_time = lv_t ).
      " 从当天起始点往前退到不晚于现在, 再往后找第一个晚于现在的
      WHILE lv_c > lv_now.
        lv_c = lv_c - lv_step.
      ENDWHILE.
      WHILE lv_c <= lv_now.
        lv_c = lv_c + lv_step.
      ENDWHILE.
      lv_d = gc_base_date + lv_c DIV 86400.
      lv_t = lv_c MOD 86400.
      rv = |{ lv_d }{ lv_t }|.
      RETURN.
    ENDIF.

    DO 62 TIMES.
      lv_k = sy-index - 1.
      lv_d = iv_date + lv_k.
      IF lv_k = 0 AND lv_t <= iv_time.
        CONTINUE.
      ENDIF.
      IF due_on( is_trig = is_trig iv_date = lv_d ) = abap_true.
        rv = |{ lv_d }{ lv_t }|.
        RETURN.
      ENDIF.
    ENDDO.

  ENDMETHOD.


  METHOD trig_text.

    DATA: lt_days TYPE tt_str,
          lv_hm   TYPE string,
          lv_w7   TYPE c LENGTH 7,
          lv_i    TYPE i.
    lv_w7 = is_trig-weekdays.
    DATA(lt_names) = VALUE tt_str( ( `一` ) ( `二` ) ( `三` ) ( `四` ) ( `五` ) ( `六` ) ( `日` ) ).
    IF strlen( is_trig-run_time ) >= 4.
      lv_hm = |{ is_trig-run_time(2) }:{ is_trig-run_time+2(2) }|.
    ENDIF.
    CASE is_trig-freq.
      WHEN 'DAILY'.
        rv = |每天 { lv_hm }|.
      WHEN 'WEEKLY'.
        DO 7 TIMES.
          lv_i = sy-index - 1.
          IF lv_w7+lv_i(1) = 'X'.
            READ TABLE lt_names INTO DATA(lv_nm) INDEX sy-index.
            APPEND lv_nm TO lt_days.
          ENDIF.
        ENDDO.
        IF lv_w7 = 'XXXXX'.
          rv = |工作日 { lv_hm }|.
        ELSE.
          rv = |每周{ concat_lines_of( table = lt_days sep = `、` ) } { lv_hm }|.
        ENDIF.
      WHEN 'MONTHLY'.
        rv = COND #( WHEN is_trig-month_day = 99 THEN |每月最后一天 { lv_hm }|
                     ELSE |每月 { is_trig-month_day } 号 { lv_hm }| ).
      WHEN 'HOURLY'.
        rv = |每 { is_trig-every_hours } 小时(从 { lv_hm } 起)|.
    ENDCASE.

  ENDMETHOD.


  METHOD source_of_artifact.

    DATA lv_art TYPE zai_artifact-artifact_id.
    CLEAR: ev_src_type, ev_report_id, ev_params_json, ev_error.
    lv_art = to_upper( condense( iv_artifact_id ) ).
    SELECT SINGLE artifact_type, status, report_run_id FROM zai_artifact
      WHERE artifact_id = @lv_art AND owner = @sy-uname
      INTO @DATA(ls_art).
    IF sy-subrc <> 0.
      ev_error = '结果不存在或不属于当前用户'.
      RETURN.
    ENDIF.
    CASE ls_art-artifact_type.
      WHEN 'REPORT_RESULT'.
        SELECT SINGLE report_id, params_json, status FROM zai_rpt_run
          WHERE report_run_id = @ls_art-report_run_id AND created_by = @sy-uname
          INTO @DATA(ls_rr).
        IF sy-subrc <> 0 OR ls_rr-status <> zcl_ai_report_service=>gc_run_ready.
          ev_error = '找不到这份结果对应的成功运行'.
          RETURN.
        ENDIF.
        ev_src_type    = 'REPORT'.
        ev_report_id   = ls_rr-report_id.
        ev_params_json = ls_rr-params_json.
      WHEN 'FIORI_RESULT'.
        SELECT SINGLE report_id, params_json, run_status FROM zai_frpt_run
          WHERE artifact_id = @lv_art AND owner = @sy-uname
          INTO @DATA(ls_fr).
        IF sy-subrc <> 0 OR ls_fr-run_status <> 'READY'.
          ev_error = '找不到这份结果对应的成功取数'.
          RETURN.
        ENDIF.
        ev_src_type    = 'FIORI'.
        ev_report_id   = ls_fr-report_id.
        ev_params_json = ls_fr-params_json.
      WHEN OTHERS.
        ev_error = '只有报表执行和 Fiori 报表的结果可以设为定时'.
    ENDCASE.
    IF ev_error IS INITIAL AND ev_params_json IS INITIAL.
      ev_params_json = `{}`.
    ENDIF.

  ENDMETHOD.


  METHOD param_views.

    DATA ls_v TYPE ty_pview.
    CLEAR: et_views, ev_report_name.
    DATA(lt_kv) = parse_flat( iv_params_json ).
    IF iv_src_type = 'REPORT'.
      DATA(ls_def) = zcl_ai_report_service=>get_def( iv_report_id ).
      ev_report_name = ls_def-report_name.
      DATA(lt_par) = zcl_ai_report_service=>get_params( iv_report_id      = iv_report_id
                                                        iv_config_version = ls_def-config_version ).
      LOOP AT lt_kv INTO DATA(ls_kv).
        CLEAR ls_v.
        ls_v-param_id = ls_kv-name.
        ls_v-label    = ls_kv-name.
        ls_v-value    = ls_kv-value.
        LOOP AT lt_par INTO DATA(ls_p).
          IF to_lower( ls_p-param_id ) = to_lower( ls_kv-name ) OR to_lower( ls_p-abap_name ) = to_lower( ls_kv-name ).
            ls_v-label     = COND #( WHEN ls_p-display_label IS NOT INITIAL THEN ls_p-display_label ELSE ls_p-param_id ).
            ls_v-data_type = to_upper( ls_p-data_type ).
            ls_v-is_range  = ls_p-range_allowed.
            ls_v-is_multi  = ls_p-multi_value.
            EXIT.
          ENDIF.
        ENDLOOP.
        APPEND ls_v TO et_views.
      ENDLOOP.
    ELSEIF iv_src_type = 'FIORI'.
      DATA(ls_defs) = zcl_ai_fiori_report_service=>list_defs( ).
      READ TABLE ls_defs-reports INTO DATA(ls_fd) WITH KEY report_id = iv_report_id.
      ev_report_name = COND #( WHEN sy-subrc = 0 THEN ls_fd-report_name ELSE iv_report_id ).
      LOOP AT lt_kv INTO ls_kv.
        CLEAR ls_v.
        ls_v-param_id = ls_kv-name.
        ls_v-label    = ls_kv-name.
        ls_v-value    = ls_kv-value.
        LOOP AT ls_fd-params INTO DATA(ls_fp).
          IF to_lower( ls_fp-param_id ) = to_lower( ls_kv-name ).
            ls_v-label     = COND #( WHEN ls_fp-label IS NOT INITIAL THEN ls_fp-label ELSE ls_fp-param_id ).
            ls_v-data_type = to_upper( ls_fp-data_type ).
            ls_v-is_range  = ls_fp-range_allowed.
            ls_v-is_multi  = ls_fp-multi_value.
            EXIT.
          ENDIF.
        ENDLOOP.
        APPEND ls_v TO et_views.
      ENDLOOP.
    ENDIF.

  ENDMETHOD.


  METHOD merge_dates.

    DATA: lt_items TYPE tt_str,
          lt_out   TYPE tt_str,
          lv_v     TYPE string,
          lv_tok   TYPE abap_bool,
          lv_err   TYPE string,
          lv_item  TYPE string.
    CLEAR: ev_json, ev_error.
    DATA(lt_base) = parse_flat( iv_base_json ).
    DATA(lt_new)  = parse_flat( iv_new_json ).
    LOOP AT lt_new INTO DATA(ls_new).
      READ TABLE lt_base ASSIGNING FIELD-SYMBOL(<ls_b>) WITH KEY name = ls_new-name.
      IF sy-subrc <> 0.
        CONTINUE.                 " 原运行没有的参数不收
      ENDIF.
      IF ls_new-value = <ls_b>-value.
        CONTINUE.
      ENDIF.
      DATA ls_view TYPE ty_pview.
      CLEAR ls_view.
      READ TABLE it_views INTO ls_view WITH KEY param_id = ls_new-name.
      IF sy-subrc <> 0 OR ls_view-data_type <> 'DATE'.
        ev_error = |参数「{ COND string( WHEN ls_view-label IS NOT INITIAL THEN ls_view-label ELSE ls_new-name ) }」| &&
                   |不能在这里修改; 要换参数值请重新执行一次报表, 再在结果卡上设为定时|.
        RETURN.
      ENDIF.
      SPLIT ls_new-value AT ',' INTO TABLE lt_items.
      CLEAR lt_out.
      LOOP AT lt_items INTO lv_item.
        lv_item = condense( lv_item ).
        resolve_token( EXPORTING iv_value = lv_item iv_date = sy-datum
                       IMPORTING ev_value = lv_v ev_token = lv_tok ev_error = lv_err ).
        IF lv_err IS NOT INITIAL.
          ev_error = |「{ ls_view-label }」: { lv_err }|.
          RETURN.
        ENDIF.
        IF lv_tok = abap_false.
          REPLACE ALL OCCURRENCES OF '-' IN lv_item WITH ''.
          IF lv_item IS NOT INITIAL AND ( strlen( lv_item ) <> 8 OR lv_item CN '0123456789' ).
            ev_error = |「{ ls_view-label }」的日期格式不对: { ls_new-value }|.
            RETURN.
          ENDIF.
        ELSE.
          lv_item = to_upper( lv_item ).
        ENDIF.
        APPEND lv_item TO lt_out.
      ENDLOOP.
      <ls_b>-value = concat_lines_of( table = lt_out sep = `,` ).
    ENDLOOP.
    ev_json = flat_json( lt_base ).

  ENDMETHOD.


  METHOD parse_triggers.

    DATA: ls_t   TYPE ty_trig,
          lv_tm  TYPE string,
          lv_s   TYPE string.
    CLEAR: et_trig, ev_error.
    DATA(lv_min) = cfg_int( iv_key = 'SCHED_MIN_HOURS' iv_default = 1 iv_min = 1 iv_max = 24 ).
    DATA(lt_k) = io_json->kids( iv_node ).
    IF lt_k IS INITIAL.
      ev_error = '至少要有一个触发时间'.
      RETURN.
    ENDIF.
    IF lines( lt_k ) > 3.
      ev_error = '触发最多 3 个'.
      RETURN.
    ENDIF.
    LOOP AT lt_k INTO DATA(lv_n).
      CLEAR ls_t.
      ls_t-trig_no = sy-tabix.
      ls_t-freq = to_upper( condense( io_json->text( io_json->child( iv_id = lv_n iv_name = 'freq' ) ) ) ).
      lv_tm = io_json->text( io_json->child( iv_id = lv_n iv_name = 'time' ) ).
      REPLACE ALL OCCURRENCES OF ':' IN lv_tm WITH ''.
      CONDENSE lv_tm NO-GAPS.
      IF strlen( lv_tm ) = 3.
        lv_tm = |0{ lv_tm }|.
      ENDIF.
      DATA(lv_tm_ok) = xsdbool( strlen( lv_tm ) = 4 ).
      IF lv_tm_ok = abap_true.
        lv_tm_ok = xsdbool( lv_tm CO '0123456789' ).
      ENDIF.
      IF lv_tm_ok = abap_true.
        lv_tm_ok = xsdbool( CONV i( lv_tm(2) ) <= 23 AND CONV i( lv_tm+2(2) ) <= 59 ).
      ENDIF.
      IF lv_tm_ok = abap_false.
        ev_error = |第 { ls_t-trig_no } 个触发的时间不对, 请写成 09:00 这样|.
        RETURN.
      ENDIF.
      ls_t-run_time = lv_tm.
      CASE ls_t-freq.
        WHEN 'DAILY'.
        WHEN 'WEEKLY'.
          lv_s = io_json->text( io_json->child( iv_id = lv_n iv_name = 'weekdays' ) ).
          ls_t-weekdays = to_upper( lv_s ).
          IF ls_t-weekdays NA 'X'.
            ev_error = |第 { ls_t-trig_no } 个触发(每周)至少勾一天|.
            RETURN.
          ENDIF.
        WHEN 'MONTHLY'.
          lv_s = io_json->text( io_json->child( iv_id = lv_n iv_name = 'monthDay' ) ).
          CONDENSE lv_s NO-GAPS.
          IF lv_s IS INITIAL OR lv_s CN '0123456789'.
            ev_error = |第 { ls_t-trig_no } 个触发(每月)要选几号|.
            RETURN.
          ENDIF.
          ls_t-month_day = lv_s.
          IF NOT ( ls_t-month_day BETWEEN 1 AND 31 OR ls_t-month_day = 99 ).
            ev_error = |第 { ls_t-trig_no } 个触发(每月)的日期只能是 1-31 或最后一天|.
            RETURN.
          ENDIF.
        WHEN 'HOURLY'.
          lv_s = io_json->text( io_json->child( iv_id = lv_n iv_name = 'everyHours' ) ).
          CONDENSE lv_s NO-GAPS.
          IF lv_s IS INITIAL OR lv_s CN '0123456789'.
            ev_error = |第 { ls_t-trig_no } 个触发要写每几小时|.
            RETURN.
          ENDIF.
          ls_t-every_hours = lv_s.
          IF ls_t-every_hours < lv_min OR ls_t-every_hours > 24.
            ev_error = |每 N 小时的 N 只能是 { lv_min }-24|.
            RETURN.
          ENDIF.
        WHEN OTHERS.
          ev_error = |不认识的频率 { ls_t-freq }(只支持 DAILY / WEEKLY / MONTHLY / HOURLY)|.
          RETURN.
      ENDCASE.
      APPEND ls_t TO et_trig.
    ENDLOOP.

  ENDMETHOD.


  METHOD db_trigs.
    DATA lv_id TYPE zai_sched_trig-sched_id.
    lv_id = iv_sched_id.
    SELECT * FROM zai_sched_trig WHERE sched_id = @lv_id ORDER BY trig_no INTO TABLE @rt.
  ENDMETHOD.


  METHOD trig_of_db.
    rs-trig_no     = is_db-trig_no.
    rs-freq        = is_db-freq.
    rs-run_time    = is_db-run_time.
    IF strlen( rs-run_time ) > 4.
      rs-run_time = rs-run_time(4).
    ENDIF.
    rs-weekdays    = is_db-weekdays.
    rs-month_day   = is_db-month_day.
    rs-every_hours = is_db-every_hours.
    rs-text        = trig_text( rs ).
  ENDMETHOD.


  METHOD to_view.

    DATA ls_t TYPE ty_trig.
    rs-sched_id     = is_db-sched_id.
    rs-owner        = is_db-owner.
    rs-name         = is_db-name_text.
    rs-instruction  = is_db-instruction.
    rs-scene        = is_db-scene.
    rs-model_id     = is_db-model_id.
    rs-src_type     = is_db-src_type.
    rs-report_id    = is_db-report_id.
    rs-params_json  = is_db-params_json.
    rs-status       = is_db-status.
    rs-stop_note    = is_db-stop_note.
    rs-session_id   = is_db-session_id.
    rs-last_run_at  = is_db-last_run_at.
    rs-last_run_sts = is_db-last_run_sts.
    rs-last_seen_at = is_db-last_seen_at.
    rs-created_at   = is_db-created_at.
    rs-changed_at   = is_db-changed_at.
    rs-unread       = xsdbool( is_db-last_run_at IS NOT INITIAL AND is_db-last_run_at > is_db-last_seen_at ).
    DATA(lt_dbt) = db_trigs( CONV string( is_db-sched_id ) ).
    LOOP AT lt_dbt INTO DATA(ls_db).
      ls_t = trig_of_db( ls_db ).
      IF is_db-status = 'ACTIVE'.
        ls_t-next_run = next_run( is_trig = ls_t iv_date = sy-datum iv_time = sy-uzeit ).
        IF ls_t-next_run IS NOT INITIAL AND ( rs-next_run IS INITIAL OR ls_t-next_run < rs-next_run ).
          rs-next_run = ls_t-next_run.
        ENDIF.
      ENDIF.
      APPEND ls_t TO rs-triggers.
    ENDLOOP.
    IF rs-src_type IS NOT INITIAL.
      IF iv_detail = abap_true.
        param_views( EXPORTING iv_src_type    = rs-src_type
                               iv_report_id   = rs-report_id
                               iv_params_json = rs-params_json
                     IMPORTING et_views       = rs-params
                               ev_report_name = rs-report_name ).
      ELSE.
        rs-report_name = rs-report_id.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD create_job.

    DATA: lv_name  TYPE tbtcjob-jobname,
          lv_cnt   TYPE tbtcjob-jobcount,
          lv_prog  TYPE progname,
          lv_sid   TYPE c LENGTH 32,
          lv_tno   TYPE c LENGTH 1,
          lv_d     TYPE d,
          lv_t     TYPE t,
          lv_days  TYPE tbtcjob-prddays,
          lv_hours TYPE tbtcjob-prdhours,
          lv_rel   TYPE c LENGTH 1,
          lv_rc    TYPE i.
    CLEAR: ev_jobname, ev_jobcount, ev_error.
    lv_sid  = iv_sched_id.
    lv_tno  = COND #( WHEN iv_now = abap_true THEN '0' ELSE |{ is_trig-trig_no }| ).
    lv_name = |ZAI_SCHED_{ iv_sched_id(8) }_{ lv_tno }|.
    lv_prog = 'ZAI_SCHED_RUNNER'.

    CALL FUNCTION 'JOB_OPEN'
      EXPORTING
        jobname          = lv_name
      IMPORTING
        jobcount         = lv_cnt
      EXCEPTIONS
        cant_create_job  = 1
        invalid_job_data = 2
        jobname_missing  = 3
        OTHERS           = 4.
    IF sy-subrc <> 0.
      ev_error = |建后台作业失败(JOB_OPEN subrc={ sy-subrc })|.
      RETURN.
    ENDIF.

    SUBMIT (lv_prog)
      WITH p_sched = lv_sid
      WITH p_trig  = lv_tno
      VIA JOB lv_name NUMBER lv_cnt
      AND RETURN.
    IF sy-subrc <> 0.
      lv_rc = sy-subrc.
      CALL FUNCTION 'BP_JOB_DELETE'
        EXPORTING jobcount = lv_cnt jobname = lv_name
        EXCEPTIONS OTHERS = 1.
      ev_error = |作业步骤 ZAI_SCHED_RUNNER 提交失败(subrc={ lv_rc }); 请确认 SE38 已建好该程序|.
      RETURN.
    ENDIF.

    IF iv_now = abap_true.
      CALL FUNCTION 'JOB_CLOSE'
        EXPORTING
          jobcount             = lv_cnt
          jobname              = lv_name
          strtimmed            = 'X'
        IMPORTING
          job_was_released     = lv_rel
        EXCEPTIONS
          cant_start_immediate = 1
          OTHERS               = 9.
      lv_rc = sy-subrc.
      IF lv_rc = 1.
        " 没有空闲后台进程: 按"现在"释放, 调度器下一个周期拾取
        lv_d = sy-datum.
        lv_t = sy-uzeit.
        CALL FUNCTION 'JOB_CLOSE'
          EXPORTING
            jobcount         = lv_cnt
            jobname          = lv_name
            sdlstrtdt        = lv_d
            sdlstrttm        = lv_t
          IMPORTING
            job_was_released = lv_rel
          EXCEPTIONS
            OTHERS           = 9.
        lv_rc = sy-subrc.
      ENDIF.
    ELSE.
      " 首次开始时间: 每 N 小时 = 下一个整点周期; 其余 = 下一个设定时间点(作业每天跑, 程序判断当天该不该跑)
      DATA(ls_daily) = is_trig.
      IF ls_daily-freq <> 'HOURLY'.
        ls_daily-freq = 'DAILY'.
      ENDIF.
      DATA(lv_next) = next_run( is_trig = ls_daily iv_date = sy-datum iv_time = sy-uzeit ).
      IF strlen( lv_next ) < 14.
        ev_error = '算不出首次运行时间'.
        RETURN.
      ENDIF.
      lv_d = lv_next(8).
      lv_t = lv_next+8(6).
      IF is_trig-freq = 'HOURLY'.
        lv_hours = is_trig-every_hours.
      ELSE.
        lv_days = 1.
      ENDIF.
      CALL FUNCTION 'JOB_CLOSE'
        EXPORTING
          jobcount          = lv_cnt
          jobname           = lv_name
          sdlstrtdt         = lv_d
          sdlstrttm         = lv_t
          prddays           = lv_days
          prdhours          = lv_hours
        IMPORTING
          job_was_released  = lv_rel
        EXCEPTIONS
          invalid_startdate = 2
          jobname_missing   = 3
          job_close_failed  = 4
          job_nosteps       = 5
          job_notex         = 6
          lock_failed       = 7
          OTHERS            = 9.
      lv_rc = sy-subrc.
    ENDIF.

    IF lv_rc <> 0 OR lv_rel <> 'X'.
      CALL FUNCTION 'BP_JOB_DELETE'
        EXPORTING jobcount = lv_cnt jobname = lv_name
        EXCEPTIONS OTHERS = 1.
      ev_error = COND #( WHEN lv_rc <> 0 THEN |释放后台作业失败(JOB_CLOSE subrc={ lv_rc })|
                         ELSE '你没有释放后台作业的权限(S_BTCH_JOB RELE), 请联系管理员' ).
      RETURN.
    ENDIF.
    ev_jobname  = lv_name.
    ev_jobcount = lv_cnt.

  ENDMETHOD.


  METHOD create_jobs.

    DATA: lv_jn  TYPE string,
          lv_jc  TYPE string,
          lv_err TYPE string.
    CLEAR ev_error.
    DATA(lt_db) = db_trigs( iv_sched_id ).
    LOOP AT lt_db ASSIGNING FIELD-SYMBOL(<ls_db>).
      create_job( EXPORTING iv_sched_id = iv_sched_id is_trig = trig_of_db( <ls_db> )
                  IMPORTING ev_jobname = lv_jn ev_jobcount = lv_jc ev_error = lv_err ).
      IF lv_err IS NOT INITIAL.
        ev_error = lv_err.
        drop_jobs( iv_sched_id ).
        RETURN.
      ENDIF.
      <ls_db>-jobname  = lv_jn.
      <ls_db>-jobcount = lv_jc.
      UPDATE zai_sched_trig FROM @<ls_db>.
    ENDLOOP.

  ENDMETHOD.


  METHOD drop_jobs.

    DATA(lt_db) = db_trigs( iv_sched_id ).
    LOOP AT lt_db ASSIGNING FIELD-SYMBOL(<ls_db>) WHERE jobname IS NOT INITIAL.
      CALL FUNCTION 'BP_JOB_DELETE'
        EXPORTING
          jobcount = <ls_db>-jobcount
          jobname  = <ls_db>-jobname
        EXCEPTIONS
          OTHERS   = 1.
      " 删不掉(已被手工删 / 正在运行)不影响: 运行程序会按状态判断
      CLEAR: <ls_db>-jobname, <ls_db>-jobcount.
      UPDATE zai_sched_trig FROM @<ls_db>.
    ENDLOOP.

  ENDMETHOD.


  METHOD save_sched.

    DATA: lo        TYPE REF TO zcl_ai_odata_shaper,
          lt_trig   TYPE tt_trig,
          lv_err    TYPE string,
          ls_db     TYPE zai_schedule,
          ls_old    TYPE zai_schedule,
          lv_id     TYPE zai_schedule-sched_id,
          lv_src    TYPE string,
          lv_rid    TYPE string,
          lv_base   TYPE string,
          lv_merged TYPE string,
          lt_views  TYPE tt_pview,
          lv_rname  TYPE string,
          lt_dbt    TYPE tt_db_trig,
          lv_new    TYPE abap_bool.
    CLEAR rs.
    rs-is_admin = zcl_ai_access=>is_admin( ).
    IF user_ok( ) = abap_false.
      rs-error = '你还没有被赋予此功能的使用权限，请联系管理员'.
      RETURN.
    ENDIF.
    IF enabled( ) = abap_false.
      rs-error = '定时任务功能未开启(SCHED_ENABLED)，请联系管理员'.
      RETURN.
    ENDIF.

    CREATE OBJECT lo.
    IF lo->parse( iv_json ) = abap_false.
      rs-error = |定时任务内容格式不正确: { lo->get_error( ) }|.
      RETURN.
    ENDIF.
    DATA(lv_root) = lo->root( ).
    DATA(lv_sid)   = to_upper( condense( lo->text( lo->child( iv_id = lv_root iv_name = 'schedId' ) ) ) ).
    DATA(lv_name)  = condense( lo->text( lo->child( iv_id = lv_root iv_name = 'name' ) ) ).
    DATA(lv_instr) = lo->text( lo->child( iv_id = lv_root iv_name = 'instruction' ) ).
    DATA(lv_scene) = to_upper( condense( lo->text( lo->child( iv_id = lv_root iv_name = 'scene' ) ) ) ).
    DATA(lv_model) = to_upper( condense( lo->text( lo->child( iv_id = lv_root iv_name = 'modelId' ) ) ) ).
    DATA(lv_from)  = to_upper( condense( lo->text( lo->child( iv_id = lv_root iv_name = 'fromArtifactId' ) ) ) ).
    DATA(lv_pnode) = lo->child( iv_id = lv_root iv_name = 'params' ).
    DATA(lv_pjson) = COND string( WHEN lv_pnode > 0 THEN lo->to_json( lv_pnode ) ELSE `{}` ).
    lv_instr = condense( lv_instr ).

    " ---- 基本校验 ----
    IF lv_name IS INITIAL.
      rs-error = '请填写名称'.
      RETURN.
    ENDIF.
    IF strlen( lv_name ) > 80.
      rs-error = '名称最多 80 字'.
      RETURN.
    ENDIF.
    IF strlen( lv_instr ) > 4000.
      rs-error = '指令最多 4000 字'.
      RETURN.
    ENDIF.
    IF strlen( lv_model ) > 30.
      rs-error = '模型编号不对'.
      RETURN.
    ENDIF.
    parse_triggers( EXPORTING io_json = lo iv_node = lo->child( iv_id = lv_root iv_name = 'triggers' )
                    IMPORTING et_trig = lt_trig ev_error = lv_err ).
    IF lv_err IS NOT INITIAL.
      rs-error = lv_err.
      RETURN.
    ENDIF.

    " ---- 新建 / 修改 ----
    IF lv_sid IS INITIAL.
      lv_new = abap_true.
      SELECT COUNT(*) FROM zai_schedule WHERE owner = @sy-uname.
      IF sy-dbcnt >= cfg_int( iv_key = 'SCHED_MAX_PER_USER' iv_default = 10 iv_min = 1 iv_max = 100 ).
        rs-error = |每人最多 { cfg_int( iv_key = 'SCHED_MAX_PER_USER' iv_default = 10 iv_min = 1 iv_max = 100 ) } 个定时任务, 先删掉不用的|.
        RETURN.
      ENDIF.
      IF lv_from IS NOT INITIAL.
        source_of_artifact( EXPORTING iv_artifact_id = lv_from
                            IMPORTING ev_src_type = lv_src ev_report_id = lv_rid
                                      ev_params_json = lv_base ev_error = lv_err ).
        IF lv_err IS NOT INITIAL.
          rs-error = lv_err.
          RETURN.
        ENDIF.
      ENDIF.
    ELSE.
      lv_id = lv_sid.
      SELECT SINGLE * FROM zai_schedule WHERE sched_id = @lv_id INTO @ls_old.
      IF sy-subrc <> 0 OR ls_old-owner <> sy-uname.
        rs-error = '定时任务不存在或不属于你'.
        RETURN.
      ENDIF.
      IF ls_old-status = 'ADMIN_STOP'.
        rs-error = '这个定时任务已被管理员停用, 不能修改'.
        IF ls_old-stop_note IS NOT INITIAL.
          rs-error = |{ rs-error }(原因: { ls_old-stop_note })|.
        ENDIF.
        RETURN.
      ENDIF.
      lv_src  = ls_old-src_type.
      lv_rid  = ls_old-report_id.
      lv_base = ls_old-params_json.
    ENDIF.

    IF lv_instr IS INITIAL AND lv_src IS INITIAL.
      rs-error = '指令和数据来源至少要有一个'.
      RETURN.
    ENDIF.

    " ---- 场景: 有数据来源时跟随来源; 否则 自动 / 数据分析 / 代码分析 ----
    IF lv_src IS NOT INITIAL.
      lv_scene = lv_src.
    ELSEIF lv_scene IS INITIAL OR lv_scene = 'GENERAL'.
      lv_scene = 'AUTO'.
    ENDIF.
    IF lv_src IS INITIAL AND lv_scene <> 'AUTO' AND lv_scene <> 'DATA' AND lv_scene <> 'CODE'.
      rs-error = '没有数据来源时, 场景只能选 自动 / 数据分析 / 代码分析; 要定时跑报表请在结果卡上点「设为定时」'.
      RETURN.
    ENDIF.
    IF zcl_ai_access=>scene_ok( lv_scene ) = abap_false.
      rs-error = zcl_ai_access=>scene_deny_text( lv_scene ).
      RETURN.
    ENDIF.

    " ---- 数据来源: 授权 + 参数(只能改日期) + 用今天换算后预校验 ----
    IF lv_src IS NOT INITIAL.
      IF zcl_ai_access=>report_ok( iv_src_type = lv_src iv_report_id = lv_rid ) = abap_false.
        rs-error = zcl_ai_access=>report_deny_text( lv_rid ).
        RETURN.
      ENDIF.
      IF zcl_ai_task_service=>task_enabled( ) = abap_false.
        rs-error = '定时跑报表需要先开启任务上下文能力(TASK_CONTEXT_ENABLED), 请联系管理员'.
        RETURN.
      ENDIF.
      param_views( EXPORTING iv_src_type = lv_src iv_report_id = lv_rid iv_params_json = lv_base
                   IMPORTING et_views = lt_views ev_report_name = lv_rname ).
      merge_dates( EXPORTING iv_base_json = lv_base iv_new_json = lv_pjson it_views = lt_views
                   IMPORTING ev_json = lv_merged ev_error = lv_err ).
      IF lv_err IS NOT INITIAL.
        rs-error = lv_err.
        RETURN.
      ENDIF.
      IF lv_src = 'REPORT'.
        DATA(ls_def) = zcl_ai_report_service=>get_def( lv_rid ).
        IF ls_def-report_id IS INITIAL OR ls_def-exec_enabled = abap_false.
          rs-error = |报表 { lv_rid } 未登记、已停用或未开放执行|.
          RETURN.
        ENDIF.
        DATA(ls_pv) = zcl_ai_report_service=>validate_params(
                        is_def = ls_def iv_params_json = resolve_params( iv_json = lv_merged iv_date = sy-datum ) ).
        IF ls_pv-ok = abap_false.
          READ TABLE ls_pv-errors INTO DATA(ls_pe) INDEX 1.
          rs-error = |参数校验没通过: { ls_pe-param_id } { ls_pe-message }|.
          RETURN.
        ENDIF.
      ENDIF.
    ENDIF.

    " ---- 落库 ----
    IF lv_new = abap_true.
      lv_id = guid( ).
      CLEAR ls_db.
      ls_db-sched_id   = lv_id.
      ls_db-owner      = sy-uname.
      ls_db-src_type   = lv_src.
      ls_db-report_id  = lv_rid.
      ls_db-status     = 'ACTIVE'.
      ls_db-created_at = now14( ).
      " 专属会话 + 任务
      ls_db-session_id = guid( ).
      INSERT zai_chat_sess FROM @( VALUE #( mandt        = sy-mandt
                                            session_id   = ls_db-session_id
                                            title        = |定时：{ lv_name }|
                                            model_id     = lv_model
                                            msg_count    = 0
                                            session_mode = 'AGENT'
                                            agent_type   = COND #( WHEN lv_scene = 'AUTO' THEN 'GENERAL' ELSE lv_scene )
                                            status       = 'COMPLETED'
                                            created_by   = sy-uname
                                            created_at   = now14( )
                                            changed_at   = now14( ) ) ).
      IF lv_src IS NOT INITIAL.
        DATA(ls_pick) = zcl_ai_task_service=>pick_or_create(
                          iv_session_id = CONV string( ls_db-session_id )
                          iv_task_id    = ''
                          iv_module_id  = COND #( WHEN lv_src = 'FIORI' THEN zcl_ai_fiori_report_service=>gc_module
                                                  ELSE zcl_ai_task_service=>gc_mod_report )
                          iv_intent     = COND #( WHEN lv_src = 'FIORI' THEN zcl_ai_fiori_report_service=>gc_intent
                                                  ELSE zcl_ai_intent_router=>gc_int_run_analyze )
                          iv_title      = |定时：{ lv_name }| ).
        IF ls_pick-task_id IS INITIAL.
          ROLLBACK WORK.
          rs-error = COND #( WHEN ls_pick-reason IS NOT INITIAL THEN ls_pick-reason ELSE '建专属任务失败' ).
          RETURN.
        ENDIF.
        ls_db-task_id = ls_pick-task_id.
      ENDIF.
    ELSE.
      ls_db = ls_old.
      drop_jobs( CONV string( lv_id ) ).
      DATA lv_title TYPE zai_chat_sess-title.
      lv_title = |定时：{ lv_name }|.
      UPDATE zai_chat_sess SET title = @lv_title WHERE session_id = @ls_db-session_id.
    ENDIF.
    ls_db-name_text   = lv_name.
    ls_db-instruction = lv_instr.
    ls_db-scene       = lv_scene.
    ls_db-model_id    = lv_model.
    ls_db-params_json = lv_merged.
    ls_db-changed_at  = now14( ).
    MODIFY zai_schedule FROM @ls_db.

    DELETE FROM zai_sched_trig WHERE sched_id = @lv_id.
    CLEAR lt_dbt.
    LOOP AT lt_trig INTO DATA(ls_t).
      APPEND VALUE #( mandt       = sy-mandt
                      sched_id    = lv_id
                      trig_no     = ls_t-trig_no
                      freq        = ls_t-freq
                      run_time    = |{ ls_t-run_time }00|
                      weekdays    = ls_t-weekdays
                      month_day   = ls_t-month_day
                      every_hours = ls_t-every_hours ) TO lt_dbt.
    ENDLOOP.
    INSERT zai_sched_trig FROM TABLE @lt_dbt.
    COMMIT WORK.

    " ---- 作业(暂停中的不建) ----
    IF ls_db-status = 'ACTIVE'.
      create_jobs( EXPORTING iv_sched_id = CONV string( lv_id ) IMPORTING ev_error = lv_err ).
      IF lv_err IS NOT INITIAL.
        IF lv_new = abap_true.
          DELETE FROM zai_sched_trig WHERE sched_id = @lv_id.
          DELETE FROM zai_schedule WHERE sched_id = @lv_id.
        ELSE.
          DATA lv_jnote TYPE zai_schedule-stop_note.
          lv_jnote = lv_err.
          UPDATE zai_schedule SET status = 'JOB_ERROR', stop_note = @lv_jnote WHERE sched_id = @lv_id.
        ENDIF.
        COMMIT WORK.
        rs-error = lv_err.
        RETURN.
      ENDIF.
      COMMIT WORK.
    ENDIF.

    SELECT SINGLE * FROM zai_schedule WHERE sched_id = @lv_id INTO @ls_db.
    rs-item    = to_view( is_db = ls_db iv_detail = abap_true ).
    rs-message = COND #( WHEN lv_new = abap_true THEN '定时任务已创建' ELSE '定时任务已保存' ).

  ENDMETHOD.


  METHOD get_list.

    DATA lt_db TYPE STANDARD TABLE OF zai_schedule WITH DEFAULT KEY.
    CLEAR rs.
    rs-is_admin = zcl_ai_access=>is_admin( ).
    IF user_ok( ) = abap_false.
      rs-error = '你还没有被赋予此功能的使用权限，请联系管理员'.
      RETURN.
    ENDIF.
    IF enabled( ) = abap_false.
      rs-message = '定时任务功能未开启(SCHED_ENABLED)'.
      RETURN.
    ENDIF.
    IF to_upper( iv_scope ) = 'ALL'.
      IF rs-is_admin = abap_false.
        rs-error = '只有管理员能查看全部用户的定时任务'.
        RETURN.
      ENDIF.
      SELECT * FROM zai_schedule ORDER BY owner, created_at INTO TABLE @lt_db.
    ELSE.
      SELECT * FROM zai_schedule WHERE owner = @sy-uname ORDER BY created_at INTO TABLE @lt_db.
    ENDIF.
    LOOP AT lt_db INTO DATA(ls_db).
      APPEND to_view( is_db = ls_db iv_detail = abap_true ) TO rs-items.
    ENDLOOP.

  ENDMETHOD.


  METHOD do_action.

    DATA: ls_db  TYPE zai_schedule,
          lv_id  TYPE zai_schedule-sched_id,
          lv_err TYPE string,
          lv_jn  TYPE string,
          lv_jc  TYPE string,
          lv_src TYPE string,
          lv_rid TYPE string,
          lv_pj  TYPE string,
          lv_now TYPE zai_schedule-changed_at,
          lv_snt TYPE zai_schedule-stop_note.
    CLEAR rs.
    lv_now = now14( ).
    lv_snt = iv_note.
    rs-is_admin = zcl_ai_access=>is_admin( ).
    IF user_ok( ) = abap_false.
      rs-error = '你还没有被赋予此功能的使用权限，请联系管理员'.
      RETURN.
    ENDIF.
    DATA(lv_act) = to_upper( condense( iv_action ) ).

    " ---- 设为定时: 从结果号带出数据来源和参数(不落库) ----
    IF lv_act = 'PREFILL'.
      IF enabled( ) = abap_false.
        rs-error = '定时任务功能未开启(SCHED_ENABLED)，请联系管理员'.
        RETURN.
      ENDIF.
      source_of_artifact( EXPORTING iv_artifact_id = iv_note
                          IMPORTING ev_src_type = lv_src ev_report_id = lv_rid
                                    ev_params_json = lv_pj ev_error = lv_err ).
      IF lv_err IS NOT INITIAL.
        rs-error = lv_err.
        RETURN.
      ENDIF.
      rs-item-src_type      = lv_src.
      rs-item-report_id     = lv_rid.
      rs-item-scene         = lv_src.
      rs-item-params_json   = lv_pj.
      rs-item-from_artifact = to_upper( condense( iv_note ) ).
      param_views( EXPORTING iv_src_type = lv_src iv_report_id = lv_rid iv_params_json = lv_pj
                   IMPORTING et_views = rs-item-params ev_report_name = rs-item-report_name ).
      rs-item-name = |{ rs-item-report_name } · 每天 09:00|.
      RETURN.
    ENDIF.

    lv_id = to_upper( condense( iv_sched_id ) ).
    SELECT SINGLE * FROM zai_schedule WHERE sched_id = @lv_id INTO @ls_db.
    IF sy-subrc <> 0.
      rs-error = '定时任务不存在'.
      RETURN.
    ENDIF.
    IF lv_act = 'ADMIN_STOP' OR lv_act = 'ADMIN_RESUME'.
      IF rs-is_admin = abap_false.
        rs-error = '只有管理员能停用 / 恢复别人的定时任务'.
        RETURN.
      ENDIF.
    ELSEIF ls_db-owner <> sy-uname.
      rs-error = '定时任务不属于你'.
      RETURN.
    ENDIF.

    CASE lv_act.
      WHEN 'PAUSE'.
        drop_jobs( CONV string( lv_id ) ).
        UPDATE zai_schedule SET status = 'PAUSED', changed_at = @lv_now WHERE sched_id = @lv_id.
        rs-message = '已暂停'.
      WHEN 'RESUME'.
        IF ls_db-status = 'ADMIN_STOP'.
          rs-error = '这个定时任务已被管理员停用, 请联系管理员恢复'.
          RETURN.
        ENDIF.
        IF enabled( ) = abap_false.
          rs-error = '定时任务功能未开启(SCHED_ENABLED)'.
          RETURN.
        ENDIF.
        drop_jobs( CONV string( lv_id ) ).
        create_jobs( EXPORTING iv_sched_id = CONV string( lv_id ) IMPORTING ev_error = lv_err ).
        IF lv_err IS NOT INITIAL.
          lv_snt = lv_err.
          UPDATE zai_schedule SET status = 'JOB_ERROR', stop_note = @lv_snt WHERE sched_id = @lv_id.
          COMMIT WORK.
          rs-error = lv_err.
          RETURN.
        ENDIF.
        UPDATE zai_schedule SET status = 'ACTIVE', stop_note = ' ', changed_at = @lv_now WHERE sched_id = @lv_id.
        rs-message = '已恢复'.
      WHEN 'DELETE'.
        drop_jobs( CONV string( lv_id ) ).
        DELETE FROM zai_sched_trig WHERE sched_id = @lv_id.
        DELETE FROM zai_sched_run WHERE sched_id = @lv_id.
        DELETE FROM zai_schedule WHERE sched_id = @lv_id.
        COMMIT WORK.
        rs-message = '已删除(专属会话和已有结果保留)'.
        RETURN.
      WHEN 'RUNNOW'.
        IF ls_db-status = 'ADMIN_STOP'.
          rs-error = '这个定时任务已被管理员停用'.
          RETURN.
        ENDIF.
        IF enabled( ) = abap_false.
          rs-error = '定时任务功能未开启(SCHED_ENABLED)'.
          RETURN.
        ENDIF.
        create_job( EXPORTING iv_sched_id = CONV string( lv_id ) is_trig = VALUE #( ) iv_now = abap_true
                    IMPORTING ev_jobname = lv_jn ev_jobcount = lv_jc ev_error = lv_err ).
        IF lv_err IS NOT INITIAL.
          rs-error = lv_err.
          RETURN.
        ENDIF.
        rs-message = '已开始运行, 完成后结果会出现在专属会话里'.
      WHEN 'SEEN'.
        UPDATE zai_schedule SET last_seen_at = @lv_now WHERE sched_id = @lv_id.
        rs-message = 'OK'.
      WHEN 'ADMIN_STOP'.
        UPDATE zai_schedule SET status = 'ADMIN_STOP', stop_note = @lv_snt,
                                changed_at = @lv_now WHERE sched_id = @lv_id.
        rs-message = '已停用(作业到点会直接结束)'.
      WHEN 'ADMIN_RESUME'.
        " 管理员停用时没删作业, 恢复只改状态; 作业若已不在, 主人点「恢复」会重建
        UPDATE zai_schedule SET status = 'ACTIVE', stop_note = ' ', changed_at = @lv_now WHERE sched_id = @lv_id.
        rs-message = '已恢复'.
      WHEN OTHERS.
        rs-error = |不认识的操作 { iv_action }|.
        RETURN.
    ENDCASE.
    COMMIT WORK.
    SELECT SINGLE * FROM zai_schedule WHERE sched_id = @lv_id INTO @ls_db.
    rs-item = to_view( is_db = ls_db iv_detail = abap_true ).

  ENDMETHOD.


  METHOD get_runs.

    DATA: lv_id  TYPE zai_schedule-sched_id,
          lt_run TYPE STANDARD TABLE OF zai_sched_run WITH DEFAULT KEY.
    CLEAR rs.
    rs-is_admin = zcl_ai_access=>is_admin( ).
    lv_id = to_upper( condense( iv_sched_id ) ).
    SELECT SINGLE owner FROM zai_schedule WHERE sched_id = @lv_id INTO @DATA(lv_owner).
    IF sy-subrc <> 0 OR ( lv_owner <> sy-uname AND rs-is_admin = abap_false ).
      rs-error = '定时任务不存在或不属于你'.
      RETURN.
    ENDIF.
    SELECT * FROM zai_sched_run WHERE sched_id = @lv_id
      ORDER BY started_at DESCENDING INTO TABLE @lt_run UP TO 50 ROWS.
    LOOP AT lt_run INTO DATA(ls_r).
      APPEND VALUE #( started_at    = ls_r-started_at
                      trig_no       = ls_r-trig_no
                      status        = ls_r-status
                      params_used   = ls_r-params_used
                      report_run_id = ls_r-report_run_id
                      artifact_id   = ls_r-artifact_id
                      row_count     = ls_r-row_count
                      elapsed_ms    = ls_r-elapsed_ms
                      message       = ls_r-message ) TO rs-runs.
    ENDLOOP.

  ENDMETHOD.


  METHOD write_msg.

    DATA: ls_msg TYPE zai_chat_msg,
          lv_sid TYPE zai_chat_msg-session_id.
    lv_sid = iv_session_id.
    SELECT MAX( msg_seq ) FROM zai_chat_msg WHERE session_id = @lv_sid INTO @DATA(lv_max).
    CLEAR ls_msg.
    ls_msg-mandt        = sy-mandt.
    ls_msg-session_id   = lv_sid.
    ls_msg-msg_seq      = lv_max + 1.
    ls_msg-role         = 'assistant'.
    ls_msg-content      = iv_text.
    ls_msg-program_name = 'SCHED'.
    ls_msg-status       = 'OK'.
    ls_msg-created_at   = now14( ).
    ls_msg-created_by   = sy-uname.
    INSERT zai_chat_msg FROM @ls_msg.
    DATA lv_chg TYPE zai_chat_sess-changed_at.
    lv_chg = now14( ).
    UPDATE zai_chat_sess SET msg_count = msg_count + 1, changed_at = @lv_chg
      WHERE session_id = @lv_sid.

  ENDMETHOD.


  METHOD log_run.

    DATA lt_old TYPE STANDARD TABLE OF zai_sched_run WITH DEFAULT KEY.
    INSERT zai_sched_run FROM @( VALUE #( mandt         = sy-mandt
                                          sched_id      = is_db-sched_id
                                          started_at    = is_run-started_at
                                          trig_no       = is_run-trig_no
                                          status        = is_run-status
                                          params_used   = is_run-params_used
                                          report_run_id = is_run-report_run_id
                                          artifact_id   = is_run-artifact_id
                                          row_count     = is_run-row_count
                                          elapsed_ms    = is_run-elapsed_ms
                                          message       = is_run-message ) ).
    " 只留最近 N 条
    DATA(lv_keep) = cfg_int( iv_key = 'SCHED_KEEP_RUNS' iv_default = 30 iv_min = 5 iv_max = 500 ).
    SELECT * FROM zai_sched_run WHERE sched_id = @is_db-sched_id
      ORDER BY started_at DESCENDING INTO TABLE @lt_old.
    IF lines( lt_old ) > lv_keep.
      DELETE lt_old FROM 1 TO lv_keep.
      DELETE zai_sched_run FROM TABLE @lt_old.
    ENDIF.

  ENDMETHOD.


  METHOD run_one.

    DATA: ls_db     TYPE zai_schedule,
          lv_id     TYPE zai_schedule-sched_id,
          ls_run    TYPE ty_run,
          ls_trig   TYPE ty_trig,
          lv_art    TYPE string,
          lv_rows   TYPE i,
          lv_src_ok TYPE abap_bool,
          lv_text   TYPE string,
          lv_rname  TYPE string,
          lt_views  TYPE tt_pview,
          ls_agent  TYPE zcl_ai_agent_service=>ty_agent_result.

    lv_id = to_upper( condense( iv_sched_id ) ).
    SELECT SINGLE * FROM zai_schedule WHERE sched_id = @lv_id INTO @ls_db.
    " 作业以创建人身份运行; 不是本人的(作业被改过用户)不跑
    IF sy-subrc <> 0 OR ls_db-owner <> sy-uname OR enabled( ) = abap_false.
      RETURN.
    ENDIF.
    IF ls_db-status = 'ADMIN_STOP' OR ( iv_trig_no > 0 AND ls_db-status <> 'ACTIVE' ).
      RETURN.
    ENDIF.
    IF iv_trig_no > 0.
      DATA(lt_dbt) = db_trigs( CONV string( lv_id ) ).
      LOOP AT lt_dbt INTO DATA(ls_dbt) WHERE trig_no = iv_trig_no.
        ls_trig = trig_of_db( ls_dbt ).
      ENDLOOP.
      IF ls_trig-freq IS INITIAL OR due_on( is_trig = ls_trig iv_date = sy-datum ) = abap_false.
        RETURN.                    " 今天不该跑(星期 / 日期)
      ENDIF.
    ENDIF.

    ls_run-started_at = now14( ).
    ls_run-trig_no    = iv_trig_no.

    " ---- 上一次还没跑完: 跳过 ----
    DATA(lv_wait) = cfg_int( iv_key = 'SCHED_WAIT_MIN' iv_default = 30 iv_min = 5 iv_max = 240 ).
    IF ls_db-running_since IS NOT INITIAL
       AND ts_secs( ls_run-started_at ) - ts_secs( CONV string( ls_db-running_since ) ) < ( lv_wait + 15 ) * 60.
      ls_run-status  = 'SKIPPED'.
      ls_run-message = |上一次运行(开始于 { fmt_time( CONV string( ls_db-running_since ) ) })还没结束, 本次跳过|.
      log_run( is_db = ls_db is_run = ls_run ).
      COMMIT WORK.
      RETURN.
    ENDIF.
    UPDATE zai_schedule SET running_since = @ls_run-started_at WHERE sched_id = @lv_id.
    COMMIT WORK.

    " ---- 场景还开放吗 ----
    IF zcl_ai_access=>scene_ok( CONV string( ls_db-scene ) ) = abap_false.
      ls_run-status  = 'FAILED'.
      ls_run-message = zcl_ai_access=>scene_deny_text( CONV string( ls_db-scene ) ).
    ENDIF.

    " ---- 数据来源 ----
    lv_src_ok = abap_true.
    IF ls_run-status IS INITIAL AND ls_db-src_type IS NOT INITIAL.
      lv_src_ok = abap_false.
      ls_run-params_used = resolve_params( iv_json = CONV string( ls_db-params_json ) iv_date = sy-datum ).
      param_views( EXPORTING iv_src_type = CONV string( ls_db-src_type ) iv_report_id = CONV string( ls_db-report_id )
                             iv_params_json = CONV string( ls_db-params_json )
                   IMPORTING et_views = lt_views ev_report_name = lv_rname ).
      IF ls_db-src_type = 'REPORT'.
        DATA(ls_start) = zcl_ai_report_service=>start_run(
                           iv_task_id     = CONV string( ls_db-task_id )
                           iv_session_id  = CONV string( ls_db-session_id )
                           iv_report_id   = CONV string( ls_db-report_id )
                           iv_params_json = ls_run-params_used
                           iv_request_id  = guid( ) ).
        IF ls_start-rejected = abap_true OR ls_start-report_run_id IS INITIAL.
          ls_run-message = |报表提交被拒绝: { ls_start-message }|.
        ELSE.
          ls_run-report_run_id = ls_start-report_run_id.
          " 等结果: 每 15 秒推进一次状态(就绪时 get_run_status 自动登记结果)
          DATA(lv_deadline) = ts_secs( now14( ) ) + lv_wait * 60.
          DO.
            WAIT UP TO 15 SECONDS.
            DATA(ls_st) = zcl_ai_report_service=>get_run_status( ls_start-report_run_id ).
            IF ls_st-status = zcl_ai_report_service=>gc_run_ready AND ls_st-artifact_id IS NOT INITIAL.
              lv_art    = ls_st-artifact_id.
              lv_rows   = ls_st-row_count.
              lv_src_ok = abap_true.
              EXIT.
            ELSEIF ls_st-status = zcl_ai_report_service=>gc_run_failed
                OR ls_st-status = zcl_ai_report_service=>gc_run_timeout.
              ls_run-message = |报表运行失败: { COND string( WHEN ls_st-error_message IS NOT INITIAL
                                                            THEN ls_st-error_message ELSE ls_st-message ) }|.
              EXIT.
            ENDIF.
            IF ts_secs( now14( ) ) > lv_deadline.
              ls_run-message = |等了 { lv_wait } 分钟报表还没跑完, 本次不再等(作业仍在后台, 稍后可在会话里查看)|.
              EXIT.
            ENDIF.
          ENDDO.
        ENDIF.
      ELSE.
        DATA(ls_fr) = zcl_ai_fiori_report_service=>run(
                        iv_task_id     = CONV string( ls_db-task_id )
                        iv_session_id  = CONV string( ls_db-session_id )
                        iv_report_id   = CONV string( ls_db-report_id )
                        iv_params_json = ls_run-params_used
                        iv_request_id  = guid( ) ).
        IF ls_fr-error IS NOT INITIAL OR ls_fr-artifact_id IS INITIAL.
          ls_run-message = |Fiori 取数失败: { COND string( WHEN ls_fr-error IS NOT INITIAL THEN ls_fr-error ELSE ls_fr-message ) }|.
        ELSE.
          ls_run-report_run_id = ls_fr-run_id.
          lv_art    = ls_fr-artifact_id.
          lv_rows   = ls_fr-row_count.
          lv_src_ok = abap_true.
          " 有指令 = 创建时已同意交给灵犀分析(方案 §4.3); 登记没开放分析的不置
          IF ls_db-instruction IS NOT INITIAL AND ls_fr-analyze_enabled = 'X'.
            DATA lv_frun TYPE zai_frpt_run-run_id.
            lv_frun = ls_fr-run_id.
            UPDATE zai_frpt_run SET analyzed = 'X' WHERE run_id = @lv_frun.
            COMMIT WORK.
          ENDIF.
        ENDIF.
      ENDIF.
      ls_run-artifact_id = lv_art.
      ls_run-row_count   = lv_rows.
      lv_text = COND #( WHEN lv_src_ok = abap_true
                        THEN |【定时运行】{ fmt_time( ls_run-started_at ) } { lv_rname }：共 { lv_rows } 行|
                        ELSE |【定时运行】{ fmt_time( ls_run-started_at ) } { lv_rname }：{ ls_run-message }| ).
      write_msg( iv_session_id = CONV string( ls_db-session_id ) iv_text = lv_text ).
      COMMIT WORK.
      IF lv_src_ok = abap_false.
        ls_run-status = 'FAILED'.
      ENDIF.
    ELSEIF ls_run-status IS INITIAL.
      write_msg( iv_session_id = CONV string( ls_db-session_id )
                 iv_text       = |【定时运行】{ fmt_time( ls_run-started_at ) }| ).
      COMMIT WORK.
    ENDIF.

    " ---- 指令: 交给灵犀(数据来源失败时不分析, 消息里已写原因) ----
    IF ls_run-status IS INITIAL AND ls_db-instruction IS NOT INITIAL.
      DATA(lv_q) = |{ ls_db-instruction }\n\n(这是定时任务「{ ls_db-name_text }」的自动运行, | &&
                   |今天是 { sy-datum(4) }-{ sy-datum+4(2) }-{ sy-datum+6(2) }| &&
                   COND string( WHEN lv_art IS NOT INITIAL THEN |; 本次数据来源的结果({ lv_rows } 行)已在上下文中| ) && `)`.
      TRY.
          zcl_ai_agent_service=>analyze_agent(
            EXPORTING iv_session_id        = CONV string( ls_db-session_id )
                      iv_question          = lv_q
                      iv_model_id          = CONV string( ls_db-model_id )
                      iv_focus_artifact_id = lv_art
                      iv_scene             = CONV string( ls_db-scene )
                      iv_request_id        = guid( )
            IMPORTING es_result            = ls_agent ).
          IF ls_agent-status <> 'OK'.
            ls_run-status  = 'ANALYZE_ERR'.
            ls_run-message = |结果已就绪, 分析没完成: { COND string( WHEN ls_agent-message IS NOT INITIAL
                                                                 THEN ls_agent-message ELSE ls_agent-status ) }|.
          ENDIF.
        CATCH cx_root INTO DATA(lx).
          ls_run-status  = 'ANALYZE_ERR'.
          ls_run-message = |结果已就绪, 分析出错: { lx->get_text( ) }|.
      ENDTRY.
    ENDIF.
    IF ls_run-status IS INITIAL.
      ls_run-status = 'OK'.
    ENDIF.

    ls_run-elapsed_ms = ( ts_secs( now14( ) ) - ts_secs( ls_run-started_at ) ) * 1000.
    log_run( is_db = ls_db is_run = ls_run ).
    UPDATE zai_schedule SET running_since = ' ',
                            last_run_at   = @ls_run-started_at,
                            last_run_sts  = @ls_run-status
      WHERE sched_id = @lv_id.
    COMMIT WORK.

  ENDMETHOD.


ENDCLASS.
