*=======================================================================
* 对象:   ZCL_AI_BSKILL_SERVICE
* 用途:   内置技能(随灵犀发布的知识技能) —— 存在 SAP、按用户开放的场景下发给新引擎
*         设计: 《03》〇-AV(2026-11-10): 技能全文不再放在前端包里(任何登录用户都能按地址下载),
*         改为管理员导入「内置技能包」(项目 部署产物/builtin-skills.json)到表 ZAI_BSKILL,
*         每次提问由 browser_start 按用户开放的场景下发(没开对应场景的用户拿不到)
*
*         管理(只限 ZAI_CHAT_USER-ROLE = ADMIN, 经 ZCL_AI_AGENT_HTTP /admin/bskill/<动作>):
*           list    全部内置技能(不含正文): 目录、名称、说明、场景、启用、字数、附带资料数
*           get     { dir } → 一个技能的正文和附带资料
*           import  内置技能包 { version, skills:[{dir,title,description,source,scenes,sortNo,version,content,
*                   files:[{path,content}]}] }: 包里有的新增或覆盖(保留原来的启用状态; 新技能默认启用),
*                   包里没有的删除
*           active  { dir, active } 启用 / 停用一个内置技能
*         运行时:
*           for_user  当前用户能用的内置技能(启用 + 场景与用户开放的场景有交集)及其版本号;
*                     浏览器带来的版本号相同时不再回正文(浏览器用自己缓存的)
* 依赖:   表 ZAI_BSKILL(《03》〇-AV)、ZCL_AI_ACCESS
* 安装:   SE24 -> 创建类 -> 源代码视图整类粘贴 (ABAP 7.50 语法, 755 适用); 先建表 ZAI_BSKILL
* 版本:   V1.0 20261110 首版
*         ★ 重贴后核对标记: 有 METHOD admin / for_user / import_pkg / check_skill;
*           import_pkg 里有 DELETE FROM zai_bskill 与 is_admin 由 admin 先查; for_user 里有 scene_ok(
*=======================================================================
CLASS zcl_ai_bskill_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES: BEGIN OF ty_file,
             path    TYPE string,
             content TYPE string,
           END OF ty_file,
           tt_files TYPE STANDARD TABLE OF ty_file WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_pkg_skill,
             dir         TYPE string,
             title       TYPE string,
             description TYPE string,
             source      TYPE string,
             scenes      TYPE string,
             sort_no     TYPE i,
             version     TYPE string,
             content     TYPE string,
             files       TYPE tt_files,
           END OF ty_pkg_skill,
           tt_pkg_skills TYPE STANDARD TABLE OF ty_pkg_skill WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_pkg,
             version TYPE string,
             skills  TYPE tt_pkg_skills,
           END OF ty_pkg.

    CONSTANTS: gc_max_pkg     TYPE i VALUE 3000000,   " 内置技能包上限(字符)
               gc_max_content TYPE i VALUE 200000,    " 单个 SKILL.md 上限
               gc_max_files   TYPE i VALUE 20.        " 单个技能附带资料份数上限

    " 管理入口(ZCL_AI_AGENT_HTTP /admin/bskill/<动作>)
    CLASS-METHODS admin
      IMPORTING iv_action TYPE string
                iv_body   TYPE string
      EXPORTING ev_json   TYPE string
                ev_http   TYPE i
                ev_error  TYPE string.

    " 当前用户能用的内置技能: ev_version = 这份清单的版本号(空 = 没有);
    " iv_known = 浏览器手里那份的版本号, 相同时 ev_json 为空(不重复下发正文)
    CLASS-METHODS for_user
      IMPORTING iv_known   TYPE string OPTIONAL
      EXPORTING ev_version TYPE string
                ev_json    TYPE string.

  PRIVATE SECTION.

    CLASS-METHODS import_pkg
      IMPORTING iv_body  TYPE string
      EXPORTING ev_json  TYPE string
                ev_error TYPE string.

    " 校验一个技能; 通过时 ev_scenes = 规范化后的场景(逗号分隔)
    CLASS-METHODS check_skill
      IMPORTING is_skill  TYPE ty_pkg_skill
      EXPORTING ev_scenes TYPE string
                ev_error  TYPE string.

    CLASS-METHODS jstr
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS hash
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS zcl_ai_bskill_service IMPLEMENTATION.


  METHOD admin.

    CLEAR: ev_json, ev_error.
    ev_http = 200.
    IF zcl_ai_access=>is_admin( ) = abap_false.
      ev_http  = 403.
      ev_error = '只有管理员能管理内置技能'.
      RETURN.
    ENDIF.

    TYPES: BEGIN OF ty_req,
             dir    TYPE string,
             active TYPE abap_bool,
           END OF ty_req.
    DATA ls_req TYPE ty_req.

    CASE to_lower( iv_action ).
      WHEN 'list'.
        SELECT * FROM zai_bskill ORDER BY sort_no, dir INTO TABLE @DATA(lt_rows).
        DATA lv_list TYPE string.
        LOOP AT lt_rows INTO DATA(ls_row).
          DATA lt_f TYPE tt_files.
          CLEAR lt_f.
          IF ls_row-files IS NOT INITIAL.
            /ui2/cl_json=>deserialize( EXPORTING json = ls_row-files CHANGING data = lt_f ).
          ENDIF.
          lv_list = |{ lv_list }{ COND string( WHEN lv_list IS NOT INITIAL THEN `,` ) }| &&
                    |\{"dir":{ jstr( CONV string( ls_row-dir ) ) },"title":{ jstr( CONV string( ls_row-title ) ) },| &&
                    |"description":{ jstr( ls_row-descr ) },"source":{ jstr( ls_row-source ) },| &&
                    |"scenes":{ jstr( CONV string( ls_row-scenes ) ) },"sortNo":{ ls_row-sort_no },| &&
                    |"active":{ COND string( WHEN ls_row-active = abap_true THEN `true` ELSE `false` ) },| &&
                    |"version":{ jstr( CONV string( ls_row-version ) ) },"pkgVersion":{ jstr( CONV string( ls_row-pkg_ver ) ) },| &&
                    |"chars":{ strlen( ls_row-content ) },"fileCount":{ lines( lt_f ) },| &&
                    |"changedBy":{ jstr( CONV string( ls_row-changed_by ) ) }\}|.
        ENDLOOP.
        ev_json = |\{"ok":true,"skills":[{ lv_list }]\}|.

      WHEN 'get'.
        /ui2/cl_json=>deserialize( EXPORTING json = iv_body pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                   CHANGING data = ls_req ).
        DATA(lv_dir) = to_lower( condense( ls_req-dir ) ).
        SELECT SINGLE * FROM zai_bskill WHERE dir = @lv_dir INTO @DATA(ls_one).
        IF sy-subrc <> 0.
          ev_http  = 404.
          ev_error = |没有内置技能 { lv_dir }|.
          RETURN.
        ENDIF.
        ev_json = |\{"ok":true,"skill":\{"dir":{ jstr( CONV string( ls_one-dir ) ) },"title":{ jstr( CONV string( ls_one-title ) ) },| &&
                  |"description":{ jstr( ls_one-descr ) },"source":{ jstr( ls_one-source ) },| &&
                  |"scenes":{ jstr( CONV string( ls_one-scenes ) ) },| &&
                  |"active":{ COND string( WHEN ls_one-active = abap_true THEN `true` ELSE `false` ) },| &&
                  |"content":{ jstr( ls_one-content ) },| &&
                  |"files":{ COND string( WHEN ls_one-files IS INITIAL THEN `[]` ELSE ls_one-files ) }\}\}|.

      WHEN 'import'.
        import_pkg( EXPORTING iv_body = iv_body IMPORTING ev_json = ev_json ev_error = ev_error ).
        IF ev_error IS NOT INITIAL.
          ev_http = 400.
        ENDIF.

      WHEN 'active'.
        /ui2/cl_json=>deserialize( EXPORTING json = iv_body pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                   CHANGING data = ls_req ).
        lv_dir = to_lower( condense( ls_req-dir ) ).
        DATA lv_ts TYPE timestampl.
        GET TIME STAMP FIELD lv_ts.
        UPDATE zai_bskill SET active     = @ls_req-active,
                              changed_by = @sy-uname,
                              changed_at = @lv_ts
          WHERE dir = @lv_dir.
        IF sy-subrc <> 0.
          ev_http  = 404.
          ev_error = |没有内置技能 { lv_dir }|.
          RETURN.
        ENDIF.
        ev_json = |\{"ok":true,"dir":{ jstr( lv_dir ) },"active":{ COND string( WHEN ls_req-active = abap_true THEN `true` ELSE `false` ) }\}|.

      WHEN OTHERS.
        ev_http  = 404.
        ev_error = |未知动作 { iv_action }|.
    ENDCASE.

  ENDMETHOD.


  METHOD import_pkg.

    CLEAR: ev_json, ev_error.
    IF iv_body IS INITIAL OR strlen( iv_body ) > gc_max_pkg.
      ev_error = |内置技能包为空或超过 { gc_max_pkg } 字符|.
      RETURN.
    ENDIF.

    DATA ls_pkg TYPE ty_pkg.
    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json = iv_body pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                                   CHANGING data = ls_pkg ).
      CATCH cx_root INTO DATA(lx).
        ev_error = |内置技能包不是有效的 JSON: { lx->get_text( ) }|.
        RETURN.
    ENDTRY.
    IF ls_pkg-skills IS INITIAL.
      ev_error = '内置技能包里没有技能(请选项目里的 部署产物/builtin-skills.json)'.
      RETURN.
    ENDIF.

    " ---- 先全部校验, 有一个不合格整包不导 ----
    TYPES: BEGIN OF ty_ok,
             dir    TYPE string,
             scenes TYPE string,
           END OF ty_ok.
    DATA lt_ok TYPE STANDARD TABLE OF ty_ok WITH DEFAULT KEY.
    DATA lv_err TYPE string.
    LOOP AT ls_pkg-skills INTO DATA(ls_sk).
      DATA lv_scn TYPE string.
      check_skill( EXPORTING is_skill = ls_sk IMPORTING ev_scenes = lv_scn ev_error = lv_err ).
      IF lv_err IS NOT INITIAL.
        ev_error = |技能 { ls_sk-dir }: { lv_err }|.
        RETURN.
      ENDIF.
      IF line_exists( lt_ok[ dir = ls_sk-dir ] ).
        ev_error = |技能目录 { ls_sk-dir } 重复|.
        RETURN.
      ENDIF.
      APPEND VALUE #( dir = ls_sk-dir scenes = lv_scn ) TO lt_ok.
    ENDLOOP.

    " ---- 写表: 保留已有技能的启用状态 ----
    SELECT dir, active FROM zai_bskill INTO TABLE @DATA(lt_old).
    DATA: lv_ts      TYPE timestampl,
          lv_added   TYPE i,
          lv_updated TYPE i,
          lv_removed TYPE i,
          ls_db      TYPE zai_bskill.
    GET TIME STAMP FIELD lv_ts.
    LOOP AT ls_pkg-skills INTO ls_sk.
      CLEAR ls_db.
      ls_db-dir     = ls_sk-dir.
      ls_db-title   = ls_sk-title.
      ls_db-descr   = ls_sk-description.
      ls_db-source  = ls_sk-source.
      ls_db-scenes  = lt_ok[ dir = ls_sk-dir ]-scenes.
      ls_db-sort_no = ls_sk-sort_no.
      ls_db-version = COND #( WHEN ls_sk-version IS NOT INITIAL THEN ls_sk-version ELSE hash( ls_sk-content ) ).
      ls_db-pkg_ver = ls_pkg-version.
      ls_db-content = ls_sk-content.
      " 附带资料由本类重新序列化后再存(下发时原样拼进 JSON)
      ls_db-files   = COND #( WHEN ls_sk-files IS INITIAL THEN ``
                              ELSE /ui2/cl_json=>serialize( data = ls_sk-files pretty_name = /ui2/cl_json=>pretty_mode-camel_case ) ).
      READ TABLE lt_old INTO DATA(ls_old) WITH KEY dir = ls_db-dir.
      IF sy-subrc = 0.
        ls_db-active = ls_old-active.
        lv_updated = lv_updated + 1.
      ELSE.
        ls_db-active = abap_true.
        lv_added = lv_added + 1.
      ENDIF.
      ls_db-changed_by = sy-uname.
      ls_db-changed_at = lv_ts.
      MODIFY zai_bskill FROM @ls_db.
    ENDLOOP.
    LOOP AT lt_old INTO ls_old.
      IF NOT line_exists( lt_ok[ dir = CONV string( ls_old-dir ) ] ).
        DELETE FROM zai_bskill WHERE dir = @ls_old-dir.
        lv_removed = lv_removed + 1.
      ENDIF.
    ENDLOOP.

    ev_json = |\{"ok":true,"version":{ jstr( ls_pkg-version ) },"added":{ lv_added },"updated":{ lv_updated },"removed":{ lv_removed }\}|.

  ENDMETHOD.


  METHOD check_skill.

    CLEAR: ev_scenes, ev_error.
    IF NOT matches( val = is_skill-dir regex = `[a-z0-9]+(-[a-z0-9]+)*` ) OR strlen( is_skill-dir ) > 40.
      ev_error = '目录名只能用小写字母、数字和单个连字符, 最长 40'.
      RETURN.
    ENDIF.
    IF is_skill-title IS INITIAL OR strlen( is_skill-title ) > 60.
      ev_error = '名称必填, 最长 60 字'.
      RETURN.
    ENDIF.
    IF is_skill-description IS INITIAL OR strlen( is_skill-description ) > 1024.
      ev_error = '说明必填, 最长 1024 字'.
      RETURN.
    ENDIF.
    IF is_skill-content IS INITIAL OR strlen( is_skill-content ) > gc_max_content.
      ev_error = |SKILL.md 为空或超过 { gc_max_content } 字|.
      RETURN.
    ENDIF.
    IF lines( is_skill-files ) > gc_max_files.
      ev_error = |附带资料超过 { gc_max_files } 份|.
      RETURN.
    ENDIF.
    LOOP AT is_skill-files INTO DATA(ls_f).
      IF NOT matches( val = ls_f-path regex = `[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)*\.md` )
         OR ls_f-path CS '..' OR ls_f-path = 'SKILL.md' OR ls_f-content IS INITIAL
         OR strlen( ls_f-content ) > gc_max_content.
        ev_error = |附带资料 { ls_f-path } 的路径或内容不合规|.
        RETURN.
      ENDIF.
    ENDLOOP.

    " 场景: 只认 REPORT / FIORI / DATA / CODE, 按固定顺序; 至少一个
    DATA lt_in TYPE string_table.
    DATA lt_all TYPE string_table.
    DATA(lv_scenes_in) = to_upper( is_skill-scenes ).
    SPLIT lv_scenes_in AT ',' INTO TABLE lt_in.
    LOOP AT lt_in ASSIGNING FIELD-SYMBOL(<lv_in>).
      CONDENSE <lv_in> NO-GAPS.
    ENDLOOP.
    SPLIT zcl_ai_access=>gc_scenes AT ',' INTO TABLE lt_all.
    LOOP AT lt_all INTO DATA(lv_s).
      IF line_exists( lt_in[ table_line = lv_s ] ).
        ev_scenes = |{ ev_scenes }{ COND string( WHEN ev_scenes IS NOT INITIAL THEN `,` ) }{ lv_s }|.
      ENDIF.
    ENDLOOP.
    IF ev_scenes IS INITIAL.
      ev_error = '至少要有一个适用场景(REPORT / FIORI / DATA / CODE)'.
    ENDIF.

  ENDMETHOD.


  METHOD for_user.

    CLEAR: ev_version, ev_json.
    SELECT * FROM zai_bskill WHERE active = @abap_true ORDER BY sort_no, dir INTO TABLE @DATA(lt_rows).
    IF lt_rows IS INITIAL.
      RETURN.
    ENDIF.

    " 用户开放的场景(管理员 = 全部)
    DATA lt_scn TYPE string_table.
    DATA lt_mine TYPE string_table.
    SPLIT zcl_ai_access=>gc_scenes AT ',' INTO TABLE lt_scn.
    LOOP AT lt_scn INTO DATA(lv_scn).
      IF zcl_ai_access=>scene_ok( lv_scn ) = abap_true.
        APPEND lv_scn TO lt_mine.
      ENDIF.
    ENDLOOP.

    DATA: lv_key  TYPE string,
          lv_list TYPE string.
    LOOP AT lt_rows INTO DATA(ls_row).
      DATA lt_sk_scn TYPE string_table.
      SPLIT ls_row-scenes AT ',' INTO TABLE lt_sk_scn.
      DATA(lv_hit) = abap_false.
      LOOP AT lt_sk_scn INTO DATA(lv_ss).
        IF line_exists( lt_mine[ table_line = lv_ss ] ).
          lv_hit = abap_true.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_hit = abap_false.
        CONTINUE.
      ENDIF.
      lv_key  = |{ lv_key }{ ls_row-dir }:{ ls_row-version };|.
      lv_list = |{ lv_list }{ COND string( WHEN lv_list IS NOT INITIAL THEN `,` ) }| &&
                |\{"dir":{ jstr( CONV string( ls_row-dir ) ) },"title":{ jstr( CONV string( ls_row-title ) ) },| &&
                |"content":{ jstr( ls_row-content ) },| &&
                |"files":{ COND string( WHEN ls_row-files IS INITIAL THEN `[]` ELSE ls_row-files ) }\}|.
    ENDLOOP.
    IF lv_key IS INITIAL.
      RETURN.
    ENDIF.

    ev_version = substring( val = hash( lv_key ) len = 12 ).
    IF iv_known = ev_version.
      RETURN.   " 浏览器手里就是这份, 不重复下发
    ENDIF.
    ev_json = |[{ lv_list }]|.

  ENDMETHOD.


  METHOD jstr.

    rv = /ui2/cl_json=>serialize( data = iv ).
    IF rv IS INITIAL.
      rv = '""'.
    ENDIF.

  ENDMETHOD.


  METHOD hash.

    DATA lv_hash TYPE string.
    TRY.
        cl_abap_message_digest=>calculate_hash_for_char( EXPORTING if_algorithm  = 'SHA1'
                                                                   if_data       = iv
                                                         IMPORTING ef_hashstring = lv_hash ).
      CATCH cx_abap_message_digest.
        lv_hash = |{ strlen( iv ) }000000000000|.
    ENDTRY.
    rv = to_lower( lv_hash ).

  ENDMETHOD.

ENDCLASS.
