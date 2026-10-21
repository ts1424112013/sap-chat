*&---------------------------------------------------------------------*
*& Report ZAI_TEST_ALV_CAPTURE
*&---------------------------------------------------------------------*
*& 用途: ALV 通用采集的现场验证(不经过 AI 助手 / 运行表 / 作业链路)
*&       对任意报表程序: SUBMIT -> 抑制 ALV 显示 -> 取回 ALV 数据, 打印结果
*& 验证顺序(建议):
*&   1) SA38/SE38 前台运行: 看「已捕获 ALV」是否为 X、列与前几行是否对
*&   2) SM36 以后台作业运行同一组参数: 作业日志/spool 里看同样的输出
*&      (线上走的是后台作业, 这一步才是真正的验收)
*& 参数怎么给: 先在目标报表里存一个变式(选择屏 -> 保存), 这里填变式名;
*&       P_SEL/P_VAL 可再覆盖一个单值参数 / 选择条件(等于)
*& 安装: SE38 新建「可执行程序(类型 1)」, 贴入本文件; 依赖 ZCL_AI_ALV_CAPTURE
*& V1.0 20261021: 首版
*&---------------------------------------------------------------------*
REPORT zai_test_alv_capture LINE-SIZE 255.

PARAMETERS: p_prog TYPE progname OBLIGATORY,
            p_vari TYPE raldb_vari,
            p_sel  TYPE c LENGTH 30,
            p_val  TYPE c LENGTH 45,
            p_skind TYPE c LENGTH 1 DEFAULT 'S',
            p_rows TYPE i DEFAULT 5.

START-OF-SELECTION.
  DATA: lt_seltab   TYPE rsparams_tt,
        ls_sel      TYPE rsparams,
        lv_captured TYPE abap_bool,
        lv_total    TYPE i,
        lt_cols     TYPE zcl_ai_alv_capture=>tt_col,
        lt_rows     TYPE string_table,
        lv_err      TYPE string,
        lv_n        TYPE i,
        lv_named    TYPE i,
        lv_line     TYPE string.

  IF p_sel IS NOT INITIAL.
    ls_sel-selname = to_upper( p_sel ).
    ls_sel-kind    = p_skind.
    ls_sel-sign    = 'I'.
    ls_sel-option  = 'EQ'.
    ls_sel-low     = p_val.
    APPEND ls_sel TO lt_seltab.
  ENDIF.

  zcl_ai_alv_capture=>run(
    EXPORTING iv_program  = p_prog
              it_seltab   = lt_seltab
              iv_variant  = p_vari
              iv_max_rows = p_rows
    IMPORTING ev_captured = lv_captured
              ev_total    = lv_total
              et_cols     = lt_cols
              et_rows     = lt_rows
              ev_error    = lv_err ).

  WRITE: / '程序:', p_prog, '  变式:', p_vari, '  后台作业:', sy-batch, '  用户:', sy-uname.
  IF lv_err IS NOT INITIAL.
    WRITE: / '【错误】', lv_err.
  ENDIF.
  WRITE: / '已捕获 ALV:', lv_captured, '  总行数:', lv_total, '  列数:', lines( lt_cols ).
  IF lv_captured = abap_false.
    WRITE: / '未捕获到 ALV 输出: 报表可能无数据 / 无权限 STOP / 提前结束,',
             '或 ALV 不走标准采集口(自建 CL_GUI_ALV_GRID); 前台运行时请留意是否弹出了 ALV'.
    RETURN.
  ENDIF.

  SKIP.
  WRITE: / '--- 列(字段名 / 列标题; 标题等于字段名 = 字段目录里没取到标题) ---'.
  LOOP AT lt_cols INTO DATA(ls_col).
    WRITE: / ls_col-name, ls_col-label.
    IF ls_col-label <> ls_col-name.
      lv_named = lv_named + 1.
    ENDIF.
  ENDLOOP.
  WRITE: / '有标题的列:', lv_named, '/', lines( lt_cols ).

  SKIP.
  WRITE: / '--- 前', p_rows, '行(JSON) ---'.
  LOOP AT lt_rows INTO lv_line.
    lv_n = lv_n + 1.
    IF lv_n > p_rows.
      EXIT.
    ENDIF.
    WRITE: / lv_line.
  ENDLOOP.
