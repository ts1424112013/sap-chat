*=======================================================================
* 对象:   ZCL_AI_ODATA_CLIENT
* 用途:   Fiori 报表取数 —— 在服务器内部以当前用户身份 GET 一个 OData URI
*         (设计: 功能计划书/Fiori报表分析/01-方案与开发计划 §4.1)
*         Fiori 页面在浏览器里怎么调 OData, 这里就在服务器内部原样调一次:
*         报表逻辑、口径、权限全部复用(S_SERVICE 与 DPC 里的权限检查照常生效)
* 规则:   - 只发 GET; 不发 CSRF; 不支持 $batch
*         - URI 必须以 /sap/opu/odata/ 开头(不带主机名), 其余字符由调用方
*           拼好并 URL 编码; 本类只再做一次字符集与长度校验
*         - 通道(ZAI_CHAT_CFG.FIORI_HTTP_DEST):
*             空(默认) = RFC 新会话: CALL FUNCTION Z_AI_ODATA_GET DESTINATION
*               'NONE'(系统自带, 不用建 SM59), 在新会话里 create_internal ——
*               身份仍是当前用户, 不存任何密码
*             填 SM59 目标名 = 该目标(真实网络连接, 身份取目标里的登录数据)
*           不能在网关请求里直接 create_internal: 10-22 部署实锤, 内层请求被
*           /IWFND/MED/101「ICF 节点不可用」拒绝(403), 外层请求收尾时
*           /IWCOR/CL_REST_HTTP_HANDLER 166 行 GETWA_NOT_ASSIGNED(500);
*           SE38 里直接调用正常(没有外层网关请求)。机制: 内层请求与外层网关
*           请求在同一会话里跑, 共用 /IWCOR、/IWFND 的静态数据 —— 内层收尾
*           CLEAR flow_history(169~173 行)让外层 166 行的 <flow_history> 失效,
*           内层自己也读到外层状态, 把服务解析成命名空间 /OPU/、服务 odata
*           (ERROR_LOG 实锤)。RFC 新会话有自己的一份静态数据, 与 SE38 一样
*         - 超时如实返回, 不重试; 响应超过 iv_max_bytes 拒绝
*         - HTTP 非 200: 附上服务端原文(OData message / HTML 标题 / 正文前
*           200 字); 401/403 提示没有权限
* 依赖:   函数模块 Z_AI_ODATA_GET(函数组 ZAI_ODATA, 远程启用; 源码
*         backend-abap/Z_AI_ODATA_GET.abap)。本类对它是动态调用, 先激活本类
*         再建函数模块; 没建时取数返回"未部署"提示, 不会 dump
* 安装:   SE24 -> 整类源代码替换粘帖 (ABAP 7.50 语法, 755 适用)
* V1.0    20261020: 首版(create_internal; FIORI_HTTP_DEST 填了走 SM59)
* V1.1~V1.2a 20261022: 部署现场版本(不在仓库): 三通道 destination / URL /
*         internal; 凭据透传 set_authorization; 401/403 附响应体; 头名诊断
* V1.3    20261022: 取代现场 V1.2a ——
*         ① 默认通道改为 RFC 新会话(见上), 不再需要 SM59;
*         ② SM59 通道保留(FIORI_HTTP_DEST 填目标名);
*         ③ 去掉 URL 通道(FIORI_SELF_URL): 不带凭据只会拿到登录页 401;
*         ④ 去掉凭据透传与头名诊断: 浏览器发了 Authorization 头, 但 ICF 登录
*            后不把它交给应用(现场头名清单里没有), 透传取不到; 取到了转发的
*            也是用户密码, 不该转发。set_authorization / set_hdr_names 只留空壳, 让现场
*            DPC_EXT 的捕获块照常编译, DPC_EXT 删掉捕获块后可一并删除;
*         ⑤ 非 200 附服务端原文(现场 V1.2a 的做法, 定位 MED/101 靠它);
*         ⑥ 新增 PUBLIC http_get(只做一次 HTTP GET, 不选通道、不翻译错误),
*            给 Z_AI_ODATA_GET 与测试程序用; 业务代码一律调 get;
*         ⑦ get 增加可选参数 iv_channel(RFC / INTERNAL / SM59 目标名), 只给
*            测试程序做通道对照, 业务调用不传
* ★ 重贴后核对标记: PUBLIC SECTION 有 get / http_get / check_uri /
*   set_authorization / set_hdr_names; via_rfc 内有 DESTINATION 'NONE' 与
*   RFC_CONNECTION_CLOSE; http_get 内有 create_internal 与
*   create_by_destination; 有 propertytype_logon_popup = if_http_client=>co_disabled;
*   全文无 create_by_url / FIORI_SELF_URL
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
             channel    TYPE string,      " RFC / INTERNAL / SM59 目标名
             error      TYPE string,      " 非空 = 失败(已是给用户看的中文)
           END OF ty_response.

    " GET 一个 OData URI(以 /sap/opu/odata/ 开头, 已 URL 编码)
    " iv_channel: 空 = 按配置(业务调用一律不传); RFC / INTERNAL / SM59 目标名
    " 只给测试程序做通道对照
    CLASS-METHODS get
      IMPORTING iv_uri       TYPE string
                iv_timeout   TYPE i DEFAULT 60
                iv_max_bytes TYPE i DEFAULT 20971520
                iv_channel   TYPE string OPTIONAL
      RETURNING VALUE(rs)    TYPE ty_response.

    " 只做一次 HTTP GET: iv_dest 空 = create_internal, 填了 = 该 SM59 目标
    " 不选通道、不翻译 HTTP 错误码; 给 Z_AI_ODATA_GET 与测试程序用
    CLASS-METHODS http_get
      IMPORTING iv_uri       TYPE string
                iv_dest      TYPE rfcdest OPTIONAL
                iv_timeout   TYPE i DEFAULT 60
                iv_max_bytes TYPE i DEFAULT 20971520
      RETURNING VALUE(rs)    TYPE ty_response.

    " URI 是否可调用(前缀、字符集); 不合法返回原因
    CLASS-METHODS check_uri
      IMPORTING iv_uri       TYPE string
      RETURNING VALUE(rv)    TYPE string.

    " 空壳(V1.3): 现场诊断版 DPC_EXT 的捕获块会调用, 不做任何事
    CLASS-METHODS set_authorization
      IMPORTING iv_authorization TYPE string OPTIONAL.
    CLASS-METHODS set_hdr_names
      IMPORTING iv_names         TYPE string OPTIONAL.

  PRIVATE SECTION.

    CONSTANTS gc_rfc_fm TYPE rs38l_fnam VALUE 'Z_AI_ODATA_GET'.

    " RFC 新会话里调用 http_get(DESTINATION 'NONE')
    CLASS-METHODS via_rfc
      IMPORTING iv_uri       TYPE string
                iv_timeout   TYPE i
                iv_max_bytes TYPE i
      RETURNING VALUE(rs)    TYPE ty_response.

    " 从错误响应里取一句服务端原文: OData message > HTML 标题 > 正文前 200 字
    CLASS-METHODS server_text
      IMPORTING iv_body      TYPE string
      RETURNING VALUE(rv)    TYPE string.

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

    DATA: lv_chan    TYPE string,
          lv_dest    TYPE rfcdest,
          lv_msg     TYPE string,
          lv_timeout TYPE i,
          lv_ts0     TYPE timestampl,
          lv_ts1     TYPE timestampl,
          lv_secs    TYPE tzntstmpl.

    CLEAR rs.
    rs-error = check_uri( iv_uri ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    lv_timeout = iv_timeout.
    IF lv_timeout <= 0.
      lv_timeout = 60.
    ENDIF.

    " ---- 通道: 测试程序可指定; 否则 FIORI_HTTP_DEST 空 = RFC 新会话, 填了 = SM59 ----
    lv_chan = iv_channel.
    IF lv_chan IS INITIAL.
      lv_chan = zcl_ai_task_service=>read_cfg_str( 'FIORI_HTTP_DEST' ).
    ENDIF.

    GET TIME STAMP FIELD lv_ts0.
    IF lv_chan IS INITIAL OR to_upper( lv_chan ) = 'RFC'.
      rs = via_rfc( iv_uri = iv_uri iv_timeout = lv_timeout iv_max_bytes = iv_max_bytes ).
    ELSEIF to_upper( lv_chan ) = 'INTERNAL'.
      " 网关请求里会被 MED/101 拒绝(见文件头); 只在 SE38 测试程序里对照用
      rs = http_get( iv_uri = iv_uri iv_timeout = lv_timeout iv_max_bytes = iv_max_bytes ).
    ELSE.
      lv_dest = lv_chan.
      rs = http_get( iv_uri = iv_uri iv_dest = lv_dest
                     iv_timeout = lv_timeout iv_max_bytes = iv_max_bytes ).
    ENDIF.
    GET TIME STAMP FIELD lv_ts1.
    TRY.
        lv_secs = cl_abap_tstmp=>subtract( tstmp1 = lv_ts1 tstmp2 = lv_ts0 ).
        rs-elapsed_ms = lv_secs * 1000.
      CATCH cx_root.
        rs-elapsed_ms = 0.
    ENDTRY.

    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF rs-http_code = 401 OR rs-http_code = 403.
      lv_msg = server_text( rs-body ).
      rs-error = |没有这张报表的权限(HTTP { rs-http_code }); 在 Fiori 里能打开这张报表的账号才能取数| &&
                 COND string( WHEN lv_msg IS NOT INITIAL THEN |。服务端原文: { lv_msg }| ELSE `` ) &&
                 |(通道 { rs-channel })|.
    ELSEIF rs-http_code <> 200.
      lv_msg = server_text( rs-body ).
      rs-error = |OData 返回 HTTP { rs-http_code }| &&
                 COND string( WHEN lv_msg IS NOT INITIAL THEN |: { lv_msg }| ELSE |({ rs-reason })| ) &&
                 |(通道 { rs-channel })|.
    ENDIF.

  ENDMETHOD.


  METHOD via_rfc.

    DATA: lv_fm     TYPE rs38l_fnam,
          lv_rc     TYPE i,
          lv_rfcmsg TYPE c LENGTH 255.

    CLEAR rs.
    rs-channel = 'RFC'.
    lv_fm = gc_rfc_fm.

    " 函数模块是动态调用(本类可先于它激活); 没建时给出明确提示
    SELECT SINGLE funcname FROM tfdir
      WHERE funcname = @lv_fm
      INTO @DATA(lv_exists).
    IF sy-subrc <> 0.
      rs-error = |取数通道未部署: SE37 新建远程启用的函数模块 { lv_fm }(函数组 ZAI_ODATA), | &&
                 |或在 ZAI_CHAT_CFG.FIORI_HTTP_DEST 填 SM59 目标名|.
      RETURN.
    ENDIF.

    " DESTINATION 'NONE' = 本系统、当前用户、新会话(不用建 SM59, 不存密码)
    " 注意: 同步 RFC 会让调用方做一次隐式数据库提交; 调用方此前没有未提交的写操作
    CALL FUNCTION lv_fm DESTINATION 'NONE'
      EXPORTING
        iv_uri                = iv_uri
        iv_timeout            = iv_timeout
        iv_max_bytes          = iv_max_bytes
      IMPORTING
        ev_code               = rs-http_code
        ev_reason             = rs-reason
        ev_body               = rs-body
        ev_bytes              = rs-bytes
        ev_error              = rs-error
      EXCEPTIONS
        system_failure        = 1 MESSAGE lv_rfcmsg
        communication_failure = 2 MESSAGE lv_rfcmsg
        OTHERS                = 3.
    lv_rc = sy-subrc.
    IF lv_rc <> 0.
      CLEAR: rs-http_code, rs-reason, rs-body, rs-bytes.
      rs-error = |RFC 新会话取数失败(DESTINATION NONE, rc={ lv_rc }): { condense( lv_rfcmsg ) }|.
    ENDIF.

    " 用完即关: 释放新会话(连同其中的静态状态), 不留到下一个请求
    CALL FUNCTION 'RFC_CONNECTION_CLOSE'
      EXPORTING
        destination = 'NONE'
      EXCEPTIONS
        OTHERS      = 1.

  ENDMETHOD.


  METHOD http_get.

    DATA: lo_http    TYPE REF TO if_http_client,
          lv_code    TYPE i,
          lv_reason  TYPE string,
          lv_rc      TYPE i,
          lv_msg     TYPE string,
          lv_xdata   TYPE xstring,
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

    IF iv_dest IS INITIAL.
      rs-channel = 'INTERNAL'.
      cl_http_client=>create_internal(
        IMPORTING  client = lo_http
        EXCEPTIONS OTHERS = 1 ).
    ELSE.
      rs-channel = iv_dest.
      cl_http_client=>create_by_destination(
        EXPORTING  destination = iv_dest
        IMPORTING  client      = lo_http
        EXCEPTIONS OTHERS      = 1 ).
    ENDIF.
    IF sy-subrc <> 0 OR lo_http IS INITIAL.
      rs-error = |无法创建 HTTP 客户端(通道 { rs-channel })|.
      RETURN.
    ENDIF.

    " 不弹登录框: 认证失败直接返回 401
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
      rs-error = |调用 OData 失败(通道 { rs-channel }, 可能超时, 上限 { lv_timeout } 秒): { lv_msg }|.
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

  ENDMETHOD.


  METHOD server_text.

    DATA lv_t TYPE string.
    CLEAR rv.
    IF iv_body IS INITIAL.
      RETURN.
    ENDIF.

    rv = odata_message( iv_body ).
    IF rv IS INITIAL.
      FIND REGEX '<title>([^<]*)</title>' IN iv_body IGNORING CASE SUBMATCHES lv_t.
      IF sy-subrc = 0.
        rv = condense( lv_t ).
      ENDIF.
    ENDIF.
    IF rv IS INITIAL.
      lv_t = iv_body.
      REPLACE ALL OCCURRENCES OF REGEX '<[^>]*>' IN lv_t WITH ` `.
      REPLACE ALL OCCURRENCES OF REGEX '\s+' IN lv_t WITH ` `.
      rv = condense( lv_t ).
    ENDIF.
    IF strlen( rv ) > 200.
      rv = substring( val = rv len = 200 ).
    ENDIF.

  ENDMETHOD.


  METHOD odata_message.

    " OData V2 错误: {"error":{"code":"..","message":{"lang":"..","value":"原文"}}}
    " 只取第一个 "value":"..." 的内容(正则; 不追求完整 JSON 解析); 带上 code
    DATA: lv_val  TYPE string,
          lv_code TYPE string.
    CLEAR rv.
    FIND REGEX '"value"\s*:\s*"([^"]*)"' IN iv_body SUBMATCHES lv_val.
    IF sy-subrc = 0.
      rv = lv_val.
      FIND REGEX '"code"\s*:\s*"([^"]*)"' IN iv_body SUBMATCHES lv_code.
      IF sy-subrc = 0 AND lv_code IS NOT INITIAL.
        rv = |{ lv_code } { rv }|.
      ENDIF.
    ENDIF.
    IF strlen( rv ) > 200.
      rv = substring( val = rv len = 200 ).
    ENDIF.

  ENDMETHOD.


  METHOD set_authorization.

    " 空壳(V1.3): 凭据透传已取消, 见文件头 ④
    RETURN.

  ENDMETHOD.


  METHOD set_hdr_names.

    " 空壳(V1.3): 头名诊断已取消, 见文件头 ④
    RETURN.

  ENDMETHOD.

ENDCLASS.
