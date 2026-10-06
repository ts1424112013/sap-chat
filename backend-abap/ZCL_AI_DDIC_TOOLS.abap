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
* V1.1.1 20261006: 修复 SE24 激活语法错(2 处报错)
* V1.1.2 20261006: 修复激活错 "Expression literal '{' not followed by space"(L124)
* V1.1.3 20261006: 修复激活错 JSON_STR Line 11 "Field CR_CHAR is unknown"
* V1.1.4 20261006: 修复激活错 4 处 "not type-compatible with IV_TEXT/IV_TABLE"
* V1.1.5 20261006: 修复 4 处 "not type-compatible"(内联显式化后仍报)
* V1.1.6 20261006: 修复运行时 dump VIEW_AUTHORITY_CHECK 形参 VIEW does not exist
* V1.1.7 20261006: view_name 形参(CHAR30 引用)不接受 string 实参 → lv_vname 中转;
*   异常名对齐标准全名 no_clientindep_authority(截断名会被忽略, 权限拒绝时二次炸)
*   ★ 重贴后核对标记: 本方法内应有 DATA lv_vname TYPE dd02v-tabname.
*   describe_table 的表权限检查传参 view= 已废弃, 本系统 FM 形参为 view_name=
*   (静态 CALL FUNCTION 参数名错误编译期不查, /IWFND/ERROR_LOG 才可见, ST22 无记录)
*   ★ 重贴后核对标记: describe_table 方法内应有 view_name = lv_tab
*   根因: IMPORTING TYPE string 为按引用传参, 该 Class Builder 解析器拒绝
*   CHAR 型实参(ls_hit-tabname/ls_f-fieldname/lv_ddtext)直接传 string 引用形参
*   (ADT 新编译器自动按值转换故开发机无感) → 实参一律 CONV string( ) 显式转换
*   ★ 重贴后核对标记: 全文应有 6 处 CONV string( 
*   根因: SE24 Class Builder 旧解析器对 SELECT INTO @DATA / LOOP INTO DATA 内联声明
*   (含 JOIN 场景)类型推断失败 —— 显式 string 实参(lv_tab)不报错, 内联结构字段全部报错
*   → search_tables/describe_table 的 6 处内联全部改显式声明(TYPES ty_hit + DATA)
*   ★ 重贴后核对标记: search_tables 开头应有 TYPES: BEGIN OF ty_hit,
*   cl_abap_char_utilities 无 CR_CHAR 属性(7z 源码笔误) → 裸 CR 改用 cr_lf(1) 首字符
*   ★ 重贴后核对标记: json_str 方法内应有 "DATA lv_cr TYPE c LENGTH 1."
*   ⚠ 重贴方式: SE24 源码全选删除后整类粘贴 V1.1.3 全文, 确保 DEFINITION 与实现同源
*   全类 6 处 JSON 组装由 |{{ }}| 转义模板 + 嵌套模板(sep = |, |) 改为反引号 ` 字面量拼接;
*   本类是全包唯一使用 {{ 转义写法的类(其余类均无), 疑与该 release 语法检查器不兼容
*   ★ 重贴后核对标记: 全文应搜不到 "{{"
*   describe_table: offset 位置 strlen() 表达式非法 → 先算入变量 lv_len_fj/lv_last_fj
*   ★ 重贴后核对标记: 本方法内应有 "DATA lv_last_fj TYPE i."
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
    " V1.1.4: SE24 旧解析器对 SELECT @DATA 内联声明(含 JOIN)类型推断失败,
    " 实参报 not type-compatible —— 涉及内联结构的全部改显式声明
    TYPES: BEGIN OF ty_hit,
             tabname  TYPE tabname,
             ddtext   TYPE ddtext,
             tabclass TYPE tabclass,
           END OF ty_hit.
    DATA: lt_hits    TYPE STANDARD TABLE OF ty_hit WITH DEFAULT KEY,
          lt_hits_en TYPE STANDARD TABLE OF ty_hit WITH DEFAULT KEY,
          ls_hit     TYPE ty_hit,
          ls_en      TYPE ty_hit.

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
      INTO TABLE @lt_hits
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
        INTO TABLE @lt_hits_en
        UP TO 100 ROWS.
      LOOP AT lt_hits_en INTO ls_en.
        READ TABLE lt_hits TRANSPORTING NO FIELDS WITH KEY tabname = ls_en-tabname.
        IF sy-subrc <> 0.
          APPEND ls_en TO lt_hits.
        ENDIF.
      ENDLOOP.
    ENDIF.

    " 过滤: JOIN 已保证透明表/视图 + 活动版本; 这里排除敏感表并限量
    DATA(lv_count) = 0.
    LOOP AT lt_hits INTO ls_hit.
      IF lv_count >= gc_max_hits.
        EXIT.
      ENDIF.
      IF zcl_ai_sql_guard=>is_sensitive( CONV string( ls_hit-tabname ) ) = abap_true.
        CONTINUE.
      ENDIF.
      lv_count = lv_count + 1.
      DATA lv_item TYPE string.
      lv_item = `{"name":` && json_str( CONV string( ls_hit-tabname ) ) &&
                `,"desc":` && json_str( CONV string( ls_hit-ddtext ) ) &&
                `,"class":"` && ls_hit-tabclass && `"}`.
      APPEND lv_item TO lt_out.
    ENDLOOP.

    rv_json = `{"ok":true,"keyword":` && json_str( lv_kw ) &&
              `,"count":` && CONV string( lv_count ) &&
              `,"tables":[` && concat_lines_of( table = lt_out sep = `,` ) && `]}`.

    " 结果过大时整体截断(护栏统一裁剪), 这里不再额外处理

  ENDMETHOD.


  METHOD describe_table.
    DATA lv_ddtext TYPE ddtext.   " V1.1.4: 内联改显式
    DATA lv_msg TYPE string.   " V1.1.2: 两处错误 JSON 复用

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
    " V1.1.6: 形参 view 在本系统 FM 中不存在(改版后为 view_name) ——
    " 静态 CALL FUNCTION 参数名编译期不查, 运行时 dump CX_SY_DYN_CALL_PARAM_NOT_FOUND
    DATA lv_vname TYPE dd02v-tabname.   " V1.1.7: string 实参显式中转
    lv_vname = lv_tab.
    CALL FUNCTION 'VIEW_AUTHORITY_CHECK'
      EXPORTING
        view_name                 = lv_vname
      EXCEPTIONS
        no_authority     = 1
        no_clientindep_authority = 2
        table_not_found  = 3
        OTHERS           = 4.
    IF sy-subrc <> 0.
      lv_msg = |没有权限读取表 { lv_tab }|.
      rv_json = `{"ok":false,"error":` && json_str( lv_msg ) && `}`.
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
      lv_msg = |未找到表 { lv_tab }(检查名称)|.
      rv_json = `{"ok":false,"error":` && json_str( lv_msg ) && `}`.
      RETURN.
    ENDIF.

    SELECT SINGLE ddtext FROM dd02t
      WHERE tabname = @lv_tab AND ddlanguage = @sy-langu
      INTO @lv_ddtext.

    DATA: lt_fields TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_n      TYPE i.
    DATA ls_f TYPE dfies.   " V1.1.4
    LOOP AT lt_dfies INTO ls_f.
      lv_n = lv_n + 1.
      IF lv_n > gc_max_fields.
        EXIT.
      ENDIF.
      DATA lv_fitem TYPE string.
      lv_fitem = `{"name":` && json_str( CONV string( ls_f-fieldname ) ) &&
                 `,"desc":` && json_str( CONV string( ls_f-fieldtext ) ) &&
                 `,"type":"` && ls_f-datatype && `","len":` && |{ ls_f-leng }| &&
                 `,"key":` && COND string( WHEN ls_f-keyflag = 'X' THEN 'true' ELSE 'false' ) &&
                 `,"checktable":` && json_str( COND string( WHEN ls_f-checktable IS INITIAL THEN '' ELSE ls_f-checktable ) ) &&
                 `},`.
      APPEND lv_fitem TO lt_fields.
    ENDLOOP.
    " 最后一项去掉尾逗号: 改为逐项拼接时统一处理
    DATA(lv_fields_json) = concat_lines_of( table = lt_fields sep = `` ).
    " V1.1.1: offset 位置不允许 strlen() 表达式, 先算入变量
    DATA lv_len_fj  TYPE i.
    DATA lv_last_fj TYPE i.
    lv_len_fj = strlen( lv_fields_json ).
    IF lv_len_fj > 0.
      lv_last_fj = lv_len_fj - 1.
      IF lv_fields_json+lv_last_fj(1) = ','.
        lv_fields_json = lv_fields_json(lv_last_fj).
      ENDIF.
    ENDIF.

    rv_json = `{"ok":true,"table":` && json_str( lv_tab ) &&
              `,"desc":` && json_str( CONV string( lv_ddtext ) ) &&
              `,"field_count":` && CONV string( lines( lt_dfies ) ) &&
              `,"truncated":` && COND string( WHEN lines( lt_dfies ) > gc_max_fields THEN 'true' ELSE 'false' ) &&
              `,"fields":[` && lv_fields_json && `]}`.

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
    " V1.1.3: cl_abap_char_utilities 无 CR_CHAR 属性 —— 裸 CR 取 cr_lf 首字符
    DATA lv_cr TYPE c LENGTH 1.
    lv_cr = cl_abap_char_utilities=>cr_lf(1).
    REPLACE ALL OCCURRENCES OF lv_cr IN rv_json WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv_json WITH `\t`.
    rv_json = |"{ rv_json }"|.

  ENDMETHOD.

ENDCLASS.


