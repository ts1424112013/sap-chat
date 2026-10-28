*=======================================================================
* 对象:   ZCL_AI_SQL_GUARD
* 用途:   动态 SQL 安全校验(《SAP动态SQL业务分析_开发计划》§4, V1.1 20261004)
*         - 只允许单条只读 SELECT(Open SQL), 词法扫描后由
*           ZCL_AI_SQL_EXECUTOR 拼装 INTO/UP TO 生成子程序池执行
*         - 关键字/字符黑名单: SQL 会被拼进生成的 ABAP 代码,
*           校验防的是"ABAP 代码注入"而不只是 SQL 写操作
*         - 表名提取(FROM/JOIN) → DD02L 存在性 → 敏感表黑名单 →
*           VIEW_AUTHORITY_CHECK(等同 SE16 的表权限口径)
*         - 配置(ZAI_CHAT_CFG): SQL_ANALYSIS_ENABLED / SQL_MAX_ROWS /
*           SQL_MAX_EXEC; 黑名单首版为常量, P2 迁 ZAI_SQL_BLACKLIST 表
* 依赖:   无(纯校验, 不执行 SQL; 被 AGENT_SERVICE / SQL_EXECUTOR 调用)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (适用 ABAP 7.50, 755 兼容)
* 激活顺序: 本类 -> ZCL_AI_SQL_EXECUTOR -> ZCL_AI_DDIC_TOOLS
* V1.2 20261005: is_sensitive 提为 public(黑名单单一来源); 实现未动
* V1.2.1 20261006: 修复 SE24 激活语法错(12 处报错)
* V1.2.2 20261006: 修复运行时 dump VIEW_AUTHORITY_CHECK
*   ①形参 view→view_name(本系统 FM 已改名) ②string 实参→CHAR30 引用形参 ILLEGAL_TYPE,
*   显式中转变量 lv_vname(dd02v-tabname) ③异常名对齐标准全名 no_clientindep_authority
*   ★ 重贴后核对标记: 本类内应有 lv_vname 中转与 no_clientindep_authority
*   ① SHIFT ... LEFT LEADING 非法组合(2 处) → LEFT DELETING LEADING / RIGHT DELETING TRAILING
*   ② offset/length 位置不允许 strlen() 表达式 → SHIFT RIGHT DELETING TRAILING 替代循环
*   ③ STRING 写入位置子串赋值非法(writer 位置须 flat) → STRIP_LITERALS 改 CHAR 4000 缓冲
*   ★ 重贴后核对标记: validate_sql 内应有 "SHIFT lv_sql RIGHT DELETING TRAILING space."
* V1.2.3 20261028(10.28 记录 #02: 工单分析 SQL 反复失败): 把模型常犯的通用 SQL 写法
*   在校验阶段就说清楚怎么改, 不再落到含糊的报错或生成程序里的编译错:
*   ① "别名.字段" → 提示写成 别名~字段(原来报"检测到语句分隔符"); 分号单独提示
*   ② 双引号 → 提示别名不要加引号(原来报"注释符或反引号")
*   ③ 常量之外出现中文 / 全角符号 → 提示别名只用英文、符号用半角
*   ④ LIMIT / TOP / FETCH FIRST、CURRENT_DATE / NOW( ) / sy-datum(提示今天日期)、
*     DATEDIFF 等日期函数(提示 DATS_DAYS_BETWEEN / DATS_ADD_DAYS / SUBSTRING)、
*     IFNULL / NVL(提示 COALESCE)
*   只加拒绝条件, 原有放行 / 拒绝规则不变
*   ★ 重贴后核对标记: validate_sql 内有 DATA(lv_ascii) 与 DATS_DAYS_BETWEEN 提示
*=======================================================================
CLASS zcl_ai_sql_guard DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES: tt_names TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    " 敏感表黑名单(首版常量; 仅拦凭据类, 业务数据交给表授权控制:
    " 第一阶段只对 IT 账号开放, 开放业务用户前把 PA*/HRP*/银行类加进来)
    TYPES: BEGIN OF ty_bl,
             pattern TYPE string,     " 支持通配符 % (按 CP 匹配)
             reason  TYPE string,
           END OF ty_bl.
    TYPES: tt_blacklist TYPE STANDARD TABLE OF ty_bl WITH DEFAULT KEY.

    CONSTANTS: gc_sql_max_len   TYPE i VALUE 4000,   " 语句长度上限
               gc_max_tables    TYPE i VALUE 8,      " FROM/JOIN 表数上限
               gc_rows_default  TYPE i VALUE 5000,   " 单条默认行数
               gc_rows_hard_max TYPE i VALUE 50000,  " 行数硬上限
               gc_exec_default  TYPE i VALUE 5.      " 单请求执行次数上限

    CLASS-METHODS validate_sql
      IMPORTING iv_sql        TYPE string
      EXPORTING ev_sql_clean  TYPE string     " 压缩为单行后的语句(执行用)
                et_tables     TYPE tt_names    " 涉及的表名(大写, 已去重)
                ev_error      TYPE string.     " 空=通过

    CLASS-METHODS is_enabled
      RETURNING VALUE(rv_on) TYPE abap_bool.  " SQL_ANALYSIS_ENABLED

    CLASS-METHODS read_max_rows
      RETURNING VALUE(rv_rows) TYPE i.

    CLASS-METHODS read_max_exec
      RETURNING VALUE(rv_n) TYPE i.

    " V1.2: 提为 public —— DDIC_TOOLS 的 search/describe 委托本方法,
    " 敏感表黑名单全系统只维护这一处(原 DDIC_TOOLS 里的硬编码副本已删)
    CLASS-METHODS is_sensitive
      IMPORTING iv_table     TYPE string
      RETURNING VALUE(rv_yes) TYPE abap_bool.

  PRIVATE SECTION.

    CLASS-METHODS strip_literals
      IMPORTING iv_sql         TYPE string
      EXPORTING ev_stripped    TYPE string      " 字面量替换为空格后的文本(扫描用)
                ev_unbalanced  TYPE abap_bool   " 引号不闭合
                ev_lit_too_long TYPE abap_bool. " 单个字面量超 150 字符

    CLASS-METHODS get_blacklist
      RETURNING VALUE(rt_bl) TYPE tt_blacklist.

    CLASS-METHODS table_exists
      IMPORTING iv_table      TYPE string
      RETURNING VALUE(rv_ok)  TYPE abap_bool.

    CLASS-METHODS read_cfg
      IMPORTING iv_key          TYPE string
                iv_default      TYPE string
      RETURNING VALUE(rv_value) TYPE string.

    CLASS-METHODS is_active_user
      RETURNING VALUE(rv_ok) TYPE abap_bool.

ENDCLASS.

CLASS zcl_ai_sql_guard IMPLEMENTATION.

  METHOD validate_sql.

    CLEAR: ev_sql_clean, ev_error.
    CLEAR et_tables.

    " ---- 0. 总开关 ----
    IF is_enabled( ) <> abap_true.
      ev_error = 'SQL 分析功能未开启(请联系管理员在 ZAI_CHAT_CFG 配置 SQL_ANALYSIS_ENABLED=X)'.
      RETURN.
    ENDIF.

    " ---- 1. 基本清理与长度 ----
    DATA(lv_sql) = iv_sql.
    FIND REGEX '(^|[\r\n])[[:space:]]*\*' IN lv_sql.
    IF sy-subrc = 0.
      ev_error = '不允许使用 ABAP 行首注释符 *'.
      RETURN.
    ENDIF.
    " 换行/制表符折叠为空格(行首 * 注释因此退化为乘号, 无注释注入面);
    " 只掐头去尾, 不压缩内部空格 —— 字面量内的连续空格可能参与过滤条件
    REPLACE ALL OCCURRENCES OF REGEX '[\r\n\t]+' IN lv_sql WITH ` `.
    SHIFT lv_sql LEFT DELETING LEADING space.      " V1.2.1: LEFT LEADING 非法组合
    SHIFT lv_sql RIGHT DELETING TRAILING space.    " V1.2.1: 替代 STRING 子串写入循环

    IF lv_sql IS INITIAL.
      ev_error = 'SQL 语句为空'.
      RETURN.
    ENDIF.
    IF strlen( lv_sql ) > gc_sql_max_len.
      ev_error = |SQL 超过长度上限 { gc_sql_max_len } 字符(当前 { strlen( lv_sql ) })|.
      RETURN.
    ENDIF.

    " ---- 2. 结构: 必须是单条 SELECT, 不允许语句结束符/注释/反引号 ----
    DATA(lv_head) = lv_sql.
    TRANSLATE lv_head TO UPPER CASE.
    FIND REGEX '^\s*SELECT\s+' IN lv_head.
    IF sy-subrc <> 0.
      ev_error = '语句必须以 SELECT 开头'.
      RETURN.
    ENDIF.

    DATA(lv_work) = lv_sql.

    " 尾部句点(模型常见习惯)允许剥离; 内部句点(多语句)拒绝
    SHIFT lv_work RIGHT DELETING TRAILING '.'.     " V1.2.1
    SHIFT lv_work LEFT DELETING LEADING space.     " V1.2.1
    SHIFT lv_work RIGHT DELETING TRAILING space.   " V1.2.1
    IF lv_work IS INITIAL.
      ev_error = 'SQL 语句为空'.
      RETURN.
    ENDIF.
    DATA(lv_scan) = lv_work.
    TRANSLATE lv_scan TO UPPER CASE.

    strip_literals( EXPORTING iv_sql = lv_scan
                    IMPORTING ev_stripped = DATA(lv_bare)
                              ev_unbalanced = DATA(lv_unbal)
                              ev_lit_too_long = DATA(lv_litlong) ).
    IF lv_unbal = abap_true.
      ev_error = '字符串常量引号不闭合'.
      RETURN.
    ENDIF.
    IF lv_litlong = abap_true.
      ev_error = '单个字符串常量超过 150 字符(过滤值请直接写完整值或改用 LIKE)'.
      RETURN.
    ENDIF.

    " V1.2.3: 通用 SQL 的"别名.字段"写法单独报清楚 —— 原来落到下面的"语句分隔符",
    " 模型看不出要改成 ~, 反复重写直到次数用完(10.28 记录 #02)
    FIND REGEX '[A-Z_][A-Z0-9_]*\.[A-Z_*]' IN lv_bare.
    IF sy-subrc = 0.
      ev_error = `字段请写成 别名~字段(如 K~AUFNR、P~WEMNG), Open SQL 不用点号 . 限定字段; ` &&
                 `表别名写在 FROM / JOIN 后(如 FROM AFKO AS K)`.
      RETURN.
    ENDIF.
    IF lv_bare CS ';'.
      ev_error = '只允许单条 SELECT 语句, 不要写分号 ;'.
      RETURN.
    ENDIF.

    IF lv_bare CS ';' OR lv_bare CS '.'.
      " 数字间的小数点(如 1.5)不算语句分隔符, 先摘除再判断
      DATA(lv_dot_check) = lv_bare.
      REPLACE ALL OCCURRENCES OF REGEX '[0-9]\.[0-9]' IN lv_dot_check WITH ` , `.
      IF lv_dot_check CS ';' OR lv_dot_check CS '.'.
        ev_error = '只允许单条 SELECT 语句(检测到语句分隔符)'.
        RETURN.
      ENDIF.
    ENDIF.
    IF lv_bare CS '"'.
      " V1.2.3: 双引号在 ABAP 里是注释符; 模型多半是给别名加了引号
      ev_error = '不允许使用双引号: 别名直接写英文(如 AS WIP_QTY), 不要加引号; 字符串常量用单引号'.
      RETURN.
    ENDIF.
    IF lv_bare CS '`'.
      ev_error = '不允许使用反引号, 字符串常量用单引号'.
      RETURN.
    ENDIF.
    " V1.2.3: 字符串常量之外只能是 ASCII —— 中文别名、全角逗号 / 括号会在生成程序里编译失败
    DATA(lv_ascii) = `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_~,()=<>*+-/%:@!&|^?[]{}$#.\ `.
    IF lv_bare CN lv_ascii.
      ev_error = `别名和字段名只能用英文字母、数字、下划线(检测到中文或全角符号); ` &&
                 `中文只能出现在单引号常量里, 逗号和括号用半角`.
      RETURN.
    ENDIF.
    IF lv_scan NS 'FROM'.
      ev_error = 'SELECT 语句缺少 FROM 子句'.
      RETURN.
    ENDIF.

    " ---- 3. 关键字黑名单(整词匹配, 已排除字符串常量) ----
    " INTO/UP TO/PACKAGE/APPENDING 由后端拼接, 模型语句中禁止出现;
    " 其余为写操作/代码生成/原生连接入口, 一律拒绝
    DATA: lt_kw TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    APPEND 'INTO'      TO lt_kw.
    APPEND 'INSERT'    TO lt_kw.
    APPEND 'UPDATE'    TO lt_kw.
    APPEND 'DELETE'    TO lt_kw.
    APPEND 'MODIFY'    TO lt_kw.
    APPEND 'COMMIT'    TO lt_kw.
    APPEND 'ROLLBACK'  TO lt_kw.
    APPEND 'CLIENT'    TO lt_kw.
    APPEND 'CONNECTION' TO lt_kw.
    APPEND 'BYPASSING' TO lt_kw.
    APPEND 'BUFFER'    TO lt_kw.
    APPEND 'PACKAGE'   TO lt_kw.
    APPEND 'APPENDING' TO lt_kw.
    APPEND 'FORM'      TO lt_kw.
    APPEND 'PERFORM'   TO lt_kw.
    APPEND 'SUBMIT'    TO lt_kw.
    APPEND 'CALL'      TO lt_kw.
    APPEND 'METHOD'    TO lt_kw.
    APPEND 'GENERATE'  TO lt_kw.
    APPEND 'INCLUDE'   TO lt_kw.
    APPEND 'WITH'      TO lt_kw.   " 7.50 无 CTE, WITH 仅出现在危险上下文
    APPEND 'WINDOW'    TO lt_kw.

    " 整词边界: 关键字前后为非字母数字(或边界)
    DATA(lv_bare_pad) = | { lv_bare } |.

    " V1.2.3: 通用 SQL 方言先给出可照做的改法(否则只会在生成程序里报编译错)
    FIND REGEX `[^A-Z0-9_](LIMIT|TOP\s+[0-9]+|FETCH\s+FIRST)[^A-Z0-9_]` IN lv_bare_pad.
    IF sy-subrc = 0.
      ev_error = '不支持 LIMIT / TOP / FETCH FIRST: 返回行数由系统控制; 需要前 N 条请 ORDER BY 后在回答里取前 N 条'.
      RETURN.
    ENDIF.
    FIND REGEX `[^A-Z0-9_](CURRENT_DATE|CURRENT_TIMESTAMP|SYSDATE|GETDATE|NOW\s*\(|SY-DATUM|SY-UZEIT)` IN lv_bare_pad.
    IF sy-subrc = 0.
      ev_error = |不支持取当前日期的函数或 sy-datum: 请直接写日期常量, 今天是 '{ sy-datum }'|.
      RETURN.
    ENDIF.
    FIND REGEX `[^A-Z0-9_](DATEDIFF|DATE_DIFF|DATEADD|DATE_ADD|DATE_FORMAT|TO_CHAR|TO_DATE|EXTRACT|YEAR|MONTH)\s*\(` IN lv_bare_pad.
    IF sy-subrc = 0.
      ev_error = `日期直接按 YYYYMMDD 字符串比较; 日期差用 DATS_DAYS_BETWEEN( 日期1, 日期2 ), ` &&
                 `加减天数用 DATS_ADD_DAYS( 日期, 天数 ), 取年月用 SUBSTRING( 日期, 1, 6 )`.
      RETURN.
    ENDIF.
    FIND REGEX `[^A-Z0-9_](IFNULL|NVL|ISNULL)\s*\(` IN lv_bare_pad.
    IF sy-subrc = 0.
      ev_error = '空值处理请用 COALESCE( 字段, 默认值 )'.
      RETURN.
    ENDIF.

    LOOP AT lt_kw INTO DATA(lv_kw).
      DATA(lv_pat) = |[^A-Z0-9_]{ lv_kw }[^A-Z0-9_]| .
      FIND REGEX lv_pat IN lv_bare_pad.
      IF sy-subrc = 0.
        ev_error = |语句包含不允许的关键字: { lv_kw } (只允许只读 SELECT, | &&
                   |INTO/UP TO 等子句由系统自动添加)|.
        RETURN.
      ENDIF.
    ENDLOOP.

    " UP TO 两个词单独查
    FIND REGEX `[^A-Z0-9_]UP\s+TO[^A-Z0-9_]` IN lv_bare_pad.
    IF sy-subrc = 0.
      ev_error = '语句包含不允许的子句: UP TO (返回行数由系统自动添加)'.
      RETURN.
    ENDIF.

    " FROM/JOIN 子查询允许通过；后续仍会扫描子查询内部的 FROM/JOIN
    " 表名并逐一做 DDIC、黑名单和权限校验。

    " ---- 4. 表名提取 + 存在性 + 黑名单 + 权限 ----
    DATA lv_off TYPE i.
    DATA lv_tab TYPE string.
    DATA(lo_regex) = NEW cl_abap_regex( pattern     = `(FROM|JOIN)\s+([A-Z_][A-Z0-9_/]*)`
                                        ignore_case = abap_false ).
    DATA(lo_matcher) = lo_regex->create_matcher( text = lv_bare_pad ).
    WHILE lo_matcher->find_next( ) = abap_true.
      lv_tab = lo_matcher->get_submatch( 2 ).
      IF lv_tab IS INITIAL.
        CONTINUE.
      ENDIF.
      READ TABLE et_tables TRANSPORTING NO FIELDS WITH KEY table_line = lv_tab.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      APPEND lv_tab TO et_tables.
    ENDWHILE.

    IF lines( et_tables ) = 0.
      ev_error = '未能从语句中识别出任何表名'.
      RETURN.
    ENDIF.
    IF lines( et_tables ) > gc_max_tables.
      ev_error = |涉及的表数 { lines( et_tables ) } 超过上限 { gc_max_tables }|.
      RETURN.
    ENDIF.

    LOOP AT et_tables INTO lv_tab.

      IF is_sensitive( lv_tab ) = abap_true.
        ev_error = |表 { lv_tab } 属于受保护表, 不允许查询|.
        RETURN.
      ENDIF.

      IF table_exists( lv_tab ) = abap_false.
        ev_error = |表 { lv_tab } 不存在或不是透明表/视图, 请用 describe_table 确认表名|.
        RETURN.
      ENDIF.

    " V1.1.7: FM 形参 view_name(CHAR30, 按引用) —— string 实参须显式中转;
    " CALL FUNCTION 参数位置不允许 CONV 表达式; 异常名用标准全名
    DATA lv_vname TYPE dd02v-tabname.
    lv_vname = lv_tab.
    CALL FUNCTION 'VIEW_AUTHORITY_CHECK'
      EXPORTING
        view_name                 = lv_vname
      EXCEPTIONS
        no_authority              = 1
        no_clientindep_authority  = 2
        table_not_found           = 3
        OTHERS                    = 4.
      IF sy-subrc <> 0.
        ev_error = |没有权限读取表 { lv_tab } (需要 S_TABU_NAM/S_TABU_DIS 显示权限)|.
        RETURN.
      ENDIF.

    ENDLOOP.

    " ---- 5. 通过: 返回压缩后的单行语句(执行用, 保留大小写) ----
    ev_sql_clean = lv_work.

  ENDMETHOD.


  METHOD strip_literals.

    " 把 '...' 字面量替换为等长空格, 供关键字扫描使用;
    " ABAP 单引号字面量中 '' 表示一个引号(转义); 同时检查常量长度
    CLEAR: ev_stripped, ev_unbalanced, ev_lit_too_long.

    " V1.2.1: 改用 CHAR 4000 定长缓冲扫描 —— ABAP 不允许对 STRING 在
    " 写入位置(writer position)做子串赋值(操作数必须 flat 类型);
    " 双 offset 写法 iv_sql+lv_i+1(1) 亦非法, 改用变量 lv_last
    DATA: lv_len  TYPE i,
          lv_i    TYPE i,
          lv_last TYPE i,
          lv_ch   TYPE c LENGTH 1,
          lv_open TYPE abap_bool,
          lv_lits TYPE i,               " 当前常量长度
          lv_buf  TYPE c LENGTH 4000.   " 定长扫描缓冲(CHAR 子串写入合法)

    lv_len = strlen( iv_sql ).
    IF lv_len > 4000.
      lv_len = 4000.                    " validate_sql 已限长 4000, 此处兜底
    ENDIF.
    lv_buf = iv_sql(lv_len).

    WHILE lv_i < lv_len.
      lv_ch = lv_buf+lv_i(1).
      IF lv_open = abap_true.
        lv_lits = lv_lits + 1.
        IF lv_lits > 150.
          ev_lit_too_long = abap_true.
          RETURN.
        ENDIF.
        lv_buf+lv_i(1) = ` `.
        IF lv_ch = `'`.
          " 判断是转义('')还是闭合
          lv_last = lv_i + 1.
          IF lv_last < lv_len AND lv_buf+lv_last(1) = `'`.
            lv_buf+lv_last(1) = ` `.
            lv_i = lv_i + 1.
            lv_lits = lv_lits + 1.
          ELSE.
            lv_open = abap_false.
          ENDIF.
        ENDIF.
      ELSEIF lv_ch = `'`.
        lv_open = abap_true.
        lv_lits = 0.
        lv_buf+lv_i(1) = ` `.
      ENDIF.
      lv_i = lv_i + 1.
    ENDWHILE.

    ev_stripped = lv_buf.
    ev_unbalanced = xsdbool( lv_open = abap_true ).

  ENDMETHOD.


  METHOD get_blacklist.

    " 首版: 仅凭据类; 业务数据交给 VIEW_AUTHORITY_CHECK
    rt_bl = VALUE #(
      ( pattern = 'USR%'           reason = 'SAP 用户数据' )
      ( pattern = 'USH%'           reason = '用户变更历史' )
      ( pattern = 'USRPWD%'        reason = '口令历史' )
      ( pattern = 'AGR_1251'       reason = '授权维护数据' )
      ( pattern = 'RSECTAB'        reason = '加密段存储' )
      ( pattern = 'SSF%'           reason = 'SSF/PSE 凭据' )
      ( pattern = 'SECSTORE%'      reason = '安全存储' )
      ( pattern = 'ZAI_MODEL_CFG'  reason = '模型 API Key 配置' )
      ( pattern = 'ZAI_CHAT_USER'  reason = '本系统用户表' )
    ).

  ENDMETHOD.


  METHOD is_sensitive.

    rv_yes = abap_false.
    DATA(lv_tab) = to_upper( iv_table ).
    LOOP AT get_blacklist( ) INTO DATA(ls_bl).
      IF lv_tab CP ls_bl-pattern.
        rv_yes = abap_true.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD table_exists.

    SELECT SINGLE tabname FROM dd02l
      WHERE tabname  = @iv_table
        AND tabclass IN ( 'TRANSP', 'VIEW' )
      INTO @DATA(lv_tab).
    rv_ok = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  METHOD read_cfg.

    rv_value = iv_default.
    SELECT SINGLE cfgvalue FROM zai_chat_cfg
      WHERE cfgkey = @iv_key
      INTO @DATA(lv_val).
    IF sy-subrc = 0 AND lv_val IS NOT INITIAL.
      rv_value = lv_val.
    ENDIF.

  ENDMETHOD.


  METHOD is_enabled.

    rv_on = xsdbool( read_cfg( iv_key = 'SQL_ANALYSIS_ENABLED'
                               iv_default = '' ) = 'X'
                     AND is_active_user( ) = abap_true ).

  ENDMETHOD.


  METHOD is_active_user.

    " 登录 ID 字段是 USERID(USERNAME 是显示姓名, 不能拿 sy-uname 匹配);
    " 启用字段为 ACTIVE。SQL_ALLOWED 字段在 SE11 扩展后作为第二层开关:
    " 用动态组件读取, 字段尚未建好时仍可激活; 字段存在则必须勾选 X。
    SELECT SINGLE * FROM zai_chat_user
      WHERE userid = @sy-uname AND active = 'X'
      INTO @DATA(ls_user).
    IF sy-subrc <> 0.
      rv_ok = abap_false.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT 'SQL_ALLOWED' OF STRUCTURE ls_user TO FIELD-SYMBOL(<lv_allowed>).
    IF sy-subrc = 0.
      rv_ok = xsdbool( <lv_allowed> = 'X' ).
    ELSE.
      rv_ok = abap_true.
    ENDIF.

  ENDMETHOD.


  METHOD read_max_rows.

    DATA(lv_val) = read_cfg( iv_key = 'SQL_MAX_ROWS' iv_default = '' ).
    rv_rows = gc_rows_default.
    IF lv_val CN '0123456789 ' OR lv_val IS INITIAL.
      RETURN.
    ENDIF.
    rv_rows = CONV i( lv_val ).
    IF rv_rows < 1.
      rv_rows = gc_rows_default.
    ENDIF.
    IF rv_rows > gc_rows_hard_max.
      rv_rows = gc_rows_hard_max.
    ENDIF.

  ENDMETHOD.


  METHOD read_max_exec.

    DATA(lv_val) = read_cfg( iv_key = 'SQL_MAX_EXEC' iv_default = '' ).
    rv_n = gc_exec_default.
    IF lv_val CN '0123456789 ' OR lv_val IS INITIAL.
      RETURN.
    ENDIF.
    rv_n = CONV i( lv_val ).
    IF rv_n < 1.
      rv_n = gc_exec_default.
    ENDIF.
    IF rv_n > 10.
      rv_n = 10.
    ENDIF.

  ENDMETHOD.

ENDCLASS.

