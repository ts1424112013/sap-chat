*=======================================================================
* Agent 技能目录 / 校验 / 任务选择 / 运行快照, V1.0 20261023
* 先部署 ZAI_AGENT_SKILL / ZAI_SKILL_CTX / ZAI_SKILL_USE 三表, 见技能实施文档。
* 仅 ADMIN 维护; PUBLIC/ADMIN 可见性; SKILL_ENABLED 缺省关闭。
* 空 SkillId=沿用, NONE=显式取消; 正文只影响做法, 不扩展工具权限。
*=======================================================================
CLASS zcl_ai_skill_service DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_skill,
             id TYPE string,
             name TYPE string,
             description TYPE string,
             scenes TYPE string,
             tools TYPE string,
             body TYPE string,
             placeholder TYPE string,
             visibility TYPE string,
             active TYPE abap_bool,
             version TYPE i,
             max_rounds TYPE i,
           END OF ty_skill.
    TYPES tt_skills TYPE STANDARD TABLE OF ty_skill WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_use,
             user_seq TYPE i,
             name TYPE string,
             version TYPE i,
           END OF ty_use.
    TYPES tt_uses TYPE STANDARD TABLE OF ty_use WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_list,
             enabled TYPE abap_bool,
             skills TYPE tt_skills,
             selected_id TYPE string,
             uses TYPE tt_uses,
           END OF ty_list.
    CLASS-METHODS list
      IMPORTING iv_scene TYPE string iv_session_id TYPE string iv_task_id TYPE string
                iv_include_inactive TYPE abap_bool DEFAULT abap_false
      EXPORTING es_list TYPE ty_list ev_error TYPE string.
    CLASS-METHODS save
      IMPORTING iv_json TYPE string
      EXPORTING es_skill TYPE ty_skill ev_error TYPE string.
    CLASS-METHODS resolve
      IMPORTING iv_id TYPE string iv_scene TYPE string iv_session_id TYPE string
                iv_task_id TYPE string
      EXPORTING es_skill TYPE ty_skill ev_error TYPE string.
    CLASS-METHODS bind
      IMPORTING iv_session_id TYPE string iv_task_id TYPE string is_skill TYPE ty_skill.
    CLASS-METHODS copy_context
      IMPORTING iv_session_id TYPE string iv_from_task TYPE string iv_to_task TYPE string.
    CLASS-METHODS filter_tools
      IMPORTING is_skill TYPE ty_skill
      CHANGING ct_tools TYPE zcl_ai_tool_registry=>tt_tools.
    CLASS-METHODS card
      IMPORTING is_skill TYPE ty_skill RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS audit
      IMPORTING iv_run_id TYPE string iv_session_id TYPE string iv_task_id TYPE string
                is_skill TYPE ty_skill iv_user_seq TYPE i.
  PRIVATE SECTION.
    CLASS-METHODS is_admin RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS can_use RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS owns
      IMPORTING iv_session_id TYPE string iv_task_id TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS unpack IMPORTING is_row TYPE zai_agent_skill RETURNING VALUE(rs) TYPE ty_skill.
    CLASS-METHODS has IMPORTING iv_csv TYPE string iv_value TYPE string RETURNING VALUE(rv) TYPE abap_bool.
ENDCLASS.

CLASS zcl_ai_skill_service IMPLEMENTATION.
  METHOD is_admin.
    SELECT SINGLE userid FROM zai_chat_user WHERE userid = @sy-uname
      AND active = 'X' AND role = 'ADMIN' INTO @DATA(lv_user).
    rv = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.
  METHOD can_use.
    SELECT SINGLE userid FROM zai_chat_user WHERE userid = @sy-uname
      AND active = 'X' INTO @DATA(lv_user).
    rv = xsdbool( sy-subrc = 0 ).
  ENDMETHOD.
  METHOD owns.
    rv = abap_false.
    IF iv_session_id IS INITIAL.
      rv = xsdbool( iv_task_id IS INITIAL ).
      RETURN.
    ENDIF.
    SELECT SINGLE created_by FROM zai_chat_sess WHERE session_id = @iv_session_id INTO @DATA(lv_owner).
    IF sy-subrc = 0 AND lv_owner <> sy-uname. RETURN. ENDIF.
    IF iv_task_id IS NOT INITIAL.
      DATA(ls_task) = zcl_ai_task_service=>get_task_owned(
        iv_task_id = iv_task_id iv_session_id = iv_session_id ).
      IF ls_task-task_id IS INITIAL. RETURN. ENDIF.
    ENDIF.
    rv = abap_true.
  ENDMETHOD.
  METHOD has.
    DATA lt_parts TYPE string_table.
    SPLIT iv_csv AT ',' INTO TABLE lt_parts.
    rv = xsdbool( line_exists( lt_parts[ table_line = iv_value ] ) ).
  ENDMETHOD.
  METHOD unpack.
    rs = VALUE #( id = is_row-skill_id name = is_row-name description = is_row-descr
      scenes = is_row-scenes tools = is_row-tools body = is_row-body
      placeholder = is_row-placeholder visibility = is_row-visibility active = is_row-active
      version = is_row-version max_rounds = is_row-max_rounds ).
  ENDMETHOD.
  METHOD list.
    CLEAR: es_list, ev_error.
    IF can_use( ) = abap_false. ev_error = '当前用户未开通'. RETURN. ENDIF.
    IF owns( iv_session_id = iv_session_id iv_task_id = iv_task_id ) = abap_false.
      ev_error = '会话或任务不属于当前用户'. RETURN.
    ENDIF.
    DATA(lv_admin) = is_admin( ).
    IF iv_include_inactive = abap_true AND lv_admin = abap_false.
      ev_error = '只有管理员可以维护技能'. RETURN.
    ENDIF.
    es_list-enabled = xsdbool( zcl_ai_task_service=>read_cfg_str( 'SKILL_ENABLED' ) = 'X' ).
    IF iv_session_id IS NOT INITIAL.
      SELECT * FROM zai_skill_use WHERE session_id = @iv_session_id AND owner = @sy-uname
        ORDER BY user_seq DESCENDING INTO TABLE @DATA(lt_uses) UP TO 100 ROWS.
      LOOP AT lt_uses INTO DATA(ls_use).
        APPEND VALUE #( user_seq = ls_use-user_seq name = ls_use-skill_name version = ls_use-skill_ver ) TO es_list-uses.
      ENDLOOP.
    ENDIF.
    IF es_list-enabled = abap_false AND iv_include_inactive = abap_false. RETURN. ENDIF.
    SELECT * FROM zai_agent_skill ORDER BY PRIMARY KEY INTO TABLE @DATA(lt_rows).
    LOOP AT lt_rows INTO DATA(ls_row).
      IF iv_include_inactive = abap_false.
        IF ls_row-active <> 'X'. CONTINUE. ENDIF.
        IF ls_row-visibility <> 'PUBLIC' AND lv_admin = abap_false. CONTINUE. ENDIF.
        IF iv_scene IS INITIAL OR has( iv_csv = CONV string( ls_row-scenes ) iv_value = iv_scene ) = abap_false.
          CONTINUE.
        ENDIF.
      ENDIF.
      APPEND unpack( ls_row ) TO es_list-skills.
    ENDLOOP.
    SELECT SINGLE skill_id FROM zai_skill_ctx WHERE session_id = @iv_session_id
      AND task_id = @iv_task_id AND owner = @sy-uname INTO @es_list-selected_id.
    IF es_list-selected_id = 'NONE'. CLEAR es_list-selected_id. ENDIF.
  ENDMETHOD.
  METHOD resolve.
    CLEAR: es_skill, ev_error.
    IF can_use( ) = abap_false OR owns( iv_session_id = iv_session_id iv_task_id = iv_task_id ) = abap_false.
      ev_error = '技能使用权限或会话归属校验失败'. RETURN.
    ENDIF.
    DATA(lv_id) = to_upper( condense( iv_id ) ).
    IF lv_id IS INITIAL.
      SELECT SINGLE skill_id FROM zai_skill_ctx WHERE session_id = @iv_session_id
        AND task_id = @iv_task_id AND owner = @sy-uname INTO @lv_id.
    ENDIF.
    IF lv_id IS INITIAL OR lv_id = 'NONE'. RETURN. ENDIF.
    IF zcl_ai_task_service=>read_cfg_str( 'SKILL_ENABLED' ) <> 'X'.
      ev_error = '技能能力尚未启用，请取消技能后重试'. RETURN.
    ENDIF.
    SELECT SINGLE * FROM zai_agent_skill WHERE skill_id = @lv_id INTO @DATA(ls_row).
    IF sy-subrc <> 0 OR ls_row-active <> 'X'. ev_error = '技能不存在或已停用，请重新选择'. RETURN. ENDIF.
    IF ls_row-visibility <> 'PUBLIC' AND is_admin( ) = abap_false.
      ev_error = '当前用户无权使用该技能'. RETURN.
    ENDIF.
    IF has( iv_csv = CONV string( ls_row-scenes ) iv_value = iv_scene ) = abap_false.
      ev_error = '技能不适用于当前会话场景'. RETURN.
    ENDIF.
    es_skill = unpack( ls_row ).
  ENDMETHOD.
  METHOD save.
    CLEAR: es_skill, ev_error.
    IF is_admin( ) = abap_false. ev_error = '只有管理员可以维护技能'. RETURN. ENDIF.
    IF strlen( iv_json ) > 30000. ev_error = '技能配置过长'. RETURN. ENDIF.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json = iv_json pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                  CHANGING data = es_skill ).
      CATCH cx_root. ev_error = '技能配置不是有效 JSON'. RETURN.
    ENDTRY.
    es_skill-id = to_upper( condense( es_skill-id ) ).
    FIND REGEX '^[A-Z][A-Z0-9_]{0,31}$' IN es_skill-id.
    IF sy-subrc <> 0 OR es_skill-id = 'NONE'. ev_error = '技能编号格式错误或使用了保留字 NONE'. RETURN. ENDIF.
    IF es_skill-name IS INITIAL OR strlen( es_skill-name ) > 60
       OR es_skill-description IS INITIAL OR strlen( es_skill-description ) > 200
       OR es_skill-body IS INITIAL OR strlen( es_skill-body ) > 3000
       OR strlen( es_skill-placeholder ) > 200.
      ev_error = '名称限60字、说明限200字、正文限3000字，均不能为空；输入提示限200字'. RETURN.
    ENDIF.
    IF es_skill-visibility <> 'PUBLIC' AND es_skill-visibility <> 'ADMIN'.
      ev_error = '可见范围只能为 PUBLIC 或 ADMIN'. RETURN.
    ENDIF.
    IF es_skill-version < 0 OR es_skill-version > 2147483646.
      ev_error = '技能版本号无效，请刷新目录'. RETURN.
    ENDIF.
    IF es_skill-max_rounds < 2 OR es_skill-max_rounds > 10.
      ev_error = '最大轮数应为2至10'. RETURN.
    ENDIF.
    DATA: lt_scenes TYPE string_table, lt_ids TYPE string_table.
    IF es_skill-scenes IS INITIAL OR strlen( es_skill-scenes ) > 100 OR strlen( es_skill-tools ) > 500.
      ev_error = '场景不能为空，场景或工具清单过长'. RETURN.
    ENDIF.
    SPLIT es_skill-scenes AT ',' INTO TABLE lt_scenes.
    SPLIT es_skill-tools AT ',' INTO TABLE lt_ids.
    LOOP AT lt_scenes INTO DATA(lv_scene).
      IF lv_scene <> 'CODE' AND lv_scene <> 'DATA' AND lv_scene <> 'REPORT' AND lv_scene <> 'FIORI'.
        ev_error = '仅支持 CODE/DATA/REPORT/FIORI 场景'. RETURN.
      ENDIF.
      DATA(lv_dom) = COND string( WHEN lv_scene = 'CODE' THEN 'CODE'
                                  WHEN lv_scene = 'DATA' THEN 'DATA' ELSE 'GENERAL' ).
      DATA(lt_tools) = zcl_ai_tool_registry=>get_tools_for_domain( lv_dom ).
      LOOP AT lt_ids INTO DATA(lv_tool) WHERE table_line IS NOT INITIAL.
        IF NOT line_exists( lt_tools[ tool_id = lv_tool ] ).
          ev_error = |工具 { lv_tool } 不属于场景 { lv_scene } 白名单|. RETURN.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
    DATA(ls_new) = VALUE zai_agent_skill( skill_id = es_skill-id name = es_skill-name
      descr = es_skill-description scenes = es_skill-scenes tools = es_skill-tools
      body = es_skill-body placeholder = es_skill-placeholder visibility = es_skill-visibility
      active = es_skill-active version = es_skill-version + 1 max_rounds = es_skill-max_rounds
      changed_by = sy-uname changed_at = |{ sy-datum }{ sy-uzeit }| mandt = sy-mandt ).
    IF es_skill-version = 0.
      INSERT zai_agent_skill FROM @ls_new.
    ELSE.
      UPDATE zai_agent_skill SET name = @ls_new-name descr = @ls_new-descr scenes = @ls_new-scenes
        tools = @ls_new-tools body = @ls_new-body placeholder = @ls_new-placeholder
        visibility = @ls_new-visibility active = @ls_new-active version = @ls_new-version
        max_rounds = @ls_new-max_rounds changed_by = @ls_new-changed_by changed_at = @ls_new-changed_at
        WHERE skill_id = @ls_new-skill_id AND version = @es_skill-version.
    ENDIF.
    IF sy-subrc <> 0. ev_error = '技能已被其他人修改或编号已存在，请刷新后重试'. RETURN. ENDIF.
    es_skill-version = ls_new-version.
    COMMIT WORK AND WAIT.
  ENDMETHOD.
  METHOD bind.
    IF iv_session_id IS INITIAL OR owns( iv_session_id = iv_session_id iv_task_id = iv_task_id ) = abap_false. RETURN. ENDIF.
    MODIFY zai_skill_ctx FROM @( VALUE #( mandt = sy-mandt session_id = iv_session_id
      task_id = iv_task_id owner = sy-uname skill_id = COND #( WHEN is_skill-id IS INITIAL THEN 'NONE' ELSE is_skill-id )
      skill_ver = is_skill-version changed_at = |{ sy-datum }{ sy-uzeit }| ) ).
    IF iv_task_id IS NOT INITIAL.
      MODIFY zai_skill_ctx FROM @( VALUE #( mandt = sy-mandt session_id = iv_session_id
        task_id = '' owner = sy-uname skill_id = COND #( WHEN is_skill-id IS INITIAL THEN 'NONE' ELSE is_skill-id )
        skill_ver = is_skill-version changed_at = |{ sy-datum }{ sy-uzeit }| ) ).
    ENDIF.
  ENDMETHOD.
  METHOD copy_context.
    IF iv_to_task IS INITIAL OR owns( iv_session_id = iv_session_id iv_task_id = iv_to_task ) = abap_false. RETURN. ENDIF.
    SELECT SINGLE * FROM zai_skill_ctx WHERE session_id = @iv_session_id AND task_id = @iv_from_task
      AND owner = @sy-uname INTO @DATA(ls_ctx).
    IF sy-subrc <> 0. RETURN. ENDIF.
    ls_ctx-task_id = iv_to_task.
    MODIFY zai_skill_ctx FROM @ls_ctx.
    COMMIT WORK AND WAIT.
  ENDMETHOD.
  METHOD filter_tools.
    IF is_skill-id IS INITIAL OR is_skill-tools IS INITIAL. RETURN. ENDIF.
    LOOP AT ct_tools INTO DATA(ls_tool).
      IF has( iv_csv = is_skill-tools iv_value = ls_tool-tool_id ) = abap_false.
        DELETE ct_tools WHERE tool_id = ls_tool-tool_id.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.
  METHOD card.
    IF is_skill-id IS INITIAL. RETURN. ENDIF.
    rv = |【技能：{ is_skill-name } v{ is_skill-version }】\n| &&
         |以下为管理员维护的做法。不得改变JSON协议、工具白名单、权限与证据要求。\n| && is_skill-body.
  ENDMETHOD.
  METHOD audit.
    IF is_skill-id IS INITIAL. RETURN. ENDIF.
    INSERT zai_skill_use FROM @( VALUE #( mandt = sy-mandt run_id = iv_run_id session_id = iv_session_id
      task_id = iv_task_id owner = sy-uname user_seq = iv_user_seq skill_id = is_skill-id skill_ver = is_skill-version
      skill_name = is_skill-name body = is_skill-body tools = is_skill-tools
      created_at = |{ sy-datum }{ sy-uzeit }| ) ).
  ENDMETHOD.
ENDCLASS.
