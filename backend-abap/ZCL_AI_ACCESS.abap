*=======================================================================
* 对象:   ZCL_AI_ACCESS
* 用途:   按用户开放 Agent 场景 + 报表授权(设计: 功能计划书/用户权限/01-方案)
*         - 场景: ZAI_CHAT_USER-AGENT_SCENES(逗号分隔 REPORT,FIORI,DATA,CODE)
*           空 = 四个场景全开(老用户不受影响); ADMIN 永远全开;
*           「自动」(AUTO / 旧 INVENTORY)会在场景间自动选, 只对四个全开的用户开放
*         - 报表: ZAI_RPT_ACL(USERID, SRC_TYPE, REPORT_ID) 一行 = 一张报表给一个用户;
*           USERID = '*' 表示所有人(公共报表); 开关 RPT_ACL_ENABLED 不开 = 所有人看全部;
*           开了 = 普通用户只看到分配给自己的 + 公共的; ADMIN 照旧全部
*         所有判断都在后端做, 前端只是按结果显示
* 调用方: ZCL_AI_AGENT_SERVICE(场景 / 报表执行按 TCode) / ZCL_AI_REPORT_SERVICE
*         (list_defs / start_run) / ZCL_AI_FIORI_REPORT_SERVICE(load_def / list_defs /
*         find_candidates) / ZCL_AI_COMBO_SERVICE(来源核对) / ZCL_AI_CHAT_SERVICE
*         (登录返回场景 / 用户管理读写)
* 数据:   ZAI_CHAT_USER(加字段 AGENT_SCENES CHAR 40) / ZAI_RPT_ACL(新表)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用); 先改表 / 建表
* V1.0    20261101: 首版
* ★ 重贴后核对标记: 有 METHOD scene_ok / user_scenes / report_ok / acl_on /
*   save_user_access / user_reports_csv; scene_ok 里 AUTO 要求四个全开
*=======================================================================
CLASS zcl_ai_access DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS: gc_src_report TYPE string VALUE 'REPORT',
               gc_src_fiori  TYPE string VALUE 'FIORI',
               gc_all        TYPE string VALUE '*',
               gc_scenes     TYPE string VALUE 'REPORT,FIORI,DATA,CODE'.

    " 当前用户是不是管理员(ZAI_CHAT_USER-ROLE = ADMIN)
    CLASS-METHODS is_admin
      RETURNING VALUE(rv) TYPE abap_bool.

    " 用户开放的场景(逗号分隔, 只含 REPORT/FIORI/DATA/CODE, 按固定顺序);
    " ADMIN 或字段为空 = 四个全开
    CLASS-METHODS user_scenes
      IMPORTING iv_user   TYPE syuname DEFAULT sy-uname
      RETURNING VALUE(rv) TYPE string.

    " 场景能不能用; AUTO / INVENTORY / 空 = 自动, 要求四个全开
    CLASS-METHODS scene_ok
      IMPORTING iv_scene  TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.

    " 场景没开放时给用户看的话
    CLASS-METHODS scene_deny_text
      IMPORTING iv_scene  TYPE string
      RETURNING VALUE(rv) TYPE string.

    " 报表授权开关(ZAI_CHAT_CFG RPT_ACL_ENABLED = X)
    CLASS-METHODS acl_on
      RETURNING VALUE(rv) TYPE abap_bool.

    " 当前用户能不能用这张报表(iv_src_type = REPORT / FIORI)
    CLASS-METHODS report_ok
      IMPORTING iv_src_type  TYPE string
                iv_report_id TYPE string
      RETURNING VALUE(rv)    TYPE abap_bool.

    " 报表没授权时给用户看的话
    CLASS-METHODS report_deny_text
      IMPORTING iv_name   TYPE string
      RETURNING VALUE(rv) TYPE string.

    " 用户管理: 某用户单独分配的报表, 形如 REPORT:A,FIORI:X(不含公共行)
    CLASS-METHODS user_reports_csv
      IMPORTING iv_user   TYPE syuname
      RETURNING VALUE(rv) TYPE string.

    " 用户管理: 保存某用户的场景与报表(报表整体覆盖); iv_user = '*' 只存公共报表;
    " 调用方负责管理员校验
    CLASS-METHODS save_user_access
      IMPORTING iv_user    TYPE syuname
                iv_scenes  TYPE string
                iv_reports TYPE string
      EXPORTING ev_error   TYPE string.

    " 把任意写法的场景串规范成 REPORT,FIORI,DATA,CODE 的子集(固定顺序, 去重去非法)
    CLASS-METHODS norm_scenes
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_acl,
             src_type  TYPE string,
             report_id TYPE string,
           END OF ty_acl,
           tt_acl TYPE STANDARD TABLE OF ty_acl WITH DEFAULT KEY.

    " 同一请求内缓存当前用户的授权行(含公共行), 列表过滤时不必逐行查库
    CLASS-DATA: gt_acl    TYPE tt_acl,
                gv_loaded TYPE abap_bool,
                gv_user   TYPE syuname,
                gv_free   TYPE abap_bool.   " 开关没开或管理员: 全部放行(随 gt_acl 一起缓存)

    CLASS-METHODS load_acl.

ENDCLASS.



CLASS zcl_ai_access IMPLEMENTATION.


  METHOD is_admin.
    SELECT SINGLE role FROM zai_chat_user
      WHERE userid = @sy-uname AND active = 'X'
      INTO @DATA(lv_role).
    rv = xsdbool( sy-subrc = 0 AND lv_role = 'ADMIN' ).
  ENDMETHOD.


  METHOD norm_scenes.

    DATA: lt_in  TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lt_all TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lt_out TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_s   TYPE string.

    CLEAR rv.
    lv_s = to_upper( iv ).
    REPLACE ALL OCCURRENCES OF `，` IN lv_s WITH `,`.
    REPLACE ALL OCCURRENCES OF ` ` IN lv_s WITH ``.
    SPLIT lv_s AT ',' INTO TABLE lt_in.
    SPLIT gc_scenes AT ',' INTO TABLE lt_all.
    LOOP AT lt_all INTO lv_s.
      READ TABLE lt_in TRANSPORTING NO FIELDS WITH KEY table_line = lv_s.
      IF sy-subrc = 0.
        APPEND lv_s TO lt_out.
      ENDIF.
    ENDLOOP.
    CONCATENATE LINES OF lt_out INTO rv SEPARATED BY ','.

  ENDMETHOD.


  METHOD user_scenes.

    SELECT SINGLE role, agent_scenes FROM zai_chat_user
      WHERE userid = @iv_user AND active = 'X'
      INTO ( @DATA(lv_role), @DATA(lv_sc) ).
    IF sy-subrc <> 0.
      CLEAR rv.        " 未开通: 什么都不开放(登录本身也会被拒)
      RETURN.
    ENDIF.
    IF lv_role = 'ADMIN'.
      rv = gc_scenes.
      RETURN.
    ENDIF.
    rv = norm_scenes( CONV string( lv_sc ) ).
    IF rv IS INITIAL.
      rv = gc_scenes.  " 空 = 全开(老用户不受影响)
    ENDIF.

  ENDMETHOD.


  METHOD scene_ok.

    DATA: lt_have TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_sc   TYPE string,
          lv_have TYPE string.

    lv_have = user_scenes( ).
    IF lv_have = gc_scenes.
      rv = abap_true.
      RETURN.
    ENDIF.
    lv_sc = to_upper( iv_scene ).
    CONDENSE lv_sc NO-GAPS.
    SPLIT lv_have AT ',' INTO TABLE lt_have.
    READ TABLE lt_have TRANSPORTING NO FIELDS WITH KEY table_line = lv_sc.
    rv = xsdbool( sy-subrc = 0 ).   " AUTO / INVENTORY / 空 不在列表里 → 不开放

  ENDMETHOD.


  METHOD scene_deny_text.

    DATA lv_lbl TYPE string.
    CASE to_upper( iv_scene ).
      WHEN 'REPORT'. lv_lbl = '报表执行'.
      WHEN 'FIORI'.  lv_lbl = 'Fiori 报表'.
      WHEN 'DATA'.   lv_lbl = '数据分析'.
      WHEN 'CODE'.   lv_lbl = '代码分析'.
      WHEN OTHERS.   lv_lbl = '自动'.
    ENDCASE.
    rv = |你没有「{ lv_lbl }」场景的使用权限, 请新建任务时选择已开放的场景, 或联系管理员开通。|.

  ENDMETHOD.


  METHOD acl_on.
    DATA lv TYPE string.
    lv = zcl_ai_task_service=>read_cfg_str( 'RPT_ACL_ENABLED' ).
    CONDENSE lv NO-GAPS.
    rv = xsdbool( to_upper( lv ) = 'X' ).
  ENDMETHOD.


  METHOD load_acl.

    DATA ls_a TYPE ty_acl.
    IF gv_loaded = abap_true AND gv_user = sy-uname.
      RETURN.
    ENDIF.
    CLEAR: gt_acl, gv_free.
    gv_loaded = abap_true.
    gv_user   = sy-uname.
    IF acl_on( ) = abap_false OR is_admin( ) = abap_true.
      gv_free = abap_true.
      RETURN.
    ENDIF.
    SELECT src_type, report_id FROM zai_rpt_acl
      WHERE userid = @sy-uname OR userid = '*'
      INTO TABLE @DATA(lt_db).
    LOOP AT lt_db INTO DATA(ls_db).
      ls_a-src_type  = to_upper( ls_db-src_type ).
      ls_a-report_id = to_upper( ls_db-report_id ).
      CONDENSE: ls_a-src_type NO-GAPS, ls_a-report_id NO-GAPS.
      APPEND ls_a TO gt_acl.
    ENDLOOP.

  ENDMETHOD.


  METHOD report_ok.

    DATA: lv_src TYPE string,
          lv_id  TYPE string.

    " 开关 / 角色 / 授权行在同一请求内只读一次(目录过滤时逐行调用)
    load_acl( ).
    IF gv_free = abap_true.
      rv = abap_true.
      RETURN.
    ENDIF.
    lv_src = to_upper( iv_src_type ).
    lv_id  = to_upper( iv_report_id ).
    CONDENSE: lv_src NO-GAPS, lv_id NO-GAPS.
    IF lv_id IS INITIAL.
      rv = abap_false.
      RETURN.
    ENDIF.
    READ TABLE gt_acl TRANSPORTING NO FIELDS WITH KEY src_type = lv_src report_id = lv_id.
    IF sy-subrc <> 0.
      READ TABLE gt_acl TRANSPORTING NO FIELDS WITH KEY src_type = lv_src report_id = gc_all.
    ENDIF.
    rv = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  METHOD report_deny_text.
    rv = |你没有报表「{ iv_name }」的使用权限, 请联系管理员在用户管理里分配。|.
  ENDMETHOD.


  METHOD user_reports_csv.

    DATA: lt_out TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_one TYPE string.
    CLEAR rv.
    SELECT src_type, report_id FROM zai_rpt_acl
      WHERE userid = @iv_user
      ORDER BY src_type, report_id
      INTO TABLE @DATA(lt_db).
    LOOP AT lt_db INTO DATA(ls_db).
      lv_one = |{ ls_db-src_type }:{ ls_db-report_id }|.
      CONDENSE lv_one NO-GAPS.
      APPEND lv_one TO lt_out.
    ENDLOOP.
    CONCATENATE LINES OF lt_out INTO rv SEPARATED BY ','.

  ENDMETHOD.


  METHOD save_user_access.

    DATA: lt_in  TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lt_ins TYPE STANDARD TABLE OF zai_rpt_acl WITH DEFAULT KEY,
          ls_ins TYPE zai_rpt_acl,
          lv_one TYPE string,
          lv_src TYPE string,
          lv_id  TYPE string,
          lv_sc  TYPE string.

    CLEAR ev_error.
    IF iv_user IS INITIAL.
      ev_error = '用户为空'.
      RETURN.
    ENDIF.

    " '*' = 所有人: 只有公共报表, 没有场景
    IF iv_user <> gc_all.
      lv_sc = norm_scenes( iv_scenes ).
      IF lv_sc = gc_scenes.
        CLEAR lv_sc.   " 四个全选存空(= 全开), 以后加场景时老用户也自动有
      ENDIF.
      UPDATE zai_chat_user SET agent_scenes = @lv_sc WHERE userid = @iv_user.
    ENDIF.

    lv_one = iv_reports.
    REPLACE ALL OCCURRENCES OF `，` IN lv_one WITH `,`.
    SPLIT lv_one AT ',' INTO TABLE lt_in.
    LOOP AT lt_in INTO lv_one.
      CONDENSE lv_one NO-GAPS.
      SPLIT lv_one AT ':' INTO lv_src lv_id.
      lv_src = to_upper( lv_src ).
      lv_id  = to_upper( lv_id ).
      IF ( lv_src <> gc_src_report AND lv_src <> gc_src_fiori ) OR lv_id IS INITIAL.
        CONTINUE.
      ENDIF.
      CLEAR ls_ins.
      ls_ins-mandt     = sy-mandt.
      ls_ins-userid    = iv_user.
      ls_ins-src_type  = lv_src.
      ls_ins-report_id = lv_id.
      ls_ins-created_by = sy-uname.
      ls_ins-created_at = |{ sy-datum }{ sy-uzeit }|.
      READ TABLE lt_ins TRANSPORTING NO FIELDS
        WITH KEY src_type = ls_ins-src_type report_id = ls_ins-report_id.
      IF sy-subrc <> 0.
        APPEND ls_ins TO lt_ins.
      ENDIF.
    ENDLOOP.

    DELETE FROM zai_rpt_acl WHERE userid = @iv_user.
    IF lt_ins IS NOT INITIAL.
      INSERT zai_rpt_acl FROM TABLE @lt_ins.
      IF sy-subrc <> 0.
        ROLLBACK WORK.
        ev_error = '报表授权写入失败'.
        RETURN.
      ENDIF.
    ENDIF.
    COMMIT WORK.
    CLEAR gv_loaded.

  ENDMETHOD.

ENDCLASS.
