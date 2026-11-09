*=======================================================================
* 对象:   ZCL_AI_MCP_CLIENT
* 用途:   MCP 服务客户端(Streamable HTTP): SAP 经 SM59 目标调外部 MCP 服务
*         设计: 功能计划书/Deep Agents浏览器接入/04-MCP连接入口方案 §2 / §6
*         - 一个地址(SM59 目标 + 路径), POST JSON-RPC 2.0;
*           回应是 application/json(直接是结果)或 text/event-stream(SSE, 取 id 对上的那条)
*         - initialize → notifications/initialized → tools/list / tools/call
*         - 服务回了 Mcp-Session-Id 就在后续请求里带上; 协议版本头 MCP-Protocol-Version
*         - 「用户本人」模式: 请求头 X-Lingxi-User = 当前 SAP 用户(MCP 服务按这个人办事)
*         - 连接信息、证书、令牌 / 账号密码都在 SM59(本类不碰密钥)
*         JSON 用本类的小解析器按原文取值(json_member / json_items), 不做整体反序列化:
*         工具的参数结构要原样转给模型, 不能被 ABAP 结构改写键名
* 安装:   SE24 → 创建类 → 源代码粘贴(S/4HANA 760)
* 版本:   V1.0 20261109 首版(《03》〇-AU, MCP 连接 M1)
*         ★ 重贴后核对标记: 有 METHOD initialize / list_tools / call_tool / json_member / json_items / sse_pick;
*           post 里有 cl_http_client=>create_by_destination 与 'mcp-session-id'
*=======================================================================
CLASS zcl_ai_mcp_client DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS gc_proto TYPE string VALUE `2025-03-26`.   " 本客户端说的协议版本(Streamable HTTP 起始版)

    METHODS constructor
      IMPORTING iv_dest    TYPE csequence            " SM59 目标(类型 G)
                iv_path    TYPE csequence            " 路径, 如 /mcp
                iv_timeout TYPE i DEFAULT 60         " 秒
                iv_user    TYPE csequence OPTIONAL.  " 「用户本人」模式: 放进 X-Lingxi-User

    " 握手: 服务名 / 版本 / 协议版本; 成功后发 notifications/initialized
    METHODS initialize
      EXPORTING ev_name    TYPE string
                ev_version TYPE string
                ev_proto   TYPE string
                ev_error   TYPE string.

    " tools/list(自动翻页, 最多 20 页): 每个工具一条原始 JSON 对象
    METHODS list_tools
      EXPORTING et_tools TYPE string_table
                ev_error TYPE string.

    " tools/call: ev_result = result 对象原文(含 content / structuredContent / isError)
    METHODS call_tool
      IMPORTING iv_name   TYPE string
                iv_args   TYPE string       " 参数对象 JSON, 空 = {}
      EXPORTING ev_result TYPE string
                ev_error  TYPE string.

    " ---- JSON 小工具(PUBLIC: 服务类与测试报表直接用) ----
    " 对象 iv_json 顶层键 iv_key 的原始值(字符串带引号); 没有返回空
    CLASS-METHODS json_member
      IMPORTING iv_json   TYPE string
                iv_key    TYPE string
      RETURNING VALUE(rv) TYPE string.

    " 数组 iv_json 的每个元素原文
    CLASS-METHODS json_items
      IMPORTING iv_json   TYPE string
      RETURNING VALUE(rt) TYPE string_table.

    " JSON 字符串原文(带引号)→ 文本; 不是字符串时原样返回
    CLASS-METHODS json_string
      IMPORTING iv_raw    TYPE string
      RETURNING VALUE(rv) TYPE string.

    " 文本 → JSON 字符串(带引号, 已转义)
    CLASS-METHODS jstr
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.

    " SSE 回应里 id = iv_id 的那条 JSON-RPC 消息
    CLASS-METHODS sse_pick
      IMPORTING iv_body   TYPE string
                iv_id     TYPE i
      RETURNING VALUE(rv) TYPE string.

  PROTECTED SECTION.
  PRIVATE SECTION.

    DATA: mv_dest    TYPE string,
          mv_path    TYPE string,
          mv_timeout TYPE i,
          mv_user    TYPE string,
          mv_session TYPE string,
          mv_proto   TYPE string,
          mv_id      TYPE i.

    METHODS post
      IMPORTING iv_body  TYPE string
      EXPORTING ev_code  TYPE i
                ev_resp  TYPE string
                ev_ctype TYPE string
                ev_error TYPE string.

    METHODS rpc
      IMPORTING iv_method TYPE string
                iv_params TYPE string OPTIONAL
      EXPORTING ev_result TYPE string
                ev_error  TYPE string.

    METHODS notify
      IMPORTING iv_method TYPE string.

    CLASS-METHODS skip_ws
      IMPORTING iv_json   TYPE string
                iv_pos    TYPE i
      RETURNING VALUE(rv) TYPE i.

    CLASS-METHODS skip_value
      IMPORTING iv_json   TYPE string
                iv_pos    TYPE i
      RETURNING VALUE(rv) TYPE i.

    CLASS-METHODS char_at
      IMPORTING iv_json   TYPE string
                iv_pos    TYPE i
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS zcl_ai_mcp_client IMPLEMENTATION.


  METHOD constructor.

    mv_dest    = condense( iv_dest ).
    mv_path    = condense( iv_path ).
    IF mv_path IS INITIAL.
      mv_path = `/mcp`.
    ENDIF.
    mv_timeout = COND #( WHEN iv_timeout <= 0 THEN 60 ELSE iv_timeout ).
    mv_user    = condense( iv_user ).

  ENDMETHOD.


  METHOD initialize.

    CLEAR: ev_name, ev_version, ev_proto, ev_error.
    DATA lv_res TYPE string.
    rpc( EXPORTING iv_method = `initialize`
                   iv_params = |\{"protocolVersion":"{ gc_proto }","capabilities":\{\},| &&
                               |"clientInfo":\{"name":"lingxi-sap","version":"1.0"\}\}|
         IMPORTING ev_result = lv_res
                   ev_error  = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    ev_proto = json_string( json_member( iv_json = lv_res iv_key = `protocolVersion` ) ).
    mv_proto = COND #( WHEN ev_proto IS NOT INITIAL THEN ev_proto ELSE gc_proto ).
    DATA(lv_info) = json_member( iv_json = lv_res iv_key = `serverInfo` ).
    ev_name    = json_string( json_member( iv_json = lv_info iv_key = `name` ) ).
    ev_version = json_string( json_member( iv_json = lv_info iv_key = `version` ) ).
    notify( `notifications/initialized` ).

  ENDMETHOD.


  METHOD list_tools.

    CLEAR: et_tools, ev_error.
    DATA: lv_cursor TYPE string,
          lv_res    TYPE string.
    DO 20 TIMES.
      rpc( EXPORTING iv_method = `tools/list`
                     iv_params = COND #( WHEN lv_cursor IS NOT INITIAL THEN |\{"cursor":{ lv_cursor }\}| )
           IMPORTING ev_result = lv_res
                     ev_error  = ev_error ).
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
      APPEND LINES OF json_items( json_member( iv_json = lv_res iv_key = `tools` ) ) TO et_tools.
      lv_cursor = json_member( iv_json = lv_res iv_key = `nextCursor` ).
      IF lv_cursor IS INITIAL OR lv_cursor = `null` OR lv_cursor = `""`.
        EXIT.
      ENDIF.
    ENDDO.

  ENDMETHOD.


  METHOD call_tool.

    CLEAR: ev_result, ev_error.
    DATA(lv_args) = condense( iv_args ).
    IF lv_args IS INITIAL.
      lv_args = `{}`.
    ENDIF.
    rpc( EXPORTING iv_method = `tools/call`
                   iv_params = |\{"name":{ jstr( iv_name ) },"arguments":{ lv_args }\}|
         IMPORTING ev_result = ev_result
                   ev_error  = ev_error ).

  ENDMETHOD.


  METHOD rpc.

    CLEAR: ev_result, ev_error.
    mv_id = mv_id + 1.
    DATA(lv_body) = |\{"jsonrpc":"2.0","id":{ mv_id },"method":{ jstr( iv_method ) }| &&
                    COND string( WHEN iv_params IS NOT INITIAL THEN |,"params":{ iv_params }| ) && `}`.
    DATA: lv_code  TYPE i,
          lv_resp  TYPE string,
          lv_ctype TYPE string.
    post( EXPORTING iv_body  = lv_body
          IMPORTING ev_code  = lv_code
                    ev_resp  = lv_resp
                    ev_ctype = lv_ctype
                    ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF lv_code < 200 OR lv_code >= 300.
      DATA(lv_snip) = lv_resp.
      IF strlen( lv_snip ) > 300.
        lv_snip = lv_snip(300).
      ENDIF.
      ev_error = |MCP 服务返回 HTTP { lv_code }: { lv_snip }|.
      RETURN.
    ENDIF.

    DATA(lv_msg) = COND string( WHEN lv_ctype CS 'text/event-stream'
                                THEN sse_pick( iv_body = lv_resp iv_id = mv_id )
                                ELSE lv_resp ).
    IF lv_msg IS INITIAL.
      ev_error = 'MCP 服务没有返回本次请求的结果(回应里找不到对应的 id)'.
      RETURN.
    ENDIF.
    DATA(lv_err) = json_member( iv_json = lv_msg iv_key = `error` ).
    IF lv_err IS NOT INITIAL AND lv_err <> `null`.
      DATA(lv_emsg) = json_string( json_member( iv_json = lv_err iv_key = `message` ) ).
      ev_error = |MCP 错误: { COND string( WHEN lv_emsg IS NOT INITIAL THEN lv_emsg ELSE lv_err ) }|.
      RETURN.
    ENDIF.
    ev_result = json_member( iv_json = lv_msg iv_key = `result` ).
    IF ev_result IS INITIAL.
      ev_error = 'MCP 回应里没有 result'.
    ENDIF.

  ENDMETHOD.


  METHOD notify.

    " 通知没有 id, 服务回 202 不带内容; 失败不影响后续
    DATA: lv_code  TYPE i,
          lv_resp  TYPE string,
          lv_ctype TYPE string,
          lv_err   TYPE string.
    post( EXPORTING iv_body  = |\{"jsonrpc":"2.0","method":{ jstr( iv_method ) }\}|
          IMPORTING ev_code  = lv_code
                    ev_resp  = lv_resp
                    ev_ctype = lv_ctype
                    ev_error = lv_err ).

  ENDMETHOD.


  METHOD post.

    CLEAR: ev_code, ev_resp, ev_ctype, ev_error.
    DATA lo_http TYPE REF TO if_http_client.

    IF mv_dest IS INITIAL.
      ev_error = '没有配置 SM59 目标'.
      RETURN.
    ENDIF.
    cl_http_client=>create_by_destination(
      EXPORTING  destination              = CONV rfcdest( mv_dest )
      IMPORTING  client                   = lo_http
      EXCEPTIONS argument_not_found       = 1
                 destination_not_found    = 2
                 destination_no_authority = 3
                 plugin_not_active        = 4
                 internal_error           = 5
                 OTHERS                   = 6 ).
    IF sy-subrc <> 0 OR lo_http IS NOT BOUND.
      ev_error = |SM59 目标 { mv_dest } 不可用(subrc={ sy-subrc }), 请 Basis 检查目标名与权限|.
      RETURN.
    ENDIF.

    cl_http_utility=>set_request_uri( request = lo_http->request uri = mv_path ).
    lo_http->request->set_method( if_http_request=>co_request_method_post ).
    lo_http->request->set_header_field( name = 'Content-Type' value = 'application/json; charset=utf-8' ).
    lo_http->request->set_header_field( name = 'Accept' value = 'application/json, text/event-stream' ).
    IF mv_proto IS NOT INITIAL.
      lo_http->request->set_header_field( name = 'MCP-Protocol-Version' value = mv_proto ).
    ENDIF.
    IF mv_session IS NOT INITIAL.
      lo_http->request->set_header_field( name = 'Mcp-Session-Id' value = mv_session ).
    ENDIF.
    IF mv_user IS NOT INITIAL.
      lo_http->request->set_header_field( name = 'X-Lingxi-User' value = mv_user ).
    ENDIF.
    lo_http->request->set_cdata( iv_body ).

    lo_http->send( EXPORTING  timeout                    = mv_timeout
                   EXCEPTIONS http_communication_failure = 1
                              http_invalid_state         = 2
                              http_processing_failed     = 3
                              OTHERS                     = 4 ).
    IF sy-subrc <> 0.
      ev_error = |发送到 MCP 服务失败(subrc={ sy-subrc }), 检查网络 / 防火墙 / SM59 目标|.
      lo_http->close( ).
      RETURN.
    ENDIF.
    lo_http->receive( EXCEPTIONS http_communication_failure = 1
                                 http_invalid_state         = 2
                                 http_processing_failed     = 3
                                 OTHERS                     = 4 ).
    IF sy-subrc <> 0.
      ev_error = |接收 MCP 服务回应失败(subrc={ sy-subrc }), 可能超时({ mv_timeout } 秒)|.
      lo_http->close( ).
      RETURN.
    ENDIF.

    lo_http->response->get_status( IMPORTING code = ev_code ).
    ev_resp  = lo_http->response->get_cdata( ).
    ev_ctype = to_lower( lo_http->response->get_header_field( 'content-type' ) ).
    DATA(lv_sid) = lo_http->response->get_header_field( 'mcp-session-id' ).
    IF lv_sid IS NOT INITIAL.
      mv_session = lv_sid.
    ENDIF.
    lo_http->close( ).

  ENDMETHOD.


  METHOD sse_pick.

    " 事件之间空行分隔; 每个事件的 data: 行拼起来是一条 JSON-RPC 消息
    CLEAR rv.
    DATA: lt_lines TYPE string_table,
          lv_data  TYPE string.
    DATA(lv_body) = replace( val = iv_body sub = cl_abap_char_utilities=>cr_lf
                             with = cl_abap_char_utilities=>newline occ = 0 ).
    SPLIT lv_body AT cl_abap_char_utilities=>newline INTO TABLE lt_lines.
    APPEND `` TO lt_lines.
    DATA(lv_want) = |{ iv_id }|.
    LOOP AT lt_lines INTO DATA(lv_line).
      IF lv_line IS INITIAL.
        IF lv_data IS NOT INITIAL.
          IF json_member( iv_json = lv_data iv_key = `id` ) = lv_want.
            rv = lv_data.
            RETURN.
          ENDIF.
          CLEAR lv_data.
        ENDIF.
        CONTINUE.
      ENDIF.
      IF strlen( lv_line ) >= 5 AND substring( val = lv_line len = 5 ) = `data:`.
        DATA(lv_d) = substring( val = lv_line off = 5 ).
        IF strlen( lv_d ) > 0 AND substring( val = lv_d len = 1 ) = ` `.
          lv_d = substring( val = lv_d off = 1 ).
        ENDIF.
        lv_data = COND #( WHEN lv_data IS INITIAL THEN lv_d
                          ELSE lv_data && cl_abap_char_utilities=>newline && lv_d ).
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD json_member.

    CLEAR rv.
    DATA(lv_len) = strlen( iv_json ).
    DATA(lv_pos) = skip_ws( iv_json = iv_json iv_pos = 0 ).
    IF char_at( iv_json = iv_json iv_pos = lv_pos ) <> `{`.
      RETURN.
    ENDIF.
    lv_pos = lv_pos + 1.
    DATA(lv_want) = |"{ iv_key }"|.
    DO.
      lv_pos = skip_ws( iv_json = iv_json iv_pos = lv_pos ).
      IF char_at( iv_json = iv_json iv_pos = lv_pos ) <> `"`.
        RETURN.   " } 或格式不对
      ENDIF.
      DATA(lv_kend) = skip_value( iv_json = iv_json iv_pos = lv_pos ).
      IF lv_kend <= lv_pos OR lv_kend > lv_len.
        RETURN.
      ENDIF.
      DATA(lv_key) = substring( val = iv_json off = lv_pos len = lv_kend - lv_pos ).
      lv_pos = skip_ws( iv_json = iv_json iv_pos = lv_kend ).
      IF char_at( iv_json = iv_json iv_pos = lv_pos ) <> `:`.
        RETURN.
      ENDIF.
      lv_pos = skip_ws( iv_json = iv_json iv_pos = lv_pos + 1 ).
      DATA(lv_vend) = skip_value( iv_json = iv_json iv_pos = lv_pos ).
      IF lv_vend <= lv_pos OR lv_vend > lv_len.
        RETURN.
      ENDIF.
      IF lv_key = lv_want.
        rv = substring( val = iv_json off = lv_pos len = lv_vend - lv_pos ).
        RETURN.
      ENDIF.
      lv_pos = skip_ws( iv_json = iv_json iv_pos = lv_vend ).
      IF char_at( iv_json = iv_json iv_pos = lv_pos ) <> `,`.
        RETURN.
      ENDIF.
      lv_pos = lv_pos + 1.
    ENDDO.

  ENDMETHOD.


  METHOD json_items.

    CLEAR rt.
    DATA(lv_len) = strlen( iv_json ).
    DATA(lv_pos) = skip_ws( iv_json = iv_json iv_pos = 0 ).
    IF char_at( iv_json = iv_json iv_pos = lv_pos ) <> `[`.
      RETURN.
    ENDIF.
    lv_pos = lv_pos + 1.
    DO.
      lv_pos = skip_ws( iv_json = iv_json iv_pos = lv_pos ).
      DATA(lv_c) = char_at( iv_json = iv_json iv_pos = lv_pos ).
      IF lv_c IS INITIAL OR lv_c = `]`.
        RETURN.
      ENDIF.
      DATA(lv_end) = skip_value( iv_json = iv_json iv_pos = lv_pos ).
      IF lv_end <= lv_pos OR lv_end > lv_len.
        RETURN.
      ENDIF.
      APPEND substring( val = iv_json off = lv_pos len = lv_end - lv_pos ) TO rt.
      lv_pos = skip_ws( iv_json = iv_json iv_pos = lv_end ).
      IF char_at( iv_json = iv_json iv_pos = lv_pos ) <> `,`.
        RETURN.
      ENDIF.
      lv_pos = lv_pos + 1.
    ENDDO.

  ENDMETHOD.


  METHOD json_string.

    TYPES: BEGIN OF lty_v,
             v TYPE string,
           END OF lty_v.
    DATA ls_v TYPE lty_v.
    IF iv_raw IS INITIAL OR substring( val = iv_raw len = 1 ) <> `"`.
      rv = COND #( WHEN iv_raw = `null` THEN `` ELSE iv_raw ).
      RETURN.
    ENDIF.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json = |\{"v":{ iv_raw }\}|
                                   CHANGING  data = ls_v ).
        rv = ls_v-v.
      CATCH cx_root.
        rv = substring( val = iv_raw off = 1 len = nmax( val1 = strlen( iv_raw ) - 2 val2 = 0 ) ).
    ENDTRY.

  ENDMETHOD.


  METHOD jstr.

    rv = /ui2/cl_json=>serialize( data = iv ).
    IF rv IS INITIAL.
      rv = `""`.
    ENDIF.

  ENDMETHOD.


  METHOD char_at.

    CLEAR rv.
    IF iv_pos >= 0 AND iv_pos < strlen( iv_json ).
      rv = substring( val = iv_json off = iv_pos len = 1 ).
    ENDIF.

  ENDMETHOD.


  METHOD skip_ws.

    rv = iv_pos.
    DATA(lv_len) = strlen( iv_json ).
    DATA(lv_cr)  = substring( val = cl_abap_char_utilities=>cr_lf len = 1 ).
    WHILE rv < lv_len.
      DATA(lv_c) = substring( val = iv_json off = rv len = 1 ).
      IF lv_c = ` ` OR lv_c = cl_abap_char_utilities=>newline OR lv_c = lv_cr
         OR lv_c = cl_abap_char_utilities=>horizontal_tab.
        rv = rv + 1.
      ELSE.
        EXIT.
      ENDIF.
    ENDWHILE.

  ENDMETHOD.


  METHOD skip_value.

    " 返回值结束位置(不含); 字符串 / 对象 / 数组 / 数字 / true / false / null
    rv = iv_pos.
    DATA(lv_len) = strlen( iv_json ).
    IF rv >= lv_len.
      RETURN.
    ENDIF.
    DATA(lv_c) = substring( val = iv_json off = rv len = 1 ).

    IF lv_c = `"`.
      rv = rv + 1.
      WHILE rv < lv_len.
        lv_c = substring( val = iv_json off = rv len = 1 ).
        IF lv_c = `\`.
          rv = rv + 2.
          CONTINUE.
        ENDIF.
        rv = rv + 1.
        IF lv_c = `"`.
          RETURN.
        ENDIF.
      ENDWHILE.
      rv = lv_len + 1.   " 没闭合: 让调用方判为格式错
      RETURN.
    ENDIF.

    IF lv_c = `{` OR lv_c = `[`.
      DATA lv_depth TYPE i.
      WHILE rv < lv_len.
        lv_c = substring( val = iv_json off = rv len = 1 ).
        CASE lv_c.
          WHEN `"`.
            rv = skip_value( iv_json = iv_json iv_pos = rv ).
            CONTINUE.
          WHEN `{` OR `[`.
            lv_depth = lv_depth + 1.
          WHEN `}` OR `]`.
            lv_depth = lv_depth - 1.
            IF lv_depth = 0.
              rv = rv + 1.
              RETURN.
            ENDIF.
        ENDCASE.
        rv = rv + 1.
      ENDWHILE.
      rv = lv_len + 1.
      RETURN.
    ENDIF.

    WHILE rv < lv_len.
      lv_c = substring( val = iv_json off = rv len = 1 ).
      IF lv_c = `,` OR lv_c = `}` OR lv_c = `]` OR lv_c = ` `
         OR lv_c = cl_abap_char_utilities=>newline OR lv_c = cl_abap_char_utilities=>horizontal_tab.
        EXIT.
      ENDIF.
      rv = rv + 1.
    ENDWHILE.

  ENDMETHOD.

ENDCLASS.
