CLASS zcl_ai_report_exec_sap DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.
    " V1.0 20261009: 真实作业适配器 —— 方法契约与 ZCL_AI_REPORT_MOCK 完全一致
    " (REPORT_SERVICE V1.0.10 按开关 REPORT_EXEC_REAL 路由, 调用点透明替换)
    " 安全: AI 通道强制 P2 查询模式(P1 上传/P3 删除绝不提交);
    "       程序名来自 ZAI_RPT_DEF 登记事实源, 参数经 ZAI_RPT_PARAM 登记白名单
    " 依赖: ZAI_RPT_RESULT(结果表, 程序端 P_AICAP 落表)
    "       ZAI_RPT_PARAM.SEL_KIND 列(P=PARAMETER S=SELECT-OPTION)
    "       ZCL_AI_REPORT_SERVICE(gc_run_* 常量 / tt_kv / parse_flat_kv)
    CLASS-METHODS submit
      IMPORTING iv_report_run_id TYPE string
                iv_program       TYPE string
                iv_params_json   TYPE string
                iv_user          TYPE string
      EXPORTING ev_status        TYPE string
                ev_message       TYPE string.
    CLASS-METHODS poll
      IMPORTING iv_report_run_id TYPE string
      EXPORTING ev_status        TYPE string
                ev_message       TYPE string.
    CLASS-METHODS read_result
      IMPORTING iv_report_run_id TYPE string
                iv_max_rows      TYPE i
      EXPORTING ev_schema_json   TYPE string
                ev_summary_json  TYPE string
                ev_rows_json     TYPE string
                ev_row_count     TYPE i
                ev_message       TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS build_seltab
      IMPORTING iv_report_run_id TYPE string
                iv_program       TYPE string
                iv_params_json   TYPE string
      EXPORTING et_seltab        TYPE rsparams_tt
                ev_err           TYPE string.
ENDCLASS.


CLASS zcl_ai_report_exec_sap IMPLEMENTATION.

  METHOD submit.
    " 真实执行: JOB_OPEN -> SUBMIT VIA JOB(WITH SELECTION-TABLE) -> JOB_CLOSE
    " 作业名/号回写 ZAI_RPT_RUN 预留字段(SAP_JOB_NAME/SAP_JOB_NUMBER), poll 按此回查
    DATA: lv_jobname TYPE tbtcjob-jobname,
          lv_jobcnt  TYPE tbtcjob-jobcount,
          lt_seltab  TYPE rsparams_tt.
    CLEAR: ev_status, ev_message.

    " 结果表幂等清理(防御性; 正常每 run 只提交一次)
    DELETE FROM zai_rpt_result WHERE run_id = @iv_report_run_id.

    " 作业名: ZAI_RPT_ + run_id 前 24(TBTCJ-JOBNAME 限 32 字符)
    lv_jobname = |ZAI_RPT_{ iv_report_run_id }|.
    IF strlen( lv_jobname ) > 32.
      lv_jobname = lv_jobname(32).
    ENDIF.

    CALL FUNCTION 'JOB_OPEN'
      EXPORTING
        jobname          = lv_jobname
      IMPORTING
        jobcount         = lv_jobcnt
      EXCEPTIONS
        cant_create_job  = 1
        invalid_job_data = 2
        jobname_missing  = 3
        OTHERS           = 4.
    IF sy-subrc <> 0.
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = |作业创建失败(JOB_OPEN subrc={ sy-subrc }), 本次未提交|.
      RETURN.
    ENDIF.

    build_seltab(
      EXPORTING iv_report_run_id = iv_report_run_id
                iv_program       = iv_program
                iv_params_json   = iv_params_json
      IMPORTING et_seltab        = lt_seltab
                ev_err           = DATA(lv_err) ).
    IF lv_err IS NOT INITIAL.
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = |选择参数构建失败: { lv_err }|.
      RETURN.
    ENDIF.

    " 程序名 = 登记事实源(非用户输入); 参数 = 登记白名单(seltab, 无字符串拼接)
    SUBMIT (iv_program) VIA JOB lv_jobname NUMBER lv_jobcnt
      WITH SELECTION-TABLE lt_seltab
      AND RETURN.
    IF sy-subrc <> 0.
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = 'SUBMIT VIA JOB 失败(程序名/选择参数不合法), 本次未提交'.
      RETURN.
    ENDIF.

    CALL FUNCTION 'JOB_CLOSE'
      EXPORTING
        jobname              = lv_jobname
        jobcount             = lv_jobcnt
        strtimmed            = 'I'
      EXCEPTIONS
        cant_start_immediate = 1
        invalid_startdate    = 2
        jobname_missing      = 3
        job_close_sys_error  = 4
        job_already_running  = 5
        OTHERS               = 9.
    IF sy-subrc <> 0.
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = |作业释放失败(JOB_CLOSE subrc={ sy-subrc }), 作业滞留, 请 SM37 手工处理|.
      RETURN.
    ENDIF.

    UPDATE zai_rpt_run SET sap_job_name   = @lv_jobname,
                           sap_job_number = @lv_jobcnt
      WHERE report_run_id = @iv_report_run_id.
    COMMIT WORK.

    ev_status  = zcl_ai_report_service=>gc_run_submitted.
    ev_message = |已提交真实作业 { lv_jobname }/{ lv_jobcnt }(后台执行, 程序端自动落结果表)|.
  ENDMETHOD.


  METHOD poll.
    " 状态回查: TBTCo 直查 —— R=运行 Y/S=已释放 F=完成 A=取消
    " TIMEOUT 语义不变: RUNNING 只表示未到终态, 不代表作业已停止
    DATA: lv_jobname TYPE zai_rpt_run-sap_job_name,
          lv_jobcnt  TYPE zai_rpt_run-sap_job_number,
          lv_sts     TYPE tbtco-status.
    CLEAR: ev_status, ev_message.

    SELECT SINGLE sap_job_name, sap_job_number
      FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO ( @lv_jobname, @lv_jobcnt ).
    IF sy-subrc <> 0 OR lv_jobname IS INITIAL.
      ev_status  = zcl_ai_report_service=>gc_run_unknown.
      ev_message = '运行无后台作业信息(SAP_JOB_NAME 空), 无法回查状态'.
      RETURN.
    ENDIF.

    SELECT SINGLE status
      FROM tbtco
      WHERE jobname = @lv_jobname AND jobcount = @lv_jobcnt
      INTO @lv_sts.
    IF sy-subrc <> 0.
      ev_status  = zcl_ai_report_service=>gc_run_unknown.
      ev_message = '后台作业未找到(可能已被删除), 请 SM37 人工核对'.
      RETURN.
    ENDIF.

    CASE lv_sts.
      WHEN 'R' OR 'Y' OR 'S'.
        ev_status = zcl_ai_report_service=>gc_run_running.
      WHEN 'F'.
        ev_status = zcl_ai_report_service=>gc_run_ready.
      WHEN 'A'.
        ev_status  = zcl_ai_report_service=>gc_run_failed.
        ev_message = '后台作业被取消(SM37 状态 A), 请查看作业日志'.
      WHEN OTHERS.
        ev_status  = zcl_ai_report_service=>gc_run_unknown.
        ev_message = |作业状态 { lv_sts } 未识别, 需继续查询|.
    ENDCASE.
  ENDMETHOD.


  METHOD read_result.
    " 读 ZAI_RPT_RESULT(程序端 P_AICAP 落表) 拼 rows; schema 从首行键推断
    " 0 行是有效业务事实(空结果); 但作业完成且 0 行也可能= P_AICAP 未生效,
    " 可对比 SM37 作业 spool 行数甄别(此处不伪造, 如实返回)
    DATA: lv_rows   TYPE string,
          lv_schema TYPE string,
          lv_seg    TYPE string,
          lv_i      TYPE i,
          lv_keys   TYPE STANDARD TABLE OF string,
          lv_k      TYPE string.
    CLEAR: ev_schema_json, ev_summary_json, ev_rows_json, ev_row_count, ev_message.

    SELECT SINGLE sap_job_name FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO @DATA(lv_jobname).

    SELECT * FROM zai_rpt_result
      WHERE run_id = @iv_report_run_id
      ORDER BY line_index
      INTO TABLE @DATA(lt).
    ev_row_count = lines( lt ).

    " schema: 首行 JSON 的键推断(键=程序字段名大写, label=name)
    IF lt IS NOT INITIAL.
      DATA(lv_first) = lt[ 1 ]-row_json.
      FIND ALL OCCURRENCES OF REGEX `"([A-Z_0-9]+)"\s*:` IN lv_first
        RESULTS DATA(lt_m).
      LOOP AT lt_m INTO DATA(ls_m).
        lv_k = ls_m-submatches[ 1 ].
        READ TABLE lv_keys TRANSPORTING NO FIELDS WITH KEY table_line = lv_k.
        IF sy-subrc <> 0.
          APPEND lv_k TO lv_keys.
        ENDIF.
      ENDLOOP.
      LOOP AT lv_keys INTO lv_k.
        lv_seg = |\{"name":"{ lv_k }","label":"{ lv_k }"\}|.
        lv_schema = COND #( WHEN lv_schema IS INITIAL THEN lv_seg
                            ELSE lv_schema && ',' && lv_seg ).
      ENDLOOP.
      ev_schema_json = '[' && lv_schema && ']'.
    ELSE.
      ev_schema_json = '[]'.
    ENDIF.

    " rows 拼接: 样例行按 MAX_ROWS 截断展示, 计数如实(与 MOCK 同语义)
    lv_i = 0.
    LOOP AT lt INTO DATA(ls).
      lv_i = lv_i + 1.
      IF iv_max_rows > 0 AND lv_i > iv_max_rows.
        EXIT.
      ENDIF.
      lv_rows = COND #( WHEN lv_rows IS INITIAL THEN ls-row_json
                        ELSE lv_rows && ',' && ls-row_json ).
    ENDLOOP.
    ev_rows_json = '[' && lv_rows && ']'.

    ev_summary_json = |\{"total_rows":{ ev_row_count },"source":"JOB { lv_jobname }"\}|.
  ENDMETHOD.


  METHOD build_seltab.
    " 选择参数构建: selname = ZAI_RPT_PARAM.ABAP_NAME(必须与程序参数名一致)
    " SEL_KIND: P=PARAMETER / S=SELECT-OPTION(此处按单值 EQ 提交)
    " 强制: P2='X'(查询模式; P1 上传/P3 删除绝不提交) + P_FILE 默认值(OBLIGATORY)
    TYPES: BEGIN OF ty_prow,
             param_id  TYPE string,
             abap_name TYPE string,
             sel_kind  TYPE string,
           END OF ty_prow.
    DATA: lt_p    TYPE STANDARD TABLE OF ty_prow,
          lt_kv   TYPE zcl_ai_report_service=>tt_kv,
          ls_sel  TYPE rsparams.
    CLEAR: et_seltab, ev_err.

    SELECT SINGLE report_id FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO @DATA(lv_rid).
    IF sy-subrc <> 0.
      ev_err = '运行记录不存在, 无法定位报表参数定义'.
      RETURN.
    ENDIF.

    SELECT param_id, abap_name, sel_kind
      FROM zai_rpt_param
      WHERE report_id = @lv_rid
        AND active = 'X'
        AND abap_name <> ''
      INTO TABLE @lt_p.
    IF lt_p IS INITIAL.
      ev_err = |报表 { lv_rid } 未登记任何可执行参数(ABAP_NAME/SEL_KIND 需维护)|.
      RETURN.
    ENDIF.

    lt_kv = zcl_ai_report_service=>parse_flat_kv( iv_params_json ).

    " 强制参数(先于登记参数): AI 通道只查询
    CLEAR ls_sel.
    ls_sel-selname = 'P2'.
    ls_sel-kind    = 'P'.
    ls_sel-sign    = 'I'.
    ls_sel-option  = 'EQ'.
    ls_sel-low     = 'X'.
    APPEND ls_sel TO et_seltab.

    CLEAR ls_sel.
    ls_sel-selname = 'P_FILE'.
    ls_sel-kind    = 'P'.
    ls_sel-low     = 'D:\'.
    APPEND ls_sel TO et_seltab.

    " 登记参数: 按 param_id 从参数快照取值, 按 ABAP_NAME/SEL_KIND 提交
    LOOP AT lt_p INTO DATA(ls_p).
      READ TABLE lt_kv INTO DATA(ls_kv) WITH KEY name = ls_p-param_id.
      IF sy-subrc <> 0 OR ls_kv-value IS INITIAL.
        CONTINUE.   " 未提交的参数交给程序自身必填校验兜底
      ENDIF.
      CLEAR ls_sel.
      ls_sel-selname = to_upper( ls_p-abap_name ).
      ls_sel-sign    = 'I'.
      ls_sel-option  = 'EQ'.
      ls_sel-low     = ls_kv-value.
      ls_sel-kind    = COND #( WHEN ls_p-sel_kind = 'S' THEN 'S' ELSE 'P' ).
      APPEND ls_sel TO et_seltab.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
