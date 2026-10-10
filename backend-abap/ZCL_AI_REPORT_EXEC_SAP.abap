*=======================================================================
* 对象:   ZCL_AI_REPORT_EXEC_SAP
* 用途:   报表真实作业适配器 —— 方法契约与 ZCL_AI_REPORT_MOCK 完全一致
*         (REPORT_SERVICE 按开关 REPORT_EXEC_REAL 路由, 调用点透明替换)
* 安全:   AI 通道强制 P2 查询模式(P1 上传/P3 删除绝不提交);
*         程序名来自 ZAI_RPT_DEF 登记事实源, 参数经 ZAI_RPT_PARAM 登记白名单
* 依赖:   ZAI_RPT_RESULT(结果表, 程序端 P_AICAP 落表)
*         ZAI_RPT_PARAM.SEL_KIND 列(P=PARAMETER S=SELECT-OPTION)
*         ZCL_AI_REPORT_SERVICE(gc_run_* 常量 / tt_kv / parse_flat_kv)
* 安装:   SE24 -> 整类源代码替换粘帖 (ABAP 7.50, 755 已核对)
* V1.0    20261009: 首版(SUBMIT VIA JOB + 白名单选择屏 + 作业回查 + 结果读取)
* V1.0a   20261009: SUBMIT 动态程序名不能用 string → PROGNAME 类型
* V1.0b   20261009: FIND REGEX 的 RESULTS 子匹配是偏移/长度, 按偏移截取原串
* V1.0c   20261009: build_seltab 补传采集开关 P_AICAP='X' 与运行号 P_RUNID
* V1.0d   20261009: 参数快照键为小写(validate_params 规范化口径), 匹配
*         前大小写归一; SEL_KIND 归一(只认 S, 其余按 P)
*   (a~d 按 10.09 日报复原; 10.09 进度文件夹里的源码是 V1.0 原版)
* V1.0e   20261011: ① JOB_CLOSE STRTIMMED 由 'I' 改 'X' —— 非 'X' 即"不立即
*         启动", 作业停在"已计划(P)"不会执行, 必须 SM37 手工释放(遗留问题 3
*         根因); 无空闲后台进程(CANT_START_IMMEDIATE)时退化为"开始时间=当前"
*         释放, 由后台调度器拾取(只多一个调度周期的延迟, 不再失败);
*         ② build_seltab 前移到 JOB_OPEN 之前, SUBMIT/JOB_CLOSE 失败删除空作业
*         (BP_JOB_DELETE), SM37 不留孤儿作业;
*         ③ poll 显式识别 P(已计划未释放)/Z(已释放挂起), 消息说明处置;
*         ④ read_result 的 schema 改为 {"columns":[...]}(与 MOCK 契约一致,
*         前端按 .columns 读取), 列 = 全部行键的并集(不依赖首行完整);
*         ⑤ SELECT-OPTION 多值(逗号/竖线)→多行 EQ, 范围(登记 RANGE_ALLOWED,
*         "low,high")→BT, 含 * → CP; 参数取值转大写(与选择屏 PAI 口径一致);
*         ⑥ 参数按运行冻结的 CONFIG_VERSION 读取(与 validate_params 同口径);
*         ⑦ P2='X'/P_FILE 是 ZRMM_IDP_0702 专用的强制参数, 只对该程序下发 ——
*         原先对所有报表下发, 其他报表若恰有同名参数(如 P2=删除勾选)会被
*         强行置位; 通用"固定参数"后续改为 ZAI_RPT_PARAM 配置驱动
* ★ 重贴后核对标记: JOB_CLOSE 处 strtimmed = 'X'; 全文无 SUBMIT (iv_program);
*   read_result 输出以 {"columns": 开头
*=======================================================================
CLASS zcl_ai_report_exec_sap DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.
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

    " V1.0e: 删除未能释放的作业(JOB_OPEN 后失败时调用; 失败静默)
    CLASS-METHODS drop_job
      IMPORTING iv_jobname TYPE tbtcjob-jobname
                iv_jobcnt  TYPE tbtcjob-jobcount.
ENDCLASS.



CLASS zcl_ai_report_exec_sap IMPLEMENTATION.


  METHOD submit.
    " 真实执行: 选择参数 -> JOB_OPEN -> SUBMIT VIA JOB(WITH SELECTION-TABLE) -> JOB_CLOSE
    " 作业名/号回写 ZAI_RPT_RUN 预留字段(SAP_JOB_NAME/SAP_JOB_NUMBER), poll 按此回查
    DATA: lv_jobname TYPE tbtcjob-jobname,
          lv_jobcnt  TYPE tbtcjob-jobcount,
          lv_prog    TYPE progname,
          lt_seltab  TYPE rsparams_tt,
          lv_err     TYPE string,
          lv_rc      TYPE sysubrc,
          lv_delayed TYPE abap_bool,
          lv_sdldate TYPE tbtcjob-sdlstrtdt,
          lv_sdltime TYPE tbtcjob-sdlstrttm.
    CLEAR: ev_status, ev_message.

    " V1.0a: SUBMIT 动态程序名必须是字符型定长(PROGNAME), 不能用 string
    lv_prog = to_upper( iv_program ).
    IF lv_prog IS INITIAL.
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = '报表登记缺少程序名(ZAI_RPT_DEF.PROGNAME), 本次未提交'.
      RETURN.
    ENDIF.

    " V1.0e: 先构建选择参数再开作业 —— 参数失败时不在 SM37 留下空作业
    build_seltab(
      EXPORTING iv_report_run_id = iv_report_run_id
                iv_program       = iv_program
                iv_params_json   = iv_params_json
      IMPORTING et_seltab        = lt_seltab
                ev_err           = lv_err ).
    IF lv_err IS NOT INITIAL.
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = |选择参数构建失败: { lv_err }|.
      RETURN.
    ENDIF.

    " 结果表幂等清理(防御性; 正常每 run 只提交一次)
    DELETE FROM zai_rpt_result WHERE run_id = @iv_report_run_id.

    " 作业名: ZAI_RPT_ + run_id(赋值给 CHAR32 自动截断; 唯一性由作业号保证)
    lv_jobname = |ZAI_RPT_{ iv_report_run_id }|.

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

    " 程序名 = 登记事实源(非用户输入); 参数 = 登记白名单(seltab, 无字符串拼接)
    SUBMIT (lv_prog) VIA JOB lv_jobname NUMBER lv_jobcnt
      WITH SELECTION-TABLE lt_seltab
      AND RETURN.
    IF sy-subrc <> 0.
      lv_rc = sy-subrc.
      drop_job( iv_jobname = lv_jobname iv_jobcnt = lv_jobcnt ).
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = |SUBMIT VIA JOB 失败(subrc={ lv_rc }, 程序 { lv_prog } 或选择参数不合法), 本次未提交|.
      RETURN.
    ENDIF.

    " V1.0e: STRTIMMED 只认 'X'(立即启动)。原 'I' 不是合法值 → 作业只被
    " "计划"(状态 P)而不释放, 永远等人工 SM37 释放
    CALL FUNCTION 'JOB_CLOSE'
      EXPORTING
        jobcount             = lv_jobcnt
        jobname              = lv_jobname
        strtimmed            = 'X'
      EXCEPTIONS
        cant_start_immediate = 1
        invalid_startdate    = 2
        jobname_missing      = 3
        job_close_failed     = 4
        job_nosteps          = 5
        job_notex            = 6
        lock_failed          = 7
        OTHERS               = 9.
    lv_rc = sy-subrc.

    IF lv_rc = 1.
      " 当下无空闲后台工作进程: 改为"开始时间 = 当前"释放, 作业进入已释放
      " 队列, 由后台调度器(rdisp/btctime 周期)拾取 —— 只是晚一个周期, 不判失败
      lv_sdldate = sy-datum.
      lv_sdltime = sy-uzeit.
      CALL FUNCTION 'JOB_CLOSE'
        EXPORTING
          jobcount          = lv_jobcnt
          jobname           = lv_jobname
          sdlstrtdt         = lv_sdldate
          sdlstrttm         = lv_sdltime
        EXCEPTIONS
          invalid_startdate = 2
          jobname_missing   = 3
          job_close_failed  = 4
          job_nosteps       = 5
          job_notex         = 6
          lock_failed       = 7
          OTHERS            = 9.
      lv_rc = sy-subrc.
      lv_delayed = abap_true.
    ENDIF.

    IF lv_rc <> 0.
      drop_job( iv_jobname = lv_jobname iv_jobcnt = lv_jobcnt ).
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = |作业释放失败(JOB_CLOSE subrc={ lv_rc }), 已撤销该作业, 本次未执行|.
      RETURN.
    ENDIF.

    UPDATE zai_rpt_run SET sap_job_name   = @lv_jobname,
                           sap_job_number = @lv_jobcnt
      WHERE report_run_id = @iv_report_run_id.
    COMMIT WORK.

    ev_status  = zcl_ai_report_service=>gc_run_submitted.
    IF lv_delayed = abap_true.
      ev_message = |已提交真实作业 { lv_jobname }/{ lv_jobcnt }(当前无空闲后台进程, | &&
                   |已排入释放队列, 由调度器自动启动)|.
    ELSE.
      ev_message = |已提交真实作业 { lv_jobname }/{ lv_jobcnt }(立即启动, 程序端自动落结果表)|.
    ENDIF.
  ENDMETHOD.


  METHOD poll.
    " 状态回查: TBTCO 直查 —— P=已计划(未释放) S=已释放 Y=就绪 Z=已释放挂起
    "           R=运行中 F=完成 A=取消
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
      WHEN 'R'.
        ev_status  = zcl_ai_report_service=>gc_run_running.
        ev_message = |后台作业执行中({ lv_jobname })|.
      WHEN 'S' OR 'Y' OR 'Z'.
        ev_status  = zcl_ai_report_service=>gc_run_running.
        ev_message = |作业已释放, 等待后台进程启动(状态 { lv_sts })|.
      WHEN 'P'.
        " V1.0e: 已计划但未释放的作业不会自己运行 —— 明确提示, 不伪装成执行中
        ev_status  = zcl_ai_report_service=>gc_run_submitted.
        ev_message = |作业 { lv_jobname } 处于"已计划"(未释放)状态, 不会自动执行; | &&
                     |请在 SM37 释放该作业, 或检查 JOB_CLOSE 启动条件|.
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
    " 读 ZAI_RPT_RESULT(程序端 P_AICAP 落表) 拼 rows; schema = 全部行键的并集
    " 0 行是有效业务事实(空结果); 但作业完成且 0 行也可能 = P_AICAP 未生效,
    " 可对比 SM37 作业 spool 行数甄别(此处不伪造, 如实返回)
    DATA: lv_rows   TYPE string,
          lv_cols   TYPE string,
          lv_seg    TYPE string,
          lv_row    TYPE string,
          lv_i      TYPE i,
          lt_keys   TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_k      TYPE string,
          lt_m      TYPE match_result_tab,
          ls_m      TYPE match_result,
          ls_sub    TYPE submatch_result.
    CLEAR: ev_schema_json, ev_summary_json, ev_rows_json, ev_row_count, ev_message.

    SELECT SINGLE sap_job_name FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO @DATA(lv_jobname).

    SELECT * FROM zai_rpt_result
      WHERE run_id = @iv_report_run_id
      ORDER BY line_index
      INTO TABLE @DATA(lt).
    ev_row_count = lines( lt ).

    " schema: 每行 JSON 的键并集(按首次出现顺序; 键 = 程序字段名大写)
    " V1.0b: 子匹配只有偏移/长度, 必须按偏移从原串截取
    LOOP AT lt INTO DATA(ls).
      lv_row = ls-row_json.
      CLEAR lt_m.
      FIND ALL OCCURRENCES OF REGEX `"([A-Za-z_0-9]+)"\s*:` IN lv_row
        RESULTS lt_m.
      LOOP AT lt_m INTO ls_m.
        READ TABLE ls_m-submatches INTO ls_sub INDEX 1.
        IF sy-subrc <> 0 OR ls_sub-length <= 0.
          CONTINUE.
        ENDIF.
        lv_k = substring( val = lv_row off = ls_sub-offset len = ls_sub-length ).
        READ TABLE lt_keys TRANSPORTING NO FIELDS WITH KEY table_line = lv_k.
        IF sy-subrc <> 0.
          APPEND lv_k TO lt_keys.
        ENDIF.
      ENDLOOP.
    ENDLOOP.

    " V1.0e: 与 MOCK 同契约 {"columns":[{name,label}]}(前端读 .columns)
    LOOP AT lt_keys INTO lv_k.
      lv_seg = |\{"name":"{ lv_k }","label":"{ lv_k }"\}|.
      lv_cols = COND #( WHEN lv_cols IS INITIAL THEN lv_seg
                        ELSE lv_cols && ',' && lv_seg ).
    ENDLOOP.
    ev_schema_json = '{"columns":[' && lv_cols && ']}'.

    " rows 拼接: 样例行按 MAX_ROWS 截断展示, 计数如实(与 MOCK 同语义)
    lv_i = 0.
    LOOP AT lt INTO ls.
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
    " SEL_KIND: P=PARAMETER(单值) / S=SELECT-OPTION(多值/范围/通配)
    " 强制: ZRMM_IDP_0702 → P2='X'(查询模式; P1 上传/P3 删除绝不提交)
    "       + P_FILE 默认值(OBLIGATORY); 所有报表 → P_AICAP/P_RUNID(AI 采集通道)
    " (选择屏上不存在的 selname 会被 SUBMIT 忽略, 不影响其他登记报表)
    TYPES: BEGIN OF ty_prow,
             param_id      TYPE string,
             abap_name     TYPE string,
             sel_kind      TYPE string,
             multi_value   TYPE abap_bool,
             range_allowed TYPE abap_bool,
           END OF ty_prow.
    DATA: lt_p     TYPE STANDARD TABLE OF ty_prow,
          lt_kv    TYPE zcl_ai_report_service=>tt_kv,
          ls_kv    TYPE zcl_ai_report_service=>ty_kv,
          ls_sel   TYPE rsparams,
          lv_sel   TYPE string,
          lv_kind  TYPE string,
          lv_val   TYPE string,
          lt_vals  TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_item  TYPE string,
          lv_lo    TYPE string,
          lv_hi    TYPE string.
    CLEAR: et_seltab, ev_err.

    SELECT SINGLE report_id, config_version FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO ( @DATA(lv_rid), @DATA(lv_ver) ).
    IF sy-subrc <> 0.
      ev_err = '运行记录不存在, 无法定位报表参数定义'.
      RETURN.
    ENDIF.

    " V1.0e: 按运行冻结的配置版本取参数(与 validate_params 同口径, 防多版本重复)
    SELECT param_id, abap_name, sel_kind, multi_value, range_allowed
      FROM zai_rpt_param
      WHERE report_id      = @lv_rid
        AND config_version = @lv_ver
        AND active = 'X'
        AND abap_name <> ''
      INTO TABLE @lt_p.
    IF lt_p IS INITIAL.
      ev_err = |报表 { lv_rid } 未登记任何可执行参数(ABAP_NAME/SEL_KIND 需维护)|.
      RETURN.
    ENDIF.

    " 参数快照 = validate_params 的规范化扁平对象(键 = to_lower(param_id))
    lt_kv = zcl_ai_report_service=>parse_flat_kv( iv_params_json ).

    " 强制参数(先于登记参数): ZRMM_IDP_0702 的 AI 通道只查询
    " V1.0e: 只对 0702 下发(P2/P_FILE 是它的选择屏语义, 不是通用约定)
    IF to_upper( iv_program ) = 'ZRMM_IDP_0702'.
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
    ENDIF.

    " V1.0c: AI 采集通道(程序端 NO-DISPLAY 参数): 开关 + 运行号
    CLEAR ls_sel.
    ls_sel-selname = 'P_AICAP'.
    ls_sel-kind    = 'P'.
    ls_sel-low     = 'X'.
    APPEND ls_sel TO et_seltab.

    CLEAR ls_sel.
    ls_sel-selname = 'P_RUNID'.
    ls_sel-kind    = 'P'.
    ls_sel-low     = iv_report_run_id.
    APPEND ls_sel TO et_seltab.

    " 登记参数: 按 param_id 从参数快照取值, 按 ABAP_NAME/SEL_KIND 提交
    LOOP AT lt_p INTO DATA(ls_p).
      " V1.0d: 快照键已小写, 登记 PARAM_ID/ABAP_NAME 可能大写 → 归一后匹配
      CLEAR ls_kv.
      READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-param_id ).
      IF sy-subrc <> 0.
        READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-abap_name ).
      ENDIF.
      IF sy-subrc <> 0 OR ls_kv-value IS INITIAL.
        CONTINUE.   " 未提交的参数交给程序自身必填校验兜底
      ENDIF.

      lv_sel = to_upper( ls_p-abap_name ).
      CONDENSE lv_sel NO-GAPS.
      lv_kind = to_upper( ls_p-sel_kind ).
      CONDENSE lv_kind NO-GAPS.
      " V1.0e: SUBMIT 不做选择屏的大写转换, 这里按 PAI 默认口径转大写
      lv_val = to_upper( ls_kv-value ).

      IF lv_kind <> 'S'.
        " PARAMETER: 单值原样提交
        CLEAR ls_sel.
        ls_sel-selname = lv_sel.
        ls_sel-kind    = 'P'.
        ls_sel-sign    = 'I'.
        ls_sel-option  = 'EQ'.
        ls_sel-low     = lv_val.
        APPEND ls_sel TO et_seltab.
        CONTINUE.
      ENDIF.

      " SELECT-OPTION: 前端多值/范围用逗号分隔(兼容竖线)
      REPLACE ALL OCCURRENCES OF '|' IN lv_val WITH ','.
      CLEAR lt_vals.
      SPLIT lv_val AT ',' INTO TABLE lt_vals.

      IF ls_p-range_allowed = abap_true AND ls_p-multi_value = abap_false
         AND lines( lt_vals ) = 2.
        " 范围 low,high → BT(只给一端时退化为 GE/LE)
        READ TABLE lt_vals INTO lv_lo INDEX 1.
        READ TABLE lt_vals INTO lv_hi INDEX 2.
        CONDENSE: lv_lo NO-GAPS, lv_hi NO-GAPS.
        CLEAR ls_sel.
        ls_sel-selname = lv_sel.
        ls_sel-kind    = 'S'.
        ls_sel-sign    = 'I'.
        IF lv_lo IS NOT INITIAL AND lv_hi IS NOT INITIAL.
          ls_sel-option = 'BT'.
          ls_sel-low    = lv_lo.
          ls_sel-high   = lv_hi.
        ELSEIF lv_lo IS NOT INITIAL.
          ls_sel-option = 'GE'.
          ls_sel-low    = lv_lo.
        ELSE.
          ls_sel-option = 'LE'.
          ls_sel-low    = lv_hi.
        ENDIF.
        APPEND ls_sel TO et_seltab.
        CONTINUE.
      ENDIF.

      " 多值/单值 → 每项一行 EQ(含 * 或 + 通配 → CP)
      LOOP AT lt_vals INTO lv_item.
        CONDENSE lv_item NO-GAPS.
        IF lv_item IS INITIAL.
          CONTINUE.
        ENDIF.
        CLEAR ls_sel.
        ls_sel-selname = lv_sel.
        ls_sel-kind    = 'S'.
        ls_sel-sign    = 'I'.
        ls_sel-option  = COND #( WHEN lv_item CA '*+' THEN 'CP' ELSE 'EQ' ).
        ls_sel-low     = lv_item.
        APPEND ls_sel TO et_seltab.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.


  METHOD drop_job.
    " 只用于 JOB_OPEN 之后的失败分支: 作业未释放, 删除不影响任何业务数据
    CALL FUNCTION 'BP_JOB_DELETE'
      EXPORTING
        jobcount = iv_jobcnt
        jobname  = iv_jobname
      EXCEPTIONS
        OTHERS   = 1.
    IF sy-subrc <> 0.
      " 删除失败不影响本次结论(仍判提交失败), SM37 可人工清理
      RETURN.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
