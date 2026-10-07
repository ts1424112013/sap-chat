*=======================================================================
* 对象:   ZCL_AI_REPORT_MOCK
* 用途:   报表执行 Mock 适配器(测试 double; 《Agent多业务任务与报表分析》P3)
*         - 在没有真实 SAP 作业接口与真实结果表之前, 提供与生产适配器
*           契约一致的 Mock 闭环: 创建/排队/运行/成功/空结果/失败/超时/
*           未知状态/结果过期/重复请求
*         - 状态机确定性推进: submit 记录起点与场景, poll 按到时推进;
*           场景由参数快照中的 mock_scenario 键决定(默认 SUCCESS),
*           mock_delay_sec 控制时长(默认 5s, 测试可设 0)
*         - 结果是确定性 Mock 数据(标注 MOCK), 不是真实业务数据;
*           Mock 不能证明真实 SAP 权限、后台作业和结果锁正确
* 重要:   这是测试 double。真实适配器(ZCL_AI_REPORT_EXEC_SAP, SUBMIT
*         VIA JOB + WITH SELECTION-TABLE + 结果表关联)是 SAP 端阻塞项;
*         接口(方法签名/状态语义)保持一致, 届时只替换调用点。
* 状态语义(与 REPORT_SERVICE 一致):
*         - TIMEOUT 只表示"超过预期时长", 不代表作业已停止
*         - UNKNOWN 表示状态来源不可信(如网关失联), 需继续轮询/人工核对
*         - 空结果(0 行)是有效业务事实, 状态仍为 READY
* 数据:   ZAI_RPT_STEP(阶段审计); 场景与时间线在内存(重启即丢失,
*         丢失后如实返回 UNKNOWN, 不伪造状态)
* 依赖:   无(纯测试 double)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50)
* V1.0    20261007: 首版
* V1.0.1  20261007: 踩坑清单自查修正 —— read_scenario 弃用
*         /ui2/cl_json=>name_values/generate, 复用
*         zcl_ai_report_service=>parse_flat_kv(已部署正则模式)
* ★ 重贴后核对标记: read_scenario 应调用 zcl_ai_report_service=>parse_flat_kv;
*   激活顺序: ZCL_AI_REPORT_SERVICE 必须先于本类(常量+解析器依赖)
*=======================================================================
CLASS zcl_ai_report_mock DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " 场景常量(由参数快照的 mock_scenario 键选择)
    CONSTANTS: BEGIN OF gc_scn,
                 success TYPE string VALUE 'SUCCESS',
                 empty   TYPE string VALUE 'EMPTY',
                 fail    TYPE string VALUE 'FAIL',
                 timeout TYPE string VALUE 'TIMEOUT',
                 unknown TYPE string VALUE 'UNKNOWN',
                 expired TYPE string VALUE 'EXPIRED',
               END OF gc_scn.

    " 提交运行(Mock: 记录场景与起点, 返回 SUBMITTED;
    " 真实适配器: SUBMIT VIA JOB 后返回 SUBMITTED + 作业号)
    CLASS-METHODS submit
      IMPORTING iv_report_run_id TYPE string
                iv_program       TYPE string
                iv_params_json   TYPE string
                iv_user          TYPE string
      EXPORTING ev_status        TYPE string
                ev_message       TYPE string.

    " 轮询推进状态机(未终态才调用; 每次推进一步)
    CLASS-METHODS poll
      IMPORTING iv_report_run_id TYPE string
      EXPORTING ev_status        TYPE string
                ev_message       TYPE string.

    " 读取受控结果(schema/摘要/受限样例; 场景决定内容)
    CLASS-METHODS read_result
      IMPORTING iv_report_run_id TYPE string
                iv_max_rows      TYPE i
      EXPORTING ev_schema_json   TYPE string
                ev_summary_json  TYPE string
                ev_rows_json     TYPE string
                ev_row_count     TYPE i
                ev_message       TYPE string.  " EXPIRED = 结果已过期

    " 阶段审计(RESOLVE/VALIDATE/SUBMIT/POLL/RESULT/ANALYZE)
    CLASS-METHODS add_step
      IMPORTING iv_report_run_id TYPE string
                iv_task_id       TYPE string
                iv_phase         TYPE string
                iv_status        TYPE string
                iv_summary       TYPE string.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_run,
             report_run_id TYPE string,
             scenario      TYPE string,
             delay_sec     TYPE i,
             start_ust     TYPE i,      " GET RUN TIME 起点(本会话内有效)
             started       TYPE abap_bool,
             poll_count    TYPE i,
           END OF ty_run.

    " 内存场景表(重启丢失 → poll 如实返回 UNKNOWN)
    CLASS-DATA gt_runs TYPE STANDARD TABLE OF ty_run WITH DEFAULT KEY.

    " 从参数快照读场景与延迟(默认 SUCCESS / 5s)
    CLASS-METHODS read_scenario
      IMPORTING iv_params_json TYPE string
      EXPORTING ev_scenario    TYPE string
                ev_delay_sec   TYPE i.

    " 确定性 Mock 结果行(JSON; 数量随场景: SUCCESS=12, EMPTY=0)
    CLASS-METHODS build_rows
      IMPORTING iv_scenario TYPE string
                iv_max_rows TYPE i
      EXPORTING ev_rows     TYPE string
                ev_count    TYPE i
                ev_summary  TYPE string.

ENDCLASS.



CLASS zcl_ai_report_mock IMPLEMENTATION.


  METHOD submit.

    CLEAR: ev_status, ev_message.

    DATA: lv_scn TYPE string, lv_delay TYPE i.
    read_scenario( EXPORTING iv_params_json = iv_params_json
                   IMPORTING ev_scenario = lv_scn ev_delay_sec = lv_delay ).

    GET RUN TIME FIELD DATA(lv_t0).
    INSERT VALUE #( report_run_id = iv_report_run_id
                    scenario      = lv_scn
                    delay_sec     = lv_delay
                    start_ust     = lv_t0
                    started       = abap_true ) INTO TABLE gt_runs.

    " Mock 不做任何真实执行, 只进入排队态; 消息明确标注 MOCK
    ev_status = zcl_ai_report_service=>gc_run_submitted.
    ev_message = |已提交(Mock 适配器, 场景 { lv_scn }, 预计 { lv_delay }s); | &&
                 |Mock 不能证明真实 SAP 权限与后台作业行为|.

    add_step( iv_report_run_id = iv_report_run_id iv_task_id = ''
              iv_phase = 'SUBMIT' iv_status = 'OK'
              iv_summary = |Mock 作业已登记(场景 { lv_scn })| ).

  ENDMETHOD.


  METHOD poll.

    CLEAR: ev_status, ev_message.

    READ TABLE gt_runs INTO DATA(ls_run)
      WITH KEY report_run_id = iv_report_run_id.
    IF sy-subrc <> 0.
      " Mock 进程重启导致内存丢失: 如实返回 UNKNOWN(状态来源不可信),
      " 绝不伪造完成/失败
      ev_status  = zcl_ai_report_service=>gc_run_unknown.
      ev_message = 'Mock 状态已丢失(进程重启), 需继续轮询或人工核对'.
      RETURN.
    ENDIF.

    DATA(lv_idx) = sy-tabix.
    ls_run-poll_count = ls_run-poll_count + 1.
    GET RUN TIME FIELD DATA(lv_t1).
    DATA(lv_elapsed_s) = ( lv_t1 - ls_run-start_ust ) / 1000000.

    IF lv_elapsed_s < ls_run-delay_sec.
      " 仍在运行(或排队); 未到时不给出终态
      ev_status  = zcl_ai_report_service=>gc_run_running.
      ev_message = |运行中(Mock, 已 { lv_elapsed_s }s / 预计 { ls_run-delay_sec }s)|.
      MODIFY gt_runs FROM ls_run INDEX lv_idx.
      RETURN.
    ENDIF.

    " 到时 → 按场景终态
    CASE ls_run-scenario.
      WHEN gc_scn-success.
        ev_status  = zcl_ai_report_service=>gc_run_ready.
        ev_message = '运行完成(Mock), 结果已生成'.
      WHEN gc_scn-empty.
        ev_status  = zcl_ai_report_service=>gc_run_ready.
        ev_message = '运行完成(Mock): 0 行结果是有效业务事实, 不是失败'.
      WHEN gc_scn-fail.
        ev_status  = zcl_ai_report_service=>gc_run_failed.
        ev_message = '运行失败(Mock): 模拟作业取消/转储(脱敏错误码 MOCK_JOB_FAIL)'.
      WHEN gc_scn-timeout.
        ev_status  = zcl_ai_report_service=>gc_run_timeout.
        ev_message = |超过预期时长(Mock); 超时非终态、不等于作业已终止, 需核对作业状态|.
      WHEN gc_scn-unknown.
        ev_status  = zcl_ai_report_service=>gc_run_unknown.
        ev_message = '作业状态未知(Mock: 模拟状态来源不可信), 需继续轮询或人工核对'.
        " UNKNOWN 非终态: 保持内存记录, 下次 poll 仍按到时返回终态候选;
        " 这里固定返回 UNKNOWN 以模拟持续失联
        MODIFY gt_runs FROM ls_run INDEX lv_idx.
        RETURN.
      WHEN gc_scn-expired.
        ev_status  = zcl_ai_report_service=>gc_run_ready.
        ev_message = '运行完成(Mock); 结果标记为即将过期(场景 EXPIRED)'.
      WHEN OTHERS.
        ev_status  = zcl_ai_report_service=>gc_run_unknown.
        ev_message = 'Mock 场景未注册, 状态未知'.
    ENDCASE.

    MODIFY gt_runs FROM ls_run INDEX lv_idx.

  ENDMETHOD.


  METHOD read_result.

    CLEAR: ev_schema_json, ev_summary_json, ev_rows_json,
           ev_row_count, ev_message.

    DATA: lv_scn TYPE string VALUE zcl_ai_report_mock=>gc_scn-success.
    READ TABLE gt_runs INTO DATA(ls_run)
      WITH KEY report_run_id = iv_report_run_id.
    IF sy-subrc = 0.
      lv_scn = ls_run-scenario.
    ENDIF.

    IF lv_scn = gc_scn-expired.
      " EXPIRED 场景: 结果已过期(不可读; 只读不删除, 来源与原因可见)
      ev_message = 'EXPIRED'.
      RETURN.
    ENDIF.

    " schema 固定三列(标注 MOCK 来源)
    ev_schema_json =
      '{"columns":[' &&
      '{"name":"PLANT","label":"工厂(MOCK)","type":"CHAR"},' &&
      '{"name":"MATERIAL","label":"物料(MOCK)","type":"CHAR"},' &&
      '{"name":"QTY","label":"数量(MOCK)","type":"NUM"}]}'.

    build_rows( EXPORTING iv_scenario = lv_scn
                          iv_max_rows = iv_max_rows
                IMPORTING ev_rows = ev_rows_json ev_count = ev_row_count
                          ev_summary = ev_summary_json ).

  ENDMETHOD.


  METHOD add_step.

    " 阶段审计(表不存在时 INSERT 失败属部署问题, 不吞异常 —— 让
    " 激活/运行时报错暴露缺失的 SE11 对象)
    DATA lv_no TYPE i.
    SELECT MAX( step_no ) FROM zai_rpt_step
      WHERE report_run_id = @iv_report_run_id
      INTO @lv_no.

    INSERT zai_rpt_step FROM @(
      VALUE #( mandt         = sy-mandt
               report_run_id = iv_report_run_id
               task_id       = iv_task_id
               step_no       = lv_no + 1
               phase         = iv_phase
               status        = iv_status
               safe_summary  = iv_summary
               created_at    = |{ sy-datum }{ sy-uzeit }| ) ).
    COMMIT WORK.

  ENDMETHOD.


  METHOD read_scenario.

    CLEAR: ev_scenario, ev_delay_sec.
    ev_scenario  = gc_scn-success.
    ev_delay_sec = 5.

    " 参数快照是后端规范化 JSON(扁平对象, 键小写): 从中读
    " mock_scenario / mock_delay_sec(这两个键是 Mock 专用登记参数,
    " 真实报表不应包含)。解析复用 REPORT_SERVICE.parse_flat_kv
    " (已部署验证的正则模式, 不依赖 /ui2/cl_json name_values)
    DATA: lt_kv TYPE zcl_ai_report_service=>tt_kv.
    IF iv_params_json IS NOT INITIAL.
      lt_kv = zcl_ai_report_service=>parse_flat_kv( iv_params_json ).
      READ TABLE lt_kv INTO DATA(ls_kv) WITH KEY name = 'mock_scenario'.
      IF sy-subrc = 0 AND ls_kv-value IS NOT INITIAL.
        DATA(lv_up) = to_upper( ls_kv-value ).
        CASE lv_up.
          WHEN gc_scn-success OR gc_scn-empty OR gc_scn-fail
            OR gc_scn-timeout OR gc_scn-unknown OR gc_scn-expired.
            ev_scenario = lv_up.
          WHEN OTHERS.
            " 未注册场景 → 按 SUCCESS(并保持确定性)
        ENDCASE.
      ENDIF.
      READ TABLE lt_kv INTO ls_kv WITH KEY name = 'mock_delay_sec'.
      IF sy-subrc = 0 AND ls_kv-value IS NOT INITIAL AND ls_kv-value CO '0123456789 '.
        TRY.
            ev_delay_sec = CONV i( ls_kv-value ).
          CATCH cx_root.
            ev_delay_sec = 5.
        ENDTRY.
        IF ev_delay_sec > 60.
          ev_delay_sec = 60.
        ENDIF.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD build_rows.

    CLEAR: ev_rows, ev_count, ev_summary.

    " EMPTY: 0 行是有效业务事实
    IF iv_scenario = gc_scn-empty.
      ev_rows = '[]'.
      ev_count = 0.
      ev_summary = '{"total_rows":0,"note":"MOCK 空结果"}'.
      RETURN.
    ENDIF.

    " SUCCESS/EXPIRED(过期但内容仍可对照): 12 行确定性 Mock 数据,
    " 3 工厂 × 4 物料; iv_max_rows 只影响回传样例, 不谎报总数
    DATA(lv_total) = 12.
    DATA lv_limit TYPE i.
    lv_limit = COND #( WHEN iv_max_rows > 0 AND iv_max_rows < lv_total
                       THEN iv_max_rows ELSE lv_total ).

    DATA: lv_rows TYPE string,
          lt_plant TYPE STANDARD TABLE OF string,
          lt_mat   TYPE STANDARD TABLE OF string.
    APPEND '1000' TO lt_plant. APPEND '2000' TO lt_plant. APPEND '3000' TO lt_plant.
    APPEND 'M001' TO lt_mat. APPEND 'M002' TO lt_mat.
    APPEND 'M003' TO lt_mat. APPEND 'M004' TO lt_mat.

    DATA lv_first TYPE abap_bool VALUE abap_true.
    DATA lv_qty TYPE i.
    DATA lv_p TYPE string. DATA lv_m TYPE string.
    lv_rows = '['.
    LOOP AT lt_plant INTO lv_p.
      LOOP AT lt_mat INTO lv_m.
        lv_qty = ( sy-tabix * 100 ) + lines( lt_plant ) * 7.  " 确定性数量
        IF lv_first = abap_false.
          lv_rows = lv_rows && ','.
        ENDIF.
        lv_first = abap_false.
        lv_rows = lv_rows && |\{"PLANT":"{ lv_p }","MATERIAL":"{ lv_m }","QTY":{ lv_qty }\}|.
      ENDLOOP.
    ENDLOOP.
    lv_rows = lv_rows && ']'.

    " 样例行数按上限截断展示(计数仍如实为 12)
    ev_rows = lv_rows.
    ev_count = lv_total.
    ev_summary = |\{"total_rows":{ lv_total },"note":"MOCK 数据, 非真实业务结果"\}|.

  ENDMETHOD.


ENDCLASS.

