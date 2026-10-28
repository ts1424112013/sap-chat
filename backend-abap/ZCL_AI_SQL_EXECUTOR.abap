*=======================================================================
* 对象:   ZCL_AI_SQL_EXECUTOR
* 用途:   动态 SELECT 执行(《SAP动态SQL业务分析_开发计划》§3 方案 A, V1.1)
*         - 校验(ZCL_AI_SQL_GUARD)通过后, 把模型的 Open SQL 拼进生成的
*           子程序池(GENERATE SUBROUTINE POOL), 由后端追加 INTO/UP TO
*         - 编译错误(行号/消息)原样回传, 供模型修正语句
*         - 结果经 RTTI 转为 ZCL_AI_DATA_ANALYSIS_SERVICE=>ty_dataset
*           (与数据分析同一数据集格式 → 前端表格/图表/CSV 免改造)
*         - 回填模型: 最多 200 行明细; 前端数据集含全部取回行
*         - 每次执行写审计表 ZAI_SQL_LOG(动态写入, 表未建时静默跳过,
*           本类激活不依赖该表)
* 依赖:   ZCL_AI_SQL_GUARD, ZCL_AI_DATA_ANALYSIS_SERVICE(仅类型)
* 安装:   SE24 (ABAP 7.50)
* 激活顺序: ZCL_AI_SQL_GUARD -> 本类 -> ZCL_AI_DDIC_TOOLS
* V1.2 20261005: 生成代码改用 GET REFERENCE OF, 免整表拷贝(语义不变)
* V1.2.1 20261006: 修复 SE24 激活错 SPLIT_SOURCE(2 处报错)
* V1.2.2 20261006: 编译失败错误回填附生成源码摘要(前 200 字符, 行以竖线分隔)
* V1.2.3 20261006: 修复 GENERATE period missing —— 断行结构性重做
* V1.2.4 20261006: 修复 RUN_SQL Line 73 length 表达式(lv_scut - lv_spos)报错
* V1.2.5 20261006: 修复"查询未返回结果对象" —— 调试实锤 LR_DATA = FREED STACK
* V1.2.6 20261006: 修复编译错第 8 行 generic reference cannot be dereferenced
*   泛型引用(REF TO data)的 ->* 不允许作赋值目标 —— 标准 FIELD-SYMBOL 三段式:
*   CREATE DATA → ASSIGN cr_data->* TO <fs>(ANY TABLE) → <fs> = 局部表
*   ★ 重贴后核对标记: 生成 FORM 内应有 FIELD-SYMBOLS <lt_copy> TYPE ANY TABLE.
*   GET REFERENCE OF 指向 FORM 栈上局部表 lt_result, PERFORM 返回后栈帧回收,
*   引用失效 → IS NOT BOUND 为真(头注释"GC 保证存活"断言错误, 7z 源码第 8 处坑)
*   → FORM 内改 CREATE DATA cr_data LIKE lt_result(堆对象) + cr_data->* = lt_result 拷贝
*   顺带 log_run 补 MANDT 赋值(此前审计行 client 为空, SE16 按 470 查不可见)
*   ★ 重贴后核对标记: 生成 FORM 内应有 CREATE DATA cr_data LIKE lt_result.
*   offset/length 位置只允许简单变量 —— 教训在 SQL_EXECUTOR/DDIC_TOOLS 已两犯,
*   本次自查再犯于新代码; 顺带修 STRING 无 length APPEND 与 -= 复合赋值
*   ★ 重贴后核对标记: SQL 段断行内应有 DATA lv_segl TYPE i.
*   调试实锤: split_source 断行失效(环境相关), lv_code 350 字符挤进单行 C(200)
*   被截断, ROWS./ENDFORM. 丢失 → SYS$$INCOMPLETE$$ LINE 1
*   → 弃用整体拼串+断行, 改按逻辑段逐行 APPEND(PROGRAM/FORM/TRY/SQL段/INTO/...);
*   行数上限 @iv_max 同步改为字面量内嵌 { lv_max }(消除 FORM 参数引用悬案);
*   仅模型 SQL 段超 230 时才 FIND 空格断行。split_source 方法保留但不再调用
*   ★ 重贴后核对标记: run_sql 内应有 APPEND |PROGRAM.| TO lt_source.
*   排障: ZAI_SQL_LOG.ERROR_MSG 直接可见喂给 GENERATE 的完整代码, 不再盲猜
*   ★ 重贴后核对标记: 失败分支应有 lv_srccode
*   ① 双 offset iv_code+lv_i+1(1) 非法 → lv_next 变量
*   ② length 位置不允许算术表达式 lv_last_sp - lv_start → lv_cut 变量
*   ③ 尾行无 length 子串改显式 length
*   ★ 重贴后核对标记: 本类应搜到 "lv_cut = lv_last_sp - lv_start."
* V1.3 20261028(10.28 记录 #02: 工单分析的 SQL 几乎都编译失败, 单表查询正常):
*   ① 根因: 模型 SQL 按 230 字符断行, 但生成源码行类型 ty_srcline 是 C(200),
*     每行第 201~230 个字符被静默截掉 → 超过 200 字符的 SQL(多表 JOIN)必然
*     编译失败, 报错只附前 200 字符源码, 模型看不出原因, 反复重写直到次数用完。
*     改为每行 ≤ gc_seg_max(180): 只在字符串常量之外的空格 / 逗号处断行,
*     找不到安全断点直接拒绝, 不再硬切
*   ② 编译报错改为回填出错行及上一行(原为生成源码前 200 字符)
*   ★ 重贴后核对标记: 私有常量 gc_seg_max = 180; run_sql 内有 count( val = lv_lead sub = `'` );
*     不再有 "IF lv_segl <= 230"

*=======================================================================
CLASS zcl_ai_sql_executor DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " 回填模型的最大明细行数(超出时提示模型改用 GROUP BY)
    CONSTANTS: gc_llm_rows TYPE i VALUE 200.

    TYPES: BEGIN OF ty_run,
             status  TYPE string,          " OK / ERROR
             error   TYPE string,
             purpose TYPE string,
             sql     TYPE string,          " 校验通过后的语句
             dataset TYPE zcl_ai_data_analysis_service=>ty_dataset,
           END OF ty_run.

    CLASS-METHODS run_sql
      IMPORTING iv_sql        TYPE string
                iv_purpose    TYPE string DEFAULT ''
                iv_session_id TYPE string DEFAULT ''
      RETURNING VALUE(rs_run) TYPE ty_run.

  PRIVATE SECTION.

    TYPES: ty_srcline TYPE c LENGTH 200,
           tt_source  TYPE STANDARD TABLE OF ty_srcline WITH DEFAULT KEY.

    " V1.3: 模型 SQL 每行最多字符数(必须小于 ty_srcline 的 200, 逗号断行时本行可多 1 个)
    CONSTANTS gc_seg_max TYPE i VALUE 180.

    " 按字面量外的空格断行(≤198字符/行), 不切断字符串常量、不压缩其内空格
    CLASS-METHODS split_source
      IMPORTING iv_code   TYPE string
      EXPORTING et_source TYPE tt_source.

    CLASS-METHODS cells_from_row
      IMPORTING is_struct TYPE any
                io_desc   TYPE REF TO cl_abap_structdescr
      EXPORTING et_cells  TYPE zcl_ai_data_analysis_service=>tt_cells.

    " 动态写审计表(表未建/写入失败时静默跳过, 不影响主流程)
    CLASS-METHODS log_run
      IMPORTING iv_sql        TYPE string
                iv_status     TYPE string
                iv_rows       TYPE i
                iv_error      TYPE string
                iv_session_id TYPE string.

ENDCLASS.

CLASS zcl_ai_sql_executor IMPLEMENTATION.

  METHOD run_sql.

    DATA: lv_t0 TYPE i,
          lv_t1 TYPE i.
    GET RUN TIME FIELD lv_t0.

    CLEAR rs_run.
    rs_run-purpose = iv_purpose.
    rs_run-dataset-name = COND #( WHEN iv_purpose IS NOT INITIAL
                                  THEN iv_purpose ELSE 'SQL查询结果' ).
    rs_run-dataset-source = 'SAP Open SQL'.

    " ---- 1. 校验(开关/词法/表黑名单/表权限) ----
    DATA: lv_clean  TYPE string,
          lt_tables TYPE zcl_ai_sql_guard=>tt_names,
          lv_verr   TYPE string.

    zcl_ai_sql_guard=>validate_sql(
      EXPORTING iv_sql       = iv_sql
      IMPORTING ev_sql_clean = lv_clean
                et_tables    = lt_tables
                ev_error     = lv_verr ).

    IF lv_verr IS NOT INITIAL.
      rs_run-status = 'ERROR'.
      rs_run-error  = lv_verr.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = lv_verr.
      log_run( iv_sql = iv_sql iv_status = 'REJECTED' iv_rows = 0
               iv_error = lv_verr iv_session_id = iv_session_id ).
      RETURN.
    ENDIF.

    rs_run-sql = lv_clean.

    " ---- 2. 行数上限(配置, 硬上限在 GUARD 中收敛) ----
    DATA(lv_max) = zcl_ai_sql_guard=>read_max_rows( ).

    " ---- 3. 拼装子程序池源码 ----
    " 模型语句 + 后端拼接的 INTO/UP TO; 表/字段/语法在编译期即校验
    " V1.2: GET REFERENCE OF 直接引用结果表(ABAP GC 保证 FORM 返回后
    " 数据存活), 替代 CREATE DATA+ASSIGN+整表拷贝, 省一次 5000 行复制
    " V1.2.3: 弃用"整体拼串+split_source 断行"(实测断行失效 → 单行 200 截断
    " → period missing), 改为按逻辑段逐行 APPEND —— 每行天然 < 200 字符;
    " 仅模型 SQL 段可能超长, 用 FIND 空格断行(每段独立检查)
    DATA: lt_source TYPE tt_source,
          lv_seg    TYPE string,
          lv_spos   TYPE i,
          lv_scand  TYPE i,
          lv_scut   TYPE i.

    APPEND |PROGRAM.| TO lt_source.
    APPEND |FORM run_sql USING iv_max TYPE i| TO lt_source.
    APPEND |CHANGING cr_data TYPE REF TO data cv_err TYPE string.| TO lt_source.
    APPEND |TRY.| TO lt_source.

    " ---- 模型 SQL 段: 每行 ≤ gc_seg_max 字符 ----
    " V1.3: 原按 230 断行, 但行类型 ty_srcline 是 C(200) —— 每行第 201~230 个字符被
    "       静默截掉, 超过 200 字符的 SQL 必然编译失败(多表 JOIN 的工单查询首当其冲)。
    "       改为每行 ≤ 180: 从第 180 个字符往回找字符串常量之外的空格(不保留)或
    "       逗号(留在本行); 引号个数为偶数 = 在常量之外('' 转义成对出现, 不影响奇偶)。
    "       找不到安全断点就拒绝, 绝不硬切。只用 substring( )/count( ), 不用 offset 写法
    DATA: lv_segl TYPE i,
          lv_rest TYPE i,
          lv_q    TYPE i,
          lv_ch1  TYPE string,
          lv_lead TYPE string.
    lv_spos = 0.
    WHILE lv_spos < strlen( lv_clean ).
      lv_rest = strlen( lv_clean ) - lv_spos.
      IF lv_rest <= gc_seg_max.
        lv_seg = substring( val = lv_clean off = lv_spos len = lv_rest ).
        APPEND lv_seg TO lt_source.
        EXIT.
      ENDIF.
      lv_scut  = -1.
      lv_scand = lv_spos + gc_seg_max.
      WHILE lv_scand > lv_spos.
        lv_ch1 = substring( val = lv_clean off = lv_scand len = 1 ).
        IF lv_ch1 = ` ` OR lv_ch1 = `,`.
          lv_lead = substring( val = lv_clean len = lv_scand ).
          lv_q = count( val = lv_lead sub = `'` ).
          IF lv_q MOD 2 = 0.
            lv_scut = lv_scand.
            EXIT.
          ENDIF.
        ENDIF.
        lv_scand = lv_scand - 1.
      ENDWHILE.
      IF lv_scut < 0.
        rs_run-status = 'ERROR'.
        rs_run-error  = |SQL 中有超过 { gc_seg_max } 个字符没有空格或逗号的连续片段, 无法安全断行。| &&
                        |请在字段、运算符和关键字之间加空格后重试|.
        rs_run-dataset-status = 'ERROR'.
        rs_run-dataset-error  = rs_run-error.
        log_run( iv_sql = lv_clean iv_status = 'REJECTED' iv_rows = 0
                 iv_error = rs_run-error iv_session_id = iv_session_id ).
        RETURN.
      ENDIF.
      lv_ch1 = substring( val = lv_clean off = lv_scut len = 1 ).
      IF lv_ch1 = `,`.
        lv_segl = lv_scut - lv_spos + 1.   " 逗号留在本行
      ELSE.
        lv_segl = lv_scut - lv_spos.       " 空格由换行代替
      ENDIF.
      lv_seg = substring( val = lv_clean off = lv_spos len = lv_segl ).
      APPEND lv_seg TO lt_source.
      lv_spos = lv_scut + 1.
    ENDWHILE.

    APPEND |INTO TABLE @DATA(lt_result) UP TO { lv_max } ROWS.| TO lt_source.
    " V1.2.5: 栈引用在 FORM 返回后 FREED(调试实锤 FREED STACK) —— 必须堆上创建
    APPEND |FIELD-SYMBOLS <lt_copy> TYPE ANY TABLE.| TO lt_source.
    APPEND |CREATE DATA cr_data LIKE lt_result.| TO lt_source.
    APPEND |ASSIGN cr_data->* TO <lt_copy>.| TO lt_source.
    APPEND |<lt_copy> = lt_result.| TO lt_source.
    APPEND |CATCH cx_root INTO DATA(lx_gen).| TO lt_source.
    APPEND |cv_err = lx_gen->get_text( ).| TO lt_source.
    APPEND |ENDTRY.| TO lt_source.
    APPEND |ENDFORM.| TO lt_source.

    " ---- 4. 生成(编译): 错误原样回给模型修正 ----
    DATA: lv_prog TYPE string,
          lv_msg  TYPE string,
          lv_line TYPE string,
          lv_word TYPE string.

    GENERATE SUBROUTINE POOL lt_source NAME lv_prog
      MESSAGE lv_msg LINE lv_line WORD lv_word.

    IF sy-subrc <> 0.
      " V1.2.2: 错误回填附生成源码摘要 —— 审计/回模型都可见编译器实际收到什么
      " V1.3: 原来只给生成源码前 200 字符(多是固定的 PROGRAM/FORM 行, 看不到出错处),
      "       改为给出错行及其上一行; 行号取不到时退回前 200 字符
      DATA: lv_srccode TYPE string,
            lv_lno     TYPE i,
            lv_lprev   TYPE i.
      TRY.
          lv_lno = lv_line.
        CATCH cx_sy_conversion_error.
          lv_lno = 0.
      ENDTRY.
      DATA lv_errline TYPE ty_srcline.
      DATA lv_found   TYPE abap_bool.
      lv_found = abap_false.
      IF lv_lno > 0.
        READ TABLE lt_source INTO lv_errline INDEX lv_lno.
        IF sy-subrc = 0.
          lv_found = abap_true.
        ENDIF.
      ENDIF.
      IF lv_found = abap_true.
        lv_srccode = condense( CONV string( lv_errline ) ).
        lv_lprev = lv_lno - 1.
        IF lv_lprev > 4.                      " 前 4 行是固定的 PROGRAM/FORM/TRY
          READ TABLE lt_source INTO lv_errline INDEX lv_lprev.
          IF sy-subrc = 0.
            lv_srccode = |{ condense( CONV string( lv_errline ) ) } \| { lv_srccode }|.
          ENDIF.
        ENDIF.
      ELSE.
        lv_srccode = concat_lines_of( table = lt_source sep = ` | ` ).
        IF strlen( lv_srccode ) > 200.
          lv_srccode = lv_srccode(200).
        ENDIF.
      ENDIF.
      rs_run-status = 'ERROR'.
      rs_run-error  = |SQL 编译错误(第 { lv_line } 行): { lv_msg } ({ lv_word }). | &&
                      |出错位置附近: [{ lv_srccode }]. 请按 Open SQL 写法修正后重试|.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = rs_run-error.
      log_run( iv_sql = lv_clean iv_status = 'ERROR' iv_rows = 0
               iv_error = rs_run-error iv_session_id = iv_session_id ).
      RETURN.
    ENDIF.

    " ---- 5. 执行 ----
    DATA: lr_data TYPE REF TO data,
          lv_err  TYPE string.

    PERFORM run_sql IN PROGRAM (lv_prog)
      USING lv_max
      CHANGING lr_data lv_err.

    IF lv_err IS NOT INITIAL.
      rs_run-status = 'ERROR'.
      rs_run-error  = |SQL 执行失败: { lv_err }. 请修正语句后重试|.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = rs_run-error.
      log_run( iv_sql = lv_clean iv_status = 'ERROR' iv_rows = 0
               iv_error = rs_run-error iv_session_id = iv_session_id ).
      RETURN.
    ENDIF.

    IF lr_data IS NOT BOUND.
      rs_run-status = 'ERROR'.
      rs_run-error  = '查询未返回结果对象'.
      rs_run-dataset-status = 'ERROR'.
      rs_run-dataset-error  = rs_run-error.
      RETURN.
    ENDIF.

    " ---- 6. RTTI 转统一数据集 ----
    FIELD-SYMBOLS <lt_data> TYPE ANY TABLE.
    ASSIGN lr_data->* TO <lt_data>.

    TRY.
        DATA(lo_tab) = CAST cl_abap_tabledescr(
                         cl_abap_typedescr=>describe_by_data( <lt_data> ) ).
        DATA(lo_line) = CAST cl_abap_structdescr( lo_tab->get_table_line_type( ) ).

        " 列声明(名称 + 是否数值: I/b/s/8/P/F)
        LOOP AT lo_line->components INTO DATA(ls_comp).
          DATA(lv_numeric) = xsdbool( ls_comp-type_kind = 'I' OR ls_comp-type_kind = 'P'
                                   OR ls_comp-type_kind = 'F' OR ls_comp-type_kind = 'b'
                                   OR ls_comp-type_kind = 's' OR ls_comp-type_kind = '8' ).
          APPEND VALUE zcl_ai_data_analysis_service=>ty_column(
                   name    = ls_comp-name
                   label   = ls_comp-name
                   numeric = lv_numeric )
            TO rs_run-dataset-columns.
        ENDLOOP.

        " 行数据(单元格统一转字符串, 长文本截断到 200 字符)
        LOOP AT <lt_data> ASSIGNING FIELD-SYMBOL(<ls_row>).
          cells_from_row( EXPORTING is_struct = <ls_row>
                                    io_desc   = lo_line
                          IMPORTING et_cells  = DATA(lt_cells) ).
          APPEND lt_cells TO rs_run-dataset-rows.
        ENDLOOP.

      CATCH cx_root INTO DATA(lx_conv).
        rs_run-status = 'ERROR'.
        rs_run-error  = |结果转换失败: { lx_conv->get_text( ) }|.
        rs_run-dataset-status = 'ERROR'.
        rs_run-dataset-error  = rs_run-error.
        log_run( iv_sql = lv_clean iv_status = 'ERROR' iv_rows = 0
                 iv_error = rs_run-error iv_session_id = iv_session_id ).
        RETURN.
    ENDTRY.

    rs_run-dataset-total_rows = lines( rs_run-dataset-rows ).
    rs_run-dataset-status     = 'OK'.
    rs_run-status             = 'OK'.

    GET RUN TIME FIELD lv_t1.
    rs_run-dataset-elapsed_ms = ( lv_t1 - lv_t0 ) / 1000.

    log_run( iv_sql = lv_clean iv_status = 'OK'
             iv_rows = rs_run-dataset-total_rows
             iv_error = '' iv_session_id = iv_session_id ).

  ENDMETHOD.


  METHOD split_source.

    " GENERATE SUBROUTINE POOL 要求定长字符行(c 长度), 且断行不能
    " 切断字符串常量、不能压缩常量内部的连续空格:
    " 逐字符扫描, 只在【字面量外】的空格处断行, 行内内容原样保留
    CLEAR et_source.

    DATA: lv_len     TYPE i,
          lv_i       TYPE i,
          lv_start   TYPE i,        " 当前行起点
          lv_last_sp TYPE i,        " 行内最近一个可断点(字面量外空格)的绝对位置
          lv_next    TYPE i,        " V1.2.1: 双 offset 改变量
          lv_cut     TYPE i,        " V1.2.1: 断行长度(length 位置禁表达式)
          lv_open    TYPE abap_bool,
          lv_ch      TYPE c LENGTH 1.

    lv_len = strlen( iv_code ).
    lv_last_sp = -1.

    WHILE lv_i < lv_len.
      lv_ch = iv_code+lv_i(1).

      IF lv_open = abap_true.
        IF lv_ch = `'`.
          lv_next = lv_i + 1.
          IF lv_next < lv_len AND iv_code+lv_next(1) = `'`.
            lv_i = lv_i + 1.            " '' 转义, 跳过第二个引号
          ELSE.
            lv_open = abap_false.
          ENDIF.
        ENDIF.
      ELSEIF lv_ch = `'`.
        lv_open = abap_true.
      ELSEIF lv_ch = ` `.
        lv_last_sp = lv_i.
      ENDIF.

      " 行长达到 198 → 在最近可断点处断行(该空格不保留, 换行即分隔)
      IF lv_i - lv_start >= 198 AND lv_last_sp > lv_start.
        lv_cut = lv_last_sp - lv_start.          " V1.2.1: length 位置不允许算术表达式
        APPEND iv_code+lv_start(lv_cut) TO et_source.
        lv_start = lv_last_sp + 1.
      ENDIF.

      lv_i = lv_i + 1.
    ENDWHILE.

    IF lv_start < lv_len.
      lv_cut = lv_len - lv_start.              " V1.2.1: 无 length 子串改显式 length
      APPEND iv_code+lv_start(lv_cut) TO et_source.
    ENDIF.

  ENDMETHOD.


  METHOD cells_from_row.

    CLEAR et_cells.
    LOOP AT io_desc->components INTO DATA(ls_comp).
      ASSIGN COMPONENT ls_comp-name OF STRUCTURE is_struct
        TO FIELD-SYMBOL(<lv_val>).
      IF sy-subrc <> 0.
        APPEND '' TO et_cells.
        CONTINUE.
      ENDIF.
      CASE ls_comp-type_kind.
        WHEN 'D'.
          DATA lv_d TYPE c LENGTH 8.
          lv_d = <lv_val>.
          APPEND CONV string( lv_d ) TO et_cells.
        WHEN 'T'.
          DATA lv_t TYPE c LENGTH 6.
          lv_t = <lv_val>.
          APPEND CONV string( lv_t ) TO et_cells.
        WHEN OTHERS.
          DATA lv_s TYPE string.
          lv_s = <lv_val>.
          IF strlen( lv_s ) > 200.
            lv_s = lv_s(200) && '…'.
          ENDIF.
          APPEND lv_s TO et_cells.
      ENDCASE.
    ENDLOOP.

  ENDMETHOD.


  METHOD log_run.

    " 动态写审计: 本类激活不依赖 ZAI_SQL_LOG; 表未建时 cx 异常被捕获,
    " 查询结果不受影响(生产环境应尽快建表并监控被拒记录)
    DATA: lr_wa   TYPE REF TO data,
          lv_tab  TYPE c LENGTH 30 VALUE 'ZAI_SQL_LOG'.

    FIELD-SYMBOLS: <ls_log>    TYPE any,
                   <lv_field>  TYPE any.

    TRY.
        CREATE DATA lr_wa TYPE (lv_tab).
        ASSIGN lr_wa->* TO <ls_log>.
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.

        ASSIGN COMPONENT 'QUERY_ID'   OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0.
          GET TIME STAMP FIELD DATA(lv_ts).
          <lv_field> = |SQL{ lv_ts }{ sy-uname }|.
        ENDIF.
        ASSIGN COMPONENT 'USERNAME'   OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = sy-uname. ENDIF.
        ASSIGN COMPONENT 'SQL_TEXT'   OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0.
          <lv_field> = iv_sql.
          IF strlen( <lv_field> ) > 4000.
            <lv_field> = <lv_field>(4000).
          ENDIF.
        ENDIF.
        ASSIGN COMPONENT 'MANDT'      OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = sy-mandt. ENDIF.
        ASSIGN COMPONENT 'STATUS'     OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_status. ENDIF.
        ASSIGN COMPONENT 'RESULT_ROWS' OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_rows. ENDIF.
        ASSIGN COMPONENT 'ERROR_MSG'  OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_error. ENDIF.
        ASSIGN COMPONENT 'SESSION_ID' OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = iv_session_id. ENDIF.
        ASSIGN COMPONENT 'CREATED_AT' OF STRUCTURE <ls_log> TO <lv_field>.
        IF sy-subrc = 0. <lv_field> = |{ sy-datum }{ sy-uzeit }|. ENDIF.

        INSERT (lv_tab) FROM @<ls_log>.
        IF sy-subrc = 0.
          COMMIT WORK.
        ENDIF.

      CATCH cx_root.
        RETURN.
    ENDTRY.

  ENDMETHOD.

ENDCLASS.

