*&---------------------------------------------------------------------*
*& Report ZAI_TEST_AGENT_CORE
*&---------------------------------------------------------------------*
*& 改进清单 PROC-02: 测试报表(首批) —— 直接调用公开静态方法, 打印通过 / 失败
*& 覆盖:
*&   ZCL_AI_AGENT_GUARD   parse_model_json(BE-01) / parse_flat_json(BE-02)
*&   ZCL_AI_REPORT_SERVICE parse_flat_kv(BE-11)
*&   ZCL_AI_LLM_CLIENT    is_retryable(BE-07)
*&   ZCL_AI_INTENT_ROUTER normalize_scene / quick_route 场景收窄(V1.1 加 FIORI 场景)
*& 用法: SE38 新建可执行程序 ZAI_TEST_AGENT_CORE, 贴入本源码, 激活, F8。
*&       每次 SE24 重贴上述类后跑一遍, 末行"全部通过"才进回归。
*& 依赖: AGENT_GUARD V1.1.4 / REPORT_SERVICE V1.0.12 / LLM_CLIENT V1.3。
*&       在旧版本上跑, 对应用例会失败 —— 正好用来确认重贴是否到位。
*& 只读: 不写任何表; quick_route 可能按会话 ZAI_TEST 读 ZAI_TASK(无数据也不影响)
*& V1.0 20261019
*& V1.1 20261020: 加「Fiori 报表」场景 4 项(需要 INTENT_ROUTER V1.0.6; 共 29 项)
*&---------------------------------------------------------------------*
REPORT zai_test_agent_core.

CLASS lcl_t DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-DATA: gv_pass TYPE i,
                gv_fail TYPE i.
    CLASS-METHODS check
      IMPORTING iv_name TYPE string
                iv_ok   TYPE abap_bool
                iv_info TYPE string OPTIONAL.
ENDCLASS.

CLASS lcl_t IMPLEMENTATION.
  METHOD check.
    IF iv_ok = abap_true.
      gv_pass = gv_pass + 1.
      WRITE: / '[通过]', iv_name.
    ELSE.
      gv_fail = gv_fail + 1.
      WRITE: / '[失败]' COLOR COL_NEGATIVE, iv_name.
      IF iv_info IS NOT INITIAL.
        WRITE: / '        ', iv_info.
      ENDIF.
    ENDIF.
  ENDMETHOD.
ENDCLASS.

START-OF-SELECTION.

  DATA: ls_out   TYPE zcl_ai_agent_guard=>ty_llm_out,
        lv_err   TYPE string,
        lv_obj   TYPE string,
        lv_in    TYPE string,
        lv_sub   TYPE string,
        lt_kv    TYPE zcl_ai_agent_guard=>tt_kv,
        lt_rkv   TYPE zcl_ai_report_service=>tt_kv,
        ls_rkv   TYPE zcl_ai_report_service=>ty_kv,
        ls_int   TYPE zcl_ai_intent_router=>ty_intent.

  " 三个反引号不直接写进字符串字面量(避免各种工具误处理反引号), 运行时拼出来
  DATA(lv_fence) = repeat( val = '`' occ = 3 ).
  DATA(lv_nl)    = cl_abap_char_utilities=>newline.

  "======================== AGENT_GUARD.parse_model_json(BE-01) ========================
  WRITE: / '━━ AGENT_GUARD.parse_model_json'.
  lv_obj = `{"action":"final","summary":"x","answer":"说明\n` && lv_fence &&
           `abap\nDATA lv TYPE i.\n  lv = 1.\n` && lv_fence && `"}`.

  CLEAR: ls_out, lv_err.
  zcl_ai_agent_guard=>parse_model_json( EXPORTING iv_raw = lv_obj
                                        IMPORTING es_out = ls_out ev_error = lv_err ).
  lcl_t=>check( iv_name = `纯对象: 解析成功, action=final` iv_ok = xsdbool( lv_err IS INITIAL AND ls_out-action = 'final' ) iv_info = lv_err ).
  lv_sub = lv_fence && `abap`.
  lcl_t=>check( iv_name = `answer 保留代码围栏` iv_ok = xsdbool( find( val = ls_out-answer sub = lv_sub ) >= 0 ) iv_info = ls_out-answer ).
  lv_sub = lv_nl && `  lv = 1.`.
  lcl_t=>check( iv_name = `answer 保留两个空格缩进` iv_ok = xsdbool( find( val = ls_out-answer sub = lv_sub ) >= 0 ) iv_info = ls_out-answer ).

  lv_in = `好的：` && lv_nl && lv_fence && `json` && lv_nl && lv_obj && lv_nl && lv_fence.
  CLEAR: ls_out, lv_err.
  zcl_ai_agent_guard=>parse_model_json( EXPORTING iv_raw = lv_in
                                        IMPORTING es_out = ls_out ev_error = lv_err ).
  lcl_t=>check( iv_name = `前缀文字 + json 围栏: 直接解析成功(不进修复轮)` iv_ok = xsdbool( lv_err IS INITIAL AND ls_out-action = 'final' ) iv_info = lv_err ).

  lv_in = `我先查一下。{"action":"tool","tool":"run_sql","summary":"查数","args": {"sql":"SELECT 1"}} 稍等`.
  CLEAR: ls_out, lv_err.
  zcl_ai_agent_guard=>parse_model_json( EXPORTING iv_raw = lv_in
                                        IMPORTING es_out = ls_out ev_error = lv_err ).
  lcl_t=>check( iv_name = `前后带文字的 tool 调用: tool 与 args 正确` iv_ok = xsdbool( lv_err IS INITIAL AND ls_out-tool = 'run_sql' AND ls_out-args = `"sql":"SELECT 1"` ) iv_info = |{ lv_err } / { ls_out-args }| ).

  CLEAR: ls_out, lv_err.
  zcl_ai_agent_guard=>parse_model_json( EXPORTING iv_raw = `这里没有 JSON`
                                        IMPORTING es_out = ls_out ev_error = lv_err ).
  lcl_t=>check( iv_name = `没有 JSON: 返回协议错误(进修复轮)` iv_ok = xsdbool( lv_err IS NOT INITIAL ) ).

  "======================== AGENT_GUARD.parse_flat_json(BE-02) ========================
  WRITE: / '━━ AGENT_GUARD.parse_flat_json'.
  " 入参是 args 的内层内容(不带外层花括号, 与 parse_model_json 的 es_out-args 一致)
  CLEAR: lt_kv, lv_err.
  zcl_ai_agent_guard=>parse_flat_json( EXPORTING iv_json = `"sql":"SELECT a\nFROM b","note":"say \"hi\""`
                                       IMPORTING et_kv = lt_kv ev_error = lv_err ).
  lv_sub = `SELECT a` && lv_nl && `FROM b`.
  lcl_t=>check( iv_name = `\n 还原为换行` iv_ok = xsdbool( lv_err IS INITIAL AND zcl_ai_agent_guard=>kv_get( it_kv = lt_kv iv_name = `sql` ) = lv_sub ) iv_info = lv_err ).
  lcl_t=>check( iv_name = `\" 不截断并还原为引号` iv_ok = xsdbool( zcl_ai_agent_guard=>kv_get( it_kv = lt_kv iv_name = `note` ) = `say "hi"` ) ).

  "======================== REPORT_SERVICE.parse_flat_kv(BE-11) ========================
  WRITE: / '━━ REPORT_SERVICE.parse_flat_kv'.
  lt_rkv = zcl_ai_report_service=>parse_flat_kv( `{"P_WERKS":"1000","S_MODEL":"A\"B","N":5}` ).
  CLEAR ls_rkv.
  READ TABLE lt_rkv INTO ls_rkv WITH KEY name = `p_werks`.
  lcl_t=>check( iv_name = `键转小写、普通值` iv_ok = xsdbool( sy-subrc = 0 AND ls_rkv-value = `1000` ) ).
  CLEAR ls_rkv.
  READ TABLE lt_rkv INTO ls_rkv WITH KEY name = `s_model`.
  lcl_t=>check( iv_name = `\" 不截断并还原为引号` iv_ok = xsdbool( sy-subrc = 0 AND ls_rkv-value = `A"B` ) iv_info = ls_rkv-value ).
  CLEAR ls_rkv.
  READ TABLE lt_rkv INTO ls_rkv WITH KEY name = `n`.
  lcl_t=>check( iv_name = `数字值` iv_ok = xsdbool( sy-subrc = 0 AND ls_rkv-value = `5` ) ).

  "======================== LLM_CLIENT.is_retryable(BE-07) ========================
  WRITE: / '━━ LLM_CLIENT.is_retryable'.
  lcl_t=>check( iv_name = `网络层快速失败 → 重试` iv_ok = zcl_ai_llm_client=>is_retryable( iv_code = 0 iv_comm_fail = abap_true iv_elapsed_ms = 800 iv_timeout_s = 60 ) ).
  lcl_t=>check( iv_name = `读超时(已耗时过半) → 不重试` iv_ok = xsdbool( zcl_ai_llm_client=>is_retryable( iv_code = 0 iv_comm_fail = abap_true iv_elapsed_ms = 45000 iv_timeout_s = 60 ) = abap_false ) ).
  lcl_t=>check( iv_name = `HTTP 429 → 重试` iv_ok = zcl_ai_llm_client=>is_retryable( iv_code = 429 iv_comm_fail = abap_false iv_elapsed_ms = 100 iv_timeout_s = 60 ) ).
  lcl_t=>check( iv_name = `HTTP 503 → 重试` iv_ok = zcl_ai_llm_client=>is_retryable( iv_code = 503 iv_comm_fail = abap_false iv_elapsed_ms = 100 iv_timeout_s = 60 ) ).
  lcl_t=>check( iv_name = `HTTP 400 → 不重试` iv_ok = xsdbool( zcl_ai_llm_client=>is_retryable( iv_code = 400 iv_comm_fail = abap_false iv_elapsed_ms = 100 iv_timeout_s = 60 ) = abap_false ) ).
  lcl_t=>check( iv_name = `HTTP 401 → 不重试` iv_ok = xsdbool( zcl_ai_llm_client=>is_retryable( iv_code = 401 iv_comm_fail = abap_false iv_elapsed_ms = 100 iv_timeout_s = 60 ) = abap_false ) ).

  "======================== INTENT_ROUTER 场景 ========================
  WRITE: / '━━ INTENT_ROUTER'.
  lcl_t=>check( iv_name = `空场景 = AUTO` iv_ok = xsdbool( zcl_ai_intent_router=>normalize_scene( `` ) = `AUTO` ) ).
  lcl_t=>check( iv_name = `GENERAL = AUTO` iv_ok = xsdbool( zcl_ai_intent_router=>normalize_scene( `GENERAL` ) = `AUTO` ) ).
  lcl_t=>check( iv_name = `INVENTORY 保留(旧会话)` iv_ok = xsdbool( zcl_ai_intent_router=>normalize_scene( `inventory` ) = `INVENTORY` ) ).

  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `执行 ZDPMM702` iv_session_id = `ZAI_TEST` iv_scene = `DATA` ).
  lcl_t=>check( iv_name = `数据分析场景: 执行报表 → 场景外` iv_ok = ls_int-out_of_scene iv_info = ls_int-reason ).
  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `统计 ZIDPMM455 中提交日期的分布` iv_session_id = `ZAI_TEST` iv_scene = `DATA` ).
  lcl_t=>check( iv_name = `数据分析场景: 含"提交"不误判报表执行` iv_ok = xsdbool( ls_int-out_of_scene = abap_false AND ls_int-module_id = `DATA` ) iv_info = |{ ls_int-module_id } / { ls_int-reason }| ).
  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `物料 A001 的库存` iv_session_id = `ZAI_TEST` iv_scene = `REPORT` ).
  lcl_t=>check( iv_name = `报表场景: 库存 → 场景外` iv_ok = ls_int-out_of_scene iv_info = ls_int-reason ).
  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `表 MARD 的字段` iv_session_id = `ZAI_TEST` iv_scene = `INVENTORY` ).
  lcl_t=>check( iv_name = `库存场景: 查表 → 场景外` iv_ok = ls_int-out_of_scene iv_info = ls_int-reason ).
  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `执行 ZDPMM702` iv_session_id = `ZAI_TEST` iv_scene = `CODE` ).
  lcl_t=>check( iv_name = `代码场景: 执行报表 → 场景外` iv_ok = ls_int-out_of_scene iv_info = ls_int-reason ).
  " V1.1: Fiori 报表场景(INTENT_ROUTER V1.0.6)
  lcl_t=>check( iv_name = `FIORI 是显式场景` iv_ok = xsdbool( zcl_ai_intent_router=>normalize_scene( `fiori` ) = `FIORI` ) ).
  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `选择报表：shipment報表` iv_session_id = `ZAI_TEST` iv_scene = `FIORI` ).
  lcl_t=>check( iv_name = `Fiori 场景: 选择报表 → FIORI 意图` iv_ok = xsdbool( ls_int-out_of_scene = abap_false AND ls_int-module_id = `FIORI` ) iv_info = |{ ls_int-module_id } / { ls_int-reason }| ).
  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `执行 ZDPMM702` iv_session_id = `ZAI_TEST` iv_scene = `FIORI` ).
  lcl_t=>check( iv_name = `Fiori 场景: 执行 TCode → 场景外` iv_ok = ls_int-out_of_scene iv_info = ls_int-reason ).
  ls_int = zcl_ai_intent_router=>quick_route( iv_question = `表 MARD 的字段` iv_session_id = `ZAI_TEST` iv_scene = `FIORI` ).
  lcl_t=>check( iv_name = `Fiori 场景: 查表 → 场景外` iv_ok = ls_int-out_of_scene iv_info = ls_int-reason ).

  SKIP.
  IF lcl_t=>gv_fail = 0.
    WRITE: / '全部通过:', lcl_t=>gv_pass, '项' COLOR COL_POSITIVE.
  ELSE.
    WRITE: / '有失败:', lcl_t=>gv_fail, '项失败 /', lcl_t=>gv_pass, '项通过' COLOR COL_NEGATIVE.
  ENDIF.
