*=======================================================================
* 对象:   ZCL_AI_AGENT_HTTP
* 用途:   浏览器 Agent 引擎(Deep Agents 浏览器版)的 SAP 服务 —— SICF 节点
*         /sap/bc/zai_agent 的处理类(IF_HTTP_EXTENSION)
*         设计: 功能计划书/Deep Agents浏览器接入/02-方案与开发计划_V2.0 §5.1
*
*         POST /run/start         { sessionId, scene, modelId, question, think, skillId }
*              → { runId, model, tools:[{name,description,parameters}], systemPrompt, limits }
*         POST /chat/completions  OpenAI 兼容请求体; 头 X-Lingxi-Run = 运行号
*              → 网关响应原文(SAP 用自己的模型配置与密钥转发, 透传 tools / tool_calls)
*         POST /tools/exec        { runId, tool, args:{…}, requestId } → { ok, content, message, card? }
*              card = 报表参数卡(open_report / prefill_report), 浏览器拿到即结束运行
*         POST /run/finish        { runId, status, answer, message, skillsUsed } → { ok }
*         POST /results/export    { runId, resultId } → { ok, label, rows, columns, truncated, csv }(V1.1)
*
* 安全:   ① 只收 POST; ② 必须带 X-Lingxi-Agent: 1(跨站表单发不出自定义头; 跨站 fetch
*           带它会触发预检, 本节点不回 CORS 头 → 浏览器拦下);
*         ③ 带 Origin 时必须与本机 Host 一致; ④ 用户 = ICF 登录用户(sy-uname),
*           浏览器发来的用户 / 工具清单 / 次数一律不信, 全部在 ZCL_AI_AGENT_SERVICE 里重新校验
*         ⑤ 模型密钥只在 SAP(ZAI_MODEL_CFG), 不回给浏览器
* 部署:   SE24 创建本类(接口 IF_HTTP_EXTENSION) → SICF 在 /sap/bc/ 下建服务 zai_agent,
*         处理程序列表填本类; 登录方式与灵犀 BSP 应用一致 → 激活
* 依赖:   ZCL_AI_AGENT_SERVICE V15.18 / ZCL_AI_LLM_CLIENT V1.7 / ZAI_BRUN
* 版本:   V1.0 20261107 首版
*         V1.1 20261107 浏览器 Agent M2: /run/start 回 skills / export; /tools/exec 回 card;
*              /run/finish 收 skillsUsed; 新路径 /results/export(依赖 ZCL_AI_AGENT_SERVICE V15.19)
*         V1.2 20261107 /run/start 收 focusArtifactId、回 answer / card(Fiori 确定性回答);
*              /tools/exec 回 datasets(界面表格 / 图表)(依赖 ZCL_AI_AGENT_SERVICE V15.20)
*         ★ 重贴后核对标记: INTERFACES if_http_extension; handle_request 里有
*           WHEN '/run/start' / '/chat/completions' / '/tools/exec' / '/results/export' / '/run/finish'
*=======================================================================
CLASS zcl_ai_agent_http DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PROTECTED SECTION.
  PRIVATE SECTION.

    TYPES: BEGIN OF ty_start_req,
             session_id TYPE string,
             scene      TYPE string,
             model_id   TYPE string,
             question   TYPE string,
             think      TYPE abap_bool,
             skill_id   TYPE string,
             focus_artifact_id TYPE string,   " V1.2: 前端聚焦的结果(Fiori「交给模型分析」)
           END OF ty_start_req.
    TYPES: BEGIN OF ty_tool_req,
             run_id     TYPE string,
             tool       TYPE string,
             request_id TYPE string,
           END OF ty_tool_req.
    TYPES: BEGIN OF ty_finish_req,
             run_id      TYPE string,
             status      TYPE string,
             answer      TYPE string,
             message     TYPE string,
             skills_used TYPE string_table,   " V1.1: 模型读过的 SAP 技能编号
           END OF ty_finish_req.
    TYPES: BEGIN OF ty_export_req,
             run_id    TYPE string,
             result_id TYPE string,
           END OF ty_export_req.

    " 写 JSON 响应
    CLASS-METHODS reply
      IMPORTING io_server TYPE REF TO if_http_server
                iv_code   TYPE i
                iv_json   TYPE string.

    " 写错误响应 { ok:false, message } (OpenAI 路径用 { error:{ message } })
    CLASS-METHODS fail
      IMPORTING io_server TYPE REF TO if_http_server
                iv_code   TYPE i
                iv_msg    TYPE string
                iv_openai TYPE abap_bool OPTIONAL.

    " JSON 字符串值(带引号, 已转义)
    CLASS-METHODS jstr
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.

    " 请求体 → 结构(驼峰键名)
    CLASS-METHODS parse
      IMPORTING iv_json TYPE string
      CHANGING  cs_data TYPE any.

    " Origin 与本机 Host 一致(没带 Origin 视为同源)
    CLASS-METHODS origin_ok
      IMPORTING io_server TYPE REF TO if_http_server
      RETURNING VALUE(rv) TYPE abap_bool.

ENDCLASS.



CLASS zcl_ai_agent_http IMPLEMENTATION.


  METHOD if_http_extension~handle_request.

    if_http_extension~flow_rc = if_http_extension=>co_flow_ok.

    " ---- 0. 请求方式 / 自定义头 / 来源 ----
    IF to_upper( server->request->get_header_field( '~request_method' ) ) <> 'POST'.
      fail( io_server = server iv_code = 405 iv_msg = '只接受 POST' ).
      RETURN.
    ENDIF.
    IF server->request->get_header_field( 'x-lingxi-agent' ) <> '1'.
      fail( io_server = server iv_code = 403 iv_msg = '缺少 X-Lingxi-Agent 请求头' ).
      RETURN.
    ENDIF.
    IF origin_ok( server ) = abap_false.
      fail( io_server = server iv_code = 403 iv_msg = '请求来源与本系统不一致' ).
      RETURN.
    ENDIF.

    DATA(lv_path) = to_lower( server->request->get_header_field( '~path_info' ) ).
    DATA(lv_body) = server->request->get_cdata( ).

    TRY.
        CASE lv_path.

          " ---------------- 开始运行 ----------------
          WHEN '/run/start'.
            DATA ls_start TYPE ty_start_req.
            parse( EXPORTING iv_json = lv_body CHANGING cs_data = ls_start ).
            DATA: ls_out  TYPE zcl_ai_agent_service=>ty_brun_start,
                  lv_err  TYPE string,
                  lv_http TYPE i.
            zcl_ai_agent_service=>browser_start(
              EXPORTING iv_session_id = ls_start-session_id
                        iv_scene      = ls_start-scene
                        iv_model_id   = ls_start-model_id
                        iv_question   = ls_start-question
                        iv_skill_id   = ls_start-skill_id
                        iv_think      = COND #( WHEN ls_start-think = abap_true THEN `X` ELSE `` )
                        iv_focus_artifact_id = ls_start-focus_artifact_id
              IMPORTING es_start      = ls_out
                        ev_error      = lv_err
                        ev_http       = lv_http ).
            IF lv_err IS NOT INITIAL.
              ROLLBACK WORK.
              fail( io_server = server iv_code = lv_http iv_msg = lv_err ).
              RETURN.
            ENDIF.
            COMMIT WORK.
            reply( io_server = server iv_code = 200
                   iv_json = |\{"ok":true,"runId":{ jstr( ls_out-run_id ) },"model":{ jstr( ls_out-model ) },| &&
                             |"tools":{ ls_out-tools_json },"systemPrompt":{ jstr( ls_out-system ) },| &&
                             |"skills":{ COND string( WHEN ls_out-skills_json IS INITIAL THEN `[]` ELSE ls_out-skills_json ) },| &&
                             |"export":{ COND string( WHEN ls_out-export = abap_true THEN `true` ELSE `false` ) },| &&
                             |"answer":{ jstr( ls_out-answer ) },| &&
                             COND string( WHEN ls_out-card IS NOT INITIAL THEN |"card":{ ls_out-card },| ) &&
                             |"limits":\{"maxModelCalls":{ ls_out-max_model },"maxToolCalls":{ ls_out-max_tool },| &&
                             |"recursionLimit":{ ( ls_out-max_model + ls_out-max_tool ) * 2 + 10 }\}\}| ).

          " ---------------- 一轮模型调用(OpenAI 兼容) ----------------
          WHEN '/chat/completions'.
            DATA: lv_code TYPE i,
                  lv_resp TYPE string.
            zcl_ai_agent_service=>browser_model(
              EXPORTING iv_run_id = server->request->get_header_field( 'x-lingxi-run' )
                        iv_body   = lv_body
              IMPORTING ev_code   = lv_code
                        ev_resp   = lv_resp
                        ev_error  = lv_err ).
            COMMIT WORK.
            IF lv_code = 200 AND lv_err IS INITIAL.
              reply( io_server = server iv_code = 200 iv_json = lv_resp ).
            ELSE.
              fail( io_server = server iv_code = COND #( WHEN lv_code >= 400 THEN lv_code ELSE 502 )
                    iv_msg = lv_err iv_openai = abap_true ).
            ENDIF.

          " ---------------- 执行一个工具 ----------------
          WHEN '/tools/exec'.
            DATA ls_tool TYPE ty_tool_req.
            parse( EXPORTING iv_json = lv_body CHANGING cs_data = ls_tool ).
            IF ls_tool-run_id <> server->request->get_header_field( 'x-lingxi-run' ).
              fail( io_server = server iv_code = 400 iv_msg = '运行号不一致' ).
              RETURN.
            ENDIF.
            DATA: lv_ok      TYPE abap_bool,
                  lv_content TYPE string,
                  lv_msg     TYPE string,
                  lv_card    TYPE string,
                  lv_ds      TYPE string.
            zcl_ai_agent_service=>browser_tool(
              EXPORTING iv_run_id  = ls_tool-run_id
                        iv_tool    = ls_tool-tool
                        iv_args    = zcl_ai_agent_guard=>extract_args_object( lv_body )
              IMPORTING ev_ok      = lv_ok
                        ev_content = lv_content
                        ev_message = lv_msg
                        ev_http    = lv_http
                        ev_card    = lv_card
                        ev_datasets = lv_ds ).
            COMMIT WORK.
            IF lv_http <> 200.
              fail( io_server = server iv_code = lv_http iv_msg = lv_msg ).
            ELSE.
              reply( io_server = server iv_code = 200
                     iv_json = |\{"ok":{ COND string( WHEN lv_ok = abap_true THEN `true` ELSE `false` ) },| &&
                               |"content":{ jstr( lv_content ) },"message":{ jstr( lv_msg ) }| &&
                               COND string( WHEN lv_card IS NOT INITIAL THEN |,"card":{ lv_card }| ) &&
                               COND string( WHEN lv_ds IS NOT INITIAL THEN |,"datasets":{ lv_ds }| ) && |\}| ).
            ENDIF.

          " ---------------- V1.1: 把一份报表结果导出成 CSV(浏览器写进用户文件夹) ----------------
          WHEN '/results/export'.
            DATA ls_exp TYPE ty_export_req.
            parse( EXPORTING iv_json = lv_body CHANGING cs_data = ls_exp ).
            IF ls_exp-run_id <> server->request->get_header_field( 'x-lingxi-run' ).
              fail( io_server = server iv_code = 400 iv_msg = '运行号不一致' ).
              RETURN.
            ENDIF.
            DATA: lv_csv   TYPE string,
                  lv_label TYPE string,
                  lv_rows  TYPE i,
                  lv_cols  TYPE i,
                  lv_trunc TYPE abap_bool.
            zcl_ai_agent_service=>browser_export(
              EXPORTING iv_run_id    = ls_exp-run_id
                        iv_result_id = ls_exp-result_id
              IMPORTING ev_csv       = lv_csv
                        ev_label     = lv_label
                        ev_rows      = lv_rows
                        ev_cols      = lv_cols
                        ev_trunc     = lv_trunc
                        ev_error     = lv_err
                        ev_http      = lv_http ).
            COMMIT WORK.
            IF lv_http <> 200.
              fail( io_server = server iv_code = lv_http iv_msg = lv_err ).
            ELSEIF lv_err IS NOT INITIAL.
              reply( io_server = server iv_code = 200 iv_json = |\{"ok":false,"message":{ jstr( lv_err ) }\}| ).
            ELSE.
              reply( io_server = server iv_code = 200
                     iv_json = |\{"ok":true,"label":{ jstr( lv_label ) },"rows":{ lv_rows },"columns":{ lv_cols },| &&
                               |"truncated":{ COND string( WHEN lv_trunc = abap_true THEN `true` ELSE `false` ) },| &&
                               |"csv":{ jstr( lv_csv ) }\}| ).
            ENDIF.

          " ---------------- 结束运行(写回会话) ----------------
          WHEN '/run/finish'.
            DATA ls_fin TYPE ty_finish_req.
            parse( EXPORTING iv_json = lv_body CHANGING cs_data = ls_fin ).
            zcl_ai_agent_service=>browser_finish(
              EXPORTING iv_run_id  = ls_fin-run_id
                        iv_status  = ls_fin-status
                        iv_answer  = ls_fin-answer
                        iv_message = ls_fin-message
                        it_skills  = ls_fin-skills_used
              IMPORTING ev_error   = lv_err
                        ev_http    = lv_http ).
            IF lv_err IS NOT INITIAL.
              ROLLBACK WORK.
              fail( io_server = server iv_code = lv_http iv_msg = lv_err ).
              RETURN.
            ENDIF.
            COMMIT WORK.
            reply( io_server = server iv_code = 200 iv_json = '{"ok":true}' ).

          WHEN OTHERS.
            fail( io_server = server iv_code = 404 iv_msg = |未知路径 { lv_path }| ).
        ENDCASE.

      CATCH cx_root INTO DATA(lx).
        ROLLBACK WORK.
        fail( io_server = server iv_code = 500 iv_msg = |服务内部错误: { lx->get_text( ) }|
              iv_openai = xsdbool( lv_path = '/chat/completions' ) ).
    ENDTRY.

  ENDMETHOD.


  METHOD reply.

    io_server->response->set_status( code = iv_code reason = COND #( WHEN iv_code = 200 THEN `OK` ELSE `Error` ) ).
    io_server->response->set_header_field( name = 'Content-Type' value = 'application/json; charset=utf-8' ).
    io_server->response->set_header_field( name = 'Cache-Control' value = 'no-store' ).
    io_server->response->set_cdata( iv_json ).

  ENDMETHOD.


  METHOD fail.

    DATA(lv_msg) = COND string( WHEN iv_msg IS INITIAL THEN `请求失败` ELSE iv_msg ).
    reply( io_server = io_server
           iv_code   = COND #( WHEN iv_code >= 400 THEN iv_code ELSE 500 )
           iv_json   = COND #( WHEN iv_openai = abap_true
                               THEN |\{"error":\{"message":{ jstr( lv_msg ) },"type":"lingxi_error"\}\}|
                               ELSE |\{"ok":false,"message":{ jstr( lv_msg ) }\}| ) ).

  ENDMETHOD.


  METHOD jstr.

    rv = /ui2/cl_json=>serialize( data = iv ).
    IF rv IS INITIAL.
      rv = '""'.
    ENDIF.

  ENDMETHOD.


  METHOD parse.

    IF iv_json IS INITIAL.
      RETURN.
    ENDIF.
    /ui2/cl_json=>deserialize( EXPORTING json        = iv_json
                                         pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                               CHANGING  data        = cs_data ).

  ENDMETHOD.


  METHOD origin_ok.

    rv = abap_true.
    DATA(lv_origin) = to_lower( io_server->request->get_header_field( 'origin' ) ).
    IF lv_origin IS INITIAL.
      RETURN.
    ENDIF.
    " https://host:port → host:port
    DATA(lv_o_host) = lv_origin.
    REPLACE FIRST OCCURRENCE OF REGEX '^https?://' IN lv_o_host WITH ``.
    DATA(lv_host) = to_lower( io_server->request->get_header_field( 'host' ) ).
    IF lv_o_host = lv_host.
      RETURN.
    ENDIF.
    " 经 Web Dispatcher / 反向代理时, 浏览器看到的主机名在 X-Forwarded-Host
    DATA(lv_fwd) = to_lower( io_server->request->get_header_field( 'x-forwarded-host' ) ).
    IF lv_fwd IS NOT INITIAL AND ( lv_o_host = lv_fwd OR lv_fwd = |{ lv_o_host }:443| ).
      RETURN.
    ENDIF.
    " 默认端口: Origin 不带 :443 / :80, Host 可能带
    IF lv_host = |{ lv_o_host }:443| OR lv_host = |{ lv_o_host }:80|.
      RETURN.
    ENDIF.
    rv = abap_false.

  ENDMETHOD.

ENDCLASS.
