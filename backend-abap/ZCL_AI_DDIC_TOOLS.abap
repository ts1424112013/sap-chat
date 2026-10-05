*=======================================================================
* 对象:   ZCL_AI_DDIC_TOOLS
* 用途:   动态 SQL 的元数据工具(《SAP动态SQL业务分析_开发计划》§6)
*         - search_tables   按业务关键词查表(DD02T 描述 + 表名模糊匹配),
*                           排除敏感表, 供模型先定位业务表
*         - describe_table  读表字段清单(DDIF_FIELDINFO_GET, 与普通对话的
*                           表结构读取同一口径), 供模型写 SELECT 前确认字段
*         - 两个工具均只读; describe_table 前做敏感表黑名单 + 表权限校验
* 依赖:   ZCL_AI_SQL_GUARD(黑名单/开关; V1.2 起敏感表判断直接委托 GUARD)
* 安装:   SE24 (ABAP 7.50, 755 兼容)
* 激活顺序: ZCL_AI_SQL_GUARD -> ZCL_AI_SQL_EXECUTOR -> 本类
* V1.2 20261005: search_tables 改 JOIN 一次取 tabclass(免 N+1 查询);
*         删除私有黑名单副本, 委托 GUARD=>is_sensitive(单一来源);
*         json_str 修复 CRLF 转义顺序(裸 CR 产生非法 JSON)
*=======================================================================
CLASS zcl_ai_ddic_tools DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " 搜索结果上限(回给模型的候选表数)
    CONSTANTS: gc_max_hits    TYPE i VALUE 30,
               " describe_table 字段清单上限(超大表截断, 已含说明)
               gc_max_fields  TYPE i VALUE 150.

    CLASS-METHODS search_tables
      IMPORTING iv_keyword     TYPE string
      RETURNING VALUE(rv_json) TYPE string.

    CLASS-METHODS describe_table
      IMPORTING iv_tabname     TYPE string
      RETURNING VALUE(rv_json) TYPE string.

  PRIVATE SECTION.

    CLASS-METHODS json_str
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_json) TYPE string.   " JSON 字符串字面量(含引号)

ENDCLASS.

CLASS zcl_ai_ddic_tools IMPLEMENTATION.

  METHOD search_tables.

    DATA: lt_out TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    DATA(lv_kw) = iv_keyword.
    CONDENSE lv_kw.
    " 关键词限制(仅检索提示, 不进 SQL)
    IF strlen( lv_kw ) > 40.
      lv_kw = lv_kw(40).
    ENDIF.
    IF lv_kw IS INITIAL.
      rv_json = '{"ok":false,"error":"关键词为空"}'.
      RETURN.
    ENDIF.
    IF zcl_ai_sql_guard=>is_enabled( ) <> abap_true.
      rv_json = '{"ok":false,"error":"SQL 分析功能未开启"}'.
      RETURN.
    ENDIF.

    " 中文/混合关键词: 在 DD02T(当前登录语言)按描述匹配; 同时匹配表名
    " LIKE 关键词含 % _ 时按字面处理(FIND 不涉及, 这里拼 LIKE 需转义)
    DATA(lv_like) = replace( val  = lv_kw
                             sub  = '%'
                             with = '' occ = 0 ).
    lv_like = replace( val = lv_like sub = '_' with = '' occ = 0 ).
    CONDENSE lv_like.
    DATA(lv_pat) = '%' && lv_like && '%'.

    " V1.2: JOIN DD02L 一次带出 tabclass(仅活动版本/透明表/视图),
    " 替代循环内逐表 SELECT SINGLE(原实现最多 ~300 次 DB 往返)
    SELECT t~tabname, t~ddtext, l~tabclass
      FROM dd02t AS t
      INNER JOIN dd02l AS l
        ON  l~tabname  = t~tabname
        AND l~as4local = 'A'
        AND l~tabclass IN ( 'TRANSP', 'VIEW' )
      WHERE t~ddlanguage = @sy-langu
        AND t~as4local   = 'A'
        AND ( t~tabname LIKE @lv_pat OR t~ddtext LIKE @lv_pat )
      ORDER BY t~tabname
      INTO TABLE @DATA(lt_hits)
      UP TO 200 ROWS.

    " 当前语言命中不足时回退英文(技术表常只有英文描述)
    IF lines( lt_hits ) < 5.
      SELECT t~tabname, t~ddtext, l~tabclass
        FROM dd02t AS t
        INNER JOIN dd02l AS l
          ON  l~tabname  = t~tabname
          AND l~as4local = 'A'
          AND l~tabclass IN ( 'TRANSP', 'VIEW' )
        WHERE t~ddlanguage = 'E'
          AND t~as4local   = 'A'
          AND ( t~tabname LIKE @lv_pat OR t~ddtext LIKE @lv_pat )
        ORDER BY t~tabname
        INTO TABLE @DATA(lt_hits_en)
        UP TO 100 ROWS.
      LOOP AT lt_hits_en INTO DATA(ls_en).
        READ TABLE lt_hits TRANSPORTING NO FIELDS WITH KEY tabname = ls_en-tabname.
        IF sy-subrc <> 0.
          APPEND ls_en TO lt_hits.
        ENDIF.
      ENDLOOP.
    ENDIF.

    " 过滤: JOIN 已保证透明表/视图 + 活动版本; 这里排除敏感表并限量
    DATA(lv_count) = 0.
    LOOP AT lt_hits INTO DATA(ls_hit).
      IF lv_count >= gc_max_hits.
        EXIT.
      ENDIF.
      IF zcl_ai_sql_guard=>is_sensitive( ls_hit-tabname ) = abap_true.
        CONTINUE.
      ENDIF.
      lv_count = lv_count + 1.
      APPEND |{{"name":{ json_str( ls_hit-tabname ) },"desc":{ json_str( ls_hit-ddtext ) },"class":"{ ls_hit-tabclass }"}}|
        TO lt_out.
    ENDLOOP.

    rv_json = |{{"ok":true,"keyword":{ json_str( lv_kw ) },"count":{ lv_count },| &&
              |"tables":[{ concat_lines_of( table = lt_out sep = |, | ) }]| &&
              |}}|.

    " 结果过大时整体截断(护栏统一裁剪), 这里不再额外处理

  ENDMETHOD.


  METHOD describe_table.

    DATA(lv_tab) = to_upper( iv_tabname ).
    CONDENSE lv_tab.

    IF lv_tab IS INITIAL OR strlen( lv_tab ) > 30.
      rv_json = '{"ok":false,"error":"表名为空或超过 30 个字符"}'.
      RETURN.
    ENDIF.
    IF zcl_ai_sql_guard=>is_enabled( ) <> abap_true.
      rv_json = '{"ok":false,"error":"SQL 分析功能未开启"}'.
      RETURN.
    ENDIF.
    IF zcl_ai_sql_guard=>is_sensitive( lv_tab ) = abap_true.
      rv_json = '{"ok":false,"error":"该表属于受保护表, 不允许查询"}'.
      RETURN.
    ENDIF.

    " 表权限(与 run_sql 执行前同一口径); 敏感表判断委托 GUARD 单一来源
    CALL FUNCTION 'VIEW_AUTHORITY_CHECK'
      EXPORTING
        view             = lv_tab
      EXCEPTIONS
        no_authority     = 1
        no_clientindep_auth = 2
        table_not_found  = 3
        OTHERS           = 4.
    IF sy-subrc <> 0.
      rv_json = |{{"ok":false,"error":{ json_str( |没有权限读取表 { lv_tab }| ) }}}|.
      RETURN.
    ENDIF.

    " 字段清单(与普通对话 read_structure 同一 FM)
    DATA: lt_dfies TYPE STANDARD TABLE OF dfies WITH DEFAULT KEY.

    CALL FUNCTION 'DDIF_FIELDINFO_GET'
      EXPORTING
        tabname        = CONV ddobjname( lv_tab )
        langu          = sy-langu
      TABLES
        dfies_tab      = lt_dfies
      EXCEPTIONS
        not_found      = 1
        internal_error = 2
        OTHERS         = 3.

    IF sy-subrc <> 0 OR lines( lt_dfies ) = 0.
      rv_json = |{{"ok":false,"error":{ json_str( |未找到表 { lv_tab }(检查名称)| ) }}}|.
      RETURN.
    ENDIF.

    SELECT SINGLE ddtext FROM dd02t
      WHERE tabname = @lv_tab AND ddlanguage = @sy-langu
      INTO @DATA(lv_ddtext).

    DATA: lt_fields TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_n      TYPE i.
    LOOP AT lt_dfies INTO DATA(ls_f).
      lv_n = lv_n + 1.
      IF lv_n > gc_max_fields.
        EXIT.
      ENDIF.
      APPEND |{{"name":{ json_str( ls_f-fieldname ) },| &&
              |"desc":{ json_str( ls_f-fieldtext ) },| &&
              |"type":"{ ls_f-datatype }","len":{ ls_f-leng },| &&
              |"key":{ COND #( WHEN ls_f-keyflag = 'X' THEN 'true' ELSE 'false' ) },| &&
              |"checktable":{ json_str( COND string( WHEN ls_f-checktable IS INITIAL THEN '' ELSE ls_f-checktable ) ) }},|
        TO lt_fields.
    ENDLOOP.
    " 最后一项去掉尾逗号: 改为逐项拼接时统一处理
    DATA(lv_fields_json) = concat_lines_of( table = lt_fields sep = `` ).
    IF lv_fields_json IS NOT INITIAL AND lv_fields_json+strlen( lv_fields_json )-1(1) = ','.
      lv_fields_json = lv_fields_json(strlen( lv_fields_json )-1).
    ENDIF.

    rv_json = |{{"ok":true,"table":{ json_str( lv_tab ) },| &&
              |"desc":{ json_str( lv_ddtext ) },| &&
              |"field_count":{ lines( lt_dfies ) },| &&
              |"truncated":{ COND #( WHEN lines( lt_dfies ) > gc_max_fields THEN 'true' ELSE 'false' ) },| &&
              |"fields":[{ lv_fields_json }]| &&
              |}}|.

  ENDMETHOD.


  METHOD json_str.

    " JSON 字符串字面量: 引号/反斜杠/控制字符转义
    rv_json = iv_text.
    REPLACE ALL OCCURRENCES OF `\` IN rv_json WITH `\\`.
    REPLACE ALL OCCURRENCES OF `"` IN rv_json WITH `\"`.
    " V1.2 修复转义顺序: 先 CRLF 再孤立 LF/CR —— 原顺序会把 CRLF 中的 LF
    " 先转成 \n 字面量, 残留的裸 CR 在严格 JSON 解析器中是非法控制字符
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv_json WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv_json WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_char IN rv_json WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv_json WITH `\t`.
    rv_json = |"{ rv_json }"|.

  ENDMETHOD.

ENDCLASS.
