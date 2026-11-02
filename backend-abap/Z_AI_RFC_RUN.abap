*=======================================================================
* 对象:   函数模块 Z_AI_RFC_RUN(函数组 ZAI_ODATA)
* 用途:   数据分析里调用登记函数的「RFC 新会话」通道(设计: 功能计划书/RFC函数执行/03 §5) ——
*         ZCL_AI_RFC_EXEC=>call_sync 用 CALL FUNCTION 'Z_AI_RFC_RUN' DESTINATION 'NONE'
*         调本函数; 'NONE' = 本系统、当前用户、新会话, 不用建 SM59、不存密码。
*         目标函数 dump 时只会让调用方收到 SYSTEM_FAILURE, 不打断 Agent 请求
* 安全:   身份 = 调用者本人; 本函数只调 ZCL_AI_RFC_EXEC=>run_direct, 里面再核一遍
*         登记(FUNC + 活动 + 开放执行)、报表授权和目标函数的 S_RFC; 调用后 ROLLBACK WORK
* 安装:
*   1. 函数组用现有的 ZAI_ODATA(和 Z_AI_ODATA_GET 放一起, S_RFC 授权共用);
*      包与传输请求同 ZCL_AI_RFC_EXEC(禁 $TMP)
*   2. SE37 → 函数模块 Z_AI_RFC_RUN → 创建, 函数组 ZAI_ODATA
*   3. 「属性」页: 处理类型选「远程启用模块」(★ 必选, 否则 DESTINATION
*      'NONE' 调用报"不是远程启用")
*   4. 「导入」页(全部勾「值传递」, RFC 要求):
*        IV_REPORT_ID   TYPE STRING
*        IV_PARAMS_JSON TYPE STRING
*        IV_MAX_ROWS    TYPE INT4    缺省值 2000
*      「导出」页(全部勾「值传递」):
*        EV_RESULT      TYPE STRING
*        EV_ERROR       TYPE STRING
*      「例外」页: 不建
*   5. 「源代码」页: 把下面 FUNCTION ... ENDFUNCTION 之间的正文贴进去
*      (接口注释块由系统按第 4 步自动生成, 不用贴), 激活
*   顺序: 先激活 ZCL_AI_RFC_EXEC V1.1(本函数调用它的 run_direct), 再建本函数
* 核对:   SE37 单测: IV_REPORT_ID 填一个已登记函数的编号(ZAI_RPT_DEF-REPORT_ID),
*         IV_PARAMS_JSON 填 {"iv_werks":"1000"} 这类(键 = 参数编号小写) → EV_RESULT 以
*         {"NAME": 开头、带 "COLUMNS" / "ROWS"; 出错时 EV_ERROR 有原因。
*         权限: 若报 S_RFC 缺权限, 给用户角色加 S_RFC(RFC_TYPE = FUGR, RFC_NAME = ZAI_ODATA,
*         ACTVT = 16); 目标函数本身的 S_RFC 由 run_direct 另查
* V1.0    20261102: 首版
*=======================================================================
FUNCTION z_ai_rfc_run.
*"----------------------------------------------------------------------
*"*"本地接口：
*"  IMPORTING
*"     VALUE(IV_REPORT_ID) TYPE  STRING
*"     VALUE(IV_PARAMS_JSON) TYPE  STRING
*"     VALUE(IV_MAX_ROWS) TYPE  INT4 DEFAULT 2000
*"  EXPORTING
*"     VALUE(EV_RESULT) TYPE  STRING
*"     VALUE(EV_ERROR) TYPE  STRING
*"----------------------------------------------------------------------

  zcl_ai_rfc_exec=>run_direct(
    EXPORTING iv_report_id   = iv_report_id
              iv_params_json = iv_params_json
              iv_max_rows    = iv_max_rows
    IMPORTING ev_result      = ev_result
              ev_error       = ev_error ).

ENDFUNCTION.
