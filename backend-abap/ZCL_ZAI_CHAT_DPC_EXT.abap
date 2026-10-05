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
*         6) AGENTCAPABILITIES_GET_ENTITYSET - GET /AgentCapabilities
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
    METHODS agentcapabilities_get_entityset REDEFINITION.

    " V2.0: 读取 Function Import 的指定参数(大小写不敏感, 未传返回空)
    METHODS v8_param
      IMPORTING it_parameter TYPE /iwbep/t_mgw_name_value_pair
                iv_name      TYPE string
      RETURNING VALUE(rv)    TYPE string.

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

    CASE to_upper( iv_action_name ).

      WHEN 'ANALYZECODE'.
        DATA: ls_result TYPE zcl_ai_chat_service=>ty_analyze_result.

        zcl_ai_chat_service=>analyze(
          EXPORTING iv_session_id   = lv_session
                    iv_question     = lv_question
                    iv_model_id     = lv_model
                    iv_program_name = lv_prog
          IMPORTING es_result       = ls_result ).

        copy_data_to_ref( EXPORTING is_data  = ls_result
                          CHANGING  cr_data  = er_data ).

      WHEN 'ANALYZEAGENT'.
        " Agent V1.0: 库存分析受限工具循环(与普通聊天路径完全分离;
        " 参数 SessionId/Question/ModelId 与 AnalyzeCode 同名复用上方解析)
        DATA: ls_agent TYPE zcl_ai_agent_service=>ty_agent_result.

        zcl_ai_agent_service=>analyze_agent(
          EXPORTING iv_session_id = lv_session
                    iv_question   = lv_question
                    iv_model_id   = lv_model
          IMPORTING es_result     = ls_agent ).

        copy_data_to_ref( EXPORTING is_data  = ls_agent
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

    DATA: lt_sessions TYPE zcl_ai_chat_service=>tt_sessions.

    zcl_ai_chat_service=>get_sessions( IMPORTING et_sessions = lt_sessions ).

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


  METHOD agentcapabilities_get_entityset.

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


  METHOD v8_param.
    LOOP AT it_parameter INTO DATA(ls_p).
      IF to_upper( ls_p-name ) = to_upper( iv_name ).
        rv = ls_p-value.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
