*&---------------------------------------------------------------------*
*& Report ZAI_TEST_ODATA_INTERNAL
*&---------------------------------------------------------------------*
*& Fiori 报表分析 G0 前提验证(设计 §4.1; 部署清单 7.3 第 4 步)
*& 两部分:
*&   ① 离线自测(P_SELF = X): ZCL_AI_ODATA_SHAPER 的清洗 / 数值列 / FLAT /
*&      PIVOT / EXPAND / 列长度不一致 —— 不调 OData, 末行应为"全部通过"
*&   ② 真实调用(P_U1..P_U4 填了 URI 时): 用 ZCL_AI_ODATA_CLIENT 以当前用户
*&      身份内部调用一次, 打印 HTTP 码、耗时、字节数、响应开头, 再按 P_SHAPE /
*&      P_C1..P_C2(SHAPE_CFG, 可空)转换并打印列与前 P_ROWS 行
*& 选择屏幕(未维护选择文本, 显示技术名):
*&   P_SELF  离线自测              P_U1..P_U4 URI(太长时依次接着填, 不留空格)
*&   P_SHAPE FLAT/PIVOT/EXPAND     P_C1..P_C2 SHAPE_CFG JSON(空 = 默认)
*&   P_ROWS  打印前几行
*& URI 怎么来: Fiori 页面按 F12 → Network → $batch 请求的 Payload 里找
*&   "GET DynamiFIELDSet?$filter=..." 这一行, 在前面补上服务路径
*&   /sap/opu/odata/sap/ZSD_IDP_001_SRV/ 即可(不带主机名)
*& 验证项(设计 §4.1): T1 HTTP 200 且 JSON 与 F12 一致; T2 换一个没有该 Fiori
*&   角色的账号运行应被拒(401/403 或业务报错); T3 转换后的行与 Fiori 页面一致;
*&   T4 记下耗时与字节数(定 FIORI_TIMEOUT_SEC / FIORI_MAX_BYTES)
*& 依赖: ZCL_AI_ODATA_CLIENT V1.0 / ZCL_AI_ODATA_SHAPER V1.0(不需要 ZAI_FRPT_* 表)
*& 只读: 不写任何表
*& V1.0 20261020
*&---------------------------------------------------------------------*
REPORT zai_test_odata_internal LINE-SIZE 255.

PARAMETERS: p_self  AS CHECKBOX DEFAULT 'X',
            p_u1    TYPE c LENGTH 132 LOWER CASE,
            p_u2    TYPE c LENGTH 132 LOWER CASE,
            p_u3    TYPE c LENGTH 132 LOWER CASE,
            p_u4    TYPE c LENGTH 132 LOWER CASE,
            p_shape TYPE c LENGTH 10 DEFAULT 'PIVOT',
            p_c1    TYPE c LENGTH 132 LOWER CASE,
            p_c2    TYPE c LENGTH 132 LOWER CASE,
            p_rows  TYPE i DEFAULT 10.

CLASS lcl_t DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-DATA: gv_pass TYPE i,
                gv_fail TYPE i.
    CLASS-METHODS check
      IMPORTING iv_name TYPE string
                iv_ok   TYPE abap_bool
                iv_info TYPE string OPTIONAL.
    CLASS-METHODS selftest.
    CLASS-METHODS live
      IMPORTING iv_uri TYPE string
                iv_cfg TYPE string.
    CLASS-METHODS print_ds
      IMPORTING is_ds TYPE zcl_ai_odata_shaper=>ty_dataset.
    CLASS-METHODS print_long
      IMPORTING iv_text TYPE string
                iv_max  TYPE i.
ENDCLASS.

CLASS lcl_t IMPLEMENTATION.

  METHOD check.
    IF iv_ok = abap_true.
      gv_pass = gv_pass + 1.
      WRITE: / '[通过]', iv_name.
    ELSE.
      gv_fail = gv_fail + 1.
      WRITE: / '[失败]' COLOR COL_NEGATIVE, iv_name.
      IF iv_info IS NOT INITIAL.
        WRITE: / '        ', iv_info.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD selftest.

    DATA: ls_ds   TYPE zcl_ai_odata_shaper=>ty_dataset,
          ls_col  TYPE zcl_ai_odata_shaper=>ty_column,
          lv_json TYPE string,
          lv_cfg  TYPE string,
          lv_row  TYPE string,
          lv_v    TYPE string.

    WRITE: / '==== 离线自测(不调 OData) ===='.

    lv_v = zcl_ai_odata_shaper=>clean_value( `     139418` ).
    check( iv_name = 'clean_value 去前导空格' iv_ok = xsdbool( lv_v = `139418` ) iv_info = lv_v ).
    lv_v = zcl_ai_odata_shaper=>clean_value( `1,234,567.50` ).
    check( iv_name = 'clean_value 千分位' iv_ok = xsdbool( lv_v = `1234567.50` ) iv_info = lv_v ).
    lv_v = zcl_ai_odata_shaper=>clean_value( `100-` ).
    check( iv_name = 'clean_value 尾负号' iv_ok = xsdbool( lv_v = `-100` ) iv_info = lv_v ).
    lv_v = zcl_ai_odata_shaper=>clean_value( `/Date(1640995200000)/` ).
    check( iv_name = 'clean_value /Date()/' iv_ok = xsdbool( lv_v = `2022-01-01` ) iv_info = lv_v ).
    check( iv_name = 'is_col_number 12.5'   iv_ok = zcl_ai_odata_shaper=>is_col_number( `12.5` ) ).
    check( iv_name = 'is_col_number 0045 否' iv_ok = xsdbool( zcl_ai_odata_shaper=>is_col_number( `0045` ) = abap_false ) ).
    check( iv_name = 'is_col_number 2026-10-01 否'
           iv_ok = xsdbool( zcl_ai_odata_shaper=>is_col_number( `2026-10-01` ) = abap_false ) ).

    " PIVOT(shipment 同结构): 每条是一列, DynamicDataSet 是列值
    lv_json = `{"d":{"results":[` &&
              `{"Name":"202610","Description":"2026-10","Position":"2","DynamicDataSet":{"results":[{"Value":"     139418"},{"Value":"      33390"}]}},` &&
              `{"Name":"SHMODE","Description":"Ship Mode","Position":"1","DynamicDataSet":{"results":[{"Value":"D"},{"Value":"C"}]}}` &&
              `]}}`.
    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = lv_json iv_shape = `PIVOT` iv_cfg = `` ).
    check( iv_name = 'PIVOT 无错误' iv_ok = xsdbool( ls_ds-error IS INITIAL ) iv_info = ls_ds-error ).
    check( iv_name = 'PIVOT 2 列 2 行' iv_ok = xsdbool( lines( ls_ds-columns ) = 2 AND lines( ls_ds-rows ) = 2 ) ).
    READ TABLE ls_ds-columns INTO ls_col INDEX 1.
    check( iv_name = 'PIVOT 按 Position 排列(第一列 SHMODE)' iv_ok = xsdbool( ls_col-name = `SHMODE` ) iv_info = ls_col-name ).
    READ TABLE ls_ds-columns INTO ls_col INDEX 2.
    check( iv_name = 'PIVOT 期间列是数值列' iv_ok = ls_col-is_numeric ).
    lv_row = zcl_ai_odata_shaper=>row_json( is_ds = ls_ds iv_index = 1 ).
    check( iv_name = 'PIVOT 第 1 行 = D / 139418' iv_ok = xsdbool( lv_row = `{"SHMODE":"D","202610":139418}` ) iv_info = lv_row ).

    lv_json = `{"d":{"results":[` &&
              `{"Name":"A","Position":"1","DynamicDataSet":{"results":[{"Value":"x"},{"Value":"y"}]}},` &&
              `{"Name":"B","Position":"2","DynamicDataSet":{"results":[{"Value":"1"}]}}` &&
              `]}}`.
    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = lv_json iv_shape = `PIVOT` iv_cfg = `` ).
    check( iv_name = 'PIVOT 列长度不一致 → 报错不硬拼' iv_ok = xsdbool( find( val = ls_ds-error sub = `列长度不一致` ) >= 0 ) iv_info = ls_ds-error ).

    " FLAT: 去掉 __metadata 与嵌套对象; 单据号前导零按文本
    lv_json = `{"d":{"results":[` &&
              `{"__metadata":{"type":"X"},"Werks":"1000","Vbeln":"0045000001","Netwr":"1,200.50","ToItem":{"__deferred":{}}},` &&
              `{"__metadata":{"type":"X"},"Werks":"2000","Vbeln":"0045000002","Netwr":"300.00","ToItem":{"__deferred":{}}}` &&
              `]}}`.
    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = lv_json iv_shape = `FLAT` iv_cfg = `` ).
    check( iv_name = 'FLAT 3 列(去掉 __metadata / 嵌套)' iv_ok = xsdbool( lines( ls_ds-columns ) = 3 ) ).
    lv_row = zcl_ai_odata_shaper=>row_json( is_ds = ls_ds iv_index = 1 ).
    check( iv_name = 'FLAT 行: 单据号保留前导零, 金额去千分位'
           iv_ok = xsdbool( lv_row = `{"Werks":1000,"Vbeln":"0045000001","Netwr":1200.50}` ) iv_info = lv_row ).

    " FLAT + columns 配置 + 截断
    lv_cfg = `{"rowList":"d.results","columns":[{"prop":"Netwr","label":"金额"}]}`.
    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = lv_json iv_shape = `FLAT` iv_cfg = lv_cfg iv_max_rows = 1 ).
    READ TABLE ls_ds-columns INTO ls_col INDEX 1.
    check( iv_name = 'FLAT columns 配置 + 截断 1 行'
           iv_ok = xsdbool( lines( ls_ds-columns ) = 1 AND ls_col-label = `金额` AND lines( ls_ds-rows ) = 1
                            AND ls_ds-total = 2 AND ls_ds-truncated = abap_true ) ).

    " EXPAND: 抬头字段复制到每个行项目
    lv_json = `{"d":{"results":[{"Aufnr":"100001","ToItems":{"results":[{"Matnr":"FG1","Qty":"10"},{"Matnr":"FG2","Qty":"20"}]}}]}}`.
    lv_cfg  = `{"itemList":"ToItems.results","headerCols":["Aufnr"],"itemCols":["Matnr","Qty"]}`.
    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = lv_json iv_shape = `EXPAND` iv_cfg = lv_cfg ).
    lv_row = zcl_ai_odata_shaper=>row_json( is_ds = ls_ds iv_index = 2 ).
    check( iv_name = 'EXPAND 2 行, 抬头复制' iv_ok = xsdbool( lines( ls_ds-rows ) = 2 AND lv_row = `{"Aufnr":100001,"Matnr":"FG2","Qty":20}` )
           iv_info = lv_row ).

    check( iv_name = 'check_uri 拒绝 $batch'
           iv_ok = xsdbool( zcl_ai_odata_client=>check_uri( `/sap/opu/odata/sap/X/$batch` ) IS NOT INITIAL ) ).
    check( iv_name = 'check_uri 拒绝非 /sap/opu/odata/ 前缀'
           iv_ok = xsdbool( zcl_ai_odata_client=>check_uri( `/sap/bc/x` ) IS NOT INITIAL ) ).

  ENDMETHOD.

  METHOD live.

    DATA: ls_resp TYPE zcl_ai_odata_client=>ty_response,
          ls_ds   TYPE zcl_ai_odata_shaper=>ty_dataset,
          lv_uri  TYPE string,
          lv_sh   TYPE string.

    lv_uri = iv_uri.
    IF find( val = lv_uri sub = '$format=' ) < 0.
      lv_uri = lv_uri && COND string( WHEN find( val = lv_uri sub = '?' ) >= 0 THEN `&` ELSE `?` ) && `$format=json`.
    ENDIF.

    SKIP.
    WRITE: / '==== 真实调用 ===='.
    WRITE: / '用户:', sy-uname, '  客户端:', sy-mandt.
    WRITE: / 'URI:', lv_uri.
    ls_resp = zcl_ai_odata_client=>get( iv_uri = lv_uri iv_timeout = 120 iv_max_bytes = 104857600 ).
    WRITE: / '通道:', ls_resp-channel.
    WRITE: / 'HTTP:', ls_resp-http_code, ls_resp-reason.
    WRITE: / '耗时(毫秒):', ls_resp-elapsed_ms, '  字节:', ls_resp-bytes.
    IF ls_resp-error IS NOT INITIAL.
      WRITE: / '错误:' COLOR COL_NEGATIVE, ls_resp-error.
    ENDIF.
    WRITE: / '响应开头(前 3000 字符):'.
    print_long( iv_text = ls_resp-body iv_max = 3000 ).
    IF ls_resp-error IS NOT INITIAL OR ls_resp-body IS INITIAL.
      RETURN.
    ENDIF.

    lv_sh = p_shape.
    ls_ds = zcl_ai_odata_shaper=>shape( iv_json = ls_resp-body iv_shape = lv_sh iv_cfg = iv_cfg iv_max_rows = 5000 ).
    SKIP.
    WRITE: / '==== 转换结果(', lv_sh, ') ===='.
    IF ls_ds-error IS NOT INITIAL.
      WRITE: / '转换失败:' COLOR COL_NEGATIVE, ls_ds-error.
      RETURN.
    ENDIF.
    print_ds( ls_ds ).

  ENDMETHOD.

  METHOD print_ds.

    DATA: ls_col  TYPE zcl_ai_odata_shaper=>ty_column,
          ls_row  TYPE zcl_ai_odata_shaper=>ty_row,
          lv_line TYPE string,
          lv_cell TYPE string,
          lv_n    TYPE i.

    lv_n = lines( is_ds-rows ).
    WRITE: / '行数:', lv_n, '  总行数:', is_ds-total, '  截断:', is_ds-truncated.
    WRITE: / '列(名称 / 标签 / 是否数值):'.
    LOOP AT is_ds-columns INTO ls_col.
      WRITE: / '  ', ls_col-name, '/', ls_col-label, '/', ls_col-is_numeric.
    ENDLOOP.
    WRITE: / '前', p_rows, '行:'.
    LOOP AT is_ds-rows INTO ls_row.
      IF sy-tabix > p_rows.
        EXIT.
      ENDIF.
      CLEAR lv_line.
      LOOP AT ls_row-cells INTO lv_cell.
        lv_line = lv_line && lv_cell && ` | `.
      ENDLOOP.
      WRITE: / '  ', lv_line.
    ENDLOOP.

  ENDMETHOD.

  METHOD print_long.

    DATA: lv_len TYPE i,
          lv_off TYPE i,
          lv_l   TYPE i,
          lv_seg TYPE string.

    lv_len = strlen( iv_text ).
    IF lv_len > iv_max.
      lv_len = iv_max.
    ENDIF.
    lv_off = 0.
    WHILE lv_off < lv_len.
      lv_l = lv_len - lv_off.
      IF lv_l > 200.
        lv_l = 200.
      ENDIF.
      lv_seg = substring( val = iv_text off = lv_off len = lv_l ).
      WRITE: / lv_seg.
      lv_off = lv_off + lv_l.
    ENDWHILE.

  ENDMETHOD.

ENDCLASS.

START-OF-SELECTION.
  DATA: gv_uri TYPE string,
        gv_cfg TYPE string.

  IF p_self = abap_true.
    lcl_t=>selftest( ).
    SKIP.
    IF lcl_t=>gv_fail = 0.
      WRITE: / '全部通过:', lcl_t=>gv_pass, '项' COLOR COL_POSITIVE.
    ELSE.
      WRITE: / '失败:', lcl_t=>gv_fail, '项 / 通过:', lcl_t=>gv_pass, '项' COLOR COL_NEGATIVE.
    ENDIF.
  ENDIF.

  CONCATENATE p_u1 p_u2 p_u3 p_u4 INTO gv_uri.
  CONCATENATE p_c1 p_c2 INTO gv_cfg.
  IF gv_uri IS NOT INITIAL.
    lcl_t=>live( iv_uri = gv_uri iv_cfg = gv_cfg ).
  ELSEIF p_self = abap_false.
    WRITE: / '请在 P_U1..P_U4 填 URI(以 /sap/opu/odata/ 开头), 或勾选 P_SELF 跑离线自测'.
  ENDIF.
