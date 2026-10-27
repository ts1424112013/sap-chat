*=======================================================================
* 对象:   ZCL_AI_AGENT_PROGRESS
* 用途:   Agent「边跑边看」运行进度(设计: 功能计划书/Agent实时过程/
*         01-边跑边看_接口约定与后端改造)
*         AGENT_SERVICE 跑的同时, 把已走完 / 正在走的步骤写进 ZAI_AGENT_PROG;
*         前端在 AnalyzeTask 返回前按 ClientRequestId 调 AgentProgress 读。
*         - 写: 独立数据库连接 R/3*AI_PROG 单独提交, 不碰主事务(主请求
*           的 COMMIT / 回滚都不影响进度行, 其他会话立即可见);
*         - 任何异常只关掉本次进度(mv_on = 空), 绝不影响 Agent 主流程;
*         - 步骤与 Trace 同口径: 只有阶段 / 友好摘要 / 工具 / 参数 /
*           行数 / 耗时 / 已校验 SQL / 前 3 行预览, 不含思维链、Prompt、密钥;
*         - 读: 只返回本人(UNAME = sy-uname)的运行。
* 表:     ZAI_AGENT_PROG(MANDT, RUN_ID CHAR32, SEQ INT4, UNAME, STEP_JSON
*         STRING, CHANGED_AT TIMESTAMP); SEQ = 0 是运行头(RUNNING / DONE),
*         其余一行一步, STEP_JSON = 单步 JSON(camelCase)。保留 2 天。
* 开关:   ZAI_CHAT_CFG-AGENT_PROGRESS = OFF 时不写(默认写)。
* 用法(AGENT_SERVICE):
*         start( 请求编号 ) → 每轮调模型前 sync( trace + 运行中占位 ) →
*         工具执行前 sync( trace + 模型那句话 + 工具占位 ) → 数据分析查询后
*         sync( trace + 预览 ) → 结束 sync( trace ) + finish( )。
*         占位: 下一条新的 Trace 行原地接替(同一 SEQ); 没有新行就按完成收口。
* V1.0 20261028: 新建
*=======================================================================
CLASS zcl_ai_agent_progress DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES: BEGIN OF ty_arg,
             k TYPE string,
             v TYPE string,
           END OF ty_arg.
    TYPES tt_arg TYPE STANDARD TABLE OF ty_arg WITH DEFAULT KEY.

    TYPES tt_cells TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    TYPES tt_prev_rows TYPE STANDARD TABLE OF tt_cells WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_preview,
             columns TYPE tt_cells,
             rows    TYPE tt_prev_rows,
           END OF ty_preview.
    TYPES tt_preview TYPE STANDARD TABLE OF ty_preview WITH DEFAULT KEY.

    " 单步(序列化成前端契约: seq/phase/label/toolLabel/tool/args/status/elapsedMs/rows/detail/preview)
    TYPES: BEGIN OF ty_step,
             seq        TYPE i,
             phase      TYPE string,
             label      TYPE string,
             tool_label TYPE string,
             tool       TYPE string,
             args       TYPE tt_arg,
             status     TYPE string,
             elapsed_ms TYPE i,
             rows       TYPE i,
             detail     TYPE string,
             preview    TYPE ty_preview,
           END OF ty_step.

    " 运行中占位(进入下一轮 / 执行工具前写)
    TYPES: BEGIN OF ty_running,
             phase      TYPE string,
             label      TYPE string,
             tool       TYPE string,
             args       TYPE tt_arg,
           END OF ty_running.

    " 开始一次运行: 请求编号为空或开关 OFF 时本次不记进度
    CLASS-METHODS start
      IMPORTING iv_run_id TYPE string.

    " 写入 Trace 里还没写过的行; 可带模型那句话(NOTE)、运行中占位、
    " 新行对应的预览(按新行顺序一一对应, 用于数据分析查询)
    CLASS-METHODS sync
      IMPORTING it_trace   TYPE zcl_ai_agent_service=>tt_trace
                iv_note    TYPE string OPTIONAL
                is_running TYPE ty_running OPTIONAL
                it_preview TYPE tt_preview OPTIONAL.

    " 结束: 收掉占位, 运行头置 DONE
    CLASS-METHODS finish.

    " 读进度(DPC 的 AgentProgress): {"status":"RUNNING|DONE|NONE","steps":[...]}
    CLASS-METHODS read
      IMPORTING iv_run_id   TYPE string
      RETURNING VALUE(rv)   TYPE string.

    " 工具 ID → 界面名(未登记的原样返回)
    CLASS-METHODS tool_label
      IMPORTING iv_tool     TYPE string
      RETURNING VALUE(rv)   TYPE string.

    " 数据分析查询占位: 第一条查询名作标签(多条加"等 N 条查询"), 涉及的表作参数小标签
    CLASS-METHODS plan_running
      IMPORTING iv_tool   TYPE string
                is_plan   TYPE zcl_ai_data_analysis_service=>ty_plan
      RETURNING VALUE(rs) TYPE ty_running.

    " 扁平参数工具占位: 校验后的参数作小标签(常见参数名换中文; SQL 原文不放, 值超 40 字截断)
    CLASS-METHODS kv_running
      IMPORTING iv_tool   TYPE string
                it_kv     TYPE zcl_ai_agent_guard=>tt_kv
      RETURNING VALUE(rs) TYPE ty_running.

    " 数据集前 3 行 × 5 列 → 预览
    CLASS-METHODS preview_of
      IMPORTING it_columns  TYPE zcl_ai_data_analysis_service=>tt_column
                it_rows     TYPE zcl_ai_data_analysis_service=>tt_rows
      RETURNING VALUE(rs)   TYPE ty_preview.

  PRIVATE SECTION.

    CONSTANTS gc_con  TYPE dbcon_name VALUE 'R/3*AI_PROG'.
    CONSTANTS gc_keep_sec TYPE i VALUE 172800.   " 进度行保留 2 天

    CLASS-DATA: gv_on       TYPE abap_bool,
                gv_run      TYPE c LENGTH 32,
                gv_seq      TYPE i,
                gv_synced   TYPE i,              " it_trace 已写到第几行
                gv_hold     TYPE i,              " 运行中占位的 SEQ(0 = 无)
                gs_hold     TYPE ty_step,        " 占位内容(接替时保留工具名 / 参数)
                gv_hold_t0  TYPE i.              " 占位开始时刻(GET RUN TIME, 微秒)

    CLASS-METHODS put
      IMPORTING is_step   TYPE ty_step
                iv_update TYPE abap_bool.

    CLASS-METHODS put_head
      IMPORTING iv_status TYPE string.

    CLASS-METHODS to_json
      IMPORTING is_step   TYPE ty_step
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS arg_label
      IMPORTING iv_name   TYPE string
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS zcl_ai_agent_progress IMPLEMENTATION.


  METHOD start.

    CLEAR: gv_on, gv_run, gv_seq, gv_synced, gv_hold, gs_hold, gv_hold_t0.
    IF iv_run_id IS INITIAL OR strlen( iv_run_id ) > 32.
      RETURN.
    ENDIF.

    SELECT SINGLE cfgvalue FROM zai_chat_cfg
      WHERE cfgkey = 'AGENT_PROGRESS'
      INTO @DATA(lv_cfg).
    IF sy-subrc = 0 AND to_upper( condense( CONV string( lv_cfg ) ) ) = 'OFF'.
      RETURN.
    ENDIF.

    gv_run = iv_run_id.
    gv_on  = abap_true.

    TRY.
        " 顺手清掉 2 天前的进度行(表很小, 一次删除很快)
        DATA: lv_now TYPE timestamp,
              lv_cut TYPE timestamp.
        GET TIME STAMP FIELD lv_now.
        lv_cut = cl_abap_tstmp=>subtractsecs( tstmp = lv_now secs = gc_keep_sec ).
        DELETE FROM zai_agent_prog CONNECTION (gc_con) WHERE changed_at < @lv_cut.
        " 同一编号重发(极少见)从头记
        DELETE FROM zai_agent_prog CONNECTION (gc_con) WHERE run_id = @gv_run.
        put_head( 'RUNNING' ).
        COMMIT CONNECTION (gc_con).
      CATCH cx_root.
        CLEAR gv_on.
    ENDTRY.

  ENDMETHOD.


  METHOD sync.

    CHECK gv_on = abap_true.

    TRY.
        DATA: ls_step TYPE ty_step,
              lv_t1   TYPE i,
              lv_new  TYPE i,
              lv_from TYPE i.

        " ---- 1. 新增的 Trace 行(第一条接替占位) ----
        lv_from = gv_synced + 1.
        LOOP AT it_trace INTO DATA(ls_t) FROM lv_from.
          lv_new = lv_new + 1.
          CLEAR ls_step.
          ls_step-phase      = ls_t-phase.
          ls_step-label      = ls_t-label.
          ls_step-tool       = ls_t-tool.
          ls_step-tool_label = COND #( WHEN ls_t-tool IS NOT INITIAL THEN tool_label( ls_t-tool ) ).
          ls_step-status     = ls_t-status.
          ls_step-elapsed_ms = ls_t-elapsed_ms.
          ls_step-rows       = ls_t-rows.
          ls_step-detail     = ls_t-detail.
          " 数据分析查询行: 去掉与工具名重复的前缀和与结果列重复的「, N 行」
          IF ls_step-phase = 'EXECUTING' AND ls_step-tool = zcl_ai_tool_registry=>gc_tool_data_analysis.
            REPLACE FIRST OCCURRENCE OF REGEX '^数据分析查询(失败)?:\s*' IN ls_step-label WITH ``.
            REPLACE FIRST OCCURRENCE OF REGEX ',\s*[0-9]+\s*行$' IN ls_step-label WITH ``.
          ENDIF.
          READ TABLE it_preview INTO ls_step-preview INDEX lv_new.
          IF gv_hold > 0.
            ls_step-seq = gv_hold.
            " 接替工具占位: 保留执行前写的参数小标签
            IF ls_step-phase = 'EXECUTING' AND gs_hold-tool IS NOT INITIAL
               AND ( ls_step-tool IS INITIAL OR ls_step-tool = gs_hold-tool ).
              ls_step-args = gs_hold-args.
              IF ls_step-tool IS INITIAL.
                ls_step-tool       = gs_hold-tool.
                ls_step-tool_label = gs_hold-tool_label.
              ENDIF.
            ENDIF.
            put( is_step = ls_step iv_update = abap_true ).
            CLEAR: gv_hold, gs_hold, gv_hold_t0.
          ELSE.
            gv_seq = gv_seq + 1.
            ls_step-seq = gv_seq.
            put( is_step = ls_step iv_update = abap_false ).
          ENDIF.
        ENDLOOP.
        gv_synced = lines( it_trace ).

        " ---- 2. 占位没有被接替 → 按完成收口(例如"根据结果决定下一步"这一轮模型调用) ----
        IF gv_hold > 0.
          GET RUN TIME FIELD lv_t1.
          ls_step = gs_hold.
          ls_step-status     = 'OK'.
          ls_step-elapsed_ms = ( lv_t1 - gv_hold_t0 ) / 1000.
          put( is_step = ls_step iv_update = abap_true ).
          CLEAR: gv_hold, gs_hold, gv_hold_t0.
        ENDIF.

        " ---- 3. 模型调工具前的那句话 ----
        IF iv_note IS NOT INITIAL.
          CLEAR ls_step.
          gv_seq = gv_seq + 1.
          ls_step-seq    = gv_seq.
          ls_step-phase  = 'NOTE'.
          ls_step-label  = iv_note.
          ls_step-status = 'OK'.
          put( is_step = ls_step iv_update = abap_false ).
        ENDIF.

        " ---- 4. 运行中占位 ----
        IF is_running-phase IS NOT INITIAL.
          CLEAR ls_step.
          gv_seq = gv_seq + 1.
          ls_step-seq        = gv_seq.
          ls_step-phase      = is_running-phase.
          ls_step-label      = is_running-label.
          ls_step-tool       = is_running-tool.
          ls_step-tool_label = COND #( WHEN is_running-tool IS NOT INITIAL THEN tool_label( is_running-tool ) ).
          ls_step-args       = is_running-args.
          ls_step-status     = 'RUNNING'.
          put( is_step = ls_step iv_update = abap_false ).
          gv_hold = gv_seq.
          gs_hold = ls_step.
          GET RUN TIME FIELD gv_hold_t0.
        ENDIF.

        COMMIT CONNECTION (gc_con).
      CATCH cx_root.
        CLEAR gv_on.
    ENDTRY.

  ENDMETHOD.


  METHOD finish.

    CHECK gv_on = abap_true.
    TRY.
        IF gv_hold > 0.
          DATA lv_t1 TYPE i.
          GET RUN TIME FIELD lv_t1.
          DATA(ls_step) = gs_hold.
          ls_step-status     = 'OK'.
          ls_step-elapsed_ms = ( lv_t1 - gv_hold_t0 ) / 1000.
          put( is_step = ls_step iv_update = abap_true ).
        ENDIF.
        put_head( 'DONE' ).
        COMMIT CONNECTION (gc_con).
      CATCH cx_root.
        CLEAR gv_on.
    ENDTRY.
    CLEAR: gv_on, gv_hold, gs_hold, gv_hold_t0.

  ENDMETHOD.


  METHOD read.

    DATA: lv_run    TYPE c LENGTH 32,
          lv_status TYPE string,
          lv_steps  TYPE string.

    lv_status = 'NONE'.
    IF iv_run_id IS NOT INITIAL AND strlen( iv_run_id ) <= 32.
      lv_run = iv_run_id.
      SELECT seq, step_json FROM zai_agent_prog
        WHERE run_id = @lv_run AND uname = @sy-uname
        ORDER BY seq
        INTO TABLE @DATA(lt_rows).
      LOOP AT lt_rows INTO DATA(ls_row).
        IF ls_row-seq = 0.
          lv_status = COND #( WHEN ls_row-step_json = 'DONE' THEN 'DONE' ELSE 'RUNNING' ).
        ELSE.
          lv_steps = COND #( WHEN lv_steps IS INITIAL THEN ls_row-step_json
                             ELSE lv_steps && `,` && ls_row-step_json ).
        ENDIF.
      ENDLOOP.
      IF lv_status = 'NONE' AND lt_rows IS NOT INITIAL.
        lv_status = 'RUNNING'.
      ENDIF.
    ENDIF.

    rv = `{"status":"` && lv_status && `","steps":[` && lv_steps && `]}`.

  ENDMETHOD.


  METHOD tool_label.

    CASE iv_tool.
      WHEN zcl_ai_tool_registry=>gc_tool_data_analysis. rv = '数据分析查询'.
      WHEN zcl_ai_tool_registry=>gc_tool_search_tables. rv = '找表'.
      WHEN zcl_ai_tool_registry=>gc_tool_describe_tab.  rv = '表结构'.
      WHEN zcl_ai_tool_registry=>gc_tool_run_sql.       rv = '只读 SQL'.
      WHEN zcl_ai_tool_registry=>gc_tool_resolve_rpt.   rv = '匹配报表'.
      WHEN zcl_ai_tool_registry=>gc_tool_rpt_params.    rv = '读取参数定义'.
      WHEN zcl_ai_tool_registry=>gc_tool_rpt_result.    rv = '读取报表结果'.
      WHEN zcl_ai_tool_registry=>gc_tool_read_source.   rv = '读源码'.
      WHEN 'get_stock_snapshot'.                        rv = '库存快照'.
      WHEN 'get_daily_movement'.                        rv = '当天收发'.
      WHEN 'get_batch_stock'.                           rv = '批次库存'.
      WHEN 'resolve_material'.                          rv = '识别物料'.
      WHEN OTHERS.                                      rv = iv_tool.
    ENDCASE.

  ENDMETHOD.


  METHOD plan_running.

    DATA lv_tabs TYPE string.
    rs-phase = 'EXECUTING'.
    rs-tool  = iv_tool.
    LOOP AT is_plan-queries INTO DATA(ls_q).
      IF rs-label IS INITIAL.
        rs-label = ls_q-name.
      ENDIF.
      IF ls_q-entity IS NOT INITIAL AND lv_tabs NS ls_q-entity.
        lv_tabs = COND #( WHEN lv_tabs IS INITIAL THEN ls_q-entity ELSE lv_tabs && ` / ` && ls_q-entity ).
      ENDIF.
    ENDLOOP.
    IF lines( is_plan-queries ) > 1.
      rs-label = rs-label && | 等 { lines( is_plan-queries ) } 条查询|.
    ENDIF.
    IF lv_tabs IS NOT INITIAL.
      APPEND VALUE #( k = '表' v = lv_tabs ) TO rs-args.
    ENDIF.

  ENDMETHOD.


  METHOD kv_running.

    rs-phase = 'EXECUTING'.
    rs-tool  = iv_tool.
    LOOP AT it_kv INTO DATA(ls_kv).
      CHECK ls_kv-value IS NOT INITIAL.
      CHECK to_lower( ls_kv-name ) <> 'sql' AND to_lower( ls_kv-name ) <> 'purpose'.
      DATA(lv_v) = ls_kv-value.
      IF strlen( lv_v ) > 40.
        lv_v = substring( val = lv_v len = 40 ) && `…`.
      ENDIF.
      APPEND VALUE #( k = arg_label( ls_kv-name ) v = lv_v ) TO rs-args.
      IF lines( rs-args ) >= 6.
        EXIT.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD arg_label.

    CASE to_lower( iv_name ).
      WHEN 'plant' OR 'werks'.                 rv = '工厂'.
      WHEN 'material' OR 'matnr'.              rv = '物料'.
      WHEN 'material_hint'.                    rv = '物料线索'.
      WHEN 'lgort' OR 'storage_location'.      rv = '库位'.
      WHEN 'batch' OR 'charg'.                 rv = '批次'.
      WHEN 'posting_date' OR 'date' OR 'budat'. rv = '日期'.
      WHEN 'table' OR 'tabname'.               rv = '表'.
      WHEN 'name' OR 'program'.                rv = '对象'.
      WHEN 'start_line'.                       rv = '起始行'.
      WHEN 'keyword'.                          rv = '关键词'.
      WHEN 'tcode'.                            rv = '事务码'.
      WHEN OTHERS.                             rv = iv_name.
    ENDCASE.

  ENDMETHOD.


  METHOD preview_of.

    DATA lt_cells TYPE tt_cells.
    LOOP AT it_columns INTO DATA(ls_col) TO 5.
      APPEND COND string( WHEN ls_col-label IS NOT INITIAL THEN ls_col-label ELSE ls_col-name ) TO rs-columns.
    ENDLOOP.
    LOOP AT it_rows INTO DATA(lt_src) TO 3.
      CLEAR lt_cells.
      LOOP AT lt_src INTO DATA(lv_cell) TO 5.
        IF strlen( lv_cell ) > 60.
          lv_cell = substring( val = lv_cell len = 60 ) && `…`.
        ENDIF.
        APPEND lv_cell TO lt_cells.
      ENDLOOP.
      APPEND lt_cells TO rs-rows.
    ENDLOOP.

  ENDMETHOD.


  METHOD put.

    DATA: ls_row TYPE zai_agent_prog,
          lv_ts  TYPE timestamp.
    GET TIME STAMP FIELD lv_ts.
    IF iv_update = abap_true.
      DATA(lv_json) = to_json( is_step ).
      UPDATE zai_agent_prog CONNECTION (gc_con)
        SET step_json = @lv_json, changed_at = @lv_ts
        WHERE run_id = @gv_run AND seq = @is_step-seq.
    ELSE.
      ls_row-mandt      = sy-mandt.
      ls_row-run_id     = gv_run.
      ls_row-seq        = is_step-seq.
      ls_row-uname      = sy-uname.
      ls_row-step_json  = to_json( is_step ).
      ls_row-changed_at = lv_ts.
      INSERT zai_agent_prog CONNECTION (gc_con) FROM @ls_row.
    ENDIF.

  ENDMETHOD.


  METHOD put_head.

    DATA: ls_row TYPE zai_agent_prog,
          lv_ts  TYPE timestamp.
    GET TIME STAMP FIELD lv_ts.
    ls_row-mandt      = sy-mandt.
    ls_row-run_id     = gv_run.
    ls_row-seq        = 0.
    ls_row-uname      = sy-uname.
    ls_row-step_json  = iv_status.
    ls_row-changed_at = lv_ts.
    MODIFY zai_agent_prog CONNECTION (gc_con) FROM @ls_row.

  ENDMETHOD.


  METHOD to_json.

    " compress: 空值不输出(没有预览 / 参数 / 行数的步骤更短); 前端对缺省字段都有兜底
    rv = /ui2/cl_json=>serialize( data        = is_step
                                  compress    = abap_true
                                  pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).

  ENDMETHOD.

ENDCLASS.
