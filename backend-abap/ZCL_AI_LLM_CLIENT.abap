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
* V1.3 20261019(改进清单 BE-07): 瞬时失败自动重试 1 次 ——
*         网络层失败(send/receive) / HTTP 429 / 5xx 视为瞬时, 间隔 1 秒重试一次;
*         4xx、配置错误、创建客户端失败不重试; 网络层失败且已耗时超过超时
*         一半(基本是读超时)也不重试, 免得超出调用方预算。新增可选入参
*         iv_no_retry、可选出参 ev_attempts(老调用方不用改); 判断规则单独
*         成 PUBLIC 方法 is_retryable 便于测试报表直接调用。间隔用 ENQUE_SLEEP
*         (WAIT UP TO 会触发隐式数据库提交), 不可用时直接重试
*         ★ 重贴后核对标记: chat 内有 DO 2 TIMES 与 is_retryable( 调用;
*           有 CALL FUNCTION 'ENQUE_SLEEP'; 定义区有 is_retryable 声明
* V1.4 20261028(10.28 记录 #01): 新增可选出参 ev_finish = 模型的结束原因
*         (OpenAI 兼容 finish_reason / Ollama done_reason; 'length' = 达到
*         MAX_TOKENS 被截断)。Agent 据此区分"回答太长被截断"与"格式写错",
*         给出对应的重写提示。老调用方不用改
*         ★ 重贴后核对标记: chat 声明有 ev_finish; 解析段有 to_lower( ls_choice-finish_reason )
* V1.5 20261028(功能计划书/Agent闭环增强/02 第 0 步): 新增可选出参 ev_usage = 本次
*         调用的用量(输入 / 输出 token、前缀缓存命中)。由 PUBLIC 方法 parse_usage
*         单独解析: OpenAI 兼容 usage(DeepSeek 风格 prompt_cache_hit_tokens /
*         OpenAI 风格 prompt_tokens_details.cached_tokens)、Ollama prompt_eval_count /
*         eval_count; 没有字段或解析失败时返回空, 不影响正文解析。老调用方不用改
*         ★ 重贴后核对标记: chat 声明有 ev_usage TYPE ty_usage; 有 ev_usage = parse_usage( lv_resp );
*           PUBLIC 有 parse_usage 声明
* V1.6 20261029(思考模式): 每个模型可单独开关思考。设置存 ZAI_CHAT_CFG-MODEL_THINK
*         (前端 设置 → 模型管理 维护, 不改表结构 / SEGW), 值 = "模型ID=写法开关" 逗号分隔,
*         例 DS_V4=DS1,GLM_LOCAL=QW0。写法: DS = chat_template_kwargs.thinking(DeepSeek),
*         QW = chat_template_kwargs.enable_thinking(Qwen / GLM), OL = Ollama 原生 think;
*         末位 1 = 开 0 = 关(显式传 false)。没配的模型不传任何思考参数, 与原来完全一致。
*         新增可选出参 ev_reasoning = 思考过程(reasoning_content / reasoning / Ollama thinking
*         字段 + 正文开头的 <think>…</think>), ev_content 只留正式回答 —— 调用方拿到的正文
*         永远不含思考内容, Agent 的 JSON 协议解析不受影响; 思考内容不落库、不进下一轮上下文。
*         只有思考没有回答时按失败返回(提示调大 MAX_TOKENS 或关闭思考)。老调用方不用改
*         ★ 重贴后核对标记: chat 声明有 ev_reasoning; 有 think_fragment( 与 split_think(;
*           有 ev_reasoning = parse_reasoning( lv_resp ); PUBLIC 有 wrap_think 声明(DPC 用)
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

    " V1.5: 一次调用的用量(网关没返回时 has_usage / cache_known 为空)
    TYPES: BEGIN OF ty_usage,
             prompt_tokens     TYPE i,          " 输入 token
             completion_tokens TYPE i,          " 输出 token
             cache_hit_tokens  TYPE i,          " 输入中命中前缀缓存的 token
             has_usage         TYPE abap_bool,  " X = 网关返回了输入 / 输出 token
             cache_known       TYPE abap_bool,  " X = 网关返回了缓存命中字段(0 也有效)
           END OF ty_usage.

    " 发送一轮对话请求
    " @parameter is_cfg      | 模型配置(ZAI_MODEL_CFG 单行)
    " @parameter it_messages | 消息数组(含 system 与多轮上下文)
    " @parameter ev_content  | 模型回复内容
    " @parameter ev_elapsed  | 耗时(毫秒)
    " @parameter ev_error    | 非空 = 失败原因
    CLASS-METHODS chat
      IMPORTING is_cfg       TYPE zai_model_cfg
                it_messages  TYPE tt_messages
                iv_no_retry  TYPE abap_bool OPTIONAL   " V1.3: X = 不重试
      EXPORTING ev_content   TYPE string
                ev_elapsed   TYPE i
                ev_error     TYPE string
                ev_attempts  TYPE i                    " V1.3: 实际请求次数(1 或 2)
                ev_finish    TYPE string               " V1.4: 结束原因(length = 被 MAX_TOKENS 截断)
                ev_usage     TYPE ty_usage             " V1.5: 用量(输入 / 输出 token、缓存命中)
                ev_reasoning TYPE string.              " V1.6: 思考过程(没开思考 / 模型没返回时为空)

    " V1.5: 从响应 JSON 取用量。单独解析, 没有字段或解析失败返回空, 不抛异常
    CLASS-METHODS parse_usage
      IMPORTING iv_json      TYPE string
      RETURNING VALUE(rs)    TYPE ty_usage.

    " V1.6: 从响应 JSON 取思考过程(OpenAI 兼容 choices[1].message.reasoning_content /
    "       reasoning, Ollama message.thinking)。单独解析, 失败返回空, 不影响正文
    CLASS-METHODS parse_reasoning
      IMPORTING iv_json      TYPE string
      RETURNING VALUE(rv)    TYPE string.

    " V1.6: 本模型的思考设置(读 ZAI_CHAT_CFG-MODEL_THINK): 空 = 不传思考参数(原来的行为);
    "       DS1 / DS0、QW1 / QW0、OL1 / OL0(见文件头)
    CLASS-METHODS think_mode
      IMPORTING iv_model_id  TYPE csequence
      RETURNING VALUE(rv)    TYPE string.

    " V1.6: 从配置值里取某个模型的思考设置(纯函数); 写法不认识时返回空
    CLASS-METHODS parse_think_cfg
      IMPORTING iv_cfg       TYPE csequence
                iv_model_id  TYPE csequence
      RETURNING VALUE(rv)    TYPE string.

    " V1.6: 思考设置 → 拼进请求体的 JSON 片段(不含前导逗号); 空 = 不拼。
    "       OLLAMA 一律用原生 "think"; OpenAI 兼容按写法用 chat_template_kwargs
    CLASS-METHODS think_fragment
      IMPORTING iv_mode       TYPE csequence
                iv_model_type TYPE csequence
      RETURNING VALUE(rv)     TYPE string.

    " V1.6: 把正文开头的 <think>…</think> 拆到 ev_think, cv_content 只留回答。
    "       iv_loose = X(思考开着)时, 没有开头标签只有 </think> 也拆(模板把 <think> 放进了提示词)
    CLASS-METHODS split_think
      IMPORTING iv_loose     TYPE abap_bool OPTIONAL
      EXPORTING ev_think     TYPE string
      CHANGING  cv_content   TYPE string.

    " V1.6: 回给前端时把思考过程放在回答前面(<think>…</think> 空一行接回答),
    "       前端拆开单独显示; 思考为空时原样返回回答。只在 DPC 出参时用, 不能拿去落库
    CLASS-METHODS wrap_think
      IMPORTING iv_reasoning TYPE string
                iv_answer    TYPE string
      RETURNING VALUE(rv)    TYPE string.

    " V1.3: 一次失败是否值得重试(网络层失败 / 429 / 5xx; 读超时与 4xx 不重试)
    " @parameter iv_code       | HTTP 状态码(网络层失败时为 0)
    " @parameter iv_comm_fail  | X = send / receive 失败
    " @parameter iv_elapsed_ms | 本次请求耗时(毫秒)
    " @parameter iv_timeout_s  | 本次请求超时(秒)
    CLASS-METHODS is_retryable
      IMPORTING iv_code       TYPE i
                iv_comm_fail  TYPE abap_bool
                iv_elapsed_ms TYPE i
                iv_timeout_s  TYPE i
      RETURNING VALUE(rv)     TYPE abap_bool.

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
             message     TYPE ty_message,
             error       TYPE string,
             done_reason TYPE string,  " V1.4: stop / length
           END OF ty_ol_resp.

    " ---- V1.5 用量解析结构(OpenAI 兼容 usage + Ollama 计数, 一次反序列化) ----
    TYPES: BEGIN OF ty_tok_detail,   " OpenAI: usage.prompt_tokens_details
             cached_tokens TYPE i,
           END OF ty_tok_detail.
    TYPES: BEGIN OF ty_oai_usage,
             prompt_tokens           TYPE i,
             completion_tokens       TYPE i,
             prompt_cache_hit_tokens TYPE i,              " DeepSeek 风格
             prompt_tokens_details   TYPE ty_tok_detail,  " OpenAI 风格
           END OF ty_oai_usage.
    TYPES: BEGIN OF ty_usage_resp,
             usage             TYPE ty_oai_usage,
             prompt_eval_count TYPE i,     " Ollama 输入 token
             eval_count        TYPE i,     " Ollama 输出 token
           END OF ty_usage_resp.

    " ---- V1.6 思考过程解析结构(单独反序列化, 不动正文解析) ----
    TYPES: BEGIN OF ty_rs_msg,
             reasoning_content TYPE string,   " vLLM / DeepSeek
             reasoning         TYPE string,   " 新版 vLLM / 部分网关
             thinking          TYPE string,   " Ollama
           END OF ty_rs_msg.
    TYPES: BEGIN OF ty_rs_choice,
             message TYPE ty_rs_msg,
           END OF ty_rs_choice.
    TYPES tt_rs_choice TYPE STANDARD TABLE OF ty_rs_choice WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_rs_resp,
             choices TYPE tt_rs_choice,      " OpenAI 兼容
             message TYPE ty_rs_msg,         " Ollama
           END OF ty_rs_resp.

    " V1.6: 去掉首尾空白(空格 / 制表 / 换行 / 回车); 不动中间的空格、缩进和空行
    CLASS-METHODS trim_ws
      IMPORTING iv_text     TYPE string
      RETURNING VALUE(rv)   TYPE string.

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

    CLEAR: ev_content, ev_elapsed, ev_error, ev_attempts, ev_finish.
    CLEAR: ev_usage, ev_reasoning.

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

    " V1.6: 思考参数(按模型配置; 没配 = 不传, 与原来一致)。拼在请求体最后一个 } 之前
    DATA(lv_think)    = think_mode( is_cfg-model_id ).
    DATA(lv_think_on) = xsdbool( lv_think CP '++1' ).
    DATA(lv_frag)     = think_fragment( iv_mode = lv_think iv_model_type = is_cfg-model_type ).
    IF lv_frag IS NOT INITIAL.
      DATA(lv_brace) = find( val = lv_body sub = `}` occ = -1 ).
      IF lv_brace > 0.
        lv_body = substring( val = lv_body len = lv_brace ) && `,` && lv_frag &&
                  substring( val = lv_body off = lv_brace ).
      ENDIF.
    ENDIF.

    DATA(lv_timeout) = is_cfg-timeout_sec.
    IF lv_timeout <= 0.
      lv_timeout = 300.
    ENDIF.

    " ---------------- 2~4. 发送(V1.3: 瞬时失败重试 1 次) ----------------
    DATA: lv_try     TYPE i,
          lv_fail    TYPE string,
          lv_comm    TYPE abap_bool,
          lv_t_try   TYPE i,
          lv_try_ms  TYPE i,
          lv_snippet TYPE string.

    GET RUN TIME FIELD lv_t1.
    DO 2 TIMES.
      lv_try = sy-index.
      CLEAR: lv_fail, lv_comm, lv_code, lv_reason, lv_resp.
      GET RUN TIME FIELD lv_t_try.

      " ---- 2. 创建 HTTP 客户端(失败 = 配置问题, 不重试) ----
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
          ev_attempts = lv_try.
          RETURN.
      ENDTRY.

      " ---- 3. 设置请求头与报文 ----
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

      " ---- 4. 发送与接收 ----
      lo_http->send( EXPORTING timeout = lv_timeout
                     EXCEPTIONS http_communication_failure = 1
                                http_invalid_state          = 2
                                http_processing_failed      = 3
                                OTHERS                      = 4 ).
      IF sy-subrc <> 0.
        lv_fail = |发送请求失败(subrc={ sy-subrc }), 检查网络/白名单/SM59 目的地|.
        lv_comm = abap_true.
      ELSE.
        lo_http->receive( EXCEPTIONS http_communication_failure = 1
                                     http_invalid_state          = 2
                                     http_processing_failed      = 3
                                     OTHERS                      = 4 ).
        IF sy-subrc <> 0.
          lv_fail = |接收响应失败(subrc={ sy-subrc }), 可能是模型服务超时({ lv_timeout }s)|.
          lv_comm = abap_true.
        ELSE.
          lo_http->response->get_status( IMPORTING code   = lv_code
                                                   reason = lv_reason ).
          lv_resp = lo_http->response->get_cdata( ).
        ENDIF.
      ENDIF.
      lo_http->close( ).

      GET RUN TIME FIELD lv_t2.
      lv_try_ms = ( lv_t2 - lv_t_try ) / 1000.

      IF lv_comm = abap_false AND lv_code = 200.
        EXIT.
      ENDIF.
      IF lv_comm = abap_false.
        " 尽力从响应中提取错误信息, 否则展示响应片段
        lv_snippet = lv_resp.
        IF strlen( lv_snippet ) > 300.
          lv_snippet = lv_snippet(300).
        ENDIF.
        lv_fail = |HTTP { lv_code } { lv_reason }: { lv_snippet }|.
      ENDIF.

      IF iv_no_retry = abap_true OR lv_try >= 2
         OR is_retryable( iv_code       = lv_code
                          iv_comm_fail  = lv_comm
                          iv_elapsed_ms = lv_try_ms
                          iv_timeout_s  = CONV i( lv_timeout ) ) = abap_false.
        EXIT.
      ENDIF.

      " 间隔 1 秒再试: ENQUE_SLEEP 不像 WAIT UP TO 那样触发隐式数据库提交;
      " 该 FM 不可用时直接重试(形参按 SE37 核对: SECONDS)
      TRY.
          CALL FUNCTION 'ENQUE_SLEEP'
            EXPORTING
              seconds = 1
            EXCEPTIONS
              OTHERS  = 1.
        CATCH cx_sy_dyn_call_error.
      ENDTRY.
    ENDDO.

    ev_attempts = lv_try.
    GET RUN TIME FIELD lv_t2.
    ev_elapsed = ( lv_t2 - lv_t1 ) / 1000.

    " ---------------- 5. 解析响应 ----------------
    IF lv_fail IS NOT INITIAL.
      ev_error = COND #( WHEN lv_try > 1 THEN |{ lv_fail }(已自动重试 1 次)| ELSE lv_fail ).
      RETURN.
    ENDIF.

    " V1.5: 用量单独解析(失败返回空), 正文解析照旧
    ev_usage = parse_usage( lv_resp ).

    TRY.
        IF is_cfg-model_type = 'OLLAMA'.
          DATA ls_olr TYPE ty_ol_resp.
          /ui2/cl_json=>deserialize(
            EXPORTING json = lv_resp
                      name_mappings = VALUE #( ( abap = 'MESSAGE' json = 'message' )
                                               ( abap = 'ROLE'    json = 'role' )
                                               ( abap = 'CONTENT' json = 'content' )
                                               ( abap = 'ERROR'   json = 'error' )
                                               ( abap = 'DONE_REASON' json = 'done_reason' ) )
            CHANGING  data = ls_olr ).
          ev_content = ls_olr-message-content.
          ev_finish  = to_lower( ls_olr-done_reason ).
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
            ev_finish  = to_lower( ls_choice-finish_reason ).
          ENDIF.
          IF ls_oair-error-message IS NOT INITIAL.
            ev_error = ls_oair-error-message.
          ENDIF.
        ENDIF.
      CATCH cx_root INTO lx.
        ev_error = |响应 JSON 解析失败: { lx->get_text( ) }|.
        RETURN.
    ENDTRY.

    " V1.6: 思考过程与正式回答分开 —— 专用字段单独解析(失败为空), 再拆正文开头的
    " <think>…</think>; 之后 ev_content 只剩回答(没开思考时也拆, 去掉空的思考块)
    ev_reasoning = parse_reasoning( lv_resp ).
    DATA lv_tag_think TYPE string.
    split_think( EXPORTING iv_loose   = lv_think_on
                 IMPORTING ev_think   = lv_tag_think
                 CHANGING  cv_content = ev_content ).
    IF lv_tag_think IS NOT INITIAL.
      ev_reasoning = COND #( WHEN ev_reasoning IS INITIAL THEN lv_tag_think
                             ELSE ev_reasoning && cl_abap_char_utilities=>newline &&
                                  cl_abap_char_utilities=>newline && lv_tag_think ).
    ENDIF.
    ev_reasoning = trim_ws( ev_reasoning ).

    IF ev_error IS INITIAL AND ev_content IS INITIAL.
      IF ev_reasoning IS NOT INITIAL.
        " 思考把 MAX_TOKENS 用完了 / 模型只想不答: 按失败返回, 调用方照常走失败处理
        ev_error = COND #( WHEN ev_finish = 'length'
                           THEN '模型只写了思考过程, 还没给出回答就达到 MAX_TOKENS 上限; 请调大该模型的 MAX_TOKENS, 或在模型管理里关闭思考'
                           ELSE '模型只返回了思考过程, 没有给出回答; 可重试, 或在模型管理里关闭思考' ).
      ELSE.
        ev_error = '模型返回了空内容, 请检查 API_MODEL 名称是否正确'.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD parse_reasoning.

    " V1.6: 只读思考字段, 任何异常都返回空 —— 不能因为思考字段格式不同把正常回答判成失败
    CLEAR rv.
    IF iv_json IS INITIAL
       OR ( iv_json NS '"reasoning' AND iv_json NS '"thinking"' ).
      RETURN.
    ENDIF.

    DATA ls_r TYPE ty_rs_resp.
    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_json
                    name_mappings = VALUE #( ( abap = 'CHOICES'           json = 'choices' )
                                             ( abap = 'MESSAGE'           json = 'message' )
                                             ( abap = 'REASONING_CONTENT' json = 'reasoning_content' )
                                             ( abap = 'REASONING'         json = 'reasoning' )
                                             ( abap = 'THINKING'          json = 'thinking' ) )
          CHANGING  data = ls_r ).
      CATCH cx_root.
        CLEAR rv.
        RETURN.
    ENDTRY.

    READ TABLE ls_r-choices INTO DATA(ls_c) INDEX 1.
    IF sy-subrc = 0.
      rv = COND #( WHEN ls_c-message-reasoning_content IS NOT INITIAL
                   THEN ls_c-message-reasoning_content
                   ELSE ls_c-message-reasoning ).
    ENDIF.
    IF rv IS INITIAL.
      rv = ls_r-message-thinking.
    ENDIF.

  ENDMETHOD.


  METHOD think_mode.

    " V1.6: 每次调用读一次配置(单行主键读, 很快); 读不到 = 不传思考参数
    CLEAR rv.
    TRY.
        SELECT SINGLE cfgvalue FROM zai_chat_cfg
          WHERE cfgkey = 'MODEL_THINK'
          INTO @DATA(lv_cfg).
        IF sy-subrc = 0.
          rv = parse_think_cfg( iv_cfg = lv_cfg iv_model_id = iv_model_id ).
        ENDIF.
      CATCH cx_root.
        CLEAR rv.
    ENDTRY.

  ENDMETHOD.


  METHOD parse_think_cfg.

    " 值: 模型ID=写法开关, 逗号分隔(大小写不敏感); 写法只认 DS / QW / OL + 1 / 0
    CLEAR rv.
    DATA(lv_id)  = to_upper( condense( CONV string( iv_model_id ) ) ).
    DATA(lv_cfg) = to_upper( CONV string( iv_cfg ) ).
    IF lv_id IS INITIAL OR lv_cfg IS INITIAL.
      RETURN.
    ENDIF.

    DATA: lt_items TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_k     TYPE string,
          lv_v     TYPE string.
    SPLIT lv_cfg AT ',' INTO TABLE lt_items.
    LOOP AT lt_items INTO DATA(lv_item).
      CLEAR: lv_k, lv_v.
      SPLIT lv_item AT '=' INTO lv_k lv_v.
      lv_k = condense( lv_k ).
      lv_v = condense( lv_v ).
      IF lv_k <> lv_id.
        CONTINUE.
      ENDIF.
      IF strlen( lv_v ) = 3 AND ( lv_v CP 'DS+' OR lv_v CP 'QW+' OR lv_v CP 'OL+' )
         AND ( lv_v CP '++1' OR lv_v CP '++0' ).
        rv = lv_v.
      ENDIF.
      RETURN.
    ENDLOOP.

  ENDMETHOD.


  METHOD think_fragment.

    CLEAR rv.
    DATA(lv_mode) = to_upper( CONV string( iv_mode ) ).
    IF strlen( lv_mode ) <> 3.
      RETURN.
    ENDIF.
    DATA(lv_on) = COND string( WHEN lv_mode CP '++1' THEN `true` ELSE `false` ).

    IF to_upper( CONV string( iv_model_type ) ) = 'OLLAMA'.
      rv = `"think":` && lv_on.                                     " Ollama 原生开关
    ELSEIF lv_mode CP 'DS+'.
      rv = `"chat_template_kwargs":{"thinking":` && lv_on && `}`.          " DeepSeek
    ELSEIF lv_mode CP 'QW+'.
      rv = `"chat_template_kwargs":{"enable_thinking":` && lv_on && `}`.   " Qwen / GLM
    ENDIF.

  ENDMETHOD.


  METHOD split_think.

    CLEAR ev_think.
    IF cv_content IS INITIAL.
      RETURN.
    ENDIF.

    DATA(lv_close) = find( val = cv_content sub = `</think>` case = abap_false ).
    IF lv_close < 0.
      RETURN.
    ENDIF.
    DATA(lv_open) = find( val = cv_content sub = `<think>` case = abap_false ).

    IF lv_open >= 0 AND lv_open < lv_close.
      " 只认开头的思考块: <think> 前面只能是空白(回答中间提到标签的不动)
      IF lv_open > 0 AND find( val = substring( val = cv_content len = lv_open ) regex = `\S` ) >= 0.
        RETURN.
      ENDIF.
      ev_think = substring( val = cv_content off = lv_open + 7 len = lv_close - lv_open - 7 ).
    ELSEIF lv_open < 0 AND iv_loose = abap_true.
      " 思考开着、模板已把 <think> 放进提示词: 正文从思考开始, 到 </think> 结束
      ev_think = substring( val = cv_content len = lv_close ).
    ELSE.
      RETURN.
    ENDIF.

    cv_content = trim_ws( substring( val = cv_content off = lv_close + 8 ) ).
    ev_think   = trim_ws( ev_think ).

  ENDMETHOD.


  METHOD wrap_think.

    IF iv_reasoning IS INITIAL.
      rv = iv_answer.
      RETURN.
    ENDIF.
    " 思考里万一出现 </think> 字样, 改掉免得前端提前截断
    DATA(lv_r) = replace( val = iv_reasoning sub = `</think>` with = `</ think>` occ = 0 case = abap_false ).
    rv = `<think>` && cl_abap_char_utilities=>newline && lv_r && cl_abap_char_utilities=>newline &&
         `</think>` && cl_abap_char_utilities=>newline && cl_abap_char_utilities=>newline && iv_answer.

  ENDMETHOD.


  METHOD trim_ws.

    " 逐个去掉首尾的空格 / 制表 / 换行 / 回车。不用正则: ABAP 正则的 ^ 和 $ 按行匹配,
    " 会把回答中间每一行的缩进和空行都吃掉(代码块会乱)
    DATA lv_len TYPE i.
    rv = iv_text.
    DO.
      lv_len = strlen( rv ).
      rv = shift_left(  val = rv sub = ` ` ).
      rv = shift_left(  val = rv sub = |\t| ).
      rv = shift_left(  val = rv sub = |\n| ).
      rv = shift_left(  val = rv sub = |\r| ).
      rv = shift_right( val = rv sub = ` ` ).
      rv = shift_right( val = rv sub = |\t| ).
      rv = shift_right( val = rv sub = |\n| ).
      rv = shift_right( val = rv sub = |\r| ).
      IF strlen( rv ) = lv_len.
        EXIT.
      ENDIF.
    ENDDO.

  ENDMETHOD.


  METHOD parse_usage.

    " V1.5: 一次反序列化同时取 OpenAI 兼容 usage 与 Ollama 计数; 字段缺失保持 0。
    " 只读用量, 任何异常都返回空 —— 不能因为用量格式不同把正常回答判成失败
    CLEAR rs.
    IF iv_json IS INITIAL.
      RETURN.
    ENDIF.

    DATA ls_u TYPE ty_usage_resp.
    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json = iv_json
                    name_mappings = VALUE #( ( abap = 'USAGE'                   json = 'usage' )
                                             ( abap = 'PROMPT_TOKENS'           json = 'prompt_tokens' )
                                             ( abap = 'COMPLETION_TOKENS'       json = 'completion_tokens' )
                                             ( abap = 'PROMPT_CACHE_HIT_TOKENS' json = 'prompt_cache_hit_tokens' )
                                             ( abap = 'PROMPT_TOKENS_DETAILS'   json = 'prompt_tokens_details' )
                                             ( abap = 'CACHED_TOKENS'           json = 'cached_tokens' )
                                             ( abap = 'PROMPT_EVAL_COUNT'       json = 'prompt_eval_count' )
                                             ( abap = 'EVAL_COUNT'              json = 'eval_count' ) )
          CHANGING  data = ls_u ).
      CATCH cx_root.
        CLEAR rs.
        RETURN.
    ENDTRY.

    rs-prompt_tokens     = COND #( WHEN ls_u-usage-prompt_tokens > 0
                                   THEN ls_u-usage-prompt_tokens ELSE ls_u-prompt_eval_count ).
    rs-completion_tokens = COND #( WHEN ls_u-usage-completion_tokens > 0
                                   THEN ls_u-usage-completion_tokens ELSE ls_u-eval_count ).
    rs-has_usage = xsdbool( rs-prompt_tokens > 0 OR rs-completion_tokens > 0 ).

    " 缓存命中: 网关返回了字段才算已知(0 = 没命中, 也是有效值)
    IF iv_json CS '"prompt_cache_hit_tokens"' OR iv_json CS '"cached_tokens"'.
      rs-cache_known      = abap_true.
      rs-cache_hit_tokens = nmax( val1 = ls_u-usage-prompt_cache_hit_tokens
                                  val2 = ls_u-usage-prompt_tokens_details-cached_tokens ).
    ENDIF.

  ENDMETHOD.


  METHOD is_retryable.

    " V1.3(BE-07): 网络层失败 / 429 / 5xx 视为瞬时; 其余 4xx 与配置错误重试也没用。
    " 网络层失败若已耗时超过超时一半, 基本是读超时 —— 再等一轮会超出调用方预算
    rv = abap_false.
    IF iv_comm_fail = abap_true.
      rv = xsdbool( iv_elapsed_ms < iv_timeout_s * 500 ).
    ELSEIF iv_code = 429 OR ( iv_code >= 500 AND iv_code <= 599 ).
      rv = abap_true.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
