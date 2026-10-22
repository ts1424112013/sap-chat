*&---------------------------------------------------------------------*
*& Report ZRMM_IDP_0702
*&---------------------------------------------------------------------*
*&
*&---------------------------------------------------------------------*
REPORT zrmm_idp_0702 .

TABLES:zidpmm455,zidppp009.

DATA: BEGIN OF input OCCURS 0,
        werks     LIKE zidpmm455-werks,
        model     LIKE zidpmm455-model,
        config    LIKE zidpmm455-config,
        mih       LIKE zidpmm455-mih,
        mih_day   LIKE zidpmm455-mih_day,
        mih_dayin LIKE zidpmm455-mih_dayin,
        uname     LIKE zidpmm455-uname,
        datum     LIKE zidpmm455-datum,
        uzeit     LIKE zidpmm455-uzeit,
        mess(50),
      END OF input.

DATA:BEGIN OF lt_data OCCURS 0,
       sel,
       werks     LIKE zidpmm455-werks,
       model     LIKE zidpmm455-model,
       config    LIKE zidpmm455-config,
       mih       LIKE zidpmm455-mih,
       mih_day   LIKE zidpmm455-mih_day,
       mih_dayin LIKE zidpmm455-mih_dayin,
       uname     LIKE zidpmm455-uname,
       datum     LIKE zidpmm455-datum,
       uzeit     LIKE zidpmm455-uzeit,
       mess(50)  TYPE c,
     END OF lt_data.

DATA ls_data LIKE  lt_data.

DATA: ls_layout TYPE slis_layout_alv.

DATA: fieldcat    TYPE slis_t_fieldcat_alv,
      fieldcat_ln LIKE LINE OF fieldcat.

DATA: l_repid TYPE sy-repid.

DATA: lt_werksV TYPE RANGE OF zidpmm455-werks.
DATA ls_werksV LIKE LINE OF lt_werksV.

DATA: lt_disDele TYPE c.

DATA lt_seDatamodel TYPE RANGE OF zidpmm455-model.


DATA lt_zidpmmcontrol TYPE zidpmmcontrol.
**判断重复参数

DATA:loc_answer3(1) TYPE c.
*
*DATA:sel  TYPE c,
*     scbi TYPE char4.

PARAMETERS: p1 RADIOBUTTON GROUP rad1 USER-COMMAND uc.

PARAMETERS p_file LIKE rlgrap-filename OBLIGATORY DEFAULT 'D:\'.
SELECTION-SCREEN SKIP 1.

PARAMETERS: p2 RADIOBUTTON GROUP rad1 DEFAULT 'X' .

PARAMETERS : werks_i TYPE zidpmm455-werks   . "销售订单类型
SELECT-OPTIONS: model_i FOR zidpmm455-model . "物料

PARAMETERS: p3 RADIOBUTTON GROUP rad1.
* AI 采集通道(20261009 V1.1): NO-DISPLAY 界面零变化; 真实作业适配器专用
PARAMETERS: p_aicap TYPE c NO-DISPLAY DEFAULT ''.
PARAMETERS: p_runid TYPE c LENGTH 32 NO-DISPLAY DEFAULT ''.

PARAMETERS : werks1_i TYPE zidpmm455-werks . "订单创建日期
SELECT-OPTIONS: model1_i FOR zidpmm455-model. "订单交货日期


SELECTION-SCREEN BEGIN OF LINE.
  SELECTION-SCREEN PUSHBUTTON 3(30) but USER-COMMAND cli.
SELECTION-SCREEN END OF LINE.

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file.
  PERFORM get_file USING p_file.


AT SELECTION-SCREEN.
  IF sy-ucomm = 'CLI'.
    PERFORM open_format.
  ENDIF.

INITIALIZATION.
  IF sy-langu = 'E'.
    but = 'Upload Format'.
  ELSE.
    but = '上傳模板'.
  ENDIF.



*进行单选按钮时进行
START-OF-SELECTION.
  IF p1 = 'X'.
    CLEAR:fieldcat.
    PERFORM get_data_from_file USING   p_file.
    PERFORM process_data.
    PERFORM alv_selectData.
  ENDIF.

  IF p2 = 'X'.
    CLEAR:fieldcat.
    IF werks_i IS INITIAL.
      MESSAGE  '請輸入工廠欄位' TYPE 'S' DISPLAY LIKE 'E'.
    ELSE.
      PERFORM selectData.
      " AI 采集通道(20261009 V1.1): 结果落 ZAI_RPT_RESULT 后仍走原 ALV
      " (后台作业时 ALV 输出进 spool, 不影响; 采集失败不中断报表)
      IF p_aicap = 'X'.
        PERFORM ai_capture USING p_runid.
      ENDIF.
      PERFORM alv_selectData.
    ENDIF.
  ENDIF.

  IF p3 = 'X' .
*    screen-required = '2'.
    CLEAR:fieldcat.
    lt_disDele = 'X'.
**    创建复选框
    fieldcat_ln-fieldname = 'SEL'.
    fieldcat_ln-seltext_l = '复选框'.
   fieldcat_ln-checkbox = 'X'.
    fieldcat_ln-edit = 'X'.
    fieldcat_ln-key = 'X'.
    APPEND fieldcat_ln TO fieldcat.
    CLEAR: fieldcat_ln.

*    滿足刪除條件所輸的邏輯
    IF werks1_i IS INITIAL.
      MESSAGE  '請輸入工廠欄位' TYPE 'S' DISPLAY LIKE 'E'.
    ELSE.
* 根据输入的工厂进行查询
      PERFORM selectData.
      PERFORM alv_selectData.
    ENDIF.
  ENDIF.



FORM selectData.
  CLEAR lt_werksV.
  IF werks1_i  IS NOT INITIAL OR werks_i IS NOT INITIAL.
    IF p2 = 'X'.
      ls_werksV-low = werks_i.
      lt_seDatamodel = model_i[].
    ELSE.
      ls_werksV-low = werks1_i.
      lt_seDatamodel = model1_i[].
    ENDIF.
    ls_werksV-sign = 'I'.
    ls_werksV-option = 'EQ'.
    APPEND ls_werksV TO lt_werksV.
    CLEAR ls_werksV.
  ENDIF.

  SELECT uzeit datum uname mih_dayin mih_day mih  config model werks
    INTO CORRESPONDING FIELDS OF TABLE lt_data
  FROM zidpmm455
  WHERE werks IN lt_werksV
  AND model IN lt_seDatamodel.
  SORT lt_data BY werks model  config.
ENDFORM.

FORM alv_selectData.
  PERFORM frm_fill_fieldcat.
* 设置 ALV 布局
  ls_layout-colwidth_optimize = 'X'.
  ls_layout-zebra = 'X'.
  IF p3 = 'X' AND lt_disDele = 'X'.
    CALL FUNCTION 'REUSE_ALV_GRID_DISPLAY'
      EXPORTING
        i_callback_program       = l_repid
        it_fieldcat              = fieldcat
        i_default                = 'X'
        i_save                   = 'A'
        is_layout                = ls_layout
        i_callback_pf_status_set = 'STATUS_100'
        i_callback_user_command  = 'COMD2000'
      TABLES
        t_outtab                 = lt_data.
  ELSEIF p1 = 'X'.
    CALL FUNCTION 'REUSE_ALV_GRID_DISPLAY'
      EXPORTING
        i_callback_program = l_repid
        it_fieldcat        = fieldcat
        is_layout          = ls_layout
        i_default          = 'X'
        i_save             = 'A'
      TABLES
        t_outtab           = input
      EXCEPTIONS
        program_error      = 1
        OTHERS             = 2.
  ELSE.
    CALL FUNCTION 'REUSE_ALV_GRID_DISPLAY'
      EXPORTING
        i_callback_program = l_repid
        it_fieldcat        = fieldcat
        is_layout          = ls_layout
        i_default          = 'X'
        i_save             = 'A'
      TABLES
        t_outtab           = lt_data
      EXCEPTIONS
        program_error      = 1
        OTHERS             = 2.
  ENDIF.
  CLEAR lt_disDele.
ENDFORM.


FORM frm_fill_fieldcat.
  DATA: c TYPE i.
  l_repid = sy-repid.
  DEFINE add_field.
    c = c + 1.
    fieldcat_ln-fieldname = &1.
    fieldcat_ln-outputlen = &2.
    fieldcat_ln-seltext_l = &3.
    fieldcat_ln-col_pos = c.
    fieldcat_ln-just = 'L'.
    APPEND fieldcat_ln TO fieldcat.
    CLEAR: fieldcat_ln.

  end-of-definition.
  add_field 'WERKS' '' '工廠'.
  add_field 'MODEL' '' '機種'.
  add_field 'CONFIG'  '' 'config'.
  add_field 'MIH'   '' 'MIH 需求'.
  add_field 'MIH_DAY'   '' 'MIH Day'.
  add_field 'MIH_DAYIN'   '' 'MIH Day(對內)'.
  add_field 'UNAME'  '' '維護人'.
  add_field 'DATUM' '' '維護日期'.
  add_field 'UZEIT'   '' '維護時間'.
  IF p1 = 'X'.
    add_field 'MESS'   '' 'Message'.
  ENDIF.
ENDFORM.

FORM status_100 USING rt_extab TYPE slis_t_extab.
  SET PF-STATUS '2000'.
ENDFORM.

DATA:gv_grid TYPE REF TO cl_gui_alv_grid.
DATA:loc_answer(1) TYPE c.
DATA:lv_delTem   TYPE string,
     lv_delTitle TYPE string,
     lv_delYes   TYPE string,
     lv_delNo    TYPE string.

FORM comd2000 USING ok_code LIKE sy-ucomm
     wa_selfield TYPE slis_selfield.

  CASE ok_code.
    WHEN 'SELECTALL'.

      PERFORM select_all.
      CALL FUNCTION 'GET_GLOBALS_FROM_SLVC_FULLSCR'
        IMPORTING
          e_grid = gv_grid.
      CALL METHOD gv_grid->check_changed_data.
      CALL METHOD gv_grid->refresh_table_display.

    WHEN 'REVERSE'.

      PERFORM reverse.
      CALL FUNCTION 'GET_GLOBALS_FROM_SLVC_FULLSCR'
        IMPORTING
          e_grid = gv_grid.
      CALL METHOD gv_grid->check_changed_data.
      CALL METHOD gv_grid->refresh_table_display.

    WHEN 'DELETE'.
      IF sy-langu = 'M'.
        lv_delTem = '是否確定刪除數據'.
        lv_delTitle = '確認刪除'.
        lv_delYes = '是'.
        lv_delNo = '否'.
      ELSE.
        lv_delTem = 'Delete Upload Demand list'.
        lv_delTitle = 'Confirm'.
        lv_delYes = 'YES'.
        lv_delNo = 'NO'.
      ENDIF.
      CALL FUNCTION 'GET_GLOBALS_FROM_SLVC_FULLSCR'
        IMPORTING
          e_grid = gv_grid.
      CALL METHOD gv_grid->check_changed_data.
      CALL METHOD gv_grid->refresh_table_display.
      CALL FUNCTION 'POPUP_TO_CONFIRM'
        EXPORTING
          titlebar              = lv_delTitle
          text_question         = lv_delTem
          text_button_1         = lv_delYes
          text_button_2         = lv_delNo
          default_button        = '1'
          display_cancel_button = 'X'
          start_column          = 25
          start_row             = 6
        IMPORTING
          answer                = loc_answer.
      IF loc_answer = '1'.
        CLEAR lt_disDele.
        PERFORM delete.
        LEAVE TO SCREEN 0.
      ENDIF.
  ENDCASE.
ENDFORM.

FORM select_all.
  LOOP AT lt_data WHERE sel = ''.
    lt_data-sel = 'X'.
    MODIFY lt_data.
    CLEAR lt_data.
  ENDLOOP.
*  perform del_alv.
ENDFORM.

FORM reverse.
  LOOP AT lt_data.
    lt_data-sel = ''.
    MODIFY lt_data.
    CLEAR lt_data.
  ENDLOOP.
*  perform  delete.
ENDFORM.                    " REVERSE
*


FORM delete.
  DATA: out_del TYPE zidpmm455 OCCURS 0 WITH HEADER LINE.
  DATA:ls_out_del TYPE zidpmm455 OCCURS 0 WITH HEADER LINE.
  DATA:ls_werksRole TYPE zidppp009-werks.
*  data: g_emplyee_id(20) type c.
*  get parameter id 'ZLG' field g_emplyee_id.
  CLEAR:lt_data,out_del.

  SELECT SINGLE werks FROM Zidppp009 INTO ls_werksRole
   WHERE  tcode = 'ZDPMM702'
    AND fir_account = sy-uname
    AND werks IN ( werks1_i,'ALL' ) .

  IF  sy-subrc <> 0.
    MESSAGE i004(zmm) WITH '您没有删除该工廠的权限'(010).
    EXIT.
  ENDIF.




  LOOP AT lt_data WHERE sel = 'X'.
    MOVE-CORRESPONDING lt_data TO out_del.
    APPEND out_del.
  ENDLOOP.
  IF out_del[] IS INITIAL.
    IF sy-langu = 'E'.
      MESSAGE i004(zmm) WITH 'Please select the data to be deleted'.
    ELSE.
      MESSAGE i004(zmm) WITH '請選擇需要刪除的數據'.
    ENDIF.
    EXIT.
  ELSE.
*    循环选择的删除
    LOOP AT lt_data.
      IF lt_data-sel = 'X'.
        DELETE FROM zidpmm455 WHERE  werks = lt_data-werks  AND model = lt_data-model AND config = lt_data-config.
        IF sy-subrc = 0.
          IF sy-langu = 'M'.
            lt_data-mess = '删除成功'.
            APPEND lt_data.
          ELSE.
            lt_data-mess = 'Delete successfully!'.
            APPEND lt_data.
          ENDIF.
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDIF.

  DELETE lt_data WHERE sel = 'X' AND mess = ''.
  SORT lt_data BY werks model  config.
  CLEAR:fieldcat,fieldcat_ln.
  fieldcat_ln-fieldname = 'mess'.
  fieldcat_ln-seltext_l = 'Message'.
  APPEND fieldcat_ln TO fieldcat.
  CLEAR: fieldcat_ln.
  PERFORM alv_selectData.

ENDFORM.



FORM get_data_from_file USING    l_file.
  DATA intern TYPE STANDARD TABLE OF alsmex_tabline WITH HEADER LINE.
  FIELD-SYMBOLS:<fs>.
  CALL FUNCTION 'ALSM_EXCEL_TO_INTERNAL_TABLE'
    EXPORTING
      filename                = l_file
      i_begin_col             = 1
      i_begin_row             = 2
      i_end_col               = 255
      i_end_row               = 65336
    TABLES
      intern                  = intern
    EXCEPTIONS
      inconsistent_parameters = 1
      upload_ole              = 2
      OTHERS                  = 3.
  IF sy-subrc <> 0.
    IF sy-langu = 'E'.
      MESSAGE i000(zpp) WITH 'Upload failure,' 'pls adjust upload format'.
    ELSE.
      MESSAGE i000(zpp) WITH '上傳失敗，請調節上傳的格式'.
    ENDIF.
    STOP.
  ENDIF.
  IF intern[] IS INITIAL.
    IF sy-langu = 'E'.
      MESSAGE i000(zpp) WITH 'No Data Upload'.
    ELSE.
      MESSAGE i000(zpp) WITH '沒有要上傳的數據！'.
    ENDIF.
    STOP.
  ENDIF.
  SORT intern BY row col.
  LOOP AT intern.
    ASSIGN COMPONENT intern-col OF STRUCTURE input TO <fs>.
    MOVE intern-value TO <fs>.
    AT END OF row.
      APPEND input.
      CLEAR  input.
    ENDAT.
  ENDLOOP.
ENDFORM.


FORM process_data.
  DATA: l_werks LIKE t001w-werks.
*  data: g_emplyee_id(20) type c.
*  DATA: l_model LIKE zidpmmcontrol-value1.
  DATA: itab LIKE zidpmm455 OCCURS 0 WITH HEADER LINE.

  DATA: mih_dayinFlo TYPE string.
  DATA:min_dayFlo TYPE string.


  LOOP AT input.
*上傳內容轉大寫
    TRANSLATE input-werks  TO UPPER CASE.
    TRANSLATE input-model  TO UPPER CASE.

    CONDENSE input-werks NO-GAPS.

*檢查時間格式問題

    mih_dayinFlo = input-mih_dayin+4(2).
    min_dayFlo =   input-mih_day+4(2).

    IF  mih_dayinFlo(1)  CO '0123456789'  AND min_dayFlo(1) CO  '0123456789'.
      IF   mih_dayinFlo < 1
        OR mih_dayinFlo > 12 OR min_dayFlo < 1 OR min_dayFlo > 12..
        IF sy-langu = 'E'.
          input-mess = 'date format is error!'.
        ELSE.
          input-mess = '日期格式錯誤！'.
        ENDIF.
        MODIFY input.
        CONTINUE.
      ENDIF.
    ELSE.
      IF sy-langu = 'E'.
        input-mess = 'date format is error!'.
      ELSE.
        input-mess = '日期格式錯誤！'.
      ENDIF.
      MODIFY input.
      CONTINUE.
    ENDIF.

    IF  mih_dayinFlo  = '/' OR min_dayFlo = '/' .
      IF sy-langu = 'E'.
        input-mess = 'date format is error!'.
      ELSE.
        input-mess = '日期格式錯誤！'.
      ENDIF.
      MODIFY input.
      CONTINUE.
    ENDIF.


*檢查模板各欄位是否為空
    IF input-werks  IS INITIAL OR input-werks = ''.
      IF sy-langu = 'E'.
        input-mess = 'werks is null!'.
      ELSE.
        input-mess = '工廠不能為空！'.
      ENDIF.
      MODIFY input.
      CONTINUE.
    ELSE.
      SELECT SINGLE werks FROM t001w INTO l_werks
      WHERE werks = input-werks.
      IF sy-subrc NE 0.
        IF sy-langu = 'E'.
          CONCATENATE input-mess
           'Plant is not exist!'
          INTO input-mess.
        ELSE.
          CONCATENATE input-mess
            '工廠不存在！'
          INTO input-mess.
        ENDIF.
        MODIFY input.
        CONTINUE.
      ENDIF.
    ENDIF.

    IF input-model  IS INITIAL OR input-model = ''.
      IF sy-langu = 'E'.
        CONCATENATE input-mess
        'model is null!'
        INTO input-mess.
      ELSE.
        CONCATENATE input-mess
         '機種不能為空！'
        INTO input-mess.
      ENDIF.
      MODIFY input.
      CONTINUE.
    ELSE.
      DATA:modelF TYPE string.
      modelF = input-model+0(3).
      SELECT SINGLE * FROM zidpmmcontrol INTO lt_zidpmmcontrol
      WHERE project = 'RELATION'
        AND value1 = modelF AND werks = input-werks.
      IF sy-subrc NE 0.
        IF sy-langu = 'E'.
          CONCATENATE input-mess
           'Model is not exist!'
           INTO input-mess.
        ELSE.
          CONCATENATE input-mess
            '機種不存在！'
          INTO input-mess.
        ENDIF.
        MODIFY input.
        CONTINUE.
      ENDIF.
    ENDIF.

    IF input-mess = '' OR input-mess IS INITIAL.
      CONCATENATE input-mess
            '上傳成功'
          INTO input-mess.
    ENDIF.

    itab-werks = input-werks.
    itab-model = input-model.
    itab-config = input-config.
    itab-mih = input-mih.
    itab-mih_day = input-mih_day.
    itab-mih_dayin = input-mih_dayin.
    itab-uname = sy-uname.
    itab-datum = sy-datum.
    itab-uzeit = sy-uzeit.


    input-uname = sy-uname.
    input-datum = sy-datum.
    input-uzeit = sy-uzeit.
*      get parameter id 'ZLG' field g_emplyee_id.
    MODIFY input.
    APPEND itab.
    CLEAR : input,mih_dayinFlo,min_dayFlo.
  ENDLOOP.
  IF NOT itab[] IS INITIAL.
    MODIFY zidpmm455 FROM TABLE itab.
*     if sy-subrc = 0.
*       if sy-langu = 'E'.
*         input-mess = 'Upload Success'.
*       else.
*         input-mess = '上傳成功'.
*       endif.
*       modify input.
*     else.
*        if sy-langu = 'E'.
*          concatenate input-mess
*           'Upload Failed!'
*          into input-mess.
*         else.
*          concatenate input-mess
*           '上傳失敗,請重試！'
*          into input-mess.
*         endif.
*         modify input.
*      endif.
  ENDIF.
  COMMIT WORK AND WAIT.
ENDFORM.                    " process_data1


FORM get_file USING    l_file.
  CALL FUNCTION 'WS_FILENAME_GET'
    EXPORTING
      def_filename = ''
      def_path     = 'C:\'
      mask         = ',*.XLS.'
      mode         = 'O'
      title        = 'Find the input file'
    IMPORTING
      filename     = l_file
    EXCEPTIONS
      inv_winsys   = 1
      no_batch     = 2
      OTHERS       = 5.

ENDFORM.


FORM open_format.
  TYPE-POOLS:soi.
  DATA:lt_contents TYPE soi_generic_table,
       ls_content  TYPE soi_generic_item.

  CLEAR:ls_content.
  CLEAR:lt_contents[].
  IF sy-langu = 'E'.
    ls_content-column = 1.
    ls_content-row = 1.
    ls_content-value = 'WERKS'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 2.
    ls_content-row = 1.
    ls_content-value = 'MODEL'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 3.
    ls_content-row = 1.
    ls_content-value = 'CONFIG'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 4.
    ls_content-row = 1.
    ls_content-value = 'MIH'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 5.
    ls_content-row = 1.
    ls_content-value = 'MIH_DAY'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 6.
    ls_content-row = 1.
    ls_content-value = 'MIH_DAYIN'.
    APPEND ls_content TO lt_contents.

  ELSE.
    ls_content-column = 1.
    ls_content-row = 1.
    ls_content-value = '工廠'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 2.
    ls_content-row = 1.
    ls_content-value = '機種'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 3.
    ls_content-row = 1.
    ls_content-value = 'Config'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 4.
    ls_content-row = 1.
    ls_content-value = 'MIH需求'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 5.
    ls_content-row = 1.
    ls_content-value = 'MIH Day'.
    APPEND ls_content TO lt_contents.

    ls_content-column = 6.
    ls_content-row = 1.
    ls_content-value = 'MIH Day(對內)'.
    APPEND ls_content TO lt_contents.

  ENDIF.
  CALL FUNCTION 'ZRFC_MM_IDP_0298'
    EXPORTING
      p_inplace   = ''
    TABLES
      it_contents = lt_contents.

ENDFORM.                    " open_format

*&---------------------------------------------------------------------*
*& Form AI_CAPTURE (20261009 V1.1: AI 助手报表结果采集通道)
*&---------------------------------------------------------------------*
*& 输入: P_RUNID = ZAI_RPT_RUN.REPORT_RUN_ID(真实适配器 SUBMIT 传入)
*& 动作: 将 lt_data(P2 查询结果) 逐行 JSON 化写入 ZAI_RPT_RESULT
*&       字段名即 JSON 键(大写), 前端表格按键渲染; 仅 P2 查询使用
*& 注意: 空结果(0 行)不落任何行 = 有效业务事实; INSERT 失败回滚不中断
*&---------------------------------------------------------------------*
FORM ai_capture USING p_runid TYPE c.
  DATA: BEGIN OF ls_row,
          werks     TYPE zidpmm455-werks,
          model     TYPE zidpmm455-model,
          config    TYPE zidpmm455-config,
          mih       TYPE zidpmm455-mih,
          mih_day   TYPE zidpmm455-mih_day,
          mih_dayin TYPE zidpmm455-mih_dayin,
          uname     TYPE zidpmm455-uname,
          datum     TYPE zidpmm455-datum,
          uzeit     TYPE zidpmm455-uzeit,
        END OF ls_row.
  DATA: lt_res TYPE STANDARD TABLE OF zai_rpt_result,
        ls_res TYPE zai_rpt_result,
        lv_idx TYPE n LENGTH 6,
        lv_json TYPE string,
        lv_cnt  TYPE i.

  IF p_runid IS INITIAL.
    RETURN.   " 非真实适配器调用(如手工勾选场景), 不采集
  ENDIF.

  " 幂等: 清同 run 旧数据
  DELETE FROM zai_rpt_result WHERE run_id = p_runid.

  LOOP AT lt_data.
    MOVE-CORRESPONDING lt_data TO ls_row.
    lv_json = /ui2/cl_json=>serialize( data = ls_row compress = abap_true ).
    lv_idx = lv_idx + 1.
    CLEAR ls_res.
    ls_res-mandt      = sy-mandt.
    ls_res-run_id     = p_runid.
    ls_res-line_index = lv_idx.
    ls_res-row_json   = lv_json.
    APPEND ls_res TO lt_res.
  ENDLOOP.
  lv_cnt = lines( lt_res ).

  IF lt_res IS NOT INITIAL.
    INSERT zai_rpt_result FROM TABLE lt_res.
    IF sy-subrc = 0.
      COMMIT WORK AND WAIT.
    ELSE.
      ROLLBACK WORK.   " 落表失败: 报表照常显示, 结果表为空由前端如实呈现
    ENDIF.
  ENDIF.
ENDFORM.
