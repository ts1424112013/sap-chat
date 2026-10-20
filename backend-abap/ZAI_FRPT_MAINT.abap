*&---------------------------------------------------------------------*
*& Report ZAI_FRPT_MAINT
*&---------------------------------------------------------------------*
*& Fiori 报表登记维护(ZAI_FRPT_DEF / ZAI_FRPT_PARAM)
*& 为什么不用 SM30: SHAPE_CFG / ENUM_JSON 是 STRING 字段, 表维护生成器不支持;
*& 这里改成"一张报表一个 JSON 文件"导入 / 导出, 导入时整份校验
*& (ZCL_AI_FIORI_REPORT_SERVICE=>save_def_json, 只有 ZAI_CHAT_USER 角色 ADMIN 能保存)
*& 模式(单选):
*&   P_LIST 列出已登记报表
*&   P_IMP  导入: P_FILE 选 JSON 文件; P_TEST = X 只校验不保存(先跑一遍再去掉勾)
*&   P_EXP  导出: P_RID 报表编号; P_FILE 空 = 打印到屏幕, 填了 = 下载到该文件
*&   P_SELF 离线自测: 参数 → $filter / URL 编码 / 后端统计, 不调 OData, 不写表
*& JSON 格式见 backend-abap/fiori-reports/README.md, 模板 SHIPMENT.json
*& 依赖: ZCL_AI_FIORI_REPORT_SERVICE V1.0(及四张 ZAI_FRPT_* 表)
*& V1.0 20261020
*&---------------------------------------------------------------------*
REPORT zai_frpt_maint LINE-SIZE 255.

DATA: gt_files TYPE filetable,
      gs_file  TYPE file_table,
      gv_rc    TYPE i.

PARAMETERS: p_list RADIOBUTTON GROUP g1 DEFAULT 'X',
            p_imp  RADIOBUTTON GROUP g1,
            p_exp  RADIOBUTTON GROUP g1,
            p_self RADIOBUTTON GROUP g1,
            p_file TYPE localfile LOWER CASE,
            p_rid  TYPE c LENGTH 30,
            p_test AS CHECKBOX DEFAULT 'X'.

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file.
  CLEAR: gt_files, gv_rc.
  cl_gui_frontend_services=>file_open_dialog(
    EXPORTING  window_title      = 'Fiori 报表登记 JSON'
               default_extension = 'json'
               file_filter       = 'JSON (*.json)|*.json|All (*.*)|*.*'
    CHANGING   file_table        = gt_files
               rc                = gv_rc
    EXCEPTIONS OTHERS            = 1 ).
  IF sy-subrc = 0.
    READ TABLE gt_files INTO gs_file INDEX 1.
    IF sy-subrc = 0.
      p_file = gs_file-filename.
    ENDIF.
  ENDIF.

CLASS lcl_m DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-DATA: gv_pass TYPE i,
                gv_fail TYPE i.
    CLASS-METHODS list.
    CLASS-METHODS import.
    CLASS-METHODS export.
    CLASS-METHODS selftest.
    CLASS-METHODS check
      IMPORTING iv_name TYPE string
                iv_ok   TYPE abap_bool
                iv_info TYPE string OPTIONAL.
    CLASS-METHODS write_lines
      IMPORTING iv_text TYPE string.
ENDCLASS.

CLASS lcl_m IMPLEMENTATION.

  METHOD list.

    DATA lv_cnt TYPE i.
    SELECT report_id, report_name, category, shape, analyze_enabled, active
      FROM zai_frpt_def
      ORDER BY category, sort_no, report_id
      INTO TABLE @DATA(lt_def).
    IF lt_def IS INITIAL.
      WRITE: / '还没有登记报表。用 P_IMP 导入 backend-abap/fiori-reports/ 里的 JSON。'.
      RETURN.
    ENDIF.
    WRITE: / '报表编号', 32 '分类', 50 '形状', 58 '分析', 64 '启用', 70 '参数', 76 '报表名'.
    ULINE.
    LOOP AT lt_def INTO DATA(ls_d).
      SELECT COUNT(*) FROM zai_frpt_param WHERE report_id = @ls_d-report_id INTO @lv_cnt.
      WRITE: / ls_d-report_id, 32 ls_d-category(16), 50 ls_d-shape, 58 ls_d-analyze_enabled,
               64 ls_d-active, 70 lv_cnt LEFT-JUSTIFIED, 76 ls_d-report_name.
    ENDLOOP.

  ENDMETHOD.

  METHOD import.

    DATA: lt_lines TYPE string_table,
          lv_file  TYPE string,
          lv_json  TYPE string,
          lv_off   TYPE i,
          ls_ack   TYPE zcl_ai_fiori_report_service=>ty_ack.

    IF p_file IS INITIAL.
      WRITE: / '请先在 P_FILE 选择 JSON 文件(F4)'.
      RETURN.
    ENDIF.
    lv_file = p_file.
    cl_gui_frontend_services=>gui_upload(
      EXPORTING  filename = lv_file
                 filetype = 'ASC'
                 codepage = '4110'
      CHANGING   data_tab = lt_lines
      EXCEPTIONS OTHERS   = 1 ).
    IF sy-subrc <> 0.
      WRITE: / '读取文件失败:', lv_file COLOR COL_NEGATIVE.
      RETURN.
    ENDIF.
    CONCATENATE LINES OF lt_lines INTO lv_json SEPARATED BY cl_abap_char_utilities=>newline.
    " 去掉 UTF-8 BOM 等文件头: 从第一个 { 开始
    lv_off = find( val = lv_json sub = '{' ).
    IF lv_off > 0.
      lv_json = substring( val = lv_json off = lv_off ).
    ENDIF.

    ls_ack = zcl_ai_fiori_report_service=>save_def_json( iv_json = lv_json iv_test = p_test ).
    IF ls_ack-error IS NOT INITIAL.
      WRITE: / '导入失败(未保存):' COLOR COL_NEGATIVE.
      write_lines( ls_ack-error ).
    ELSE.
      WRITE: / ls_ack-message COLOR COL_POSITIVE.
      IF p_test = abap_true.
        WRITE: / '这是测试运行。确认无误后去掉 P_TEST 的勾再执行一次才会保存。'.
      ENDIF.
    ENDIF.

  ENDMETHOD.

  METHOD export.

    DATA: lt_lines TYPE string_table,
          lv_json  TYPE string,
          lv_file  TYPE string,
          lv_rid   TYPE string.

    lv_rid = p_rid.
    IF lv_rid IS INITIAL.
      WRITE: / '请在 P_RID 填报表编号'.
      RETURN.
    ENDIF.
    lv_json = zcl_ai_fiori_report_service=>export_def_json( lv_rid ).
    IF lv_json IS INITIAL.
      WRITE: / '没有这张报表:', lv_rid COLOR COL_NEGATIVE.
      RETURN.
    ENDIF.
    SPLIT lv_json AT cl_abap_char_utilities=>newline INTO TABLE lt_lines.
    IF p_file IS INITIAL.
      write_lines( lv_json ).
      RETURN.
    ENDIF.
    lv_file = p_file.
    cl_gui_frontend_services=>gui_download(
      EXPORTING  filename = lv_file
                 filetype = 'ASC'
                 codepage = '4110'
      CHANGING   data_tab = lt_lines
      EXCEPTIONS OTHERS   = 1 ).
    IF sy-subrc = 0.
      WRITE: / '已下载到', lv_file COLOR COL_POSITIVE.
    ELSE.
      WRITE: / '下载失败:', lv_file COLOR COL_NEGATIVE.
    ENDIF.

  ENDMETHOD.

  METHOD selftest.

    DATA: lt_par    TYPE zcl_ai_fiori_report_service=>tt_param,
          ls_par    TYPE zai_frpt_param,
          lt_val    TYPE zcl_ai_odata_shaper=>tt_kv,
          ls_val    TYPE zcl_ai_odata_shaper=>ty_kv,
          ls_ds     TYPE zcl_ai_odata_shaper=>ty_dataset,
          lv_filter TYPE string,
          lv_err    TYPE string,
          lv_exp    TYPE string,
          lv_json   TYPE string,
          lv_v      TYPE string.

    WRITE: / '==== 离线自测(不调 OData, 不写表) ===='.

    " SITE: CHAR 4, 多值, IN;  DATE: 范围, BT2(BegDat / EndDat), DATETIME
    CLEAR ls_par.
    ls_par-param_id = 'SITE'. ls_par-display_label = 'site'. ls_par-data_type = 'CHAR'.
    ls_par-type_length = 4. ls_par-multi_value = 'X'. ls_par-odata_prop = 'Site'.
    ls_par-filter_op = 'IN'. ls_par-value_fmt = 'STRING'. ls_par-active = 'X'.
    APPEND ls_par TO lt_par.
    CLEAR ls_par.
    ls_par-param_id = 'DATE'. ls_par-display_label = '日期区间'. ls_par-data_type = 'DATE'.
    ls_par-type_length = 8. ls_par-required = 'X'. ls_par-range_allowed = 'X'.
    ls_par-odata_prop = 'BegDat'. ls_par-odata_prop_to = 'EndDat'. ls_par-filter_op = 'BT2'.
    ls_par-value_fmt = 'DATETIME'. ls_par-active = 'X'.
    APPEND ls_par TO lt_par.

    CLEAR lt_val.
    ls_val-name = 'SITE'. ls_val-value = 'HHZZ, HHCD'. APPEND ls_val TO lt_val.
    ls_val-name = 'DATE'. ls_val-value = '20261015,20261015'. APPEND ls_val TO lt_val.
    zcl_ai_fiori_report_service=>build_filter( EXPORTING it_params = lt_par it_values = lt_val
                                               IMPORTING ev_filter = lv_filter ev_error = lv_err ).
    lv_exp = `(Site eq 'HHZZ' or Site eq 'HHCD') and BegDat ge datetime'2026-10-15T00:00:00' and ` &&
             `EndDat le datetime'2026-10-15T00:00:00'`.
    check( iv_name = 'build_filter IN + BT2' iv_ok = xsdbool( lv_err IS INITIAL AND lv_filter = lv_exp ) iv_info = lv_filter && lv_err ).

    CLEAR lt_val.
    ls_val-name = 'SITE'. ls_val-value = `HH'Z`. APPEND ls_val TO lt_val.
    ls_val-name = 'DATE'. ls_val-value = '20261001,20261031'. APPEND ls_val TO lt_val.
    zcl_ai_fiori_report_service=>build_filter( EXPORTING it_params = lt_par it_values = lt_val
                                               IMPORTING ev_filter = lv_filter ev_error = lv_err ).
    check( iv_name = 'build_filter 单引号写成两个' iv_ok = xsdbool( find( val = lv_filter sub = `Site eq 'HH''Z'` ) = 0 ) iv_info = lv_filter ).

    CLEAR lt_val.
    ls_val-name = 'SITE'. ls_val-value = 'HHZZZ'. APPEND ls_val TO lt_val.
    zcl_ai_fiori_report_service=>build_filter( EXPORTING it_params = lt_par it_values = lt_val
                                               IMPORTING ev_filter = lv_filter ev_error = lv_err ).
    check( iv_name = 'build_filter 超长拒绝 + 必填缺失'
           iv_ok = xsdbool( find( val = lv_err sub = `超过 4 位` ) >= 0 AND find( val = lv_err sub = `必填` ) >= 0 )
           iv_info = lv_err ).

    CLEAR lt_val.
    ls_val-name = 'DATE'. ls_val-value = '20260231'. APPEND ls_val TO lt_val.
    zcl_ai_fiori_report_service=>build_filter( EXPORTING it_params = lt_par it_values = lt_val
                                               IMPORTING ev_filter = lv_filter ev_error = lv_err ).
    check( iv_name = 'build_filter 无效日期 20260231' iv_ok = xsdbool( find( val = lv_err sub = `不是有效日期` ) >= 0 ) iv_info = lv_err ).

    lv_v = zcl_ai_fiori_report_service=>url_encode( `Site eq 'A B'` ).
    check( iv_name = 'url_encode' iv_ok = xsdbool( lv_v = `Site%20eq%20%27A%20B%27` ) iv_info = lv_v ).
    lv_v = zcl_ai_fiori_report_service=>url_encode( `出货` ).
    check( iv_name = 'url_encode 中文按 UTF-8' iv_ok = xsdbool( lv_v = `%E5%87%BA%E8%B4%A7` ) iv_info = lv_v ).

    lv_json = `{"d":{"results":[` &&
              `{"Name":"SHMODE","Description":"Ship Mode","Position":"1","DynamicDataSet":{"results":[{"Value":"D"},{"Value":"C"}]}},` &&
              `{"Name":"202610","Description":"2026-10","Position":"2","DynamicDataSet":{"results":[{"Value":"     139418"},{"Value":"      33390"}]}}` &&
              `]}}`.
    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = lv_json iv_shape = `PIVOT` iv_cfg = `` ).
    lv_v = zcl_ai_fiori_report_service=>compute_stats( ls_ds ).
    check( iv_name = 'compute_stats 合计 172808 / 最大 D / 占比 80.68'
           iv_ok = xsdbool( find( val = lv_v sub = `"sum":172808.00` ) >= 0 AND find( val = lv_v sub = `"maxAt":"D"` ) >= 0
                            AND find( val = lv_v sub = `"share":80.68` ) >= 0 )
           iv_info = lv_v ).

    SKIP.
    IF gv_fail = 0.
      WRITE: / '全部通过:', gv_pass, '项' COLOR COL_POSITIVE.
    ELSE.
      WRITE: / '失败:', gv_fail, '项 / 通过:', gv_pass, '项' COLOR COL_NEGATIVE.
    ENDIF.

  ENDMETHOD.

  METHOD check.
    IF iv_ok = abap_true.
      gv_pass = gv_pass + 1.
      WRITE: / '[通过]', iv_name.
    ELSE.
      gv_fail = gv_fail + 1.
      WRITE: / '[失败]' COLOR COL_NEGATIVE, iv_name.
      IF iv_info IS NOT INITIAL.
        write_lines( iv_info ).
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD write_lines.

    DATA: lt_l   TYPE string_table,
          lv_l   TYPE string,
          lv_len TYPE i,
          lv_off TYPE i,
          lv_n   TYPE i,
          lv_seg TYPE string.

    SPLIT iv_text AT cl_abap_char_utilities=>newline INTO TABLE lt_l.
    LOOP AT lt_l INTO lv_l.
      lv_len = strlen( lv_l ).
      lv_off = 0.
      IF lv_len = 0.
        WRITE: /.
      ENDIF.
      WHILE lv_off < lv_len.
        lv_n = lv_len - lv_off.
        IF lv_n > 200.
          lv_n = 200.
        ENDIF.
        lv_seg = substring( val = lv_l off = lv_off len = lv_n ).
        WRITE: / '  ', lv_seg.
        lv_off = lv_off + lv_n.
      ENDWHILE.
    ENDLOOP.

  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  CASE abap_true.
    WHEN p_list.
      lcl_m=>list( ).
    WHEN p_imp.
      lcl_m=>import( ).
    WHEN p_exp.
      lcl_m=>export( ).
    WHEN p_self.
      lcl_m=>selftest( ).
  ENDCASE.
