*=======================================================================
* 对象:   ZCL_ZAI_CHAT_DPC_EXT (SEGW 项目 ZAI_CHAT 生成的 DPC 扩展类)
* 用途:   OData 服务运行时逻辑(把请求转交给 ZCL_AI_CHAT_SERVICE)
* 重定义的方法:
*         1) EXECUTE_ACTION          - 基线 3 个函数导入: AnalyzeCode /
*                                      SaveModelCfg / TestModel(V1.3)
*                                    + V8 的 9 个: Login / RolesList /
*                                      SaveRoles / PromptsList / SavePrompts /
*                                      UsersList / SaveUser / GetConfig /
*                                      SaveConfig (V2.0 合并)
*                                    + V2.2 的 1 个: UpdateSession(会话
*                                      重命名/置顶), SaveModelCfg 增参
*                                      SkipSource(该模型不做源码解析) 与
*                                      UserHideSrc(USER 用此模型时不下发源码)
*                                    + Agent V1.0 的 1 个: AnalyzeAgent
*                                      (库存分析受限工具循环, 见
*                                      docs/SAP_AI对话助手_后端部署详细文档_V13.docx)
*         2) MODELS_GET_ENTITYSET    - GET /Models
*         3) MESSAGES_GET_ENTITYSET  - GET /Messages
*         4) SESSIONS_GET_ENTITYSET  - GET /Sessions(会话历史列表)
*                                      V12 增返 Mode/AgentType/Status
*                                      (对话与 Agent 模式分离)
*         5) SESSIONS_DELETE_ENTITY  - DELETE /Sessions('...')
*         6) AGENTCAPABILITIE_GET_ENTITYSET - GET /AgentCapabilities
*                                      (V1.3.0 数据分析能力目录, 计划 §5/§14;
*                                       需先在 SEGW 增加 AgentCapability
*                                       EntityType + AgentCapabilities
*                                       EntitySet, 属性全 Edm.String:
*                                       Entity/Label/Dimensions/Metrics/
*                                       Operations/MaxRows/TimeoutSec/
*                                       Permission/SensitiveFields)
*         + 辅助方法 V8_PARAM(读函数导入参数, V2.0)
* AnalyzeAgent 返回(ComplexType AgentResult)新增可选属性 AnalysisJson
* (Edm.String): 结构化分析+统一数据集; 旧前端继续读 Answer/TraceJson
* 不受影响(计划 §14/§18)。SEGW 增属性后需 Generate Runtime 并重新发布。
* 安装(两种方式任选):
*   A) SE24: 打开类 ZCL_ZAI_CHAT_DPC_EXT -> (修改) -> 方法列表中找到上述
*      继承方法 -> 逐个"重定义" -> 把本文档对应 METHOD 方法体的代码粘帖进去
*   B) ADT/Eclipse: 在本地包创建同名类后整段粘帖本文件(注意父类名要与
*      SEGW 实际生成的 DPC 类名一致, 本文件按项目名 ZAI_CHAT 生成为
*      ZCL_ZAI_CHAT_DPC; 若你的项目名不同, 请同步修改 INHERITING FROM)
* V2.0:   全量合并版 —— 已并入原 ZAI_CHAT_V8_ADMIN.abap 第四步的 9 个
*         V8 函数导入分支与 v8_param 辅助方法, 可直接整类覆盖粘贴,
*         无需再执行任何"追加"操作。
* 注意: SEGW 属性名与代码字段一一对应(如属性 ModelId -> 字段 modelid),
*       若你在 SEGW 中使用了不同的属性名, 请同步修改本类中的字段名。
*=======================================================================
* V1.1.1 20261006: 修复激活错 "method does not exist / 相似 AGENTCAPABILITIE_GET_ENTITYSET"
*   EntitySet AgentCapabilities 拼接 _GET_ENTITYSET = 32 字符, 超 ABAP 30 上限,
*   SEGW 生成基类方法名自动截尾(去掉 Capability 尾 s) —— 本类 REDEFINITION
*   方法名同步改为截断版(2 处: DEFINITION + IMPLEMENTATION), 方法体逻辑不变;
*   URL /AgentCapabilities 不受影响(metadata 用 EntitySet 全名)
*   ★ 重贴后核对标记: 搜 agentcapabilitie_get_entityset 应有 2 处(代码区)
* V13.1 20261007(踩坑清单 §2.3 对齐): ANALYZEAGENT 改经无下划线中间结构
*   ty_agent_odata 输出 —— copy_data_to_ref 按属性名大写精确匹配不容忍
*   下划线, 带下划线字段直传会静默置空(图表不出根因); 仓库此前版本
*   缺该修复, 本版补齐(ANALYZEAGENT + ANALYZETASK 共用)
* V15 20261007(P1~P3): 新增 ANALYZETASK/Tasks/TaskContext/ReportDefinitions/
*   StartReportRun/ReportRunStatus/ReportResult/TaskAction 分支
*   (GenericResult 走 ty_generic_odata 无下划线输出)
*   ★ 重贴后核对标记: 搜 to_agent_odata 应有 2 处调用(ANALYZEAGENT/
*   ANALYZETASK) + 1 处实现; to_generic_odata 应有 7 处调用 + 1 处实现
* V15.1 20261011: ANALYZETASK 把 FocusedArtifactId 透传给
*   AGENT_SERVICE.analyze_agent(iv_focus_artifact_id) —— 此前只解析不使用,
*   "分析一下这个结果" 拿不到前端正在看的报表结果(10.09 遗留问题 1);
*   需同时重贴 AGENT_SERVICE V15.1(新增可选参数), SEGW 无需改动
*   ★ 重贴后核对标记: ANALYZETASK 分支调用含 iv_focus_artifact_id = lv_at_fid
* V15.2 20261011: ANALYZETASK 新增可选参数 Scene(会话场景: REPORT/DATA/
*   INVENTORY/CODE/AUTO; 只在新会话首条消息时写入 AGENT_TYPE, 之后以库内
*   为准) —— 需在 SEGW 给 AnalyzeTask 加参数 Scene(Edm.String, Nullable)
*   并重新生成; 未加之前前端不会发送(按 metadata 探测), 新会话按 AUTO 处理
*   ★ 重贴后核对标记: ANALYZETASK 分支有 WHEN 'SCENE' 与 iv_scene = lv_at_scn
* V15.3 20261011(改进清单 BE-09): SESSIONS_GET_ENTITYSET 把 $top / $skip、
*   $filter 的 Mode(eq 'CHAT'/'AGENT') 与 search(标题关键字) 传给
*   CHAT_SERVICE.get_sessions(V2.4 新增可选入参) —— 原来固定前 100 条、
*   更早的会话前端看不到, 也没有服务端搜索。只改这一个方法, SEGW 无需改动;
*   需同时重贴 CHAT_SERVICE V2.4(先激活 CHAT_SERVICE)
*   ★ 重贴后核对标记: sessions_get_entityset 内有 iv_search = lv_search
*   与 is_paging-skip
* V15.4 20261020(权限自助申请): 新增 9 个函数导入分支 AUTHSUBMIT / AUTHBATCHADD /
*   AUTHDECIDE / AUTHREVOKE / AUTHTABLESAVE / AUTHRULESAVE / AUTHLIST /
*   AUTHTABLEDESCRIBE / AUTHCONFIG, 都调 ZCL_AI_AUTH_SERVICE 的同名类型化方法,
*   统一经 GenericResult 输出(Success=无 error / Message / ResultJson=camelCase
*   且不压缩空值); 新私有方法 auth_reply。需先激活 ZCL_AI_AUTH_SERVICE, 并在
*   SEGW 建 9 个 FI(全部返回 GenericResult、参数全 Edm.String), 见
*   backend-abap/00_对象清单与部署顺序_20261019.md 第七节。其余分支不变
*   ★ 重贴后核对标记: 搜 auth_reply 代码区应有 9 处调用 + 1 处实现 + 1 处声明(头部注释另有 2 处)
* V15.5 20261020(Fiori 报表分析): 新增 3 个函数导入分支 FIORIREPORTDEFS /
*   RUNFIORIREPORT / FIORIREPORTRESULT, 调 ZCL_AI_FIORI_REPORT_SERVICE 的
*   list_defs / run / get_result, 输出同样经 auth_reply(改名不值得, 它就是通用
*   的"类型化返回 → GenericResult"; ResultJson camelCase、不压缩空值)。需先
*   激活 ZCL_AI_FIORI_REPORT_SERVICE, 并在 SEGW 建 3 个 FI(返回 GenericResult,
*   参数全 Edm.String; RunFioriReport 为 POST), 见部署清单第七节 7.3。其余不变
*   ★ 重贴后核对标记: 搜 auth_reply 代码区应有 12 处调用(权限 9 + Fiori 3)
*   + 1 处实现 + 1 处声明; 搜 zcl_ai_fiori_report_service 代码区应有 3 处
* V15.6 20261021(修 AnalyzeCode HTTP 414): 长文本通道 ——
*   OData V2 函数导入的参数全在 URL 查询串里, 贴代码 / 附件时 URL 编码后超过
*   网关 / ICM 的 URL 上限, 返回 414。前端(ChatService._prepareQuestion)在问题
*   编码后超过 3000 字符时先 POST /ChatTexts(正文在请求体, 不受 URL 长度限制),
*   拿回 TextId, 再用 "@@ZAI_TEXT:<TextId>" 作为 Question 调 AnalyzeCode /
*   AnalyzeAgent / AnalyzeTask; 本类 EXECUTE_ACTION 解析完参数后经 resolve_text
*   换回原文(只认本人存的, 读到即删), 三个 FI 的分支与返回结构都不变。
*   需先 SE11 建表 ZAI_CHAT_TEXT, SEGW 建 EntityType ChatText(TextId 键 /
*   Content, ABAP 字段名 TEXTID / CONTENT) + EntitySet ChatTexts(只开 Creatable)
*   并 Generate, 见部署清单第八节。不要把 POST /ChatTexts 放进 $batch(本方法有
*   COMMIT WORK, changeset 内不允许)
*   ★ 重贴后核对标记: 定义区有 chattexts_create_entity REDEFINITION 与
*   resolve_text; EXECUTE_ACTION 参数循环后有 find( val = lv_question
*   sub = gc_text_prefix ) = 0
* V15.7 20261023(权限: 事务码规则带字段映射): AUTHRULESAVE 分支多读一个参数
*   FmapJson, 传给 ZCL_AI_AUTH_SERVICE=>save_rule 的 iv_fmap_json(V1.2 起有, 可选)。
*   需先 SE11 建 ZAI_AUTH_RMAP、重贴 ZCL_AI_AUTH_SERVICE V1.2, SEGW 给 AuthRuleSave
*   加参数 FmapJson(Edm.String, 勾 Nullable: 旧前端不发它也不 404)并 Generate。
*   现场 DPC 若还留着 〇-D 的诊断捕获块, 不要整类重贴, 只在 AUTHRULESAVE 分支加这一行。其余分支不变
*   ★ 重贴后核对标记: AUTHRULESAVE 分支里有 iv_fmap_json = v8_param( ... 'FmapJson' )
*=======================================================================
* V15(P1~P3) 20261007: Agent 多业务任务与报表分析接口
*   新增函数导入分支(全部旁路, 不改既有分支; SEGW 未建 metadata 前
*   网关在 metadata 层直接拒绝, 本类分支不生效 —— 见部署清单):
*   - ANALYZETASK        复用 ComplexType AgentResult + 新增可选属性
*                        TaskId/TaskModule/TaskStatus/NeedsInput/
*                        PendingParamsJson/ArtifactRefsJson(旧前端忽略)
*   - TASKS / TASKCONTEXT / REPORTDEFINITIONS / STARTREPORTRUN /
*     REPORTRUNSTATUS / REPORTRESULT / TASKACTION
*                        返回统一 ComplexType GenericResult{Success,
*                        Message, ResultJson}: ResultJson 承载服务层
*                        结构化 JSON(协议见 02 设计 §4.3), 前端能力
*                        探测失败时回退旧 AnalyzeAgent
*   安全: 后端是事实源 —— 未登记报表/未开开关/归属不符一律拒绝;
*   前端不能决定权限、白名单、报表存在性与运行成功与否
*=======================================================================
* V15.8 20261023: SkillList / SkillSave / AnalyzeTask.SkillId; 技能上下文只信本人任务。
* V15.9 20261028(边跑边看, 设计: 功能计划书/Agent实时过程/01): 运行进度 ——
*   ① ANALYZETASK 把已解析的 ClientRequestId(lv_at_rid)传给
*     AGENT_SERVICE.analyze_agent(iv_request_id), 作为本次运行的进度键;
*   ② 新增函数导入 AgentProgress(GET; 参数 ClientRequestId; 返回 GenericResult),
*     ResultJson = ZCL_AI_AGENT_PROGRESS=>read(只读, 只返回本人的运行)。
*   SEGW: Function Import AgentProgress, HTTP Method GET, Return Type
*   GenericResult(Complex Type, Cardinality 1), 参数 ClientRequestId Edm.String 32。
*   ★ 重贴后核对标记: 有 WHEN 'AGENTPROGRESS' 与 iv_request_id = lv_at_rid
* V15.10 20261029(思考模式, SEGW 无需改动): AnalyzeCode / AnalyzeAgent / AnalyzeTask 出参时
*   用 ZCL_AI_LLM_CLIENT=>wrap_think 把本轮思考过程放在 Answer 前面(<think>…</think>),
*   前端拆开放进可折叠的「思考过程」区。只在这里拼 —— 服务层落库的回答不含思考。
*   需先激活 LLM_CLIENT V1.6、CHAT_SERVICE V2.6、AGENT_SERVICE V15.9(出参新字段 reasoning)
*   ★ 重贴后核对标记: 搜 wrap_think( 应有 2 处(ANALYZECODE 分支 + to_agent_odata)
CLASS zcl_zai_chat_dpc_ext DEFINITION
  PUBLIC
  INHERITING FROM zcl_zai_chat_dpc
  CREATE PUBLIC.

  PUBLIC SECTION.

    " 函数导入: 基线 3 个 + V8 的 9 个(见头部说明)
    METHODS /iwbep/if_mgw_appl_srv_runtime~execute_action REDEFINITION.

  PROTECTED SECTION.

    " GET /Models - 模型配置列表
    METHODS models_get_entityset REDEFINITION.

    " GET /Messages - 会话消息历史($filter=SessionId eq '...')
    METHODS messages_get_entityset REDEFINITION.

    " 会话历史列表(前端左侧栏)
    METHODS sessions_get_entityset REDEFINITION.

    " 删除会话(连带删除消息)
    METHODS sessions_delete_entity REDEFINITION.

    " V1.3.0: GET /AgentCapabilities - 数据分析能力目录(计划 §5)
    METHODS agentcapabilitie_get_entityset REDEFINITION.

    " V15.6: POST /ChatTexts - 长文本通道(问题太长时先暂存正文, 返回 TextId)
    METHODS chattexts_create_entity REDEFINITION.

    " V2.0: 读取 Function Import 的指定参数(大小写不敏感, 未传返回空)
    METHODS v8_param
      IMPORTING it_parameter TYPE /iwbep/t_mgw_name_value_pair
                iv_name      TYPE string
      RETURNING VALUE(rv)    TYPE string.

  PRIVATE SECTION.

    " V15.6: 长文本通道 —— Question 以此前缀开头时, 后面是 ChatTexts 的 TextId
    CONSTANTS: gc_text_prefix TYPE string VALUE '@@ZAI_TEXT:',
               gc_text_max    TYPE i VALUE 1000000.   " 单条长文本字符上限

    " V15.6: "@@ZAI_TEXT:<TextId>" → 暂存的原文(只认本人存的, 读到即删)
    METHODS resolve_text
      IMPORTING iv_question TYPE string
      RETURNING VALUE(rv)   TYPE string
      RAISING   /iwbep/cx_mgw_busi_exception.

    " V15: 结构化接口统一返回的服务侧结构(分支内填充, 输出前经
    " to_generic_odata 转无下划线结构再 copy_data_to_ref)
    TYPES: BEGIN OF ty_generic_result,
             success     TYPE string,
             message     TYPE string,
             result_json TYPE string,
           END OF ty_generic_result.

    " V15: 无下划线中间结构(踩坑清单 §2.3: copy_data_to_ref 按属性名
    " 大写精确匹配, 不容忍下划线 —— 带下划线字段静默置空不报错)。
    " ★ 重贴后核对标记: 搜 ty_agent_odata / ty_generic_odata 应各有多处引用
    " AgentResult: SEGW 属性 SessionId/Answer/Status/ModelId/Rounds/
    " ElapsedMs/TraceJson/AnalysisJson/Message + V15 新增 TaskId/
    " TaskModule/TaskStatus/NeedsInput/PendingParamsJson/ArtifactRefsJson
    TYPES: BEGIN OF ty_agent_odata,
             sessionid          TYPE string,
             answer             TYPE string,
             status             TYPE string,
             modelid            TYPE string,
             rounds             TYPE string,
             elapsedms          TYPE string,
             tracejson          TYPE string,
             analysisjson       TYPE string,
             message            TYPE string,
             taskid             TYPE string,
             taskmodule         TYPE string,
             taskstatus         TYPE string,
             needsinput         TYPE string,
             pendingparamsjson  TYPE string,
             artifactrefsjson   TYPE string,
           END OF ty_agent_odata.

    " GenericResult: SEGW 属性 Success/Message/ResultJson
    TYPES: BEGIN OF ty_generic_odata,
             success     TYPE string,
             message     TYPE string,
             resultjson  TYPE string,
           END OF ty_generic_odata.

    " AgentResult(ty_agent_result) → 无下划线 OData 结构逐字段搬运
    CLASS-METHODS to_agent_odata
      IMPORTING is_agent    TYPE zcl_ai_agent_service=>ty_agent_result
      RETURNING VALUE(rs)   TYPE ty_agent_odata.

    " GenericResult 服务结构 → 无下划线 OData 结构
    CLASS-METHODS to_generic_odata
      IMPORTING is_result   TYPE ty_generic_result
      RETURNING VALUE(rs)   TYPE ty_generic_odata.

    " V15.4: 权限申请服务的返回 → GenericResult(iv_error 非空 = 失败, Message 取它;
    " 成功时 Message 取 iv_message; ResultJson = iv_data 的 camelCase JSON, 不压缩空值)
    " V15.5: Fiori 报表的 3 个 FI 也用它(通用的类型化返回 → GenericResult)
    CLASS-METHODS auth_reply
      IMPORTING iv_error    TYPE string
                iv_message  TYPE string
                iv_data     TYPE any
      RETURNING VALUE(rs)   TYPE ty_generic_result.

    " V15: TASKS 返回行(TaskItem)
    TYPES: BEGIN OF ty_task_item,
             task_id     TYPE string,
             short_id    TYPE string,
             module_id   TYPE string,
             intent_code TYPE string,
             title       TYPE string,
             status      TYPE string,
             focus_artifact TYPE string,
             version     TYPE i,
             pending_json TYPE string,
             summary_text TYPE string,
             created_at  TYPE string,
             changed_at  TYPE string,
           END OF ty_task_item.

ENDCLASS.


CLASS zcl_zai_chat_dpc_ext IMPLEMENTATION.


  METHOD /iwbep/if_mgw_appl_srv_runtime~execute_action.

    DATA: lv_session  TYPE string,
          lv_question TYPE string,
          lv_model    TYPE string,
          lv_prog     TYPE string,
          ls_param    LIKE LINE OF it_parameter.

    LOOP AT it_parameter INTO ls_param.
      CASE to_upper( ls_param-name ).
        WHEN 'SESSIONID'.    lv_session  = ls_param-value.
        WHEN 'QUESTION'.     lv_question = ls_param-value.
        WHEN 'MODELID'.      lv_model    = ls_param-value.
        WHEN 'PROGRAMNAME'.  lv_prog     = ls_param-value.
      ENDCASE.
    ENDLOOP.

    " V15.6: 长文本通道 —— 前端把太长的问题先存进 ChatTexts, 这里只收到引用, 换回原文
    " (AnalyzeCode / AnalyzeAgent / AnalyzeTask 共用 lv_question, 一处换完即可)
    IF find( val = lv_question sub = gc_text_prefix ) = 0.
      lv_question = resolve_text( lv_question ).
    ENDIF.

    CASE to_upper( iv_action_name ).
      WHEN 'AGENTPROGRESS'.
        " V15.9 边跑边看: 本人某次 Agent 运行的进度(只读; AnalyzeTask 返回前前端约每秒查一次)
        DATA ls_prog_reply TYPE ty_generic_result.
        CLEAR ls_prog_reply.
        ls_prog_reply-success     = 'X'.
        ls_prog_reply-result_json = zcl_ai_agent_progress=>read(
                                      v8_param( it_parameter = it_parameter iv_name = 'ClientRequestId' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata( ls_prog_reply ) CHANGING cr_data = er_data ).

      WHEN 'SKILLLIST'.
        DATA: ls_sk_list TYPE zcl_ai_skill_service=>ty_list, lv_sk_error TYPE string,
              ls_sk_reply TYPE ty_generic_result.
        zcl_ai_skill_service=>list(
          EXPORTING iv_scene = v8_param( it_parameter = it_parameter iv_name = 'Scene' )
                    iv_session_id = v8_param( it_parameter = it_parameter iv_name = 'SessionId' )
                    iv_task_id = v8_param( it_parameter = it_parameter iv_name = 'TaskId' )
                    iv_include_inactive = xsdbool( v8_param( it_parameter = it_parameter iv_name = 'IncludeInactive' ) = 'X' )
          IMPORTING es_list = ls_sk_list ev_error = lv_sk_error ).
        ls_sk_reply-success = COND #( WHEN lv_sk_error IS INITIAL THEN 'X' ELSE '' ).
        ls_sk_reply-message = lv_sk_error.
        ls_sk_reply-result_json = /ui2/cl_json=>serialize( data = ls_sk_list
          pretty_name = /ui2/cl_json=>pretty_mode-camel_case compress = abap_false ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata( ls_sk_reply ) CHANGING cr_data = er_data ).

      WHEN 'SKILLSAVE'.
        DATA: ls_sk_saved TYPE zcl_ai_skill_service=>ty_skill, lv_sk_json TYPE string.
        lv_sk_json = v8_param( it_parameter = it_parameter iv_name = 'Payload' ).
        IF lv_sk_json CP '@@ZAI_TEXT:*'. lv_sk_json = resolve_text( lv_sk_json ). ENDIF.
        CLEAR: ls_sk_reply, lv_sk_error.
        zcl_ai_skill_service=>save( EXPORTING iv_json = lv_sk_json
          IMPORTING es_skill = ls_sk_saved ev_error = lv_sk_error ).
        ls_sk_reply-success = COND #( WHEN lv_sk_error IS INITIAL THEN 'X' ELSE '' ).
        ls_sk_reply-message = lv_sk_error.
        ls_sk_reply-result_json = /ui2/cl_json=>serialize( data = ls_sk_saved
          pretty_name = /ui2/cl_json=>pretty_mode-camel_case compress = abap_false ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata( ls_sk_reply ) CHANGING cr_data = er_data ).


      " ===============================================================
      " V15.4: 事务码权限自助申请(9 个 FI; 服务内部再校验开关与角色)
      " ===============================================================
      WHEN 'AUTHSUBMIT'.
        DATA(ls_au1) = zcl_ai_auth_service=>submit(
                         iv_tcode      = v8_param( it_parameter = it_parameter iv_name = 'Tcode' )
                         iv_werks_list = v8_param( it_parameter = it_parameter iv_name = 'WerksList' )
                         iv_reason     = v8_param( it_parameter = it_parameter iv_name = 'Reason' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au1-error iv_message = ls_au1-summary iv_data = ls_au1 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHBATCHADD'.
        DATA(ls_au2) = zcl_ai_auth_service=>admin_batch_add(
                         iv_users      = v8_param( it_parameter = it_parameter iv_name = 'Users' )
                         iv_tcode      = v8_param( it_parameter = it_parameter iv_name = 'Tcode' )
                         iv_werks_list = v8_param( it_parameter = it_parameter iv_name = 'WerksList' )
                         iv_reason     = v8_param( it_parameter = it_parameter iv_name = 'Reason' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au2-error iv_message = ls_au2-summary iv_data = ls_au2 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHDECIDE'.
        DATA(ls_au3) = zcl_ai_auth_service=>decide(
                         iv_req_id  = v8_param( it_parameter = it_parameter iv_name = 'ReqId' )
                         iv_approve = v8_param( it_parameter = it_parameter iv_name = 'Approve' )
                         iv_message = v8_param( it_parameter = it_parameter iv_name = 'Message' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au3-error iv_message = ls_au3-summary iv_data = ls_au3 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHREVOKE'.
        DATA(ls_au4) = zcl_ai_auth_service=>revoke(
                         iv_req_id  = v8_param( it_parameter = it_parameter iv_name = 'ReqId' )
                         iv_message = v8_param( it_parameter = it_parameter iv_name = 'Message' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au4-error iv_message = ls_au4-summary iv_data = ls_au4 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHTABLESAVE'.
        DATA(ls_au5) = zcl_ai_auth_service=>save_table(
                         iv_tabname   = v8_param( it_parameter = it_parameter iv_name = 'Tabname' )
                         iv_descr     = v8_param( it_parameter = it_parameter iv_name = 'Descr' )
                         iv_discover  = v8_param( it_parameter = it_parameter iv_name = 'Discover' )
                         iv_active    = v8_param( it_parameter = it_parameter iv_name = 'Active' )
                         iv_fmap_json = v8_param( it_parameter = it_parameter iv_name = 'FmapJson' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au5-error iv_message = ls_au5-message iv_data = ls_au5 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHRULESAVE'.
        DATA(ls_au6) = zcl_ai_auth_service=>save_rule(
                         iv_tcode_pat = v8_param( it_parameter = it_parameter iv_name = 'TcodePat' )
                         iv_tabname   = v8_param( it_parameter = it_parameter iv_name = 'Tabname' )
                         iv_rule_mode = v8_param( it_parameter = it_parameter iv_name = 'RuleMode' )
                         iv_allow_all = v8_param( it_parameter = it_parameter iv_name = 'AllowAll' )
                         iv_active    = v8_param( it_parameter = it_parameter iv_name = 'Active' )
                         iv_delete    = v8_param( it_parameter = it_parameter iv_name = 'Delete' )
                         iv_fmap_json = v8_param( it_parameter = it_parameter iv_name = 'FmapJson' ) ).   " V15.7
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au6-error iv_message = ls_au6-message iv_data = ls_au6 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHLIST'.
        DATA(ls_au7) = zcl_ai_auth_service=>list_requests(
                         iv_status = v8_param( it_parameter = it_parameter iv_name = 'Status' )
                         iv_user   = v8_param( it_parameter = it_parameter iv_name = 'User' )
                         iv_tcode  = v8_param( it_parameter = it_parameter iv_name = 'Tcode' )
                         iv_top    = v8_param( it_parameter = it_parameter iv_name = 'Top' )
                         iv_skip   = v8_param( it_parameter = it_parameter iv_name = 'Skip' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au7-error iv_message = `` iv_data = ls_au7 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHTABLEDESCRIBE'.
        DATA(ls_au8) = zcl_ai_auth_service=>describe_table(
                         iv_tabname = v8_param( it_parameter = it_parameter iv_name = 'Tabname' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au8-error iv_message = `` iv_data = ls_au8 ) )
                          CHANGING cr_data = er_data ).

      WHEN 'AUTHCONFIG'.
        DATA(ls_au9) = zcl_ai_auth_service=>get_config( ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_au9-error iv_message = `` iv_data = ls_au9 ) )
                          CHANGING cr_data = er_data ).

      " ===============================================================
      " V15.5: Fiori 报表(3 个 FI; 开关 / 用户 / 归属在服务内校验)
      " ===============================================================
      WHEN 'FIORIREPORTDEFS'.
        DATA(ls_fdefs) = zcl_ai_fiori_report_service=>list_defs( ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_fdefs-error iv_message = ls_fdefs-message iv_data = ls_fdefs ) )
                          CHANGING cr_data = er_data ).

      WHEN 'RUNFIORIREPORT'.
        DATA(ls_frun) = zcl_ai_fiori_report_service=>run(
                          iv_task_id     = v8_param( it_parameter = it_parameter iv_name = 'TaskId' )
                          iv_session_id  = v8_param( it_parameter = it_parameter iv_name = 'SessionId' )
                          iv_report_id   = v8_param( it_parameter = it_parameter iv_name = 'ReportId' )
                          iv_params_json = v8_param( it_parameter = it_parameter iv_name = 'ParamsJson' )
                          iv_request_id  = v8_param( it_parameter = it_parameter iv_name = 'ClientRequestId' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_frun-error iv_message = ls_frun-message iv_data = ls_frun ) )
                          CHANGING cr_data = er_data ).

      WHEN 'FIORIREPORTRESULT'.
        DATA(ls_fres) = zcl_ai_fiori_report_service=>get_result(
                          iv_artifact_id = v8_param( it_parameter = it_parameter iv_name = 'ArtifactId' ) ).
        copy_data_to_ref( EXPORTING is_data = to_generic_odata(
                            auth_reply( iv_error = ls_fres-error iv_message = ls_fres-message iv_data = ls_fres ) )
                          CHANGING cr_data = er_data ).

      WHEN 'ANALYZECODE'.
        DATA: ls_result TYPE zcl_ai_chat_service=>ty_analyze_result.

        zcl_ai_chat_service=>analyze(
          EXPORTING iv_session_id   = lv_session
                    iv_question     = lv_question
                    iv_model_id     = lv_model
                    iv_program_name = lv_prog
          IMPORTING es_result       = ls_result ).

        " V15.10: 思考过程放在回答前面回给前端(落库的回答不含思考)
        ls_result-answer = zcl_ai_llm_client=>wrap_think( iv_reasoning = ls_result-reasoning
                                                          iv_answer    = ls_result-answer ).
        copy_data_to_ref( EXPORTING is_data  = ls_result
                          CHANGING  cr_data  = er_data ).

      WHEN 'ANALYZEAGENT'.
        " Agent V1.0: 库存分析受限工具循环(与普通聊天路径完全分离;
        " 参数 SessionId/Question/ModelId 与 AnalyzeCode 同名复用上方解析)
        " V15: 改经无下划线中间结构输出(踩坑清单 §2.3/V13.1 修复对齐 ——
        " 带下划线字段直传 copy_data_to_ref 会静默置空)
        DATA: ls_agent TYPE zcl_ai_agent_service=>ty_agent_result.

        zcl_ai_agent_service=>analyze_agent(
          EXPORTING iv_session_id = lv_session
                    iv_question   = lv_question
                    iv_model_id   = lv_model
                    iv_skill_id   = 'NONE' " 旧接口不隐式继承新入口的技能
          IMPORTING es_result     = ls_agent ).

        copy_data_to_ref( EXPORTING is_data  = to_agent_odata( ls_agent )
                          CHANGING  cr_data  = er_data ).

      WHEN 'SAVEMODELCFG'.
        DATA: ls_save TYPE zcl_ai_chat_service=>ty_save_result,
              lv_key  TYPE string,
              lv_val  TYPE string.

        LOOP AT it_parameter INTO ls_param.
          lv_key = to_upper( ls_param-name ).
          lv_val = ls_param-value.
          CASE lv_key.
            WHEN 'MODELID'.      DATA(lv_model_id)     = lv_val.
            WHEN 'MODELNAME'.    DATA(lv_model_name)   = lv_val.
            WHEN 'MODELDESC'.    DATA(lv_model_desc)   = lv_val.
            WHEN 'MODELTYPE'.    DATA(lv_model_type)   = lv_val.
            WHEN 'ENDPOINTURL'.  DATA(lv_endpoint_url) = lv_val.
            WHEN 'DESTINATION'.  DATA(lv_destination)  = lv_val.
            WHEN 'APIMODEL'.     DATA(lv_api_model)    = lv_val.
            WHEN 'APIKEY'.       DATA(lv_api_key)      = lv_val.
            WHEN 'AUTHTYPE'.     DATA(lv_auth_type)    = lv_val.
            WHEN 'TEMPERATURE'.  DATA(lv_temperature)  = lv_val.
            WHEN 'MAXTOKENS'.    DATA(lv_max_tokens)   = lv_val.
            WHEN 'TIMEOUTSEC'.   DATA(lv_timeout_sec)  = lv_val.
            WHEN 'ISACTIVE'.     DATA(lv_is_active)    = lv_val.
            WHEN 'SKIPSOURCE'.   DATA(lv_skip_source)  = lv_val.
            WHEN 'USERHIDESRC'.  DATA(lv_user_hide_src) = lv_val.
          ENDCASE.
        ENDLOOP.

        zcl_ai_chat_service=>save_model_cfg(
          EXPORTING iv_model_id     = lv_model_id
                    iv_model_name   = lv_model_name
                    iv_model_desc   = lv_model_desc
                    iv_model_type   = lv_model_type
                    iv_endpoint_url = lv_endpoint_url
                    iv_destination  = lv_destination
                    iv_api_model    = lv_api_model
                    iv_api_key      = lv_api_key
                    iv_auth_type    = lv_auth_type
                    iv_temperature  = lv_temperature
                    iv_max_tokens   = lv_max_tokens
                    iv_timeout_sec  = lv_timeout_sec
                    iv_is_active    = lv_is_active
                    iv_skip_source  = lv_skip_source
                    iv_user_hide_src = lv_user_hide_src
          IMPORTING es_result       = ls_save ).

        copy_data_to_ref( EXPORTING is_data  = ls_save
                          CHANGING  cr_data  = er_data ).

      WHEN 'TESTMODEL'.
        DATA: ls_test TYPE zcl_ai_chat_service=>ty_test_result,
              lv_mid  TYPE string.

        LOOP AT it_parameter INTO ls_param.
          IF to_upper( ls_param-name ) = 'MODELID'.
            lv_mid = ls_param-value.
          ENDIF.
        ENDLOOP.

        zcl_ai_chat_service=>test_model(
          EXPORTING iv_model_id = lv_mid
          IMPORTING es_result   = ls_test ).

        copy_data_to_ref( EXPORTING is_data  = ls_test
                          CHANGING  cr_data  = er_data ).

      WHEN 'LOGIN'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_login( )
                          CHANGING  cr_data  = er_data ).

      WHEN 'ROLESLIST'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_get_roles( )
                          CHANGING  cr_data  = er_data ).

      WHEN 'SAVEROLES'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_save_roles(
                                             iv_json = v8_param( it_parameter = it_parameter iv_name = 'Roles' ) )
                          CHANGING  cr_data  = er_data ).

      WHEN 'PROMPTSLIST'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_get_prompts( )
                          CHANGING  cr_data  = er_data ).

      WHEN 'SAVEPROMPTS'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_save_prompts(
                                             iv_json = v8_param( it_parameter = it_parameter iv_name = 'Prompts' ) )
                          CHANGING  cr_data  = er_data ).

      WHEN 'USERSLIST'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_get_users( )
                          CHANGING  cr_data  = er_data ).

      WHEN 'SAVEUSER'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_save_user(
                                             iv_json = '{ "UserId": "'    && v8_param( it_parameter = it_parameter iv_name = 'UserId' ) &&
                                                       '", "UserName": "' && v8_param( it_parameter = it_parameter iv_name = 'UserName' ) &&
                                                       '", "Role": "'     && v8_param( it_parameter = it_parameter iv_name = 'Role' ) &&
                                                       '", "Active": "'   && v8_param( it_parameter = it_parameter iv_name = 'Active' ) && '" }' )
                          CHANGING  cr_data  = er_data ).

      WHEN 'GETCONFIG'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_get_config(
                                             iv_key = v8_param( it_parameter = it_parameter iv_name = 'ConfigKey' ) )
                          CHANGING  cr_data  = er_data ).

      WHEN 'SAVECONFIG'.
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_save_config(
                                             iv_key = v8_param( it_parameter = it_parameter iv_name = 'ConfigKey' )
                                             iv_val = v8_param( it_parameter = it_parameter iv_name = 'ConfigValue' ) )
                          CHANGING  cr_data  = er_data ).

      WHEN 'UPDATESESSION'.
        " V2.2: 会话重命名/置顶(仅本人会话)
        copy_data_to_ref( EXPORTING is_data  = zcl_ai_chat_service=>v8_update_session(
                                             iv_session_id = v8_param( it_parameter = it_parameter iv_name = 'SessionId' )
                                             iv_title      = v8_param( it_parameter = it_parameter iv_name = 'Title' )
                                             iv_pinned     = v8_param( it_parameter = it_parameter iv_name = 'Pinned' ) )
                          CHANGING  cr_data  = er_data ).

      " ===============================================================
      " V15(P1~P3): Agent 多业务任务与报表分析接口(旁路新增)
      " ===============================================================
      WHEN 'ANALYZETASK'.
        " 任务化 Agent 入口(与 AnalyzeAgent 并行): 参数在旧三参基础上
        " 新增 TaskId/ClientRequestId/FocusedArtifactId(P1 由后端
        " 确定性任务层解析; TaskId 仅作为候选值, 归属由后端校验)
        DATA: ls_atask TYPE zcl_ai_agent_service=>ty_agent_result,
              lv_at_tid TYPE string,
              lv_at_rid TYPE string,
              lv_at_fid TYPE string,
              lv_at_skill TYPE string,
              lv_at_scn TYPE string.   " V15.2: 会话场景
        CLEAR: lv_at_tid, lv_at_rid, lv_at_fid, lv_at_scn, lv_at_skill.
        LOOP AT it_parameter INTO ls_param.
          CASE to_upper( ls_param-name ).
            WHEN 'TASKID'.            lv_at_tid = ls_param-value.
            WHEN 'CLIENTREQUESTID'.   lv_at_rid = ls_param-value.
            WHEN 'FOCUSEDARTIFACTID'. lv_at_fid = ls_param-value.
            WHEN 'SCENE'.             lv_at_scn = ls_param-value.   " V15.2
            WHEN 'SKILLID'.           lv_at_skill = ls_param-value.
          ENDCASE.
        ENDLOOP.

        " V15.1: FocusedArtifactId 透传(候选值; 归属/会话/READY 由后端校验)
        zcl_ai_agent_service=>analyze_agent(
          EXPORTING iv_session_id        = lv_session
                    iv_question          = lv_question
                    iv_model_id          = lv_model
                    iv_focus_artifact_id = lv_at_fid
                    iv_scene             = lv_at_scn
                    iv_task_id           = lv_at_tid
                    iv_skill_id          = lv_at_skill
                    iv_request_id        = lv_at_rid   " V15.9: 运行进度键(边跑边看)
          IMPORTING es_result            = ls_atask ).

        IF ls_atask-status <> 'DENIED' AND ls_atask-status <> 'ERROR'.
          zcl_ai_skill_service=>copy_context( iv_session_id = lv_session
            iv_from_task = lv_at_tid iv_to_task = ls_atask-task_id ).
        ENDIF.

        " 显式指定 TaskId 且与后端解析一致时以显式为准(归属已校验);
        " 不一致以后端为准(后端是事实源)
        IF lv_at_tid IS NOT INITIAL AND ls_atask-task_id IS INITIAL
           AND ls_atask-status <> 'DENIED' AND ls_atask-status <> 'ERROR'.
          " 后端未启用任务层时原样回显候选值(前端据此降级)
          ls_atask-task_id = lv_at_tid.
        ENDIF.

        copy_data_to_ref( EXPORTING is_data  = to_agent_odata( ls_atask )
                          CHANGING  cr_data  = er_data ).

      WHEN 'TASKS'.
        " 会话任务列表(只读; 归属 = 当前用户)
        DATA: ls_tasks TYPE ty_generic_result,
              lt_tlist TYPE zcl_ai_task_service=>tt_task,
              lt_titems TYPE STANDARD TABLE OF ty_task_item WITH DEFAULT KEY.
        CLEAR: ls_tasks, lt_tlist, lt_titems.
        lt_tlist = zcl_ai_task_service=>list_tasks( lv_session ).
        LOOP AT lt_tlist INTO DATA(ls_t1).
          APPEND VALUE #( task_id = ls_t1-task_id
                          short_id = zcl_ai_task_service=>short_id( ls_t1-task_id )
                          module_id = ls_t1-module_id
                          intent_code = ls_t1-intent_code
                          title = ls_t1-task_title  " 20261008: ZAI_TASK.TITLE→TASK_TITLE 保留字修复, 视图键 title 不变
                          status = ls_t1-status
                          focus_artifact = COND #( WHEN ls_t1-focus_artifact_id IS NOT INITIAL
                            THEN zcl_ai_task_service=>short_id( ls_t1-focus_artifact_id ) ELSE '' )
                          version = ls_t1-current_version
                          pending_json = ls_t1-pending_json
                          summary_text = ls_t1-summary_text
                          created_at = ls_t1-created_at
                          changed_at = ls_t1-changed_at ) TO lt_titems.
        ENDLOOP.
        ls_tasks-success = 'X'.
        ls_tasks-result_json = /ui2/cl_json=>serialize(
                                 data = lt_titems compress = abap_true ).
        copy_data_to_ref( EXPORTING is_data  = to_generic_odata( ls_tasks )
                          CHANGING  cr_data  = er_data ).

      WHEN 'TASKCONTEXT'.
        " 任务上下文(摘要/待办/结果索引/相关消息摘要)
        DATA: ls_tctx TYPE ty_generic_result,
              ls_ctx  TYPE zcl_ai_task_service=>ty_context.
        CLEAR: ls_tctx, ls_ctx.
        ls_ctx = zcl_ai_task_service=>build_context(
                   iv_session_id = lv_session
                   iv_task_id    = v8_param( it_parameter = it_parameter iv_name = 'TaskId' ) ).
        IF ls_ctx-task_id IS NOT INITIAL.
          ls_tctx-success = 'X'.
          ls_tctx-result_json = zcl_ai_task_service=>context_json( ls_ctx ).
        ELSE.
          ls_tctx-success = ''.
          ls_tctx-message = '任务不存在、能力未开启或不属于当前用户'.
        ENDIF.
        copy_data_to_ref( EXPORTING is_data  = to_generic_odata( ls_tctx )
                          CHANGING  cr_data  = er_data ).

      WHEN 'REPORTDEFINITIONS'.
        " 登记报表 + 参数 Schema(REPORT_READ_ENABLED 未开 → 空清单)
        DATA: ls_rdefs TYPE ty_generic_result.
        CLEAR ls_rdefs.
        IF zcl_ai_report_service=>read_enabled( ) = abap_true.
          DATA(lt_rdefs) = zcl_ai_report_service=>list_defs( ).
          " 参数 Schema 逐报表附带(前端表单据此生成; 不含敏感默认值)
          DATA: BEGIN OF ls_rd,
                  report_id TYPE string,
                  tcode     TYPE string,
                  name      TYPE string,
                  description TYPE string,
                  exec_enabled TYPE string,
                  config_version TYPE string,
                  params    TYPE zcl_ai_report_service=>tt_param,
                END OF ls_rd,
                lt_rd LIKE STANDARD TABLE OF ls_rd.
          CLEAR: lt_rd.
          LOOP AT lt_rdefs INTO DATA(ls_rd1).
            CLEAR ls_rd.
            ls_rd-report_id = ls_rd1-report_id.
            ls_rd-tcode = ls_rd1-tcode.
            ls_rd-name = ls_rd1-report_name.
            ls_rd-description = ls_rd1-description.
            ls_rd-exec_enabled = COND #( WHEN ls_rd1-exec_enabled = abap_true THEN 'X' ELSE '' ).
            ls_rd-config_version = ls_rd1-config_version.
            ls_rd-params = zcl_ai_report_service=>get_params(
                             iv_report_id = ls_rd1-report_id
                             iv_config_version = ls_rd1-config_version ).
            APPEND ls_rd TO lt_rd.
          ENDLOOP.
          ls_rdefs-success = 'X'.
          ls_rdefs-result_json = /ui2/cl_json=>serialize(
                                    data = lt_rd compress = abap_true ).
        ELSE.
          ls_rdefs-success = 'X'.
          ls_rdefs-message = '报表读取能力未开启(REPORT_READ_ENABLED)'.
          ls_rdefs-result_json = '[]'.
        ENDIF.
        copy_data_to_ref( EXPORTING is_data  = to_generic_odata( ls_rdefs )
                          CHANGING  cr_data  = er_data ).

      WHEN 'STARTREPORTRUN'.
        " 幂等启动报表运行(P3; REPORT_EXEC_ENABLED 默认关闭)
        DATA: ls_srun TYPE ty_generic_result,
              ls_rst  TYPE zcl_ai_report_service=>ty_run_start.
        CLEAR: ls_srun, ls_rst.
        ls_rst = zcl_ai_report_service=>start_run(
                   iv_task_id     = v8_param( it_parameter = it_parameter iv_name = 'TaskId' )
                   iv_session_id  = v8_param( it_parameter = it_parameter iv_name = 'SessionId' )
                   iv_report_id   = v8_param( it_parameter = it_parameter iv_name = 'ReportId' )
                   iv_params_json = v8_param( it_parameter = it_parameter iv_name = 'ParamsJson' )
                   iv_request_id  = v8_param( it_parameter = it_parameter iv_name = 'ClientRequestId' ) ).
        ls_srun-success = COND #( WHEN ls_rst-rejected = abap_true THEN '' ELSE 'X' ).
        ls_srun-message = ls_rst-message.
        ls_srun-result_json = /ui2/cl_json=>serialize(
                                 data = ls_rst compress = abap_true
                                 pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
        copy_data_to_ref( EXPORTING is_data  = to_generic_odata( ls_srun )
                          CHANGING  cr_data  = er_data ).

      WHEN 'REPORTRUNSTATUS'.
        " 运行状态轮询(TIMEOUT≠已停止; UNKNOWN 需继续查询)
        DATA: ls_rsts TYPE ty_generic_result,
              ls_rstv TYPE zcl_ai_report_service=>ty_run_status.
        CLEAR: ls_rsts, ls_rstv.
        ls_rstv = zcl_ai_report_service=>get_run_status(
                    iv_report_run_id = v8_param( it_parameter = it_parameter iv_name = 'ReportRunId' ) ).
        ls_rsts-success = COND #( WHEN ls_rstv-report_run_id IS NOT INITIAL THEN 'X' ELSE '' ).
        ls_rsts-message = ls_rstv-message.
        ls_rsts-result_json = /ui2/cl_json=>serialize(
                                 data = ls_rstv compress = abap_true
                                 pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
        copy_data_to_ref( EXPORTING is_data  = to_generic_odata( ls_rsts )
                          CHANGING  cr_data  = er_data ).

      WHEN 'REPORTRESULT'.
        " 结果读取(READY + AVAILABLE + 归属正确; 过期/失效如实返回)
        DATA: ls_rres TYPE ty_generic_result,
              ls_rresv TYPE zcl_ai_report_service=>ty_result.
        CLEAR: ls_rres, ls_rresv.
        ls_rresv = zcl_ai_report_service=>get_result(
                     iv_artifact_id = v8_param( it_parameter = it_parameter iv_name = 'ArtifactId' ) ).
        ls_rres-success = COND #( WHEN ls_rresv-artifact_id IS NOT INITIAL THEN 'X' ELSE '' ).
        ls_rres-message = ls_rresv-message.
        ls_rres-result_json = /ui2/cl_json=>serialize(
                                 data = ls_rresv compress = abap_true
                                 pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
        copy_data_to_ref( EXPORTING is_data  = to_generic_odata( ls_rres )
                          CHANGING  cr_data  = er_data ).

      WHEN 'TASKACTION'.
        " 任务动作白名单: VIEW / PAUSE / RESUME / REANALYZE(重跑必须走
        " StartReportRun + 新 ClientRequestId, 不在本接口)
        DATA: ls_tact   TYPE ty_generic_result,
              lv_tact   TYPE string,
              lv_ttid   TYPE string,
              ls_ttask  TYPE zcl_ai_task_service=>ty_task,
              ls_tctx2  TYPE zcl_ai_task_service=>ty_context.
        CLEAR: ls_tact, lv_tact, lv_ttid, ls_ttask, ls_tctx2.
        lv_tact = to_upper( v8_param( it_parameter = it_parameter iv_name = 'Action' ) ).
        lv_ttid = v8_param( it_parameter = it_parameter iv_name = 'TaskId' ).
        ls_ttask = zcl_ai_task_service=>get_task_owned(
                     iv_task_id = lv_ttid iv_session_id = lv_session ).

        IF ls_ttask-task_id IS INITIAL.
          ls_tact-message = '任务不存在、能力未开启或不属于当前会话'.
        ELSE.
          CASE lv_tact.
            WHEN 'VIEW'.
              ls_tact-success = 'X'.
              ls_tctx2 = zcl_ai_task_service=>build_context(
                           iv_session_id = lv_session iv_task_id = lv_ttid ).
              ls_tact-result_json = zcl_ai_task_service=>context_json( ls_tctx2 ).
            WHEN 'PAUSE'.
              " 活跃态 → PAUSED(草稿与运行保留; 运行中的报表不取消)
              IF zcl_ai_task_service=>is_active_status( ls_ttask-status ) = abap_true.
                DATA lv_pause_ok TYPE abap_bool.
                zcl_ai_task_service=>update_status(
                  EXPORTING iv_task_id = lv_ttid iv_version = ls_ttask-current_version
                            iv_status  = zcl_ai_task_service=>gc_st_paused
                  IMPORTING ev_ok      = lv_pause_ok ).
                ls_tact-success = COND #( WHEN lv_pause_ok = abap_true THEN 'X' ELSE '' ).
                IF lv_pause_ok = abap_false.
                  ls_tact-message = '任务状态已被其他操作更新, 请刷新后重试'.
                ENDIF.
              ELSE.
                ls_tact-message = |任务当前状态 { ls_ttask-status } 不支持暂停|.
              ENDIF.
            WHEN 'RESUME'.
              " PAUSED → OPEN(恢复对话继续)
              IF ls_ttask-status = zcl_ai_task_service=>gc_st_paused.
                DATA lv_res_ok TYPE abap_bool.
                zcl_ai_task_service=>update_status(
                  EXPORTING iv_task_id = lv_ttid iv_version = ls_ttask-current_version
                            iv_status  = zcl_ai_task_service=>gc_st_open
                  IMPORTING ev_ok      = lv_res_ok ).
                ls_tact-success = COND #( WHEN lv_res_ok = abap_true THEN 'X' ELSE '' ).
                IF lv_res_ok = abap_false.
                  ls_tact-message = '任务状态已被其他操作更新, 请刷新后重试'.
                ENDIF.
              ELSE.
                ls_tact-message = |任务当前状态 { ls_ttask-status } 不支持恢复|.
              ENDIF.
            WHEN 'REANALYZE'.
              " 只重试分析, 不重跑报表: 前提 = 任务有可用结果且上次分析失败
              IF ls_ttask-focus_artifact_id IS NOT INITIAL
                 AND zcl_ai_report_service=>is_artifact_available( ls_ttask-focus_artifact_id ) = abap_true.
                DATA lv_rea_ok TYPE abap_bool.
                zcl_ai_task_service=>update_status(
                  EXPORTING iv_task_id = lv_ttid iv_version = ls_ttask-current_version
                            iv_status  = zcl_ai_task_service=>gc_st_analyzing
                  IMPORTING ev_ok      = lv_rea_ok ).
                ls_tact-success = COND #( WHEN lv_rea_ok = abap_true THEN 'X' ELSE '' ).
                IF lv_rea_ok = abap_true.
                  ls_tact-message = |已置为分析中, 请引用结果 { zcl_ai_task_service=>short_id( ls_ttask-focus_artifact_id ) } 继续提问分析|.
                ELSE.
                  ls_tact-message = '任务状态已被其他操作更新, 请刷新后重试'.
                ENDIF.
              ELSE.
                ls_tact-message = '没有可用的报表结果, 不能发起分析重试(重跑请提交新运行)'.
              ENDIF.
            WHEN OTHERS.
              ls_tact-message = |未支持的任务动作: { lv_tact }(白名单: VIEW/PAUSE/RESUME/REANALYZE)|.
          ENDCASE.
        ENDIF.
        copy_data_to_ref( EXPORTING is_data  = to_generic_odata( ls_tact )
                          CHANGING  cr_data  = er_data ).

      WHEN OTHERS.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            textid  = /iwbep/cx_mgw_busi_exception=>business_error
            message = |未知的函数导入: { iv_action_name }|.
    ENDCASE.

  ENDMETHOD.


  METHOD models_get_entityset.

    DATA: lt_models TYPE zcl_ai_chat_service=>tt_models.

    zcl_ai_chat_service=>get_models( IMPORTING et_models = lt_models ).

    LOOP AT lt_models INTO DATA(ls_model).
      APPEND VALUE #(
        modelid     = ls_model-model_id
        modelname   = ls_model-model_name
        modeldesc   = ls_model-model_desc
        modeltype   = ls_model-model_type
        endpointurl = ls_model-endpoint_url
        destination = ls_model-destination
        apimodel    = ls_model-api_model
        authtype    = ls_model-auth_type
        temperature = ls_model-temperature
        maxtokens   = ls_model-max_tokens
        timeoutsec  = ls_model-timeout_sec
        isactive    = ls_model-is_active
        skipsource  = ls_model-skip_source
        userhidesrc = ls_model-user_hide_src
        apikeyset   = ls_model-api_key_set
      ) TO et_entityset.
    ENDLOOP.

  ENDMETHOD.


  METHOD messages_get_entityset.

    DATA: lv_session TYPE string.

    DATA(lt_filter) = io_tech_request_context->get_filter( )->get_filter_select_options( ).
    LOOP AT lt_filter INTO DATA(ls_filter).
      IF to_upper( ls_filter-property ) = 'SESSIONID'.
        READ TABLE ls_filter-select_options INTO DATA(ls_so) INDEX 1.
        IF sy-subrc = 0.
          lv_session = ls_so-low.
        ENDIF.
      ENDIF.
    ENDLOOP.

    IF lv_session IS INITIAL.
      RETURN.   " 未传会话 ID 时返回空集(前端总是按会话查询)
    ENDIF.

    " V14 安全修复：消息查询必须校验会话归属，失败时返回空集。
    SELECT SINGLE session_id FROM zai_chat_sess
      WHERE session_id = @lv_session AND created_by = @sy-uname
      INTO @DATA(lv_owned_session).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    SELECT * FROM zai_chat_msg
      WHERE session_id = @lv_session
      ORDER BY msg_seq DESCENDING
      INTO TABLE @DATA(lt_msg)
      UP TO 200 ROWS.

    LOOP AT lt_msg INTO DATA(ls_msg).
      APPEND VALUE #(
        sessionid   = ls_msg-session_id
        msgseq      = ls_msg-msg_seq
        role        = ls_msg-role
        content     = ls_msg-content
        modelid     = ls_msg-model_id
        programname = ls_msg-program_name
        codelines   = CONV #( ls_msg-code_lines )
        elapsedms   = CONV #( ls_msg-elapsed_ms )
        createdat   = ls_msg-created_at
        status      = ls_msg-status
      ) TO et_entityset.
    ENDLOOP.

  ENDMETHOD.


  METHOD sessions_get_entityset.

    DATA: lt_sessions TYPE zcl_ai_chat_service=>tt_sessions,
          lv_mode     TYPE string,
          lv_search   TYPE string,
          lv_top      TYPE i,
          lv_skip     TYPE i.

    " V15.3(BE-09): 分页 + 模式过滤 + 标题搜索(都不传 = 前 100 条全部模式)
    "   $filter=Mode eq 'AGENT'  → 每个属性只取第一个条件的 low
    "   search=<关键字>           → iv_search_string(标题包含, 不区分大小写)
    LOOP AT it_filter_select_options ASSIGNING FIELD-SYMBOL(<ls_fso>).
      IF to_upper( <ls_fso>-property ) = 'MODE'.
        LOOP AT <ls_fso>-select_options ASSIGNING FIELD-SYMBOL(<ls_so>).
          lv_mode = <ls_so>-low.
          EXIT.
        ENDLOOP.
      ENDIF.
    ENDLOOP.
    lv_search = iv_search_string.
    lv_top    = is_paging-top.
    lv_skip   = is_paging-skip.

    zcl_ai_chat_service=>get_sessions(
      EXPORTING iv_mode     = lv_mode
                iv_search   = lv_search
                iv_top      = lv_top
                iv_skip     = lv_skip
      IMPORTING et_sessions = lt_sessions ).

    LOOP AT lt_sessions INTO DATA(ls_session).
      APPEND VALUE #(
        sessionid = ls_session-session_id
        title     = ls_session-title
        modelid   = ls_session-model_id
        msgcount  = ls_session-msg_count
        createdat = ls_session-created_at
        changedat = ls_session-changed_at
        pinned    = ls_session-pinned
        " V12: 对话/Agent 模式分离 —— 老数据 MODE 空按 CHAT 返回
        mode      = ls_session-mode
        agenttype = ls_session-agent_type
        status    = ls_session-status
      ) TO et_entityset.
    ENDLOOP.

  ENDMETHOD.


  METHOD sessions_delete_entity.

    DATA: lv_session TYPE string,
           ls_result  TYPE zcl_ai_chat_service=>ty_save_result.

    LOOP AT it_key_tab INTO DATA(ls_key).
      IF to_upper( ls_key-name ) = 'SESSIONID'.
        lv_session = ls_key-value.
      ENDIF.
    ENDLOOP.

    zcl_ai_chat_service=>delete_session(
      EXPORTING iv_session_id = lv_session
      IMPORTING es_result     = ls_result ).

    IF ls_result-success <> 'X'.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid = /iwbep/cx_mgw_busi_exception=>business_error.
    ENDIF.

  ENDMETHOD.


  METHOD agentcapabilitie_get_entityset.

    " V1.3.0: GET /AgentCapabilities —— 数据分析能力目录(计划 §5)。
    " 只读声明项: 实体/标签/维度/指标/操作/上限/权限; 前端仅用于
    " 即时提示与展示, 最终权限与白名单一律以后端校验为准。
    " SEGW: EntityType AgentCapability(属性全 Edm.String) + EntitySet
    " AgentCapabilities; 字段名与属性名的对应见本类头部说明。
    DATA: lt_cap    TYPE zcl_ai_data_analysis_service=>tt_capability,
          lv_csv    TYPE string,
          ls_row    LIKE LINE OF et_entityset.

    lt_cap = zcl_ai_data_analysis_service=>get_capabilities( ).

    LOOP AT lt_cap INTO DATA(ls_cap).
      CLEAR: ls_row, lv_csv.

      " 可分组维度 → CSV
      LOOP AT ls_cap-fields INTO DATA(ls_fld)
           WHERE dimension = abap_true.
        IF lv_csv IS INITIAL.
          lv_csv = ls_fld-name.
        ELSE.
          lv_csv = |{ lv_csv },{ ls_fld-name }|.
        ENDIF.
      ENDLOOP.

      ls_row-entity           = ls_cap-entity.
      ls_row-label            = ls_cap-label.
      ls_row-dimensions       = lv_csv.
      ls_row-metrics          = ls_cap-metrics.
      ls_row-operations       = ls_cap-operations.
      ls_row-maxrows          = CONV string( ls_cap-max_rows ).
      ls_row-timeoutsec       = CONV string( ls_cap-timeout_sec ).
      ls_row-permission       = ls_cap-permission.
      ls_row-sensitivefields  = ls_cap-sensitive_fields.

      APPEND ls_row TO et_entityset.
    ENDLOOP.

  ENDMETHOD.


  METHOD chattexts_create_entity.

    " V15.6: POST /ChatTexts —— 长文本通道(见类头)。正文在请求体里, 不受 URL 长度限制;
    " 返回 TextId, 前端再用 "@@ZAI_TEXT:<TextId>" 调 AnalyzeCode / AnalyzeAgent / AnalyzeTask。
    " SEGW: EntityType ChatText(TextId 键 / Content, 都是 Edm.String; ABAP 字段名 TEXTID / CONTENT)
    DATA: ls_in   TYPE zcl_zai_chat_mpc=>ts_chattext,
          ls_row  TYPE zai_chat_text,
          lv_yday TYPE d,
          lv_old  TYPE zai_chat_text-created_at.

    io_data_provider->read_entry_data( IMPORTING es_data = ls_in ).

    IF ls_in-content IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = '长文本内容为空'.
    ENDIF.
    IF strlen( ls_in-content ) > gc_text_max.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = |内容超过 { gc_text_max } 字符上限, 请分段发送|.
    ENDIF.

    " 顺手清掉本人一天前没用掉的(发送中途失败 / 关页面留下的)
    lv_yday = sy-datum - 1.
    lv_old  = |{ lv_yday }{ sy-uzeit }|.
    DELETE FROM zai_chat_text WHERE owner = @sy-uname AND created_at < @lv_old.

    TRY.
        ls_row-text_id = cl_system_uuid=>create_uuid_c32_static( ).
      CATCH cx_uuid_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            textid  = /iwbep/cx_mgw_busi_exception=>business_error
            message = '生成长文本编号失败'.
    ENDTRY.
    ls_row-owner      = sy-uname.
    ls_row-created_at = |{ sy-datum }{ sy-uzeit }|.
    ls_row-content    = ls_in-content.
    INSERT zai_chat_text FROM @ls_row.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = '长文本暂存失败(写 ZAI_CHAT_TEXT)'.
    ENDIF.
    " 下一个请求(AnalyzeCode 等)要读到它 —— 显式提交(本请求不在 $batch 里)
    COMMIT WORK.

    er_entity-textid = ls_row-text_id.   " 不回传正文

  ENDMETHOD.


  METHOD resolve_text.

    " V15.6: "@@ZAI_TEXT:<TextId>" → ChatTexts 暂存的原文。只认本人存的; 读到即删(一次性),
    " 删除随本次请求的 COMMIT WORK 一起提交(对话 / Agent 服务里都有)
    DATA(lv_id) = to_upper( condense( substring( val = iv_question off = strlen( gc_text_prefix ) ) ) ).

    SELECT SINGLE content FROM zai_chat_text
      WHERE text_id = @lv_id
        AND owner   = @sy-uname
      INTO @rv.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = |长文本 { lv_id } 不存在或已失效, 请重新发送|.
    ENDIF.

    DELETE FROM zai_chat_text WHERE text_id = @lv_id.

  ENDMETHOD.


  METHOD v8_param.
    LOOP AT it_parameter INTO DATA(ls_p).
      IF to_upper( ls_p-name ) = to_upper( iv_name ).
        rv = ls_p-value.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD to_agent_odata.

    " V15: AgentResult → 无下划线 OData 结构(踩坑清单 §2.3;
    " SEGW 属性名大写精确匹配, 不容忍下划线 —— 逐字段搬运)
    CLEAR rs.
    rs-sessionid         = is_agent-session_id.
    " V15.10: 思考过程放在回答前面(落库的回答不含思考)
    rs-answer            = zcl_ai_llm_client=>wrap_think( iv_reasoning = is_agent-reasoning
                                                          iv_answer    = is_agent-answer ).
    rs-status            = is_agent-status.
    rs-modelid           = is_agent-model_id.
    rs-rounds            = is_agent-rounds.
    rs-elapsedms         = is_agent-elapsed_ms.
    rs-tracejson         = is_agent-trace_json.
    rs-analysisjson      = is_agent-analysis_json.
    rs-message           = is_agent-message.
    " V15 任务层可选字段(SEGW 增属性前网关按 metadata 投影忽略)
    rs-taskid            = is_agent-task_id.
    rs-taskmodule        = is_agent-task_module.
    rs-taskstatus        = is_agent-task_status.
    rs-needsinput        = is_agent-needs_input.
    rs-pendingparamsjson = is_agent-pending_params_json.
    rs-artifactrefsjson  = is_agent-artifact_refs_json.

  ENDMETHOD.


  METHOD auth_reply.

    " V15.4: 失败 = Success 空 + Message 取 error; 成功 = Success X + Message 取一句话汇总。
    " ResultJson 始终带结构(失败时是空结构), compress=false 让 total=0 / 空数组也有键
    rs-success     = COND #( WHEN iv_error IS INITIAL THEN 'X' ELSE '' ).
    rs-message     = COND #( WHEN iv_error IS NOT INITIAL THEN iv_error ELSE iv_message ).
    rs-result_json = /ui2/cl_json=>serialize( data        = iv_data
                                              compress    = abap_false
                                              pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).

  ENDMETHOD.


  METHOD to_generic_odata.

    " V15: GenericResult → 无下划线 OData 结构(踩坑清单 §2.3)
    CLEAR rs.
    rs-success    = is_result-success.
    rs-message    = is_result-message.
    rs-resultjson = is_result-result_json.

  ENDMETHOD.

ENDCLASS.
