*=======================================================================
* 对象:   ZCL_AI_RFC_EXEC
* 用途:   RFC 函数执行(设计: 功能计划书/RFC函数执行/01-方案与开发计划) ——
*         函数模块登记成 ZAI_RPT_DEF 一行(REPORT_KIND = FUNC, PROGNAME = 函数名,
*         RESULT_REF = 主结果参数), 和报表走同一个后台作业(ZAI_RPT_RUNNER);
*         ZCL_AI_REPORT_EXEC_SAP=>run_captured 读到 FUNC 时调本类 run
*         - read_interface: 读函数接口(FUPARAREF, 参数说明 FUNCT 动态读), 给每个参数
*           建数据对象并归类(SCALAR / FLAG / RANGE / STRUCT / TABLE / GENERIC / EXC)
*         - check_writes / scan_source / name_danger: 登记时的写入类检查(规则与本地参考
*           实现 test-server/rfc-scan-ref.js 一致, npm run test:rfcscan 锁住, 改规则两边同步)
*         - precheck: 提交作业前预检(函数存在 / S_RFC / 参数能绑定)
*         - run: 作业内执行 —— 复核 → S_RFC → 绑定参数 → COMMIT → 动态调用 →
*           立刻 ROLLBACK WORK(撤回函数没提交的改动和更新任务) → 主结果转行
* 安全:   函数名只来自登记表(调用方已核登记 / 归属); 调用后一律 ROLLBACK WORK;
*         S_RFC 按当前用户检查(ZAI_CHAT_CFG 键 RFC_AUTH_CHECK = N 关闭, 默认开)
* 依赖:   ZCL_AI_CODE_PROVIDER V1.1(function_include) / ZCL_AI_REPORT_SERVICE
*         (parse_flat_kv / json_escape) / ZCL_AI_ALV_CAPTURE(tt_col) /
*         ZCL_AI_TASK_SERVICE(read_cfg_str) / TFDIR / FUPARAREF / DD02L(只读)
* 安装:   SE24 -> 新建类 ZCL_AI_RFC_EXEC -> 源代码视图整类粘贴 (ABAP 7.50, 755 适用)
*         激活顺序: CODE_PROVIDER V1.1 之后, REPORT_EXEC_SAP V1.2 之前
* V1.0    20261102: 首版
* V1.1    20261102(功能计划书/RFC函数执行/03-数据分析调用函数方案): 数据分析里同步调用 ——
*         ① list_callable / tool_description: 数据分析可用的函数(FUNC + 活动 + 开放执行 +
*           EXEC_MODE 不是 JOB + 报表授权; 开关 RFC_IN_DATA = N 关闭), 拼成工具说明(最多 30 个);
*         ② call_sync(网关会话): 按调用名找登记 → validate_params(和参数卡同一套) →
*           CALL FUNCTION 'Z_AI_RFC_RUN' DESTINATION 'NONE'(新会话, dump 只变 SYSTEM_FAILURE);
*         ③ run_direct(新会话里, Z_AI_RFC_RUN 调): 复核登记 / 授权 → 同一套绑定 → invoke →
*           主结果转「列 + 字符串单元格」数据集 JSON(键大写, 供 /ui2/cl_json 直接还原);
*         ④ 重构: build_bindings 拆出 bind_core(登记行 + 快照); 调用 + ROLLBACK 收进 invoke,
*           run / run_direct 共用; max_exec 读 RFC_MAX_EXEC(默认 3, 最多 10)
* ★ 核对标记: 有 METHOD read_interface / check_writes / scan_source / name_danger /
*   auth_ok / precheck / run / build_bindings / bind_core / invoke / run_direct / call_sync /
*   list_callable / tool_description; invoke 里 CALL FUNCTION iv_fm PARAMETER-TABLE 之后紧跟
*   ROLLBACK WORK; call_sync 里 CALL FUNCTION 'Z_AI_RFC_RUN' DESTINATION 'NONE';
*   全文没有 FIND PCRE; 方法之间没有注释
* V1.2    20261104(功能计划书/RFC函数执行/05-表参数粘贴数据方案): 表参数 ——
*         ① classify 算出行的可填字段数 cols(行展开 include 后全是单值字段才算, 单字段行 = 1;
*           0 = 不支持); table_columns 给参数卡列说明; table_input_name: TABLES 表按名字
*           (IT_ / I_ / IN_ / INPUT_ / T_IN)或点名当输入, default_result 不再选它当主结果
*         ② 参数值 = JSON 数组的数组(第一行字段名), parse_rows 手写扫描(不用长正则);
*           bind_core 对表 / 结构参数调 fill_table: 按表头对字段, 逐格 set_value(数字去千分位),
*           错误写「第 n 行 字段: 原因」; 最多 gc_tbl_max_rows 行
*         ③ list_callable: 有必填表参数的函数不进数据分析; 说明里不列表参数
* ★ 核对标记 V1.2: 有 METHOD parse_rows / fill_table / table_columns / table_input_name /
*   flat_cols; bind_core 里 WHEN 'STRUCT' OR 'TABLE'
*=======================================================================
CLASS zcl_ai_rfc_exec DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " 函数接口的一个参数(kind = I / E / C / T / X; shape 见类头)
    TYPES: BEGIN OF ty_iparam,
             name        TYPE string,
             kind        TYPE string,
             type_name   TYPE string,
             optional    TYPE abap_bool,
             defval      TYPE string,
             text        TYPE string,
             label       TYPE string,
             shape       TYPE string,
             data_type   TYPE string,    " 参数卡口径: CHAR / NUM / DATE / BOOL
             type_length TYPE i,
             sort_no     TYPE i,
             pos         TYPE i,
             cols        TYPE i,         " V1.2: 表 / 结构行的可填字段数(0 = 不支持粘贴)
           END OF ty_iparam.
    TYPES tt_iparam TYPE STANDARD TABLE OF ty_iparam WITH DEFAULT KEY.

    " 写入类检查命中(level: BLOCK 不能登记 / NAME 名字疑似, 可强制 / WARN 只提示)
    TYPES: BEGIN OF ty_hit,
             level TYPE string,
             code  TYPE string,
             text  TYPE string,
             line  TYPE i,
           END OF ty_hit.
    TYPES tt_hit TYPE STANDARD TABLE OF ty_hit WITH DEFAULT KEY.

    " 写库候选目标(表名, 行号); 是不是透明表由 check_writes 查 DD02L
    TYPES: BEGIN OF ty_target,
             table TYPE string,
             line  TYPE i,
           END OF ty_target.
    TYPES tt_target TYPE STANDARD TABLE OF ty_target WITH DEFAULT KEY.

    " V1.1: 数据分析里可调用的函数(调用名 = TCODE)
    TYPES: BEGIN OF ty_callable,
             report_id      TYPE string,
             tcode          TYPE string,
             name           TYPE string,
             progname       TYPE string,
             config_version TYPE string,
             params_text    TYPE string,
           END OF ty_callable.
    TYPES tt_callable TYPE STANDARD TABLE OF ty_callable WITH DEFAULT KEY.

    CONSTANTS: gc_tool_max_funcs TYPE i VALUE 30,
               gc_data_max_rows  TYPE i VALUE 2000,
               gc_tbl_max_rows   TYPE i VALUE 1000,      " V1.2: 表参数最多行数
               gc_tbl_max_cols   TYPE i VALUE 60.

    " V1.2: 表参数的一列(参数卡列说明)
    TYPES: BEGIN OF ty_tcol,
             name  TYPE string,
             label TYPE string,
             type  TYPE string,
             len   TYPE i,
           END OF ty_tcol.
    TYPES tt_tcol TYPE STANDARD TABLE OF ty_tcol WITH DEFAULT KEY.
    TYPES tt_rows TYPE STANDARD TABLE OF string_table WITH EMPTY KEY.

    " V1.2: TABLES 表当输入: 名字规则或点名(it_tin 大写)
    CLASS-METHODS table_input_name
      IMPORTING iv_name   TYPE clike
                it_tin    TYPE string_table OPTIONAL
      RETURNING VALUE(rv) TYPE abap_bool.

    " V1.2: 表参数的列(参照类型 → 行字段; 单字段行 = TABLE_LINE)
    CLASS-METHODS table_columns
      IMPORTING iv_type_name TYPE clike
      RETURNING VALUE(rt)    TYPE tt_tcol.

    " V1.2: JSON 数组的数组 → 行(每行一组字符串); 手写扫描
    CLASS-METHODS parse_rows
      IMPORTING iv_json  TYPE string
      EXPORTING et_rows  TYPE tt_rows
                ev_error TYPE string.

    CLASS-METHODS read_interface
      IMPORTING iv_fm     TYPE clike
      EXPORTING et_params TYPE tt_iparam
                ev_remote TYPE abap_bool
                ev_group  TYPE string
                ev_error  TYPE string.

    CLASS-METHODS default_result
      IMPORTING it_params TYPE tt_iparam
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS name_danger
      IMPORTING iv_fm     TYPE clike
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS scan_source
      IMPORTING it_src     TYPE string_table
      EXPORTING et_hits    TYPE tt_hit
                et_targets TYPE tt_target.

    CLASS-METHODS check_writes
      IMPORTING iv_fm     TYPE clike
      RETURNING VALUE(rt) TYPE tt_hit.

    CLASS-METHODS auth_ok
      IMPORTING iv_fm     TYPE clike
      RETURNING VALUE(rv) TYPE abap_bool.

    CLASS-METHODS precheck
      IMPORTING iv_fm            TYPE clike
                iv_report_run_id TYPE string
                iv_params_json   TYPE string
      EXPORTING ev_error         TYPE string.

    " V1.1: 数据分析开关(ZAI_CHAT_CFG RFC_IN_DATA = N 关; 不维护 = 开)
    CLASS-METHODS data_enabled
      RETURNING VALUE(rv) TYPE abap_bool.

    " V1.1: 每次提问最多调用几次(RFC_MAX_EXEC, 默认 3, 最多 10)
    CLASS-METHODS max_exec
      RETURNING VALUE(rv) TYPE i.

    " V1.1: 当前用户在数据分析里可调用的函数(同一请求内只算一次)
    CLASS-METHODS list_callable
      RETURNING VALUE(rt) TYPE tt_callable.

    " V1.1: call_function 工具说明(开关关 / 没有可用函数 = 空, 调用方不注册工具)
    CLASS-METHODS tool_description
      RETURNING VALUE(rv) TYPE string.

    " V1.1: 网关会话里同步调用(新会话执行); ev_result = 数据集 JSON(键大写)
    CLASS-METHODS call_sync
      IMPORTING iv_call_name   TYPE string
                iv_params_json TYPE string
                iv_max_rows    TYPE i DEFAULT gc_data_max_rows
      EXPORTING ev_result      TYPE string
                ev_name        TYPE string
                ev_tcode       TYPE string
                ev_error       TYPE string.

    " V1.1: 新会话里执行(Z_AI_RFC_RUN 调); iv_params_json = validate_params 的规范化快照
    CLASS-METHODS run_direct
      IMPORTING iv_report_id   TYPE string
                iv_params_json TYPE string
                iv_max_rows    TYPE i DEFAULT gc_data_max_rows
      EXPORTING ev_result      TYPE string
                ev_error       TYPE string.

    CLASS-METHODS run
      IMPORTING iv_report_run_id TYPE string
                iv_fm            TYPE clike
                iv_params_json   TYPE string
                iv_result_ref    TYPE string OPTIONAL
                iv_max_rows      TYPE i DEFAULT 20000
      EXPORTING ev_total         TYPE i
                et_cols          TYPE zcl_ai_alv_capture=>tt_col
                et_rows          TYPE string_table
                ev_note          TYPE string
                ev_outputs       TYPE string
                ev_error         TYPE string.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_reg,
             param_id      TYPE string,
             abap_name     TYPE string,
             sel_kind      TYPE string,
             multi_value   TYPE abap_bool,
             range_allowed TYPE abap_bool,
             allowed_ops   TYPE string,
           END OF ty_reg.
    TYPES tt_reg TYPE STANDARD TABLE OF ty_reg WITH DEFAULT KEY.

    CLASS-DATA: gt_callable TYPE tt_callable,
                gv_loaded   TYPE abap_bool.

    CLASS-METHODS make_data
      IMPORTING iv_type_name TYPE string
                iv_kind      TYPE string
      RETURNING VALUE(rr)    TYPE REF TO data.

    CLASS-METHODS classify
      IMPORTING ir_data TYPE REF TO data
      CHANGING  cs_p    TYPE ty_iparam.

    CLASS-METHODS flat_cols
      IMPORTING io_sd     TYPE REF TO cl_abap_structdescr
      RETURNING VALUE(rv) TYPE i.

    CLASS-METHODS fill_table
      IMPORTING ir_data TYPE REF TO data
                iv_val  TYPE string
      EXPORTING ev_err  TYPE string.

    CLASS-METHODS elem_info
      IMPORTING io_el    TYPE REF TO cl_abap_elemdescr
      EXPORTING ev_type  TYPE string
                ev_len   TYPE i
                ev_label TYPE string.

    CLASS-METHODS build_bindings
      IMPORTING iv_report_run_id TYPE string
                iv_params_json   TYPE string
                it_params        TYPE tt_iparam
      EXPORTING et_ptab          TYPE abap_func_parmbind_tab
                et_etab          TYPE abap_func_excpbind_tab
                ev_error         TYPE string.

    CLASS-METHODS reg_rows
      IMPORTING iv_report_id TYPE clike
                iv_version   TYPE clike
      RETURNING VALUE(rt)    TYPE tt_reg.

    CLASS-METHODS bind_core
      IMPORTING it_reg         TYPE tt_reg
                iv_params_json TYPE string
                it_params      TYPE tt_iparam
      EXPORTING et_ptab        TYPE abap_func_parmbind_tab
                et_etab        TYPE abap_func_excpbind_tab
                ev_error       TYPE string.

    CLASS-METHODS invoke
      IMPORTING iv_fm    TYPE string
                it_ptab  TYPE abap_func_parmbind_tab
                it_etab  TYPE abap_func_excpbind_tab
      EXPORTING ev_error TYPE string.

    CLASS-METHODS table_to_cells
      IMPORTING ir_tab   TYPE REF TO data
                iv_max   TYPE i
      EXPORTING ev_total TYPE i
                ev_cols  TYPE string
                ev_rows  TYPE string
                ev_error TYPE string.

    CLASS-METHODS cell_text
      IMPORTING iv_val    TYPE any
      EXPORTING ev_text   TYPE string
                ev_num    TYPE abap_bool.

    CLASS-METHODS def_lookup
      IMPORTING iv_report_id TYPE string
      EXPORTING es_def       TYPE ty_callable
                ev_resref    TYPE string
                ev_error     TYPE string.

    CLASS-METHODS set_value
      IMPORTING iv_val TYPE string
      EXPORTING ev_err TYPE string
      CHANGING  cv     TYPE any.

    CLASS-METHODS fill_range
      IMPORTING iv_val   TYPE string
                iv_multi TYPE abap_bool
                iv_range TYPE abap_bool
      EXPORTING ev_err   TYPE string
      CHANGING  ct_tab   TYPE STANDARD TABLE.

    CLASS-METHODS table_to_rows
      IMPORTING ir_tab   TYPE REF TO data
                iv_max   TYPE i
      EXPORTING ev_total TYPE i
                et_cols  TYPE zcl_ai_alv_capture=>tt_col
                et_rows  TYPE string_table
                ev_error TYPE string.

    CLASS-METHODS single_row
      IMPORTING it_ptab   TYPE abap_func_parmbind_tab
                it_params TYPE tt_iparam
      EXPORTING et_cols   TYPE zcl_ai_alv_capture=>tt_col
                et_rows   TYPE string_table.

    CLASS-METHODS return_messages
      IMPORTING ir_data   TYPE REF TO data
      EXPORTING ev_first  TYPE string
                ev_errors TYPE i
                ev_json   TYPE string.

    CLASS-METHODS fm_group
      IMPORTING iv_pname  TYPE clike
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS strip_comment
      IMPORTING iv_line   TYPE string
      EXPORTING ev_code   TYPE string
                ev_nolit  TYPE string.

    CLASS-METHODS add_hit
      IMPORTING iv_level TYPE string
                iv_code  TYPE string
                iv_text  TYPE string
                iv_line  TYPE i
      CHANGING  ct_hits  TYPE tt_hit.

    CLASS-METHODS add_target
      IMPORTING iv_tok     TYPE string
                iv_line    TYPE i
      CHANGING  ct_targets TYPE tt_target
                ct_hits    TYPE tt_hit.

ENDCLASS.



CLASS zcl_ai_rfc_exec IMPLEMENTATION.


  METHOD read_interface.

    TYPES: BEGIN OF ty_txt,
             parameter TYPE c LENGTH 30,
             stext     TYPE c LENGTH 80,
           END OF ty_txt.
    DATA: lv_fm    TYPE string,
          lt_txt   TYPE STANDARD TABLE OF ty_txt WITH DEFAULT KEY,
          lv_cols  TYPE string VALUE `PARAMETER, STEXT`,
          lv_tab   TYPE string VALUE `FUNCT`,
          lv_where TYPE string,
          ls_p     TYPE ty_iparam,
          lr_data  TYPE REF TO data.

    CLEAR: et_params, ev_remote, ev_group, ev_error.
    lv_fm = to_upper( condense( val = CONV string( iv_fm ) ) ).
    IF lv_fm IS INITIAL OR strlen( lv_fm ) > 30 OR lv_fm CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/'.
      ev_error = |函数名不合法: { lv_fm }|.
      RETURN.
    ENDIF.

    SELECT SINGLE pname, fmode FROM tfdir
      WHERE funcname = @lv_fm
      INTO @DATA(ls_dir).
    IF sy-subrc <> 0.
      ev_error = |函数模块 { lv_fm } 不存在|.
      RETURN.
    ENDIF.
    ev_remote = xsdbool( ls_dir-fmode = 'R' ).
    ev_group  = fm_group( ls_dir-pname ).

    SELECT parameter, paramtype, pposition, structure, defaultval, optional
      FROM fupararef
      WHERE funcname = @lv_fm AND r3state = 'A'
      INTO TABLE @DATA(lt_fp).

    lv_where = |FUNCNAME = '{ lv_fm }' AND SPRAS = '{ sy-langu }'|.
    TRY.
        SELECT (lv_cols) FROM (lv_tab) WHERE (lv_where) INTO TABLE @lt_txt.
      CATCH cx_sy_dynamic_osql_error.
        CLEAR lt_txt.
    ENDTRY.

    LOOP AT lt_fp INTO DATA(ls_fp).
      CLEAR ls_p.
      ls_p-name      = to_upper( condense( val = CONV string( ls_fp-parameter ) ) ).
      ls_p-kind      = ls_fp-paramtype.
      ls_p-type_name = to_upper( condense( val = CONV string( ls_fp-structure ) ) ).
      ls_p-defval    = condense( val = CONV string( ls_fp-defaultval ) ).
      ls_p-optional  = xsdbool( ls_fp-optional = 'X' OR ls_p-defval IS NOT INITIAL ).
      ls_p-pos       = ls_fp-pposition.
      ls_p-sort_no   = SWITCH i( ls_p-kind WHEN 'I' THEN 1 WHEN 'T' THEN 2 WHEN 'C' THEN 3
                                           WHEN 'E' THEN 4 ELSE 5 ).
      READ TABLE lt_txt INTO DATA(ls_txt) WITH KEY parameter = ls_fp-parameter.
      IF sy-subrc = 0.
        ls_p-text = condense( val = CONV string( ls_txt-stext ) ).
      ENDIF.
      IF ls_p-kind = 'X'.
        ls_p-shape = 'EXC'.
      ELSE.
        lr_data = make_data( iv_type_name = ls_p-type_name iv_kind = ls_p-kind ).
        IF lr_data IS BOUND.
          classify( EXPORTING ir_data = lr_data CHANGING cs_p = ls_p ).
        ELSE.
          ls_p-shape = 'GENERIC'.
        ENDIF.
      ENDIF.
      IF ls_p-text IS NOT INITIAL.
        ls_p-label = ls_p-text.
      ELSEIF ls_p-label IS INITIAL.
        ls_p-label = ls_p-name.
      ENDIF.
      APPEND ls_p TO et_params.
    ENDLOOP.
    SORT et_params BY sort_no pos.

  ENDMETHOD.


  METHOD default_result.

    CLEAR rv.
    LOOP AT it_params INTO DATA(ls_p) WHERE shape = 'TABLE' AND name <> 'RETURN'
                                       AND ( kind = 'T' OR kind = 'E' OR kind = 'C' ).
      " V1.2: 当输入的 TABLES 表不当主结果
      IF ls_p-kind = 'T' AND table_input_name( ls_p-name ) = abap_true.
        CONTINUE.
      ENDIF.
      rv = ls_p-name.
      RETURN.
    ENDLOOP.

  ENDMETHOD.


  METHOD name_danger.

    DATA: lv_fm    TYPE string,
          lt_words TYPE string_table.

    CLEAR rv.
    lv_fm = to_upper( condense( val = CONV string( iv_fm ) ) ).
    lt_words = VALUE #( ( `CREATE` ) ( `CHANGE` ) ( `DELETE` ) ( `POST` ) ( `SAVE` )
                        ( `UPDATE` ) ( `CANCEL` ) ( `RELEASE` ) ( `SEND` ) ).
    LOOP AT lt_words INTO DATA(lv_w).
      IF lv_fm CS lv_w.
        rv = lv_w.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD scan_source.

    DATA: lv_code  TYPE string,
          lv_nolit TYPE string,
          lv_up    TYPE string,
          lv_buf   TYPE string,
          lv_start TYPE i,
          lv_lno   TYPE i,
          lv_npc   TYPE i,
          lv_i     TYPE i,
          lv_stmt  TYPE string,
          lt_pcs   TYPE string_table,
          lt_stmts TYPE STANDARD TABLE OF ty_target WITH DEFAULT KEY,
          ls_stmt  TYPE ty_target,
          lt_tok   TYPE string_table,
          lv_t1    TYPE string,
          lv_t2    TYPE string,
          lv_t3    TYPE string,
          lv_seq   TYPE string,
          lv_tmp   TYPE string,
          lv_ntok  TYPE i.

    CLEAR: et_hits, et_targets.

    LOOP AT it_src INTO DATA(lv_line).
      lv_lno = sy-tabix.
      IF strlen( lv_line ) > 0 AND lv_line(1) = '*'.
        CONTINUE.
      ENDIF.
      strip_comment( EXPORTING iv_line = lv_line IMPORTING ev_code = lv_code ev_nolit = lv_nolit ).
      lv_up = to_upper( lv_code ).
      IF lv_up CS `'BAPI_TRANSACTION_COMMIT'`.
        add_hit( EXPORTING iv_level = `BLOCK` iv_code = `BAPICOMMIT`
                           iv_text = `调用 BAPI_TRANSACTION_COMMIT` iv_line = lv_lno
                 CHANGING ct_hits = et_hits ).
      ENDIF.
      IF lv_up CS `'POPUP_`.
        add_hit( EXPORTING iv_level = `WARN` iv_code = `POPUP`
                           iv_text = `调用弹窗函数(后台作业里会中止)` iv_line = lv_lno
                 CHANGING ct_hits = et_hits ).
      ENDIF.

      lv_up = to_upper( lv_nolit ).
      CLEAR lt_pcs.
      SPLIT lv_up AT '.' INTO TABLE lt_pcs.
      " 行尾是句点时 SPLIT 不产生末尾空段: 补一段, 让最后一句也结束
      IF strlen( lv_up ) > 0.
        lv_i = strlen( lv_up ) - 1.
        IF lv_up+lv_i(1) = '.'.
          APPEND `` TO lt_pcs.
        ENDIF.
      ENDIF.
      lv_npc = lines( lt_pcs ).
      LOOP AT lt_pcs INTO DATA(lv_pc).
        lv_i = sy-tabix.
        lv_tmp = condense( lv_buf ).
        IF lv_tmp IS INITIAL.
          lv_tmp = condense( lv_pc ).
          IF lv_tmp IS NOT INITIAL.
            lv_start = lv_lno.
          ENDIF.
        ENDIF.
        lv_buf = lv_buf && ` ` && lv_pc.
        IF lv_i < lv_npc.
          lv_tmp = condense( lv_buf ).
          IF lv_tmp IS NOT INITIAL.
            ls_stmt-table = lv_buf.
            ls_stmt-line  = lv_start.
            APPEND ls_stmt TO lt_stmts.
          ENDIF.
          CLEAR lv_buf.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
    lv_tmp = condense( lv_buf ).
    IF lv_tmp IS NOT INITIAL.
      ls_stmt-table = lv_buf.
      ls_stmt-line  = lv_start.
      APPEND ls_stmt TO lt_stmts.
    ENDIF.

    LOOP AT lt_stmts INTO ls_stmt.
      lv_stmt = ls_stmt-table.
      REPLACE ALL OCCURRENCES OF ':' IN lv_stmt WITH ` `.
      REPLACE ALL OCCURRENCES OF ',' IN lv_stmt WITH ` `.
      CONDENSE lv_stmt.
      CLEAR lt_tok.
      SPLIT lv_stmt AT space INTO TABLE lt_tok.
      DELETE lt_tok WHERE table_line IS INITIAL.
      lv_ntok = lines( lt_tok ).
      IF lv_ntok = 0.
        CONTINUE.
      ENDIF.
      CLEAR: lv_t1, lv_t2, lv_t3.
      READ TABLE lt_tok INTO lv_t1 INDEX 1.
      READ TABLE lt_tok INTO lv_t2 INDEX 2.
      READ TABLE lt_tok INTO lv_t3 INDEX 3.
      lv_seq = | { lv_stmt } |.

      IF lv_seq CS ` COMMIT WORK `.
        add_hit( EXPORTING iv_level = `BLOCK` iv_code = `COMMIT`
                           iv_text = `提交数据库(COMMIT WORK)` iv_line = ls_stmt-line
                 CHANGING ct_hits = et_hits ).
      ENDIF.
      IF lv_seq CS ` IN UPDATE TASK `.
        add_hit( EXPORTING iv_level = `BLOCK` iv_code = `UPDTASK`
                           iv_text = `更新任务(IN UPDATE TASK)` iv_line = ls_stmt-line
                 CHANGING ct_hits = et_hits ).
      ENDIF.
      IF lv_seq CS ` IN BACKGROUND TASK `.
        add_hit( EXPORTING iv_level = `BLOCK` iv_code = `BGTASK`
                           iv_text = `后台任务(IN BACKGROUND TASK)` iv_line = ls_stmt-line
                 CHANGING ct_hits = et_hits ).
      ENDIF.
      IF lv_seq CS ` STARTING NEW TASK `.
        add_hit( EXPORTING iv_level = `BLOCK` iv_code = `NEWTASK`
                           iv_text = `异步调用(STARTING NEW TASK)` iv_line = ls_stmt-line
                 CHANGING ct_hits = et_hits ).
      ENDIF.
      IF lv_t1 = `SUBMIT`.
        add_hit( EXPORTING iv_level = `WARN` iv_code = `SUBMIT`
                           iv_text = `运行其他程序(SUBMIT)` iv_line = ls_stmt-line
                 CHANGING ct_hits = et_hits ).
      ENDIF.
      IF lv_t1 = `CALL` AND ( lv_t2 = `TRANSACTION` OR lv_t2 = `SCREEN` OR lv_t2 = `DIALOG` ).
        add_hit( EXPORTING iv_level = `WARN` iv_code = `CALLUI`
                           iv_text = |调用界面(CALL { lv_t2 }, 后台作业里会中止)| iv_line = ls_stmt-line
                 CHANGING ct_hits = et_hits ).
      ENDIF.

      CASE lv_t1.
        WHEN `UPDATE`.
          IF lv_t2 IS NOT INITIAL.
            add_target( EXPORTING iv_tok = lv_t2 iv_line = ls_stmt-line
                        CHANGING ct_targets = et_targets ct_hits = et_hits ).
          ENDIF.
        WHEN `INSERT`.
          IF lv_t2 = `LINES` OR lv_t2 = `INITIAL` OR lv_seq CS ` INTO TABLE `.
            CONTINUE.
          ENDIF.
          IF lv_t2 = `INTO`.
            IF lv_t3 IS NOT INITIAL.
              add_target( EXPORTING iv_tok = lv_t3 iv_line = ls_stmt-line
                          CHANGING ct_targets = et_targets ct_hits = et_hits ).
            ENDIF.
          ELSEIF lv_t3 = `FROM` OR lv_ntok = 2.
            add_target( EXPORTING iv_tok = lv_t2 iv_line = ls_stmt-line
                        CHANGING ct_targets = et_targets ct_hits = et_hits ).
          ENDIF.
        WHEN `MODIFY`.
          IF lv_t2 IS NOT INITIAL AND lv_t2 <> `TABLE` AND lv_t2 <> `LINE`
             AND lv_t2 <> `SCREEN` AND lv_t2 <> `CURRENT`.
            add_target( EXPORTING iv_tok = lv_t2 iv_line = ls_stmt-line
                        CHANGING ct_targets = et_targets ct_hits = et_hits ).
          ENDIF.
        WHEN `DELETE`.
          IF lv_t2 = `FROM`.
            IF lv_t3 IS NOT INITIAL AND lv_t3 <> `MEMORY` AND lv_t3 <> `SHARED` AND lv_t3 <> `DATABASE`.
              add_target( EXPORTING iv_tok = lv_t3 iv_line = ls_stmt-line
                          CHANGING ct_targets = et_targets ct_hits = et_hits ).
            ENDIF.
          ELSEIF lv_t2 IS NOT INITIAL AND lv_t2 <> `ADJACENT` AND lv_t2 <> `TABLE`
                 AND lv_t2 <> `DATASET` AND lv_t2 <> `REPORT` AND lv_t2 <> `TEXTPOOL`
                 AND lv_t2 <> `DYNPRO`.
            add_target( EXPORTING iv_tok = lv_t2 iv_line = ls_stmt-line
                        CHANGING ct_targets = et_targets ct_hits = et_hits ).
          ENDIF.
      ENDCASE.
    ENDLOOP.

  ENDMETHOD.


  METHOD check_writes.

    TYPES: BEGIN OF ty_line,
             text TYPE c LENGTH 255,
           END OF ty_line.
    DATA: lv_fm    TYPE string,
          lv_inc   TYPE string,
          lv_pname TYPE progname,
          lt_lines TYPE STANDARD TABLE OF ty_line WITH DEFAULT KEY,
          lt_src   TYPE string_table,
          lt_hits  TYPE tt_hit,
          lt_tg    TYPE tt_target,
          lv_tab   TYPE dd02l-tabname,
          lv_w     TYPE string.

    CLEAR rt.
    lv_fm = to_upper( condense( val = CONV string( iv_fm ) ) ).

    lv_w = name_danger( lv_fm ).
    IF lv_w IS NOT INITIAL.
      add_hit( EXPORTING iv_level = `NAME` iv_code = `NAME`
                         iv_text = |函数名含 { lv_w }(疑似写入类)| iv_line = 0
               CHANGING ct_hits = rt ).
    ENDIF.

    SELECT SINGLE pname, include FROM tfdir
      WHERE funcname = @lv_fm
      INTO @DATA(ls_dir).
    IF sy-subrc <> 0.
      add_hit( EXPORTING iv_level = `BLOCK` iv_code = `NOFM`
                         iv_text = |函数模块 { lv_fm } 不存在| iv_line = 0
               CHANGING ct_hits = rt ).
      RETURN.
    ENDIF.
    lv_inc = zcl_ai_code_provider=>function_include( iv_pname = ls_dir-pname iv_include = ls_dir-include ).
    lv_pname = lv_inc.
    READ REPORT lv_pname INTO lt_lines.
    IF sy-subrc <> 0.
      add_hit( EXPORTING iv_level = `BLOCK` iv_code = `NOSRC`
                         iv_text = |读不到函数源码 { lv_inc }, 无法检查是否写数据库| iv_line = 0
               CHANGING ct_hits = rt ).
      RETURN.
    ENDIF.
    LOOP AT lt_lines INTO DATA(ls_l).
      APPEND CONV string( ls_l-text ) TO lt_src.
    ENDLOOP.

    scan_source( EXPORTING it_src = lt_src IMPORTING et_hits = lt_hits et_targets = lt_tg ).
    APPEND LINES OF lt_hits TO rt.

    LOOP AT lt_tg INTO DATA(ls_tg).
      IF strlen( ls_tg-table ) > 30.
        CONTINUE.
      ENDIF.
      lv_tab = ls_tg-table.
      SELECT SINGLE tabname FROM dd02l
        WHERE tabname = @lv_tab AND as4local = 'A' AND tabclass = 'TRANSP'
        INTO @DATA(lv_hit).
      IF sy-subrc = 0.
        add_hit( EXPORTING iv_level = `BLOCK` iv_code = `DBWRITE`
                           iv_text = |写数据库表 { ls_tg-table }| iv_line = ls_tg-line
                 CHANGING ct_hits = rt ).
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD auth_ok.

    DATA: lv_fm   TYPE string,
          lv_off  TYPE string,
          lv_n30  TYPE c LENGTH 30,
          lv_g30  TYPE c LENGTH 30.

    lv_off = to_upper( condense( val = zcl_ai_task_service=>read_cfg_str( 'RFC_AUTH_CHECK' ) ) ).
    IF lv_off = 'N' OR lv_off = '-'.
      rv = abap_true.
      RETURN.
    ENDIF.

    lv_fm  = to_upper( condense( val = CONV string( iv_fm ) ) ).
    lv_n30 = lv_fm.
    AUTHORITY-CHECK OBJECT 'S_RFC'
      ID 'RFC_TYPE' FIELD 'FUNC'
      ID 'RFC_NAME' FIELD lv_n30
      ID 'ACTVT'    FIELD '16'.
    IF sy-subrc = 0.
      rv = abap_true.
      RETURN.
    ENDIF.

    SELECT SINGLE pname FROM tfdir WHERE funcname = @lv_fm INTO @DATA(lv_pname).
    IF sy-subrc <> 0.
      rv = abap_false.
      RETURN.
    ENDIF.
    lv_g30 = fm_group( lv_pname ).
    AUTHORITY-CHECK OBJECT 'S_RFC'
      ID 'RFC_TYPE' FIELD 'FUGR'
      ID 'RFC_NAME' FIELD lv_g30
      ID 'ACTVT'    FIELD '16'.
    rv = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  METHOD precheck.

    DATA: lt_params TYPE tt_iparam,
          lt_ptab   TYPE abap_func_parmbind_tab,
          lt_etab   TYPE abap_func_excpbind_tab,
          lv_fm     TYPE string.

    CLEAR ev_error.
    lv_fm = to_upper( condense( val = CONV string( iv_fm ) ) ).
    read_interface( EXPORTING iv_fm = lv_fm IMPORTING et_params = lt_params ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF auth_ok( lv_fm ) = abap_false.
      ev_error = |没有函数 { lv_fm } 的调用权限(S_RFC, 按函数或函数组, 活动 16), 请联系管理员|.
      RETURN.
    ENDIF.
    build_bindings( EXPORTING iv_report_run_id = iv_report_run_id
                              iv_params_json   = iv_params_json
                              it_params        = lt_params
                    IMPORTING et_ptab          = lt_ptab
                              et_etab          = lt_etab
                              ev_error         = ev_error ).

  ENDMETHOD.


  METHOD run.

    DATA: lv_fm     TYPE string,
          lt_params TYPE tt_iparam,
          lt_ptab   TYPE abap_func_parmbind_tab,
          lt_etab   TYPE abap_func_excpbind_tab,
          lv_ref    TYPE string,
          lv_first  TYPE string,
          lv_nerr   TYPE i,
          lv_rjson  TYPE string,
          lv_outs   TYPE string,
          lv_otxt   TYPE string,
          lv_seg    TYPE string,
          lv_n      TYPE i.
    FIELD-SYMBOLS <lv_v> TYPE any.

    CLEAR: ev_total, et_cols, et_rows, ev_note, ev_outputs, ev_error.
    lv_fm = to_upper( condense( val = CONV string( iv_fm ) ) ).

    read_interface( EXPORTING iv_fm = lv_fm IMPORTING et_params = lt_params ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF auth_ok( lv_fm ) = abap_false.
      ev_error = |没有函数 { lv_fm } 的调用权限(S_RFC, 按函数或函数组, 活动 16), 请联系管理员|.
      RETURN.
    ENDIF.
    build_bindings( EXPORTING iv_report_run_id = iv_report_run_id
                              iv_params_json   = iv_params_json
                              it_params        = lt_params
                    IMPORTING et_ptab          = lt_ptab
                              et_etab          = lt_etab
                              ev_error         = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.

    invoke( EXPORTING iv_fm = lv_fm it_ptab = lt_ptab it_etab = lt_etab
            IMPORTING ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.

    " 主结果: 登记的 RESULT_REF; 没登记按默认规则取第一个表; 都没有 = 输出参数合成一行
    lv_ref = to_upper( condense( val = iv_result_ref ) ).
    IF lv_ref IS INITIAL.
      lv_ref = default_result( lt_params ).
    ENDIF.
    READ TABLE lt_ptab INTO DATA(ls_res) WITH TABLE KEY name = CONV abap_parmname( lv_ref ).
    IF lv_ref IS NOT INITIAL AND sy-subrc = 0 AND ls_res-value IS BOUND.
      table_to_rows( EXPORTING ir_tab   = ls_res-value
                               iv_max   = iv_max_rows
                     IMPORTING ev_total = ev_total
                               et_cols  = et_cols
                               et_rows  = et_rows
                               ev_error = ev_error ).
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
    ELSE.
      single_row( EXPORTING it_ptab = lt_ptab it_params = lt_params
                  IMPORTING et_cols = et_cols et_rows = et_rows ).
      ev_total = lines( et_rows ).
    ENDIF.

    " RETURN 消息(BAPIRET2 / BAPIRETURN 类): 有 E / A 且没有数据 → 失败
    READ TABLE lt_ptab INTO DATA(ls_ret) WITH TABLE KEY name = CONV abap_parmname( 'RETURN' ).
    IF sy-subrc = 0 AND ls_ret-value IS BOUND.
      return_messages( EXPORTING ir_data = ls_ret-value
                       IMPORTING ev_first = lv_first ev_errors = lv_nerr ev_json = lv_rjson ).
      IF lv_nerr > 0 AND ev_total = 0.
        ev_error = |函数 { lv_fm } 返回错误消息: { lv_first }|.
        RETURN.
      ENDIF.
      IF lv_nerr > 0.
        ev_note = |函数同时返回了 { lv_nerr } 条错误消息, 第一条: { lv_first }|.
      ENDIF.
    ENDIF.

    " 其他输出: EXPORTING 单值(最多 10 个)放元数据行 outputs + note
    LOOP AT lt_params INTO DATA(ls_p) WHERE kind = 'E' AND shape = 'SCALAR' AND name <> lv_ref.
      READ TABLE lt_ptab INTO DATA(ls_b) WITH TABLE KEY name = CONV abap_parmname( ls_p-name ).
      IF sy-subrc <> 0 OR ls_b-value IS NOT BOUND.
        CONTINUE.
      ENDIF.
      ASSIGN ls_b-value->* TO <lv_v>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      lv_n = lv_n + 1.
      IF lv_n > 10.
        EXIT.
      ENDIF.
      lv_seg = |"{ zcl_ai_report_service=>json_escape( ls_p-name ) }":| &&
               /ui2/cl_json=>serialize( data = <lv_v> compress = abap_false ).
      lv_outs = COND #( WHEN lv_outs IS INITIAL THEN lv_seg ELSE lv_outs && ',' && lv_seg ).
      lv_otxt = COND #( WHEN lv_otxt IS INITIAL THEN |{ ls_p-label } = { <lv_v> }|
                        ELSE |{ lv_otxt }; { ls_p-label } = { <lv_v> }| ).
    ENDLOOP.
    IF lv_rjson IS NOT INITIAL.
      lv_seg  = |"RETURN":{ lv_rjson }|.
      lv_outs = COND #( WHEN lv_outs IS INITIAL THEN lv_seg ELSE lv_outs && ',' && lv_seg ).
    ENDIF.
    IF lv_outs IS NOT INITIAL.
      ev_outputs = |\{{ lv_outs }\}|.
    ENDIF.
    IF lv_otxt IS NOT INITIAL.
      ev_note = COND #( WHEN ev_note IS INITIAL THEN |其他输出: { lv_otxt }|
                        ELSE |{ ev_note }; 其他输出: { lv_otxt }| ).
    ENDIF.

  ENDMETHOD.


  METHOD invoke.

    DATA: lv_rc  TYPE sysubrc,
          lv_exc TYPE string,
          lv_msg TYPE string.

    CLEAR ev_error.
    " 先提交调用方自己的写入, 调用后的 ROLLBACK WORK 只撤回函数的改动
    COMMIT WORK.
    TRY.
        CALL FUNCTION iv_fm PARAMETER-TABLE it_ptab EXCEPTION-TABLE it_etab.
        lv_rc = sy-subrc.
      CATCH cx_sy_dyn_call_error INTO DATA(lx_dyn).
        ROLLBACK WORK.
        ev_error = |参数和函数 { iv_fm } 的接口不一致, 函数接口可能改过, 请重新登记({ lx_dyn->get_text( ) })|.
        RETURN.
    ENDTRY.
    IF lv_rc <> 0 AND sy-msgid IS NOT INITIAL.
      MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
        WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_msg.
    ENDIF.
    ROLLBACK WORK.

    IF lv_rc <> 0.
      READ TABLE it_etab INTO DATA(ls_e) WITH KEY value = lv_rc.
      IF sy-subrc = 0.
        lv_exc = ls_e-name.
      ENDIF.
      IF lv_exc = 'ERROR_MESSAGE'.
        ev_error = |函数 { iv_fm } 报错: { COND string( WHEN lv_msg IS NOT INITIAL THEN lv_msg ELSE '(没有消息文本)' ) }|.
      ELSE.
        ev_error = |函数 { iv_fm } 返回例外 { COND string( WHEN lv_exc IS NOT INITIAL THEN lv_exc ELSE |{ lv_rc }| ) }| &&
                   COND string( WHEN lv_msg IS NOT INITIAL THEN |: { lv_msg }| ).
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD data_enabled.

    DATA lv TYPE string.
    lv = to_upper( condense( val = zcl_ai_task_service=>read_cfg_str( 'RFC_IN_DATA' ) ) ).
    rv = xsdbool( lv <> 'N' AND lv <> '-' ).

  ENDMETHOD.


  METHOD max_exec.

    DATA lv TYPE string.
    rv = 3.
    lv = condense( val = zcl_ai_task_service=>read_cfg_str( 'RFC_MAX_EXEC' ) ).
    IF lv IS INITIAL OR lv CN '0123456789'.
      RETURN.
    ENDIF.
    rv = lv.
    IF rv < 1.
      rv = 3.
    ELSEIF rv > 10.
      rv = 10.
    ENDIF.

  ENDMETHOD.


  METHOD list_callable.

    DATA: ls_c    TYPE ty_callable,
          lt_par  TYPE zcl_ai_report_service=>tt_param,
          lv_pt   TYPE string,
          lv_seg  TYPE string,
          lv_kind TYPE string.

    IF gv_loaded = abap_true.
      rt = gt_callable.
      RETURN.
    ENDIF.
    gv_loaded = abap_true.
    CLEAR gt_callable.
    IF data_enabled( ) = abap_false.
      RETURN.
    ENDIF.

    SELECT report_id, tcode, report_name, progname, config_version, exec_mode
      FROM zai_rpt_def
      WHERE report_kind = 'FUNC' AND active = 'X' AND exec_enabled = 'X'
      ORDER BY tcode
      INTO TABLE @DATA(lt_def).

    LOOP AT lt_def INTO DATA(ls_def).
      IF to_upper( condense( val = CONV string( ls_def-exec_mode ) ) ) = 'JOB'.
        CONTINUE.
      ENDIF.
      IF zcl_ai_access=>report_ok( iv_src_type  = zcl_ai_access=>gc_src_report
                                   iv_report_id = CONV string( ls_def-report_id ) ) = abap_false.
        CONTINUE.
      ENDIF.
      CLEAR: ls_c, lv_pt.
      ls_c-report_id      = ls_def-report_id.
      ls_c-tcode          = ls_def-tcode.
      ls_c-name           = ls_def-report_name.
      ls_c-progname       = ls_def-progname.
      ls_c-config_version = ls_def-config_version.
      " 参数说明: 编号 标签(*必填)(类型 / 多值 / 范围 / 复选框), 与参数卡同一份登记
      lt_par = zcl_ai_report_service=>get_params( iv_report_id      = ls_c-report_id
                                                  iv_config_version = ls_c-config_version ).
      " V1.2: 表参数数据分析里传不了 —— 有必填的整个函数不进清单, 选填的不列
      IF line_exists( lt_par[ sel_kind = 'T' required = abap_true ] ).
        CONTINUE.
      ENDIF.
      DELETE lt_par WHERE sel_kind = 'T'.
      LOOP AT lt_par INTO DATA(ls_p).
        lv_kind = COND #( WHEN ls_p-data_type = 'BOOL' THEN `X/空`
                          WHEN ls_p-range_allowed = abap_true THEN |{ ls_p-data_type } 范围 low,high|
                          WHEN ls_p-multi_value = abap_true THEN |{ ls_p-data_type } 多值逗号分隔|
                          WHEN ls_p-data_type = 'DATE' THEN `YYYYMMDD`
                          ELSE |{ ls_p-data_type }{ COND string( WHEN ls_p-type_length > 0 THEN |{ ls_p-type_length }| ) }| ).
        lv_seg = |{ ls_p-param_id } { ls_p-display_label }{ COND string( WHEN ls_p-required = abap_true THEN `*` ) }({ lv_kind })|.
        lv_pt = COND #( WHEN lv_pt IS INITIAL THEN lv_seg ELSE |{ lv_pt }、{ lv_seg }| ).
      ENDLOOP.
      ls_c-params_text = lv_pt.
      APPEND ls_c TO gt_callable.
    ENDLOOP.
    rt = gt_callable.

  ENDMETHOD.


  METHOD tool_description.

    DATA: lt_c   TYPE tt_callable,
          lv_n   TYPE i,
          lv_lst TYPE string.

    CLEAR rv.
    lt_c = list_callable( ).
    IF lt_c IS INITIAL.
      RETURN.
    ENDIF.
    LOOP AT lt_c INTO DATA(ls_c).
      lv_n = lv_n + 1.
      IF lv_n > gc_tool_max_funcs.
        EXIT.
      ENDIF.
      lv_lst = lv_lst && |{ ls_c-tcode } { ls_c-name }: { ls_c-params_text }; |.
    ENDLOOP.
    rv = '调用系统里已登记的只读查询函数(秒级出数), 返回统一数据集(表格+图表可用)。'
         && '有现成函数能直接回答时优先用它, 不够再用 run_sql 补查。'
         && 'args: {"function":"<调用名>","purpose":"<一句话, 作为结果标题>","params":{"<参数编号>":"<值>"}}; '
         && '带 * 的参数必填, 缺了先问用户; 多值用逗号分隔, 范围写 low,high, 复选框写 X 或空, 日期 YYYYMMDD。'
         && |可用函数: { lv_lst }|.
    IF lines( lt_c ) > gc_tool_max_funcs.
      rv = rv && |(还有 { lines( lt_c ) - gc_tool_max_funcs } 个未列出, 知道调用名也可以直接调用)|.
    ENDIF.

  ENDMETHOD.


  METHOD call_sync.

    DATA: lv_call TYPE string,
          lt_c    TYPE tt_callable,
          ls_def  TYPE zcl_ai_report_service=>ty_def,
          ls_pv   TYPE zcl_ai_report_service=>ty_pvres,
          lv_msg  TYPE c LENGTH 255,
          lv_res  TYPE string,
          lv_err  TYPE string,
          lv_perr TYPE string.

    CLEAR: ev_result, ev_name, ev_tcode, ev_error.
    lv_call = to_upper( condense( val = iv_call_name ) ).
    IF data_enabled( ) = abap_false.
      ev_error = '数据分析里调用函数的功能已关闭(RFC_IN_DATA)'.
      RETURN.
    ENDIF.

    " 只能调可用清单里的(登记 + 开放执行 + 不是 JOB + 有授权); 清单外的知道调用名也可以, 规则相同
    lt_c = list_callable( ).
    READ TABLE lt_c INTO DATA(ls_c) WITH KEY tcode = lv_call.
    IF sy-subrc <> 0.
      ev_error = |函数 { lv_call } 未登记、未开放、只能走报表执行, 或你没有使用权限; 可用的函数见工具说明|.
      RETURN.
    ENDIF.
    ev_name  = ls_c-name.
    ev_tcode = ls_c-tcode.

    " 参数: 和参数卡同一套校验(必填 / 类型 / 范围 / 值域 / 默认值)
    ls_def = zcl_ai_report_service=>get_def( ls_c-report_id ).
    IF ls_def-report_id IS INITIAL.
      ev_error = |函数 { lv_call } 的登记读取失败|.
      RETURN.
    ENDIF.
    ls_pv = zcl_ai_report_service=>validate_params( is_def = ls_def iv_params_json = iv_params_json ).
    IF ls_pv-ok = abap_false OR ls_pv-needs_input = abap_true.
      LOOP AT ls_pv-errors INTO DATA(ls_e).
        lv_perr = COND #( WHEN lv_perr IS INITIAL THEN |{ ls_e-param_id }: { ls_e-message }|
                          ELSE |{ lv_perr }; { ls_e-param_id }: { ls_e-message }| ).
      ENDLOOP.
      ev_error = |参数不对: { COND string( WHEN lv_perr IS NOT INITIAL THEN lv_perr ELSE '缺必填参数' ) }(参数编号和格式见工具说明)|.
      RETURN.
    ENDIF.

    " 新会话里执行: 函数 dump 只会变成 SYSTEM_FAILURE, 不打断当前 Agent 请求
    " 同步 RFC 会让调用方隐式提交一次数据库(调用方此前没有未提交的写操作)
    CALL FUNCTION 'Z_AI_RFC_RUN' DESTINATION 'NONE'
      EXPORTING
        iv_report_id          = ls_c-report_id
        iv_params_json        = ls_pv-norm_json
        iv_max_rows           = iv_max_rows
      IMPORTING
        ev_result             = lv_res
        ev_error              = lv_err
      EXCEPTIONS
        system_failure        = 1 MESSAGE lv_msg
        communication_failure = 2 MESSAGE lv_msg
        OTHERS                = 3.
    IF sy-subrc <> 0.
      ev_error = |函数调用中断({ COND string( WHEN sy-subrc = 1 THEN 'SYSTEM_FAILURE' WHEN sy-subrc = 2 THEN 'COMMUNICATION_FAILURE' ELSE 'OTHERS' ) }): | &&
                 |{ condense( val = CONV string( lv_msg ) ) }; 请换条件, 或改用报表执行|.
    ELSE.
      ev_result = lv_res.
      ev_error  = lv_err.
    ENDIF.
    CALL FUNCTION 'RFC_CONNECTION_CLOSE'
      EXPORTING
        destination          = 'NONE'
      EXCEPTIONS
        destination_not_open = 1
        OTHERS               = 2.

  ENDMETHOD.


  METHOD def_lookup.

    CLEAR: es_def, ev_resref, ev_error.
    SELECT SINGLE report_id, tcode, report_name, progname, config_version, report_kind, result_ref
      FROM zai_rpt_def
      WHERE report_id = @iv_report_id AND active = 'X' AND exec_enabled = 'X'
      INTO @DATA(ls_row).
    IF sy-subrc <> 0 OR to_upper( condense( val = CONV string( ls_row-report_kind ) ) ) <> 'FUNC'.
      ev_error = |函数登记 { iv_report_id } 不存在、已停用或未开放执行|.
      RETURN.
    ENDIF.
    IF zcl_ai_access=>report_ok( iv_src_type  = zcl_ai_access=>gc_src_report
                                 iv_report_id = iv_report_id ) = abap_false.
      ev_error = |你没有函数 { ls_row-tcode } 的使用权限|.
      RETURN.
    ENDIF.
    es_def-report_id      = ls_row-report_id.
    es_def-tcode          = ls_row-tcode.
    es_def-name           = ls_row-report_name.
    es_def-progname       = to_upper( condense( val = CONV string( ls_row-progname ) ) ).
    es_def-config_version = ls_row-config_version.
    ev_resref             = to_upper( condense( val = CONV string( ls_row-result_ref ) ) ).

  ENDMETHOD.


  METHOD run_direct.

    DATA: ls_def    TYPE ty_callable,
          lv_ref    TYPE string,
          lt_params TYPE tt_iparam,
          lt_ptab   TYPE abap_func_parmbind_tab,
          lt_etab   TYPE abap_func_excpbind_tab,
          lv_total  TYPE i,
          lv_cols   TYPE string,
          lv_rows   TYPE string,
          lv_first  TYPE string,
          lv_nerr   TYPE i,
          lv_rjson  TYPE string,
          lv_note   TYPE string,
          lv_trunc  TYPE string,
          lv_text   TYPE string,
          lv_num    TYPE abap_bool,
          lv_seg    TYPE string,
          lv_cell   TYPE string.
    FIELD-SYMBOLS <lv_v> TYPE any.

    CLEAR: ev_result, ev_error.

    " 新会话里再核一遍登记与授权(Z_AI_RFC_RUN 能被单独调用)
    def_lookup( EXPORTING iv_report_id = iv_report_id
                IMPORTING es_def = ls_def ev_resref = lv_ref ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    read_interface( EXPORTING iv_fm = ls_def-progname IMPORTING et_params = lt_params ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF auth_ok( ls_def-progname ) = abap_false.
      ev_error = |没有函数 { ls_def-progname } 的调用权限(S_RFC, 按函数或函数组, 活动 16), 请联系管理员|.
      RETURN.
    ENDIF.
    bind_core( EXPORTING it_reg         = reg_rows( iv_report_id = ls_def-report_id iv_version = ls_def-config_version )
                         iv_params_json = iv_params_json
                         it_params      = lt_params
               IMPORTING et_ptab        = lt_ptab
                         et_etab        = lt_etab
                         ev_error       = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.

    invoke( EXPORTING iv_fm = ls_def-progname it_ptab = lt_ptab it_etab = lt_etab
            IMPORTING ev_error = ev_error ).
    IF ev_error IS NOT INITIAL.
      RETURN.
    ENDIF.

    IF lv_ref IS INITIAL.
      lv_ref = default_result( lt_params ).
    ENDIF.
    READ TABLE lt_ptab INTO DATA(ls_res) WITH TABLE KEY name = CONV abap_parmname( lv_ref ).
    IF lv_ref IS NOT INITIAL AND sy-subrc = 0 AND ls_res-value IS BOUND.
      table_to_cells( EXPORTING ir_tab   = ls_res-value
                                iv_max   = iv_max_rows
                      IMPORTING ev_total = lv_total
                                ev_cols  = lv_cols
                                ev_rows  = lv_rows
                                ev_error = ev_error ).
      IF ev_error IS NOT INITIAL.
        RETURN.
      ENDIF.
    ELSE.
      " 没有表输出: EXPORTING / CHANGING 单值合成一行
      LOOP AT lt_params INTO DATA(ls_p) WHERE ( kind = 'E' OR kind = 'C' ) AND ( shape = 'SCALAR' OR shape = 'FLAG' ).
        READ TABLE lt_ptab INTO DATA(ls_b) WITH TABLE KEY name = CONV abap_parmname( ls_p-name ).
        IF sy-subrc <> 0 OR ls_b-value IS NOT BOUND.
          CONTINUE.
        ENDIF.
        ASSIGN ls_b-value->* TO <lv_v>.
        cell_text( EXPORTING iv_val = <lv_v> IMPORTING ev_text = lv_text ev_num = lv_num ).
        lv_seg  = |\{"NAME":"{ zcl_ai_report_service=>json_escape( ls_p-name ) }","LABEL":"{ zcl_ai_report_service=>json_escape( ls_p-label ) }","NUMERIC":"{ lv_num }"\}|.
        lv_cols = COND #( WHEN lv_cols IS INITIAL THEN lv_seg ELSE lv_cols && ',' && lv_seg ).
        lv_cell = |"{ zcl_ai_report_service=>json_escape( lv_text ) }"|.
        lv_rows = COND #( WHEN lv_rows IS INITIAL THEN lv_cell ELSE lv_rows && ',' && lv_cell ).
      ENDLOOP.
      IF lv_rows IS NOT INITIAL.
        lv_rows  = |[{ lv_rows }]|.
        lv_total = 1.
      ENDIF.
    ENDIF.

    READ TABLE lt_ptab INTO DATA(ls_ret) WITH TABLE KEY name = CONV abap_parmname( 'RETURN' ).
    IF sy-subrc = 0 AND ls_ret-value IS BOUND.
      return_messages( EXPORTING ir_data = ls_ret-value
                       IMPORTING ev_first = lv_first ev_errors = lv_nerr ev_json = lv_rjson ).
      IF lv_nerr > 0 AND lv_total = 0.
        ev_error = |函数 { ls_def-progname } 返回错误消息: { lv_first }|.
        RETURN.
      ENDIF.
      IF lv_nerr > 0.
        lv_note = |函数同时返回了 { lv_nerr } 条错误消息, 第一条: { lv_first }|.
      ENDIF.
    ENDIF.
    IF lv_total > iv_max_rows.
      lv_trunc = 'X'.
      lv_note  = COND #( WHEN lv_note IS INITIAL THEN |共 { lv_total } 行, 只取前 { iv_max_rows } 行|
                         ELSE |{ lv_note }; 共 { lv_total } 行, 只取前 { iv_max_rows } 行| ).
    ENDIF.

    " 键大写: 调用方 /ui2/cl_json=>deserialize 不设 pretty_name 直接还原成 ty_dataset
    ev_result = |\{"NAME":"{ zcl_ai_report_service=>json_escape( ls_def-name ) }",| &&
                |"STATUS":"OK","COLUMNS":[{ lv_cols }],"ROWS":[{ lv_rows }],| &&
                |"TOTAL_ROWS":{ lv_total },"TRUNCATED":"{ lv_trunc }",| &&
                |"ERROR":"{ zcl_ai_report_service=>json_escape( lv_note ) }"\}|.

  ENDMETHOD.


  METHOD table_to_cells.

    DATA: lo_td   TYPE REF TO cl_abap_typedescr,
          lo_tab  TYPE REF TO cl_abap_tabledescr,
          lo_line TYPE REF TO cl_abap_datadescr,
          lo_sd   TYPE REF TO cl_abap_structdescr,
          lt_dd   TYPE ddfields,
          lt_name TYPE string_table,
          lv_lbl  TYPE string,
          lv_seg  TYPE string,
          lv_row  TYPE string,
          lv_text TYPE string,
          lv_num  TYPE abap_bool,
          lv_n    TYPE i,
          lv_flat TYPE abap_bool,
          lv_first TYPE abap_bool VALUE abap_true.
    FIELD-SYMBOLS: <lt_tab> TYPE ANY TABLE,
                   <ls_row> TYPE any,
                   <lv_c>   TYPE any.

    CLEAR: ev_total, ev_cols, ev_rows, ev_error.
    ASSIGN ir_tab->* TO <lt_tab>.
    IF sy-subrc <> 0.
      ev_error = '主结果参数不是内表, 请在登记里改选主结果(RESULT_REF)'.
      RETURN.
    ENDIF.
    ev_total = lines( <lt_tab> ).
    lo_td  = cl_abap_typedescr=>describe_by_data( <lt_tab> ).
    lo_tab ?= lo_td.
    lo_line = lo_tab->get_table_line_type( ).

    IF lo_line->kind <> cl_abap_typedescr=>kind_struct.
      lv_flat = abap_true.
      APPEND `VALUE` TO lt_name.
    ELSE.
      lo_sd ?= lo_line.
      lo_sd->get_ddic_field_list(
        EXPORTING p_langu = sy-langu
        RECEIVING p_field_list = lt_dd
        EXCEPTIONS OTHERS = 1 ).
      IF sy-subrc <> 0.
        CLEAR lt_dd.
      ENDIF.
      LOOP AT lo_sd->components INTO DATA(ls_comp).
        CASE ls_comp-type_kind.
          WHEN 'h' OR 'l' OR 'r' OR 'm' OR 'u' OR 'v'.
            CONTINUE.
        ENDCASE.
        APPEND CONV string( ls_comp-name ) TO lt_name.
      ENDLOOP.
    ENDIF.

    " 单元格: 日期 YYYY-MM-DD / 数值原样 / 转换例程 _OUTPUT; 列的「数值」按第一行的值类型定
    LOOP AT <lt_tab> ASSIGNING <ls_row>.
      lv_n = lv_n + 1.
      IF lv_n > iv_max.
        EXIT.
      ENDIF.
      CLEAR lv_row.
      LOOP AT lt_name INTO DATA(lv_name).
        IF lv_flat = abap_true.
          ASSIGN <ls_row> TO <lv_c>.
        ELSE.
          ASSIGN COMPONENT lv_name OF STRUCTURE <ls_row> TO <lv_c>.
        ENDIF.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        cell_text( EXPORTING iv_val = <lv_c> IMPORTING ev_text = lv_text ev_num = lv_num ).
        lv_seg = |"{ zcl_ai_report_service=>json_escape( lv_text ) }"|.
        lv_row = COND #( WHEN lv_row IS INITIAL THEN lv_seg ELSE lv_row && ',' && lv_seg ).
        IF lv_first = abap_true.
          CLEAR lv_lbl.
          READ TABLE lt_dd INTO DATA(ls_dd) WITH KEY fieldname = lv_name.
          IF sy-subrc = 0.
            lv_lbl = COND #( WHEN ls_dd-scrtext_m IS NOT INITIAL THEN condense( val = CONV string( ls_dd-scrtext_m ) )
                             ELSE condense( val = CONV string( ls_dd-fieldtext ) ) ).
          ENDIF.
          IF lv_lbl IS INITIAL.
            lv_lbl = lv_name.
          ENDIF.
          lv_seg  = |\{"NAME":"{ zcl_ai_report_service=>json_escape( lv_name ) }","LABEL":"{ zcl_ai_report_service=>json_escape( lv_lbl ) }","NUMERIC":"{ lv_num }"\}|.
          ev_cols = COND #( WHEN ev_cols IS INITIAL THEN lv_seg ELSE ev_cols && ',' && lv_seg ).
        ENDIF.
      ENDLOOP.
      lv_first = abap_false.
      lv_row  = |[{ lv_row }]|.
      ev_rows = COND #( WHEN ev_rows IS INITIAL THEN lv_row ELSE ev_rows && ',' && lv_row ).
    ENDLOOP.

    " 0 行: 列照样给(标题取字典), 数值标记为空
    IF lv_first = abap_true.
      LOOP AT lt_name INTO lv_name.
        CLEAR lv_lbl.
        READ TABLE lt_dd INTO ls_dd WITH KEY fieldname = lv_name.
        IF sy-subrc = 0.
          lv_lbl = condense( val = CONV string( ls_dd-scrtext_m ) ).
        ENDIF.
        IF lv_lbl IS INITIAL.
          lv_lbl = lv_name.
        ENDIF.
        lv_seg  = |\{"NAME":"{ zcl_ai_report_service=>json_escape( lv_name ) }","LABEL":"{ zcl_ai_report_service=>json_escape( lv_lbl ) }","NUMERIC":""\}|.
        ev_cols = COND #( WHEN ev_cols IS INITIAL THEN lv_seg ELSE ev_cols && ',' && lv_seg ).
      ENDLOOP.
    ENDIF.

  ENDMETHOD.


  METHOD cell_text.

    DATA: lo_td   TYPE REF TO cl_abap_typedescr,
          lo_el   TYPE REF TO cl_abap_elemdescr,
          ls_df   TYPE dfies,
          lv_conv TYPE string,
          lv_cfm  TYPE string,
          lv_out  TYPE c LENGTH 255,
          lv_d    TYPE d,
          lv_t    TYPE t.

    CLEAR: ev_text, ev_num.
    lo_td = cl_abap_typedescr=>describe_by_data( iv_val ).
    IF lo_td->kind <> cl_abap_typedescr=>kind_elem.
      RETURN.
    ENDIF.
    lo_el ?= lo_td.
    CASE lo_el->type_kind.
      WHEN cl_abap_typedescr=>typekind_date.
        lv_d = iv_val.
        IF lv_d IS NOT INITIAL.
          ev_text = |{ lv_d+0(4) }-{ lv_d+4(2) }-{ lv_d+6(2) }|.
        ENDIF.
        RETURN.
      WHEN cl_abap_typedescr=>typekind_time.
        lv_t = iv_val.
        ev_text = |{ lv_t+0(2) }:{ lv_t+2(2) }:{ lv_t+4(2) }|.
        RETURN.
      WHEN cl_abap_typedescr=>typekind_int OR cl_abap_typedescr=>typekind_int1
        OR cl_abap_typedescr=>typekind_int2 OR cl_abap_typedescr=>typekind_packed
        OR cl_abap_typedescr=>typekind_float OR cl_abap_typedescr=>typekind_int8
        OR cl_abap_typedescr=>typekind_decfloat16 OR cl_abap_typedescr=>typekind_decfloat34.
        ev_num  = abap_true.
        ev_text = |{ iv_val }|.
        RETURN.
    ENDCASE.

    " 字符: 有转换例程的走 _OUTPUT(料号去前导零, 和 SAP 界面一样)
    IF lo_el->is_ddic_type( ) = abap_true.
      lo_el->get_ddic_field(
        EXPORTING p_langu = sy-langu
        RECEIVING p_flddescr = ls_df
        EXCEPTIONS OTHERS = 1 ).
      IF sy-subrc = 0.
        lv_conv = condense( val = CONV string( ls_df-convexit ) ).
      ENDIF.
    ENDIF.
    IF lv_conv IS NOT INITIAL AND iv_val IS NOT INITIAL.
      lv_cfm = |CONVERSION_EXIT_{ lv_conv }_OUTPUT|.
      TRY.
          CALL FUNCTION lv_cfm
            EXPORTING
              input  = iv_val
            IMPORTING
              output = lv_out
            EXCEPTIONS
              OTHERS = 1.
          IF sy-subrc = 0.
            ev_text = condense( val = CONV string( lv_out ) ).
            RETURN.
          ENDIF.
        CATCH cx_root.
          CLEAR lv_out.
      ENDTRY.
    ENDIF.
    ev_text = condense( val = |{ iv_val }| ).

  ENDMETHOD.


  METHOD make_data.

    DATA: lv_t  TYPE string,
          lo_td TYPE REF TO cl_abap_typedescr.

    CLEAR rr.
    lv_t = to_upper( condense( val = iv_type_name ) ).
    IF lv_t IS INITIAL.
      RETURN.
    ENDIF.
    " 通用类型建不出具体数据对象(C / N / X / P 不带长度也算通用)
    IF lv_t = 'ANY' OR lv_t = 'DATA' OR lv_t = 'SIMPLE' OR lv_t = 'CLIKE' OR lv_t = 'CSEQUENCE'
       OR lv_t = 'XSEQUENCE' OR lv_t = 'NUMERIC' OR lv_t = 'OBJECT' OR lv_t = 'TABLE'
       OR lv_t = 'ANY TABLE' OR lv_t = 'INDEX TABLE' OR lv_t = 'STANDARD TABLE'
       OR lv_t = 'SORTED TABLE' OR lv_t = 'HASHED TABLE' OR lv_t = 'C' OR lv_t = 'N'
       OR lv_t = 'X' OR lv_t = 'P' OR lv_t = 'DECFLOAT'.
      RETURN.
    ENDIF.

    TRY.
        IF iv_kind = 'T'.
          cl_abap_typedescr=>describe_by_name(
            EXPORTING p_name = lv_t
            RECEIVING p_descr_ref = lo_td
            EXCEPTIONS OTHERS = 1 ).
          IF sy-subrc = 0 AND lo_td IS BOUND AND lo_td->kind = cl_abap_typedescr=>kind_table.
            CREATE DATA rr TYPE (lv_t).
          ELSE.
            CREATE DATA rr TYPE STANDARD TABLE OF (lv_t) WITH DEFAULT KEY.
          ENDIF.
        ELSE.
          CREATE DATA rr TYPE (lv_t).
        ENDIF.
      CATCH cx_sy_create_data_error cx_sy_struct_creation cx_sy_table_creation.
        CLEAR rr.
    ENDTRY.

  ENDMETHOD.


  METHOD classify.

    DATA: lo_td   TYPE REF TO cl_abap_typedescr,
          lo_el   TYPE REF TO cl_abap_elemdescr,
          lo_tab  TYPE REF TO cl_abap_tabledescr,
          lo_line TYPE REF TO cl_abap_datadescr,
          lo_sd   TYPE REF TO cl_abap_structdescr,
          lo_low  TYPE REF TO cl_abap_datadescr,
          lv_rel  TYPE string,
          lv_lbl  TYPE string.

    lo_td = cl_abap_typedescr=>describe_by_data_ref( ir_data ).
    CASE lo_td->kind.
      WHEN cl_abap_typedescr=>kind_elem.
        lo_el ?= lo_td.
        elem_info( EXPORTING io_el = lo_el
                   IMPORTING ev_type = cs_p-data_type ev_len = cs_p-type_length ev_label = lv_lbl ).
        cs_p-label = lv_lbl.
        lv_rel = to_upper( lo_el->get_relative_name( ) ).
        IF lo_el->type_kind = cl_abap_typedescr=>typekind_char AND lo_el->output_length = 1
           AND ( lv_rel = 'XFELD' OR lv_rel = 'FLAG' OR lv_rel = 'BOOLE_D' OR lv_rel = 'ABAP_BOOL'
                 OR lv_rel = 'ABAP_BOOLEAN' OR lv_rel = 'XFLAG' OR lv_rel = 'CHAR1_X' ).
          cs_p-shape       = 'FLAG'.
          cs_p-data_type   = 'BOOL'.
          cs_p-type_length = 1.
        ELSE.
          cs_p-shape = 'SCALAR'.
        ENDIF.
      WHEN cl_abap_typedescr=>kind_struct.
        cs_p-shape = 'STRUCT'.
        lo_sd ?= lo_td.
        cs_p-cols = flat_cols( lo_sd ).
      WHEN cl_abap_typedescr=>kind_table.
        lo_tab ?= lo_td.
        lo_line = lo_tab->get_table_line_type( ).
        cs_p-shape = 'TABLE'.
        IF lo_line->kind = cl_abap_typedescr=>kind_elem.
          cs_p-cols = 1.
        ENDIF.
        IF lo_line->kind = cl_abap_typedescr=>kind_struct.
          lo_sd ?= lo_line.
          cs_p-cols = flat_cols( lo_sd ).
          IF line_exists( lo_sd->components[ name = 'SIGN' ] )
             AND line_exists( lo_sd->components[ name = 'OPTION' ] )
             AND line_exists( lo_sd->components[ name = 'LOW' ] )
             AND line_exists( lo_sd->components[ name = 'HIGH' ] ).
            cs_p-shape = 'RANGE'.
            lo_sd->get_component_type(
              EXPORTING p_name = 'LOW'
              RECEIVING p_descr_ref = lo_low
              EXCEPTIONS OTHERS = 1 ).
            IF sy-subrc = 0 AND lo_low IS BOUND AND lo_low->kind = cl_abap_typedescr=>kind_elem.
              lo_el ?= lo_low.
              elem_info( EXPORTING io_el = lo_el
                         IMPORTING ev_type = cs_p-data_type ev_len = cs_p-type_length ev_label = lv_lbl ).
              cs_p-label = lv_lbl.
            ELSE.
              cs_p-data_type = 'CHAR'.
            ENDIF.
          ENDIF.
        ENDIF.
      WHEN OTHERS.
        cs_p-shape = 'GENERIC'.
    ENDCASE.

  ENDMETHOD.


  METHOD flat_cols.

    DATA lt_view TYPE cl_abap_structdescr=>included_view.

    CLEAR rv.
    lt_view = io_sd->get_included_view( ).
    LOOP AT lt_view INTO DATA(ls_c).
      IF ls_c-type->kind <> cl_abap_typedescr=>kind_elem.
        CLEAR rv.
        RETURN.
      ENDIF.
      rv = rv + 1.
    ENDLOOP.

  ENDMETHOD.


  METHOD table_input_name.

    DATA lv TYPE string.

    CLEAR rv.
    lv = to_upper( condense( val = CONV string( iv_name ) ) ).
    IF lv IS INITIAL.
      RETURN.
    ENDIF.
    IF line_exists( it_tin[ table_line = lv ] ).
      rv = abap_true.
      RETURN.
    ENDIF.
    FIND REGEX '^(IT|I|IN|INPUT)_|^T_IN' IN lv.
    IF sy-subrc = 0.
      rv = abap_true.
    ENDIF.

  ENDMETHOD.


  METHOD table_columns.

    DATA: lo_td   TYPE REF TO cl_abap_typedescr,
          lo_tab  TYPE REF TO cl_abap_tabledescr,
          lo_line TYPE REF TO cl_abap_datadescr,
          lo_sd   TYPE REF TO cl_abap_structdescr,
          lo_el   TYPE REF TO cl_abap_elemdescr,
          lt_view TYPE cl_abap_structdescr=>included_view,
          ls_col  TYPE ty_tcol,
          lv_t    TYPE string.

    CLEAR rt.
    lv_t = to_upper( condense( val = CONV string( iv_type_name ) ) ).
    IF lv_t IS INITIAL.
      RETURN.
    ENDIF.
    cl_abap_typedescr=>describe_by_name(
      EXPORTING  p_name         = lv_t
      RECEIVING  p_descr_ref    = lo_td
      EXCEPTIONS type_not_found = 1
                 OTHERS         = 2 ).
    IF sy-subrc <> 0 OR lo_td IS NOT BOUND.
      RETURN.
    ENDIF.
    IF lo_td->kind = cl_abap_typedescr=>kind_table.
      lo_tab ?= lo_td.
      lo_line = lo_tab->get_table_line_type( ).
    ELSEIF lo_td->kind = cl_abap_typedescr=>kind_struct OR lo_td->kind = cl_abap_typedescr=>kind_elem.
      lo_line ?= lo_td.
    ELSE.
      RETURN.
    ENDIF.

    IF lo_line->kind = cl_abap_typedescr=>kind_elem.
      lo_el ?= lo_line.
      CLEAR ls_col.
      ls_col-name = 'TABLE_LINE'.
      elem_info( EXPORTING io_el = lo_el IMPORTING ev_type = ls_col-type ev_len = ls_col-len ev_label = ls_col-label ).
      APPEND ls_col TO rt.
      RETURN.
    ENDIF.
    IF lo_line->kind <> cl_abap_typedescr=>kind_struct.
      RETURN.
    ENDIF.
    lo_sd ?= lo_line.
    lt_view = lo_sd->get_included_view( ).
    LOOP AT lt_view INTO DATA(ls_c).
      IF ls_c-type->kind <> cl_abap_typedescr=>kind_elem.
        CONTINUE.
      ENDIF.
      lo_el ?= ls_c-type.
      CLEAR ls_col.
      ls_col-name = ls_c-name.
      elem_info( EXPORTING io_el = lo_el IMPORTING ev_type = ls_col-type ev_len = ls_col-len ev_label = ls_col-label ).
      IF ls_col-label IS INITIAL.
        ls_col-label = ls_col-name.
      ENDIF.
      APPEND ls_col TO rt.
      IF lines( rt ) >= gc_tbl_max_cols.
        EXIT.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD parse_rows.

    DATA: lv_len  TYPE i,
          lv_i    TYPE i,
          lv_c    TYPE string,
          lv_e    TYPE string,
          lv_hit  TYPE i,
          lv_n    TYPE i,
          lv_cell TYPE string,
          lv_hex  TYPE c LENGTH 4,
          lt_row  TYPE string_table.

    CLEAR: et_rows, ev_error.
    lv_len = strlen( iv_json ).
    IF lv_len = 0.
      RETURN.
    ENDIF.

    " 外层 [
    WHILE lv_i < lv_len AND substring( val = iv_json off = lv_i len = 1 ) CO | \t\n\r|.
      lv_i = lv_i + 1.
    ENDWHILE.
    IF lv_i >= lv_len OR substring( val = iv_json off = lv_i len = 1 ) <> '['.
      ev_error = '表数据格式不对(要 [[字段名…],[值…]])'.
      RETURN.
    ENDIF.
    lv_i = lv_i + 1.

    DO.
      WHILE lv_i < lv_len AND substring( val = iv_json off = lv_i len = 1 ) CO | \t\n\r,|.
        lv_i = lv_i + 1.
      ENDWHILE.
      IF lv_i >= lv_len.
        ev_error = '表数据不完整(缺少结尾的 ])'.
        RETURN.
      ENDIF.
      lv_c = substring( val = iv_json off = lv_i len = 1 ).
      IF lv_c = ']'.
        EXIT.
      ENDIF.
      IF lv_c <> '['.
        ev_error = |表数据格式不对(第 { lines( et_rows ) + 1 } 行不是数组)|.
        RETURN.
      ENDIF.
      lv_i = lv_i + 1.
      CLEAR lt_row.

      " 一行里的格子
      DO.
        WHILE lv_i < lv_len AND substring( val = iv_json off = lv_i len = 1 ) CO | \t\n\r|.
          lv_i = lv_i + 1.
        ENDWHILE.
        IF lv_i >= lv_len.
          ev_error = '表数据不完整(行没有结尾的 ])'.
          RETURN.
        ENDIF.
        lv_c = substring( val = iv_json off = lv_i len = 1 ).
        IF lv_c = ']'.
          lv_i = lv_i + 1.
          EXIT.
        ELSEIF lv_c = ','.
          lv_i = lv_i + 1.
          CONTINUE.
        ELSEIF lv_c = '"'.
          lv_i = lv_i + 1.
          CLEAR lv_cell.
          DO.
            FIND FIRST OCCURRENCE OF REGEX '["\\]' IN SECTION OFFSET lv_i OF iv_json MATCH OFFSET lv_hit.
            IF sy-subrc <> 0.
              ev_error = '表数据里有没闭合的引号'.
              RETURN.
            ENDIF.
            lv_n = lv_hit - lv_i.
            IF lv_n > 0.
              lv_cell = lv_cell && substring( val = iv_json off = lv_i len = lv_n ).
            ENDIF.
            IF substring( val = iv_json off = lv_hit len = 1 ) = '"'.
              lv_i = lv_hit + 1.
              EXIT.
            ENDIF.
            " 反斜杠转义
            IF lv_hit + 1 >= lv_len.
              ev_error = '表数据里有不完整的转义'.
              RETURN.
            ENDIF.
            lv_e = substring( val = iv_json off = lv_hit + 1 len = 1 ).
            CASE lv_e.
              WHEN 'n' OR 't' OR 'r'.
                lv_cell = lv_cell && ` `.
                lv_i = lv_hit + 2.
              WHEN 'u'.
                IF lv_hit + 6 > lv_len.
                  ev_error = '表数据里有不完整的 \u 转义'.
                  RETURN.
                ENDIF.
                lv_hex = substring( val = iv_json off = lv_hit + 2 len = 4 ).
                TRY.
                    lv_cell = lv_cell && cl_abap_conv_in_ce=>uccp( lv_hex ).
                  CATCH cx_root.
                    lv_cell = lv_cell && `?`.
                ENDTRY.
                lv_i = lv_hit + 6.
              WHEN OTHERS.
                lv_cell = lv_cell && lv_e.
                lv_i = lv_hit + 2.
            ENDCASE.
          ENDDO.
          APPEND lv_cell TO lt_row.
        ELSE.
          " 不带引号的数字 / null / true / false
          FIND FIRST OCCURRENCE OF REGEX '[,\]]' IN SECTION OFFSET lv_i OF iv_json MATCH OFFSET lv_hit.
          IF sy-subrc <> 0.
            ev_error = '表数据不完整(行没有结尾的 ])'.
            RETURN.
          ENDIF.
          lv_cell = condense( val = substring( val = iv_json off = lv_i len = lv_hit - lv_i ) ).
          IF lv_cell = 'null'.
            CLEAR lv_cell.
          ENDIF.
          APPEND lv_cell TO lt_row.
          lv_i = lv_hit.
        ENDIF.
      ENDDO.

      APPEND lt_row TO et_rows.
      IF lines( et_rows ) > gc_tbl_max_rows + 1.
        ev_error = |表数据超过 { gc_tbl_max_rows } 行, 请分批|.
        RETURN.
      ENDIF.
    ENDDO.

  ENDMETHOD.


  METHOD fill_table.

    DATA: lt_rows  TYPE tt_rows,
          lt_head  TYPE string_table,
          lt_map   TYPE string_table,
          lo_td    TYPE REF TO cl_abap_typedescr,
          lo_tab   TYPE REF TO cl_abap_tabledescr,
          lo_line  TYPE REF TO cl_abap_datadescr,
          lo_cell  TYPE REF TO cl_abap_typedescr,
          lo_el    TYPE REF TO cl_abap_elemdescr,
          lr_line  TYPE REF TO data,
          lv_single TYPE abap_bool,
          lv_elem  TYPE abap_bool,
          lv_h     TYPE string,
          lv_f     TYPE string,
          lv_cell  TYPE string,
          lv_err   TYPE string,
          lv_rowno TYPE i,
          lv_col   TYPE i,
          lv_any   TYPE abap_bool,
          lv_ndata TYPE i.
    FIELD-SYMBOLS: <lt>   TYPE ANY TABLE,
                   <ls>   TYPE any,
                   <lv>   TYPE any,
                   <lv_t> TYPE any,
                   <lt_r> TYPE string_table.

    CLEAR ev_err.
    parse_rows( EXPORTING iv_json = iv_val IMPORTING et_rows = lt_rows ev_error = ev_err ).
    IF ev_err IS NOT INITIAL.
      RETURN.
    ENDIF.
    IF lt_rows IS INITIAL.
      RETURN.
    ENDIF.
    READ TABLE lt_rows INTO lt_head INDEX 1.

    lo_td = cl_abap_typedescr=>describe_by_data_ref( ir_data ).
    IF lo_td->kind = cl_abap_typedescr=>kind_table.
      lo_tab ?= lo_td.
      lo_line = lo_tab->get_table_line_type( ).
      ASSIGN ir_data->* TO <lt>.
    ELSEIF lo_td->kind = cl_abap_typedescr=>kind_struct.
      lv_single = abap_true.
      lo_line ?= lo_td.
    ELSE.
      ev_err = '不是表或结构'.
      RETURN.
    ENDIF.
    CREATE DATA lr_line TYPE HANDLE lo_line.
    ASSIGN lr_line->* TO <ls>.
    lv_elem = xsdbool( lo_line->kind = cl_abap_typedescr=>kind_elem ).
    IF lv_elem = abap_false AND lo_line->kind <> cl_abap_typedescr=>kind_struct.
      ev_err = '表的行类型不支持(只支持扁平结构或单字段)'.
      RETURN.
    ENDIF.

    " 表头 → 字段
    LOOP AT lt_head INTO lv_h.
      lv_h = to_upper( condense( val = lv_h ) ).
      IF lv_elem = abap_true.
        IF lines( lt_head ) > 1.
          ev_err = '这张表每行只有一个值, 只能有一列'.
          RETURN.
        ENDIF.
        APPEND `TABLE_LINE` TO lt_map.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT lv_h OF STRUCTURE <ls> TO <lv>.
      IF sy-subrc <> 0 OR lv_h IS INITIAL.
        ev_err = |列「{ lv_h }」不是这张表的字段|.
        RETURN.
      ENDIF.
      IF cl_abap_typedescr=>describe_by_data( <lv> )->kind <> cl_abap_typedescr=>kind_elem.
        ev_err = |字段 { lv_h } 不是单值字段, 不能粘贴|.
        RETURN.
      ENDIF.
      APPEND lv_h TO lt_map.
    ENDLOOP.

    lv_ndata = lines( lt_rows ) - 1.
    IF lv_ndata > gc_tbl_max_rows.
      ev_err = |超过 { gc_tbl_max_rows } 行, 请分批|.
      RETURN.
    ENDIF.

    LOOP AT lt_rows ASSIGNING <lt_r> FROM 2.
      lv_rowno = sy-tabix - 1.
      CLEAR: <ls>, lv_any.
      LOOP AT <lt_r> INTO lv_cell.
        lv_col = sy-tabix.
        READ TABLE lt_map INTO lv_f INDEX lv_col.
        IF sy-subrc <> 0.
          ev_err = |第 { lv_rowno } 行比表头多出列|.
          RETURN.
        ENDIF.
        lv_cell = condense( val = lv_cell ).
        IF lv_cell IS INITIAL.
          CONTINUE.
        ENDIF.
        lv_any = abap_true.
        IF lv_elem = abap_true.
          ASSIGN <ls> TO <lv>.
        ELSE.
          ASSIGN COMPONENT lv_f OF STRUCTURE <ls> TO <lv>.
        ENDIF.
        " 数字列去千分位(Excel 复制常带 1,234.5)
        lo_cell = cl_abap_typedescr=>describe_by_data( <lv> ).
        IF lo_cell->kind = cl_abap_typedescr=>kind_elem.
          lo_el ?= lo_cell.
          IF lo_el->type_kind CA 'PIbs8Fae'.
            REPLACE ALL OCCURRENCES OF ',' IN lv_cell WITH ``.
          ENDIF.
        ENDIF.
        CLEAR lv_err.
        set_value( EXPORTING iv_val = lv_cell IMPORTING ev_err = lv_err CHANGING cv = <lv> ).
        IF lv_err IS NOT INITIAL.
          ev_err = |第 { lv_rowno } 行 { lv_f }: { lv_err }|.
          RETURN.
        ENDIF.
      ENDLOOP.
      IF lv_any = abap_false.
        CONTINUE.
      ENDIF.
      IF lv_single = abap_true.
        IF lv_rowno > 1.
          ev_err = '这个参数是结构, 只能填一行'.
          RETURN.
        ENDIF.
        ASSIGN ir_data->* TO <lv_t>.
        <lv_t> = <ls>.
      ELSE.
        INSERT <ls> INTO TABLE <lt>.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD elem_info.

    DATA ls_df TYPE dfies.

    CLEAR: ev_type, ev_len, ev_label.
    CASE io_el->type_kind.
      WHEN cl_abap_typedescr=>typekind_date.
        ev_type = 'DATE'.
        ev_len  = 8.
      WHEN cl_abap_typedescr=>typekind_int OR cl_abap_typedescr=>typekind_int1
        OR cl_abap_typedescr=>typekind_int2 OR cl_abap_typedescr=>typekind_packed
        OR cl_abap_typedescr=>typekind_float OR cl_abap_typedescr=>typekind_int8
        OR cl_abap_typedescr=>typekind_decfloat16 OR cl_abap_typedescr=>typekind_decfloat34.
        ev_type = 'NUM'.
        ev_len  = io_el->output_length.
      WHEN OTHERS.
        ev_type = 'CHAR'.
        ev_len  = io_el->output_length.
    ENDCASE.
    IF io_el->is_ddic_type( ) = abap_true.
      io_el->get_ddic_field(
        EXPORTING p_langu = sy-langu
        RECEIVING p_flddescr = ls_df
        EXCEPTIONS OTHERS = 1 ).
      IF sy-subrc = 0.
        ev_label = COND #( WHEN ls_df-scrtext_m IS NOT INITIAL THEN condense( val = CONV string( ls_df-scrtext_m ) )
                           ELSE condense( val = CONV string( ls_df-fieldtext ) ) ).
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD build_bindings.

    CLEAR: et_ptab, et_etab, ev_error.

    SELECT SINGLE report_id, config_version FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO ( @DATA(lv_rid), @DATA(lv_ver) ).
    IF sy-subrc <> 0.
      ev_error = '运行记录不存在, 无法定位函数参数登记'.
      RETURN.
    ENDIF.
    bind_core( EXPORTING it_reg         = reg_rows( iv_report_id = lv_rid iv_version = lv_ver )
                         iv_params_json = iv_params_json
                         it_params      = it_params
               IMPORTING et_ptab        = et_ptab
                         et_etab        = et_etab
                         ev_error       = ev_error ).

  ENDMETHOD.


  METHOD reg_rows.

    CLEAR rt.
    SELECT param_id, abap_name, sel_kind, multi_value, range_allowed, allowed_ops
      FROM zai_rpt_param
      WHERE report_id      = @iv_report_id
        AND config_version = @iv_version
        AND active = 'X'
        AND abap_name <> ''
      INTO TABLE @rt.
    LOOP AT rt ASSIGNING FIELD-SYMBOL(<ls_reg>).
      <ls_reg>-abap_name = to_upper( condense( val = <ls_reg>-abap_name ) ).
      <ls_reg>-sel_kind  = to_upper( condense( val = <ls_reg>-sel_kind ) ).
    ENDLOOP.

  ENDMETHOD.


  METHOD bind_core.

    DATA: lt_reg  TYPE tt_reg,
          ls_reg  TYPE ty_reg,
          lt_kv   TYPE zcl_ai_report_service=>tt_kv,
          ls_kv   TYPE zcl_ai_report_service=>ty_kv,
          ls_pb   TYPE abap_func_parmbind,
          ls_eb   TYPE abap_func_excpbind,
          lr_data TYPE REF TO data,
          lv_val  TYPE string,
          lv_has  TYPE abap_bool,
          lv_kind TYPE string,
          lv_err  TYPE string,
          lv_idx  TYPE i.
    FIELD-SYMBOLS: <lv_any> TYPE any,
                   <lt_any> TYPE STANDARD TABLE.

    CLEAR: et_ptab, et_etab, ev_error.
    lt_reg = it_reg.

    " 参数快照 = validate_params 的规范化扁平对象(键 = to_lower(param_id))
    lt_kv = zcl_ai_report_service=>parse_flat_kv( iv_params_json ).

    LOOP AT it_params INTO DATA(ls_p).
      IF ls_p-kind = 'X'.
        lv_idx = lv_idx + 1.
        CLEAR ls_eb.
        ls_eb-name  = ls_p-name.
        ls_eb-value = lv_idx.
        INSERT ls_eb INTO TABLE et_etab.
        CONTINUE.
      ENDIF.

      " 登记值: 固定值(F)用登记值; 其余按 param_id / abap_name 从快照取
      CLEAR: lv_val, lv_has, lv_kind, ls_reg.
      READ TABLE lt_reg INTO ls_reg WITH KEY abap_name = ls_p-name.
      IF sy-subrc = 0.
        lv_kind = ls_reg-sel_kind.
        IF lv_kind = 'F'.
          lv_val = condense( val = ls_reg-allowed_ops ).
          lv_has = abap_true.
        ELSE.
          CLEAR ls_kv.
          READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_reg-param_id ).
          IF sy-subrc <> 0.
            READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_reg-abap_name ).
          ENDIF.
          IF sy-subrc = 0.
            lv_val = ls_kv-value.
            lv_has = xsdbool( lv_val IS NOT INITIAL OR lv_kind = 'C' ).
          ENDIF.
        ENDIF.
      ENDIF.

      IF ls_p-shape = 'GENERIC'.
        IF ls_p-optional = abap_false AND ( ls_p-kind = 'I' OR ls_p-kind = 'T' OR ls_p-kind = 'C' ).
          ev_error = |函数必填参数 { ls_p-name } 是通用类型, 不支持调用|.
          RETURN.
        ENDIF.
        CONTINUE.
      ENDIF.

      lr_data = make_data( iv_type_name = ls_p-type_name iv_kind = ls_p-kind ).
      IF lr_data IS NOT BOUND.
        CONTINUE.
      ENDIF.

      CASE ls_p-kind.
        WHEN 'I' OR 'C'.
          IF lv_has = abap_false.
            IF ls_p-kind = 'I' AND ls_p-optional = abap_false.
              ev_error = |函数必填参数 { ls_p-name } 没有值(没登记或没填), 请重新登记或补填|.
              RETURN.
            ENDIF.
            IF ls_p-kind = 'I'.
              CONTINUE.
            ENDIF.
          ELSE.
            ASSIGN lr_data->* TO <lv_any>.
            CASE ls_p-shape.
              WHEN 'FLAG'.
                IF to_upper( lv_val ) = 'X'.
                  <lv_any> = 'X'.
                ELSE.
                  CLEAR <lv_any>.
                ENDIF.
              WHEN 'SCALAR'.
                set_value( EXPORTING iv_val = lv_val IMPORTING ev_err = lv_err CHANGING cv = <lv_any> ).
              WHEN 'RANGE'.
                ASSIGN lr_data->* TO <lt_any>.
                IF sy-subrc <> 0.
                  lv_err = |参数 { ls_p-name } 的范围表不是标准表, 不支持|.
                ELSE.
                  fill_range( EXPORTING iv_val = lv_val iv_multi = ls_reg-multi_value
                                        iv_range = ls_reg-range_allowed
                              IMPORTING ev_err = lv_err
                              CHANGING ct_tab = <lt_any> ).
                ENDIF.
              WHEN 'STRUCT' OR 'TABLE'.
                " V1.2: 粘贴的表 / 一行结构
                fill_table( EXPORTING ir_data = lr_data iv_val = lv_val IMPORTING ev_err = lv_err ).
              WHEN OTHERS.
                lv_err = |参数 { ls_p-name } 的类型不支持传值|.
            ENDCASE.
            IF lv_err IS NOT INITIAL.
              ev_error = |参数 { ls_p-label }: { lv_err }|.
              RETURN.
            ENDIF.
          ENDIF.
          CLEAR ls_pb.
          ls_pb-name  = ls_p-name.
          ls_pb-kind  = COND #( WHEN ls_p-kind = 'I' THEN abap_func_exporting ELSE abap_func_changing ).
          ls_pb-value = lr_data.
          INSERT ls_pb INTO TABLE et_ptab.
        WHEN 'T'.
          IF lv_has = abap_true AND ls_p-shape = 'TABLE' AND lv_kind = 'T'.
            fill_table( EXPORTING ir_data = lr_data iv_val = lv_val IMPORTING ev_err = lv_err ).
            IF lv_err IS NOT INITIAL.
              ev_error = |参数 { ls_p-label }: { lv_err }|.
              RETURN.
            ENDIF.
          ENDIF.
          IF lv_has = abap_true AND ls_p-shape = 'RANGE'.
            ASSIGN lr_data->* TO <lt_any>.
            IF sy-subrc = 0.
              fill_range( EXPORTING iv_val = lv_val iv_multi = ls_reg-multi_value
                                    iv_range = ls_reg-range_allowed
                          IMPORTING ev_err = lv_err
                          CHANGING ct_tab = <lt_any> ).
              IF lv_err IS NOT INITIAL.
                ev_error = |参数 { ls_p-label }: { lv_err }|.
                RETURN.
              ENDIF.
            ENDIF.
          ENDIF.
          CLEAR ls_pb.
          ls_pb-name  = ls_p-name.
          ls_pb-kind  = abap_func_tables.
          ls_pb-value = lr_data.
          INSERT ls_pb INTO TABLE et_ptab.
        WHEN 'E'.
          CLEAR ls_pb.
          ls_pb-name  = ls_p-name.
          ls_pb-kind  = abap_func_importing.
          ls_pb-value = lr_data.
          INSERT ls_pb INTO TABLE et_ptab.
      ENDCASE.
    ENDLOOP.

    " 函数里 MESSAGE TYPE 'E' / 'A' 由 ERROR_MESSAGE 接住, 其余未声明的例外由 OTHERS 接住
    lv_idx = lv_idx + 1.
    CLEAR ls_eb.
    ls_eb-name  = 'ERROR_MESSAGE'.
    ls_eb-value = lv_idx.
    INSERT ls_eb INTO TABLE et_etab.
    lv_idx = lv_idx + 1.
    CLEAR ls_eb.
    ls_eb-name  = 'OTHERS'.
    ls_eb-value = lv_idx.
    INSERT ls_eb INTO TABLE et_etab.

  ENDMETHOD.


  METHOD set_value.

    DATA: lo_td   TYPE REF TO cl_abap_typedescr,
          lo_el   TYPE REF TO cl_abap_elemdescr,
          ls_df   TYPE dfies,
          lv_in   TYPE string,
          lv_conv TYPE string,
          lv_cfm  TYPE string,
          lv_rc   TYPE i,
          lv_ddic TYPE abap_bool.

    CLEAR ev_err.
    lo_td = cl_abap_typedescr=>describe_by_data( cv ).
    IF lo_td->kind <> cl_abap_typedescr=>kind_elem.
      ev_err = '不是单值字段'.
      RETURN.
    ENDIF.
    lo_el ?= lo_td.
    lv_in = condense( val = iv_val ).

    " 字典字段: 没勾小写的转大写; 有转换例程(ALPHA 补前导零等)的走转换例程
    IF lo_el->is_ddic_type( ) = abap_true.
      lo_el->get_ddic_field(
        EXPORTING p_langu = sy-langu
        RECEIVING p_flddescr = ls_df
        EXCEPTIONS OTHERS = 1 ).
      IF sy-subrc = 0.
        lv_ddic = abap_true.
        lv_conv = condense( val = CONV string( ls_df-convexit ) ).
        IF ls_df-lowercase IS INITIAL.
          lv_in = to_upper( lv_in ).
        ENDIF.
      ENDIF.
    ENDIF.

    IF lv_conv IS NOT INITIAL.
      lv_cfm = |CONVERSION_EXIT_{ lv_conv }_INPUT|.
      TRY.
          CALL FUNCTION lv_cfm
            EXPORTING
              input  = lv_in
            IMPORTING
              output = cv
            EXCEPTIONS
              OTHERS = 1.
          lv_rc = sy-subrc.
        CATCH cx_root.
          lv_rc = 9.
      ENDTRY.
      IF lv_rc <> 0.
        ev_err = |值 { lv_in } 转换失败(转换例程 { lv_conv })|.
      ENDIF.
      RETURN.
    ENDIF.

    CASE lo_el->type_kind.
      WHEN cl_abap_typedescr=>typekind_date.
        REPLACE ALL OCCURRENCES OF '-' IN lv_in WITH ``.
        REPLACE ALL OCCURRENCES OF '.' IN lv_in WITH ``.
        REPLACE ALL OCCURRENCES OF '/' IN lv_in WITH ``.
        IF strlen( lv_in ) <> 8 OR lv_in CN '0123456789'.
          ev_err = |日期 { iv_val } 格式不对(要 YYYYMMDD)|.
          RETURN.
        ENDIF.
        cv = lv_in.
      WHEN cl_abap_typedescr=>typekind_time.
        REPLACE ALL OCCURRENCES OF ':' IN lv_in WITH ``.
        cv = lv_in.
      WHEN OTHERS.
        TRY.
            cv = lv_in.
          CATCH cx_sy_conversion_error cx_sy_arithmetic_error.
            ev_err = |值 { iv_val } 和参数类型不符|.
        ENDTRY.
    ENDCASE.

  ENDMETHOD.


  METHOD fill_range.

    DATA: lv_val  TYPE string,
          lt_vals TYPE string_table,
          lv_lo   TYPE string,
          lv_hi   TYPE string,
          lr_line TYPE REF TO data,
          lv_err  TYPE string.
    FIELD-SYMBOLS: <ls_ln> TYPE any,
                   <lv_s>  TYPE any,
                   <lv_o>  TYPE any,
                   <lv_l>  TYPE any,
                   <lv_h>  TYPE any.

    CLEAR ev_err.
    lv_val = iv_val.
    REPLACE ALL OCCURRENCES OF '|' IN lv_val WITH ','.
    SPLIT lv_val AT ',' INTO TABLE lt_vals.

    CREATE DATA lr_line LIKE LINE OF ct_tab.
    ASSIGN lr_line->* TO <ls_ln>.
    ASSIGN COMPONENT 'SIGN'   OF STRUCTURE <ls_ln> TO <lv_s>.
    ASSIGN COMPONENT 'OPTION' OF STRUCTURE <ls_ln> TO <lv_o>.
    ASSIGN COMPONENT 'LOW'    OF STRUCTURE <ls_ln> TO <lv_l>.
    ASSIGN COMPONENT 'HIGH'   OF STRUCTURE <ls_ln> TO <lv_h>.
    IF <lv_s> IS NOT ASSIGNED OR <lv_o> IS NOT ASSIGNED OR <lv_l> IS NOT ASSIGNED OR <lv_h> IS NOT ASSIGNED.
      ev_err = '范围表结构不是 SIGN / OPTION / LOW / HIGH'.
      RETURN.
    ENDIF.

    " 范围 low,high → BT(只给一端退化为 GE / LE); 与 EXEC_SAP.build_seltab 同口径
    IF iv_range = abap_true AND iv_multi = abap_false AND lines( lt_vals ) = 2.
      READ TABLE lt_vals INTO lv_lo INDEX 1.
      READ TABLE lt_vals INTO lv_hi INDEX 2.
      CONDENSE: lv_lo NO-GAPS, lv_hi NO-GAPS.
      CLEAR <ls_ln>.
      <lv_s> = 'I'.
      IF lv_lo IS NOT INITIAL AND lv_hi IS NOT INITIAL.
        <lv_o> = 'BT'.
        set_value( EXPORTING iv_val = lv_lo IMPORTING ev_err = lv_err CHANGING cv = <lv_l> ).
        IF lv_err IS INITIAL.
          set_value( EXPORTING iv_val = lv_hi IMPORTING ev_err = lv_err CHANGING cv = <lv_h> ).
        ENDIF.
      ELSEIF lv_lo IS NOT INITIAL.
        <lv_o> = 'GE'.
        set_value( EXPORTING iv_val = lv_lo IMPORTING ev_err = lv_err CHANGING cv = <lv_l> ).
      ELSE.
        <lv_o> = 'LE'.
        set_value( EXPORTING iv_val = lv_hi IMPORTING ev_err = lv_err CHANGING cv = <lv_l> ).
      ENDIF.
      IF lv_err IS NOT INITIAL.
        ev_err = lv_err.
        RETURN.
      ENDIF.
      APPEND <ls_ln> TO ct_tab.
      RETURN.
    ENDIF.

    " 多值 / 单值 → 每项一行 EQ(含 * 或 + 通配 → CP, 通配值不过转换例程)
    LOOP AT lt_vals INTO DATA(lv_item).
      CONDENSE lv_item NO-GAPS.
      IF lv_item IS INITIAL.
        CONTINUE.
      ENDIF.
      CLEAR <ls_ln>.
      <lv_s> = 'I'.
      IF lv_item CA '*+'.
        <lv_o> = 'CP'.
        <lv_l> = to_upper( lv_item ).
      ELSE.
        <lv_o> = 'EQ'.
        set_value( EXPORTING iv_val = lv_item IMPORTING ev_err = lv_err CHANGING cv = <lv_l> ).
        IF lv_err IS NOT INITIAL.
          ev_err = lv_err.
          RETURN.
        ENDIF.
      ENDIF.
      APPEND <ls_ln> TO ct_tab.
    ENDLOOP.

  ENDMETHOD.


  METHOD table_to_rows.

    DATA: lo_td   TYPE REF TO cl_abap_typedescr,
          lo_tab  TYPE REF TO cl_abap_tabledescr,
          lo_line TYPE REF TO cl_abap_datadescr,
          lo_sd   TYPE REF TO cl_abap_structdescr,
          lt_dd   TYPE ddfields,
          ls_col  TYPE zcl_ai_alv_capture=>ty_col,
          lv_n    TYPE i,
          lv_json TYPE string,
          lv_flat TYPE abap_bool.
    FIELD-SYMBOLS: <lt_tab> TYPE ANY TABLE,
                   <ls_row> TYPE any.

    CLEAR: ev_total, et_cols, et_rows, ev_error.
    ASSIGN ir_tab->* TO <lt_tab>.
    IF sy-subrc <> 0.
      ev_error = '主结果参数不是内表, 请在登记里改选主结果(RESULT_REF)'.
      RETURN.
    ENDIF.
    ev_total = lines( <lt_tab> ).

    lo_td  = cl_abap_typedescr=>describe_by_data( <lt_tab> ).
    lo_tab ?= lo_td.
    lo_line = lo_tab->get_table_line_type( ).

    IF lo_line->kind <> cl_abap_typedescr=>kind_struct.
      " 行不是结构: 单列 VALUE
      lv_flat = abap_true.
      ls_col-name  = 'VALUE'.
      ls_col-label = 'VALUE'.
      APPEND ls_col TO et_cols.
    ELSE.
      lo_sd ?= lo_line.
      lo_sd->get_ddic_field_list(
        EXPORTING p_langu = sy-langu
        RECEIVING p_field_list = lt_dd
        EXCEPTIONS OTHERS = 1 ).
      IF sy-subrc <> 0.
        CLEAR lt_dd.
      ENDIF.
      " 列 = 平层标量字段(跳过嵌套结构 / 内表 / 引用), 标题取字典字段文本
      LOOP AT lo_sd->components INTO DATA(ls_comp).
        CASE ls_comp-type_kind.
          WHEN 'h' OR 'l' OR 'r' OR 'm' OR 'u' OR 'v'.
            CONTINUE.
        ENDCASE.
        CLEAR ls_col.
        ls_col-name = ls_comp-name.
        READ TABLE lt_dd INTO DATA(ls_dd) WITH KEY fieldname = ls_comp-name.
        IF sy-subrc = 0.
          ls_col-label = COND #( WHEN ls_dd-scrtext_m IS NOT INITIAL THEN condense( val = CONV string( ls_dd-scrtext_m ) )
                                 ELSE condense( val = CONV string( ls_dd-fieldtext ) ) ).
        ENDIF.
        IF ls_col-label IS INITIAL.
          ls_col-label = ls_comp-name.
        ENDIF.
        APPEND ls_col TO et_cols.
      ENDLOOP.
    ENDIF.

    LOOP AT <lt_tab> ASSIGNING <ls_row>.
      lv_n = lv_n + 1.
      IF lv_n > iv_max.
        EXIT.
      ENDIF.
      IF lv_flat = abap_true.
        lv_json = `{"VALUE":` && /ui2/cl_json=>serialize( data = <ls_row> compress = abap_false ) && `}`.
      ELSE.
        lv_json = /ui2/cl_json=>serialize( data = <ls_row> compress = abap_false ).
      ENDIF.
      APPEND lv_json TO et_rows.
    ENDLOOP.

  ENDMETHOD.


  METHOD single_row.

    DATA: lo_td  TYPE REF TO cl_abap_typedescr,
          lo_sd  TYPE REF TO cl_abap_structdescr,
          lt_dd  TYPE ddfields,
          ls_col TYPE zcl_ai_alv_capture=>ty_col,
          lv_row TYPE string,
          lv_seg TYPE string,
          lv_key TYPE string.
    FIELD-SYMBOLS: <lv_v> TYPE any,
                   <lv_c> TYPE any.

    CLEAR: et_cols, et_rows.
    " 没有表输出: EXPORTING / CHANGING 的单值 + 扁平结构字段合成一行(结构字段列名 = 参数-字段)
    LOOP AT it_params INTO DATA(ls_p) WHERE ( kind = 'E' OR kind = 'C' )
                                       AND ( shape = 'SCALAR' OR shape = 'FLAG' OR shape = 'STRUCT' ).
      READ TABLE it_ptab INTO DATA(ls_b) WITH TABLE KEY name = CONV abap_parmname( ls_p-name ).
      IF sy-subrc <> 0 OR ls_b-value IS NOT BOUND.
        CONTINUE.
      ENDIF.
      ASSIGN ls_b-value->* TO <lv_v>.
      IF ls_p-shape <> 'STRUCT'.
        lv_seg = |"{ ls_p-name }":| && /ui2/cl_json=>serialize( data = <lv_v> compress = abap_false ).
        lv_row = COND #( WHEN lv_row IS INITIAL THEN lv_seg ELSE lv_row && ',' && lv_seg ).
        CLEAR ls_col.
        ls_col-name  = ls_p-name.
        ls_col-label = ls_p-label.
        APPEND ls_col TO et_cols.
        CONTINUE.
      ENDIF.
      lo_td = cl_abap_typedescr=>describe_by_data( <lv_v> ).
      lo_sd ?= lo_td.
      CLEAR lt_dd.
      lo_sd->get_ddic_field_list(
        EXPORTING p_langu = sy-langu
        RECEIVING p_field_list = lt_dd
        EXCEPTIONS OTHERS = 1 ).
      LOOP AT lo_sd->components INTO DATA(ls_comp).
        CASE ls_comp-type_kind.
          WHEN 'h' OR 'l' OR 'r' OR 'm' OR 'u' OR 'v'.
            CONTINUE.
        ENDCASE.
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE <lv_v> TO <lv_c>.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        lv_key = |{ ls_p-name }-{ ls_comp-name }|.
        lv_seg = |"{ lv_key }":| && /ui2/cl_json=>serialize( data = <lv_c> compress = abap_false ).
        lv_row = COND #( WHEN lv_row IS INITIAL THEN lv_seg ELSE lv_row && ',' && lv_seg ).
        CLEAR ls_col.
        ls_col-name = lv_key.
        READ TABLE lt_dd INTO DATA(ls_dd) WITH KEY fieldname = ls_comp-name.
        IF sy-subrc = 0.
          ls_col-label = condense( val = CONV string( ls_dd-scrtext_m ) ).
        ENDIF.
        IF ls_col-label IS INITIAL.
          ls_col-label = lv_key.
        ENDIF.
        APPEND ls_col TO et_cols.
      ENDLOOP.
    ENDLOOP.

    IF lv_row IS NOT INITIAL.
      APPEND |\{{ lv_row }\}| TO et_rows.
    ENDIF.

  ENDMETHOD.


  METHOD return_messages.

    DATA: lv_ty  TYPE string,
          lv_tx  TYPE string,
          lv_seg TYPE string,
          lv_n   TYPE i.
    FIELD-SYMBOLS: <lv_d>  TYPE any,
                   <lt_t>  TYPE ANY TABLE,
                   <ls_r>  TYPE any,
                   <lv_ty> TYPE any,
                   <lv_tx> TYPE any.

    CLEAR: ev_first, ev_errors, ev_json.
    ASSIGN ir_data->* TO <lv_d>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    DATA(lo_td) = cl_abap_typedescr=>describe_by_data( <lv_d> ).
    IF lo_td->kind = cl_abap_typedescr=>kind_table.
      ASSIGN <lv_d> TO <lt_t>.
    ELSEIF lo_td->kind <> cl_abap_typedescr=>kind_struct.
      RETURN.
    ENDIF.

    " 结构 = 一条消息; 内表 = 逐行; 只认 TYPE / MESSAGE 两个字段(最多记 20 条)
    IF <lt_t> IS NOT ASSIGNED.
      ASSIGN <lv_d> TO <ls_r>.
      ASSIGN COMPONENT 'TYPE'    OF STRUCTURE <ls_r> TO <lv_ty>.
      ASSIGN COMPONENT 'MESSAGE' OF STRUCTURE <ls_r> TO <lv_tx>.
      IF <lv_ty> IS ASSIGNED AND <lv_tx> IS ASSIGNED.
        lv_ty = <lv_ty>.
        lv_tx = <lv_tx>.
        IF lv_ty IS NOT INITIAL.
          IF lv_ty = 'E' OR lv_ty = 'A'.
            ev_errors = 1.
            ev_first  = lv_tx.
          ENDIF.
          ev_json = |[\{"type":"{ lv_ty }","message":"{ zcl_ai_report_service=>json_escape( lv_tx ) }"\}]|.
        ENDIF.
      ENDIF.
      RETURN.
    ENDIF.

    LOOP AT <lt_t> ASSIGNING <ls_r>.
      UNASSIGN: <lv_ty>, <lv_tx>.
      ASSIGN COMPONENT 'TYPE'    OF STRUCTURE <ls_r> TO <lv_ty>.
      ASSIGN COMPONENT 'MESSAGE' OF STRUCTURE <ls_r> TO <lv_tx>.
      IF <lv_ty> IS NOT ASSIGNED OR <lv_tx> IS NOT ASSIGNED.
        RETURN.
      ENDIF.
      lv_ty = <lv_ty>.
      lv_tx = <lv_tx>.
      IF lv_ty = 'E' OR lv_ty = 'A'.
        ev_errors = ev_errors + 1.
        IF ev_first IS INITIAL.
          ev_first = lv_tx.
        ENDIF.
      ENDIF.
      lv_n = lv_n + 1.
      IF lv_n <= 20.
        lv_seg = |\{"type":"{ lv_ty }","message":"{ zcl_ai_report_service=>json_escape( lv_tx ) }"\}|.
        ev_json = COND #( WHEN ev_json IS INITIAL THEN lv_seg ELSE ev_json && ',' && lv_seg ).
      ENDIF.
    ENDLOOP.
    IF ev_json IS NOT INITIAL.
      ev_json = |[{ ev_json }]|.
    ENDIF.

  ENDMETHOD.


  METHOD fm_group.

    rv = to_upper( condense( val = CONV string( iv_pname ) ) ).
    REPLACE FIRST OCCURRENCE OF 'SAPL' IN rv WITH ``.

  ENDMETHOD.


  METHOD strip_comment.

    " 单字符用 string: c 类型做 && 拼接会丢掉空格(COMMIT WORK 会粘成一个词)
    DATA: lv_len TYPE i,
          lv_i   TYPE i,
          lv_c   TYPE string,
          lv_q   TYPE string.

    CLEAR: ev_code, ev_nolit.
    lv_len = strlen( iv_line ).
    WHILE lv_i < lv_len.
      lv_c = substring( val = iv_line off = lv_i len = 1 ).
      IF lv_q IS INITIAL.
        IF lv_c = '"'.
          EXIT.
        ENDIF.
        IF lv_c = `'` OR lv_c = '`'.
          lv_q = lv_c.
          ev_nolit = ev_nolit && lv_c.
        ELSE.
          ev_nolit = ev_nolit && lv_c.
        ENDIF.
      ELSE.
        IF lv_c = lv_q.
          CLEAR lv_q.
          ev_nolit = ev_nolit && lv_c.
        ENDIF.
      ENDIF.
      ev_code = ev_code && lv_c.
      lv_i = lv_i + 1.
    ENDWHILE.

  ENDMETHOD.


  METHOD add_hit.

    IF line_exists( ct_hits[ code = iv_code line = iv_line ] ).
      RETURN.
    ENDIF.
    APPEND VALUE #( level = iv_level code = iv_code text = iv_text line = iv_line ) TO ct_hits.

  ENDMETHOD.


  METHOD add_target.

    DATA: lv_t   TYPE string,
          lv_len TYPE i,
          lv_i   TYPE i,
          lv_c   TYPE string.

    lv_t = iv_tok.
    IF strlen( lv_t ) > 0 AND lv_t(1) = '('.
      add_hit( EXPORTING iv_level = `BLOCK` iv_code = `DYNWRITE`
                         iv_text = `用动态表名写数据库` iv_line = iv_line
               CHANGING ct_hits = ct_hits ).
      RETURN.
    ENDIF.
    " 字段访问 / 表达式(LS-X / LT[ ] / LO->X)不是表名
    IF lv_t CA '-[>'.
      RETURN.
    ENDIF.
    " 只保留开头的表名字符(A-Z 0-9 _ /)
    lv_len = strlen( lv_t ).
    WHILE lv_i < lv_len.
      lv_c = substring( val = lv_t off = lv_i len = 1 ).
      IF lv_c CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/'.
        EXIT.
      ENDIF.
      lv_i = lv_i + 1.
    ENDWHILE.
    IF lv_i = 0.
      RETURN.
    ENDIF.
    lv_t = substring( val = lv_t len = lv_i ).
    IF line_exists( ct_targets[ table = lv_t line = iv_line ] ).
      RETURN.
    ENDIF.
    APPEND VALUE #( table = lv_t line = iv_line ) TO ct_targets.

  ENDMETHOD.

ENDCLASS.
