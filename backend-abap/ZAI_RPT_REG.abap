*&---------------------------------------------------------------------*
*& Report ZAI_RPT_REG
*&---------------------------------------------------------------------*
*& 报表自动登记(10.24 记录 #03b): 扫描报表源码 → 登记草稿 → 人工确认 → 写入
*& ZAI_RPT_DEF / ZAI_RPT_PARAM。解析与写入都在 ZCL_AI_RPT_SCANNER, 这里只管界面。
*& 模式(单选):
*&   P_LIST 候选清单: 列出 Z/Y 事务码(可用 S_TCODE 过滤)、对应程序、是否已登记
*&   P_SCAN 扫描预览: 按 S_TCODE / S_PROG 扫描, 逐行显示要登记的参数、标签来源、
*&          默认值、单选组选项, 以及「不登记」的项和原因; 不写任何表
*&   P_SAVE 写入登记: 同样扫描; P_TEST = X(默认)只演练, 去掉勾才真写(写前弹窗确认)
*&          写入 = 新配置版本(R + 日期时间), 旧版本参数行保留, 改回旧版本号即可回滚
*& 调整: S_SKIP 不登记的参数名; S_FORCE 判为危险但确认要登记的参数名;
*&       P_ALIAS 程序没有事务码时用的别名(只对单个程序); P_EXEC 新报表登记后立即开放执行
*& 依赖: ZCL_AI_RPT_SCANNER V1.0b; 写入只允许 ZAI_CHAT_USER 角色 ADMIN
*& V1.0 20261024
*& V1.0a 20261027(10.27 记录 #04): 扫描预览按选择屏块分段, 每块先打一行【块】标题(需 SCANNER V1.0b)
*&---------------------------------------------------------------------*
REPORT zai_rpt_reg LINE-SIZE 255.

DATA: gv_tcode TYPE tstc-tcode,
      gv_prog  TYPE trdir-name,
      gv_pname TYPE c LENGTH 30.

SELECTION-SCREEN COMMENT /1(79) c_h1.
SELECTION-SCREEN SKIP 1.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_list RADIOBUTTON GROUP g1.
SELECTION-SCREEN COMMENT 3(70) c_list FOR FIELD p_list.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_scan RADIOBUTTON GROUP g1 DEFAULT 'X'.
SELECTION-SCREEN COMMENT 3(70) c_scan FOR FIELD p_scan.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_save RADIOBUTTON GROUP g1.
SELECTION-SCREEN COMMENT 3(70) c_save FOR FIELD p_save.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN SKIP 1.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_tc FOR FIELD s_tcode.
SELECT-OPTIONS s_tcode FOR gv_tcode.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_pg FOR FIELD s_prog.
SELECT-OPTIONS s_prog FOR gv_prog.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_alias FOR FIELD p_alias.
PARAMETERS p_alias TYPE c LENGTH 20.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_lang FOR FIELD p_lang.
PARAMETERS p_lang TYPE sy-langu DEFAULT sy-langu.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN SKIP 1.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_skip FOR FIELD s_skip.
SELECT-OPTIONS s_skip FOR gv_pname NO INTERVALS.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_force FOR FIELD s_force.
SELECT-OPTIONS s_force FOR gv_pname NO INTERVALS.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN SKIP 1.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_unreg AS CHECKBOX DEFAULT 'X'.
SELECTION-SCREEN COMMENT 3(70) c_unreg FOR FIELD p_unreg.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_exec AS CHECKBOX.
SELECTION-SCREEN COMMENT 3(70) c_exec FOR FIELD p_exec.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_maxr FOR FIELD p_maxr.
PARAMETERS p_maxr TYPE i DEFAULT 200.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_test AS CHECKBOX DEFAULT 'X'.
SELECTION-SCREEN COMMENT 3(70) c_test FOR FIELD p_test.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_h1    = '报表自动登记: 扫描报表源码 → 预览登记草稿 → 确认后写入 ZAI_RPT_DEF / PARAM'.
  c_list  = '候选清单(Z/Y 事务码 + 程序 + 是否已登记)'.
  c_scan  = '扫描预览(只看, 不写表)'.
  c_save  = '写入登记(下面「只演练」去掉勾才真写)'.
  c_tc    = '事务码'.
  c_pg    = '程序名(没有事务码时)'.
  c_alias = '事务码别名'.
  c_lang  = '标签语言'.
  c_skip  = '不登记的参数名'.
  c_force = '强制登记的参数名'.
  c_unreg = '候选清单只列还没登记的'.
  c_exec  = '新报表登记后立即开放执行(EXEC_ENABLED = X)'.
  c_maxr  = '样例行数 MAX_ROWS'.
  c_test  = '只演练不写入(先勾着跑一遍, 看清楚再去掉勾)'.

CLASS lcl_reg DEFINITION FINAL.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_job,
             tcode TYPE string,
             prog  TYPE string,
           END OF ty_job.
    TYPES tt_job TYPE STANDARD TABLE OF ty_job WITH DEFAULT KEY.
    CLASS-METHODS main.
    CLASS-METHODS candidates.
    CLASS-METHODS jobs
      RETURNING VALUE(rt) TYPE tt_job.
    CLASS-METHODS show
      IMPORTING is_draft TYPE zcl_ai_rpt_scanner=>ty_draft.
    CLASS-METHODS names
      IMPORTING it_range TYPE STANDARD TABLE
      RETURNING VALUE(rt) TYPE string_table.
    CLASS-METHODS yn
      IMPORTING iv TYPE abap_bool
      RETURNING VALUE(rv) TYPE string.
ENDCLASS.

CLASS lcl_reg IMPLEMENTATION.

  METHOD main.

    DATA: lt_job   TYPE tt_job,
          ls_job   TYPE ty_job,
          lt_force TYPE string_table,
          lt_skip  TYPE string_table,
          lt_draft TYPE STANDARD TABLE OF zcl_ai_rpt_scanner=>ty_draft WITH DEFAULT KEY,
          ls_draft TYPE zcl_ai_rpt_scanner=>ty_draft,
          ls_save  TYPE zcl_ai_rpt_scanner=>ty_save,
          lv_alias TYPE string,
          lv_ok    TYPE i,
          lv_bad   TYPE i,
          lv_ans   TYPE c LENGTH 1,
          lv_q     TYPE string.

    IF p_list = abap_true.
      candidates( ).
      RETURN.
    ENDIF.

    lt_job = jobs( ).
    IF lt_job IS INITIAL.
      WRITE: / '请在「事务码」或「程序名」里至少填一个(可以多个 / 范围)'.
      RETURN.
    ENDIF.
    lt_force = names( s_force[] ).
    lt_skip  = names( s_skip[] ).
    lv_alias = p_alias.
    IF lines( lt_job ) > 1.
      CLEAR lv_alias.
    ENDIF.

    LOOP AT lt_job INTO ls_job.
      ls_draft = zcl_ai_rpt_scanner=>scan( iv_tcode = ls_job-tcode
                                           iv_prog  = ls_job-prog
                                           iv_alias = lv_alias
                                           iv_lang  = p_lang
                                           it_force = lt_force
                                           it_skip  = lt_skip ).
      show( ls_draft ).
      APPEND ls_draft TO lt_draft.
    ENDLOOP.

    IF p_scan = abap_true.
      RETURN.
    ENDIF.

    " ---- 写入 ----
    ULINE.
    IF p_test = abap_true.
      WRITE: / '【只演练】以上草稿里「+」的行会写入; 去掉「只演练不写入」的勾再跑一次才真写。'.
      RETURN.
    ENDIF.
    IF sy-batch = abap_false.
      lv_q = |确认把 { lines( lt_draft ) } 张报表的登记草稿写入 ZAI_RPT_DEF / ZAI_RPT_PARAM?(每张报表生成新配置版本)|.
      CALL FUNCTION 'POPUP_TO_CONFIRM'
        EXPORTING
          titlebar              = '写入报表登记'
          text_question         = lv_q
          text_button_1         = '写入'
          text_button_2         = '取消'
          default_button        = '2'
          display_cancel_button = ' '
        IMPORTING
          answer                = lv_ans
        EXCEPTIONS
          text_not_found        = 1
          OTHERS                = 2.
      IF sy-subrc <> 0 OR lv_ans <> '1'.
        WRITE: / '已取消, 没有写入任何内容。'.
        RETURN.
      ENDIF.
    ENDIF.
    LOOP AT lt_draft INTO ls_draft.
      IF ls_draft-error IS NOT INITIAL.
        WRITE: / '✗', ls_draft-report_id, '跳过:', ls_draft-error.
        lv_bad = lv_bad + 1.
        CONTINUE.
      ENDIF.
      ls_save = zcl_ai_rpt_scanner=>save( is_draft        = ls_draft
                                          iv_exec_enabled = p_exec
                                          iv_max_rows     = p_maxr ).
      IF ls_save-ok = abap_true.
        WRITE: / '✓', ls_save-message.
        lv_ok = lv_ok + 1.
      ELSE.
        WRITE: / '✗', ls_draft-report_id, ls_save-message.
        lv_bad = lv_bad + 1.
      ENDIF.
    ENDLOOP.
    ULINE.
    lv_q = |写入完成: 成功 { lv_ok } 张, 失败 / 跳过 { lv_bad } 张。前端「报表执行」目录刷新一次即可看到。|.
    WRITE: / lv_q.

  ENDMETHOD.


  METHOD candidates.

    TYPES: BEGIN OF ty_tc,
             tcode TYPE tstc-tcode,
             pgmna TYPE tstc-pgmna,
           END OF ty_tc.
    DATA: lt_tc    TYPE STANDARD TABLE OF ty_tc WITH DEFAULT KEY,
          ls_tc    TYPE ty_tc,
          lv_subc  TYPE trdir-subc,
          lv_text  TYPE tstct-ttext,
          lv_ver   TYPE zai_rpt_def-config_version,
          lv_cnt   TYPE i,
          lv_reg   TYPE string,
          lv_line  TYPE string.

    SELECT tcode, pgmna FROM tstc
      WHERE tcode IN @s_tcode
        AND ( tcode LIKE 'Z%' OR tcode LIKE 'Y%' )
      ORDER BY tcode
      INTO TABLE @lt_tc
      UP TO 2000 ROWS.

    WRITE: / '事务码', 22 '程序', 64 '已登记(配置版本)', 90 '说明'.
    ULINE.
    LOOP AT lt_tc INTO ls_tc.
      CLEAR: lv_subc, lv_text, lv_ver, lv_reg.
      SELECT SINGLE subc FROM trdir WHERE name = @ls_tc-pgmna INTO @lv_subc.
      IF lv_subc <> '1'.
        CONTINUE.   " 只列可执行程序(类型 1)的事务码
      ENDIF.
      SELECT SINGLE config_version FROM zai_rpt_def WHERE tcode = @ls_tc-tcode INTO @lv_ver.
      IF sy-subrc = 0.
        IF p_unreg = abap_true.
          CONTINUE.
        ENDIF.
        lv_reg = lv_ver.
      ELSE.
        lv_reg = '—'.
      ENDIF.
      SELECT SINGLE ttext FROM tstct WHERE sprsl = @p_lang AND tcode = @ls_tc-tcode INTO @lv_text.
      WRITE: / ls_tc-tcode, 22 ls_tc-pgmna, 64 lv_reg, 90 lv_text.
      lv_cnt = lv_cnt + 1.
      IF lv_cnt >= 500.
        WRITE: / '…只显示前 500 张, 请用「事务码」缩小范围'.
        EXIT.
      ENDIF.
    ENDLOOP.
    ULINE.
    lv_line = |共 { lv_cnt } 张。把要登记的事务码填进「事务码」, 选「扫描预览」看草稿。|.
    WRITE: / lv_line.

  ENDMETHOD.


  METHOD jobs.

    DATA: lt_tc   TYPE STANDARD TABLE OF tstc-tcode WITH DEFAULT KEY,
          lv_tc   TYPE tstc-tcode,
          lt_pg   TYPE STANDARD TABLE OF trdir-name WITH DEFAULT KEY,
          lv_pg   TYPE trdir-name,
          ls_job  TYPE ty_job.

    CLEAR rt.
    IF s_tcode[] IS NOT INITIAL.
      SELECT tcode FROM tstc WHERE tcode IN @s_tcode ORDER BY tcode INTO TABLE @lt_tc UP TO 200 ROWS.
      LOOP AT lt_tc INTO lv_tc.
        CLEAR ls_job.
        ls_job-tcode = lv_tc.
        APPEND ls_job TO rt.
      ENDLOOP.
    ENDIF.
    IF s_prog[] IS NOT INITIAL.
      SELECT name FROM trdir WHERE name IN @s_prog AND subc = '1' ORDER BY name INTO TABLE @lt_pg UP TO 200 ROWS.
      LOOP AT lt_pg INTO lv_pg.
        CLEAR ls_job.
        ls_job-prog = lv_pg.
        APPEND ls_job TO rt.
      ENDLOOP.
    ENDIF.

  ENDMETHOD.


  METHOD show.

    DATA: ls_p    TYPE zcl_ai_rpt_scanner=>ty_param,
          lv_note TYPE string,
          lv_mark TYPE c LENGTH 1,
          lv_flag TYPE string,
          lv_def  TYPE string,
          lv_nin  TYPE i,
          lv_nout TYPE i,
          lv_line TYPE string,
          lv_lbl  TYPE string,
          lv_typ  TYPE string,
          lv_blk  TYPE string,
          lv_bln  TYPE string.

    ULINE.
    WRITE: / '报表', is_draft-report_id, ' 事务码', is_draft-tcode, ' 程序', is_draft-progname.
    WRITE: / '名称:', is_draft-report_name.
    IF is_draft-module IS NOT INITIAL OR is_draft-description IS NOT INITIAL.
      WRITE: / '头注释: 模块', is_draft-module, ' 用途', is_draft-description.
    ENDIF.
    IF is_draft-exists = abap_true.
      lv_line = |已登记(当前配置版本 { is_draft-cur_version }): 写入会生成新版本, 旧版本参数行保留|.
      WRITE: / lv_line.
    ELSE.
      WRITE: / '还没登记: 写入会新建登记'.
    ENDIF.
    IF is_draft-error IS NOT INITIAL.
      WRITE: / '✗ 不能写入:', is_draft-error COLOR COL_NEGATIVE.
    ENDIF.
    LOOP AT is_draft-notes INTO lv_note.
      WRITE: / '! ', lv_note.
    ENDLOOP.
    SKIP.
    WRITE: / '  种类 参数编号', 34 '选择屏名', 46 '标签(来源)', 100 '类型', 112 '必填/多值/范围', 132 '默认', 150 '选项 / 固定值 / 说明'.
    LOOP AT is_draft-params INTO ls_p.
      " V1.0a: 选择屏块变了就先打一行块标题(参数卡按块给复选框分组)
      IF ls_p-group_label <> lv_blk.
        lv_blk = ls_p-group_label.
        lv_bln = COND #( WHEN lv_blk IS INITIAL THEN `【不在块里】` ELSE |【块】{ lv_blk }| ).
        WRITE: / lv_bln COLOR COL_GROUP.
      ENDIF.
      lv_mark = COND #( WHEN ls_p-include = abap_true THEN '+' ELSE '-' ).
      lv_flag = |{ yn( ls_p-required ) }/{ yn( ls_p-multi_value ) }/{ yn( ls_p-range_allowed ) }|.
      CLEAR lv_def.
      IF ls_p-default_type IS NOT INITIAL.
        lv_def = |{ ls_p-default_type } { ls_p-default_value }|.
      ENDIF.
      lv_lbl = |{ ls_p-display_label }({ ls_p-label_src })|.
      lv_typ = |{ ls_p-data_type } { ls_p-type_length }|.
      WRITE: / lv_mark, ls_p-sel_kind, ls_p-param_id, 34 ls_p-abap_name,
               46 lv_lbl, 100 lv_typ, 112 lv_flag, 132 lv_def, 150 ls_p-allowed_ops.
      IF ls_p-note IS NOT INITIAL.
        WRITE: /12 '└', ls_p-note COLOR COL_TOTAL.
      ENDIF.
      IF ls_p-include = abap_true.
        lv_nin = lv_nin + 1.
      ELSE.
        lv_nout = lv_nout + 1.
      ENDIF.
    ENDLOOP.
    lv_line = |登记 { lv_nin } 行(+), 不登记 { lv_nout } 行(-)。种类: P 单值 / S 选择项 / R 单选组 / C 复选框 / F 固定值(不显示)|.
    WRITE: / lv_line.

  ENDMETHOD.


  METHOD names.

    FIELD-SYMBOLS: <ls_r>   TYPE any,
                   <lv_low> TYPE any.
    DATA lv TYPE string.

    CLEAR rt.
    LOOP AT it_range ASSIGNING <ls_r>.
      ASSIGN COMPONENT 'LOW' OF STRUCTURE <ls_r> TO <lv_low>.
      IF sy-subrc = 0.
        lv = <lv_low>.
        lv = to_upper( condense( lv ) ).
        IF lv IS NOT INITIAL.
          APPEND lv TO rt.
        ENDIF.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD yn.
    rv = COND #( WHEN iv = abap_true THEN `X` ELSE `-` ).
  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  lcl_reg=>main( ).
