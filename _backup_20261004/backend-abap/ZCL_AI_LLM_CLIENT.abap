*=======================================================================
* 对象:   ZCL_AI_LLM_CLIENT
* 用途:   通用大模型 HTTP 客户端(零代码切换模型)
*         - OLLAMA : 本地 Ollama 私有化服务  POST {url}/api/chat
*         - OPENAI : OpenAI 兼容接口(vLLM/DeepSeek/通义等) POST {完整url}
* 说明:   模型的地址/密钥/超时等全部来自配置表 ZAI_MODEL_CFG 的行数据,
*         新增大模型只需在表中加一行, 不需要修改本类任何代码。
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (适用 S/4HANA 760)
* V1.2:   修正 MAX_TOKENS 未维护时的两个问题:
*         - OpenAI 兼容: "max_tokens":0 会被服务端拒绝, 默认 4096
*         - Ollama: 默认 num_predict=128 截断回复, 显式传 -1 不限长度
*=======================================================================
CLASS zcl_ai_llm_client DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES: BEGIN OF ty_message,
             role    TYPE string,      " system / user / assistant
             content TYPE string,
           END OF ty_message.
    TYPES tt_messages TYPE STANDARD TABLE OF ty_message WITH DEFAULT KEY.

    " 发送一轮对话请求
    " @parameter is_cfg      | 模型配置(ZAI_MODEL_CFG 单行)
    " @parameter it_messages | 消息数组(含 system 与多轮上下文)
    " @parameter ev_content  | 模型回复内容
    " @parameter ev_elapsed  | 耗时(毫秒)
    " @parameter ev_error    | 非空 = 失败原因
    CLASS-METHODS chat
      IMPORTING is_cfg       TYPE zai_model_cfg
                it_messages  TYPE tt_messages
      EXPORTING ev_content   TYPE string
                ev_elapsed   TYPE i
                ev_error     TYPE string.

  PROTECTED SECTION.
  PRIVATE SECTION.

    TYPES: BEGIN OF ty_opt,
             temperature TYPE p LENGTH 3 DECIMALS 2,
             num_predict TYPE i,       " V1.2: Ollama 默认 128 会截断回复
           END OF ty_opt.

    " ---- Ollama /api/chat 请求体 ----
    TYPES: BEGIN OF ty_ol_body,
             model     TYPE string,
             messages  TYPE tt_messages,
             stream    TYPE abap_bool,
             options   TYPE ty_opt,
           END OF ty_ol_body.

    " ---- OpenAI 兼容 /v1/chat/completions 请求体 ----
    TYPES: BEGIN OF ty_oai_body,
             model       TYPE string,
             messages    TYPE tt_messages,
             stream      TYPE abap_bool,
             temperature TYPE p LENGTH 3 DECIMALS 2,
             max_tokens  TYPE i,
           END OF ty_oai_body.

    " ---- 响应结构 ----
    TYPES: BEGIN OF ty_choice,
             message       TYPE ty_message,
             finish_reason TYPE string,
           END OF ty_choice.
    TYPES tt_choice TYPE STANDARD TABLE OF ty_choice WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_err_obj,      " OpenAI: {"error":{"message":"..."}}
             message TYPE string,
           END OF ty_err_obj.

    TYPES: BEGIN OF ty_oai_resp,
             choices TYPE tt_choice,
             error   TYPE ty_err_obj,
           END OF ty_oai_resp.

    TYPES: BEGIN OF ty_ol_resp,      " Ollama: {"message":{...},"error":"..."}
             message TYPE ty_message,
             error   TYPE string,
           END OF ty_ol_resp.

ENDCLASS.



CLASS zcl_ai_llm_client IMPLEMENTATION.

  METHOD chat.

    DATA: lo_http   TYPE REF TO if_http_client,
          lv_body   TYPE string,
          lv_resp   TYPE string,
          lv_code   TYPE i,
          lv_reason TYPE string,
          lv_t1     TYPE i,
          lv_t2     TYPE i,
          lx        TYPE REF TO cx_root.

    CLEAR: ev_content, ev_elapsed, ev_error.

    " ---------------- 0. 配置校验 ----------------
    IF is_cfg-endpoint_url IS INITIAL AND is_cfg-destination IS INITIAL.
      ev_error = '模型配置缺少 ENDPOINT_URL / DESTINATION(ZAI_MODEL_CFG)'.
      RETURN.
    ENDIF.
    IF is_cfg-endpoint_url IS NOT INITIAL
       AND is_cfg-endpoint_url NP 'http://*'
       AND is_cfg-endpoint_url NP 'https://*'.
      ev_error = |ENDPOINT_URL 必须以 http:// 或 https:// 开头: { is_cfg-endpoint_url }|.
      RETURN.
    ENDIF.

    " ---------------- 1. 构造请求体 ----------------
    DATA lv_temp TYPE p LENGTH 3 DECIMALS 2.
    TRY.
        IF is_cfg-temperature IS NOT INITIAL.
          lv_temp = is_cfg-temperature.
        ELSE.
          lv_temp = '0.3'.          " 配置表未维护温度时的默认值
        ENDIF.
      CATCH cx_root.
        lv_temp = '0.3'.
    ENDTRY.

    IF is_cfg-model_type = 'OLLAMA'.
      DATA(ls_ol) = VALUE ty_ol_body(
        model    = is_cfg-api_model
        messages = it_messages
        stream   = abap_false ).
      ls_ol-options-temperature = lv_temp.
      " V1.2: Ollama 默认 num_predict=128 会把回复截断; 配置了 MAX_TOKENS 则使用, 否则 -1 不限长度
      ls_ol-options-num_predict = COND #( WHEN is_cfg-max_tokens > 0 THEN is_cfg-max_tokens ELSE -1 ).
      lv_body = /ui2/cl_json=>serialize(
                  data          = ls_ol
                  compress      = abap_false
                  name_mappings = VALUE #( ( abap = 'MODEL'       json = 'model' )
                                           ( abap = 'MESSAGES'    json = 'messages' )
                                           ( abap = 'STREAM'      json = 'stream' )
                                           ( abap = 'OPTIONS'     json = 'options' )
                                           ( abap = 'TEMPERATURE' json = 'temperature' )
                                           ( abap = 'NUM_PREDICT' json = 'num_predict' )
                                           ( abap = 'ROLE'        json = 'role' )
                                           ( abap = 'CONTENT'     json = 'content' ) ) ).
    ELSE.
      " OPENAI 兼容: vLLM / DeepSeek / 通义 / 智谱 等
      DATA(ls_oai) = VALUE ty_oai_body(
        model       = is_cfg-api_model
        messages    = it_messages
        stream      = abap_false
        temperature = lv_temp
        max_tokens  = is_cfg-max_tokens ).
      " V1.2: 配置表 MAX_TOKENS 未维护(=0)时给默认值,
      " 避免 "max_tokens": 0 被 DeepSeek 等 OpenAI 兼容服务拒绝(400)或输出为空
      IF ls_oai-max_tokens <= 0.
        ls_oai-max_tokens = 4096.
      ENDIF.
      lv_body = /ui2/cl_json=>serialize(
                  data          = ls_oai
                  compress      = abap_false
                  name_mappings = VALUE #( ( abap = 'MODEL'       json = 'model' )
                                           ( abap = 'MESSAGES'    json = 'messages' )
                                           ( abap = 'STREAM'      json = 'stream' )
                                           ( abap = 'TEMPERATURE' json = 'temperature' )
                                           ( abap = 'MAX_TOKENS'  json = 'max_tokens' )
                                           ( abap = 'ROLE'        json = 'role' )
                                           ( abap = 'CONTENT'     json = 'content' ) ) ).
    ENDIF.

    " ---------------- 2. 创建 HTTP 客户端 ----------------
    GET RUN TIME FIELD lv_t1.
    TRY.
        IF is_cfg-destination IS NOT INITIAL.
          " 推荐方式: SM59 类型 G 目的地(便于统一管理证书/代理)
          cl_http_client=>create_by_destination(
            EXPORTING destination = CONV rfcdest( is_cfg-destination )
            IMPORTING client      = lo_http ).
        ELSE.
          " 直连方式: 需要系统已配置 HTTP 白名单(SAP Note 2751995)
          cl_http_client=>create_by_url(
            EXPORTING url     = CONV #( is_cfg-endpoint_url )
            IMPORTING client  = lo_http ).
        ENDIF.
      CATCH cx_root INTO lx.
        ev_error = |创建 HTTP 客户端失败: { lx->get_text( ) }|.
        RETURN.
    ENDTRY.

    " ---------------- 3. 设置请求头与报文 ----------------
    lo_http->request->set_method( if_http_request=>co_request_method_post ).
    lo_http->request->set_header_field( name  = 'Content-Type'
                                        value = 'application/json; charset=utf-8' ).
    CASE is_cfg-auth_type.
      WHEN 'BEARER'.
        lo_http->request->set_header_field( name  = 'Authorization'
                                            value = |Bearer { is_cfg-api_key }| ).
      WHEN 'X_API_KEY'.
        lo_http->request->set_header_field( name  = 'x-api-key'
                                            value = is_cfg-api_key ).
      WHEN OTHERS.
        " NONE: 本地无鉴权服务
    ENDCASE.
    lo_http->request->set_cdata( lv_body ).

    " ---------------- 4. 发送与接收 ----------------
    DATA(lv_timeout) = is_cfg-timeout_sec.
    IF lv_timeout <= 0.
      lv_timeout = 300.
    ENDIF.

    lo_http->send( EXPORTING timeout = lv_timeout
                   EXCEPTIONS http_communication_failure = 1
                              http_invalid_state          = 2
                              http_processing_failed      = 3
                              OTHERS                      = 4 ).
    IF sy-subrc <> 0.
      ev_error = |发送请求失败(subrc={ sy-subrc }), 检查网络/白名单/SM59 目的地|.
      lo_http->close( ).
      RETURN.
    ENDIF.

    lo_http->receive( EXCEPTIONS http_communication_failure = 1
                                 http_invalid_state          = 2
                                 http_processing_failed      = 3
                                 OTHERS                      = 4 ).
    IF sy-subrc <> 0.
      ev_error = |接收响应失败(subrc={ sy-subrc }), 可能是模型服务超时({ lv_timeout }s)|.
      lo_http->close( ).
      RETURN.
    ENDIF.

    lo_http->response->get_status( IMPORTING code   = lv_code
                                             reason = lv_reason ).
    lv_resp = lo_http->response->get_cdata( ).
    lo_http->close( ).

    GET RUN TIME FIELD lv_t2.
    ev_elapsed = ( lv_t2 - lv_t1 ) / 1000.

    " ---------------- 5. 解析响应 ----------------
    IF lv_code <> 200.
      " 尽力从响应中提取错误信息, 否则展示响应片段
      DATA(lv_snippet) = lv_resp.
      IF strlen( lv_snippet ) > 300.
        lv_snippet = lv_snippet(300).
      ENDIF.
      ev_error = |HTTP { lv_code } { lv_reason }: { lv_snippet }|.
      RETURN.
    ENDIF.

    TRY.
        IF is_cfg-model_type = 'OLLAMA'.
          DATA ls_olr TYPE ty_ol_resp.
          /ui2/cl_json=>deserialize(
            EXPORTING json = lv_resp
                      name_mappings = VALUE #( ( abap = 'MESSAGE' json = 'message' )
                                               ( abap = 'ROLE'    json = 'role' )
                                               ( abap = 'CONTENT' json = 'content' )
                                               ( abap = 'ERROR'   json = 'error' ) )
            CHANGING  data = ls_olr ).
          ev_content = ls_olr-message-content.
          IF ev_content IS INITIAL AND ls_olr-error IS NOT INITIAL.
            ev_error = ls_olr-error.
          ENDIF.
        ELSE.
          DATA ls_oair TYPE ty_oai_resp.
          /ui2/cl_json=>deserialize(
            EXPORTING json = lv_resp
                      name_mappings = VALUE #( ( abap = 'CHOICES'       json = 'choices' )
                                               ( abap = 'MESSAGE'       json = 'message' )
                                               ( abap = 'ROLE'          json = 'role' )
                                               ( abap = 'CONTENT'       json = 'content' )
                                               ( abap = 'FINISH_REASON' json = 'finish_reason' )
                                               ( abap = 'ERROR'         json = 'error' ) )
            CHANGING  data = ls_oair ).
          READ TABLE ls_oair-choices INTO DATA(ls_choice) INDEX 1.
          IF sy-subrc = 0.
            ev_content = ls_choice-message-content.
          ENDIF.
          IF ls_oair-error-message IS NOT INITIAL.
            ev_error = ls_oair-error-message.
          ENDIF.
        ENDIF.
      CATCH cx_root INTO lx.
        ev_error = |响应 JSON 解析失败: { lx->get_text( ) }|.
        RETURN.
    ENDTRY.

    IF ev_error IS INITIAL AND ev_content IS INITIAL.
      ev_error = '模型返回了空内容, 请检查 API_MODEL 名称是否正确'.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
