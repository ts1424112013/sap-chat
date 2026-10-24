*=======================================================================
* 对象:   ZCL_AI_RPT_SCANNER
* 用途:   报表自动登记(10.24 记录 #03b) —— 读报表源码(含 Z/Y 开头的 include)解析
*         选择屏, 生成 ZAI_RPT_DEF / ZAI_RPT_PARAM 登记草稿; 人工确认后写入(新配置版本)
*         · 标签: 选择文本(TEXTPOOL) → 源码里的说明(COMMENT … FOR FIELD / 同一行 /
*           INITIALIZATION 里的字面量赋值, 优先中文) → 字典字段名 → 参数名
*         · 单选组 → R(默认项照 DEFAULT, 没写默认第一个); 复选框 → C; 输出方式组 → F
*           (ALV / 查询那一项固定 X, 其余固定空格); 危险项(输出 / FTP / 邮件 / 删除 /
*           布局变式)默认不登记, 写明原因
*         · 默认值: DEFAULT 字面量 / 数字 → STATIC; DEFAULT sy-datum → TODAY 0;
*           INITIALIZATION 里 p = sy-datum ± n → TODAY ±n; 程序必填但有默认 → 登记为选填
*         规则与本地参考实现 test-server/rpt-scan-ref.js 一致(npm run test:rptscan 用 9 份
*         真实报表源码锁住), 改规则两边同步
* 依赖:   ZAI_RPT_DEF / ZAI_RPT_PARAM(SEL_KIND R / C / F 见 ZCL_AI_REPORT_SERVICE V1.0.13,
*         DEFAULT_TYPE TODAY 见 V1.0.14); ZCL_AI_CHAT_SERVICE=>v8_get_role(写入只允许 ADMIN);
*         TSTC / TSTCT / TRDIR / TRDIRT(只读)
* 安装:   SE24 -> 新建类 ZCL_AI_RPT_SCANNER -> 源代码视图整类粘贴 (ABAP 7.50)
* V1.0    20261024: 首版
* ★ 核对标记: 有 METHOD scan / METHOD save; INSERT zai_rpt_param 与 zai_rpt_def 只在
*   METHOD save; 全文没有 SCAN ABAP-SOURCE / FIND PCRE; 方法之间没有注释
*=======================================================================
CLASS zcl_ai_rpt_scanner DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " 登记草稿的一行(对应 ZAI_RPT_PARAM; include = 是否写入, note = 给人看的说明)
    TYPES: BEGIN OF ty_param,
             param_id      TYPE string,
             abap_name     TYPE string,
             sel_kind      TYPE string,
             display_label TYPE string,
             label_src     TYPE string,   " TEXTPOOL / COMMENT / DDIC / NAME / SRC_COMMENT / BLOCK
             data_type     TYPE string,
             type_length   TYPE i,
             required      TYPE abap_bool,
             multi_value   TYPE abap_bool,
             range_allowed TYPE abap_bool,
             default_type  TYPE string,
             default_value TYPE string,
             allowed_ops   TYPE string,
             include       TYPE abap_bool,
             note          TYPE string,
             sort_no       TYPE i,
           END OF ty_param.
    TYPES tt_param TYPE STANDARD TABLE OF ty_param WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_draft,
             report_id   TYPE string,
             tcode       TYPE string,
             progname    TYPE string,
             report_name TYPE string,
             description TYPE string,
             module      TYPE string,     " 头注释 SAP Module(只显示, 登记表没有这列)
             hdr_tcode   TYPE string,     " 头注释 T-CODE(和事务码表不一致时提示)
             exists      TYPE abap_bool,  " 已登记过(写入 = 换新配置版本)
             cur_version TYPE string,
             params      TYPE tt_param,
             notes       TYPE string_table,
             error       TYPE string,     " 非空 = 不能写入(预览照样显示)
           END OF ty_draft.

    TYPES: BEGIN OF ty_save,
             ok          TYPE abap_bool,
             message     TYPE string,
             version     TYPE string,
             old_version TYPE string,
           END OF ty_save.

    " 扫描: 事务码或程序名二选一(都给以事务码为准); iv_alias = 程序没有事务码时用的别名;
    " it_force = 判为危险但确认要登记的参数名; it_skip = 不登记的参数名(都是大写参数名)
    CLASS-METHODS scan
      IMPORTING iv_tcode  TYPE string OPTIONAL
                iv_prog   TYPE string OPTIONAL
                iv_alias  TYPE string OPTIONAL
                iv_lang   TYPE sy-langu DEFAULT sy-langu
                it_force  TYPE string_table OPTIONAL
                it_skip   TYPE string_table OPTIONAL
      RETURNING VALUE(rs) TYPE ty_draft.

    " 写入: 只写 include = X 的行, 配置版本 = R + 日期时间; 已登记的报表只换版本号
    " (旧版本参数行保留, 改回旧版本号即可回滚), 新报表 EXEC_ENABLED 按 iv_exec_enabled
    CLASS-METHODS save
      IMPORTING is_draft        TYPE ty_draft
                iv_exec_enabled TYPE abap_bool DEFAULT abap_false
                iv_max_rows     TYPE i DEFAULT 200
      RETURNING VALUE(rs)       TYPE ty_save.

    CLASS-METHODS parse_default
      IMPORTING iv_text  TYPE string
      EXPORTING ev_type  TYPE string
                ev_value TYPE string.

    CLASS-METHODS is_danger
      IMPORTING iv_name   TYPE string
                iv_label  TYPE string
                iv_ref    TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_stmt,
             text TYPE string,
             line TYPE i,
           END OF ty_stmt.
    TYPES tt_stmt TYPE STANDARD TABLE OF ty_stmt WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_tok,
             raw TYPE string,
             up  TYPE string,
           END OF ty_tok.
    TYPES tt_tok TYPE STANDARD TABLE OF ty_tok WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_ord,
             kind TYPE c LENGTH 1,   " C = 说明变量 / P = 参数
             name TYPE string,
           END OF ty_ord.
    TYPES tt_ord TYPE STANDARD TABLE OF ty_ord WITH DEFAULT KEY.

    " SELECTION-SCREEN BEGIN OF LINE … END OF LINE
    TYPES: BEGIN OF ty_lgrp,
             id    TYPE i,
             line  TYPE i,
             ncomm TYPE i,
             nparm TYPE i,
             ord   TYPE tt_ord,
           END OF ty_lgrp.
    TYPES tt_lgrp TYPE STANDARD TABLE OF ty_lgrp WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_decl,
             kind       TYPE c LENGTH 1,   " P / S
             name       TYPE string,
             len        TYPE i,
             ref        TYPE string,       " TYPE / LIKE / FOR 引用(字典字段等)
             builtin    TYPE string,       " TYPE c / n / d / i / p / f …
             obligatory TYPE abap_bool,
             def        TYPE string,       " DEFAULT 后面的原文
             checkbox   TYPE abap_bool,
             grp        TYPE string,       " RADIOBUTTON GROUP
             nodisp     TYPE abap_bool,
             nointv     TYPE abap_bool,
             noext      TYPE abap_bool,
             line       TYPE i,
             block      TYPE string,       " 所在块的 TITLE
             lgid       TYPE i,            " 所在 BEGIN OF LINE(0 = 不在)
           END OF ty_decl.
    TYPES tt_decl TYPE STANDARD TABLE OF ty_decl WITH DEFAULT KEY.

    " 键值(组件不叫 key: 表达式 x[ key = … ] 会被当成二级键语法)
    TYPES: BEGIN OF ty_kv,
             k TYPE string,
             v TYPE string,
           END OF ty_kv.
    TYPES tt_kv TYPE STANDARD TABLE OF ty_kv WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_opt,
             name TYPE string,
             text TYPE string,
             src  TYPE string,
             dflt TYPE abap_bool,
           END OF ty_opt.
    TYPES tt_opt TYPE STANDARD TABLE OF ty_opt WITH DEFAULT KEY.

    " 识别规则(正则在 class_constructor 里分行拼: 源码一行不能超过 255 字符)
    CLASS-DATA: gc_name_danger  TYPE string,
                gc_label_danger TYPE string,
                gc_ref_danger   TYPE string,
                gc_safe_out     TYPE string.

    CLASS-DATA: gt_stmt  TYPE tt_stmt,
                gt_cmt   TYPE tt_stmt,
                gt_decl  TYPE tt_decl,
                gt_lgrp  TYPE tt_lgrp,
                gt_cfor  TYPE tt_kv,     " 参数名 → 说明变量(COMMENT … FOR FIELD)
                gt_asg   TYPE tt_kv,     " 变量 → 赋值原文(INITIALIZATION 段)
                gt_tps   TYPE tt_kv,     " 选择文本
                gt_tpd   TYPE tt_kv,     " 选择文本勾了「字典参考」的参数
                gt_tpi   TYPE tt_kv,     " 文本符号 TEXT-xxx
                gt_note  TYPE string_table,
                gv_title TYPE string,
                gv_incl  TYPE i,
                gv_lang  TYPE sy-langu.

    CLASS-METHODS class_constructor.
    CLASS-METHODS read_source
      IMPORTING iv_prog  TYPE string
                iv_depth TYPE i
      RETURNING VALUE(rt) TYPE string_table.
    CLASS-METHODS split_statements
      IMPORTING it_src TYPE string_table.
    CLASS-METHODS outer_index
      IMPORTING iv_text TYPE string
                iv_ch   TYPE string
      RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS tokens
      IMPORTING iv_text TYPE string
      RETURNING VALUE(rt) TYPE tt_tok.
    CLASS-METHODS parse_screen.
    CLASS-METHODS parse_decl
      IMPORTING it_tok  TYPE tt_tok
                iv_kind TYPE c
      RETURNING VALUE(rs) TYPE ty_decl.
    CLASS-METHODS read_texts
      IMPORTING iv_prog TYPE string.
    CLASS-METHODS text_of_var
      IMPORTING iv_var TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS label_of
      IMPORTING is_decl TYPE ty_decl
      EXPORTING ev_text TYPE string
                ev_src  TYPE string.
    CLASS-METHODS group_label
      IMPORTING iv_grp  TYPE string
      EXPORTING ev_text TYPE string
                ev_src  TYPE string.
    CLASS-METHODS type_of
      IMPORTING is_decl TYPE ty_decl
      EXPORTING ev_type TYPE string
                ev_len  TYPE i.
    CLASS-METHODS default_of
      IMPORTING is_decl  TYPE ty_decl
      EXPORTING ev_type  TYPE string
                ev_value TYPE string.
    CLASS-METHODS ddic_info
      IMPORTING iv_ref   TYPE string
      EXPORTING ev_kind  TYPE string
                ev_len   TYPE i
                ev_label TYPE string.
    CLASS-METHODS parse_header
      IMPORTING it_src     TYPE string_table
      EXPORTING ev_purpose TYPE string
                ev_module  TYPE string
                ev_tcode   TYPE string.
    CLASS-METHODS has_cjk
      IMPORTING iv TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS unquote
      IMPORTING iv TYPE string
      RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS is_literal
      IMPORTING iv TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.
    CLASS-METHODS build_rows
      IMPORTING it_force TYPE string_table
                it_skip  TYPE string_table
      RETURNING VALUE(rt) TYPE tt_param.

ENDCLASS.



CLASS zcl_ai_rpt_scanner IMPLEMENTATION.


  METHOD class_constructor.

    " 名字(去掉 P_ / S_ / L_ 前缀与结尾数字)命中 → 危险(输出 / 传输 / 写入 / 布局变式)
    gc_name_danger = `^(P_|S_|L_)?(FTP|PWD|PASS|PASSWD|PASSWORD|FILE|FILENA|FNAME|PATH|MAIL|EMAIL|`
                  && `SEND|SBT|BAKJOB|UPLOAD|UPLD|DOWNLOAD|DOWN|DNLD|FORMAT|CACHE|GLOBAL|BI|JOB|`
                  && `DEL|DELE|DELETE|SAVE|UPD|UPDATE|ALV_DEF|VARIANT|VARI|LAYOUT)[0-9]*$`.
    " 标签命中 → 危险(POSIX 没有 \b, 用 (^|[^A-Z]) … ([^A-Z]|$) 代替)
    gc_label_danger = `FTP|密碼|密码|PASSWORD|本地文件|文件路徑|文件路径|文件名|檔案|郵件|邮件|E-?MAIL|`
                   && `上傳|上传|下載|下载|發送|发送|緩存表|缓存表|寫入|写入|刪除|删除|DELETE|UPLOAD|`
                   && `DOWNLOAD|BACKGROUND JOB|JOB NAME|布局|變式|变式|LAYOUT|`
                   && `(^|[^A-Z])BI([^A-Z]|$)|(^|[^A-Z])SEND([^A-Z]|$)`.
    " 引用类型命中 → 布局变式
    gc_ref_danger = `^(DISVARIANT|SLIS_VARI|RSVAR)`.
    " 输出方式组里可以安全固定的那一项
    gc_safe_out = `ALV|顯示|显示|DISPLAY|查詢|查询|QUERY|(^|[^A-Z])LIST([^A-Z]|$)|屏幕|畫面|画面`.

  ENDMETHOD.


  METHOD scan.

    DATA: lv_tcode   TYPE string,
          lv_prog    TYPE string,
          lv_alias   TYPE string,
          lv_pgmna   TYPE tstc-pgmna,
          lv_tc20    TYPE tstc-tcode,
          lv_pg40    TYPE trdir-name,
          lv_subc    TYPE trdir-subc,
          lv_ttext   TYPE tstct-ttext,
          lv_ptext   TYPE trdirt-text,
          lv_rid_old TYPE zai_rpt_def-report_id,
          lv_ver_old TYPE zai_rpt_def-config_version,
          lt_tcodes  TYPE STANDARD TABLE OF tstc-tcode WITH DEFAULT KEY,
          lv_tc      TYPE tstc-tcode,
          lv_first   TYPE c LENGTH 1,
          lt_src     TYPE string_table,
          lv_purpose TYPE string,
          lv_module  TYPE string,
          lv_htcode  TYPE string.

    CLEAR: gt_note, gv_title, gv_incl.
    gv_lang  = iv_lang.
    lv_tcode = to_upper( condense( iv_tcode ) ).
    lv_prog  = to_upper( condense( iv_prog ) ).
    lv_alias = to_upper( condense( iv_alias ) ).

    " 1) 事务码 <-> 程序(事务码表为准)
    IF lv_tcode IS NOT INITIAL.
      lv_tc20 = lv_tcode.
      SELECT SINGLE pgmna FROM tstc WHERE tcode = @lv_tc20 INTO @lv_pgmna.
      IF sy-subrc <> 0.
        rs-error = |事务码 { lv_tcode } 不存在|.
        RETURN.
      ENDIF.
      IF lv_prog IS INITIAL.
        lv_prog = lv_pgmna.
      ENDIF.
    ELSEIF lv_prog IS NOT INITIAL.
      lv_pg40 = lv_prog.
      SELECT tcode FROM tstc WHERE pgmna = @lv_pg40 ORDER BY tcode INTO TABLE @lt_tcodes UP TO 20 ROWS.
      LOOP AT lt_tcodes INTO lv_tc.
        lv_first = lv_tc.
        IF lv_first = 'Z' OR lv_first = 'Y'.
          lv_tcode = lv_tc.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_tcode IS INITIAL AND lv_alias IS NOT INITIAL.
        lv_tcode = lv_alias.
        APPEND |程序没有 Z/Y 事务码, 按别名 { lv_alias } 登记(聊天里用「执行 { lv_alias }」)| TO gt_note.
      ENDIF.
    ELSE.
      rs-error = '请填事务码或程序名'.
      RETURN.
    ENDIF.

    lv_pg40 = lv_prog.
    SELECT SINGLE subc FROM trdir WHERE name = @lv_pg40 INTO @lv_subc.
    IF sy-subrc <> 0.
      rs-error = |程序 { lv_prog } 不存在|.
      RETURN.
    ENDIF.
    IF lv_subc <> '1'.
      rs-error = |{ lv_prog } 不是可执行程序(类型 { lv_subc }), 不能登记|.
      RETURN.
    ENDIF.

    rs-tcode    = lv_tcode.
    rs-progname = lv_prog.
    rs-report_id = COND #( WHEN lv_tcode IS NOT INITIAL THEN lv_tcode ELSE lv_prog ).
    IF lv_tcode IS INITIAL.
      rs-error = |程序 { lv_prog } 没有 Z/Y 事务码: 聊天里按事务码执行, 请先在 SE93 建事务码, 或填「事务码别名」|.
    ENDIF.

    " 报表名: 事务码文本 → 程序标题 → (后面)文本池标题 / 用途
    IF lv_tcode IS NOT INITIAL.
      lv_tc20 = lv_tcode.
      SELECT SINGLE ttext FROM tstct WHERE sprsl = @gv_lang AND tcode = @lv_tc20 INTO @lv_ttext.
      IF sy-subrc <> 0.
        SELECT SINGLE ttext FROM tstct WHERE tcode = @lv_tc20 INTO @lv_ttext.
      ENDIF.
      rs-report_name = condense( CONV string( lv_ttext ) ).
    ENDIF.
    IF rs-report_name IS INITIAL.
      SELECT SINGLE text FROM trdirt WHERE name = @lv_pg40 AND sprsl = @gv_lang INTO @lv_ptext.
      IF sy-subrc <> 0.
        SELECT SINGLE text FROM trdirt WHERE name = @lv_pg40 INTO @lv_ptext.
      ENDIF.
      rs-report_name = condense( CONV string( lv_ptext ) ).
    ENDIF.

    " 已登记过?(按事务码, 再按编号)
    IF lv_tcode IS NOT INITIAL.
      lv_tc20 = lv_tcode.
      SELECT SINGLE report_id, config_version FROM zai_rpt_def
        WHERE tcode = @lv_tc20
        INTO ( @lv_rid_old, @lv_ver_old ).
      IF sy-subrc = 0.
        rs-exists      = abap_true.
        rs-report_id   = lv_rid_old.
        rs-cur_version = lv_ver_old.
      ENDIF.
    ENDIF.
    IF rs-exists = abap_false.
      lv_rid_old = rs-report_id.
      SELECT SINGLE config_version FROM zai_rpt_def
        WHERE report_id = @lv_rid_old
        INTO @lv_ver_old.
      IF sy-subrc = 0.
        rs-exists      = abap_true.
        rs-cur_version = lv_ver_old.
      ENDIF.
    ENDIF.

    " 2) 源码 → 语句 → 选择屏
    lt_src = read_source( iv_prog = lv_prog iv_depth = 0 ).
    IF lt_src IS INITIAL.
      rs-error = |读不到程序 { lv_prog } 的源码|.
      RETURN.
    ENDIF.
    parse_header( EXPORTING it_src     = lt_src
                  IMPORTING ev_purpose = lv_purpose
                            ev_module  = lv_module
                            ev_tcode   = lv_htcode ).
    rs-description = lv_purpose.
    rs-module      = lv_module.
    rs-hdr_tcode   = lv_htcode.
    IF lv_htcode IS NOT INITIAL AND lv_tcode IS NOT INITIAL AND lv_htcode <> lv_tcode.
      APPEND |头注释写的事务码是 { lv_htcode }, 事务码表里是 { lv_tcode }(以事务码表为准)| TO gt_note.
    ENDIF.

    split_statements( lt_src ).
    parse_screen( ).
    read_texts( lv_prog ).
    IF rs-report_name IS INITIAL.
      rs-report_name = COND #( WHEN gv_title IS NOT INITIAL THEN gv_title
                               WHEN lv_purpose IS NOT INITIAL THEN lv_purpose
                               ELSE lv_prog ).
    ENDIF.

    " 3) 登记行
    rs-params = build_rows( it_force = it_force it_skip = it_skip ).
    IF rs-params IS INITIAL.
      APPEND '没有解析到选择屏参数(参数可能写在读不到的 include 里, 或这是没有选择屏的程序)' TO gt_note.
    ENDIF.
    rs-notes = gt_note.

  ENDMETHOD.


  METHOD build_rows.

    DATA: ls_d     TYPE ty_decl,
          ls_b     TYPE ty_decl,
          ls_r     TYPE ty_param,
          lt_grp   TYPE string_table,
          lv_grp   TYPE string,
          lv_lbl   TYPE string,
          lv_src   TYPE string,
          lv_dv    TYPE string,
          lv_up    TYPE string,
          lt_opt   TYPE tt_opt,
          ls_opt   TYPE ty_opt,
          lv_ops   TYPE string,
          lv_short TYPE string,
          lv_danger TYPE abap_bool,
          lv_safe  TYPE string,
          lv_idx   TYPE i,
          lv_pos   TYPE i,
          lt_new   TYPE tt_param,
          ls_new   TYPE ty_param,
          lv_name  TYPE string,
          lv_cnt   TYPE i,
          lv_hasd  TYPE abap_bool,
          lv_note  TYPE string,
          lv_glbl  TYPE string,
          lv_gsrc  TYPE string,
          lv_seq   TYPE i,
          lv_ok    TYPE abap_bool,
          lv_ph    TYPE string,
          lv_no    TYPE i.
    FIELD-SYMBOLS: <ls_r>   TYPE ty_param,
                   <ls_opt> TYPE ty_opt.

    CLEAR rt.

    " 声明顺序逐个: 单选按钮先占位(组插在第一个按钮的位置), 其余直接成行
    LOOP AT gt_decl INTO ls_d.
      IF ls_d-nodisp = abap_true OR ls_d-name = 'P_AICAP' OR ls_d-name = 'P_RUNID'.
        CONTINUE.
      ENDIF.
      IF ls_d-grp IS NOT INITIAL.
        IF NOT line_exists( lt_grp[ table_line = ls_d-grp ] ).
          APPEND ls_d-grp TO lt_grp.
          CLEAR ls_r.
          ls_r-param_id = `#GRP#` && ls_d-grp.
          APPEND ls_r TO rt.
        ENDIF.
        CONTINUE.
      ENDIF.

      label_of( EXPORTING is_decl = ls_d IMPORTING ev_text = lv_lbl ev_src = lv_src ).
      CLEAR ls_r.
      ls_r-param_id      = ls_d-name.
      ls_r-abap_name     = ls_d-name.
      ls_r-display_label = lv_lbl.
      ls_r-label_src     = lv_src.
      ls_r-include       = abap_true.
      IF ls_d-checkbox = abap_true.
        ls_r-sel_kind    = 'C'.
        ls_r-data_type   = 'BOOL'.
        ls_r-type_length = 1.
        lv_dv = to_upper( unquote( ls_d-def ) ).
        IF lv_dv = 'X'.
          ls_r-allowed_ops = 'X'.
        ENDIF.
      ELSE.
        type_of( EXPORTING is_decl = ls_d IMPORTING ev_type = ls_r-data_type ev_len = ls_r-type_length ).
        ls_r-sel_kind = ls_d-kind.
        IF ls_d-kind = 'S'.
          IF ls_r-data_type = 'DATE' AND ls_d-nointv = abap_false.
            ls_r-range_allowed = abap_true.
          ELSEIF ls_d-noext = abap_false.
            ls_r-multi_value = abap_true.
          ENDIF.
        ENDIF.
        default_of( EXPORTING is_decl = ls_d IMPORTING ev_type = ls_r-default_type ev_value = ls_r-default_value ).
        " 程序必填但有默认值(或 INITIALIZATION 赋值): 登记成选填 + 默认, 不填就按默认下发
        IF ls_d-obligatory = abap_true AND ls_r-default_type IS INITIAL.
          ls_r-required = abap_true.
        ENDIF.
      ENDIF.
      IF is_danger( iv_name = ls_d-name iv_label = lv_lbl iv_ref = ls_d-ref ) = abap_true.
        ls_r-include = abap_false.
        lv_up = to_upper( ls_d-ref ).
        FIND REGEX gc_ref_danger IN lv_up.
        IF sy-subrc = 0.
          ls_r-note = '布局变式，不登记'.
        ELSE.
          ls_r-note = '疑似输出 / 传输 / 写入类，默认不登记（确认是业务条件再填「强制登记」）'.
        ENDIF.
      ENDIF.
      APPEND ls_r TO rt.
    ENDLOOP.

    " 单选组 → R(普通) 或 F(输出方式组: ALV / 查询那一项固定 X, 其余固定空格)
    LOOP AT lt_grp INTO lv_grp.
      CLEAR: lt_opt, lv_hasd, lv_danger, lv_safe.
      LOOP AT gt_decl INTO ls_b WHERE grp = lv_grp AND nodisp = abap_false.
        label_of( EXPORTING is_decl = ls_b IMPORTING ev_text = lv_lbl ev_src = lv_src ).
        CLEAR ls_opt.
        ls_opt-name = ls_b-name.
        ls_opt-text = lv_lbl.
        ls_opt-src  = lv_src.
        lv_dv = to_upper( unquote( ls_b-def ) ).
        IF lv_dv = 'X' AND lv_hasd = abap_false.
          ls_opt-dflt = abap_true.
          lv_hasd = abap_true.
        ENDIF.
        APPEND ls_opt TO lt_opt.
        IF is_danger( iv_name = ls_b-name iv_label = lv_lbl iv_ref = `` ) = abap_true.
          lv_danger = abap_true.
        ENDIF.
      ENDLOOP.
      IF lt_opt IS INITIAL.
        CONTINUE.
      ENDIF.
      IF lv_hasd = abap_false.
        " 程序没写 DEFAULT: SAP 默认选第一个
        READ TABLE lt_opt ASSIGNING <ls_opt> INDEX 1.
        <ls_opt>-dflt = abap_true.
      ENDIF.

      CLEAR lt_new.
      IF lv_danger = abap_false.
        CLEAR: lv_ops, lv_note.
        LOOP AT lt_opt INTO ls_opt.
          IF lv_ops IS NOT INITIAL.
            lv_ops = lv_ops && `;`.
          ENDIF.
          lv_ops = lv_ops && ls_opt-name && `=` && ls_opt-text.
          IF ls_opt-dflt = abap_true.
            lv_ops = lv_ops && `*`.
          ENDIF.
        ENDLOOP.
        IF strlen( lv_ops ) > 120.
          CLEAR lv_ops.
          LOOP AT lt_opt INTO ls_opt.
            IF lv_ops IS NOT INITIAL.
              lv_ops = lv_ops && `;`.
            ENDIF.
            lv_short = ls_opt-text.
            IF strlen( lv_short ) > 8.
              lv_short = substring( val = lv_short off = 0 len = 8 ).
            ENDIF.
            lv_ops = lv_ops && ls_opt-name && `=` && lv_short.
            IF ls_opt-dflt = abap_true.
              lv_ops = lv_ops && `*`.
            ENDIF.
          ENDLOOP.
          lv_note = '选项文字太长，已截到 8 个字'.
        ENDIF.
        lv_ok = abap_true.
        IF strlen( lv_ops ) > 120.
          lv_ok = abap_false.
          lv_note = '选项超过 120 字符，ALLOWED_OPS 放不下，请减少选项或改短文字后手工登记'.
        ENDIF.
        group_label( EXPORTING iv_grp = lv_grp IMPORTING ev_text = lv_glbl ev_src = lv_gsrc ).
        CLEAR ls_new.
        ls_new-param_id      = `RB_` && lv_grp.
        ls_new-abap_name     = lv_grp.
        ls_new-sel_kind      = 'R'.
        ls_new-display_label = lv_glbl.
        ls_new-label_src     = lv_gsrc.
        ls_new-data_type     = 'ENUM'.
        ls_new-allowed_ops   = lv_ops.
        ls_new-include       = lv_ok.
        ls_new-note          = lv_note.
        APPEND ls_new TO lt_new.
      ELSE.
        LOOP AT lt_opt INTO ls_opt.
          lv_up = to_upper( ls_opt-name ).
          FIND REGEX gc_safe_out IN ls_opt-text IGNORING CASE.
          IF sy-subrc <> 0.
            FIND REGEX gc_safe_out IN lv_up.
          ENDIF.
          IF sy-subrc = 0.
            lv_safe = ls_opt-name.
            EXIT.
          ENDIF.
        ENDLOOP.
        IF lv_safe IS NOT INITIAL.
          LOOP AT lt_opt INTO ls_opt.
            CLEAR ls_new.
            ls_new-param_id      = `OUT_` && ls_opt-name.
            ls_new-abap_name     = ls_opt-name.
            ls_new-sel_kind      = 'F'.
            ls_new-display_label = `（固定）` && ls_opt-text.
            ls_new-label_src     = ls_opt-src.
            ls_new-data_type     = 'CHAR'.
            ls_new-type_length   = 1.
            ls_new-include       = abap_true.
            IF ls_opt-name = lv_safe.
              ls_new-allowed_ops = 'X'.
              ls_new-note        = '输出方式组：固定为这一项'.
            ELSE.
              ls_new-note        = '输出方式组：固定为空'.
            ENDIF.
            APPEND ls_new TO lt_new.
          ENDLOOP.
        ELSE.
          APPEND |单选组 { lv_grp } 像是输出方式组, 但找不到可以固定的 ALV / 查询项, 未登记(保持程序默认), 请人工确认| TO gt_note.
        ENDIF.
      ENDIF.

      lv_ph = `#GRP#` && lv_grp.
      lv_idx = line_index( rt[ param_id = lv_ph ] ).
      IF lv_idx > 0.
        DELETE rt INDEX lv_idx.
        lv_pos = lv_idx.
        LOOP AT lt_new INTO ls_new.
          INSERT ls_new INTO rt INDEX lv_pos.
          lv_pos = lv_pos + 1.
        ENDLOOP.
      ENDIF.
    ENDLOOP.

    " 强制登记 / 不登记; 参数编号去重; 排序号
    LOOP AT rt ASSIGNING <ls_r>.
      lv_name = <ls_r>-abap_name.
      IF line_exists( it_skip[ table_line = lv_name ] ) OR line_exists( it_skip[ table_line = <ls_r>-param_id ] ).
        <ls_r>-include = abap_false.
        <ls_r>-note    = '按「不登记」排除'.
      ELSEIF <ls_r>-include = abap_false AND ( line_exists( it_force[ table_line = lv_name ] ) OR line_exists( it_force[ table_line = <ls_r>-param_id ] ) ).
        <ls_r>-include = abap_true.
        <ls_r>-note    = |强制登记(原判断: { <ls_r>-note })|.
      ENDIF.
      lv_cnt = 0.
      LOOP AT rt TRANSPORTING NO FIELDS WHERE param_id = <ls_r>-param_id.
        lv_cnt = lv_cnt + 1.
      ENDLOOP.
      IF lv_cnt > 1.
        lv_seq = lv_seq + 1.
        <ls_r>-param_id = |{ <ls_r>-param_id }_{ lv_seq }|.
      ENDIF.
      IF strlen( <ls_r>-param_id ) > 30.
        <ls_r>-param_id = substring( val = <ls_r>-param_id off = 0 len = 30 ).
      ENDIF.
      IF strlen( <ls_r>-display_label ) > 120.
        <ls_r>-display_label = substring( val = <ls_r>-display_label off = 0 len = 120 ).
      ENDIF.
      " 不用 sy-tabix: 上面数重复的内层 LOOP 会改掉它
      lv_no = lv_no + 1.
      <ls_r>-sort_no = lv_no * 10.
    ENDLOOP.

  ENDMETHOD.


  METHOD save.

    DATA: ls_p     TYPE ty_param,
          ls_db    TYPE zai_rpt_param,
          ls_def   TYPE zai_rpt_def,
          lv_ver   TYPE string,
          lv_rid   TYPE zai_rpt_def-report_id,
          lv_tc    TYPE zai_rpt_def-tcode,
          lv_other TYPE zai_rpt_def-report_id,
          lv_n     TYPE i.

    IF zcl_ai_chat_service=>v8_get_role( ) <> 'ADMIN'.
      rs-message = '只有 ZAI_CHAT_USER 里角色为 ADMIN 的账号能写报表登记'.
      RETURN.
    ENDIF.
    IF is_draft-error IS NOT INITIAL.
      rs-message = |草稿有错误, 不能写入: { is_draft-error }|.
      RETURN.
    ENDIF.
    IF is_draft-report_id IS INITIAL OR is_draft-tcode IS INITIAL OR is_draft-progname IS INITIAL.
      rs-message = '草稿缺报表编号 / 事务码 / 程序名, 不能写入'.
      RETURN.
    ENDIF.
    LOOP AT is_draft-params INTO ls_p WHERE include = abap_true.
      lv_n = lv_n + 1.
    ENDLOOP.
    IF lv_n = 0.
      rs-message = '没有要写入的参数行'.
      RETURN.
    ENDIF.

    lv_rid = is_draft-report_id.
    lv_tc  = is_draft-tcode.
    " 事务码唯一: 已被别的报表编号占用 → 拒绝
    SELECT SINGLE report_id FROM zai_rpt_def
      WHERE tcode = @lv_tc AND report_id <> @lv_rid
      INTO @lv_other.
    IF sy-subrc = 0.
      rs-message = |事务码 { is_draft-tcode } 已登记在报表 { lv_other } 下, 不能重复登记|.
      RETURN.
    ENDIF.

    lv_ver = |R{ sy-datum }{ sy-uzeit }|.

    LOOP AT is_draft-params INTO ls_p WHERE include = abap_true.
      CLEAR ls_db.
      ls_db-report_id       = lv_rid.
      ls_db-config_version  = lv_ver.
      ls_db-param_id        = ls_p-param_id.
      ls_db-abap_name       = ls_p-abap_name.
      ls_db-display_label   = ls_p-display_label.
      ls_db-data_type       = ls_p-data_type.
      ls_db-type_length     = ls_p-type_length.
      ls_db-type_decimals   = 0.
      ls_db-required        = COND #( WHEN ls_p-required = abap_true THEN 'X' ELSE ' ' ).
      ls_db-multi_value     = COND #( WHEN ls_p-multi_value = abap_true THEN 'X' ELSE ' ' ).
      ls_db-range_allowed   = COND #( WHEN ls_p-range_allowed = abap_true THEN 'X' ELSE ' ' ).
      ls_db-default_type    = ls_p-default_type.
      ls_db-default_value   = ls_p-default_value.
      ls_db-allowed_ops     = ls_p-allowed_ops.
      ls_db-sort_no         = ls_p-sort_no.
      ls_db-active          = 'X'.
      ls_db-sel_kind        = ls_p-sel_kind.
      INSERT zai_rpt_param FROM ls_db.
      IF sy-subrc <> 0.
        ROLLBACK WORK.
        rs-message = |写参数 { ls_p-param_id } 失败(主键重复?), 已全部撤回|.
        RETURN.
      ENDIF.
    ENDLOOP.

    SELECT SINGLE * FROM zai_rpt_def WHERE report_id = @lv_rid INTO @ls_def.
    IF sy-subrc = 0.
      rs-old_version      = ls_def-config_version.
      ls_def-config_version = lv_ver.
      IF ls_def-tcode IS INITIAL.
        ls_def-tcode = lv_tc.
      ENDIF.
      IF ls_def-progname IS INITIAL.
        ls_def-progname = is_draft-progname.
      ENDIF.
      IF ls_def-report_name IS INITIAL.
        ls_def-report_name = is_draft-report_name.
      ENDIF.
      IF ls_def-description IS INITIAL.
        ls_def-description = is_draft-description.
      ENDIF.
      IF iv_exec_enabled = abap_true.
        ls_def-exec_enabled = 'X'.
      ENDIF.
      UPDATE zai_rpt_def FROM ls_def.
    ELSE.
      CLEAR ls_def.
      ls_def-report_id       = lv_rid.
      ls_def-tcode           = lv_tc.
      ls_def-progname        = is_draft-progname.
      ls_def-report_name     = is_draft-report_name.
      ls_def-description     = is_draft-description.
      ls_def-report_kind     = 'ALV'.
      ls_def-result_mode     = 'ALV_CAPTURE'.
      ls_def-exec_mode       = 'JOB'.
      ls_def-read_enabled    = 'X'.
      ls_def-exec_enabled    = COND #( WHEN iv_exec_enabled = abap_true THEN 'X' ELSE ' ' ).
      ls_def-analyze_enabled = 'X'.
      ls_def-max_rows        = COND #( WHEN iv_max_rows > 0 THEN iv_max_rows ELSE 200 ).
      ls_def-config_version  = lv_ver.
      ls_def-active          = 'X'.
      INSERT zai_rpt_def FROM ls_def.
    ENDIF.
    IF sy-subrc <> 0.
      ROLLBACK WORK.
      rs-message = |写报表登记 { is_draft-report_id } 失败, 已全部撤回|.
      RETURN.
    ENDIF.
    COMMIT WORK.

    rs-ok      = abap_true.
    rs-version = lv_ver.
    rs-message = |已写入 { is_draft-report_id }: { lv_n } 个参数, 配置版本 { lv_ver }|.
    IF rs-old_version IS NOT INITIAL.
      rs-message = rs-message && |(原版本 { rs-old_version }, 回滚 = 把 ZAI_RPT_DEF.CONFIG_VERSION 改回原版本)|.
    ENDIF.

  ENDMETHOD.


  METHOD read_source.

    DATA: lt_src  TYPE string_table,
          lt_inc  TYPE string_table,
          lv_line TYPE string,
          lv_up   TYPE string,
          lv_inc  TYPE string,
          lv_next TYPE i.

    CLEAR rt.
    READ REPORT iv_prog INTO lt_src STATE 'A'.
    IF sy-subrc <> 0.
      READ REPORT iv_prog INTO lt_src.
    ENDIF.
    IF sy-subrc <> 0.
      IF iv_depth > 0.
        APPEND |include { iv_prog } 读不到, 跳过(里面的参数不会出现在草稿里)| TO gt_note.
      ENDIF.
      RETURN.
    ENDIF.
    IF iv_depth >= 3.
      rt = lt_src.
      RETURN.
    ENDIF.
    lv_next = iv_depth + 1.
    LOOP AT lt_src INTO lv_line.
      lv_up = to_upper( condense( lv_line ) ).
      CLEAR lv_inc.
      FIND REGEX '^INCLUDE\s+([ZY][A-Z0-9_/]*)\s*\.' IN lv_up SUBMATCHES lv_inc.
      IF sy-subrc = 0 AND lv_inc IS NOT INITIAL AND gv_incl < 30.
        gv_incl = gv_incl + 1.
        lt_inc = read_source( iv_prog = lv_inc iv_depth = lv_next ).
        APPEND LINES OF lt_inc TO rt.
        CONTINUE.
      ENDIF.
      APPEND lv_line TO rt.
    ENDLOOP.

  ENDMETHOD.


  METHOD split_statements.

    DATA: lv_line  TYPE string,
          lv_buf   TYPE string,
          lv_c     TYPE string,
          lv_lit   TYPE string,
          lv_len   TYPE i,
          lv_i     TYPE i,
          lv_start TYPE i,
          lv_row   TYPE i,
          lv_text  TYPE string,
          lt_raw   TYPE tt_stmt,
          ls_st    TYPE ty_stmt,
          lv_colon TYPE i,
          lv_off   TYPE i,
          lv_head  TYPE string,
          lv_rest  TYPE string,
          lv_part  TYPE string,
          lv_comma TYPE i,
          lv_c1    TYPE c LENGTH 1.

    CLEAR: gt_stmt, gt_cmt.
    lv_start = 0.
    LOOP AT it_src INTO lv_line.
      lv_row = sy-tabix.
      IF lv_line IS NOT INITIAL.
        lv_c1 = lv_line.
        IF lv_c1 = '*'.
          lv_text = lv_line.
          SHIFT lv_text LEFT DELETING LEADING '*'.
          REPLACE REGEX '^[-= ]+' IN lv_text WITH ``.
          REPLACE REGEX '[-= ]+$' IN lv_text WITH ``.
          APPEND VALUE #( line = lv_row text = condense( lv_text ) ) TO gt_cmt.
          CONTINUE.
        ENDIF.
      ENDIF.
      lv_len = strlen( lv_line ).
      lv_i = 0.
      CLEAR lv_lit.
      WHILE lv_i < lv_len.
        lv_c = substring( val = lv_line off = lv_i len = 1 ).
        lv_i = lv_i + 1.
        IF lv_lit IS NOT INITIAL.
          lv_buf = lv_buf && lv_c.
          IF lv_c = lv_lit.
            CLEAR lv_lit.
          ENDIF.
          CONTINUE.
        ENDIF.
        IF lv_c = '"'.
          EXIT.
        ENDIF.
        IF lv_c = `'` OR lv_c = '`' OR lv_c = '|'.
          lv_lit = lv_c.
          lv_buf = lv_buf && lv_c.
          IF lv_start = 0.
            lv_start = lv_row.
          ENDIF.
          CONTINUE.
        ENDIF.
        IF lv_c = '.'.
          lv_text = condense( lv_buf ).
          IF lv_text IS NOT INITIAL.
            CLEAR ls_st.
            ls_st-text = lv_text.
            ls_st-line = COND #( WHEN lv_start > 0 THEN lv_start ELSE lv_row ).
            APPEND ls_st TO lt_raw.
          ENDIF.
          CLEAR lv_buf.
          lv_start = 0.
          CONTINUE.
        ENDIF.
        IF lv_start = 0 AND lv_c <> ` `.
          lv_start = lv_row.
        ENDIF.
        lv_buf = lv_buf && lv_c.
      ENDWHILE.
      lv_buf = lv_buf && ` `.
    ENDLOOP.
    lv_text = condense( lv_buf ).
    IF lv_text IS NOT INITIAL.
      APPEND VALUE #( text = lv_text line = lv_start ) TO lt_raw.
    ENDIF.

    " 链式: HEAD: a, b → HEAD a / HEAD b(冒号、逗号都要在字面量 / 括号外)
    LOOP AT lt_raw INTO ls_st.
      lv_colon = outer_index( iv_text = ls_st-text iv_ch = `:` ).
      IF lv_colon < 0.
        APPEND ls_st TO gt_stmt.
        CONTINUE.
      ENDIF.
      lv_head = substring( val = ls_st-text off = 0 len = lv_colon ).
      lv_off = lv_colon + 1.
      lv_rest = substring( val = ls_st-text off = lv_off ).
      DO.
        lv_comma = outer_index( iv_text = lv_rest iv_ch = `,` ).
        IF lv_comma < 0.
          lv_part = lv_rest.
        ELSE.
          lv_part = substring( val = lv_rest off = 0 len = lv_comma ).
          lv_off = lv_comma + 1.
          lv_rest = substring( val = lv_rest off = lv_off ).
        ENDIF.
        lv_part = condense( lv_part ).
        IF lv_part IS NOT INITIAL.
          CLEAR lv_text.
          lv_text = lv_head && ` ` && lv_part.
          APPEND VALUE #( text = condense( lv_text ) line = ls_st-line ) TO gt_stmt.
        ENDIF.
        IF lv_comma < 0.
          EXIT.
        ENDIF.
      ENDDO.
    ENDLOOP.

  ENDMETHOD.


  METHOD outer_index.

    DATA: lv_len   TYPE i,
          lv_i     TYPE i,
          lv_c     TYPE string,
          lv_lit   TYPE string,
          lv_depth TYPE i.

    rv = -1.
    lv_len = strlen( iv_text ).
    WHILE lv_i < lv_len.
      lv_c = substring( val = iv_text off = lv_i len = 1 ).
      IF lv_lit IS NOT INITIAL.
        IF lv_c = lv_lit.
          CLEAR lv_lit.
        ENDIF.
      ELSEIF lv_c = `'` OR lv_c = '`' OR lv_c = '|'.
        lv_lit = lv_c.
      ELSEIF lv_c = '('.
        lv_depth = lv_depth + 1.
      ELSEIF lv_c = ')'.
        lv_depth = lv_depth - 1.
      ELSEIF lv_c = iv_ch AND lv_depth = 0.
        rv = lv_i.
        RETURN.
      ENDIF.
      lv_i = lv_i + 1.
    ENDWHILE.

  ENDMETHOD.


  METHOD tokens.

    DATA: lv_len TYPE i,
          lv_i   TYPE i,
          lv_c   TYPE string,
          lv_cur TYPE string,
          lv_lit TYPE string,
          ls_tok TYPE ty_tok,
          lv_c1  TYPE c LENGTH 1.

    CLEAR rt.
    lv_len = strlen( iv_text ).
    WHILE lv_i <= lv_len.
      IF lv_i < lv_len.
        lv_c = substring( val = iv_text off = lv_i len = 1 ).
      ELSE.
        lv_c = ` `.
      ENDIF.
      lv_i = lv_i + 1.
      IF lv_lit IS NOT INITIAL.
        lv_cur = lv_cur && lv_c.
        IF lv_c = lv_lit.
          CLEAR lv_lit.
        ENDIF.
        CONTINUE.
      ENDIF.
      IF lv_c = `'` OR lv_c = '`'.
        lv_lit = lv_c.
        lv_cur = lv_cur && lv_c.
        CONTINUE.
      ENDIF.
      IF lv_c = ` ` OR lv_c = cl_abap_char_utilities=>horizontal_tab.
        IF lv_cur IS NOT INITIAL.
          CLEAR ls_tok.
          ls_tok-raw = lv_cur.
          lv_c1 = lv_cur.
          IF lv_c1 = `'` OR lv_c1 = '`'.
            ls_tok-up = lv_cur.
          ELSE.
            ls_tok-up = to_upper( lv_cur ).
          ENDIF.
          APPEND ls_tok TO rt.
          CLEAR lv_cur.
        ENDIF.
        CONTINUE.
      ENDIF.
      lv_cur = lv_cur && lv_c.
    ENDWHILE.

  ENDMETHOD.


  METHOD parse_screen.

    DATA: ls_st     TYPE ty_stmt,
          lt_tok    TYPE tt_tok,
          ls_tok    TYPE ty_tok,
          ls_t2     TYPE ty_tok,
          lv_k0     TYPE string,
          lv_up     TYPE string,
          lv_init   TYPE abap_bool,
          lt_block  TYPE string_table,
          lv_title  TYPE string,
          lv_lgid   TYPE i,
          lv_cur_lg TYPE i,
          lv_ic     TYPE i,
          lv_j      TYPE i,
          lv_jp     TYPE i,
          lv_jn     TYPE i,
          lv_var    TYPE string,
          lv_field  TYPE string,
          lv_n      TYPE i,
          lv_val    TYPE string,
          ls_decl   TYPE ty_decl,
          ls_lg     TYPE ty_lgrp,
          lv_kind   TYPE c LENGTH 1,
          lv_c1     TYPE c LENGTH 1.
    FIELD-SYMBOLS <ls_lg> TYPE ty_lgrp.

    CLEAR: gt_decl, gt_lgrp, gt_cfor, gt_asg.
    LOOP AT gt_stmt INTO ls_st.
      lt_tok = tokens( ls_st-text ).
      IF lt_tok IS INITIAL.
        CONTINUE.
      ENDIF.
      READ TABLE lt_tok INTO ls_tok INDEX 1.
      lv_k0 = ls_tok-up.
      lv_up = to_upper( ls_st-text ).

      " 事件块: 只收 INITIALIZATION 段里的赋值
      IF lv_up CP 'INITIALIZATION*'.
        lv_init = abap_true.
      ELSEIF lv_up CP 'START-OF-SELECTION*' OR lv_up CP 'END-OF-SELECTION*'
          OR lv_up CP 'AT SELECTION-SCREEN*' OR lv_up CP 'AT LINE-SELECTION*'
          OR lv_up CP 'AT USER-COMMAND*' OR lv_up CP 'TOP-OF-PAGE*'
          OR lv_up CP 'END-OF-PAGE*' OR lv_up CP 'LOAD-OF-PROGRAM*'
          OR lv_up CP 'FORM *' OR lv_up CP 'MODULE *' OR lv_up CP 'CLASS *'.
        lv_init = abap_false.
      ENDIF.

      IF lv_k0 = 'SELECTION-SCREEN'.
        IF lv_up CS 'BEGIN OF BLOCK'.
          CLEAR lv_title.
          FIND REGEX 'TITLE\s+(\S+)' IN lv_up SUBMATCHES lv_title.
          INSERT lv_title INTO lt_block INDEX 1.
        ELSEIF lv_up CS 'END OF BLOCK'.
          IF lt_block IS NOT INITIAL.
            DELETE lt_block INDEX 1.
          ENDIF.
        ELSEIF lv_up CS 'BEGIN OF LINE'.
          lv_lgid = lv_lgid + 1.
          CLEAR ls_lg.
          ls_lg-id   = lv_lgid.
          ls_lg-line = ls_st-line.
          APPEND ls_lg TO gt_lgrp.
          lv_cur_lg = lv_lgid.
        ELSEIF lv_up CS 'END OF LINE'.
          lv_cur_lg = 0.
        ELSEIF line_exists( lt_tok[ up = 'COMMENT' ] ).
          " COMMENT [pos](len) 变量 [FOR FIELD 参数] [MODIF ID m]
          lv_ic = line_index( lt_tok[ up = 'COMMENT' ] ).
          lv_j = lv_ic + 1.
          CLEAR: lv_var, lv_field.
          READ TABLE lt_tok INTO ls_t2 INDEX lv_j.
          IF sy-subrc = 0.
            lv_c1 = ls_t2-up.
            IF lv_c1 = '/' OR lv_c1 = '(' OR lv_c1 CA '0123456789'.
              lv_j = lv_j + 1.
              READ TABLE lt_tok INTO ls_t2 INDEX lv_j.
              IF sy-subrc <> 0.
                CLEAR ls_t2.
              ENDIF.
            ENDIF.
            lv_var = ls_t2-up.
          ENDIF.
          lv_n = lines( lt_tok ).
          lv_j = 2.
          WHILE lv_j < lv_n.
            READ TABLE lt_tok INTO ls_tok INDEX lv_j.
            IF ls_tok-up = 'FIELD'.
              lv_jp = lv_j - 1.
              lv_jn = lv_j + 1.
              CLEAR ls_t2.
              READ TABLE lt_tok INTO ls_t2 INDEX lv_jp.
              IF ls_t2-up = 'FOR'.
                CLEAR ls_t2.
                READ TABLE lt_tok INTO ls_t2 INDEX lv_jn.
                lv_field = ls_t2-up.
                EXIT.
              ENDIF.
            ENDIF.
            lv_j = lv_j + 1.
          ENDWHILE.
          IF lv_var IS NOT INITIAL.
            IF lv_field IS NOT INITIAL.
              APPEND VALUE #( k = lv_field v = lv_var ) TO gt_cfor.
            ELSEIF lv_cur_lg > 0.
              READ TABLE gt_lgrp ASSIGNING <ls_lg> WITH KEY id = lv_cur_lg.
              IF sy-subrc = 0.
                APPEND VALUE #( kind = 'C' name = lv_var ) TO <ls_lg>-ord.
                <ls_lg>-ncomm = <ls_lg>-ncomm + 1.
              ENDIF.
            ENDIF.
          ENDIF.
        ENDIF.
        CONTINUE.
      ENDIF.

      IF lv_k0 = 'PARAMETERS' OR lv_k0 = 'PARAMETER' OR lv_k0 = 'SELECT-OPTIONS'.
        lv_kind = COND #( WHEN lv_k0 = 'SELECT-OPTIONS' THEN 'S' ELSE 'P' ).
        ls_decl = parse_decl( it_tok = lt_tok iv_kind = lv_kind ).
        IF ls_decl-name IS NOT INITIAL.
          ls_decl-line = ls_st-line.
          CLEAR ls_decl-block.
          READ TABLE lt_block INTO ls_decl-block INDEX 1.
          ls_decl-lgid = lv_cur_lg.
          IF lv_cur_lg > 0.
            READ TABLE gt_lgrp ASSIGNING <ls_lg> WITH KEY id = lv_cur_lg.
            IF sy-subrc = 0.
              APPEND VALUE #( kind = 'P' name = ls_decl-name ) TO <ls_lg>-ord.
              <ls_lg>-nparm = <ls_lg>-nparm + 1.
            ENDIF.
          ENDIF.
          APPEND ls_decl TO gt_decl.
        ENDIF.
        CONTINUE.
      ENDIF.

      " INITIALIZATION 里的 x = '…' / p = sy-datum - 1
      IF lv_init = abap_true AND lines( lt_tok ) >= 3.
        READ TABLE lt_tok INTO ls_t2 INDEX 2.
        IF ls_t2-up = '='.
          CLEAR lv_val.
          LOOP AT lt_tok INTO ls_tok FROM 3.
            IF lv_val IS NOT INITIAL.
              lv_val = lv_val && ` `.
            ENDIF.
            lv_val = lv_val && ls_tok-raw.
          ENDLOOP.
          APPEND VALUE #( k = lv_k0 v = lv_val ) TO gt_asg.
        ENDIF.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD parse_decl.

    DATA: ls_t   TYPE ty_tok,
          ls_pv  TYPE ty_tok,
          ls_nx  TYPE ty_tok,
          ls_n2  TYPE ty_tok,
          lv_raw TYPE string,
          lv_nm  TYPE string,
          lv_ln  TYPE string,
          lv_cnt TYPE i,
          lv_i   TYPE i,
          lv_ip  TYPE i,
          lv_in  TYPE i,
          lv_i2  TYPE i.

    CLEAR rs.
    READ TABLE it_tok INTO ls_t INDEX 2.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    lv_raw = ls_t-up.
    FIND REGEX '^([A-Z0-9_]+)\(([0-9]+)\)$' IN lv_raw SUBMATCHES lv_nm lv_ln.
    IF sy-subrc = 0.
      rs-name = lv_nm.
      rs-len  = lv_ln.
    ELSE.
      FIND REGEX '^[A-Z0-9_]+$' IN lv_raw.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      rs-name = lv_raw.
    ENDIF.
    rs-kind = iv_kind.

    lv_cnt = lines( it_tok ).
    lv_i = 3.
    WHILE lv_i <= lv_cnt.
      READ TABLE it_tok INTO ls_t INDEX lv_i.
      lv_ip = lv_i - 1.
      lv_in = lv_i + 1.
      lv_i2 = lv_i + 2.
      CLEAR: ls_pv, ls_nx, ls_n2.
      READ TABLE it_tok INTO ls_pv INDEX lv_ip.
      READ TABLE it_tok INTO ls_nx INDEX lv_in.
      READ TABLE it_tok INTO ls_n2 INDEX lv_i2.
      CASE ls_t-up.
        WHEN 'TYPE' OR 'LIKE' OR 'FOR'.
          IF ls_nx-up IS NOT INITIAL.
            IF ls_t-up = 'TYPE' AND ( ls_nx-up = 'C' OR ls_nx-up = 'N' OR ls_nx-up = 'D' OR ls_nx-up = 'T'
                                   OR ls_nx-up = 'I' OR ls_nx-up = 'P' OR ls_nx-up = 'F'
                                   OR ls_nx-up = 'STRING' OR ls_nx-up = 'X' ).
              rs-builtin = ls_nx-up.
            ELSE.
              rs-ref = ls_nx-up.
            ENDIF.
            lv_i = lv_i + 1.
          ENDIF.
        WHEN 'OBLIGATORY'.
          rs-obligatory = abap_true.
        WHEN 'DEFAULT'.
          IF ls_nx-raw IS NOT INITIAL.
            rs-def = ls_nx-raw.
            lv_i = lv_i + 1.
          ENDIF.
        WHEN 'CHECKBOX'.
          IF ls_pv-up = 'AS'.
            rs-checkbox = abap_true.
          ENDIF.
        WHEN 'RADIOBUTTON'.
          IF ls_nx-up = 'GROUP' AND ls_n2-up IS NOT INITIAL.
            rs-grp = ls_n2-up.
            lv_i = lv_i + 2.
          ENDIF.
        WHEN 'NO-DISPLAY'.
          rs-nodisp = abap_true.
        WHEN 'INTERVALS'.
          IF ls_pv-up = 'NO'.
            rs-nointv = abap_true.
          ENDIF.
        WHEN 'NO-EXTENSION'.
          rs-noext = abap_true.
        WHEN 'ID'.
          IF ls_pv-up = 'MODIF' OR ls_pv-up = 'MEMORY'.
            lv_i = lv_i + 1.
          ENDIF.
        WHEN 'LENGTH'.
          IF ls_pv-up <> 'VISIBLE' AND ls_nx-up CO '0123456789' AND ls_nx-up IS NOT INITIAL.
            rs-len = ls_nx-up.
            lv_i = lv_i + 1.
          ENDIF.
      ENDCASE.
      lv_i = lv_i + 1.
    ENDWHILE.

  ENDMETHOD.


  METHOD read_texts.

    DATA: lt_tp   TYPE STANDARD TABLE OF textpool WITH DEFAULT KEY,
          ls_tp   TYPE textpool,
          lt_lang TYPE STANDARD TABLE OF sy-langu WITH DEFAULT KEY,
          lv_l    TYPE sy-langu,
          lv_len  TYPE i,
          lv_t    TYPE string,
          lv_c1   TYPE c LENGTH 1.

    CLEAR: gt_tps, gt_tpd, gt_tpi.
    APPEND gv_lang TO lt_lang.
    APPEND 'M' TO lt_lang.
    APPEND '1' TO lt_lang.
    APPEND 'E' TO lt_lang.
    LOOP AT lt_lang INTO lv_l.
      CLEAR lt_tp.
      READ TEXTPOOL iv_prog INTO lt_tp LANGUAGE lv_l.
      IF sy-subrc <> 0 OR NOT line_exists( lt_tp[ id = 'S' ] ).
        CONTINUE.
      ENDIF.
      LOOP AT lt_tp INTO ls_tp.
        CASE ls_tp-id.
          WHEN 'S'.
            " 选择文本: ENTRY 前 8 位保留(第 1 位 D = 勾了字典参考), 文字从第 9 位起
            lv_len = strlen( ls_tp-entry ).
            CLEAR lv_t.
            IF lv_len > 8.
              lv_t = ls_tp-entry+8.
              lv_t = condense( lv_t ).
            ENDIF.
            lv_c1 = ls_tp-entry.
            IF lv_c1 = 'D'.
              APPEND VALUE #( k = ls_tp-key v = 'X' ) TO gt_tpd.
            ENDIF.
            IF lv_t IS NOT INITIAL.
              APPEND VALUE #( k = ls_tp-key v = lv_t ) TO gt_tps.
            ENDIF.
          WHEN 'I'.
            lv_t = ls_tp-entry.
            APPEND VALUE #( k = ls_tp-key v = condense( lv_t ) ) TO gt_tpi.
          WHEN 'R'.
            lv_t = ls_tp-entry.
            gv_title = condense( lv_t ).
        ENDCASE.
      ENDLOOP.
      EXIT.
    ENDLOOP.

  ENDMETHOD.


  METHOD text_of_var.

    DATA: ls_kv   TYPE ty_kv,
          lv_key  TYPE string,
          lv_v    TYPE string,
          lv_last TYPE string,
          lv_cjk  TYPE string.

    CLEAR rv.
    IF iv_var IS INITIAL.
      RETURN.
    ENDIF.
    IF iv_var CP 'TEXT-*'.
      lv_key = substring( val = iv_var off = 5 ).
      READ TABLE gt_tpi INTO ls_kv WITH KEY k = lv_key.
      IF sy-subrc = 0.
        rv = ls_kv-v.
      ENDIF.
      RETURN.
    ENDIF.
    " 只认字面量赋值(com_icon = icon_message_information 这种不是文字); 有中文的优先
    LOOP AT gt_asg INTO ls_kv WHERE k = iv_var.
      IF is_literal( ls_kv-v ) = abap_false.
        CONTINUE.
      ENDIF.
      lv_v = condense( unquote( ls_kv-v ) ).
      IF lv_v IS INITIAL.
        CONTINUE.
      ENDIF.
      lv_last = lv_v.
      IF has_cjk( lv_v ) = abap_true.
        lv_cjk = lv_v.
      ENDIF.
    ENDLOOP.
    rv = COND #( WHEN lv_cjk IS NOT INITIAL THEN lv_cjk ELSE lv_last ).

  ENDMETHOD.


  METHOD label_of.

    DATA: ls_kv  TYPE ty_kv,
          ls_lg  TYPE ty_lgrp,
          ls_o   TYPE ty_ord,
          lv_var TYPE string,
          lv_t   TYPE string,
          lv_ip  TYPE i,
          lv_ia  TYPE i.

    CLEAR: ev_text, ev_src.
    " ① 选择文本(勾了字典参考的跳过, 后面取字典字段名)
    READ TABLE gt_tps INTO ls_kv WITH KEY k = is_decl-name.
    IF sy-subrc = 0 AND NOT line_exists( gt_tpd[ k = is_decl-name ] ).
      ev_text = ls_kv-v.
      ev_src  = 'TEXTPOOL'.
      RETURN.
    ENDIF.
    " ② 源码说明: COMMENT … FOR FIELD; 否则同一行里紧跟在后面的, 再否则前面的
    READ TABLE gt_cfor INTO ls_kv WITH KEY k = is_decl-name.
    IF sy-subrc = 0.
      lv_var = ls_kv-v.
    ENDIF.
    IF lv_var IS INITIAL AND is_decl-lgid > 0.
      READ TABLE gt_lgrp INTO ls_lg WITH KEY id = is_decl-lgid.
      IF sy-subrc = 0.
        lv_ip = line_index( ls_lg-ord[ kind = 'P' name = is_decl-name ] ).
        IF lv_ip > 0.
          lv_ia = lv_ip + 1.
          LOOP AT ls_lg-ord INTO ls_o FROM lv_ia WHERE kind = 'C'.
            lv_var = ls_o-name.
            EXIT.
          ENDLOOP.
          IF lv_var IS INITIAL.
            LOOP AT ls_lg-ord INTO ls_o TO lv_ip WHERE kind = 'C'.
              lv_var = ls_o-name.
            ENDLOOP.
          ENDIF.
        ENDIF.
      ENDIF.
    ENDIF.
    IF lv_var IS NOT INITIAL.
      lv_t = text_of_var( lv_var ).
      IF lv_t IS NOT INITIAL.
        ev_text = lv_t.
        ev_src  = 'COMMENT'.
        RETURN.
      ENDIF.
    ENDIF.
    " ③ 字典字段名
    IF is_decl-ref IS NOT INITIAL.
      ddic_info( EXPORTING iv_ref = is_decl-ref IMPORTING ev_label = lv_t ).
      IF lv_t IS NOT INITIAL.
        ev_text = lv_t.
        ev_src  = 'DDIC'.
        RETURN.
      ENDIF.
    ENDIF.
    ev_text = is_decl-name.
    ev_src  = 'NAME'.

  ENDMETHOD.


  METHOD group_label.

    DATA: ls_first TYPE ty_decl,
          ls_d     TYPE ty_decl,
          ls_lg    TYPE ty_lgrp,
          ls_prev  TYPE ty_lgrp,
          ls_o     TYPE ty_ord,
          ls_c     TYPE ty_stmt,
          lv_myln  TYPE i,
          lv_from  TYPE i,
          lv_has   TYPE abap_bool,
          lv_betw  TYPE abap_bool,
          lv_t     TYPE string,
          lv_c1    TYPE string,
          lv_c2    TYPE string,
          lv_c3    TYPE string.

    CLEAR: ev_text, ev_src.
    READ TABLE gt_decl INTO ls_first WITH KEY grp = iv_grp.
    lv_myln = ls_first-line.
    IF ls_first-lgid > 0.
      READ TABLE gt_lgrp INTO ls_lg WITH KEY id = ls_first-lgid.
      IF sy-subrc = 0.
        lv_myln = ls_lg-line.
      ENDIF.
    ENDIF.
    " ① 紧挨在组前面、没有参数的那一行 SELECTION-SCREEN 说明
    LOOP AT gt_lgrp INTO ls_lg WHERE line < lv_myln.
      ls_prev = ls_lg.
      lv_has = abap_true.
    ENDLOOP.
    IF lv_has = abap_true AND ls_prev-nparm = 0 AND ls_prev-ncomm > 0.
      LOOP AT gt_decl INTO ls_d WHERE line > ls_prev-line AND line < ls_first-line.
        lv_betw = abap_true.
        EXIT.
      ENDLOOP.
      IF lv_betw = abap_false.
        LOOP AT ls_prev-ord INTO ls_o WHERE kind = 'C'.
          lv_t = text_of_var( ls_o-name ).
          IF lv_t IS NOT INITIAL.
            lv_c1 = lv_t.
          ENDIF.
        ENDLOOP.
      ENDIF.
    ENDIF.
    " ② 组前 3 行内的整行注释
    lv_from = lv_myln - 3.
    LOOP AT gt_cmt INTO ls_c WHERE line < lv_myln AND line >= lv_from.
      IF ls_c-text IS NOT INITIAL.
        lv_c2 = ls_c-text.
      ENDIF.
    ENDLOOP.
    " ③ 所在块标题
    IF ls_first-block IS NOT INITIAL.
      lv_c3 = text_of_var( ls_first-block ).
    ENDIF.
    " 优先带中文的候选, 都没有中文取第一个非空的
    IF lv_c1 IS NOT INITIAL AND has_cjk( lv_c1 ) = abap_true.
      ev_text = lv_c1. ev_src = 'COMMENT'.
    ELSEIF lv_c2 IS NOT INITIAL AND has_cjk( lv_c2 ) = abap_true.
      ev_text = lv_c2. ev_src = 'SRC_COMMENT'.
    ELSEIF lv_c3 IS NOT INITIAL AND has_cjk( lv_c3 ) = abap_true.
      ev_text = lv_c3. ev_src = 'BLOCK'.
    ELSEIF lv_c1 IS NOT INITIAL.
      ev_text = lv_c1. ev_src = 'COMMENT'.
    ELSEIF lv_c2 IS NOT INITIAL.
      ev_text = lv_c2. ev_src = 'SRC_COMMENT'.
    ELSEIF lv_c3 IS NOT INITIAL.
      ev_text = lv_c3. ev_src = 'BLOCK'.
    ELSE.
      ev_text = `单选组 ` && iv_grp.
      ev_src  = 'NAME'.
    ENDIF.

  ENDMETHOD.


  METHOD type_of.

    DATA: lv_kind TYPE string,
          lv_len  TYPE i,
          lv_dk   TYPE string,
          lv_dl   TYPE i.

    CLEAR: ev_type, ev_len.
    lv_kind = is_decl-builtin.
    lv_len  = is_decl-len.
    IF lv_kind IS INITIAL AND is_decl-ref IS NOT INITIAL.
      ddic_info( EXPORTING iv_ref = is_decl-ref IMPORTING ev_kind = lv_dk ev_len = lv_dl ).
      lv_kind = lv_dk.
      IF lv_len = 0.
        lv_len = lv_dl.
      ENDIF.
    ENDIF.
    CASE lv_kind.
      WHEN 'D'.
        ev_type = 'DATE'.
        ev_len  = 8.
      WHEN 'I' OR 'P' OR 'F' OR 'b' OR 's' OR '8' OR 'a' OR 'e'.
        ev_type = 'NUM'.
        ev_len  = lv_len.
      WHEN OTHERS.
        ev_type = 'CHAR'.
        ev_len  = lv_len.
    ENDCASE.

  ENDMETHOD.


  METHOD default_of.

    DATA: ls_kv TYPE ty_kv,
          lv_t  TYPE string,
          lv_v  TYPE string.

    CLEAR: ev_type, ev_value.
    parse_default( EXPORTING iv_text = is_decl-def IMPORTING ev_type = ev_type ev_value = ev_value ).
    IF ev_type IS NOT INITIAL.
      RETURN.
    ENDIF.
    LOOP AT gt_asg INTO ls_kv WHERE k = is_decl-name.
      parse_default( EXPORTING iv_text = ls_kv-v IMPORTING ev_type = lv_t ev_value = lv_v ).
      IF lv_t IS NOT INITIAL.
        ev_type  = lv_t.
        ev_value = lv_v.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD parse_default.

    DATA: lv     TYPE string,
          lv_up  TYPE string,
          lv_sg  TYPE string,
          lv_num TYPE string.

    CLEAR: ev_type, ev_value.
    lv = condense( iv_text ).
    IF lv IS INITIAL.
      RETURN.
    ENDIF.
    lv_up = to_upper( lv ).
    IF lv_up = 'SY-DATUM'.
      ev_type  = 'TODAY'.
      ev_value = '0'.
      RETURN.
    ENDIF.
    FIND REGEX '^SY-DATUM\s*([+-])\s*([0-9]+)$' IN lv_up SUBMATCHES lv_sg lv_num.
    IF sy-subrc = 0.
      ev_type  = 'TODAY'.
      ev_value = COND #( WHEN lv_sg = '-' THEN `-` && lv_num ELSE lv_num ).
      RETURN.
    ENDIF.
    IF is_literal( lv ) = abap_true.
      ev_type  = 'STATIC'.
      ev_value = unquote( lv ).
      RETURN.
    ENDIF.
    FIND REGEX '^-?[0-9]+$' IN lv.
    IF sy-subrc = 0.
      ev_type  = 'STATIC'.
      ev_value = lv.
    ENDIF.

  ENDMETHOD.


  METHOD is_danger.

    DATA: lv_name TYPE string,
          lv_ref  TYPE string.

    rv = abap_false.
    lv_name = to_upper( iv_name ).
    FIND REGEX gc_name_danger IN lv_name.
    IF sy-subrc = 0.
      rv = abap_true.
      RETURN.
    ENDIF.
    IF iv_label IS NOT INITIAL.
      FIND REGEX gc_label_danger IN iv_label IGNORING CASE.
      IF sy-subrc = 0.
        rv = abap_true.
        RETURN.
      ENDIF.
    ENDIF.
    IF iv_ref IS NOT INITIAL.
      lv_ref = to_upper( iv_ref ).
      FIND REGEX gc_ref_danger IN lv_ref.
      IF sy-subrc = 0.
        rv = abap_true.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD ddic_info.

    DATA: lv_name  TYPE string,
          lo_type  TYPE REF TO cl_abap_typedescr,
          lo_elem  TYPE REF TO cl_abap_elemdescr,
          ls_dfies TYPE dfies.

    CLEAR: ev_kind, ev_len, ev_label.
    lv_name = to_upper( iv_ref ).
    IF lv_name CP 'SY-*'.
      REPLACE FIRST OCCURRENCE OF 'SY-' IN lv_name WITH 'SYST-'.
    ENDIF.
    cl_abap_typedescr=>describe_by_name(
      EXPORTING  p_name         = lv_name
      RECEIVING  p_descr_ref    = lo_type
      EXCEPTIONS type_not_found = 1
                 OTHERS         = 2 ).
    IF sy-subrc <> 0 OR lo_type IS NOT BOUND.
      RETURN.
    ENDIF.
    IF lo_type->kind <> cl_abap_typedescr=>kind_elem.
      RETURN.
    ENDIF.
    lo_elem ?= lo_type.
    ev_kind = lo_elem->type_kind.
    ev_len  = lo_elem->output_length.
    lo_elem->get_ddic_field(
      EXPORTING  p_langu      = gv_lang
      RECEIVING  p_flddescr   = ls_dfies
      EXCEPTIONS not_found    = 1
                 no_ddic_type = 2
                 OTHERS       = 3 ).
    IF sy-subrc = 0.
      ev_label = COND #( WHEN ls_dfies-scrtext_m IS NOT INITIAL THEN CONV string( ls_dfies-scrtext_m )
                         ELSE CONV string( ls_dfies-fieldtext ) ).
      ev_label = condense( ev_label ).
    ENDIF.

  ENDMETHOD.


  METHOD parse_header.

    DATA: lv_line TYPE string,
          lv_key  TYPE string,
          lv_sep  TYPE string,
          lv_val  TYPE string,
          lv_n    TYPE i.

    CLEAR: ev_purpose, ev_module, ev_tcode.
    LOOP AT it_src INTO lv_line.
      lv_n = lv_n + 1.
      IF lv_n > 60.
        EXIT.
      ENDIF.
      CLEAR: lv_key, lv_sep, lv_val.
      FIND REGEX '^\*\s*(PURPOSE|SAP\s*MODULE|T-?CODE)\s*(:|：)\s*(.*)$' IN lv_line
        IGNORING CASE SUBMATCHES lv_key lv_sep lv_val.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      REPLACE REGEX '\s*\*+\s*$' IN lv_val WITH ``.
      lv_val = condense( lv_val ).
      lv_key = to_upper( lv_key ).
      CONDENSE lv_key NO-GAPS.
      IF lv_key = 'PURPOSE' AND ev_purpose IS INITIAL.
        ev_purpose = lv_val.
      ELSEIF lv_key = 'SAPMODULE' AND ev_module IS INITIAL.
        ev_module = to_upper( lv_val ).
      ELSEIF ( lv_key = 'T-CODE' OR lv_key = 'TCODE' ) AND ev_tcode IS INITIAL.
        ev_tcode = to_upper( lv_val ).
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD has_cjk.

    DATA: lv_len TYPE i,
          lv_i   TYPE i,
          lv_c   TYPE c LENGTH 1,
          lv_hex TYPE string.

    rv = abap_false.
    lv_len = strlen( iv ).
    WHILE lv_i < lv_len.
      lv_c = substring( val = iv off = lv_i len = 1 ).
      lv_hex = cl_abap_conv_out_ce=>uccp( lv_c ).
      IF lv_hex >= '4E00' AND lv_hex <= '9FFF'.
        rv = abap_true.
        RETURN.
      ENDIF.
      lv_i = lv_i + 1.
    ENDWHILE.

  ENDMETHOD.


  METHOD unquote.

    DATA: lv_len TYPE i,
          lv_in  TYPE i.

    rv = iv.
    IF is_literal( iv ) = abap_true.
      lv_len = strlen( iv ).
      lv_in = lv_len - 2.
      rv = substring( val = iv off = 1 len = lv_in ).
    ENDIF.

  ENDMETHOD.


  METHOD is_literal.

    DATA: lv     TYPE string,
          lv_len TYPE i,
          lv_off TYPE i,
          lv_f   TYPE string,
          lv_l   TYPE string.

    rv = abap_false.
    lv = condense( iv ).
    lv_len = strlen( lv ).
    IF lv_len < 2.
      RETURN.
    ENDIF.
    lv_off = lv_len - 1.
    lv_f = substring( val = lv off = 0 len = 1 ).
    lv_l = substring( val = lv off = lv_off len = 1 ).
    IF ( lv_f = `'` AND lv_l = `'` ) OR ( lv_f = '`' AND lv_l = '`' ).
      rv = abap_true.
    ENDIF.

  ENDMETHOD.
ENDCLASS.
