*=======================================================================
* 对象:   ZCL_AI_ODATA_CLIENT
* 用途:   Fiori 报表取数 —— 在服务器内部以当前用户身份 GET 一个 OData URI
*         (设计: 功能计划书/Fiori报表分析/01-方案与开发计划 §4.1)
*         Fiori 页面在浏览器里怎么调 OData, 这里就在服务器内部原样调一次:
*         报表逻辑、口径、权限全部复用(S_SERVICE 与 DPC 里的权限检查照常生效)
* 规则:   - 只发 GET; 不发 CSRF; 不支持 $batch
*         - URI 必须以 /sap/opu/odata/ 开头(不带主机名), 其余字符由调用方
*           拼好并 URL 编码; 本类只再做一次字符集与长度校验
*         - 通道: 配置 FIORI_HTTP_DEST 为空 = cl_http_client=>create_internal
*           (本系统 ICF, 不经网络、不需要 SM59); 填了 = 用该 SM59 目标
*           (G0 验证 T2 不通过时的退路: 类型 H 指向本系统 + 登录票据)
*         - 超时如实返回, 不重试; 响应超过 iv_max_bytes 拒绝
*         - HTTP 非 200: 取 OData 错误里的 message 原文; 401/403 提示没有权限
* 依赖:   无(只用 SAP 标准 HTTP 客户端)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用)
* V1.0    20261020: 首版
* ★ 重贴后核对标记: METHOD get 内有 create_internal 与 create_by_destination
*   两个分支; 有 propertytype_logon_popup = if_http_client=>co_disabled
*=======================================================================
CLASS zcl_ai_odata_client DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES: BEGIN OF ty_response,
             http_code  TYPE i,
             reason     TYPE string,
             body       TYPE string,      " 响应正文(JSON)
             bytes      TYPE i,           " 响应字节数
             elapsed_ms TYPE i,
             channel    TYPE string,      " INTERNAL / SM59 目标名
             error      TYPE string,      " 非空 = 失败(已是给用户看的中文)
           END OF ty_response.

    " GET 一个 OData URI(以 /sap/opu/odata/ 开头, 已 URL 编码)
    CLASS-METHODS get
      IMPORTING iv_uri       TYPE string
                iv_timeout   TYPE i DEFAULT 60
                iv_max_bytes TYPE i DEFAULT 20971520
      RETURNING VALUE(rs)    TYPE ty_response.

    " URI 是否可调用(前缀、字符集); 不合法返回原因
    CLASS-METHODS check_uri
      IMPORTING iv_uri       TYPE string
      RETURNING VALUE(rv)    TYPE string.

  PRIVATE SECTION.

    " 从 OData 错误响应里取 message(取不到返回空)
    CLASS-METHODS odata_message
      IMPORTING iv_body      TYPE string
      RETURNING VALUE(rv)    TYPE string.

ENDCLASS.



CLASS zcl_ai_odata_client IMPLEMENTATION.


  METHOD check_uri.

    CLEAR rv.
    IF iv_uri IS INITIAL.
      rv = 'URI 为空'.
      RETURN.
    ENDIF.
    IF find( val = iv_uri sub = '/sap/opu/odata/' ) <> 0.
      rv = 'URI 必须以 /sap/opu/odata/ 开头(不带主机名)'.
      RETURN.
    ENDIF.
    " 已 URL 编码的 URI 只会出现这些字符(OData 字面量的单引号浏览器常不编码, 也允许);
    " 空格、双引号、尖括号、中文等一律拒绝
    IF iv_uri CN `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/_-.~%?&=$,:;()*!+@'`.
      rv = 'URI 含有未编码的字符(空格、双引号、中文等), 请先 URL 编码'.
      RETURN.
    ENDIF.
    IF find( val = iv_uri sub = '$batch' ) >= 0.
      rv = '不支持 $batch, 请拆成单个请求的 URI'.
      RETURN.
    ENDIF.

  ENDMETHOD.


  METHOD get.

    DATA: lo_http    TYPE REF TO if_http_client,
          lv_dest    TYPE rfcdest,
          lv_code    TYPE i,
          lv_reason  TYPE string,
          lv_rc      TYPE i,
          lv_msg     TYPE string,
          lv_xdata   TYPE xstring,
          lv_t0      TYPE i,
          lv_t1      TYPE i,
          lv_timeout TYPE i.

    CLEAR rs.
    rs-error = check_uri( iv_uri ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    lv_timeout = iv_timeout.
    IF lv_timeout <= 0.
      lv_timeout = 60.
    ENDIF.

    GET RUN TIME FIELD lv_t0.

    " ---- 通道: 空 = 本系统内部调用(当前用户); 填了 = SM59 目标(退路) ----
    lv_dest = zcl_ai_task_service=>read_cfg_str( 'FIORI_HTTP_DEST' ).
    IF lv_dest IS INITIAL.
      rs-channel = 'INTERNAL'.
      cl_http_client=>create_internal(
        IMPORTING  client = lo_http
        EXCEPTIONS OTHERS = 1 ).
    ELSE.
      rs-channel = lv_dest.
      cl_http_client=>create_by_destination(
        EXPORTING  destination = lv_dest
        IMPORTING  client      = lo_http
        EXCEPTIONS OTHERS      = 1 ).
    ENDIF.
    IF sy-subrc <> 0 OR lo_http IS INITIAL.
      rs-error = |无法创建 HTTP 客户端(通道 { rs-channel })|.
      RETURN.
    ENDIF.

    " 不弹登录框: 内部调用沿用当前会话身份, 认证失败直接返回 401
    lo_http->propertytype_logon_popup = if_http_client=>co_disabled.
    cl_http_utility=>set_request_uri( request = lo_http->request uri = iv_uri ).
    lo_http->request->set_method( if_http_request=>co_request_method_get ).
    lo_http->request->set_header_field( name = 'Accept' value = 'application/json' ).

    lo_http->send(
      EXPORTING  timeout = lv_timeout
      EXCEPTIONS OTHERS  = 1 ).
    IF sy-subrc = 0.
      lo_http->receive( EXCEPTIONS OTHERS = 1 ).
    ENDIF.
    IF sy-subrc <> 0.
      lo_http->get_last_error( IMPORTING code = lv_rc message = lv_msg ).
      GET RUN TIME FIELD lv_t1.
      rs-elapsed_ms = ( lv_t1 - lv_t0 ) / 1000.
      rs-error = |调用 OData 失败(可能超时, 上限 { lv_timeout } 秒): { lv_msg }|.
      lo_http->close( EXCEPTIONS OTHERS = 1 ).
      RETURN.
    ENDIF.

    lo_http->response->get_status( IMPORTING code = lv_code reason = lv_reason ).
    lv_xdata = lo_http->response->get_data( ).
    rs-bytes = xstrlen( lv_xdata ).
    rs-http_code = lv_code.
    rs-reason = lv_reason.
    IF rs-bytes > iv_max_bytes.
      rs-error = |返回数据 { rs-bytes } 字节, 超过上限 { iv_max_bytes }, 请缩小查询范围|.
    ELSE.
      rs-body = lo_http->response->get_cdata( ).
    ENDIF.
    lo_http->close( EXCEPTIONS OTHERS = 1 ).

    GET RUN TIME FIELD lv_t1.
    rs-elapsed_ms = ( lv_t1 - lv_t0 ) / 1000.

    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF lv_code = 401 OR lv_code = 403.
      rs-error = |没有这张报表的权限(HTTP { lv_code }); 在 Fiori 里能打开这张报表的账号才能取数|.
    ELSEIF lv_code <> 200.
      lv_msg = odata_message( rs-body ).
      rs-error = |OData 返回 HTTP { lv_code }| &&
                 COND string( WHEN lv_msg IS NOT INITIAL THEN |: { lv_msg }| ELSE |({ lv_reason })| ).
    ENDIF.

  ENDMETHOD.


  METHOD odata_message.

    " OData V2 错误: {"error":{"code":"..","message":{"lang":"..","value":"原文"}}}
    " 只取第一个 "value":"..." 的内容(正则; 不追求完整 JSON 解析)
    DATA lv_val TYPE string.
    CLEAR rv.
    FIND REGEX '"value"\s*:\s*"([^"]*)"' IN iv_body SUBMATCHES lv_val.
    IF sy-subrc = 0.
      rv = lv_val.
    ENDIF.
    IF strlen( rv ) > 200.
      rv = substring( val = rv len = 200 ).
    ENDIF.

  ENDMETHOD.

ENDCLASS.
