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
*&          P_TRY = X 校验通过后按默认值真实取数一次(只读), 打印列 / 前 P_ROWS 行 /
*&          后端统计, 直接和 Fiori 页面对数
*&   P_EXP  导出: P_RID 报表编号; P_FILE 空 = 打印到屏幕, 填了 = 下载到该文件
*&   P_SELF 离线自测: 参数 → $filter / URL 编码 / 后端统计, 不调 OData, 不写表
*& JSON 格式见 backend-abap/fiori-reports/README.md, 模板 SHIPMENT.json
*& 依赖: ZCL_AI_FIORI_REPORT_SERVICE V1.0.1(ty_ack 带 uri / shape / shape_cfg)、
*&       ZCL_AI_ODATA_CLIENT / ZCL_AI_ODATA_SHAPER(及四张 ZAI_FRPT_* 表)
*& V1.0 20261020
*& V1.1 20261021: 导入回执多行显示(参数一览 / 提醒 / 按默认值预演的 $filter 与 URI);
*&      新增 P_TRY 试取一次 + P_ROWS; 选择屏幕自带中文说明(不用维护选择文本)
*&---------------------------------------------------------------------*
REPORT zai_frpt_maint LINE-SIZE 255.

DATA: gt_files TYPE filetable,
      gs_file  TYPE file_table,
      gv_rc    TYPE i.

SELECTION-SCREEN COMMENT /1(79) c_h1.
SELECTION-SCREEN SKIP 1.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_list RADIOBUTTON GROUP g1 DEFAULT 'X'.
SELECTION-SCREEN COMMENT 3(70) c_list FOR FIELD p_list.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_imp RADIOBUTTON GROUP g1.
SELECTION-SCREEN COMMENT 3(70) c_imp FOR FIELD p_imp.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_exp RADIOBUTTON GROUP g1.
SELECTION-SCREEN COMMENT 3(70) c_exp FOR FIELD p_exp.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_self RADIOBUTTON GROUP g1.
SELECTION-SCREEN COMMENT 3(70) c_self FOR FIELD p_self.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN SKIP 1.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_file FOR FIELD p_file.
PARAMETERS p_file TYPE localfile VISIBLE LENGTH 58 LOWER CASE.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_rid FOR FIELD p_rid.
PARAMETERS p_rid TYPE c LENGTH 30.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN SKIP 1.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_test AS CHECKBOX DEFAULT 'X'.
SELECTION-SCREEN COMMENT 3(70) c_test FOR FIELD p_test.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_try AS CHECKBOX DEFAULT 'X'.
SELECTION-SCREEN COMMENT 3(70) c_try FOR FIELD p_try.
SELECTION-SCREEN END OF LINE.
SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(20) c_rows FOR FIELD p_rows.
PARAMETERS p_rows TYPE i DEFAULT 10.
SELECTION-SCREEN END OF LINE.

INITIALIZATION.
  c_h1   = 'Fiori 报表登记维护(格式见 backend-abap/fiori-reports/README.md)'.
  c_list = '列出已登记报表'.
  c_imp  = '导入登记 JSON(选下面的文件)'.
  c_exp  = '导出登记 JSON(填报表编号; 不选文件 = 打印到屏幕)'.
  c_self = '离线自测($filter / URL 编码 / 统计, 不调 OData)'.
  c_file = 'JSON 文件(F4 选)'.
  c_rid  = '报表编号(导出用)'.
  c_test = '只校验不保存(先勾着跑, 没问题再去掉勾保存)'.
  c_try  = '导入校验通过后按默认值试取一次(只读)'.
  c_rows = '试取打印前几行'.

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
    CLASS-METHODS try_fetch
      IMPORTING is_ack TYPE zcl_ai_fiori_report_service=>ty_ack.
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

    WRITE: / '文件:', lv_file.
    ls_ack = zcl_ai_fiori_report_service=>save_def_json( iv_json = lv_json iv_test = p_test ).
    IF ls_ack-error IS NOT INITIAL.
      WRITE: / '导入失败(未保存), 按下面逐条改 JSON 后再导入:' COLOR COL_NEGATIVE.
      write_lines( ls_ack-error ).
      RETURN.
    ENDIF.

    SKIP.
    write_lines( ls_ack-message ).
    SKIP.
    IF p_test = abap_true.
      WRITE: / '这是测试运行(未保存)。核对无误后去掉「只校验不保存」的勾, 再执行一次才会保存。' COLOR COL_TOTAL.
    ELSE.
      WRITE: / '已写入 ZAI_FRPT_DEF / ZAI_FRPT_PARAM。FIORI_ENABLED = X 且 active = X 时, 前端「Fiori 报表」目录可见。' COLOR COL_POSITIVE.
    ENDIF.

    IF p_try = abap_true.
      IF ls_ack-uri IS INITIAL.
        SKIP.
        WRITE: / '试取跳过: 默认值不全(见上面"没法预演"), 补上默认值, 或保存后到前端填参数取数。'.
      ELSE.
        try_fetch( ls_ack ).
      ENDIF.
    ENDIF.

  ENDMETHOD.

  METHOD try_fetch.

    DATA: ls_resp TYPE zcl_ai_odata_client=>ty_response,
          ls_ds   TYPE zcl_ai_odata_shaper=>ty_dataset,
          ls_col  TYPE zcl_ai_odata_shaper=>ty_column,
          ls_row  TYPE zcl_ai_odata_shaper=>ty_row,
          lv_line TYPE string,
          lv_cell TYPE string,
          lv_head TYPE string,
          lv_n    TYPE i.

    SKIP.
    WRITE: / '==== 试取一次(按默认值, 只读, 不写表) ===='.
    WRITE: / '用户:', sy-uname, '  客户端:', sy-mandt.
    ls_resp = zcl_ai_odata_client=>get( iv_uri = is_ack-uri iv_timeout = 120 iv_max_bytes = 104857600 ).
    WRITE: / 'HTTP:', ls_resp-http_code, ls_resp-reason.
    WRITE: / '耗时(毫秒):', ls_resp-elapsed_ms, '  字节:', ls_resp-bytes, '  通道:', ls_resp-channel.
    lv_n = strlen( ls_resp-body ).
    IF lv_n > 2000.
      lv_n = 2000.
    ENDIF.
    IF lv_n > 0.
      lv_head = substring( val = ls_resp-body len = lv_n ).
    ENDIF.
    IF ls_resp-error IS NOT INITIAL.
      WRITE: / '取数失败:' COLOR COL_NEGATIVE.
      write_lines( ls_resp-error ).
      IF lv_head IS NOT INITIAL.
        WRITE: / '响应开头(前 2000 字符):'.
        write_lines( lv_head ).
      ENDIF.
      RETURN.
    ENDIF.

    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = ls_resp-body iv_shape = is_ack-shape iv_cfg = is_ack-shape_cfg ).
    IF ls_ds-error IS NOT INITIAL.
      WRITE: / '转换失败(检查 shape / shapeCfg):' COLOR COL_NEGATIVE.
      write_lines( ls_ds-error ).
      WRITE: / '响应开头(前 2000 字符):'.
      write_lines( lv_head ).
      RETURN.
    ENDIF.

    lv_n = lines( ls_ds-rows ).
    WRITE: / '行数:', lv_n, '  总行数:', ls_ds-total, '  截断:', ls_ds-truncated.
    WRITE: / '列(名称 / 标签 / 数值列):'.
    LOOP AT ls_ds-columns INTO ls_col.
      lv_line = |  { ls_col-name } / { ls_col-label } / { ls_col-is_numeric }|.
      write_lines( lv_line ).
    ENDLOOP.
    WRITE: / '前', p_rows, '行:'.
    LOOP AT ls_ds-rows INTO ls_row.
      IF sy-tabix > p_rows.
        EXIT.
      ENDIF.
      CLEAR lv_line.
      LOOP AT ls_row-cells INTO lv_cell.
        lv_line = lv_line && lv_cell && ` | `.
      ENDLOOP.
      write_lines( lv_line ).
    ENDLOOP.
    SKIP.
    WRITE: / '后端统计(和 Fiori 页面对合计 / 占比):'.
    write_lines( zcl_ai_fiori_report_service=>compute_stats( ls_ds ) ).

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
