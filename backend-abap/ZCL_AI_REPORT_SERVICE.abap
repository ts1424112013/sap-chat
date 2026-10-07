*=======================================================================
* 对象:   ZCL_AI_REPORT_SERVICE
* 用途:   受控报表服务(《Agent多业务任务与报表分析》P2/P3)
*         - P2: 报表登记(ZAI_RPT_DEF)与参数(ZAI_RPT_PARAM)读取、
*           服务端参数校验(类型/必填/范围/值域/默认值), 只读已有结果;
*           不开放真实执行
*         - P3: 幂等运行(ZAI_RPT_RUN, ClientRequestId 唯一)、状态查询、
*           结果绑定(ZAI_ARTIFACT)与分析状态; 执行走 Mock 适配器
*           (ZCL_AI_REPORT_MOCK, 契约与未来真实作业适配器一致)
* 安全边界(05 提示词 二/六, 全部服务端强制):
*         - REPORT_READ_ENABLED / REPORT_EXEC_ENABLED 双开关(默认关闭,
*           存 ZAI_CHAT_CFG, 复用现有配置系统)
*         - 未登记 TCode / 停用报表 / EXEC 开关未开 / 参数校验失败
*           / 归属校验失败 → 一律拒绝, 不创建运行, 不提交任何作业
*         - 禁止把用户输入拼进 SQL 或程序执行器: 参数只做规范化快照,
*           真正传值是未来 SAP 适配器(SUBMIT WITH SELECTION-TABLE)的职责
*         - 模型输出的 TCode/ReportRunId/ArtifactId 只是候选值,
*           使用前必须过归属/状态校验
*         - TIMEOUT ≠ 作业已停止; UNKNOWN 继续查询; CANCELLED 只在真实
*           取消确认后写入; 空结果(0 行)是有效事实不是失败
* 数据:   ZAI_RPT_DEF / ZAI_RPT_PARAM / ZAI_RPT_RUN / ZAI_RPT_STEP
*         —— SE11 净新增表(见《SE11对象与配置清单》), 建表前本类
*         无法激活, 属 SAP 端阻塞项
* 依赖:   ZCL_AI_TASK_SERVICE(任务归属/状态/结果索引)
*         / ZCL_AI_REPORT_MOCK(测试 double; 真实作业适配器为阻塞项)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50, 755 已核对)
* V1.0    20261007: 首版(登记/参数校验/幂等运行/状态/结果/分析状态)
* V1.0.1  20261007: 踩坑清单自查修正 ——
*         ① 参数解析弃用 /ui2/cl_json=>name_values/name_value/
*           pretty_mode-low_case(本环境零部署先例, 激活风险),
*           改 parse_flat_kv(与 AGENT_GUARD.parse_flat_json 同款正则);
*         ② norm_json 由 [{name,value}] 数组改为扁平对象 {"k":"v"}
*           (与 MOCK read_scenario 解析口径一致, 修复自不一致);
*         ③ fnv_hash 去掉 CONV x1(DDIC 依赖), 改 x LENGTH 1 局部变量
* ★ 重贴后核对标记: parse_flat_kv 正则应与 AGENT_GUARD.parse_flat_json
*   同款; 全文不得出现 name_values/low_case/CONV x1; validate_params
*   的 norm_json 为扁平对象拼装(json_escape 转义)
*=======================================================================
CLASS zcl_ai_report_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " ---- 运行状态(02 设计 §2.2; 与任务状态分开保存) ----
    CONSTANTS: gc_run_created   TYPE string VALUE 'CREATED',
               gc_run_submitted TYPE string VALUE 'SUBMITTED',
               gc_run_running   TYPE string VALUE 'RUNNING',
               gc_run_ready     TYPE string VALUE 'READY',
               gc_run_failed    TYPE string VALUE 'FAILED',
               gc_run_timeout   TYPE string VALUE 'TIMEOUT',
               gc_run_unknown   TYPE string VALUE 'UNKNOWN'.

    " 报表定义(对应 ZAI_RPT_DEF)
    TYPES: BEGIN OF ty_def,
             report_id      TYPE string,
             tcode          TYPE string,
             program        TYPE string,
             report_name    TYPE string,
             description    TYPE string,
             report_kind    TYPE string,
             result_mode    TYPE string,
             result_ref     TYPE string,
             exec_mode      TYPE string,
             read_enabled   TYPE abap_bool,
             exec_enabled   TYPE abap_bool,
             analyze_enabled TYPE abap_bool,
             max_rows       TYPE i,
             config_version TYPE string,
             active         TYPE abap_bool,
           END OF ty_def.
    TYPES tt_def TYPE STANDARD TABLE OF ty_def WITH DEFAULT KEY.

    " 参数定义(对应 ZAI_RPT_PARAM)
    TYPES: BEGIN OF ty_param,
             param_id       TYPE string,
             abap_name      TYPE string,
             label          TYPE string,
             data_type      TYPE string,
             length         TYPE i,
             decimals       TYPE i,
             required       TYPE abap_bool,
             multi_value    TYPE abap_bool,
             range_allowed  TYPE abap_bool,
             default_type   TYPE string,
             default_value  TYPE string,
             allowed_ops    TYPE string,
             value_source   TYPE string,
             validation_rule TYPE string,
             help_text      TYPE string,
             sort_no        TYPE i,
             active         TYPE abap_bool,
           END OF ty_param.
    TYPES tt_param TYPE STANDARD TABLE OF ty_param WITH DEFAULT KEY.

    " 参数校验错误(DEFAULTED 类不进 errors, 单独放 defaulted)
    TYPES: BEGIN OF ty_perr,
             param_id TYPE string,
             code     TYPE string,    " REQUIRED/TYPE/RANGE/DOMAIN/TOO_MANY/...
             message  TYPE string,
           END OF ty_perr.
    TYPES tt_perr TYPE STANDARD TABLE OF ty_perr WITH DEFAULT KEY.

    " 扁平 JSON 键值(键已转小写; 解析见 parse_flat_kv —— 沿用
    " AGENT_GUARD.parse_flat_json 已部署验证的正则模式, 不依赖
    " /ui2/cl_json 的 name_values 类型(踩坑清单 §3.B 存在性自查))
    TYPES: BEGIN OF ty_kv,
             name  TYPE string,
             value TYPE string,
           END OF ty_kv.
    TYPES tt_kv TYPE STANDARD TABLE OF ty_kv WITH DEFAULT KEY.

    " 参数校验结果
    TYPES: BEGIN OF ty_pvres,
             ok          TYPE abap_bool,
             needs_input TYPE abap_bool,   " 缺参数 → WAITING_INPUT, 不创建运行
             errors      TYPE tt_perr,
             norm_json   TYPE string,      " 规范化参数快照 JSON
             hash        TYPE string,      " 参数一致性哈希(非安全哈希)
             defaulted   TYPE tt_perr,     " 被默认值补齐的项(前端提示用)
           END OF ty_pvres.

    " 运行启动结果
    TYPES: BEGIN OF ty_run_start,
             report_run_id TYPE string,
             short_id      TYPE string,
             task_id       TYPE string,
             report_id     TYPE string,
             status        TYPE string,
             created       TYPE abap_bool,  " false = 幂等命中已有运行
             rejected      TYPE abap_bool,
             needs_input   TYPE abap_bool,
             message       TYPE string,
           END OF ty_run_start.

    " 运行状态视图(前端/TaskContext 用)
    TYPES: BEGIN OF ty_run_status,
             report_run_id TYPE string,
             short_id      TYPE string,
             task_id       TYPE string,
             report_id     TYPE string,
             status        TYPE string,
             artifact_id   TYPE string,
             artifact_short TYPE string,
             row_count     TYPE i,
             error_code    TYPE string,
             error_message TYPE string,
             message       TYPE string,
           END OF ty_run_status.

    " 结果读取视图(schema + 受控摘要 + 受限样例, 不含全量明细)
    TYPES: BEGIN OF ty_result,
             artifact_id  TYPE string,
             report_run_id TYPE string,
             report_id    TYPE string,
             label        TYPE string,
             status       TYPE string,
             schema_json  TYPE string,
             summary_json TYPE string,
             rows_json    TYPE string,  " 前 N 行样例(上限 = 定义 MAX_ROWS)
             row_count    TYPE i,
             message      TYPE string,
           END OF ty_result.

    " ---- 开关(复用 ZAI_CHAT_CFG) ----

    " REPORT_READ_ENABLED: 登记报表/参数/已有结果可见; 默认关闭
    CLASS-METHODS read_enabled
      RETURNING VALUE(rv_on) TYPE abap_bool.

    " REPORT_EXEC_ENABLED: 允许创建运行并提交执行; 默认关闭(安全默认)
    CLASS-METHODS exec_enabled
      RETURNING VALUE(rv_on) TYPE abap_bool.

    " ---- 定义与参数(P2) ----

    " 按 TCode 取登记报表(大写; 未登记/停用 → initial, 调用方必须拒绝)
    CLASS-METHODS get_def_by_tcode
      IMPORTING iv_tcode     TYPE string
      RETURNING VALUE(rs)    TYPE ty_def.

    " 按内部编号取登记报表
    CLASS-METHODS get_def
      IMPORTING iv_report_id TYPE string
      RETURNING VALUE(rs)    TYPE ty_def.

    " 登记报表清单(仅 read_enabled 时; 前端能力目录)
    CLASS-METHODS list_defs
      RETURNING VALUE(rt)   TYPE tt_def.

    " 参数定义清单(版本一致; 未登记返回空)
    CLASS-METHODS get_params
      IMPORTING iv_report_id TYPE string
                iv_config_version TYPE string
      RETURNING VALUE(rt)    TYPE tt_param.

    " 服务端参数校验与规范化(纯校验, 无任何拼接/执行):
    " 必填缺失 → needs_input(应转 WAITING_INPUT); 类型/范围/值域错误 → errors
    CLASS-METHODS validate_params
      IMPORTING is_def     TYPE ty_def
                iv_params_json TYPE string   " 用户/模型提交的候选参数
      RETURNING VALUE(rs)  TYPE ty_pvres.

    " ---- 运行(P3; Mock 闭环) ----

    " 幂等启动运行: 同一 ClientRequestId(同一用户)重试返回同一运行;
    " 用户主动重跑必须换新 RequestId
    CLASS-METHODS start_run
      IMPORTING iv_task_id     TYPE string
                iv_session_id  TYPE string
                iv_report_id   TYPE string
                iv_params_json TYPE string
                iv_request_id  TYPE string
      RETURNING VALUE(rs)      TYPE ty_run_start.

    " 运行状态查询(归属校验 → 适配器推进状态机 → 返回视图)
    CLASS-METHODS get_run_status
      IMPORTING iv_report_run_id TYPE string
      RETURNING VALUE(rs)        TYPE ty_run_status.

    " 结果读取(必须 READY + Artifact AVAILABLE + 归属正确;
    " 结果来源无法确认时拒绝分析, 不按"最新数据"猜)
    CLASS-METHODS get_result
      IMPORTING iv_artifact_id TYPE string
      RETURNING VALUE(rs)      TYPE ty_result.

    " 结果可用判定(前端/分析链路用; EXPIRED 只读不删除)
    CLASS-METHODS is_artifact_available
      IMPORTING iv_artifact_id TYPE string
      RETURNING VALUE(rv)      TYPE abap_bool.

    " 扁平 JSON 键值解析(仅对象形态, 值限字符串/数字/bool/null, 不支持
    " 嵌套; 正则模式与 AGENT_GUARD.parse_flat_json 一致 —— 已部署验证。
    " 键统一转小写; 供本类参数校验与 REPORT_MOCK 场景读取共用)
    CLASS-METHODS parse_flat_kv
      IMPORTING iv_json     TYPE string
      RETURNING VALUE(rt)   TYPE tt_kv.

    " JSON 字符串值转义(手工拼装 norm_json 用)
    CLASS-METHODS json_escape
      IMPORTING iv_text    TYPE string
      RETURNING VALUE(rv)  TYPE string.

  PRIVATE SECTION.

    " 定义行 <-> 结构
    CLASS-METHODS row_to_def
      IMPORTING is_row     TYPE zai_rpt_def
      RETURNING VALUE(rs)  TYPE ty_def.

    " 单参数校验(类型/范围/值域); ev_norm 输出规范化值
    CLASS-METHODS validate_one
      IMPORTING is_p      TYPE ty_param
                iv_val    TYPE string
      EXPORTING ev_norm   TYPE string
                ev_err    TYPE string.

    " 滚动窗口一致性哈希(非安全哈希, 仅参数一致性比对):
    " 纯位运算 + x 串移位, 无算术溢出; 输出 16 位十六进制。
    " SAP 端 P0 可按需换标准哈希工具(字段已留 CHAR64), 只要求同系统内确定。
    CLASS-METHODS fnv_hash
      IMPORTING iv_text   TYPE string
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS now14
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS zcl_ai_report_service IMPLEMENTATION.


  METHOD read_enabled.
    rv_on = xsdbool( zcl_ai_task_service=>read_cfg_str( 'REPORT_READ_ENABLED' ) = 'X' ).
  ENDMETHOD.


  METHOD exec_enabled.
    " 双重开关: 全局 REPORT_EXEC_ENABLED 且任务层开关也开
    " (执行必须先有任务归属链路; 任一关闭都拒绝)
    rv_on = xsdbool( zcl_ai_task_service=>read_cfg_str( 'REPORT_EXEC_ENABLED' ) = 'X'
                     AND zcl_ai_task_service=>task_enabled( ) = abap_true ).
  ENDMETHOD.


  METHOD get_def_by_tcode.

    CLEAR rs.
    IF read_enabled( ) = abap_false.
      RETURN.
    ENDIF.
    DATA(lv_tc) = to_upper( iv_tcode ).
    CONDENSE lv_tc NO-GAPS.
    SELECT SINGLE * FROM zai_rpt_def
      WHERE tcode = @lv_tc AND active = 'X'
      INTO @DATA(ls_row).
    IF sy-subrc = 0.
      rs = row_to_def( ls_row ).
    ENDIF.

  ENDMETHOD.


  METHOD get_def.

    CLEAR rs.
    IF read_enabled( ) = abap_false.
      RETURN.
    ENDIF.
    SELECT SINGLE * FROM zai_rpt_def
      WHERE report_id = @iv_report_id AND active = 'X'
      INTO @DATA(ls_row).
    IF sy-subrc = 0.
      rs = row_to_def( ls_row ).
    ENDIF.

  ENDMETHOD.


  METHOD list_defs.

    CLEAR rt.
    IF read_enabled( ) = abap_false.
      RETURN.
    ENDIF.
    SELECT * FROM zai_rpt_def
      WHERE active = 'X'
      ORDER BY PRIMARY KEY
      INTO TABLE @DATA(lt).
    LOOP AT lt INTO DATA(ls_row).
      APPEND row_to_def( ls_row ) TO rt.
    ENDLOOP.

  ENDMETHOD.


  METHOD get_params.

    CLEAR rt.
    IF read_enabled( ) = abap_false OR iv_report_id IS INITIAL.
      RETURN.
    ENDIF.

    " CONFIG_VERSION 必须与主表当前版本一致(不一致 → 视为未登记参数)
    SELECT SINGLE config_version FROM zai_rpt_def
      WHERE report_id = @iv_report_id AND active = 'X'
      INTO @DATA(lv_ver).
    IF sy-subrc <> 0 OR ( iv_config_version IS NOT INITIAL
                          AND iv_config_version <> lv_ver ).
      RETURN.
    ENDIF.

    SELECT param_id  abap_name  label      data_type  length
           decimals  required   multi_value range_allowed
           default_type default_value allowed_ops value_source
           validation_rule help_text sort_no active
      FROM zai_rpt_param
      WHERE report_id = @iv_report_id
        AND config_version = @lv_ver
        AND active = 'X'
      ORDER BY sort_no, param_id
      INTO CORRESPONDING FIELDS OF TABLE @rt.

  ENDMETHOD.


  METHOD validate_params.

    CLEAR rs.
    rs-ok = abap_true.

    " 参数定义必须存在(未登记参数的报表不可交互)
    DATA(lt_p) = get_params( iv_report_id = is_def-report_id
                             iv_config_version = is_def-config_version ).
    IF lt_p IS INITIAL.
      rs-ok = abap_false.
      APPEND VALUE #( param_id = ''
                      code = 'NO_SCHEMA'
                      message = |报表 { is_def-report_id } 没有可用的参数定义| )
        TO rs-errors.
      RETURN.
    ENDIF.

    " 解析用户参数 JSON 为 name→value 映射(扁平键值, 键小写;
    " 多值约定: 前端按参数 Schema 把数组序列化为 "|" 分隔字符串,
    " 真实 SAP 选择表转换是未来适配器职责, 本层不做任何拼接执行)
    DATA: lt_kv TYPE tt_kv,
          ls_kv TYPE ty_kv.
    IF iv_params_json IS NOT INITIAL.
      lt_kv = parse_flat_kv( iv_params_json ).
    ENDIF.

    " 逐参数校验(顺序 = 表单顺序); 规范化快照手工拼装为扁平对象
    " {"p_werks":"1000",...}(键小写; 值经转义)
    DATA: lt_norm TYPE tt_kv,
          lv_norm_json TYPE string.
    LOOP AT lt_p INTO DATA(ls_p).
      CLEAR ls_kv.
      READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-param_id ).
      IF sy-subrc <> 0.
        READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-abap_name ).
      ENDIF.

      DATA(lv_val) = COND string( WHEN sy-subrc = 0 THEN ls_kv-value ELSE `` ).

      " 缺值 → 默认值补齐或必填报错
      IF lv_val IS INITIAL.
        CASE to_upper( ls_p-default_type ).
          WHEN 'STATIC'.
            lv_val = ls_p-default_value.
            APPEND VALUE #( param_id = ls_p-param_id code = 'DEFAULTED'
                            message = |{ ls_p-label } 已按默认值 { lv_val } 补齐| )
              TO rs-defaulted.
          WHEN 'USER'.
            lv_val = sy-uname.
            APPEND VALUE #( param_id = ls_p-param_id code = 'DEFAULTED'
                            message = |{ ls_p-label } 已按当前用户补齐| )
              TO rs-defaulted.
          WHEN OTHERS.
            IF ls_p-required = abap_true.
              rs-ok = abap_false.
              rs-needs_input = abap_true.
              APPEND VALUE #( param_id = ls_p-param_id code = 'REQUIRED'
                              message = |{ ls_p-label } 为必填项, 请填写后重试| )
                TO rs-errors.
            ENDIF.
            CONTINUE.
        ENDCASE.
        IF lv_val IS INITIAL.
          CONTINUE.
        ENDIF.
      ENDIF.

      " 单值校验(类型/范围/值域)
      DATA: lv_norm TYPE string, lv_err TYPE string.
      validate_one( EXPORTING is_p = ls_p iv_val = lv_val
                    IMPORTING ev_norm = lv_norm ev_err = lv_err ).
      IF lv_err IS NOT INITIAL.
        rs-ok = abap_false.
        APPEND VALUE #( param_id = ls_p-param_id
                        code     = lv_err
                        message  = |{ ls_p-label }: 值 "{ lv_val }" 校验未通过({ lv_err })| )
          TO rs-errors.
        CONTINUE.
      ENDIF.
      APPEND VALUE #( name = to_lower( ls_p-param_id ) value = lv_norm )
        TO lt_norm.
    ENDLOOP.

    " 提交了未定义的参数 → 拒绝(不静默丢弃, 防越权字段)
    LOOP AT lt_kv INTO ls_kv.
      DATA(lv_defined) = abap_false.
      LOOP AT lt_p INTO DATA(ls_chk).
        IF to_lower( ls_chk-param_id ) = ls_kv-name
           OR to_lower( ls_chk-abap_name ) = ls_kv-name.
          lv_defined = abap_true.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_defined = abap_false.
        rs-ok = abap_false.
        APPEND VALUE #( param_id = ls_kv-name code = 'UNKNOWN_PARAM'
                        message = |参数 { ls_kv-name } 不在该报表的登记参数中, 已拒绝| )
          TO rs-errors.
      ENDIF.
    ENDLOOP.

    IF rs-ok = abap_true.
      " 跨参数规则(VALIDATION_RULE 引用 'GE:<param_id>' / 'LE:<param_id>'):
      " 如 结束日期 GE 开始日期(DATE 按字典序/NUM 按数值比较)
      LOOP AT lt_p INTO DATA(ls_rule) WHERE validation_rule CS 'GE:'
                                         OR validation_rule CS 'LE:'.
        DATA: lv_op  TYPE string,
              lv_ref TYPE string.
        SPLIT ls_rule-validation_rule AT ':' INTO lv_op lv_ref.
        CONDENSE: lv_op, lv_ref.
        DATA(lv_self) = VALUE string( ).
        DATA(lv_base) = VALUE string( ).
        READ TABLE lt_norm INTO DATA(ls_n1) WITH KEY name = to_lower( ls_rule-param_id ).
        IF sy-subrc = 0. lv_self = ls_n1-value. ENDIF.
        READ TABLE lt_norm INTO ls_n1 WITH KEY name = to_lower( lv_ref ).
        IF sy-subrc = 0. lv_base = ls_n1-value. ENDIF.
        IF lv_self IS INITIAL OR lv_base IS INITIAL.
          CONTINUE.
        ENDIF.
        DATA lv_bad TYPE abap_bool.
        IF lv_self CN '0123456789.-' OR lv_base CN '0123456789.-'
           OR lv_self IS INITIAL OR lv_base IS INITIAL.
          " 非数值(DATE 等)按字符串比较(YYYYMMDD 字典序即时间序)
          IF lv_op = 'GE'.
            lv_bad = xsdbool( lv_self < lv_base ).
          ELSE.
            lv_bad = xsdbool( lv_self > lv_base ).
          ENDIF.
        ELSE.
          DATA: lv_f1 TYPE f, lv_f2 TYPE f.
          lv_f1 = CONV f( lv_self ).
          lv_f2 = CONV f( lv_base ).
          IF lv_op = 'GE'.
            lv_bad = xsdbool( lv_f1 < lv_f2 ).
          ELSE.
            lv_bad = xsdbool( lv_f1 > lv_f2 ).
          ENDIF.
        ENDIF.
        IF lv_bad = abap_true.
          rs-ok = abap_false.
          APPEND VALUE #( param_id = ls_rule-param_id code = 'RANGE'
                          message = |{ ls_rule-label } 与基准参数 { lv_ref } 违反 { lv_op } 关系| )
            TO rs-errors.
        ENDIF.
      ENDLOOP.
    ENDIF.

    IF rs-ok = abap_false.
      RETURN.
    ENDIF.

    " 规范化快照(扁平对象 JSON) + 一致性哈希
    " (绑定 ReportRun; 修改参数 → 新哈希 → 旧授权失效)
    DATA lv_first_kv TYPE abap_bool VALUE abap_true.
    lv_norm_json = '{'.
    LOOP AT lt_norm INTO DATA(ls_nkv).
      IF lv_first_kv = abap_false.
        lv_norm_json = lv_norm_json && ','.
      ENDIF.
      lv_first_kv = abap_false.
      lv_norm_json = lv_norm_json && '"' && ls_nkv-name && '":"' &&
                     json_escape( ls_nkv-value ) && '"'.
    ENDLOOP.
    lv_norm_json = lv_norm_json && '}'.

    rs-norm_json = lv_norm_json.
    rs-hash = fnv_hash( |{ is_def-report_id }{ is_def-config_version }| && rs-norm_json ).

  ENDMETHOD.


  METHOD start_run.

    CLEAR rs.
    rs-task_id   = iv_task_id.
    rs-report_id = iv_report_id.

    " ---- 开关: 执行能力默认关闭 ----
    IF exec_enabled( ) = abap_false.
      rs-rejected = abap_true.
      rs-message  = '报表执行能力未开启(REPORT_EXEC_ENABLED), 已拒绝提交'.
      RETURN.
    ENDIF.

    " ---- 定义核验: 已登记 + 活跃 + 该报表 EXEC 开 ----
    DATA(ls_def) = get_def( iv_report_id ).
    IF ls_def-report_id IS INITIAL.
      " 未登记的报表绝不因模型/用户输入临时加入白名单
      rs-rejected = abap_true.
      rs-message  = |报表 { iv_report_id } 未登记或已停用, 无法执行|.
      RETURN.
    ENDIF.
    IF ls_def-exec_enabled = abap_false.
      rs-rejected = abap_true.
      rs-message  = |报表 { ls_def-report_name } 未开放执行权限|.
      RETURN.
    ENDIF.

    " ---- 任务归属核验(运行挂在任务下) ----
    DATA(ls_task) = zcl_ai_task_service=>get_task_owned(
                      iv_task_id = iv_task_id iv_session_id = iv_session_id ).
    IF ls_task-task_id IS INITIAL.
      rs-rejected = abap_true.
      rs-message  = '任务不存在或不属于当前会话, 已拒绝提交'.
      RETURN.
    ENDIF.

    " ---- RequestId 幂等(网络重试返回同一运行, 不产生第二个运行) ----
    IF iv_request_id IS INITIAL.
      rs-rejected = abap_true.
      rs-message  = '缺少 ClientRequestId, 已拒绝提交'.
      RETURN.
    ENDIF.
    SELECT SINGLE report_run_id status FROM zai_rpt_run
      WHERE request_id = @iv_request_id AND created_by = @sy-uname
      INTO ( @DATA(lv_run_id), @DATA(lv_run_sts) ).
    IF sy-subrc = 0.
      rs-report_run_id = lv_run_id.
      rs-short_id      = zcl_ai_task_service=>short_id( lv_run_id ).
      rs-status        = lv_run_sts.
      rs-created       = abap_false.
      rs-message       = '请求已存在, 返回原有运行(幂等)'.
      RETURN.
    ENDIF.

    " ---- 参数校验: 缺参数/类型错 → WAITING_INPUT, 不创建运行 ----
    DATA(ls_pv) = validate_params( is_def = ls_def iv_params_json = iv_params_json ).
    IF ls_pv-ok = abap_false.
      rs-rejected    = abap_true.
      rs-needs_input = ls_pv-needs_input.
      IF ls_pv-needs_input = abap_true.
        rs-status  = zcl_ai_task_service=>gc_st_waiting_input.
        rs-message = '参数未齐或校验未通过, 请补填后重试(本次未创建运行)'.
      ELSE.
        rs-message = '参数校验未通过, 已拒绝提交(本次未创建运行)'.
      ENDIF.
      RETURN.
    ENDIF.

    " ---- 创建运行(参数/配置版本冻结在运行记录; 后改草稿不影响) ----
    DATA lv_id TYPE c LENGTH 32.
    CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_32 = lv_id.

    INSERT zai_rpt_run FROM @(
      VALUE #( mandt          = sy-mandt
               report_run_id  = lv_id
               task_id        = iv_task_id
               request_id     = iv_request_id
               report_id      = ls_def-report_id
               config_version = ls_def-config_version
               tcode          = ls_def-tcode
               program        = ls_def-program
               params_json    = ls_pv-norm_json
               params_hash    = ls_pv-hash
               status         = gc_run_created
               created_by     = sy-uname
               created_at     = now14( ) ) ).
    COMMIT WORK.

    " 步骤审计: VALIDATE OK(脱敏摘要, 不写完整参数)
    zcl_ai_report_mock=>add_step(
      iv_report_run_id = lv_id iv_task_id = iv_task_id
      iv_phase = 'VALIDATE' iv_status = 'OK'
      iv_summary = |参数校验通过(哈希 { ls_pv-hash })| ).

    " ---- 提交(Mock 适配器; 真实 SAP 作业适配器为阻塞项) ----
    " 适配器只拿规范化参数快照与运行 ID, 不做任何字符串拼接执行
    DATA: lv_sub_sts TYPE string, lv_sub_msg TYPE string.
    zcl_ai_report_mock=>submit(
      EXPORTING iv_report_run_id = lv_id
                iv_program       = ls_def-program
                iv_params_json   = ls_pv-norm_json
                iv_user          = sy-uname
      IMPORTING ev_status        = lv_sub_sts
                ev_message       = lv_sub_msg ).

    DATA(lv_now) = now14( ).
    UPDATE zai_rpt_run
      SET status = @lv_sub_sts, started_at = @lv_now
      WHERE report_run_id = @lv_id.
    COMMIT WORK.

    zcl_ai_report_mock=>add_step(
      iv_report_run_id = lv_id iv_task_id = iv_task_id
      iv_phase = 'SUBMIT' iv_status = COND #( WHEN lv_sub_sts = gc_run_submitted
                                              THEN 'OK' ELSE 'ERROR' )
      iv_summary = lv_sub_msg ).

    rs-report_run_id = lv_id.
    rs-short_id      = zcl_ai_task_service=>short_id( lv_id ).
    rs-status        = lv_sub_sts.
    rs-created       = abap_true.
    rs-message       = lv_sub_msg.

    " 任务状态推进(乐观锁; 版本冲突不影响运行记录, 下次查询时补偿)
    zcl_ai_task_service=>update_status(
      iv_task_id = iv_task_id iv_version = ls_task-current_version
      iv_status  = zcl_ai_task_service=>gc_st_queued ).

  ENDMETHOD.


  METHOD get_run_status.

    CLEAR rs.
    IF iv_report_run_id IS INITIAL.
      rs-message = '缺少运行编号'.
      RETURN.
    ENDIF.

    SELECT SINGLE * FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
        AND created_by = @sy-uname
      INTO @DATA(ls_run).
    IF sy-subrc <> 0.
      rs-message = '运行不存在或不属于当前用户'.
      RETURN.
    ENDIF.

    " 归属链: 运行 → 任务(任务 owner 已由 WHERE 过滤当前用户)
    DATA(ls_task) = zcl_ai_task_service=>get_task_owned(
                      iv_task_id = ls_run-task_id iv_session_id = '' ).
    IF ls_task-task_id IS INITIAL.
      rs-message = '运行所属任务不可访问'.
      RETURN.
    ENDIF.

    " 未终态: 让适配器推进状态机(Mock: 到时转 READY/FAILED/...;
    " 真实适配器: 查作业状态。TIMEOUT 不等于作业已停止; UNKNOWN 需继续查询)
    IF ls_run-status = gc_run_created OR ls_run-status = gc_run_submitted
       OR ls_run-status = gc_run_running OR ls_run-status = gc_run_unknown.
      DATA: lv_new_sts TYPE string, lv_msg TYPE string.
      CLEAR: lv_new_sts, lv_msg.
      zcl_ai_report_mock=>poll(
        EXPORTING iv_report_run_id = iv_report_run_id
        IMPORTING ev_status        = lv_new_sts
                  ev_message       = lv_msg ).
      IF lv_new_sts IS NOT INITIAL AND lv_new_sts <> ls_run-status.
        DATA(lv_now) = now14( ).
        CASE lv_new_sts.
          WHEN gc_run_ready OR gc_run_failed OR gc_run_timeout OR gc_run_unknown.
            UPDATE zai_rpt_run SET status = @lv_new_sts, finished_at = @lv_now
              WHERE report_run_id = @iv_report_run_id.
          WHEN OTHERS.
            UPDATE zai_rpt_run SET status = @lv_new_sts
              WHERE report_run_id = @iv_report_run_id.
        ENDCASE.
        COMMIT WORK.
        zcl_ai_report_mock=>add_step(
          iv_report_run_id = iv_report_run_id iv_task_id = ls_run-task_id
          iv_phase = 'POLL' iv_status = 'OK'
          iv_summary = |状态推进 { ls_run-status } -> { lv_new_sts }| ).
        ls_run-status = lv_new_sts.
      ENDIF.
    ENDIF.

    " 结果绑定状态(READY 时应已有 Artifact; 没有则为结果错误, 拒绝分析)
    SELECT SINGLE artifact_id row_count error_code error_message
      FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO ( @rs-artifact_id, @rs-row_count, @rs-error_code, @rs-error_message ).

    rs-report_run_id = ls_run-report_run_id.
    rs-short_id      = zcl_ai_task_service=>short_id( ls_run-report_run_id ).
    rs-task_id       = ls_run-task_id.
    rs-report_id     = ls_run-report_id.
    rs-status        = ls_run-status.
    rs-artifact_short = COND #( WHEN rs-artifact_id IS NOT INITIAL
                                THEN zcl_ai_task_service=>short_id( rs-artifact_id ) ELSE '' ).

  ENDMETHOD.


  METHOD get_result.

    CLEAR rs.
    IF iv_artifact_id IS INITIAL.
      rs-message = '缺少结果编号'.
      RETURN.
    ENDIF.

    " Artifact 归属 + 状态
    SELECT SINGLE * FROM zai_artifact
      WHERE artifact_id = @iv_artifact_id AND owner = @sy-uname
      INTO @DATA(ls_art).
    IF sy-subrc <> 0.
      rs-message = '结果不存在或不属于当前用户'.
      RETURN.
    ENDIF.
    IF ls_art-status <> 'AVAILABLE'.
      rs-message = |结果当前状态为 { ls_art-status }, 不可读取(过期/失效需重新执行)|.
      RETURN.
    ENDIF.
    IF ls_art-report_run_id IS INITIAL.
      rs-message = '该结果不是报表运行产物, 请走数据分析链路'.
      RETURN.
    ENDIF.

    " 运行必须 READY(结果来源可确认才允许分析; 不按"最新数据"猜)
    SELECT SINGLE status report_id FROM zai_rpt_run
      WHERE report_run_id = @ls_art-report_run_id AND created_by = @sy-uname
      INTO ( @DATA(lv_sts), @DATA(lv_rid) ).
    IF sy-subrc <> 0.
      rs-message = '无法确认结果来源运行, 已拒绝分析'.
      RETURN.
    ENDIF.
    IF lv_sts <> gc_run_ready.
      rs-message = |运行状态为 { lv_sts }, 结果尚不可读|.
      RETURN.
    ENDIF.

    " 读取受控结果(样例行数受报表 MAX_ROWS 上限约束)
    DATA: lv_def  TYPE ty_def,
          lv_schema TYPE string, lv_summary TYPE string, lv_rows TYPE string,
          lv_cnt TYPE i, lv_msg TYPE string.
    CLEAR: lv_schema, lv_summary, lv_rows, lv_cnt, lv_msg.
    lv_def = get_def( lv_rid ).
    zcl_ai_report_mock=>read_result(
      EXPORTING iv_report_run_id = ls_art-report_run_id
                iv_max_rows      = lv_def-max_rows
      IMPORTING ev_schema_json   = lv_schema
                ev_summary_json  = lv_summary
                ev_rows_json     = lv_rows
                ev_row_count     = lv_cnt
                ev_message       = lv_msg ).

    IF lv_msg IS NOT INITIAL AND lv_cnt = 0.
      rs-message = lv_msg.
      RETURN.
    ENDIF.

    rs-artifact_id   = ls_art-artifact_id.
    rs-report_run_id = ls_art-report_run_id.
    rs-report_id     = lv_rid.
    rs-label         = ls_art-label.
    rs-status        = 'AVAILABLE'.
    rs-schema_json   = lv_schema.
    rs-summary_json  = lv_summary.
    rs-rows_json     = lv_rows.
    rs-row_count     = lv_cnt.

  ENDMETHOD.


  METHOD is_artifact_available.

    rv = abap_false.
    IF iv_artifact_id IS INITIAL.
      RETURN.
    ENDIF.
    SELECT SINGLE status FROM zai_artifact
      WHERE artifact_id = @iv_artifact_id AND owner = @sy-uname
      INTO @DATA(lv_sts).
    rv = xsdbool( sy-subrc = 0 AND lv_sts = 'AVAILABLE' ).

  ENDMETHOD.


  METHOD row_to_def.

    rs-report_id       = is_row-report_id.
    rs-tcode           = is_row-tcode.
    rs-program         = is_row-program.
    rs-report_name     = is_row-report_name.
    rs-description     = is_row-description.
    rs-report_kind     = is_row-report_kind.
    rs-result_mode     = is_row-result_mode.
    rs-result_ref      = is_row-result_ref.
    rs-exec_mode       = is_row-exec_mode.
    rs-read_enabled    = xsdbool( is_row-read_enabled = 'X' ).
    rs-exec_enabled    = xsdbool( is_row-exec_enabled = 'X' ).
    rs-analyze_enabled = xsdbool( is_row-analyze_enabled = 'X' ).
    rs-max_rows        = is_row-max_rows.
    rs-config_version  = is_row-config_version.
    rs-active          = xsdbool( is_row-active = 'X' ).

  ENDMETHOD.


  METHOD validate_one.

    CLEAR: ev_norm, ev_err.

    " ---- BOOL ----
    IF is_p-data_type = 'BOOL'.
      IF iv_val = 'true' OR iv_val = 'X' OR iv_val = 'x' OR iv_val = '1'.
        ev_norm = 'X'.
      ELSEIF iv_val = 'false' OR iv_val = '0'.
        ev_norm = ''.
      ELSE.
        ev_err = 'TYPE'.
      ENDIF.
      RETURN.
    ENDIF.

    " ---- DATE: YYYYMMDD 且合法(1900 起, 月/日有效) ----
    IF is_p-data_type = 'DATE'.
      IF strlen( iv_val ) <> 8 OR iv_val CN '0123456789'.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      DATA lv_dat TYPE d.
      lv_dat = iv_val.
      IF lv_dat IS INITIAL OR lv_dat(4) < '1900'.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      IF lv_dat+4(2) BETWEEN '01' AND '12' AND lv_dat+6(2) BETWEEN '01' AND '31'.
        ev_norm = iv_val.
      ELSE.
        ev_err = 'TYPE'.
      ENDIF.
      RETURN.
    ENDIF.

    " ---- NUM: 数字(允许负号/小数点), 长度上限, 可解析性 ----
    IF is_p-data_type = 'NUM'.
      IF iv_val CN '0123456789.-'.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      DATA(lv_v) = condense( val = iv_val ).
      IF is_p-length > 0 AND strlen( lv_v ) > is_p-length.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      TRY.
          DATA(lv_f) = CONV f( lv_v ).
          ev_norm = |{ lv_f }|.
        CATCH cx_root.
          ev_err = 'TYPE'.
          RETURN.
      ENDTRY.
      ev_norm = lv_v.
      RETURN.
    ENDIF.

    " ---- ENUM: 值域(允许值清单存 VALIDATION_RULE, 逗号分隔) ----
    IF is_p-data_type = 'ENUM'.
      IF is_p-validation_rule IS NOT INITIAL.
        SPLIT is_p-validation_rule AT ',' INTO TABLE DATA(lt_list).
        READ TABLE lt_list TRANSPORTING NO FIELDS
          WITH KEY table_line = iv_val.
        IF sy-subrc <> 0.
          ev_err = 'DOMAIN'.
          RETURN.
        ENDIF.
      ENDIF.
      ev_norm = iv_val.
      RETURN.
    ENDIF.

    " ---- CHAR(默认): 长度上限 ----
    IF is_p-length > 0 AND strlen( iv_val ) > is_p-length.
      ev_err = 'TYPE'.
      RETURN.
    ENDIF.
    ev_norm = iv_val.

    " 说明: 范围/多值按契约在前端序列化为 "low|high" / "a|b";
    " 本层逐项校验标量, 真实选择表转换属未来 SAP 适配器。

  ENDMETHOD.


  METHOD fnv_hash.

    " 一致性哈希(非安全; 位置混入 XOR, 顺序敏感): 每字节写入
    " 槽位 = 位置 MOD 8, 并向相邻槽混入位置低 8 位 —— 字节/顺序变化
    " 都会改变结果; x 类型无算术溢出; 同系统内确定。
    DATA: lv_x   TYPE xstring,
          lv_win TYPE x LENGTH 8,
          lv_len TYPE i,
          lv_i   TYPE i,
          lv_b   TYPE x LENGTH 1,
          lv_s1  TYPE i,
          lv_s2  TYPE i,
          lv_pos TYPE x LENGTH 1.

    TRY.
        lv_x = iv_text.
      CATCH cx_root.
        lv_x = '00'.
    ENDTRY.
    lv_len = xstrlen( lv_x ).
    DO lv_len TIMES.
      lv_i = sy-index - 1.
      lv_b = lv_x+lv_i(1).
      lv_s1 = lv_i MOD 8.
      lv_s2 = ( lv_i + 3 ) MOD 8.
      " i → 单字节(取低 8 位; 不依赖 DDIC 数据元素 X1)
      lv_pos = lv_i MOD 256.
      lv_win+lv_s1(1) = lv_win+lv_s1(1) BIT-XOR lv_b.
      lv_win+lv_s2(1) = lv_win+lv_s2(1) BIT-XOR lv_pos.
    ENDDO.
    rv = lv_win.

  ENDMETHOD.


  METHOD parse_flat_kv.

    " 扁平键值解析(正则模式与已部署的 AGENT_GUARD.parse_flat_json 一致;
    " 偏移/长度先落中间变量 —— 踩坑清单 §2.1-2 三犯模式对策)
    " 只接受对象形态; 值限 "字符串" / 数字 / true / false / null
    CLEAR rt.
    DATA(lv_inner) = iv_json.
    IF strlen( lv_inner ) >= 2 AND lv_inner(1) = '{'.
      DATA(lv_len)  = strlen( lv_inner ).
      DATA(lv_body) = lv_len - 2.
      lv_inner = lv_inner+1(lv_body).
    ELSE.
      RETURN.
    ENDIF.

    FIND ALL OCCURRENCES OF REGEX
      '"([A-Za-z0-9_]+)"[ ]*:[ ]*("([^"]*)"|(-?[0-9]+(\.[0-9]+)?|true|false|null))'
      IN lv_inner RESULTS DATA(lt_m).

    LOOP AT lt_m INTO DATA(ls_m).
      DATA(lv_s1) = ls_m-submatches[ 1 ].
      DATA(lv_s3) = ls_m-submatches[ 3 ].
      DATA(lv_s4) = ls_m-submatches[ 4 ].
      DATA(lv_key) = to_lower( substring( val = lv_inner
                                          off = lv_s1-offset
                                          len = lv_s1-length ) ).
      DATA(lv_val) = ``.
      IF lv_s3-length > 0.
        " 带引号字符串: 取引号内内容(不含转义处理; 参数值约定不含 ")
        lv_val = substring( val = lv_inner off = lv_s3-offset len = lv_s3-length ).
      ELSEIF lv_s4-length > 0.
        lv_val = substring( val = lv_inner off = lv_s4-offset len = lv_s4-length ).
      ENDIF.
      APPEND VALUE #( name = lv_key value = lv_val ) TO rt.
    ENDLOOP.

  ENDMETHOD.


  METHOD json_escape.

    rv = iv_text.
    REPLACE ALL OCCURRENCES OF '\' IN rv WITH '\\'.
    REPLACE ALL OCCURRENCES OF '"' IN rv WITH '\"'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv WITH ' '.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv WITH ' '.

  ENDMETHOD.


  METHOD now14.
    rv = |{ sy-datum }{ sy-uzeit }|.
  ENDMETHOD.


ENDCLASS.

