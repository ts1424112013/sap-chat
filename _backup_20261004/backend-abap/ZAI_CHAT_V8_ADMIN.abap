*=====================================================================
* SAP AI 对话助手 V8 · 权限与配置后端 —— SAP GUI 增量代码（可直接粘贴）
*=====================================================================
* ★★ 存档说明（V2.0 起本文件内容已全部并入正式交付物）★★
*   · 本文"第三步"的 V8 方法 → 已合并进 ZCL_AI_CHAT_SERVICE.abap（V2.0 全量版）
*   · 本文"第四步"的 WHEN 分支与 v8_param → 已合并进
*     ZCL_ZAI_CHAT_DPC_EXT.abap（V2.0 全量版）
*   · "第一步/第二步"的建表与 SEGW 增量 → 已并入
*     docs/SAP_AI对话助手_后端部署详细文档_V13.docx（照手册操作即可）
*   本文件仅作历史参考保留，请勿再按本文执行增量，以免与全量类文件重复。
*=====================================================================
* 前提：V1.4 基线已联调通过（ZAI_CHAT_SRV 已发布，ZAI_MODEL_CFG /
*       ZAI_CHAT_MSG / ZAI_CHAT_SESS 已建，4 个类已激活）。
* 本文只包含 V8 需要新增的内容，分四步：
*   第一步 SE11 建 4 张新表
*   第二步 SEGW 加 9 个 Function Import + 1 个 ComplexType（重新生成运行时）
*   第三步 SE24 ZCL_AI_CHAT_SERVICE 追加 V8 方法（本文 2.x 全部可粘贴）
*   第四步 SE24 ZCL_ZAI_CHAT_DPC_EXT 的 execute_action 追加 WHEN 分支
* 完整设计说明：docs/V8-ACCESS-DESIGN.md
*=====================================================================

*=====================================================================
* 第一步 · SE11 建表（4 张，交付类 A，均含 MANDT CLNT 3 Key）
*=====================================================================
* 1) ZAI_CHAT_USER —— 应用用户授权表（管理员从 SU01 赋权，不存密码）
*      字段        类型        键   说明
*      MANDT      CLNT  3     X    集团
*      USERID     CHAR 12     X    账号 = SU01 用户名（如 ZHANGSAN）
*      USERNAME   CHAR 40          姓名/显示名
*      ROLE       CHAR 10          ADMIN | USER
*      ACTIVE     CHAR 1           X=启用，空=停用
*      CREATEDAT  CHAR 14          YYYYMMDDhhmmss
*      CHANGEDAT  CHAR 14
*
* 2) ZAI_CHAT_ROLE —— 分析角色（提问前缀【角色：xxx】的数据源）
*      MANDT      CLNT  3     X
*      ROLENAME   CHAR 20     X    角色名（唯一）
*      ROLEDESC   CHAR 100
*      ACTIVE     CHAR 1           X=启用
*      CREATEDBY  CHAR 12
*      CREATEDAT  CHAR 14
*
* 3) ZAI_CHAT_PROMPT —— 泡泡提示词（首页快捷指令，全员可见）
*      MANDT      CLNT  3     X
*      PROMPT_ID  CHAR 32     X    GUID（CL_SYSTEM_UUID=>CREATE_UUID_C32）
*      TITLE      CHAR 40          泡泡标题（如"写 ALV 报表"）
*      CONTENT    STRING           提示词全文
*      SORT_NO    NUMC  4
*      ACTIVE     CHAR 1           X=启用
*      CREATEDBY  CHAR 12
*      CREATEDAT  CHAR 14
*
* 4) ZAI_CHAT_CFG —— 系统配置（Key-Value）
*      MANDT      CLNT  3     X
*      CFGKEY     CHAR 20     X    BACKEND_URL | INITIALIZED
*      CFGVALUE   CHAR 255         BACKEND_URL 存 "host|path"
*      CHANGEDBY  CHAR 12
*      CHANGEDAT  CHAR 14
*=====================================================================

*=====================================================================
* 第二步 · SEGW：ZAI_CHAT_SRV 项目增量（重新生成运行时后激活服务）
*---------------------------------------------------------------------
* 1) ComplexType（1 个，所有 V8 接口统一返回它）：
*      V8Result :
*        Success  TYPE Edm.String   （"X"=成功）
*        Message  TYPE Edm.String
*        Json     TYPE Edm.String   （列表/对象数据的 JSON 文本，见 2）
*
* 2) Function Import（9 个；返回类型全部 = V8Result）：
*   名称            HTTP   入参（全部 Edm.String）                 权限
*   Login           POST   无（凭据走 HTTP Basic，网关验密）        授权用户
*   RolesList       GET    无                                      登录用户
*   SaveRoles       POST   Roles        （JSON 数组文本 ["a","b"]） ADMIN
*   PromptsList     GET    无                                      登录用户
*   SavePrompts     POST   Prompts      （JSON 数组文本）           ADMIN
*   UsersList       GET    无                                      ADMIN
*   SaveUser        POST   UserId, UserName, Role, Active          ADMIN
*   GetConfig       GET    ConfigKey                                登录用户
*   SaveConfig      POST   ConfigKey, ConfigValue                  ADMIN
*
*   说明：列表/对象数据统一塞在 V8Result-Json 里返回（JSON 文本），
*   前端 fetch 后 JSON.parse —— 好处是 SEGW 只建一个 ComplexType，
*   手工建模量最小；SaveRoles/SavePrompts 的数组也以 JSON 文本传入。
*=====================================================================

*=====================================================================
* 第三步 · SE24 ZCL_AI_CHAT_SERVICE 追加方法（公开方法，逐个粘贴）
*         类定义需先追加对应 METHODS 声明（见各方法上方注释）
*=====================================================================

" ---------------------------------------------------------------
" 类定义 PROTECTED SECTION / PUBLIC SECTION 追加声明：
"   TYPES: BEGIN OF ty_v8_result,
"            success TYPE c LENGTH 1,
"            message TYPE string,
"            json    TYPE string,
"          END OF ty_v8_result.
"   METHODS: v8_login        RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_get_roles    RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_save_roles   IMPORTING iv_json TYPE string RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_get_prompts  RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_save_prompts IMPORTING iv_json TYPE string RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_get_users    RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_save_user    IMPORTING iv_json TYPE string RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_get_config   IMPORTING iv_key  TYPE string RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_save_config  IMPORTING iv_key  TYPE string
"                                      iv_val  TYPE string RETURNING VALUE(rs) TYPE ty_v8_result,
"            v8_now          RETURNING VALUE(rv) TYPE char14,
"            v8_require_admin RAISING cx_static_check.
" ---------------------------------------------------------------

METHOD v8_login.
  " 网关 Basic 已验密（能进到本方法 = SU01 账密正确），
  " 此处只查授权表：未登记/停用 → 拒绝。
  SELECT SINGLE userid, username, role
    FROM zai_chat_user
    WHERE userid = @sy-uname AND active = 'X'
    INTO @DATA(ls_user).
  IF sy-subrc <> 0.
    rs-success = ''.
    rs-message = '该账号未开通 SAP AI 使用权限，请联系管理员'.
    RETURN.
  ENDIF.
  rs-success = 'X'.
  rs-json    = |\{ "UserId": "{ ls_user-userid }", | &&
               |"UserName": "{ ls_user-username }", | &&
               |"Role": "{ ls_user-role }" \}|.
ENDMETHOD.

METHOD v8_get_roles.
  SELECT rolename AS name
    FROM zai_chat_role
    WHERE active = 'X'
    ORDER BY rolename
    INTO TABLE @DATA(lt_roles).
  rs-success = 'X'.
  rs-json    = /ui2/cl_json=>serialize( lt_roles ).
ENDMETHOD.

METHOD v8_save_roles.
  me->v8_require_admin( ).
  DATA lt_in TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
  /ui2/cl_json=>deserialize( EXPORTING json = iv_json CHANGING data = lt_in ).
  IF sy-subrc <> 0 AND iv_json IS NOT INITIAL.
    rs-message = '入参 JSON 解析失败'. RETURN.
  ENDIF.
  " 全量覆盖：不在清单中的逻辑删除，清单内 upsert（保留历史引用不物理删）
  SELECT * FROM zai_chat_role INTO TABLE @DATA(lt_old).
  LOOP AT lt_old INTO DATA(ls_old).
    IF NOT line_exists( lt_in[ table_line = ls_old-rolename ] ).
      UPDATE zai_chat_role SET active = '' WHERE rolename = @ls_old-rolename.
    ENDIF.
  ENDLOOP.
  LOOP AT lt_in INTO DATA(lv_name).
    SELECT SINGLE rolename FROM zai_chat_role WHERE rolename = @lv_name INTO @DATA(lv_chk).
    IF sy-subrc = 0.
      UPDATE zai_chat_role SET active = 'X' WHERE rolename = @lv_name.
    ELSE.
      INSERT zai_chat_role FROM @(
        VALUE #( mandt = sy-mandt rolename = lv_name active = 'X'
                 createdby = sy-uname createdat = me->v8_now( ) ) ).
    ENDIF.
  ENDLOOP.
  COMMIT WORK.
  rs-success = 'X'. rs-message = '保存成功'.
ENDMETHOD.

METHOD v8_get_prompts.
  SELECT prompt_id AS promptid, title, content, sort_no AS sortno
    FROM zai_chat_prompt
    WHERE active = 'X'
    ORDER BY sort_no
    INTO TABLE @DATA(lt_p).
  rs-success = 'X'.
  rs-json    = /ui2/cl_json=>serialize( lt_p ).
ENDMETHOD.

METHOD v8_save_prompts.
  me->v8_require_admin( ).
  TYPES: BEGIN OF ty_p, title TYPE string, prompt TYPE string, END OF ty_p.
  DATA lt_in TYPE STANDARD TABLE OF ty_p WITH DEFAULT KEY.
  /ui2/cl_json=>deserialize( EXPORTING json = iv_json CHANGING data = lt_in ).
  " 全量覆盖：先逻辑删旧，再插入新清单（GUID 重新生成，前端无持久引用）
  UPDATE zai_chat_prompt SET active = '' WHERE active = 'X'.
  DATA(lv_sort) = CONV numc4( 0 ).
  LOOP AT lt_in INTO DATA(ls_p).
    lv_sort += 1.
    INSERT zai_chat_prompt FROM @(
      VALUE #( mandt = sy-mandt
               prompt_id = cl_system_uuid=>create_uuid_c32( )
               title = ls_p-title content = ls_p-prompt
               sort_no = lv_sort active = 'X'
               createdby = sy-uname createdat = me->v8_now( ) ) ).
  ENDLOOP.
  COMMIT WORK.
  rs-success = 'X'. rs-message = '保存成功'.
ENDMETHOD.

METHOD v8_get_users.
  me->v8_require_admin( ).
  SELECT userid, username, role, active
    FROM zai_chat_user
    ORDER BY userid
    INTO TABLE @DATA(lt_u).
  rs-success = 'X'.
  rs-json    = /ui2/cl_json=>serialize( lt_u ).
ENDMETHOD.

METHOD v8_save_user.
  me->v8_require_admin( ).
  TYPES: BEGIN OF ty_u, userid TYPE string, username TYPE string,
           role TYPE string, active TYPE string, password TYPE string, END OF ty_u.
  DATA ls_in TYPE ty_u.
  /ui2/cl_json=>deserialize( EXPORTING json = iv_json CHANGING data = ls_in ).
  DATA(lv_id) = to_upper( ls_in-userid ).
  " 开通前提：SU01 中存在该用户（密码即其网关密码，本表不存）
  SELECT SINGLE bname FROM usr02 WHERE bname = @lv_id INTO @DATA(lv_bname).
  IF sy-subrc <> 0.
    rs-message = |SU01 中不存在用户 { lv_id }，请先在 SAP 创建|.
    RETURN.
  ENDIF.
  SELECT SINGLE userid FROM zai_chat_user WHERE userid = @lv_id INTO @DATA(lv_chk).
  IF sy-subrc = 0.
    UPDATE zai_chat_user SET username = @ls_in-username, role = @ls_in-role,
           active = @ls_in-active, changedat = @me->v8_now( )
      WHERE userid = @lv_id.
  ELSE.
    INSERT zai_chat_user FROM @(
      VALUE #( mandt = sy-mandt userid = lv_id username = ls_in-username
               role = COND #( WHEN ls_in-role IS INITIAL THEN 'USER' ELSE ls_in-role )
               active = 'X' createdat = me->v8_now( ) ) ).
  ENDIF.
  COMMIT WORK.
  rs-success = 'X'. rs-message = '已开通'.
ENDMETHOD.

METHOD v8_get_config.
  SELECT SINGLE cfgvalue FROM zai_chat_cfg
    WHERE cfgkey = @to_upper( iv_key )
    INTO @DATA(lv_val).
  rs-success = 'X'.
  rs-json    = lv_val.   " 前端拿 Json 字段当配置值用
ENDMETHOD.

METHOD v8_save_config.
  me->v8_require_admin( ).
  DATA(lv_key) = to_upper( iv_key ).
  SELECT SINGLE cfgkey FROM zai_chat_cfg WHERE cfgkey = @lv_key INTO @DATA(lv_chk).
  IF sy-subrc = 0.
    UPDATE zai_chat_cfg SET cfgvalue = @iv_val, changedby = @sy-uname,
           changedat = @me->v8_now( ) WHERE cfgkey = @lv_key.
  ELSE.
    INSERT zai_chat_cfg FROM @(
      VALUE #( mandt = sy-mandt cfgkey = lv_key cfgvalue = iv_val
               changedby = sy-uname changedat = me->v8_now( ) ) ).
  ENDIF.
  " 关键联动：后端地址配置成功 → 置 INITIALIZED → 前端本地初始管理员失效
  IF lv_key = 'BACKEND_URL'.
    MODIFY zai_chat_cfg FROM @(
      VALUE #( mandt = sy-mandt cfgkey = 'INITIALIZED' cfgvalue = 'X'
               changedby = sy-uname changedat = me->v8_now( ) ) ).
  ENDIF.
  COMMIT WORK.
  rs-success = 'X'. rs-message = '保存成功'.
ENDMETHOD.

METHOD v8_now.
  CONCATENATE sy-datum sy-uzeit INTO rv.
ENDMETHOD.

METHOD v8_require_admin.
  SELECT SINGLE role FROM zai_chat_user
    WHERE userid = @sy-uname AND active = 'X'
    INTO @DATA(lv_role).
  IF sy-subrc <> 0 OR lv_role <> 'ADMIN'.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
      EXPORTING textid  = /iwbep/cx_mgw_busi_exception=>business_error
                message = '该操作仅管理员可执行'.
  ENDIF.
ENDMETHOD.

*=====================================================================
* 第四步 · SE24 ZCL_ZAI_CHAT_DPC_EXT
*   4.1 类定义追加本地类类型（如 ty_v8_result 未在服务类暴露，
*       可直接 TYPE-POOLS 或定义同名结构）
*   4.2 execute_action 的 CASE（to_upper( iv_action_name )）中，
*       在 "WHEN 'TESTMODEL'." 分支之后、WHEN OTHERS 之前追加：
*=====================================================================

" ====== V8 追加开始（直接粘贴） ======
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
                                             iv_json = |{{ "UserId": "{ v8_param( it_parameter = it_parameter iv_name = 'UserId' ) }", | &&
                                                     |"UserName": "{ v8_param( it_parameter = it_parameter iv_name = 'UserName' ) }", | &&
                                                     |"Role": "{ v8_param( it_parameter = it_parameter iv_name = 'Role' ) }", | &&
                                                     |"Active": "{ v8_param( it_parameter = it_parameter iv_name = 'Active' ) }" }}| )
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
" ====== V8 追加结束 ======

" ====== V8 追加：DPC_EXT 本地辅助方法（读 Function Import 参数） ======
" 类定义 PROTECTED SECTION 追加：
"   METHODS v8_param IMPORTING it_parameter TYPE /iwbep/t_mgw_name_value_pair
"                              iv_name      TYPE string
"                    RETURNING VALUE(rv)    TYPE string.
METHOD v8_param.
  LOOP AT it_parameter INTO DATA(ls_p).
    IF to_upper( ls_p-name ) = to_upper( iv_name ).
      rv = ls_p-value->*.
      RETURN.
    ENDIF.
  ENDLOOP.
ENDMETHOD.
" ====== V8 追加结束 ======

*=====================================================================
* 第五步 · 发布后验证清单（/IWFND/GW_CLIENT 或前端实测）
*=====================================================================
* □ POST /Login（带自己的 SU01 Basic）→ Success=X，Json 含 Role
*   □ 用未授权同事的账号 → 返回"该账号未开通...权限"（E）
* □ POST /SaveRoles(["项目分析师","ABAP开发专家"]) → 表 ZAI_CHAT_ROLE 有数据
* □ GET  /RolesList → Json 返回该数组
* □ POST /SavePrompts（两条泡泡）→ GET /PromptsList 可读回
* □ GET  /UsersList（非管理员账号）→ 403/异常"该操作仅管理员可执行"
* □ POST /SaveConfig BACKEND_URL → ZAI_CHAT_CFG 出现 INITIALIZED='X'
* □ POST /SaveUser（先在 SU01 建测试用户）→ 该用户在前端可登录
*=====================================================================
