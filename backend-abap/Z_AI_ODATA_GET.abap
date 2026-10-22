*=======================================================================
* 对象:   函数模块 Z_AI_ODATA_GET(函数组 ZAI_ODATA)
* 用途:   Fiori 报表取数的「RFC 新会话」通道 ——
*         ZCL_AI_ODATA_CLIENT=>get 用 CALL FUNCTION ... DESTINATION 'NONE'
*         调本函数; 'NONE' 是系统自带的目标(本系统、当前用户、新会话),
*         不用建 SM59、不存任何密码。本函数在新会话里调 http_get(内部
*         create_internal), 和 SE38 里直接调用的环境一样(没有外层网关请求),
*         避开 10-22 实锤的 MED/101(403)与 /IWCOR GETWA(500)
* 安全:   身份 = 调用者本人(与在 Fiori 页面里打开报表一致); 只接受
*         /sap/opu/odata/ 开头的 URI(http_get 内 check_uri); 只读, 不写表
* 安装:
*   1. SE80 → 函数组 → 新建 ZAI_ODATA(短文本: AI 助手 Fiori 取数),
*      包与传输请求同 ZCL_AI_ODATA_CLIENT(禁 $TMP); 激活函数组
*   2. SE37 → 函数模块 Z_AI_ODATA_GET → 创建, 函数组 ZAI_ODATA
*   3. 「属性」页: 处理类型选「远程启用模块」(★ 必选, 否则 DESTINATION
*      'NONE' 调用报"不是远程启用")
*   4. 「导入」页(全部勾「值传递」, RFC 要求):
*        IV_URI        TYPE STRING
*        IV_TIMEOUT    TYPE INT4    缺省值 60
*        IV_MAX_BYTES  TYPE INT4    缺省值 20971520
*      「导出」页(全部勾「值传递」):
*        EV_CODE       TYPE INT4
*        EV_REASON     TYPE STRING
*        EV_BODY       TYPE STRING
*        EV_BYTES      TYPE INT4
*        EV_ERROR      TYPE STRING
*      「例外」页: 不建
*   5. 「源代码」页: 把下面 FUNCTION ... ENDFUNCTION 之间的正文贴进去
*      (接口注释块由系统按第 4 步自动生成, 不用贴), 激活
*   顺序: 先激活 ZCL_AI_ODATA_CLIENT V1.3(本函数调用它的 http_get), 再建本函数
* 核对:   SE37 单测本函数: IV_URI 填一条 /sap/opu/odata/... 的 URI → EV_CODE = 200,
*         EV_BODY 是 JSON。权限: 若取数报 S_RFC 缺权限, 给用户角色加 S_RFC
*         (RFC_TYPE = FUGR, RFC_NAME = ZAI_ODATA, ACTVT = 16)
* V1.0    20261022: 首版
*=======================================================================
FUNCTION z_ai_odata_get.
*"----------------------------------------------------------------------
*"*"本地接口：
*"  IMPORTING
*"     VALUE(IV_URI) TYPE  STRING
*"     VALUE(IV_TIMEOUT) TYPE  INT4 DEFAULT 60
*"     VALUE(IV_MAX_BYTES) TYPE  INT4 DEFAULT 20971520
*"  EXPORTING
*"     VALUE(EV_CODE) TYPE  INT4
*"     VALUE(EV_REASON) TYPE  STRING
*"     VALUE(EV_BODY) TYPE  STRING
*"     VALUE(EV_BYTES) TYPE  INT4
*"     VALUE(EV_ERROR) TYPE  STRING
*"----------------------------------------------------------------------

  DATA ls_resp TYPE zcl_ai_odata_client=>ty_response.

  " iv_dest 不传 = create_internal(本会话没有外层网关请求)
  ls_resp = zcl_ai_odata_client=>http_get( iv_uri       = iv_uri
                                           iv_timeout   = iv_timeout
                                           iv_max_bytes = iv_max_bytes ).
  ev_code   = ls_resp-http_code.
  ev_reason = ls_resp-reason.
  ev_body   = ls_resp-body.
  ev_bytes  = ls_resp-bytes.
  ev_error  = ls_resp-error.

ENDFUNCTION.
