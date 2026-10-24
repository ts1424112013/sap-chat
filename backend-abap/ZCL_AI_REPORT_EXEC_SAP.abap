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
* V1.0f   20261015: JOB_CLOSE 回收 JOB_WAS_RELEASED —— 调用用户没有释放权限
*         (S_BTCH_JOB JOBACTION=RELE / S_BTCH_ADM)时 JOB_CLOSE 不抛异常, 只把
*         作业留在"已计划(P)", 原先仍提示"已立即启动"; 现判失败、删除空作业,
*         消息写明缺哪个权限
* V1.1    20261021: ALV 通用采集 —— 报表程序零改动 ——
*         ① 作业步骤由「直接 SUBMIT 业务报表(靠程序端 P_AICAP/P_RUNID 落表)」
*         改为 SUBMIT ZAI_RPT_RUNNER(SE38); 运行器在作业内调 run_captured:
*         读运行记录 -> build_seltab -> ZCL_AI_ALV_CAPTURE=>run(SUBMIT 业务报表
*         AND RETURN, 抑制 ALV 显示, 取回 ALV 输出表) -> 写 ZAI_RPT_RESULT;
*         ② ZAI_RPT_RESULT 约定: LINE_INDEX=0 为元数据行({"__meta__":true,
*         "total","stored","note","columns":[...]}, columns 在最后), 1.. 为数据行;
*         read_result 见元数据行就用其列标题/总行数, 没有(旧程序端落表)走原逻辑;
*         ③ poll: 作业完成(F)但运行记录 ERROR_CODE=CAPTURE → FAILED(采集阶段
*         失败原因由运行器写入 ERROR_MESSAGE, 前端步骤条直接显示);
*         ④ 回退开关 ZAI_CHAT_CFG 键 RPT_CAPTURE_LEGACY='X'(V1.1a 起) → 仍走旧口径
*         (直接 SUBMIT 业务报表 + P_RUNID, 要求程序端有 ai_capture);
*         ⑤ P_AICAP='X' 仍下发(无该参数的程序自动忽略), 程序可选用它把空数据/缺参
*         的 MESSAGE 升级为 TYPE 'E' 让作业取消; P_RUNID 只在回退口径下发
*         (新口径下 ZRMM_IDP_0702 的 ai_capture 因 P_RUNID 为空自动失效, 不会双写)
* V1.1a   20261022: 回退开关键名改为 RPT_CAPTURE_LEGACY(18 字符) —— 原键
*         REPORT_CAPTURE_LEGACY 21 字符, 超过 ZAI_CHAT_CFG-CFGKEY 的 CHAR 20,
*         read_cfg_str 的 OPEN SQL 抛 CX_SY_OPEN_SQL_DATA_ERROR, 无人捕获
*         → StartReportRun 恒报 HTTP 500(10-22 部署实锤: /IWFND/ERROR_LOG
*         ERROR_INFO "REPORT_CAPTURE_LEGACY 不是 C(20,0) 的有效值");
*         SM30 输入超长键会被静默截成 20 位, 不会提示。配置键一律 <= 20 字符
* V1.1b   20261024(10.24 记录 #03a): build_seltab 支持报表选择项(SEL_KIND R / C / F,
*         登记口径见 ZCL_AI_REPORT_SERVICE V1.0.13):
*         ① R 单选组: 组内每个单选按钮都明确下发(选中 'X', 其余空格), 不依赖程序
*           DEFAULT —— 原先只能下发 'X', 程序里 DEFAULT 'X' 的按钮关不掉, 同组两个 X;
*           值不在登记选项里 → 报错不提交(快照已过 validate_params, 这里再拦一次)
*         ② C 复选框: 快照里有就一定下发('X' / 空格), 用户取消勾选才能盖掉 DEFAULT 'X'
*         ③ F 固定值: 不看用户参数, 按 ALLOWED_OPS 登记值下发(空 = 空格), 如 0003C
*           输出方式组强制 P_ALV; ZRMM_IDP_0702 的 P2 / P_FILE 仍按原硬编码下发(不动)
* ★ 重贴后核对标记: JOB_CLOSE 处 strtimmed = 'X'; 两处 JOB_CLOSE 都有
*   job_was_released = lv_released; 全文无 SUBMIT (iv_program);
*   read_result 输出以 {"columns": 开头; submit 内有 lv_runner / ZAI_RPT_RUNNER;
*   PUBLIC SECTION 有 run_captured; submit 内是 read_cfg_str( 'RPT_CAPTURE_LEGACY' );
*   V1.1b: build_seltab 的 SELECT 含 allowed_ops, 有 zcl_ai_report_service=>parse_options(
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

    " V1.1: 后台作业入口(ZAI_RPT_RUNNER 调用)。读运行记录 -> 采集 ALV -> 落 ZAI_RPT_RESULT;
    " 失败原因写 ZAI_RPT_RUN.ERROR_CODE='CAPTURE' / ERROR_MESSAGE, 由 poll 判 FAILED
    CLASS-METHODS run_captured
      IMPORTING iv_report_run_id TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS build_seltab
      IMPORTING iv_report_run_id TYPE string
                iv_program       TYPE string
                iv_params_json   TYPE string
                iv_legacy        TYPE abap_bool DEFAULT abap_false
      EXPORTING et_seltab        TYPE rsparams_tt
                ev_err           TYPE string.

    CLASS-METHODS fail_run
      IMPORTING iv_report_run_id TYPE string
                iv_message       TYPE string.

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
          lv_sdltime TYPE tbtcjob-sdlstrttm,
          lv_released TYPE btch0000-char1,
          lv_legacy  TYPE abap_bool,
          lv_runner  TYPE progname VALUE 'ZAI_RPT_RUNNER',
          lv_rexists TYPE trdir-name,
          lt_rsel    TYPE rsparams_tt,
          ls_rsel    TYPE rsparams.
    CLEAR: ev_status, ev_message.

    " V1.0a: SUBMIT 动态程序名必须是字符型定长(PROGNAME), 不能用 string
    lv_prog = to_upper( iv_program ).
    IF lv_prog IS INITIAL.
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = '报表登记缺少程序名(ZAI_RPT_DEF.PROGNAME), 本次未提交'.
      RETURN.
    ENDIF.

    " V1.1: 默认走通用 ALV 采集(作业步骤 = ZAI_RPT_RUNNER); 回退键='X' 走旧口径
    " V1.1a: 键名必须 <= 20 字符(CFGKEY CHAR 20), 超长 OPEN SQL 直接抛异常
    lv_legacy = xsdbool( zcl_ai_task_service=>read_cfg_str( 'RPT_CAPTURE_LEGACY' ) = 'X' ).
    IF lv_legacy = abap_false.
      SELECT SINGLE name FROM trdir
        WHERE name = @lv_runner
        INTO @lv_rexists.
      IF sy-subrc <> 0.
        ev_status  = zcl_ai_report_service=>gc_run_failed.
        ev_message = 'ALV 采集运行器程序 ZAI_RPT_RUNNER 未部署(SE38 新建), 本次未提交'.
        RETURN.
      ENDIF.
    ENDIF.

    " V1.0e: 先构建选择参数再开作业 —— 参数失败时不在 SM37 留下空作业
    " V1.1: 新口径下选择参数由运行器在作业内重建; 这里仍先建一遍只为提前拦错
    build_seltab(
      EXPORTING iv_report_run_id = iv_report_run_id
                iv_program       = iv_program
                iv_params_json   = iv_params_json
                iv_legacy        = lv_legacy
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
    " V1.1: 新口径作业步骤是运行器, 只带运行号; 业务报表名/参数由运行器读运行记录
    IF lv_legacy = abap_true.
      SUBMIT (lv_prog) VIA JOB lv_jobname NUMBER lv_jobcnt
        WITH SELECTION-TABLE lt_seltab
        AND RETURN.
    ELSE.
      CLEAR ls_rsel.
      ls_rsel-selname = 'P_RUNID'.
      ls_rsel-kind    = 'P'.
      ls_rsel-sign    = 'I'.
      ls_rsel-option  = 'EQ'.
      ls_rsel-low     = iv_report_run_id.
      APPEND ls_rsel TO lt_rsel.
      SUBMIT (lv_runner) VIA JOB lv_jobname NUMBER lv_jobcnt
        WITH SELECTION-TABLE lt_rsel
        AND RETURN.
    ENDIF.
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
      IMPORTING
        job_was_released     = lv_released
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
        IMPORTING
          job_was_released  = lv_released
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

    " V1.0f: 无释放权限时 JOB_CLOSE 正常返回但作业停在 P(不会自己运行)
    IF lv_released IS INITIAL.
      drop_job( iv_jobname = lv_jobname iv_jobcnt = lv_jobcnt ).
      ev_status  = zcl_ai_report_service=>gc_run_failed.
      ev_message = |作业未能释放: 用户 { sy-uname } 缺少后台作业释放权限 | &&
                   |(S_BTCH_JOB JOBACTION=RELE 或 S_BTCH_ADM), 已撤销该作业, 请联系 Basis 授权|.
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
    ELSEIF lv_legacy = abap_true.
      ev_message = |已提交真实作业 { lv_jobname }/{ lv_jobcnt }(立即启动, 程序端自动落结果表)|.
    ELSE.
      ev_message = |已提交真实作业 { lv_jobname }/{ lv_jobcnt }(立即启动, 作业内自动采集 ALV 结果)|.
    ENDIF.
  ENDMETHOD.


  METHOD poll.
    " 状态回查: TBTCO 直查 —— P=已计划(未释放) S=已释放 Y=就绪 Z=已释放挂起
    "           R=运行中 F=完成 A=取消
    " TIMEOUT 语义不变: RUNNING 只表示未到终态, 不代表作业已停止
    DATA: lv_jobname TYPE zai_rpt_run-sap_job_name,
          lv_jobcnt  TYPE zai_rpt_run-sap_job_number,
          lv_sts     TYPE tbtco-status,
          lv_ecode   TYPE zai_rpt_run-error_code.
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
        " V1.1: 作业正常结束不等于采集成功 —— 运行器把采集阶段的失败写在
        " ZAI_RPT_RUN.ERROR_CODE='CAPTURE'(旧口径无此标记, 照原逻辑判 READY)
        SELECT SINGLE error_code FROM zai_rpt_run
          WHERE report_run_id = @iv_report_run_id
          INTO @lv_ecode.
        IF sy-subrc = 0 AND lv_ecode = 'CAPTURE'.
          ev_status  = zcl_ai_report_service=>gc_run_failed.
          ev_message = 'ALV 结果采集失败(见运行记录 ERROR_MESSAGE)'.
        ELSE.
          ev_status = zcl_ai_report_service=>gc_run_ready.
        ENDIF.
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
          ls_sub    TYPE submatch_result,
          lv_meta   TYPE string,
          lv_has_meta TYPE abap_bool,
          lv_tot_s  TYPE string,
          lv_note   TYPE string,
          lv_total  TYPE i,
          lv_stored TYPE i,
          lv_trunc  TYPE string,
          lv_moff   TYPE i,
          lv_mlen   TYPE i,
          lv_mstart TYPE i,
          lv_mclen  TYPE i,
          lv_mcols  TYPE string,
          ls        TYPE zai_rpt_result.
    CLEAR: ev_schema_json, ev_summary_json, ev_rows_json, ev_row_count, ev_message.

    SELECT SINGLE sap_job_name FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO @DATA(lv_jobname).

    SELECT * FROM zai_rpt_result
      WHERE run_id = @iv_report_run_id
      ORDER BY line_index
      INTO TABLE @DATA(lt).

    " V1.1: 通用采集写的元数据行(LINE_INDEX 最小的那行, 键 __meta__)先摘出来,
    " 数据行计数/样例都不含它; 没有元数据行 = 旧程序端落表, 走下面原逻辑
    lv_has_meta = abap_false.
    READ TABLE lt INTO DATA(ls_first) INDEX 1.
    IF sy-subrc = 0 AND ls_first-row_json CP '{"__meta__"*'.
      lv_meta     = ls_first-row_json.
      lv_has_meta = abap_true.
      DELETE lt INDEX 1.
    ENDIF.
    lv_stored    = lines( lt ).
    ev_row_count = lv_stored.

    IF lv_has_meta = abap_true.
      FIND REGEX '"total":(\d+)' IN lv_meta SUBMATCHES lv_tot_s.
      IF sy-subrc = 0 AND lv_tot_s IS NOT INITIAL.
        lv_total = lv_tot_s.
      ELSE.
        lv_total = lv_stored.
      ENDIF.
      ev_row_count = lv_total.
      FIND REGEX '"note":"((?:[^"\\]|\\.)*)"' IN lv_meta SUBMATCHES lv_note.

      " columns 是元数据行最后一个键: 取 "columns": 之后到末尾 } 之前的数组原文
      FIND '"columns":' IN lv_meta MATCH OFFSET lv_moff MATCH LENGTH lv_mlen.
      IF sy-subrc = 0.
        lv_mstart = lv_moff + lv_mlen.
        lv_mclen  = strlen( lv_meta ) - lv_mstart - 1.
        IF lv_mclen > 0.
          lv_mcols = substring( val = lv_meta off = lv_mstart len = lv_mclen ).
        ENDIF.
      ENDIF.
      IF lv_mcols IS INITIAL.
        lv_mcols = '[]'.
      ENDIF.
      ev_schema_json = '{"columns":' && lv_mcols && '}'.
    ENDIF.

    " schema: 每行 JSON 的键并集(按首次出现顺序; 键 = 程序字段名大写)
    " V1.0b: 子匹配只有偏移/长度, 必须按偏移从原串截取
    " V1.1: 有元数据行时列已定(含 ALV 列标题), 不再逐行扫键
    IF lv_has_meta = abap_false.
      LOOP AT lt INTO ls.
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
    ENDIF.

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

    IF lv_has_meta = abap_true.
      " V1.1: 总行数以采集到的 ALV 总数为准; 入库行数封顶时 truncated=true;
      " note 非空 = 报表没走到 ALV(无数据 / 无权限 STOP / 提前结束), 供前端与模型如实说明
      lv_trunc = COND #( WHEN lv_total > lv_stored THEN `true` ELSE `false` ).
      ev_summary_json = |\{"total_rows":{ lv_total },"stored_rows":{ lv_stored },| &&
                        |"truncated":{ lv_trunc },"note":"{ lv_note }","source":"JOB { lv_jobname }"\}|.
    ELSE.
      ev_summary_json = |\{"total_rows":{ ev_row_count },"source":"JOB { lv_jobname }"\}|.
    ENDIF.
  ENDMETHOD.


  METHOD build_seltab.
    " 选择参数构建: selname = ZAI_RPT_PARAM.ABAP_NAME(必须与程序参数名一致)
    " SEL_KIND: P=PARAMETER(单值) / S=SELECT-OPTION(多值/范围/通配)
    "   V1.1b: R=单选组(组内按钮全下发) / C=复选框(X 或空格) / F=固定值(ALLOWED_OPS)
    " 强制: ZRMM_IDP_0702 → P2='X'(查询模式; P1 上传/P3 删除绝不提交)
    "       + P_FILE 默认值(OBLIGATORY); 所有报表 → P_AICAP/P_RUNID(AI 采集通道)
    " (选择屏上不存在的 selname 会被 SUBMIT 忽略, 不影响其他登记报表)
    TYPES: BEGIN OF ty_prow,
             param_id      TYPE string,
             abap_name     TYPE string,
             sel_kind      TYPE string,
             multi_value   TYPE abap_bool,
             range_allowed TYPE abap_bool,
             allowed_ops   TYPE string,     " V1.1b: R 选项 / C 默认 / F 固定值
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
    SELECT param_id, abap_name, sel_kind, multi_value, range_allowed, allowed_ops
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

    " V1.1: P_RUNID 只在回退口径(LEGACY)下发 —— 新口径由运行器统一落表,
    " 不下发即让程序端旧 ai_capture(P_RUNID 为空直接 RETURN)自动失效, 避免双写
    IF iv_legacy = abap_true.
      CLEAR ls_sel.
      ls_sel-selname = 'P_RUNID'.
      ls_sel-kind    = 'P'.
      ls_sel-low     = iv_report_run_id.
      APPEND ls_sel TO et_seltab.
    ENDIF.

    " 登记参数: 按 param_id 从参数快照取值, 按 ABAP_NAME/SEL_KIND 提交
    LOOP AT lt_p INTO DATA(ls_p).
      lv_sel = to_upper( ls_p-abap_name ).
      CONDENSE lv_sel NO-GAPS.
      lv_kind = to_upper( ls_p-sel_kind ).
      CONDENSE lv_kind NO-GAPS.

      " V1.1b: 固定值(F) —— 不看用户参数, 按登记值下发(空 = 空格)
      IF lv_kind = 'F'.
        CLEAR ls_sel.
        ls_sel-selname = lv_sel.
        ls_sel-kind    = 'P'.
        ls_sel-sign    = 'I'.
        ls_sel-option  = 'EQ'.
        ls_sel-low     = condense( ls_p-allowed_ops ).
        APPEND ls_sel TO et_seltab.
        CONTINUE.
      ENDIF.

      " V1.0d: 快照键已小写, 登记 PARAM_ID/ABAP_NAME 可能大写 → 归一后匹配
      CLEAR ls_kv.
      READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-param_id ).
      IF sy-subrc <> 0.
        READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-abap_name ).
      ENDIF.
      DATA(lv_found) = xsdbool( sy-subrc = 0 ).

      " V1.1b: 复选框(C) —— 快照里有就一定下发('X' / 空格), 取消勾选才能盖掉程序 DEFAULT 'X'
      IF lv_kind = 'C'.
        IF lv_found = abap_true.
          CLEAR ls_sel.
          ls_sel-selname = lv_sel.
          ls_sel-kind    = 'P'.
          ls_sel-sign    = 'I'.
          ls_sel-option  = 'EQ'.
          ls_sel-low     = COND #( WHEN to_upper( ls_kv-value ) = 'X' THEN 'X' ELSE space ).
          APPEND ls_sel TO et_seltab.
        ENDIF.
        CONTINUE.
      ENDIF.

      IF lv_found = abap_false OR ls_kv-value IS INITIAL.
        CONTINUE.   " 未提交的参数交给程序自身必填校验兜底(单选组没选 = 保持程序默认)
      ENDIF.

      " V1.1b: 单选组(R) —— 组内每个按钮都明确下发(选中 'X', 其余空格), 不依赖程序默认
      IF lv_kind = 'R'.
        DATA(lt_opt) = zcl_ai_report_service=>parse_options( ls_p-allowed_ops ).
        lv_val = to_upper( ls_kv-value ).
        CONDENSE lv_val NO-GAPS.
        IF NOT line_exists( lt_opt[ name = lv_val ] ).
          ev_err = |单选组 { ls_p-param_id } 的值 { lv_val } 不在登记的选项里, 本次未提交|.
          RETURN.
        ENDIF.
        LOOP AT lt_opt INTO DATA(ls_opt).
          CLEAR ls_sel.
          ls_sel-selname = ls_opt-name.
          ls_sel-kind    = 'P'.
          ls_sel-sign    = 'I'.
          ls_sel-option  = 'EQ'.
          ls_sel-low     = COND #( WHEN ls_opt-name = lv_val THEN 'X' ELSE space ).
          APPEND ls_sel TO et_seltab.
        ENDLOOP.
        CONTINUE.
      ENDIF.
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


  METHOD run_captured.
    " 作业内执行(ZAI_RPT_RUNNER -> 这里): 程序名/参数只信运行记录(创建时已冻结),
    " 并复核登记与归属 —— 手工运行运行器也无法借它跑任意程序或别人的运行
    CONSTANTS lc_max_store TYPE i VALUE 20000.
    DATA: ls_run    TYPE zai_rpt_run,
          lv_prog   TYPE progname,
          lv_defprog TYPE zai_rpt_def-progname,
          lt_seltab TYPE rsparams_tt,
          lv_err    TYPE string,
          lv_captured TYPE abap_bool,
          lv_total  TYPE i,
          lt_cols   TYPE zcl_ai_alv_capture=>tt_col,
          lt_rows   TYPE string_table,
          lv_seg    TYPE string,
          lv_cols   TYPE string,
          lv_note   TYPE string,
          lv_meta   TYPE string,
          lv_total_s TYPE string,
          lv_stored_s TYPE string,
          lt_res    TYPE STANDARD TABLE OF zai_rpt_result,
          ls_res    TYPE zai_rpt_result,
          lv_idx    TYPE i,
          lv_row    TYPE string.

    SELECT SINGLE * FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO @ls_run.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    IF ls_run-created_by <> sy-uname.
      fail_run( iv_report_run_id = iv_report_run_id
                iv_message       = '运行不属于当前作业用户, 已拒绝采集' ).
      RETURN.
    ENDIF.

    lv_prog = to_upper( ls_run-progname ).
    SELECT SINGLE progname FROM zai_rpt_def
      WHERE report_id = @ls_run-report_id
        AND active = 'X'
        AND exec_enabled = 'X'
      INTO @lv_defprog.
    IF sy-subrc <> 0 OR lv_prog IS INITIAL OR to_upper( lv_defprog ) <> lv_prog.
      fail_run( iv_report_run_id = iv_report_run_id
                iv_message       = '报表登记已停用 / 未开放执行 / 程序名与登记不一致, 已拒绝采集' ).
      RETURN.
    ENDIF.

    build_seltab(
      EXPORTING iv_report_run_id = iv_report_run_id
                iv_program       = CONV string( ls_run-progname )
                iv_params_json   = ls_run-params_json
                iv_legacy        = abap_false
      IMPORTING et_seltab        = lt_seltab
                ev_err           = lv_err ).
    IF lv_err IS NOT INITIAL.
      fail_run( iv_report_run_id = iv_report_run_id
                iv_message       = |选择参数构建失败: { lv_err }| ).
      RETURN.
    ENDIF.

    zcl_ai_alv_capture=>run(
      EXPORTING iv_program  = lv_prog
                it_seltab   = lt_seltab
                iv_max_rows = lc_max_store
      IMPORTING ev_captured = lv_captured
                ev_total    = lv_total
                et_cols     = lt_cols
                et_rows     = lt_rows
                ev_error    = lv_err ).
    IF lv_err IS NOT INITIAL.
      fail_run( iv_report_run_id = iv_report_run_id
                iv_message       = lv_err ).
      RETURN.
    ENDIF.

    IF lv_captured = abap_false.
      lv_note = '报表没有输出 ALV 数据: 可能是该条件下无数据、无工厂/组织权限被程序拦截、或程序提前结束(详见 SM37 作业日志)'.
    ENDIF.

    LOOP AT lt_cols INTO DATA(ls_col).
      lv_seg = '{"name":"' && zcl_ai_report_service=>json_escape( ls_col-name ) &&
               '","label":"' && zcl_ai_report_service=>json_escape( ls_col-label ) && '"}'.
      lv_cols = COND #( WHEN lv_cols IS INITIAL THEN lv_seg
                        ELSE lv_cols && ',' && lv_seg ).
    ENDLOOP.

    lv_total_s  = |{ lv_total }|.
    lv_stored_s = |{ lines( lt_rows ) }|.
    lv_meta = '{"__meta__":true,"total":' && lv_total_s &&
              ',"stored":' && lv_stored_s &&
              ',"note":"' && zcl_ai_report_service=>json_escape( lv_note ) &&
              '","columns":[' && lv_cols && ']}'.

    CLEAR ls_res.
    ls_res-mandt      = sy-mandt.
    ls_res-run_id     = iv_report_run_id.
    ls_res-line_index = 0.
    ls_res-row_json   = lv_meta.
    APPEND ls_res TO lt_res.

    LOOP AT lt_rows INTO lv_row.
      lv_idx = lv_idx + 1.
      CLEAR ls_res.
      ls_res-mandt      = sy-mandt.
      ls_res-run_id     = iv_report_run_id.
      ls_res-line_index = lv_idx.
      ls_res-row_json   = lv_row.
      APPEND ls_res TO lt_res.
    ENDLOOP.

    DELETE FROM zai_rpt_result WHERE run_id = @iv_report_run_id.
    INSERT zai_rpt_result FROM TABLE @lt_res.
    IF sy-subrc <> 0.
      ROLLBACK WORK.
      fail_run( iv_report_run_id = iv_report_run_id
                iv_message       = '采集结果写入 ZAI_RPT_RESULT 失败' ).
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.

    zcl_ai_report_mock=>add_step(
      iv_report_run_id = iv_report_run_id
      iv_task_id       = CONV string( ls_run-task_id )
      iv_phase         = 'CAPTURE'
      iv_status        = 'OK'
      iv_summary       = |ALV 采集: 捕获={ lv_captured } 总行数={ lv_total } 入库={ lv_stored_s } 列={ lines( lt_cols ) }| ).
  ENDMETHOD.


  METHOD fail_run.
    DATA lv_msg TYPE zai_rpt_run-error_message.
    lv_msg = iv_message.
    DELETE FROM zai_rpt_result WHERE run_id = @iv_report_run_id.
    UPDATE zai_rpt_run SET error_code    = 'CAPTURE',
                           error_message = @lv_msg
      WHERE report_run_id = @iv_report_run_id.
    COMMIT WORK.
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
