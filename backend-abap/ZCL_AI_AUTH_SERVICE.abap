*=======================================================================
* 对象:   ZCL_AI_AUTH_SERVICE
* 用途:   事务码权限自助申请(设计: 功能计划书/权限自助申请/01-方案与开发计划_V1.4)
*         用户给自己申请; IT 批量代加 / 审批 / 撤销; 权限表与字段映射可配置,
*         事务码按"规则"或"自动发现"落到对应的权限表。
* V1.0 20261020: 按设计重写(取代未提交的初稿 —— 初稿是一个 execute 入口 +
*         实例状态, 把"保存表/规则"也写成假申请行放进申请表)。本版:
*   · 每个操作一个带类型返回值的公开方法; 参数由 DPC 取、结果由 DPC 序列化
*   · 失败由返回结构的 error 字段给出, 不用实例状态
*   · 状态变化记在申请行自己(STATUS / DECIDED_BY / DECIDED_AT / MESSAGE);
*     配置变更记在表 / 规则的 CHANGED_BY / CHANGED_AT
*   · BLOCK 只禁止"自助申请", IT 批量代加不受限
*   · 目标权限表的读写只在 row_exists / grant_row / revoke_row 三处
*   · 字段名只来自 DDIC 且再过字符集校验, 值一律加引号转义(quote),
*     值超长拒绝而不是截断; 映射只允许 CHAR / NUMC / DATS / TIMS 字段
* 依赖:   SE11 表 ZAI_AUTH_TAB / ZAI_AUTH_FMAP / ZAI_AUTH_RULE / ZAI_AUTH_REQ /
*         ZAI_AUTH_RMAP(V1.2 新建, 规则自己的字段映射);
*         ZCL_AI_CHAT_SERVICE=>v8_get_role; ZCL_AI_TASK_SERVICE=>read_cfg_str;
*         配置键 ZAI_CHAT_CFG.AUTH_ENABLED —— 关闭时只拒绝"会写权限表"的操作
*         (申请 / 批量代加 / 审批 / 撤销)和普通用户查记录; 表 / 规则配置与 ADMIN
*         查记录照常, 这样可以先配好再打开(部署清单的上线顺序)
*   · 工厂映射可选: 没有工厂列的权限表也能登记; 写这种表时不论申请了几个
*     工厂只写一行(记录里工厂留空)
* V1.1 20261022: 映射约束放宽 —— 有的权限表几个字段要填同一个值(如两列都放账号)。
*   USER 至少一个(原来必须正好一个), WERKS / TCODE 不限个数; 同类映射的字段写入同一个值,
*   查重 / 撤销按全部这些字段一起比对(build_row / build_where 本来就逐字段处理);
*   自动发现在任一 TCODE 列里找到事务码就算(tcode_known 原来只看第一个 TCODE 列)
* V1.2 20261023: 事务码规则可带自己的字段映射(新表 ZAI_AUTH_RMAP, 键 TCODE_PAT + FIELDNAME)
*   —— 同一张权限表, 不同事务码可能要把工厂 / 账号写进不同的列(或多写一列)。
*   · 选用: 命中规则、规则指定了权限表、且该规则有自己的映射 → 用规则映射; 其余一律用
*     权限表映射(无规则 / 规则没配 / 规则不指定表走自动发现), 旧规则行为不变
*   · 规则映射是"整份"(每个字段都有), 约束同权限表(check_fmap 共用), 但不要求 TCODE;
*     表结构新增字段而规则映射没跟上 → 该规则的申请报"请 IT 重新保存该规则"
*   · 申请 / 批量代加在 find_tables 套用; 审批按当前配置重新选(decide 里 find_rule);
*     查重按选中映射比对; 撤销仍按 KEY_JSON 原始主键, 与映射无关; 自动发现不变
*   · save_rule 新增可选参数 iv_fmap_json(空 = 沿用权限表映射并清掉本规则映射);
*     删除规则一并删映射; get_config 的规则带 own_map / fields
* V1.3 20261024(10.24 记录 #00a): 审批卡显示申请人姓名 / 部门 —— 申请记录(ty_request)新增
*   target_name / target_dept, list_requests 末尾经新私有方法 fill_user_info 按账号查 USER_ADDR
*   (BNAME → NAME_TEXTC / DEPARTMENT)补齐; DPC 不用改(整个结构 camelCase 输出 targetName / targetDept)。
*   字段列表写成动态(SELECT (lv_cols) FROM user_addr), 万一字段名与系统不符只是查不到(留空、
*   前端只显示账号), 不会让整个类激活失败; 只读 USER_ADDR, 不碰任何权限表
* V1.4 20261027: 字段映射新增 RANDOM, 按字段长度逐字符生成(CHAR 大写字母/数字,
*   NUMC 纯数字); 权限表与规则共用校验, DATS/TIMS 不支持; 随机值不参与业务查重,
*   撤销沿用授权时的原始主键; 随机主键碰撞报错, 不误报已有权限。
* V1.5 20261027(10.27 记录 #02): 生成型填值再加两种, 与 RANDOM 并列, 不改表(类型存
*   MAP_TYPE CHAR 10, 参数存 CONST_VAL CHAR 60):
*   · SEQ 递增序号: CONST_VAL = 起始值(只填数字, 位数即补零位数, 如 0001); 空 = 从 1
*     开始、位数 = 字段长度(最多 10 位)。值 = 该列现有同格式值的最大值 + 1(只读查目标表,
*     METHOD seq_max), 批量代加逐行写入, 后一行能看到前一行
*   · RULE 按规则组合: CONST_VAL = 规则串, 文字原样 + 占位 {SEQn} n 位递增(同前缀内)、
*     {RANDn} n 位随机字母数字、{NUMn} n 位随机数字、{DATE} {TIME} {USER} {TCODE}
*     {WERKS} {BY}; 一条规则最多一个 {SEQn}; NUMC 字段只能用数字文字与 SEQ/NUM/DATE/TIME
*   · 保存时校验写法与最短长度(check_rule), 写入时超长 / NUMC 非数字照旧拒绝;
*     生成值(随机 / 序号 / 含随机或序号的规则)作主键碰撞 → 报错重试, 不误报"已有权限"
* ★ 重贴后核对标记: "INSERT (" 只在 METHOD grant_row, "DELETE FROM (" 只在 METHOD
*   revoke_row; "SELECT SINGLE * FROM (" 只在 row_exists(查重)与 tcode_known(自动发现, 只读);
*   有 METHOD quote(不依赖 cl_abap_dyn_prg); decide 内有 'PENDING' 状态校验;
*   save_table / save_rule / get_config / describe_table 调 gate 时带
*   iv_need_enabled = abap_false; run_submit 内有 line_exists( ls_tab-fields[ map_type = 'WERKS' ] );
*   V1.2: 有 METHOD check_fmap 与 METHOD apply_rule_map; zai_auth_rmap 出现在 save_rule
*   (删 / 写)、apply_rule_map(读)、get_config(读) 三个方法里;
*   V1.3: user_addr 只出现在 METHOD fill_user_info, list_requests 末尾调它
*   V1.5: "SELECT (" 读目标表只在 METHOD seq_max(只读); 有 METHOD parse_rule /
*   METHOD check_rule / METHOD gen_value; check_fmap 的 CASE 里有 'SEQ' OR 'RULE'
*=======================================================================
CLASS zcl_ai_auth_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    " ---- 返回结构(DPC 用 /ui2/cl_json camel_case 序列化, 前端读 reqId / targetUser ...) ----
    TYPES: BEGIN OF ty_line,
             req_id      TYPE string,
             target_user TYPE string,
             tcode       TYPE string,
             werks       TYPE string,
             tabname     TYPE string,
             status      TYPE string,   " PENDING / DONE / EXISTS / REJECTED / FAILED / REVOKED
             message     TYPE string,
           END OF ty_line.
    TYPES tt_line TYPE STANDARD TABLE OF ty_line WITH DEFAULT KEY.

    " 所有"写"操作(申请 / 代加 / 审批 / 撤销)的统一返回: 逐条结果 + 一句话汇总
    TYPES: BEGIN OF ty_submit,
             lines   TYPE tt_line,
             summary TYPE string,
             error   TYPE string,        " 非空 = 整体失败(未写入任何内容)
           END OF ty_submit.

    TYPES: BEGIN OF ty_request,          " 申请记录(列表行)
             req_id      TYPE string,
             requester   TYPE string,
             target_user TYPE string,
             tcode       TYPE string,
             werks       TYPE string,
             tabname     TYPE string,
             channel     TYPE string,    " SELF / ADMIN
             status      TYPE string,
             reason      TYPE string,
             message     TYPE string,
             decided_by  TYPE string,
             created_at  TYPE string,
             decided_at  TYPE string,
             revocable   TYPE string,    " X = 已开通且有原始主键, 可撤销
             target_name TYPE string,    " V1.3: 姓名(USER_ADDR-NAME_TEXTC), 查不到为空
             target_dept TYPE string,    " V1.3: 部门(USER_ADDR-DEPARTMENT), 查不到为空
           END OF ty_request.
    TYPES tt_request TYPE STANDARD TABLE OF ty_request WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_list,
             requests TYPE tt_request,
             total    TYPE i,
             error    TYPE string,
           END OF ty_list.

    TYPES: BEGIN OF ty_field,
             fieldname TYPE string,
             keyflag   TYPE string,
             datatype  TYPE string,
             leng      TYPE i,
             convexit  TYPE string,
             map_type  TYPE string,      " TCODE / USER / WERKS / CONST / RANDOM / SEQ / RULE / DATE / TIME / BY / INITIAL
             const_val TYPE string,
           END OF ty_field.
    TYPES tt_field TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_describe,
             fields TYPE tt_field,
             error  TYPE string,
           END OF ty_describe.

    TYPES: BEGIN OF ty_table,
             tabname  TYPE string,
             descr    TYPE string,
             discover TYPE string,
             active   TYPE string,
             fields   TYPE tt_field,
           END OF ty_table.
    TYPES tt_table TYPE STANDARD TABLE OF ty_table WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_rule,
             tcode_pat TYPE string,
             tabname   TYPE string,
             rule_mode TYPE string,      " AUTO / APPROVE / BLOCK
             allow_all TYPE string,
             active    TYPE string,
             own_map   TYPE string,      " V1.2: X = 本规则有自己的字段映射(ZAI_AUTH_RMAP)
             fields    TYPE tt_field,    " V1.2: own_map = X 时为当前表结构 + 规则映射(仅 get_config 填)
           END OF ty_rule.
    TYPES tt_rule TYPE STANDARD TABLE OF ty_rule WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_config,
             tables TYPE tt_table,
             rules  TYPE tt_rule,
             error  TYPE string,
           END OF ty_config.

    TYPES: BEGIN OF ty_ack,
             message TYPE string,
             error   TYPE string,
           END OF ty_ack.

    " 总开关(ZAI_CHAT_CFG.AUTH_ENABLED = X)
    CLASS-METHODS enabled
      RETURNING VALUE(rv) TYPE abap_bool.

    " 自助申请: 目标账号恒为当前登录用户, 前端传什么都不信
    CLASS-METHODS submit
      IMPORTING iv_tcode       TYPE string
                iv_werks_list  TYPE string
                iv_reason      TYPE string
      RETURNING VALUE(rs)      TYPE ty_submit.

    " ADMIN 批量代加: 逐账号校验(USR02 存在、未锁、在有效期内)后写表, 不走审批
    CLASS-METHODS admin_batch_add
      IMPORTING iv_users       TYPE string
                iv_tcode       TYPE string
                iv_werks_list  TYPE string
                iv_reason      TYPE string
      RETURNING VALUE(rs)      TYPE ty_submit.

    " ADMIN 批准(iv_approve = X, 写表) / 驳回(其余, iv_message 必填)
    CLASS-METHODS decide
      IMPORTING iv_req_id      TYPE string
                iv_approve     TYPE string
                iv_message     TYPE string
      RETURNING VALUE(rs)      TYPE ty_submit.

    " ADMIN 撤销已开通的权限: 按授权时记下的原始主键删行
    CLASS-METHODS revoke
      IMPORTING iv_req_id      TYPE string
                iv_message     TYPE string
      RETURNING VALUE(rs)      TYPE ty_submit.

    " 申请记录: 普通用户只看自己的(忽略 iv_user); ADMIN 可按目标账号 / 状态 / 事务码筛选
    CLASS-METHODS list_requests
      IMPORTING iv_status      TYPE string
                iv_user        TYPE string
                iv_tcode       TYPE string
                iv_top         TYPE string
                iv_skip        TYPE string
      RETURNING VALUE(rs)      TYPE ty_list.

    " ADMIN: 读表结构 + 建议映射(已登记的表带上已保存的映射)
    CLASS-METHODS describe_table
      IMPORTING iv_tabname     TYPE string
      RETURNING VALUE(rs)      TYPE ty_describe.

    " ADMIN: 登记 / 更新权限表与字段映射(iv_fmap_json = [{"f":字段,"t":映射类型,"c":固定值}])
    CLASS-METHODS save_table
      IMPORTING iv_tabname     TYPE string
                iv_descr       TYPE string
                iv_discover    TYPE string
                iv_active      TYPE string
                iv_fmap_json   TYPE string
      RETURNING VALUE(rs)      TYPE ty_ack.

    " ADMIN: 保存 / 删除事务码规则
    " V1.2: iv_fmap_json 非空 = 本规则自己的字段映射(格式同 save_table, 规则必须指定权限表);
    "       空 = 沿用权限表的映射(并清掉本规则原有的映射)
    CLASS-METHODS save_rule
      IMPORTING iv_tcode_pat   TYPE string
                iv_tabname     TYPE string
                iv_rule_mode   TYPE string
                iv_allow_all   TYPE string
                iv_active      TYPE string
                iv_delete      TYPE string
                iv_fmap_json   TYPE string OPTIONAL
      RETURNING VALUE(rs)      TYPE ty_ack.

    " ADMIN: 已登记的表(含字段映射) + 规则
    CLASS-METHODS get_config
      RETURNING VALUE(rs)      TYPE ty_config.

  PRIVATE SECTION.

    " 每个内部会话复用生成器, 避免批量授权时逐字段重设种子。
    CLASS-DATA go_random_char TYPE REF TO cl_abap_random_int.
    CLASS-DATA go_random_num  TYPE REF TO cl_abap_random_int.

    TYPES tt_string TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    " V1.5: 规则串拆出来的一段(tok 空 = 原样文字 lit; 否则占位名, n = 位数)
    TYPES: BEGIN OF ty_rpart,
             tok TYPE string,
             n   TYPE i,
             lit TYPE string,
           END OF ty_rpart.
    TYPES tt_rpart TYPE STANDARD TABLE OF ty_rpart WITH DEFAULT KEY.
    TYPES ty_seqnum TYPE p LENGTH 16 DECIMALS 0.

    TYPES: BEGIN OF ty_fmap_in,          " save_table 的 FmapJson 一行
             f TYPE string,
             t TYPE string,
             c TYPE string,
           END OF ty_fmap_in.
    TYPES tt_fmap_in TYPE STANDARD TABLE OF ty_fmap_in WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_map,              " check_fmap 校验通过的一行映射
             fieldname TYPE string,
             map_type  TYPE string,
             const_val TYPE string,
           END OF ty_map.
    TYPES tt_map TYPE STANDARD TABLE OF ty_map WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_key,              " 授权时记下的原始主键(撤销用)
             f TYPE string,
             v TYPE string,
           END OF ty_key.
    TYPES tt_key TYPE STANDARD TABLE OF ty_key WITH DEFAULT KEY.

    " V1.3: 申请记录补姓名 / 部门(USER_ADDR), 查不到留空
    CLASS-METHODS fill_user_info
      CHANGING ct_requests TYPE tt_request.

    " ---- 通用小工具 ----
    CLASS-METHODS gate
      IMPORTING iv_admin        TYPE abap_bool
                iv_need_enabled TYPE abap_bool DEFAULT abap_true
      RETURNING VALUE(rv_error) TYPE string.
    CLASS-METHODS now14
      RETURNING VALUE(rv)      TYPE string.
    CLASS-METHODS quote
      IMPORTING iv             TYPE string
      RETURNING VALUE(rv)      TYPE string.
    CLASS-METHODS safe_name
      IMPORTING iv             TYPE string
      RETURNING VALUE(rv)      TYPE abap_bool.
    CLASS-METHODS split_values
      IMPORTING iv_values      TYPE string
      RETURNING VALUE(rt)      TYPE tt_string.
    CLASS-METHODS line_of
      IMPORTING is_req         TYPE zai_auth_req
      RETURNING VALUE(rs)      TYPE ty_line.
    CLASS-METHODS new_req
      IMPORTING iv_channel     TYPE string
                iv_user        TYPE string
                iv_tcode       TYPE string
                iv_werks       TYPE string
                iv_reason      TYPE string
      RETURNING VALUE(rs)      TYPE zai_auth_req.
    CLASS-METHODS save_req
      IMPORTING is_req         TYPE zai_auth_req.

    " ---- 校验 ----
    CLASS-METHODS valid_user
      IMPORTING iv_user        TYPE string
      RETURNING VALUE(rv)      TYPE abap_bool.
    CLASS-METHODS valid_request
      IMPORTING iv_tcode           TYPE string
                iv_werks_list      TYPE string
                iv_reason          TYPE string
                iv_plants_optional TYPE abap_bool DEFAULT abap_false
      EXPORTING et_plants          TYPE tt_string
                ev_error           TYPE string.

    " ---- 权限表结构 / 规则 ----
    CLASS-METHODS read_fields
      IMPORTING iv_tabname     TYPE string
      EXPORTING et_fields      TYPE tt_field
                ev_error       TYPE string.
    CLASS-METHODS fields_with_map
      IMPORTING iv_tabname     TYPE string
      EXPORTING et_fields      TYPE tt_field
                ev_saved       TYPE abap_bool
                ev_error       TYPE string.
    CLASS-METHODS load_table
      IMPORTING iv_tabname     TYPE string
                iv_need_active TYPE abap_bool
      EXPORTING es_table       TYPE ty_table
                ev_error       TYPE string.
    CLASS-METHODS find_rule
      IMPORTING iv_tcode       TYPE string
      RETURNING VALUE(rs)      TYPE ty_rule.
    CLASS-METHODS find_tables
      IMPORTING iv_tcode       TYPE string
                is_rule        TYPE ty_rule
      EXPORTING et_tables      TYPE tt_table
                ev_error       TYPE string.
    CLASS-METHODS tcode_known
      IMPORTING is_table       TYPE ty_table
                iv_tcode       TYPE string
      RETURNING VALUE(rv)      TYPE abap_bool.
    " V1.2: 字段映射 JSON 的校验(权限表与规则共用); iv_need_tcode = X 时至少一个 TCODE
    CLASS-METHODS check_fmap
      IMPORTING iv_tabname     TYPE string
                iv_fmap_json   TYPE string
                iv_need_tcode  TYPE abap_bool
      EXPORTING et_map         TYPE tt_map
                ev_error       TYPE string.
    " V1.2: 规则有自己的映射时, 用它覆盖 cs_table 的映射(ev_own = X); 没有则原样不动
    CLASS-METHODS apply_rule_map
      IMPORTING iv_tcode_pat   TYPE string
      EXPORTING ev_own         TYPE abap_bool
                ev_error       TYPE string
      CHANGING  cs_table       TYPE ty_table.

    " ---- 一条申请的处理 ----
    CLASS-METHODS run_submit
      IMPORTING iv_channel     TYPE string
                iv_users       TYPE string
                iv_tcode       TYPE string
                iv_werks_list  TYPE string
                iv_reason      TYPE string
      RETURNING VALUE(rs)      TYPE ty_submit.
    CLASS-METHODS process_one
      IMPORTING iv_channel     TYPE string
                iv_user        TYPE string
                iv_tcode       TYPE string
                iv_werks       TYPE string
                iv_reason      TYPE string
                is_rule        TYPE ty_rule
                is_table       TYPE ty_table
      RETURNING VALUE(rs)      TYPE ty_line.
    CLASS-METHODS build_row
      IMPORTING is_table       TYPE ty_table
                iv_tcode       TYPE string
                iv_user        TYPE string
                iv_werks       TYPE string
      EXPORTING er_row         TYPE REF TO data
                ev_error       TYPE string.
    CLASS-METHODS build_where
      IMPORTING is_table       TYPE ty_table
                ir_row         TYPE REF TO data
      EXPORTING ev_where       TYPE string
                ev_error       TYPE string.
    CLASS-METHODS random_value
      IMPORTING iv_datatype    TYPE string
                iv_length      TYPE i
      EXPORTING ev_value       TYPE string
                ev_error       TYPE string.
    " V1.5: 递增序号 / 规则组合(SEQ / RULE)
    CLASS-METHODS parse_rule
      IMPORTING iv_tpl         TYPE string
      EXPORTING et_part        TYPE tt_rpart
                ev_error       TYPE string.
    CLASS-METHODS check_rule
      IMPORTING is_field       TYPE ty_field
                iv_type        TYPE string
                iv_c           TYPE string
      RETURNING VALUE(rv)      TYPE string.
    CLASS-METHODS gen_value
      IMPORTING is_table       TYPE ty_table
                is_field       TYPE ty_field
                iv_tcode       TYPE string
                iv_user        TYPE string
                iv_werks       TYPE string
      EXPORTING ev_value       TYPE string
                ev_error       TYPE string.
    CLASS-METHODS like_escape
      IMPORTING iv             TYPE string
      RETURNING VALUE(rv)      TYPE string.

    " ---- 读写目标权限表的方法(查重 / 取序号只读, 写只在 grant_row, 删只在 revoke_row) ----
    CLASS-METHODS row_exists
      IMPORTING is_table       TYPE ty_table
                ir_row         TYPE REF TO data
      EXPORTING ev_found       TYPE abap_bool
                ev_error       TYPE string.
    " V1.5: 递增序号取当前最大(只读): 列值 LIKE iv_like 的行里, 第 iv_off 位起 iv_len 位全是数字的最大值
    CLASS-METHODS seq_max
      IMPORTING iv_tabname     TYPE string
                iv_fieldname   TYPE string
                iv_like        TYPE string
                iv_off         TYPE i
                iv_len         TYPE i
      EXPORTING ev_max         TYPE ty_seqnum
                ev_found       TYPE abap_bool
                ev_error       TYPE string.
    CLASS-METHODS grant_row
      IMPORTING is_table       TYPE ty_table
                ir_row         TYPE REF TO data
      EXPORTING ev_status      TYPE string
                ev_key_json    TYPE string
                ev_error       TYPE string.
    CLASS-METHODS revoke_row
      IMPORTING is_req         TYPE zai_auth_req
      EXPORTING ev_removed     TYPE abap_bool
                ev_error       TYPE string.

ENDCLASS.



CLASS zcl_ai_auth_service IMPLEMENTATION.

  "=====================================================================
  " 公开方法
  "=====================================================================

  METHOD enabled.
    rv = xsdbool( zcl_ai_task_service=>read_cfg_str( 'AUTH_ENABLED' ) = 'X' ).
  ENDMETHOD.


  METHOD submit.

    rs-error = gate( abap_false ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    TRY.
        rs = run_submit( iv_channel    = 'SELF'
                         iv_users      = ``
                         iv_tcode      = iv_tcode
                         iv_werks_list = iv_werks_list
                         iv_reason     = iv_reason ).
        IF rs-error IS INITIAL.
          COMMIT WORK.
        ELSE.
          ROLLBACK WORK.
        ENDIF.
      CATCH cx_root INTO DATA(lx).
        ROLLBACK WORK.
        CLEAR rs.
        rs-error = lx->get_text( ).
    ENDTRY.

  ENDMETHOD.


  METHOD admin_batch_add.

    rs-error = gate( abap_true ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    TRY.
        rs = run_submit( iv_channel    = 'ADMIN'
                         iv_users      = iv_users
                         iv_tcode      = iv_tcode
                         iv_werks_list = iv_werks_list
                         iv_reason     = iv_reason ).
        IF rs-error IS INITIAL.
          COMMIT WORK.
        ELSE.
          ROLLBACK WORK.
        ENDIF.
      CATCH cx_root INTO DATA(lx).
        ROLLBACK WORK.
        CLEAR rs.
        rs-error = lx->get_text( ).
    ENDTRY.

  ENDMETHOD.


  METHOD decide.

    DATA: ls_req    TYPE zai_auth_req,
          ls_tab    TYPE ty_table,
          ls_rule   TYPE ty_rule,
          lr_row    TYPE REF TO data,
          lt_plants TYPE tt_string,
          lv_err    TYPE string,
          lv_found  TYPE abap_bool,
          lv_status TYPE string,
          lv_key    TYPE string,
          lv_reason TYPE string.

    rs-error = gate( abap_true ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    TRY.
        IF strlen( iv_req_id ) <> 32 OR strlen( iv_message ) > 255.
          rs-error = '申请编号或处理说明长度不合法'.
          RETURN.
        ENDIF.
        SELECT SINGLE * FROM zai_auth_req WHERE req_id = @iv_req_id INTO @ls_req.
        IF sy-subrc <> 0.
          rs-error = '申请不存在'.
          RETURN.
        ENDIF.
        IF ls_req-status <> 'PENDING'.
          rs-error = '只能处理待审批的申请'.
          RETURN.
        ENDIF.

        IF iv_approve = 'X'.
          " 批准: 重新校验账号、事务码、工厂和目标表(申请之后配置或账号可能变了), 再写表
          IF valid_user( CONV string( ls_req-target_user ) ) = abap_false.
            rs-error = '目标 SAP 账号不存在、已锁定或已失效'.
            RETURN.
          ENDIF.
          valid_request( EXPORTING iv_tcode           = CONV string( ls_req-tcode )
                                   iv_werks_list      = CONV string( ls_req-werks )
                                   iv_reason          = CONV string( ls_req-reason )
                                   iv_plants_optional = xsdbool( ls_req-werks IS INITIAL )
                         IMPORTING et_plants          = lt_plants
                                   ev_error           = lv_err ).
          IF lv_err IS INITIAL.
            load_table( EXPORTING iv_tabname     = CONV string( ls_req-tabname )
                                  iv_need_active = abap_true
                        IMPORTING es_table       = ls_tab
                                  ev_error       = lv_err ).
          ENDIF.
          IF lv_err IS INITIAL.
            " V1.2: 按当前配置重新选映射 —— 当前命中的规则指向的正是这张表、且有自己的映射时用它
            ls_rule = find_rule( CONV string( ls_req-tcode ) ).
            IF ls_rule-tabname = ls_tab-tabname.
              apply_rule_map( EXPORTING iv_tcode_pat = ls_rule-tcode_pat
                              IMPORTING ev_error     = lv_err
                              CHANGING  cs_table     = ls_tab ).
            ENDIF.
          ENDIF.
          IF lv_err IS INITIAL.
            build_row( EXPORTING is_table = ls_tab
                                 iv_tcode = CONV string( ls_req-tcode )
                                 iv_user  = CONV string( ls_req-target_user )
                                 iv_werks = CONV string( ls_req-werks )
                       IMPORTING er_row   = lr_row
                                 ev_error = lv_err ).
          ENDIF.
          IF lv_err IS INITIAL.
            row_exists( EXPORTING is_table = ls_tab
                                  ir_row   = lr_row
                        IMPORTING ev_found = lv_found
                                  ev_error = lv_err ).
          ENDIF.
          IF lv_err IS INITIAL.
            IF lv_found = abap_true.
              lv_status = 'EXISTS'.
            ELSE.
              grant_row( EXPORTING is_table    = ls_tab
                                   ir_row      = lr_row
                         IMPORTING ev_status   = lv_status
                                   ev_key_json = lv_key
                                   ev_error    = lv_err ).
            ENDIF.
          ENDIF.
          IF lv_err IS NOT INITIAL.
            rs-error = lv_err.
            RETURN.
          ENDIF.
          ls_req-status   = lv_status.
          ls_req-key_json = lv_key.
          ls_req-message  = COND #( WHEN lv_status = 'EXISTS' THEN '审批时发现已有权限，未重复写入'
                                    WHEN iv_message IS NOT INITIAL THEN iv_message
                                    ELSE '已批准并开通' ).
        ELSE.
          lv_reason = condense( iv_message ).
          IF lv_reason IS INITIAL.
            rs-error = '请填写驳回原因'.
            RETURN.
          ENDIF.
          ls_req-status  = 'REJECTED'.
          ls_req-message = iv_message.
        ENDIF.

        ls_req-decided_by = sy-uname.
        ls_req-decided_at = now14( ).
        save_req( ls_req ).
        COMMIT WORK.
        APPEND line_of( ls_req ) TO rs-lines.
        rs-summary = ls_req-message.

      CATCH cx_root INTO DATA(lx).
        ROLLBACK WORK.
        CLEAR rs.
        rs-error = lx->get_text( ).
    ENDTRY.

  ENDMETHOD.


  METHOD revoke.

    DATA: ls_req     TYPE zai_auth_req,
          lv_err     TYPE string,
          lv_removed TYPE abap_bool.

    rs-error = gate( abap_true ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    TRY.
        IF strlen( iv_req_id ) <> 32 OR strlen( iv_message ) > 255.
          rs-error = '申请编号或处理说明长度不合法'.
          RETURN.
        ENDIF.
        SELECT SINGLE * FROM zai_auth_req WHERE req_id = @iv_req_id INTO @ls_req.
        IF sy-subrc <> 0.
          rs-error = '申请不存在'.
          RETURN.
        ENDIF.
        IF ls_req-status <> 'DONE' OR ls_req-key_json IS INITIAL.
          rs-error = '只能撤销本系统已开通、且记有原始主键的权限'.
          RETURN.
        ENDIF.
        revoke_row( EXPORTING is_req     = ls_req
                    IMPORTING ev_removed = lv_removed
                              ev_error   = lv_err ).
        IF lv_err IS NOT INITIAL.
          rs-error = lv_err.
          RETURN.
        ENDIF.
        ls_req-status     = 'REVOKED'.
        ls_req-decided_by = sy-uname.
        ls_req-decided_at = now14( ).
        ls_req-message    = COND #( WHEN lv_removed = abap_false THEN '权限行已不存在(可能已被手工删除)，记录标为已撤销'
                                    WHEN iv_message IS NOT INITIAL THEN iv_message
                                    ELSE '权限已撤销' ).
        save_req( ls_req ).
        COMMIT WORK.
        APPEND line_of( ls_req ) TO rs-lines.
        rs-summary = ls_req-message.

      CATCH cx_root INTO DATA(lx).
        ROLLBACK WORK.
        CLEAR rs.
        rs-error = lx->get_text( ).
    ENDTRY.

  ENDMETHOD.


  METHOD list_requests.

    DATA: lr_req    TYPE RANGE OF zai_auth_req-requester,
          lr_target TYPE RANGE OF zai_auth_req-target_user,
          lr_status TYPE RANGE OF zai_auth_req-status,
          lr_tcode  TYPE RANGE OF zai_auth_req-tcode,
          lt_rows   TYPE STANDARD TABLE OF zai_auth_req WITH DEFAULT KEY,
          lv_admin  TYPE abap_bool,
          lv_top    TYPE i VALUE 50,
          lv_skip   TYPE i,
          lv_limit  TYPE i,
          lv_from   TYPE i,
          lv_user   TYPE string,
          lv_status TYPE string,
          lv_tcode  TYPE string.

    rs-error = gate( iv_admin = abap_false iv_need_enabled = abap_false ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    lv_admin = xsdbool( zcl_ai_chat_service=>v8_get_role( ) = 'ADMIN' ).
    IF lv_admin = abap_false AND enabled( ) = abap_false.
      rs-error = '权限自助申请尚未启用，请联系 IT'.
      RETURN.
    ENDIF.
    IF lv_admin = abap_false.
      " 归属限制写在数据库条件里, 不信任前端传来的 User
      APPEND VALUE #( sign = 'I' option = 'EQ' low = sy-uname ) TO lr_req.
    ELSE.
      lv_user = to_upper( condense( iv_user ) ).
      IF lv_user IS NOT INITIAL.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_user ) TO lr_target.
      ENDIF.
    ENDIF.
    lv_status = to_upper( condense( iv_status ) ).
    IF lv_status IS NOT INITIAL.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_status ) TO lr_status.
    ENDIF.
    lv_tcode = to_upper( condense( iv_tcode ) ).
    IF lv_tcode IS NOT INITIAL.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_tcode ) TO lr_tcode.
    ENDIF.

    IF iv_top IS NOT INITIAL AND iv_top CO '0123456789' AND strlen( iv_top ) <= 3.
      lv_top = iv_top.
    ENDIF.
    lv_top = nmax( val1 = 1 val2 = nmin( val1 = 200 val2 = lv_top ) ).
    IF iv_skip IS NOT INITIAL AND iv_skip CO '0123456789' AND strlen( iv_skip ) <= 6.
      lv_skip = iv_skip.
    ENDIF.

    SELECT COUNT( * ) FROM zai_auth_req
      WHERE requester IN @lr_req AND target_user IN @lr_target
        AND status IN @lr_status AND tcode IN @lr_tcode
      INTO @rs-total.

    " 7.50 的 Open SQL 没有 OFFSET: 读到当前页末尾, 再丢掉前 lv_skip 条
    lv_limit = lv_skip + lv_top.
    SELECT * FROM zai_auth_req
      WHERE requester IN @lr_req AND target_user IN @lr_target
        AND status IN @lr_status AND tcode IN @lr_tcode
      ORDER BY created_at DESCENDING, req_id DESCENDING
      INTO TABLE @lt_rows UP TO @lv_limit ROWS.

    lv_from = lv_skip + 1.
    LOOP AT lt_rows INTO DATA(ls_row) FROM lv_from.
      DATA(ls_out) = CORRESPONDING ty_request( ls_row ).
      IF ls_row-status = 'DONE' AND ls_row-key_json IS NOT INITIAL.
        ls_out-revocable = 'X'.
      ENDIF.
      APPEND ls_out TO rs-requests.
    ENDLOOP.

    " V1.3: 审批卡显示姓名 / 部门
    fill_user_info( CHANGING ct_requests = rs-requests ).

  ENDMETHOD.


  METHOD fill_user_info.
    " V1.3 20261024: 按账号(BNAME)查 USER_ADDR 补姓名 / 部门, 只读。
    " 字段列表动态: 万一某个字段名与系统不符, 只是查不到(留空, 前端只显示账号), 不会让整个类激活失败
    TYPES: BEGIN OF ty_addr,
             bname      TYPE xubname,
             name_textc TYPE c LENGTH 80,
             department TYPE c LENGTH 40,
           END OF ty_addr.
    DATA: lr_users TYPE RANGE OF xubname,
          lt_addr  TYPE STANDARD TABLE OF ty_addr WITH DEFAULT KEY,
          ls_addr  TYPE ty_addr,
          lv_cols  TYPE string VALUE `BNAME, NAME_TEXTC, DEPARTMENT`.
    FIELD-SYMBOLS <ls_req> TYPE ty_request.

    LOOP AT ct_requests ASSIGNING <ls_req> WHERE target_user IS NOT INITIAL.
      IF NOT line_exists( lr_users[ low = <ls_req>-target_user ] ).
        APPEND VALUE #( sign = 'I' option = 'EQ' low = <ls_req>-target_user ) TO lr_users.
      ENDIF.
    ENDLOOP.
    IF lr_users IS INITIAL.
      RETURN.
    ENDIF.

    TRY.
        SELECT (lv_cols) FROM user_addr
          WHERE bname IN @lr_users
          INTO CORRESPONDING FIELDS OF TABLE @lt_addr.
      CATCH cx_sy_dynamic_osql_error cx_sy_open_sql_db.
        RETURN.
    ENDTRY.
    SORT lt_addr BY bname.

    LOOP AT ct_requests ASSIGNING <ls_req>.
      READ TABLE lt_addr INTO ls_addr WITH KEY bname = <ls_req>-target_user BINARY SEARCH.
      IF sy-subrc = 0.
        <ls_req>-target_name = condense( ls_addr-name_textc ).
        <ls_req>-target_dept = condense( ls_addr-department ).
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD describe_table.

    DATA lv_saved TYPE abap_bool.

    rs-error = gate( iv_admin = abap_true iv_need_enabled = abap_false ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    fields_with_map( EXPORTING iv_tabname = to_upper( condense( iv_tabname ) )
                     IMPORTING et_fields  = rs-fields
                               ev_saved   = lv_saved
                               ev_error   = rs-error ).

  ENDMETHOD.


  METHOD save_table.

    DATA: lv_name TYPE string,
          lt_map  TYPE tt_map,
          lt_save TYPE STANDARD TABLE OF zai_auth_fmap WITH DEFAULT KEY,
          ls_tab  TYPE zai_auth_tab.

    rs-error = gate( iv_admin = abap_true iv_need_enabled = abap_false ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    TRY.
        lv_name = to_upper( condense( iv_tabname ) ).
        " V1.2: 校验与规则映射共用 check_fmap(表名 → JSON → 逐字段 → USER / TCODE 个数)
        check_fmap( EXPORTING iv_tabname    = lv_name
                              iv_fmap_json  = iv_fmap_json
                              iv_need_tcode = xsdbool( iv_discover = 'X' )
                    IMPORTING et_map        = lt_map
                              ev_error      = rs-error ).
        IF rs-error IS NOT INITIAL.
          RETURN.
        ENDIF.
        IF strlen( iv_descr ) > 60.
          rs-error = '说明不能超过 60 字'.
          RETURN.
        ENDIF.

        LOOP AT lt_map INTO DATA(ls_m).
          APPEND VALUE #( mandt     = sy-mandt
                          tabname   = lv_name
                          fieldname = ls_m-fieldname
                          map_type  = ls_m-map_type
                          const_val = ls_m-const_val ) TO lt_save.
        ENDLOOP.

        ls_tab-mandt      = sy-mandt.
        ls_tab-tabname    = lv_name.
        ls_tab-descr      = iv_descr.
        ls_tab-discover   = COND #( WHEN iv_discover = 'X' THEN 'X' ELSE ' ' ).
        ls_tab-active     = COND #( WHEN iv_active = 'X' THEN 'X' ELSE ' ' ).
        ls_tab-changed_by = sy-uname.
        ls_tab-changed_at = now14( ).
        MODIFY zai_auth_tab FROM @ls_tab.
        DELETE FROM zai_auth_fmap WHERE tabname = @lv_name.
        INSERT zai_auth_fmap FROM TABLE @lt_save.
        COMMIT WORK.
        rs-message = '权限表配置已保存'.

      CATCH cx_root INTO DATA(lx).
        ROLLBACK WORK.
        CLEAR rs.
        rs-error = lx->get_text( ).
    ENDTRY.

  ENDMETHOD.


  METHOD save_rule.

    DATA: lv_pat  TYPE string,
          lv_tab  TYPE string,
          lv_json TYPE string,
          ls_tab  TYPE ty_table,
          lt_map  TYPE tt_map,
          lt_rmap TYPE STANDARD TABLE OF zai_auth_rmap WITH DEFAULT KEY,
          ls_rule TYPE zai_auth_rule.

    rs-error = gate( iv_admin = abap_true iv_need_enabled = abap_false ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    TRY.
        lv_pat = to_upper( condense( iv_tcode_pat ) ).
        lv_tab = to_upper( condense( iv_tabname ) ).
        IF lv_pat IS INITIAL OR strlen( lv_pat ) > 20
           OR lv_pat CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/*'.
          rs-error = '事务码规则格式不合法(字母、数字、_ / 和通配符 *)'.
          RETURN.
        ENDIF.

        IF iv_delete = 'X'.
          DELETE FROM zai_auth_rule WHERE tcode_pat = @lv_pat.
          DELETE FROM zai_auth_rmap WHERE tcode_pat = @lv_pat.     " V1.2: 映射随规则一起删
          COMMIT WORK.
          rs-message = '规则已删除'.
          RETURN.
        ENDIF.

        IF iv_rule_mode <> 'AUTO' AND iv_rule_mode <> 'APPROVE' AND iv_rule_mode <> 'BLOCK'.
          rs-error = '处理方式必须是 AUTO / APPROVE / BLOCK'.
          RETURN.
        ENDIF.
        IF lv_tab IS NOT INITIAL.
          load_table( EXPORTING iv_tabname     = lv_tab
                                iv_need_active = abap_true
                      IMPORTING es_table       = ls_tab
                                ev_error       = rs-error ).
          IF rs-error IS NOT INITIAL.
            RETURN.
          ENDIF.
        ENDIF.

        " V1.2: 本规则自己的字段映射(整份, 约束同权限表但不要求 TCODE)
        lv_json = condense( iv_fmap_json ).
        IF lv_json IS NOT INITIAL.
          IF lv_tab IS INITIAL.
            rs-error = '规则不指定权限表(走自动发现)时不能单独配字段映射'.
            RETURN.
          ENDIF.
          check_fmap( EXPORTING iv_tabname    = lv_tab
                                iv_fmap_json  = lv_json
                                iv_need_tcode = abap_false
                      IMPORTING et_map        = lt_map
                                ev_error      = rs-error ).
          IF rs-error IS NOT INITIAL.
            rs-error = |本规则的字段映射: { rs-error }|.
            RETURN.
          ENDIF.
          LOOP AT lt_map INTO DATA(ls_m).
            APPEND VALUE #( mandt     = sy-mandt
                            tcode_pat = lv_pat
                            fieldname = ls_m-fieldname
                            tabname   = lv_tab
                            map_type  = ls_m-map_type
                            const_val = ls_m-const_val ) TO lt_rmap.
          ENDLOOP.
        ENDIF.

        ls_rule-mandt      = sy-mandt.
        ls_rule-tcode_pat  = lv_pat.
        ls_rule-tabname    = lv_tab.
        ls_rule-rule_mode  = iv_rule_mode.
        ls_rule-allow_all  = COND #( WHEN iv_allow_all = 'X' THEN 'X' ELSE ' ' ).
        ls_rule-active     = COND #( WHEN iv_active = 'X' THEN 'X' ELSE ' ' ).
        ls_rule-changed_by = sy-uname.
        ls_rule-changed_at = now14( ).
        MODIFY zai_auth_rule FROM @ls_rule.
        " 映射整份替换: 沿用权限表映射时清空; 规则换了表时旧映射一并作废
        DELETE FROM zai_auth_rmap WHERE tcode_pat = @lv_pat.
        IF lt_rmap IS NOT INITIAL.
          INSERT zai_auth_rmap FROM TABLE @lt_rmap.
        ENDIF.
        COMMIT WORK.
        rs-message = COND #( WHEN lt_rmap IS INITIAL THEN '事务码规则已保存'
                             ELSE '事务码规则已保存(使用本规则自己的字段映射)' ).

      CATCH cx_root INTO DATA(lx).
        ROLLBACK WORK.
        CLEAR rs.
        rs-error = lx->get_text( ).
    ENDTRY.

  ENDMETHOD.


  METHOD get_config.

    DATA: lt_names TYPE STANDARD TABLE OF zai_auth_tab WITH DEFAULT KEY,
          lt_rules TYPE STANDARD TABLE OF zai_auth_rule WITH DEFAULT KEY,
          lt_rmap  TYPE STANDARD TABLE OF zai_auth_rmap WITH DEFAULT KEY,
          ls_table TYPE ty_table,
          lv_saved TYPE abap_bool,
          lv_pat   TYPE string,
          lv_tab   TYPE string,
          lv_err   TYPE string.

    rs-error = gate( iv_admin = abap_true iv_need_enabled = abap_false ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    SELECT * FROM zai_auth_tab ORDER BY tabname INTO TABLE @lt_names.
    LOOP AT lt_names INTO DATA(ls_n).
      CLEAR ls_table.
      ls_table-tabname  = ls_n-tabname.
      ls_table-descr    = ls_n-descr.
      ls_table-discover = ls_n-discover.
      ls_table-active   = ls_n-active.
      " 表后来被删或改坏时, 只是这一张读不出字段, 不拖垮整个配置页
      fields_with_map( EXPORTING iv_tabname = CONV string( ls_n-tabname )
                       IMPORTING et_fields  = ls_table-fields
                                 ev_saved   = lv_saved
                                 ev_error   = lv_err ).
      APPEND ls_table TO rs-tables.
    ENDLOOP.

    SELECT * FROM zai_auth_rule ORDER BY tcode_pat INTO TABLE @lt_rules.
    rs-rules = CORRESPONDING #( lt_rules ).

    " V1.2: 有自己映射的规则带上 own_map = X 和字段(当前表结构 + 规则映射;
    "       表结构新增、规则映射里还没有的字段显示建议值, IT 重新保存规则即补齐)
    LOOP AT rs-rules ASSIGNING FIELD-SYMBOL(<ls_r>) WHERE tabname IS NOT INITIAL.
      lv_pat = <ls_r>-tcode_pat.
      lv_tab = <ls_r>-tabname.
      SELECT * FROM zai_auth_rmap
        WHERE tcode_pat = @lv_pat AND tabname = @lv_tab
        INTO TABLE @lt_rmap.
      IF lt_rmap IS INITIAL.
        CONTINUE.
      ENDIF.
      <ls_r>-own_map = 'X'.
      read_fields( EXPORTING iv_tabname = lv_tab
                   IMPORTING et_fields  = <ls_r>-fields
                             ev_error   = lv_err ).
      LOOP AT <ls_r>-fields ASSIGNING FIELD-SYMBOL(<ls_rf>).
        READ TABLE lt_rmap INTO DATA(ls_rm) WITH KEY fieldname = <ls_rf>-fieldname.
        IF sy-subrc = 0.
          <ls_rf>-map_type  = ls_rm-map_type.
          <ls_rf>-const_val = ls_rm-const_val.
        ENDIF.
      ENDLOOP.
    ENDLOOP.

  ENDMETHOD.


  "=====================================================================
  " 申请的处理(自助 / 批量代加共用)
  "=====================================================================

  METHOD run_submit.

    DATA: lv_tcode   TYPE string,
          lt_plants  TYPE tt_string,
          lt_users   TYPE tt_string,
          lt_tables  TYPE tt_table,
          ls_rule    TYPE ty_rule,
          lv_count   TYPE i,
          lv_done    TYPE i,
          lv_exists  TYPE i,
          lv_pending TYPE i,
          lv_bad     TYPE i,
          lv_total   TYPE i,
          ls_req     TYPE zai_auth_req.

    lv_tcode = to_upper( condense( iv_tcode ) ).
    valid_request( EXPORTING iv_tcode      = lv_tcode
                             iv_werks_list = iv_werks_list
                             iv_reason     = iv_reason
                   IMPORTING et_plants     = lt_plants
                             ev_error      = rs-error ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    IF iv_channel = 'SELF'.
      APPEND CONV string( sy-uname ) TO lt_users.
    ELSE.
      lt_users = split_values( iv_users ).
      IF lt_users IS INITIAL OR lines( lt_users ) > 100.
        rs-error = '账号数量须为 1 至 100 个'.
        RETURN.
      ENDIF.
    ENDIF.

    ls_rule = find_rule( lv_tcode ).

    " 规则 BLOCK: 只禁止自助申请(逐工厂记一条"已拒绝"); IT 批量代加不受限
    IF iv_channel = 'SELF' AND ls_rule-rule_mode = 'BLOCK'.
      LOOP AT lt_plants INTO DATA(lv_blk_plant).
        ls_req = new_req( iv_channel = iv_channel iv_user = CONV string( sy-uname ) iv_tcode = lv_tcode
                          iv_werks = lv_blk_plant iv_reason = iv_reason ).
        ls_req-status     = 'REJECTED'.
        ls_req-message    = '该事务码不允许自助申请，请联系 IT'.
        ls_req-decided_by = 'AUTO'.
        ls_req-decided_at = now14( ).
        save_req( ls_req ).
        APPEND line_of( ls_req ) TO rs-lines.
      ENDLOOP.
      rs-summary = '该事务码不允许自助申请，请联系 IT'.
      RETURN.
    ENDIF.

    find_tables( EXPORTING iv_tcode  = lv_tcode
                           is_rule   = ls_rule
                 IMPORTING et_tables = lt_tables
                           ev_error  = rs-error ).
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.

    lv_count = lines( lt_users ) * lines( lt_plants ) * lines( lt_tables ).
    IF lv_count > 500.
      rs-error = |一次最多处理 500 条(账号 × 工厂 × 权限表)，当前 { lv_count } 条，请分批|.
      RETURN.
    ENDIF.

    LOOP AT lt_users INTO DATA(lv_user).
      IF iv_channel = 'ADMIN' AND valid_user( lv_user ) = abap_false.
        ls_req = new_req( iv_channel = iv_channel iv_user = `` iv_tcode = lv_tcode iv_werks = `` iv_reason = iv_reason ).
        IF strlen( lv_user ) <= 12.
          ls_req-target_user = lv_user.
        ENDIF.
        ls_req-status     = 'FAILED'.
        ls_req-message    = |SAP 账号不存在、已锁定或已失效: { lv_user }|.
        ls_req-decided_by = sy-uname.
        ls_req-decided_at = now14( ).
        save_req( ls_req ).
        APPEND line_of( ls_req ) TO rs-lines.
        CONTINUE.
      ENDIF.
      LOOP AT lt_tables INTO DATA(ls_tab).
        IF line_exists( ls_tab-fields[ map_type = 'WERKS' ] ).
          LOOP AT lt_plants INTO DATA(lv_plant).
            APPEND process_one( iv_channel = iv_channel
                                iv_user    = lv_user
                                iv_tcode   = lv_tcode
                                iv_werks   = lv_plant
                                iv_reason  = iv_reason
                                is_rule    = ls_rule
                                is_table   = ls_tab ) TO rs-lines.
          ENDLOOP.
        ELSE.
          " 这张表不按工厂控制: 不论申请了几个工厂只写一行(记录里工厂留空)
          APPEND process_one( iv_channel = iv_channel
                              iv_user    = lv_user
                              iv_tcode   = lv_tcode
                              iv_werks   = ``
                              iv_reason  = iv_reason
                              is_rule    = ls_rule
                              is_table   = ls_tab ) TO rs-lines.
        ENDIF.
      ENDLOOP.
    ENDLOOP.

    LOOP AT rs-lines INTO DATA(ls_c).
      CASE ls_c-status.
        WHEN 'DONE'.
          lv_done = lv_done + 1.
        WHEN 'EXISTS'.
          lv_exists = lv_exists + 1.
        WHEN 'PENDING'.
          lv_pending = lv_pending + 1.
        WHEN OTHERS.
          lv_bad = lv_bad + 1.
      ENDCASE.
    ENDLOOP.
    lv_total = lines( rs-lines ).
    rs-summary = |共 { lv_total } 条: 已开通 { lv_done }，已有 { lv_exists }，待审批 { lv_pending }，失败或拒绝 { lv_bad }|.

  ENDMETHOD.


  METHOD process_one.

    DATA: ls_req    TYPE zai_auth_req,
          lr_row    TYPE REF TO data,
          lv_err    TYPE string,
          lv_found  TYPE abap_bool,
          lv_status TYPE string,
          lv_key    TYPE string,
          lv_dup    TYPE zai_auth_req-req_id.

    ls_req = new_req( iv_channel = iv_channel iv_user = iv_user iv_tcode = iv_tcode
                      iv_werks = iv_werks iv_reason = iv_reason ).
    ls_req-tabname = is_table-tabname.

    build_row( EXPORTING is_table = is_table
                         iv_tcode = iv_tcode
                         iv_user  = iv_user
                         iv_werks = iv_werks
               IMPORTING er_row   = lr_row
                         ev_error = lv_err ).
    IF lv_err IS INITIAL.
      row_exists( EXPORTING is_table = is_table
                            ir_row   = lr_row
                  IMPORTING ev_found = lv_found
                            ev_error = lv_err ).
    ENDIF.

    IF lv_err IS NOT INITIAL.
      ls_req-status  = 'FAILED'.
      ls_req-message = lv_err.
    ELSEIF lv_found = abap_true.
      ls_req-status  = 'EXISTS'.
      ls_req-message = '已有权限，未重复写入'.
    ELSEIF iv_channel = 'SELF'
       AND ( is_rule-rule_mode = 'APPROVE' OR ( iv_werks = 'ALL' AND is_rule-allow_all <> 'X' ) ).
      " 同一账号 + 事务码 + 工厂 + 表已有待审批的申请: 不再重复排队
      SELECT SINGLE req_id FROM zai_auth_req
        WHERE target_user = @iv_user AND tcode = @iv_tcode AND werks = @iv_werks
          AND tabname = @is_table-tabname AND status = 'PENDING'
        INTO @lv_dup.
      IF sy-subrc = 0.
        rs = VALUE #( req_id = lv_dup target_user = iv_user tcode = iv_tcode werks = iv_werks
                      tabname = is_table-tabname status = 'PENDING'
                      message = '已有相同的待审批申请，请等待 IT 处理' ).
        RETURN.
      ENDIF.
      ls_req-status  = 'PENDING'.
      ls_req-message = COND #( WHEN iv_werks = 'ALL' AND is_rule-rule_mode <> 'APPROVE'
                               THEN '申请全部工厂(ALL)需要 IT 审批'
                               ELSE '等待 IT 审批' ).
    ELSE.
      grant_row( EXPORTING is_table    = is_table
                           ir_row      = lr_row
                 IMPORTING ev_status   = lv_status
                           ev_key_json = lv_key
                           ev_error    = lv_err ).
      IF lv_err IS NOT INITIAL.
        ls_req-status  = 'FAILED'.
        ls_req-message = lv_err.
      ELSEIF lv_status = 'EXISTS'.
        ls_req-status  = 'EXISTS'.
        ls_req-message = '相同主键已存在，未重复写入'.
      ELSE.
        ls_req-status   = 'DONE'.
        ls_req-key_json = lv_key.
        ls_req-message  = '权限已开通'.
      ENDIF.
    ENDIF.

    IF ls_req-status <> 'PENDING'.
      ls_req-decided_by = COND #( WHEN iv_channel = 'ADMIN' THEN sy-uname ELSE 'AUTO' ).
      ls_req-decided_at = now14( ).
    ENDIF.
    save_req( ls_req ).
    rs = line_of( ls_req ).

  ENDMETHOD.


  "=====================================================================
  " 权限表结构 / 规则
  "=====================================================================

  METHOD read_fields.

    DATA: lv_table TYPE tabname,
          lt_ddic  TYPE ddfields,
          ls_f     TYPE ty_field.

    CLEAR: et_fields, ev_error.

    " 只能是 Z / Y 开头的透明表, 且不能是本系统的 ZAI_* 表
    " (否则能把 ZAI_CHAT_USER 登记成权限表, 把自己改成 ADMIN)
    IF iv_tabname IS INITIAL OR strlen( iv_tabname ) > 30
       OR iv_tabname CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
       OR iv_tabname CP 'ZAI_*'
       OR NOT ( iv_tabname CP 'Z*' OR iv_tabname CP 'Y*' ).
      ev_error = '只能登记 Z / Y 开头的透明表, 且不能是 ZAI_* 系统表'.
      RETURN.
    ENDIF.
    lv_table = iv_tabname.
    SELECT SINGLE tabname FROM dd02l
      WHERE tabname = @lv_table AND as4local = 'A' AND tabclass = 'TRANSP'
      INTO @DATA(lv_found).
    IF sy-subrc <> 0.
      ev_error = |表 { iv_tabname } 不存在, 或不是已激活的透明表|.
      RETURN.
    ENDIF.

    TRY.
        DATA(lo_struct) = CAST cl_abap_structdescr( cl_abap_typedescr=>describe_by_name( lv_table ) ).
        lt_ddic = lo_struct->get_ddic_field_list( ).
      CATCH cx_root.
        ev_error = '读取表结构失败'.
        RETURN.
    ENDTRY.

    LOOP AT lt_ddic INTO DATA(ls_d).
      IF ls_d-datatype = 'CLNT'.
        CONTINUE.                         " 客户端字段由 Open SQL 自动处理, 不映射
      ENDIF.
      CLEAR ls_f.
      ls_f-fieldname = ls_d-fieldname.
      ls_f-keyflag   = ls_d-keyflag.
      ls_f-datatype  = ls_d-datatype.
      ls_f-leng      = ls_d-leng.
      ls_f-convexit  = ls_d-convexit.
      ls_f-map_type  = 'INITIAL'.
      " 按字段名给出建议映射(IT 在页面上确认或修改)
      CASE ls_f-fieldname.
        WHEN 'TCODE' OR 'TCD'.
          ls_f-map_type = 'TCODE'.
        WHEN 'FIR_ACCOUNT' OR 'UNAME' OR 'BNAME' OR 'USERID' OR 'USNAM'.
          ls_f-map_type = 'USER'.
        WHEN 'WERKS' OR 'PLANT'.
          ls_f-map_type = 'WERKS'.
        WHEN 'ERDAT' OR 'AEDAT'.
          ls_f-map_type = 'DATE'.
        WHEN 'ERZET' OR 'AEZET'.
          ls_f-map_type = 'TIME'.
        WHEN 'ERNAM' OR 'AENAM'.
          ls_f-map_type = 'BY'.
      ENDCASE.
      APPEND ls_f TO et_fields.
    ENDLOOP.

  ENDMETHOD.


  METHOD fields_with_map.

    DATA lt_map TYPE STANDARD TABLE OF zai_auth_fmap WITH DEFAULT KEY.

    CLEAR ev_saved.
    read_fields( EXPORTING iv_tabname = iv_tabname
                 IMPORTING et_fields  = et_fields
                           ev_error   = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    SELECT * FROM zai_auth_fmap WHERE tabname = @iv_tabname INTO TABLE @lt_map.
    IF lt_map IS INITIAL.
      RETURN.
    ENDIF.
    ev_saved = abap_true.
    LOOP AT et_fields ASSIGNING FIELD-SYMBOL(<ls_f>).
      READ TABLE lt_map INTO DATA(ls_m) WITH KEY fieldname = <ls_f>-fieldname.
      IF sy-subrc = 0.
        <ls_f>-map_type  = ls_m-map_type.
        <ls_f>-const_val = ls_m-const_val.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD load_table.

    DATA: lt_fields TYPE tt_field,
          lt_map    TYPE STANDARD TABLE OF zai_auth_fmap WITH DEFAULT KEY,
          ls_tab    TYPE zai_auth_tab.

    CLEAR: es_table, ev_error.
    read_fields( EXPORTING iv_tabname = iv_tabname
                 IMPORTING et_fields  = lt_fields
                           ev_error   = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    SELECT SINGLE * FROM zai_auth_tab WHERE tabname = @iv_tabname INTO @ls_tab.
    IF sy-subrc <> 0 OR ( iv_need_active = abap_true AND ls_tab-active <> 'X' ).
      ev_error = |权限表 { iv_tabname } 未登记或未启用|.
      RETURN.
    ENDIF.
    SELECT * FROM zai_auth_fmap WHERE tabname = @iv_tabname INTO TABLE @lt_map.
    LOOP AT lt_fields ASSIGNING FIELD-SYMBOL(<ls_f>).
      " 已保存的映射是唯一来源: 表结构后来加了字段而映射没跟上, 拒绝使用(不拿建议值冒充)
      READ TABLE lt_map INTO DATA(ls_m) WITH KEY fieldname = <ls_f>-fieldname.
      IF sy-subrc <> 0.
        ev_error = |权限表 { iv_tabname } 的结构已变化(新增字段 { <ls_f>-fieldname })，请 IT 重新保存该表的配置|.
        RETURN.
      ENDIF.
      <ls_f>-map_type  = ls_m-map_type.
      <ls_f>-const_val = ls_m-const_val.
    ENDLOOP.
    es_table-tabname  = iv_tabname.
    es_table-descr    = ls_tab-descr.
    es_table-discover = ls_tab-discover.
    es_table-active   = ls_tab-active.
    es_table-fields   = lt_fields.

  ENDMETHOD.


  METHOD find_rule.

    DATA: lt_rules TYPE STANDARD TABLE OF zai_auth_rule WITH DEFAULT KEY,
          lv_best  TYPE i VALUE -1,
          lv_pat   TYPE string,
          lv_score TYPE i.

    SELECT * FROM zai_auth_rule WHERE active = 'X' INTO TABLE @lt_rules.
    LOOP AT lt_rules INTO DATA(ls_r).
      lv_pat = condense( CONV string( ls_r-tcode_pat ) ).
      IF iv_tcode NP lv_pat.
        CONTINUE.
      ENDIF.
      " 多条命中取最精确的: 精确事务码优先于通配, 通配越长越优先
      IF lv_pat NS '*'.
        lv_score = 1000.
      ELSE.
        lv_score = strlen( lv_pat ).
      ENDIF.
      IF lv_score > lv_best.
        lv_best = lv_score.
        rs = CORRESPONDING #( ls_r ).
      ENDIF.
    ENDLOOP.
    IF rs-rule_mode IS INITIAL.
      rs-rule_mode = 'AUTO'.              " 没有规则: 自动发现的表按自动通过处理
    ENDIF.

  ENDMETHOD.


  METHOD find_tables.

    DATA: ls_tab   TYPE ty_table,
          lt_names TYPE STANDARD TABLE OF zai_auth_tab WITH DEFAULT KEY.

    CLEAR: et_tables, ev_error.

    " 1) 规则指定了表 → 只写这一张; V1.2: 规则有自己的字段映射时按规则映射写
    IF is_rule-tabname IS NOT INITIAL.
      load_table( EXPORTING iv_tabname     = is_rule-tabname
                            iv_need_active = abap_true
                  IMPORTING es_table       = ls_tab
                            ev_error       = ev_error ).
      IF ev_error IS INITIAL.
        apply_rule_map( EXPORTING iv_tcode_pat = is_rule-tcode_pat
                        IMPORTING ev_error     = ev_error
                        CHANGING  cs_table     = ls_tab ).
      ENDIF.
      IF ev_error IS INITIAL.
        APPEND ls_tab TO et_tables.
      ENDIF.
      RETURN.
    ENDIF.

    " 2) 自动发现: 已登记、启用、参与发现的表里, 该事务码出现过的表
    SELECT * FROM zai_auth_tab WHERE active = 'X' AND discover = 'X' ORDER BY tabname INTO TABLE @lt_names.
    LOOP AT lt_names INTO DATA(ls_n).
      load_table( EXPORTING iv_tabname     = CONV string( ls_n-tabname )
                            iv_need_active = abap_true
                  IMPORTING es_table       = ls_tab
                            ev_error       = ev_error ).
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
      IF tcode_known( is_table = ls_tab iv_tcode = iv_tcode ) = abap_true.
        APPEND ls_tab TO et_tables.
      ENDIF.
    ENDLOOP.

    IF et_tables IS INITIAL.
      ev_error = '该事务码尚未配置权限表，请联系 IT'.
    ENDIF.

  ENDMETHOD.


  METHOD tcode_known.

    DATA: lr_found TYPE REF TO data,
          lv_where TYPE string,
          lv_q     TYPE string.
    FIELD-SYMBOLS <found> TYPE any.

    " V1.1: TCODE 映射可以有多列, 任一列里有这个事务码就算(列太短 / 名字不合法的跳过)
    lv_q = quote( iv_tcode ).
    LOOP AT is_table-fields INTO DATA(ls_f) WHERE map_type = 'TCODE'.
      IF strlen( iv_tcode ) > ls_f-leng OR safe_name( ls_f-fieldname ) = abap_false.
        CONTINUE.
      ENDIF.
      IF lv_where IS INITIAL.
        lv_where = |{ ls_f-fieldname } = { lv_q }|.
      ELSE.
        lv_where = lv_where && | OR { ls_f-fieldname } = { lv_q }|.
      ENDIF.
    ENDLOOP.
    IF lv_where IS INITIAL.
      RETURN.
    ENDIF.
    CREATE DATA lr_found TYPE (is_table-tabname).
    ASSIGN lr_found->* TO <found>.
    SELECT SINGLE * FROM (is_table-tabname) INTO @<found> WHERE (lv_where).
    rv = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  METHOD check_fmap.

    DATA: lt_fields TYPE tt_field,
          lt_in     TYPE tt_fmap_in,
          lv_json   TYPE string,
          lv_users  TYPE i,
          lv_tcodes TYPE i,
          lv_const  TYPE string,
          lv_rule   TYPE string,
          lt_part   TYPE tt_rpart,
          lv_perr   TYPE string,
          lv_digits TYPE string VALUE '0123456789'.

    CLEAR: et_map, ev_error.
    read_fields( EXPORTING iv_tabname = iv_tabname
                 IMPORTING et_fields  = lt_fields
                           ev_error   = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.

    lv_json = condense( iv_fmap_json ).
    IF lv_json NP '[*'.
      ev_error = '字段映射必须是 JSON 数组'.
      RETURN.
    ENDIF.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json = lv_json CHANGING data = lt_in ).
      CATCH cx_root.
        ev_error = '字段映射 JSON 无法解析'.
        RETURN.
    ENDTRY.
    IF lines( lt_in ) <> lines( lt_fields ).
      ev_error = '必须提交每个字段的映射(MANDT 除外)'.
      RETURN.
    ENDIF.

    LOOP AT lt_in INTO DATA(ls_in).
      READ TABLE lt_fields INTO DATA(ls_f) WITH KEY fieldname = ls_in-f.
      IF sy-subrc <> 0.
        ev_error = |字段 { ls_in-f } 不在表结构里(字段名只能来自 DDIC)|.
        EXIT.
      ENDIF.
      READ TABLE et_map TRANSPORTING NO FIELDS WITH KEY fieldname = ls_in-f.
      IF sy-subrc = 0.
        ev_error = |字段 { ls_in-f } 重复|.
        EXIT.
      ENDIF.
      CASE ls_in-t.
        WHEN 'TCODE'.
          lv_tcodes = lv_tcodes + 1.
        WHEN 'USER'.
          lv_users = lv_users + 1.
        WHEN 'WERKS' OR 'CONST' OR 'RANDOM' OR 'SEQ' OR 'RULE' OR 'DATE' OR 'TIME' OR 'BY' OR 'INITIAL'.
          " 合法
        WHEN OTHERS.
          ev_error = |字段 { ls_in-f } 的映射类型不合法: { ls_in-t }|.
          EXIT.
      ENDCASE.
      IF ls_in-t <> 'INITIAL'.
        IF ls_f-datatype <> 'CHAR' AND ls_f-datatype <> 'NUMC'
           AND ls_f-datatype <> 'DATS' AND ls_f-datatype <> 'TIMS'.
          ev_error = |字段 { ls_in-f } 的类型 { ls_f-datatype } 不支持写入映射, 只支持 CHAR / NUMC / DATS / TIMS|.
          EXIT.
        ENDIF.
        IF ( ls_in-t = 'DATE' AND ls_f-leng < 8 ) OR ( ls_in-t = 'TIME' AND ls_f-leng < 6 ).
          ev_error = |字段 { ls_in-f } 太短, 放不下日期 / 时间|.
          EXIT.
        ENDIF.
      ENDIF.
      IF ls_in-t = 'RANDOM' AND ( ( ls_f-datatype <> 'CHAR' AND ls_f-datatype <> 'NUMC' ) OR ls_f-leng < 1 ).
        ev_error = |字段 { ls_in-f } 的随机值只支持长度大于 0 的 CHAR / NUMC 字段|.
        EXIT.
      ENDIF.
      " V1.5: 递增序号 / 规则组合的参数在保存时就校验(写法、位数、最短长度、NUMC 只能出数字)
      IF ls_in-t = 'SEQ' OR ls_in-t = 'RULE'.
        ev_error = check_rule( is_field = ls_f iv_type = ls_in-t iv_c = ls_in-c ).
        IF ev_error IS NOT INITIAL.
          ev_error = |字段 { ls_in-f }: { ev_error }|.
          EXIT.
        ENDIF.
      ENDIF.
      lv_const = condense( ls_in-c ).
      lv_rule  = ls_in-c.
      SHIFT lv_rule LEFT DELETING LEADING space.
      " 规则存成规范写法(占位大写、去掉花括号里的空格), 碰撞判断与界面显示都按它
      IF ls_in-t = 'RULE'.
        parse_rule( EXPORTING iv_tpl = lv_rule IMPORTING et_part = lt_part ev_error = lv_perr ).
        CLEAR lv_rule.
        LOOP AT lt_part INTO DATA(ls_part).
          IF ls_part-tok IS INITIAL.
            lv_rule = lv_rule && ls_part-lit.
          ELSEIF ls_part-n > 0.
            lv_rule = lv_rule && `{` && ls_part-tok && |{ ls_part-n }| && `}`.
          ELSE.
            lv_rule = lv_rule && `{` && ls_part-tok && `}`.
          ENDIF.
        ENDLOOP.
      ENDIF.
      IF ls_in-t = 'CONST'.
        IF lv_const IS INITIAL.
          ev_error = |字段 { ls_in-f } 选了固定值, 但没填值|.
          EXIT.
        ENDIF.
        IF strlen( lv_const ) > ls_f-leng OR strlen( lv_const ) > 60.
          ev_error = |字段 { ls_in-f } 的固定值过长|.
          EXIT.
        ENDIF.
        IF ( ls_f-datatype = 'NUMC' OR ls_f-datatype = 'DATS' OR ls_f-datatype = 'TIMS' )
           AND lv_const CN lv_digits.
          ev_error = |字段 { ls_in-f } 的固定值必须是数字|.
          EXIT.
        ENDIF.
      ENDIF.
      " 主键必须有明确映射, 否则会写出"半条"权限
      IF ls_f-keyflag = 'X' AND ls_in-t = 'INITIAL'.
        ev_error = |主键字段 { ls_in-f } 必须配置映射(留空不允许)|.
        EXIT.
      ENDIF.
      APPEND VALUE #( fieldname = ls_in-f
                      map_type  = ls_in-t
                      const_val = COND #( WHEN ls_in-t = 'CONST' OR ls_in-t = 'SEQ' THEN lv_const
                                          WHEN ls_in-t = 'RULE' THEN lv_rule
                                          ELSE `` ) ) TO et_map.
    ENDLOOP.

    " V1.1: 同类映射可以配到多个字段(写入同一个值); 只要求至少有一个 USER
    IF ev_error IS INITIAL AND lv_users < 1.
      ev_error = '至少要有一个 USER(目标账号)映射'.
    ENDIF.
    IF ev_error IS INITIAL AND iv_need_tcode = abap_true AND lv_tcodes < 1.
      ev_error = '参与自动发现的表必须有 TCODE 映射'.
    ENDIF.
    IF ev_error IS NOT INITIAL.
      CLEAR et_map.
    ENDIF.

  ENDMETHOD.


  METHOD apply_rule_map.

    DATA lt_map TYPE STANDARD TABLE OF zai_auth_rmap WITH DEFAULT KEY.

    CLEAR: ev_own, ev_error.
    IF iv_tcode_pat IS INITIAL OR cs_table-tabname IS INITIAL.
      RETURN.
    ENDIF.
    " 只认保存时就指向这张表的映射(规则换表时 save_rule 已清掉旧映射, 这里再兜一层)
    SELECT * FROM zai_auth_rmap
      WHERE tcode_pat = @iv_tcode_pat AND tabname = @cs_table-tabname
      INTO TABLE @lt_map.
    IF lt_map IS INITIAL.
      RETURN.                             " 没有自己的映射: 沿用权限表的
    ENDIF.
    ev_own = abap_true.
    " 规则映射是整份: 当前表结构的每个字段都要有(与 load_table 对权限表映射的要求相同)
    LOOP AT cs_table-fields ASSIGNING FIELD-SYMBOL(<ls_f>).
      READ TABLE lt_map INTO DATA(ls_m) WITH KEY fieldname = <ls_f>-fieldname.
      IF sy-subrc <> 0.
        ev_error = |规则 { iv_tcode_pat } 的字段映射缺少字段 { <ls_f>-fieldname }(权限表结构已变化)，请 IT 重新保存该规则|.
        RETURN.
      ENDIF.
      <ls_f>-map_type  = ls_m-map_type.
      <ls_f>-const_val = ls_m-const_val.
    ENDLOOP.

  ENDMETHOD.


  "=====================================================================
  " 组行 / 组条件
  "=====================================================================

  METHOD random_value.

    DATA: lo_random   TYPE REF TO cl_abap_random_int,
          lv_alphabet TYPE string VALUE '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          lv_offset   TYPE i.

    CLEAR: ev_value, ev_error.
    IF ( iv_datatype <> 'CHAR' AND iv_datatype <> 'NUMC' ) OR iv_length < 1.
      ev_error = '随机值只支持长度大于 0 的 CHAR / NUMC 字段'.
      RETURN.
    ENDIF.
    TRY.
        IF iv_datatype = 'NUMC'.
          IF go_random_num IS NOT BOUND.
            go_random_num = cl_abap_random_int=>create( seed = cl_abap_random=>seed( ) min = 0 max = 9 ).
          ENDIF.
          lo_random = go_random_num.
        ELSE.
          IF go_random_char IS NOT BOUND.
            go_random_char = cl_abap_random_int=>create( seed = cl_abap_random=>seed( ) min = 0 max = 35 ).
          ENDIF.
          lo_random = go_random_char.
        ENDIF.
        " 按字符拼接, 不把整串转成整数; 长 NUMC 与前导零都能完整保留。
        DO iv_length TIMES.
          lv_offset = lo_random->get_next( ).
          ev_value = ev_value && lv_alphabet+lv_offset(1).
        ENDDO.
      CATCH cx_abap_random.
        CLEAR ev_value.
        ev_error = '随机值生成失败，请重试'.
    ENDTRY.

  ENDMETHOD.


  METHOD parse_rule.

    DATA: lv_len  TYPE i,
          lv_i    TYPE i,
          lv_ch   TYPE string,
          lv_lit  TYPE string,
          lv_tok  TYPE string,
          lv_in   TYPE abap_bool,
          lv_name TYPE string,
          lv_num  TYPE string,
          lv_n    TYPE i,
          lv_seqs TYPE i.

    CLEAR: et_part, ev_error.
    lv_len = strlen( iv_tpl ).
    WHILE lv_i < lv_len.
      lv_ch = substring( val = iv_tpl off = lv_i len = 1 ).
      lv_i = lv_i + 1.
      IF lv_in = abap_false.
        IF lv_ch = '{'.
          IF lv_lit IS NOT INITIAL.
            APPEND VALUE #( lit = lv_lit ) TO et_part.
            CLEAR lv_lit.
          ENDIF.
          lv_in = abap_true.
          CLEAR lv_tok.
        ELSEIF lv_ch = '}'.
          ev_error = '规则里的花括号没有配对'.
          RETURN.
        ELSE.
          lv_lit = lv_lit && lv_ch.
        ENDIF.
        CONTINUE.
      ENDIF.
      IF lv_ch = '{'.
        ev_error = '规则里的花括号没有配对'.
        RETURN.
      ENDIF.
      IF lv_ch <> '}'.
        lv_tok = lv_tok && lv_ch.
        CONTINUE.
      ENDIF.
      lv_in = abap_false.
      lv_tok = to_upper( condense( lv_tok ) ).
      CLEAR: lv_name, lv_num, lv_n.
      FIND REGEX '^(SEQ|RAND|NUM)([0-9]{1,2})$' IN lv_tok SUBMATCHES lv_name lv_num.
      IF sy-subrc = 0.
        lv_n = lv_num.
        IF lv_n < 1 OR lv_n > 32 OR ( lv_name = 'SEQ' AND lv_n > 20 ).
          ev_error = |{ lv_tok } 的位数不对(序号 1-20 位, 随机 1-32 位)|.
          RETURN.
        ENDIF.
        IF lv_name = 'SEQ'.
          lv_seqs = lv_seqs + 1.
        ENDIF.
      ELSEIF lv_tok = 'DATE' OR lv_tok = 'TIME' OR lv_tok = 'USER' OR lv_tok = 'TCODE'
          OR lv_tok = 'WERKS' OR lv_tok = 'BY'.
        lv_name = lv_tok.
      ELSE.
        ev_error = |规则里有不认识的占位 { lv_tok }(可用 SEQn RANDn NUMn DATE TIME USER TCODE WERKS BY)|.
        RETURN.
      ENDIF.
      APPEND VALUE #( tok = lv_name n = lv_n ) TO et_part.
    ENDWHILE.
    IF lv_in = abap_true.
      ev_error = '规则里的花括号没有配对'.
      RETURN.
    ENDIF.
    IF lv_lit IS NOT INITIAL.
      APPEND VALUE #( lit = lv_lit ) TO et_part.
    ENDIF.
    IF lv_seqs > 1.
      ev_error = '一条规则里只能有一个递增序号 SEQn'.
    ENDIF.

  ENDMETHOD.


  METHOD check_rule.

    DATA: lt_part   TYPE tt_rpart,
          lv_c      TYPE string,
          lv_err    TYPE string,
          lv_min    TYPE i,
          lv_digits TYPE string VALUE '0123456789'.

    CLEAR rv.
    IF ( is_field-datatype <> 'CHAR' AND is_field-datatype <> 'NUMC' ) OR is_field-leng < 1.
      rv = '递增序号 / 规则组合只支持 CHAR / NUMC 字段'.
      RETURN.
    ENDIF.
    IF iv_type = 'SEQ'.
      " 起始值可空(从 1 开始, 位数 = 字段长度, 最多 10 位); 填了就只能是数字, 位数 = 补零位数
      lv_c = condense( iv_c ).
      IF lv_c IS INITIAL.
        RETURN.
      ENDIF.
      IF lv_c CN lv_digits.
        rv = '递增序号的起始值只能填数字(如 0001)'.
      ELSEIF strlen( lv_c ) > 20 OR strlen( lv_c ) > is_field-leng.
        rv = |起始值位数超过字段长度 { is_field-leng }(最多 20 位)|.
      ENDIF.
      RETURN.
    ENDIF.

    lv_c = iv_c.
    SHIFT lv_c LEFT DELETING LEADING space.
    IF lv_c IS INITIAL.
      rv = '选了按规则组合, 但没填规则'.
      RETURN.
    ENDIF.
    IF strlen( lv_c ) > 60.
      rv = '规则不能超过 60 个字符'.
      RETURN.
    ENDIF.
    parse_rule( EXPORTING iv_tpl = lv_c IMPORTING et_part = lt_part ev_error = lv_err ).
    IF lv_err IS NOT INITIAL.
      rv = lv_err.
      RETURN.
    ENDIF.
    LOOP AT lt_part INTO DATA(ls_p).
      IF ls_p-tok IS INITIAL.
        lv_min = lv_min + strlen( ls_p-lit ).
        IF is_field-datatype = 'NUMC' AND ls_p-lit CN lv_digits.
          rv = 'NUMC 字段的规则里, 文字部分只能是数字'.
          RETURN.
        ENDIF.
        CONTINUE.
      ENDIF.
      CASE ls_p-tok.
        WHEN 'SEQ' OR 'RAND' OR 'NUM'.
          lv_min = lv_min + ls_p-n.
        WHEN 'DATE'.
          lv_min = lv_min + 8.
        WHEN 'TIME'.
          lv_min = lv_min + 6.
        WHEN OTHERS.
          lv_min = lv_min + 1.            " 账号 / 事务码 / 工厂 / 操作人: 实际长度写入时再查
      ENDCASE.
      IF is_field-datatype = 'NUMC' AND ls_p-tok <> 'SEQ' AND ls_p-tok <> 'NUM'
         AND ls_p-tok <> 'DATE' AND ls_p-tok <> 'TIME'.
        rv = |NUMC 字段的规则只能用 SEQn / NUMn / DATE / TIME, 不能用 { ls_p-tok }|.
        RETURN.
      ENDIF.
    ENDLOOP.
    IF lv_min > is_field-leng.
      rv = |规则生成的值至少 { lv_min } 位, 超过字段长度 { is_field-leng }|.
    ENDIF.

  ENDMETHOD.


  METHOD gen_value.

    DATA: lt_part  TYPE tt_rpart,
          lv_c     TYPE string,
          lv_piece TYPE string,
          lv_like  TYPE string,
          lv_pre   TYPE string,
          lv_post  TYPE string,
          lv_lpre  TYPE string,
          lv_lpost TYPE string,
          lv_seen  TYPE abap_bool,
          lv_width TYPE i,
          lv_start TYPE ty_seqnum,
          lv_max   TYPE ty_seqnum,
          lv_next  TYPE ty_seqnum,
          lv_limit TYPE ty_seqnum,
          lv_found TYPE abap_bool,
          lv_seq   TYPE string.

    CLEAR: ev_value, ev_error.
    lv_start = 1.
    IF is_field-map_type = 'SEQ'.
      lv_c = condense( is_field-const_val ).
      IF lv_c IS INITIAL.
        lv_width = nmin( val1 = is_field-leng val2 = 10 ).
      ELSE.
        lv_width = strlen( lv_c ).
        lv_start = lv_c.
      ENDIF.
      APPEND VALUE #( tok = 'SEQ' n = lv_width ) TO lt_part.
    ELSE.
      parse_rule( EXPORTING iv_tpl = is_field-const_val IMPORTING et_part = lt_part ev_error = ev_error ).
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
    ENDIF.

    LOOP AT lt_part INTO DATA(ls_p).
      CLEAR: lv_piece, lv_like.
      CASE ls_p-tok.
        WHEN 'SEQ'.
          lv_seen  = abap_true.
          lv_width = ls_p-n.
          CONTINUE.
        WHEN 'RAND'.
          random_value( EXPORTING iv_datatype = 'CHAR' iv_length = ls_p-n
                        IMPORTING ev_value = lv_piece ev_error = ev_error ).
        WHEN 'NUM'.
          random_value( EXPORTING iv_datatype = 'NUMC' iv_length = ls_p-n
                        IMPORTING ev_value = lv_piece ev_error = ev_error ).
        WHEN 'DATE'.
          lv_piece = sy-datum.
        WHEN 'TIME'.
          lv_piece = sy-uzeit.
        WHEN 'USER'.
          lv_piece = iv_user.
        WHEN 'TCODE'.
          lv_piece = iv_tcode.
        WHEN 'WERKS'.
          lv_piece = iv_werks.
        WHEN 'BY'.
          lv_piece = sy-uname.
        WHEN OTHERS.
          lv_piece = ls_p-lit.
      ENDCASE.
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
      " 找"同格式"的已有值: 每次会变的段(随机 / 时间)按位数用 _ 通配, 其余原样(转义)
      IF ls_p-tok = 'RAND' OR ls_p-tok = 'NUM' OR ls_p-tok = 'TIME'.
        lv_like = repeat( val = `_` occ = strlen( lv_piece ) ).
      ELSE.
        lv_like = like_escape( lv_piece ).
      ENDIF.
      IF lv_seen = abap_false.
        lv_pre  = lv_pre && lv_piece.
        lv_lpre = lv_lpre && lv_like.
      ELSE.
        lv_post  = lv_post && lv_piece.
        lv_lpost = lv_lpost && lv_like.
      ENDIF.
    ENDLOOP.

    IF lv_seen = abap_false.
      ev_value = lv_pre.
      RETURN.
    ENDIF.

    " 序号 = 同前缀 / 同后缀格式的现有值里, 序号那几位的最大值 + 1(不小于起始值)
    seq_max( EXPORTING iv_tabname   = is_table-tabname
                       iv_fieldname = is_field-fieldname
                       iv_like      = lv_lpre && repeat( val = `_` occ = lv_width ) && lv_lpost
                       iv_off       = strlen( lv_pre )
                       iv_len       = lv_width
             IMPORTING ev_max       = lv_max
                       ev_found     = lv_found
                       ev_error     = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    lv_next = lv_start.
    IF lv_found = abap_true AND lv_max + 1 > lv_next.
      lv_next = lv_max + 1.
    ENDIF.
    lv_limit = 1.
    DO lv_width TIMES.
      lv_limit = lv_limit * 10.
    ENDDO.
    IF lv_next >= lv_limit.
      ev_error = |递增序号已用到 { lv_width } 位上限, 请加长位数|.
      RETURN.
    ENDIF.
    lv_seq = |{ lv_next }|.
    WHILE strlen( lv_seq ) < lv_width.
      lv_seq = `0` && lv_seq.
    ENDWHILE.
    ev_value = lv_pre && lv_seq && lv_post.

  ENDMETHOD.


  METHOD like_escape.
    " LIKE 用 # 作转义符: # _ % 前面各加一个 #(先转 #, 否则会重复转义)
    rv = iv.
    REPLACE ALL OCCURRENCES OF `#` IN rv WITH `##`.
    REPLACE ALL OCCURRENCES OF `_` IN rv WITH `#_`.
    REPLACE ALL OCCURRENCES OF `%` IN rv WITH `#%`.
  ENDMETHOD.


  METHOD build_row.

    FIELD-SYMBOLS: <row> TYPE any, <val> TYPE any, <conv> TYPE any.
    DATA: lv_value TYPE string,
          lr_conv  TYPE REF TO data,
          lv_fm    TYPE rs38l_fnam,
          lv_digits TYPE string VALUE '0123456789'.

    CLEAR: er_row, ev_error.
    CREATE DATA er_row TYPE (is_table-tabname).
    ASSIGN er_row->* TO <row>.
    ASSIGN COMPONENT 'MANDT' OF STRUCTURE <row> TO <val>.
    IF sy-subrc = 0.
      <val> = sy-mandt.
    ENDIF.

    LOOP AT is_table-fields INTO DATA(ls_f).
      CLEAR lv_value.
      CASE ls_f-map_type.
        WHEN 'TCODE'.
          lv_value = iv_tcode.
        WHEN 'USER'.
          lv_value = iv_user.
        WHEN 'WERKS'.
          lv_value = iv_werks.
        WHEN 'CONST'.
          lv_value = ls_f-const_val.
        WHEN 'RANDOM'.
          random_value( EXPORTING iv_datatype = ls_f-datatype iv_length = ls_f-leng
                        IMPORTING ev_value = lv_value ev_error = ev_error ).
          IF ev_error IS NOT INITIAL.
            ev_error = |字段 { ls_f-fieldname }: { ev_error }|.
            RETURN.
          ENDIF.
        WHEN 'SEQ' OR 'RULE'.
          " V1.5: 递增序号要读目标表当前最大值, 必须在本行写入前现算(批量时逐行算)
          gen_value( EXPORTING is_table = is_table is_field = ls_f
                               iv_tcode = iv_tcode iv_user = iv_user iv_werks = iv_werks
                     IMPORTING ev_value = lv_value ev_error = ev_error ).
          IF ev_error IS NOT INITIAL.
            ev_error = |字段 { ls_f-fieldname }: { ev_error }|.
            RETURN.
          ENDIF.
        WHEN 'DATE'.
          lv_value = sy-datum.
        WHEN 'TIME'.
          lv_value = sy-uzeit.
        WHEN 'BY'.
          lv_value = sy-uname.
        WHEN OTHERS.
          CONTINUE.                       " INITIAL: 留空
      ENDCASE.

      " 值超长拒绝而不是截断(截断会写进一条错误的权限)
      IF strlen( lv_value ) > ls_f-leng.
        ev_error = |字段 { ls_f-fieldname } 的值超过长度 { ls_f-leng }, 拒绝截断|.
        RETURN.
      ENDIF.
      IF ( ls_f-datatype = 'NUMC' OR ls_f-datatype = 'DATS' OR ls_f-datatype = 'TIMS' )
         AND lv_value IS NOT INITIAL AND lv_value CN lv_digits.
        ev_error = |字段 { ls_f-fieldname } 的值必须是数字|.
        RETURN.
      ENDIF.
      ASSIGN COMPONENT ls_f-fieldname OF STRUCTURE <row> TO <val>.
      IF sy-subrc <> 0.
        ev_error = |表结构已变化, 找不到字段 { ls_f-fieldname }|.
        RETURN.
      ENDIF.

      " 转换例程(如 ALPHA): 先转成内部格式, 输出按 DDIC 长度分配
      IF ls_f-convexit IS NOT INITIAL AND lv_value IS NOT INITIAL AND ls_f-leng > 0.
        CREATE DATA lr_conv TYPE c LENGTH ls_f-leng.
        ASSIGN lr_conv->* TO <conv>.
        CONCATENATE 'CONVERSION_EXIT_' ls_f-convexit '_INPUT' INTO lv_fm.
        CALL FUNCTION lv_fm
          EXPORTING
            input  = lv_value
          IMPORTING
            output = <conv>
          EXCEPTIONS
            OTHERS = 1.
        IF sy-subrc <> 0.
          ev_error = |字段 { ls_f-fieldname } 的转换例程 { ls_f-convexit } 执行失败|.
          RETURN.
        ENDIF.
        lv_value = <conv>.
      ENDIF.
      <val> = lv_value.
    ENDLOOP.

  ENDMETHOD.


  METHOD build_where.

    FIELD-SYMBOLS: <row> TYPE any, <val> TYPE any.
    DATA: lv_cond TYPE string,
          lv_q    TYPE string.

    CLEAR: ev_where, ev_error.
    ASSIGN ir_row->* TO <row>.
    LOOP AT is_table-fields INTO DATA(ls_f).
      IF ls_f-map_type <> 'TCODE' AND ls_f-map_type <> 'USER' AND ls_f-map_type <> 'WERKS'.
        CONTINUE.
      ENDIF.
      IF safe_name( ls_f-fieldname ) = abap_false.
        ev_error = |字段名不合法: { ls_f-fieldname }|.
        RETURN.
      ENDIF.
      ASSIGN COMPONENT ls_f-fieldname OF STRUCTURE <row> TO <val>.
      IF sy-subrc <> 0.
        ev_error = |表结构已变化, 找不到字段 { ls_f-fieldname }|.
        RETURN.
      ENDIF.
      lv_q = quote( CONV string( <val> ) ).
      IF ls_f-map_type = 'WERKS'.
        " 已有该工厂的权限, 或已有 ALL(全部工厂), 都算"已有"
        lv_cond = |( { ls_f-fieldname } = { lv_q } OR { ls_f-fieldname } = 'ALL' )|.
      ELSE.
        lv_cond = |{ ls_f-fieldname } = { lv_q }|.
      ENDIF.
      IF ev_where IS INITIAL.
        ev_where = lv_cond.
      ELSE.
        ev_where = ev_where && ` AND ` && lv_cond.
      ENDIF.
    ENDLOOP.
    IF ev_where IS INITIAL.
      ev_error = '权限表没有可用于查重的映射字段'.
    ENDIF.

  ENDMETHOD.


  "=====================================================================
  " 唯一写目标权限表的两个方法(grant_row / revoke_row)与查重(row_exists)、取序号(seq_max, 只读);
  " 另外只有 tcode_known 只读查目标表(自动发现)
  "=====================================================================

  METHOD row_exists.

    DATA: lv_where TYPE string,
          lr_found TYPE REF TO data.
    FIELD-SYMBOLS <found> TYPE any.

    CLEAR: ev_found, ev_error.
    build_where( EXPORTING is_table = is_table
                           ir_row   = ir_row
                 IMPORTING ev_where = lv_where
                           ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    CREATE DATA lr_found TYPE (is_table-tabname).
    ASSIGN lr_found->* TO <found>.
    SELECT SINGLE * FROM (is_table-tabname) INTO @<found> WHERE (lv_where).
    ev_found = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  METHOD seq_max.

    DATA: lr_vals  TYPE REF TO data,
          lv_type  TYPE string,
          lv_where TYPE string,
          lv_v     TYPE string,
          lv_slice TYPE string,
          lv_num   TYPE ty_seqnum.
    FIELD-SYMBOLS: <lt_vals> TYPE STANDARD TABLE,
                   <lv_val>  TYPE any.

    CLEAR: ev_max, ev_found, ev_error.
    IF safe_name( iv_tabname ) = abap_false OR safe_name( iv_fieldname ) = abap_false.
      ev_error = '表名或字段名不合法'.
      RETURN.
    ENDIF.
    " 只读: 取该列符合格式的现有值(同一 LUW 里本批刚写入的行也读得到)
    lv_type  = |{ iv_tabname }-{ iv_fieldname }|.
    lv_where = |{ iv_fieldname } LIKE { quote( iv_like ) } ESCAPE '#'|.
    TRY.
        CREATE DATA lr_vals TYPE STANDARD TABLE OF (lv_type) WITH DEFAULT KEY.
        ASSIGN lr_vals->* TO <lt_vals>.
        SELECT (iv_fieldname) FROM (iv_tabname) WHERE (lv_where) INTO TABLE @<lt_vals>.
      CATCH cx_root INTO DATA(lx).
        ev_error = |读取 { iv_tabname }-{ iv_fieldname } 的现有序号失败: { lx->get_text( ) }|.
        RETURN.
    ENDTRY.
    LOOP AT <lt_vals> ASSIGNING <lv_val>.
      lv_v = <lv_val>.
      IF strlen( lv_v ) < iv_off + iv_len.
        CONTINUE.
      ENDIF.
      lv_slice = substring( val = lv_v off = iv_off len = iv_len ).
      IF lv_slice CN '0123456789'.
        CONTINUE.
      ENDIF.
      lv_num = lv_slice.
      IF ev_found = abap_false OR lv_num > ev_max.
        ev_max   = lv_num.
        ev_found = abap_true.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD grant_row.

    DATA lt_keys TYPE tt_key.
    FIELD-SYMBOLS: <row> TYPE any, <val> TYPE any.

    CLEAR: ev_status, ev_key_json, ev_error.
    ASSIGN ir_row->* TO <row>.

    " 授权时记下全部主键(客户端字段除外), 撤销时只按它删, 不用当前映射重算
    LOOP AT is_table-fields INTO DATA(ls_f) WHERE keyflag = 'X'.
      ASSIGN COMPONENT ls_f-fieldname OF STRUCTURE <row> TO <val>.
      IF sy-subrc = 0.
        APPEND VALUE #( f = ls_f-fieldname v = CONV string( <val> ) ) TO lt_keys.
      ENDIF.
    ENDLOOP.
    IF lt_keys IS INITIAL.
      ev_error = '权限表没有主键字段, 拒绝写入'.
      RETURN.
    ENDIF.

    INSERT (is_table-tabname) FROM <row>.
    CASE sy-subrc.
      WHEN 0.
        ev_status   = 'DONE'.
        ev_key_json = /ui2/cl_json=>serialize( data        = lt_keys
                                               compress    = abap_false
                                               pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
      WHEN 4.
        " V1.5: 主键里有"每次都会变"的生成值(随机 / 序号 / 含随机或序号的规则)时, 碰撞是
        " 生成冲突(并发或随机撞上), 不是"已有权限"; 纯文字 / 账号拼出来的规则碰撞仍算已有
        LOOP AT is_table-fields INTO ls_f WHERE keyflag = 'X'.
          IF ls_f-map_type = 'RANDOM' OR ls_f-map_type = 'SEQ'
             OR ( ls_f-map_type = 'RULE' AND ( ls_f-const_val CS '{SEQ' OR ls_f-const_val CS '{RAND'
                                               OR ls_f-const_val CS '{NUM' OR ls_f-const_val CS '{TIME' ) ).
            ev_error = '随机值 / 递增序号与现有主键冲突(可能有人同时写入)，请重试；随机值可加长位数'.
            EXIT.
          ENDIF.
        ENDLOOP.
        IF ev_error IS INITIAL.
          ev_status = 'EXISTS'.           " 主键已存在(并发或字段映射没覆盖到)
        ENDIF.
      WHEN OTHERS.
        ev_error = '权限写入失败'.
    ENDCASE.

  ENDMETHOD.


  METHOD revoke_row.

    DATA: ls_tab   TYPE ty_table,
          lt_keys  TYPE tt_key,
          lv_where TYPE string,
          lv_cond  TYPE string,
          lv_n     TYPE i.

    CLEAR: ev_removed, ev_error.
    load_table( EXPORTING iv_tabname     = CONV string( is_req-tabname )
                          iv_need_active = abap_false
                IMPORTING es_table       = ls_tab
                          ev_error       = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json        = is_req-key_json
                                             pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                   CHANGING  data        = lt_keys ).
      CATCH cx_root.
        ev_error = '原始主键记录无法解析, 拒绝撤销'.
        RETURN.
    ENDTRY.

    " 表的每个主键字段都必须在原始记录里; 数量也要一致, 防止结构变了之后误删
    LOOP AT ls_tab-fields INTO DATA(ls_f) WHERE keyflag = 'X'.
      lv_n = lv_n + 1.
      READ TABLE lt_keys INTO DATA(ls_k) WITH KEY f = ls_f-fieldname.
      IF sy-subrc <> 0 OR strlen( ls_k-v ) > ls_f-leng OR safe_name( ls_f-fieldname ) = abap_false.
        ev_error = '原始主键与当前表结构不一致, 拒绝撤销'.
        RETURN.
      ENDIF.
      lv_cond = |{ ls_f-fieldname } = { quote( ls_k-v ) }|.
      IF lv_where IS INITIAL.
        lv_where = lv_cond.
      ELSE.
        lv_where = lv_where && ` AND ` && lv_cond.
      ENDIF.
    ENDLOOP.
    IF lv_n = 0 OR lv_n <> lines( lt_keys ) OR lv_where IS INITIAL.
      ev_error = '原始主键不完整, 拒绝撤销'.
      RETURN.
    ENDIF.

    DELETE FROM (is_req-tabname) WHERE (lv_where).
    ev_removed = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  "=====================================================================
  " 小工具
  "=====================================================================

  METHOD gate.

    IF iv_need_enabled = abap_true AND enabled( ) = abap_false.
      rv_error = '权限自助申请尚未启用，请联系 IT'.
      RETURN.
    ENDIF.
    DATA(lv_role) = zcl_ai_chat_service=>v8_get_role( ).
    IF lv_role IS INITIAL.
      rv_error = '当前 SAP 账号未开通 Gale-SAP，请联系管理员'.
      RETURN.
    ENDIF.
    IF iv_admin = abap_true AND lv_role <> 'ADMIN'.
      rv_error = '该操作仅管理员可执行'.
    ENDIF.

  ENDMETHOD.


  METHOD now14.
    CONCATENATE sy-datum sy-uzeit INTO rv.
  ENDMETHOD.


  METHOD quote.
    " 动态 WHERE 里的字符串字面量: 单引号写成两个, 外面再包一对
    rv = iv.
    REPLACE ALL OCCURRENCES OF `'` IN rv WITH `''`.
    rv = `'` && rv && `'`.
  ENDMETHOD.


  METHOD safe_name.
    " 字段名来自 DDIC, 这里再过一道字符集(含命名空间斜杠), 防止拼进 WHERE 的名字带别的东西
    rv = xsdbool( iv IS NOT INITIAL AND strlen( iv ) <= 30
                  AND iv CO 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/' ).
  ENDMETHOD.


  METHOD split_values.

    DATA(lv) = to_upper( iv_values ).
    REPLACE ALL OCCURRENCES OF REGEX '[,，;；\s]+' IN lv WITH ','.
    SPLIT lv AT ',' INTO TABLE rt.
    DELETE rt WHERE table_line IS INITIAL.
    SORT rt.
    DELETE ADJACENT DUPLICATES FROM rt.

  ENDMETHOD.


  METHOD valid_user.

    IF iv_user IS INITIAL OR strlen( iv_user ) > 12.
      RETURN.
    ENDIF.
    SELECT SINGLE bname FROM usr02
      WHERE bname = @iv_user AND uflag = 0
        AND ( gltgv = '00000000' OR gltgv <= @sy-datum )
        AND ( gltgb = '00000000' OR gltgb >= @sy-datum )
      INTO @DATA(lv_bname).
    rv = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  METHOD valid_request.

    DATA lv_reason TYPE string.

    CLEAR: et_plants, ev_error.
    IF iv_tcode IS INITIAL OR strlen( iv_tcode ) > 20
       OR iv_tcode CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/'.
      ev_error = '事务码格式不合法'.
      RETURN.
    ENDIF.
    SELECT SINGLE tcode FROM tstc WHERE tcode = @iv_tcode INTO @DATA(lv_tc).
    IF sy-subrc <> 0.
      ev_error = |事务码 { iv_tcode } 不存在|.
      RETURN.
    ENDIF.
    lv_reason = condense( iv_reason ).
    IF lv_reason IS INITIAL OR strlen( iv_reason ) > 255.
      ev_error = '申请原因必填，最多 255 字'.
      RETURN.
    ENDIF.
    et_plants = split_values( iv_werks_list ).
    IF et_plants IS INITIAL AND iv_plants_optional = abap_true.
      RETURN.                             " 不按工厂控制的表: 申请记录里工厂为空
    ENDIF.
    IF et_plants IS INITIAL OR lines( et_plants ) > 50.
      ev_error = '工厂数量须为 1 至 50 个'.
      RETURN.
    ENDIF.
    LOOP AT et_plants INTO DATA(lv_plant).
      IF strlen( lv_plant ) > 4 OR lv_plant CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.
        ev_error = |工厂格式不合法: { lv_plant }|.
        RETURN.
      ENDIF.
      IF lv_plant = 'ALL'.
        CONTINUE.
      ENDIF.
      SELECT SINGLE werks FROM t001w WHERE werks = @lv_plant INTO @DATA(lv_werks).
      IF sy-subrc <> 0.
        ev_error = |工厂 { lv_plant } 不存在|.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD line_of.
    rs = CORRESPONDING #( is_req ).
  ENDMETHOD.


  METHOD new_req.

    DATA lv_guid TYPE c LENGTH 32.

    CALL FUNCTION 'GUID_CREATE'
      IMPORTING
        ev_guid_32 = lv_guid.
    rs-mandt       = sy-mandt.
    rs-req_id      = lv_guid.
    rs-requester   = sy-uname.
    rs-target_user = iv_user.
    rs-tcode       = iv_tcode.
    rs-werks       = iv_werks.
    rs-reason      = iv_reason.
    rs-channel     = iv_channel.
    rs-created_at  = now14( ).

  ENDMETHOD.


  METHOD save_req.
    MODIFY zai_auth_req FROM @is_req.
  ENDMETHOD.

ENDCLASS.
