*=======================================================================
* 对象:   ZCL_AI_ODATA_SHAPER
* 用途:   Fiori 报表取数 —— 把各种 OData 返回结构转成统一数据集
*         (设计: 功能计划书/Fiori报表分析/01-方案与开发计划 §4.3)
*         ty_dataset = 列(名称/标签/是否数值) + 行(按列顺序的单元格) + 总行数/截断
* 形状:   FLAT   d.results 每条是一行(去掉 __metadata 与嵌套对象)
*         PIVOT  按列返回的动态透视(shipment): 每条是一列(Name/Description/
*                Position), DynamicDataSet.results 是该列的值, 按下标拼成行;
*                各列值个数不一致时如实报错, 不硬拼
*         EXPAND 抬头 + 行项目: 抬头字段复制到每个行项目上
* 清洗:   去前后空格; /Date(ms)/ → YYYY-MM-DD; 千分位; ABAP 尾负号 100- → -100;
*         一列去空格后的值全部是完整数值形态(且无前导零, 防单据号) → 数值列
* JSON:   用 SAP 标准 sXML 读取器(cl_sxml_string_reader, JSON-XML)解析成
*         节点表, 不依赖 /ui2/cl_json 的动态类型生成; 实例方法(parse / path /
*         kids / text / to_json)也给 ZCL_AI_FIORI_REPORT_SERVICE 读配置用
*         JS 版同口径实现见 webapp/service/FioriMockBackend.js(_fioriShape)
* 依赖:   无
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50 语法, 755 适用)
* V1.0    20261020: 首版
* ★ 重贴后核对标记: METHOD parse 内有 cl_sxml_string_reader=>create 与
*   if_sxml_node=>co_nt_element_open; METHOD shape_pivot 内有"列长度不一致"
*=======================================================================
CLASS zcl_ai_odata_shaper DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES: BEGIN OF ty_column,
             name       TYPE string,
             label      TYPE string,
             is_numeric TYPE abap_bool,
           END OF ty_column.
    TYPES tt_column TYPE STANDARD TABLE OF ty_column WITH DEFAULT KEY.
    TYPES tt_cells TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_row,
             cells TYPE tt_cells,         " 按 columns 的顺序
           END OF ty_row.
    TYPES tt_row TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_dataset,
             columns   TYPE tt_column,
             rows      TYPE tt_row,
             total     TYPE i,            " 截断前的总行数
             truncated TYPE abap_bool,
             error     TYPE string,       " 非空 = 失败(中文原因)
           END OF ty_dataset.
    TYPES: BEGIN OF ty_kv,
             name  TYPE string,
             value TYPE string,
           END OF ty_kv.
    TYPES tt_kv TYPE STANDARD TABLE OF ty_kv WITH DEFAULT KEY.
    TYPES tt_int TYPE STANDARD TABLE OF i WITH DEFAULT KEY.

    " ---- 静态入口 ----

    " OData 响应 → 统一数据集(含清洗、数值列判断、截断)
    CLASS-METHODS shape
      IMPORTING iv_json     TYPE string
                iv_shape    TYPE string
                iv_cfg      TYPE string
                iv_max_rows TYPE i DEFAULT 5000
      RETURNING VALUE(rs)   TYPE ty_dataset.

    " 单元格清洗(见文件头)
    CLASS-METHODS clean_value
      IMPORTING iv_value  TYPE string
      RETURNING VALUE(rv) TYPE string.

    " 数值列判断用: 完整数值形态且无前导零
    CLASS-METHODS is_col_number
      IMPORTING iv_value  TYPE string
      RETURNING VALUE(rv) TYPE abap_bool.

    " JSON 字符串字面量(带双引号, 已转义)
    CLASS-METHODS json_str
      IMPORTING iv        TYPE string
      RETURNING VALUE(rv) TYPE string.

    " {"columns":[{"name","label","numeric"}]}
    CLASS-METHODS schema_json
      IMPORTING is_ds     TYPE ty_dataset
      RETURNING VALUE(rv) TYPE string.

    " 第 iv_index 行 → JSON 对象(数值列不带引号, 空值是 "")
    CLASS-METHODS row_json
      IMPORTING is_ds     TYPE ty_dataset
                iv_index  TYPE i
      RETURNING VALUE(rv) TYPE string.

    " 顶层 JSON 对象 → 名/值表(值是标量原文; 嵌套对象/数组给紧凑 JSON)
    CLASS-METHODS flat_object
      IMPORTING iv_json   TYPE string
      RETURNING VALUE(rt) TYPE tt_kv.

    " ---- 实例: 通用 JSON 节点读取 ----

    METHODS parse
      IMPORTING iv_json      TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
    METHODS get_error
      RETURNING VALUE(rv) TYPE string.
    " 根节点(解析成功 = 1, 否则 0)
    METHODS root
      RETURNING VALUE(rv) TYPE i.
    " 对象成员(没有返回 0)
    METHODS child
      IMPORTING iv_id     TYPE i
                iv_name   TYPE string
      RETURNING VALUE(rv) TYPE i.
    " 点号路径(如 d.results), 从 iv_id 出发; 没有返回 0
    METHODS path
      IMPORTING iv_id     TYPE i
                iv_path   TYPE string
      RETURNING VALUE(rv) TYPE i.
    " 子节点(文档顺序)
    METHODS kids
      IMPORTING iv_id     TYPE i
      RETURNING VALUE(rt) TYPE tt_int.
    " 标量值(字符串/数字/布尔的原文; 对象/数组/null 返回空)
    METHODS text
      IMPORTING iv_id     TYPE i
      RETURNING VALUE(rv) TYPE string.
    " 节点类型: O 对象 / A 数组 / S 字符串 / N 数字 / B 布尔 / Z null
    METHODS kind
      IMPORTING iv_id     TYPE i
      RETURNING VALUE(rv) TYPE string.
    " 成员名
    METHODS name_of
      IMPORTING iv_id     TYPE i
      RETURNING VALUE(rv) TYPE string.
    " 子树重新序列化为紧凑 JSON
    METHODS to_json
      IMPORTING iv_id     TYPE i
      RETURNING VALUE(rv) TYPE string.
    " 根对象成员的字符串值(没有或为空 → iv_default)
    METHODS cfg
      IMPORTING iv_key     TYPE string
                iv_default TYPE string
      RETURNING VALUE(rv)  TYPE string.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_node,
             parent TYPE i,
             name   TYPE string,
             kind   TYPE c LENGTH 1,
             value  TYPE string,
             nkids  TYPE i,
           END OF ty_node.
    TYPES tt_node TYPE STANDARD TABLE OF ty_node WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_kid,
             parent TYPE i,
             name   TYPE string,
             idx    TYPE i,
             id     TYPE i,
           END OF ty_kid.
    TYPES tt_kid TYPE SORTED TABLE OF ty_kid WITH UNIQUE KEY parent name idx.

    DATA mt_nodes TYPE tt_node.      " 行号 = 节点编号
    DATA mt_kids  TYPE tt_kid.       " 父 → 子索引
    DATA mv_error TYPE string.

    METHODS shape_flat
      IMPORTING io_cfg TYPE REF TO zcl_ai_odata_shaper
      CHANGING  cs_ds  TYPE ty_dataset.
    METHODS shape_pivot
      IMPORTING io_cfg TYPE REF TO zcl_ai_odata_shaper
      CHANGING  cs_ds  TYPE ty_dataset.
    METHODS shape_expand
      IMPORTING io_cfg TYPE REF TO zcl_ai_odata_shaper
      CHANGING  cs_ds  TYPE ty_dataset.
    " 字符串数组配置(如 headerCols) → 名称表
    METHODS cfg_list
      IMPORTING iv_key    TYPE string
      RETURNING VALUE(rt) TYPE tt_cells.
    " 列名去重 + 截断 + 数值列判断
    CLASS-METHODS finish
      IMPORTING iv_max_rows TYPE i
      CHANGING  cs_ds       TYPE ty_dataset.

ENDCLASS.



CLASS zcl_ai_odata_shaper IMPLEMENTATION.


  METHOD shape.

    DATA: lo_doc   TYPE REF TO zcl_ai_odata_shaper,
          lo_cfg   TYPE REF TO zcl_ai_odata_shaper,
          lv_shape TYPE string.

    CLEAR rs.
    CREATE OBJECT lo_doc.
    IF lo_doc->parse( iv_json ) = abap_false.
      rs-error = |返回内容不是合法 JSON: { lo_doc->get_error( ) }|.
      RETURN.
    ENDIF.
    CREATE OBJECT lo_cfg.
    IF iv_cfg IS NOT INITIAL.
      IF lo_cfg->parse( iv_cfg ) = abap_false.
        rs-error = |SHAPE_CFG 不是合法 JSON: { lo_cfg->get_error( ) }|.
        RETURN.
      ENDIF.
    ENDIF.

    lv_shape = to_upper( iv_shape ).
    CASE lv_shape.
      WHEN 'PIVOT'.
        lo_doc->shape_pivot( EXPORTING io_cfg = lo_cfg CHANGING cs_ds = rs ).
      WHEN 'EXPAND'.
        lo_doc->shape_expand( EXPORTING io_cfg = lo_cfg CHANGING cs_ds = rs ).
      WHEN OTHERS.
        lo_doc->shape_flat( EXPORTING io_cfg = lo_cfg CHANGING cs_ds = rs ).
    ENDCASE.
    IF rs-error IS NOT INITIAL.
      RETURN.
    ENDIF.
    finish( EXPORTING iv_max_rows = iv_max_rows CHANGING cs_ds = rs ).

  ENDMETHOD.


  METHOD shape_flat.

    DATA: lv_list   TYPE i,
          lv_ccfg   TYPE i,
          lv_id     TYPE i,
          lv_first  TYPE i,
          lv_ci     TYPE i,
          lv_name   TYPE string,
          lv_kind   TYPE string,
          lv_cell   TYPE string,
          lt_rows   TYPE tt_int,
          lt_ccfg   TYPE tt_int,
          lt_props  TYPE tt_int,
          ls_column TYPE ty_column,
          ls_row    TYPE ty_row.

    DATA(lv_row_list) = io_cfg->cfg( iv_key = 'rowList' iv_default = 'd.results' ).
    lv_list = path( iv_id = root( ) iv_path = lv_row_list ).
    IF lv_list = 0.
      cs_ds-error = |返回结构里找不到 { lv_row_list }|.
      RETURN.
    ENDIF.
    lt_rows = kids( lv_list ).

    " 列: SHAPE_CFG.columns = [{prop,label}]; 没配 = 第一行的全部标量属性(去掉 __metadata)
    lv_ccfg = io_cfg->child( iv_id = io_cfg->root( ) iv_name = 'columns' ).
    IF lv_ccfg > 0.
      lt_ccfg = io_cfg->kids( lv_ccfg ).
      LOOP AT lt_ccfg INTO lv_id.
        CLEAR ls_column.
        ls_column-name  = io_cfg->text( io_cfg->child( iv_id = lv_id iv_name = 'prop' ) ).
        ls_column-label = io_cfg->text( io_cfg->child( iv_id = lv_id iv_name = 'label' ) ).
        IF ls_column-label IS INITIAL.
          ls_column-label = ls_column-name.
        ENDIF.
        IF ls_column-name IS NOT INITIAL.
          APPEND ls_column TO cs_ds-columns.
        ENDIF.
      ENDLOOP.
    ELSE.
      READ TABLE lt_rows INTO lv_first INDEX 1.
      IF sy-subrc = 0.
        lt_props = kids( lv_first ).
        LOOP AT lt_props INTO lv_id.
          lv_name = name_of( lv_id ).
          lv_kind = kind( lv_id ).
          IF lv_name = '__metadata' OR lv_kind = 'O' OR lv_kind = 'A'.
            CONTINUE.
          ENDIF.
          CLEAR ls_column.
          ls_column-name  = lv_name.
          ls_column-label = lv_name.
          APPEND ls_column TO cs_ds-columns.
        ENDLOOP.
      ENDIF.
    ENDIF.

    LOOP AT lt_rows INTO lv_id.
      CLEAR ls_row.
      LOOP AT cs_ds-columns INTO ls_column.
        lv_ci = child( iv_id = lv_id iv_name = ls_column-name ).
        lv_cell = clean_value( text( lv_ci ) ).
        APPEND lv_cell TO ls_row-cells.
      ENDLOOP.
      APPEND ls_row TO cs_ds-rows.
    ENDLOOP.

  ENDMETHOD.


  METHOD shape_pivot.

    TYPES: BEGIN OF ty_pcol,
             ord   TYPE i,
             seq   TYPE i,
             name  TYPE string,
             label TYPE string,
             vals  TYPE tt_cells,
           END OF ty_pcol.
    DATA: lt_pcol   TYPE STANDARD TABLE OF ty_pcol WITH DEFAULT KEY,
          ls_pcol   TYPE ty_pcol,
          lt_cols   TYPE tt_int,
          lt_vals   TYPE tt_int,
          lv_list   TYPE i,
          lv_col    TYPE i,
          lv_vlist  TYPE i,
          lv_val    TYPE i,
          lv_len    TYPE i,
          lv_cnt    TYPE i,
          lv_r      TYPE i,
          lv_ord    TYPE string,
          lv_cell   TYPE string,
          ls_column TYPE ty_column,
          ls_row    TYPE ty_row.
    FIELD-SYMBOLS <ls_pc> TYPE ty_pcol.

    DATA(lv_col_list)    = io_cfg->cfg( iv_key = 'colList'    iv_default = 'd.results' ).
    DATA(lv_col_name)    = io_cfg->cfg( iv_key = 'colName'    iv_default = 'Name' ).
    DATA(lv_col_label)   = io_cfg->cfg( iv_key = 'colLabel'   iv_default = 'Description' ).
    DATA(lv_col_order)   = io_cfg->cfg( iv_key = 'colOrder'   iv_default = 'Position' ).
    DATA(lv_value_list)  = io_cfg->cfg( iv_key = 'valueList'  iv_default = 'DynamicDataSet.results' ).
    DATA(lv_value_field) = io_cfg->cfg( iv_key = 'valueField' iv_default = 'Value' ).

    lv_list = path( iv_id = root( ) iv_path = lv_col_list ).
    IF lv_list = 0.
      cs_ds-error = |返回结构里找不到 { lv_col_list }|.
      RETURN.
    ENDIF.

    lt_cols = kids( lv_list ).
    LOOP AT lt_cols INTO lv_col.
      CLEAR ls_pcol.
      ls_pcol-seq   = sy-tabix.
      ls_pcol-name  = clean_value( text( child( iv_id = lv_col iv_name = lv_col_name ) ) ).
      ls_pcol-label = clean_value( text( child( iv_id = lv_col iv_name = lv_col_label ) ) ).
      lv_ord        = clean_value( text( child( iv_id = lv_col iv_name = lv_col_order ) ) ).
      IF lv_ord IS NOT INITIAL AND lv_ord CO '0123456789'.
        ls_pcol-ord = lv_ord.
      ELSE.
        ls_pcol-ord = ls_pcol-seq.
      ENDIF.
      IF ls_pcol-name IS INITIAL.
        ls_pcol-name = |C{ ls_pcol-seq }|.
      ENDIF.
      IF ls_pcol-label IS INITIAL.
        ls_pcol-label = ls_pcol-name.
      ENDIF.
      lv_vlist = path( iv_id = lv_col iv_path = lv_value_list ).
      lt_vals = kids( lv_vlist ).
      LOOP AT lt_vals INTO lv_val.
        lv_cell = clean_value( text( child( iv_id = lv_val iv_name = lv_value_field ) ) ).
        APPEND lv_cell TO ls_pcol-vals.
      ENDLOOP.
      APPEND ls_pcol TO lt_pcol.
    ENDLOOP.

    IF lt_pcol IS INITIAL.
      RETURN.   " 没有列 = 0 行(不算错)
    ENDIF.
    SORT lt_pcol BY ord seq.

    " 对齐检查: 各列值个数必须一致(某格无值时后端若不补空, 硬拼会错位)
    READ TABLE lt_pcol INTO ls_pcol INDEX 1.
    lv_len = lines( ls_pcol-vals ).
    LOOP AT lt_pcol INTO ls_pcol.
      lv_cnt = lines( ls_pcol-vals ).
      IF lv_cnt <> lv_len.
        cs_ds-error = |返回结构列长度不一致(列 { ls_pcol-name } 有 { lv_cnt } 个值, | &&
                      |第一列有 { lv_len } 个), 无法按行拼接|.
        CLEAR cs_ds-columns.
        RETURN.
      ENDIF.
      CLEAR ls_column.
      ls_column-name  = ls_pcol-name.
      ls_column-label = ls_pcol-label.
      APPEND ls_column TO cs_ds-columns.
    ENDLOOP.

    DO lv_len TIMES.
      lv_r = sy-index.
      CLEAR ls_row.
      LOOP AT lt_pcol ASSIGNING <ls_pc>.
        CLEAR lv_cell.
        READ TABLE <ls_pc>-vals INTO lv_cell INDEX lv_r.
        APPEND lv_cell TO ls_row-cells.
      ENDLOOP.
      APPEND ls_row TO cs_ds-rows.
    ENDDO.

  ENDMETHOD.


  METHOD shape_expand.

    DATA: lv_list   TYPE i,
          lv_hdr    TYPE i,
          lv_items  TYPE i,
          lv_item   TYPE i,
          lv_name   TYPE string,
          lv_cell   TYPE string,
          lt_hdrs   TYPE tt_int,
          lt_items  TYPE tt_int,
          lt_hcols  TYPE tt_cells,
          lt_icols  TYPE tt_cells,
          ls_column TYPE ty_column,
          ls_row    TYPE ty_row,
          ls_hrow   TYPE ty_row.

    DATA(lv_row_list)  = io_cfg->cfg( iv_key = 'rowList'  iv_default = 'd.results' ).
    DATA(lv_item_list) = io_cfg->cfg( iv_key = 'itemList' iv_default = '' ).
    IF lv_item_list IS INITIAL.
      cs_ds-error = 'EXPAND 形状的 SHAPE_CFG 必须配置 itemList'.
      RETURN.
    ENDIF.
    lt_hcols = io_cfg->cfg_list( 'headerCols' ).
    lt_icols = io_cfg->cfg_list( 'itemCols' ).
    IF lt_icols IS INITIAL.
      cs_ds-error = 'EXPAND 形状的 SHAPE_CFG 必须配置 itemCols'.
      RETURN.
    ENDIF.
    LOOP AT lt_hcols INTO lv_name.
      CLEAR ls_column.
      ls_column-name  = lv_name.
      ls_column-label = lv_name.
      APPEND ls_column TO cs_ds-columns.
    ENDLOOP.
    LOOP AT lt_icols INTO lv_name.
      CLEAR ls_column.
      ls_column-name  = lv_name.
      ls_column-label = lv_name.
      APPEND ls_column TO cs_ds-columns.
    ENDLOOP.

    lv_list = path( iv_id = root( ) iv_path = lv_row_list ).
    IF lv_list = 0.
      cs_ds-error = |返回结构里找不到 { lv_row_list }|.
      RETURN.
    ENDIF.
    lt_hdrs = kids( lv_list ).
    LOOP AT lt_hdrs INTO lv_hdr.
      CLEAR ls_hrow.
      LOOP AT lt_hcols INTO lv_name.
        lv_cell = clean_value( text( child( iv_id = lv_hdr iv_name = lv_name ) ) ).
        APPEND lv_cell TO ls_hrow-cells.
      ENDLOOP.
      lv_items = path( iv_id = lv_hdr iv_path = lv_item_list ).
      lt_items = kids( lv_items ).
      LOOP AT lt_items INTO lv_item.
        ls_row = ls_hrow.
        LOOP AT lt_icols INTO lv_name.
          lv_cell = clean_value( text( child( iv_id = lv_item iv_name = lv_name ) ) ).
          APPEND lv_cell TO ls_row-cells.
        ENDLOOP.
        APPEND ls_row TO cs_ds-rows.
      ENDLOOP.
    ENDLOOP.

  ENDMETHOD.


  METHOD finish.

    DATA: lv_ci   TYPE i,
          lv_from TYPE i,
          lv_all  TYPE abap_bool,
          lv_any  TYPE abap_bool,
          lv_cell TYPE string,
          lt_seen TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    FIELD-SYMBOLS: <ls_col> TYPE ty_column,
                   <ls_row> TYPE ty_row.

    " 列名去重(行 JSON 以列名为键, 重名会互相覆盖)
    LOOP AT cs_ds-columns ASSIGNING <ls_col>.
      lv_ci = sy-tabix.
      READ TABLE lt_seen TRANSPORTING NO FIELDS WITH KEY table_line = <ls_col>-name.
      IF sy-subrc = 0.
        <ls_col>-name = |{ <ls_col>-name }_{ lv_ci }|.
      ENDIF.
      APPEND <ls_col>-name TO lt_seen.
    ENDLOOP.

    cs_ds-total = lines( cs_ds-rows ).
    IF iv_max_rows > 0 AND cs_ds-total > iv_max_rows.
      lv_from = iv_max_rows + 1.
      DELETE cs_ds-rows FROM lv_from.
      cs_ds-truncated = abap_true.
    ENDIF.

    " 数值列: 非空值全部是完整数值形态(且至少一个非空值)
    LOOP AT cs_ds-columns ASSIGNING <ls_col>.
      lv_ci  = sy-tabix.
      lv_all = abap_true.
      lv_any = abap_false.
      LOOP AT cs_ds-rows ASSIGNING <ls_row>.
        CLEAR lv_cell.
        READ TABLE <ls_row>-cells INTO lv_cell INDEX lv_ci.
        IF lv_cell IS INITIAL.
          CONTINUE.
        ENDIF.
        IF is_col_number( lv_cell ) = abap_false.
          lv_all = abap_false.
          EXIT.
        ENDIF.
        lv_any = abap_true.
      ENDLOOP.
      <ls_col>-is_numeric = xsdbool( lv_all = abap_true AND lv_any = abap_true ).
    ENDLOOP.

  ENDMETHOD.


  METHOD clean_value.

    DATA: lv_ms   TYPE string,
          lv_msp  TYPE p LENGTH 16 DECIMALS 0,
          lv_days TYPE i,
          lv_date TYPE d,
          lv_len  TYPE i.

    rv = iv_value.
    rv = shift_left( val = rv sub = ` ` ).
    rv = shift_right( val = rv sub = ` ` ).
    IF rv IS INITIAL.
      RETURN.
    ENDIF.

    " /Date(1640995200000)/ 或 /Date(1640995200000+0000)/ → 2022-01-01
    FIND REGEX '^/Date\((-?[0-9]+)' IN rv SUBMATCHES lv_ms.
    IF sy-subrc = 0.
      TRY.
          lv_msp  = lv_ms.
          lv_days = lv_msp DIV 86400000.
          lv_date = '19700101'.
          lv_date = lv_date + lv_days.
          rv = |{ lv_date DATE = ISO }|.
        CATCH cx_root ##NO_HANDLER.
      ENDTRY.
      RETURN.
    ENDIF.

    " 千分位 1,234,567.89 → 1234567.89
    FIND REGEX '^-?[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?-?$' IN rv.
    IF sy-subrc = 0.
      REPLACE ALL OCCURRENCES OF `,` IN rv WITH ``.
    ENDIF.

    " ABAP 尾负号 100- → -100
    FIND REGEX '^[0-9]+(\.[0-9]+)?-$' IN rv.
    IF sy-subrc = 0.
      lv_len = strlen( rv ) - 1.
      rv = `-` && substring( val = rv len = lv_len ).
    ENDIF.

  ENDMETHOD.


  METHOD is_col_number.

    FIND REGEX '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' IN iv_value.
    rv = xsdbool( sy-subrc = 0 ).

  ENDMETHOD.


  METHOD json_str.

    DATA: lv    TYPE string,
          lv_cr TYPE c LENGTH 1.

    lv = iv.
    lv_cr = cl_abap_char_utilities=>cr_lf.   " 取第一个字符 = CR
    REPLACE ALL OCCURRENCES OF `\` IN lv WITH `\\`.
    REPLACE ALL OCCURRENCES OF `"` IN lv WITH `\"`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN lv WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN lv WITH `\n`.
    REPLACE ALL OCCURRENCES OF lv_cr IN lv WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN lv WITH `\t`.
    rv = `"` && lv && `"`.

  ENDMETHOD.


  METHOD schema_json.

    DATA: ls_col TYPE ty_column,
          lv_sep TYPE string.

    rv = `{"columns":[`.
    LOOP AT is_ds-columns INTO ls_col.
      rv = rv && lv_sep && `{"name":` && json_str( ls_col-name ) &&
           `,"label":` && json_str( ls_col-label ) &&
           `,"numeric":` && COND string( WHEN ls_col-is_numeric = abap_true THEN `true` ELSE `false` ) && `}`.
      lv_sep = `,`.
    ENDLOOP.
    rv = rv && `]}`.

  ENDMETHOD.


  METHOD row_json.

    DATA: ls_row  TYPE ty_row,
          ls_col  TYPE ty_column,
          lv_ci   TYPE i,
          lv_cell TYPE string,
          lv_sep  TYPE string.

    READ TABLE is_ds-rows INTO ls_row INDEX iv_index.
    IF sy-subrc <> 0.
      rv = `{}`.
      RETURN.
    ENDIF.
    rv = `{`.
    LOOP AT is_ds-columns INTO ls_col.
      lv_ci = sy-tabix.
      CLEAR lv_cell.
      READ TABLE ls_row-cells INTO lv_cell INDEX lv_ci.
      rv = rv && lv_sep && json_str( ls_col-name ) && `:`.
      IF ls_col-is_numeric = abap_true AND lv_cell IS NOT INITIAL.
        rv = rv && lv_cell.
      ELSE.
        rv = rv && json_str( lv_cell ).
      ENDIF.
      lv_sep = `,`.
    ENDLOOP.
    rv = rv && `}`.

  ENDMETHOD.


  METHOD flat_object.

    DATA: lo_doc  TYPE REF TO zcl_ai_odata_shaper,
          lt_kids TYPE tt_int,
          lv_id   TYPE i,
          lv_kind TYPE string,
          ls_kv   TYPE ty_kv.

    CLEAR rt.
    CREATE OBJECT lo_doc.
    IF lo_doc->parse( iv_json ) = abap_false.
      RETURN.
    ENDIF.
    IF lo_doc->kind( 1 ) <> 'O'.
      RETURN.
    ENDIF.
    lt_kids = lo_doc->kids( 1 ).
    LOOP AT lt_kids INTO lv_id.
      CLEAR ls_kv.
      ls_kv-name = lo_doc->name_of( lv_id ).
      lv_kind = lo_doc->kind( lv_id ).
      IF lv_kind = 'O' OR lv_kind = 'A'.
        ls_kv-value = lo_doc->to_json( lv_id ).
      ELSE.
        ls_kv-value = lo_doc->text( lv_id ).
      ENDIF.
      APPEND ls_kv TO rt.
    ENDLOOP.

  ENDMETHOD.


  METHOD parse.

    DATA: lo_reader TYPE REF TO if_sxml_reader,
          lo_node   TYPE REF TO if_sxml_node,
          lo_open   TYPE REF TO if_sxml_open_element,
          lo_value  TYPE REF TO if_sxml_value_node,
          lo_err    TYPE REF TO cx_root,
          lt_stack  TYPE tt_int,
          ls_node   TYPE ty_node,
          ls_kid    TYPE ty_kid,
          lv_xjson  TYPE xstring,
          lv_parent TYPE i,
          lv_id     TYPE i,
          lv_depth  TYPE i.
    FIELD-SYMBOLS <ls_n> TYPE ty_node.

    CLEAR: mt_nodes, mt_kids, mv_error, rv_ok.
    IF iv_json IS INITIAL.
      mv_error = 'JSON 为空'.
      RETURN.
    ENDIF.

    TRY.
        lv_xjson  = cl_abap_codepage=>convert_to( source = iv_json ).
        lo_reader = cl_sxml_string_reader=>create( input = lv_xjson ).
        DO.
          lo_node = lo_reader->read_next_node( ).
          IF lo_node IS INITIAL.
            EXIT.
          ENDIF.
          CASE lo_node->type.

            WHEN if_sxml_node=>co_nt_element_open.
              " JSON-XML: <object>/<array>/<str>/<num>/<bool>/<null>, 成员名在属性 name 里
              lo_open ?= lo_node.
              CLEAR: ls_node, ls_kid.
              lv_depth = lines( lt_stack ).
              lv_parent = 0.
              IF lv_depth > 0.
                READ TABLE lt_stack INTO lv_parent INDEX lv_depth.
              ENDIF.
              ls_node-parent = lv_parent.
              CASE lo_open->qname-name.
                WHEN 'object'.
                  ls_node-kind = 'O'.
                WHEN 'array'.
                  ls_node-kind = 'A'.
                WHEN 'str'.
                  ls_node-kind = 'S'.
                WHEN 'num'.
                  ls_node-kind = 'N'.
                WHEN 'bool'.
                  ls_node-kind = 'B'.
                WHEN OTHERS.
                  ls_node-kind = 'Z'.
              ENDCASE.
              DATA(lt_attr) = lo_open->get_attributes( ).
              LOOP AT lt_attr INTO DATA(lo_attr).
                IF lo_attr->qname-name = 'name'.
                  ls_node-name = lo_attr->get_value( ).
                ENDIF.
              ENDLOOP.
              APPEND ls_node TO mt_nodes.
              lv_id = lines( mt_nodes ).
              ls_kid-idx = 1.
              IF lv_parent > 0.
                READ TABLE mt_nodes ASSIGNING <ls_n> INDEX lv_parent.
                IF sy-subrc = 0.
                  <ls_n>-nkids = <ls_n>-nkids + 1.
                  ls_kid-idx = <ls_n>-nkids.
                ENDIF.
              ENDIF.
              ls_kid-parent = lv_parent.
              ls_kid-name   = ls_node-name.
              ls_kid-id     = lv_id.
              INSERT ls_kid INTO TABLE mt_kids.
              APPEND lv_id TO lt_stack.

            WHEN if_sxml_node=>co_nt_value.
              lo_value ?= lo_node.
              lv_depth = lines( lt_stack ).
              IF lv_depth > 0.
                READ TABLE lt_stack INTO lv_id INDEX lv_depth.
                READ TABLE mt_nodes ASSIGNING <ls_n> INDEX lv_id.
                IF sy-subrc = 0.
                  <ls_n>-value = lo_value->get_value( ).
                ENDIF.
              ENDIF.

            WHEN if_sxml_node=>co_nt_element_close.
              lv_depth = lines( lt_stack ).
              IF lv_depth > 0.
                DELETE lt_stack INDEX lv_depth.
              ENDIF.

          ENDCASE.
        ENDDO.
      CATCH cx_root INTO lo_err.
        CLEAR: mt_nodes, mt_kids.
        mv_error = lo_err->get_text( ).
        RETURN.
    ENDTRY.

    rv_ok = xsdbool( lines( mt_nodes ) > 0 ).
    IF rv_ok = abap_false.
      mv_error = 'JSON 没有内容'.
    ENDIF.

  ENDMETHOD.


  METHOD get_error.
    rv = mv_error.
  ENDMETHOD.


  METHOD root.
    rv = COND #( WHEN lines( mt_nodes ) > 0 THEN 1 ELSE 0 ).
  ENDMETHOD.


  METHOD child.

    DATA ls_kid TYPE ty_kid.
    rv = 0.
    IF iv_id <= 0.
      RETURN.
    ENDIF.
    READ TABLE mt_kids INTO ls_kid WITH KEY parent = iv_id name = iv_name.
    IF sy-subrc = 0.
      rv = ls_kid-id.
    ENDIF.

  ENDMETHOD.


  METHOD path.

    DATA: lt_seg TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_seg TYPE string.

    rv = iv_id.
    IF iv_path IS INITIAL OR rv <= 0.
      RETURN.
    ENDIF.
    SPLIT iv_path AT '.' INTO TABLE lt_seg.
    LOOP AT lt_seg INTO lv_seg.
      IF lv_seg IS INITIAL.
        CONTINUE.
      ENDIF.
      rv = child( iv_id = rv iv_name = lv_seg ).
      IF rv = 0.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD kids.

    DATA: ls_kid TYPE ty_kid,
          lt_tmp TYPE STANDARD TABLE OF ty_kid WITH DEFAULT KEY.

    CLEAR rt.
    IF iv_id <= 0.
      RETURN.
    ENDIF.
    LOOP AT mt_kids INTO ls_kid WHERE parent = iv_id.
      APPEND ls_kid TO lt_tmp.
    ENDLOOP.
    SORT lt_tmp BY idx.
    LOOP AT lt_tmp INTO ls_kid.
      APPEND ls_kid-id TO rt.
    ENDLOOP.

  ENDMETHOD.


  METHOD text.

    DATA ls_node TYPE ty_node.
    CLEAR rv.
    IF iv_id <= 0.
      RETURN.
    ENDIF.
    READ TABLE mt_nodes INTO ls_node INDEX iv_id.
    IF sy-subrc = 0 AND ( ls_node-kind = 'S' OR ls_node-kind = 'N' OR ls_node-kind = 'B' ).
      rv = ls_node-value.
    ENDIF.

  ENDMETHOD.


  METHOD kind.

    DATA ls_node TYPE ty_node.
    CLEAR rv.
    IF iv_id <= 0.
      RETURN.
    ENDIF.
    READ TABLE mt_nodes INTO ls_node INDEX iv_id.
    IF sy-subrc = 0.
      rv = ls_node-kind.
    ENDIF.

  ENDMETHOD.


  METHOD name_of.

    DATA ls_node TYPE ty_node.
    CLEAR rv.
    IF iv_id <= 0.
      RETURN.
    ENDIF.
    READ TABLE mt_nodes INTO ls_node INDEX iv_id.
    IF sy-subrc = 0.
      rv = ls_node-name.
    ENDIF.

  ENDMETHOD.


  METHOD to_json.

    DATA: ls_node TYPE ty_node,
          lt_kids TYPE tt_int,
          lt_part TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lv_part TYPE string,
          lv_kid  TYPE i,
          lv_body TYPE string.

    CLEAR rv.
    IF iv_id <= 0.
      RETURN.
    ENDIF.
    READ TABLE mt_nodes INTO ls_node INDEX iv_id.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    CASE ls_node-kind.
      WHEN 'O' OR 'A'.
        lt_kids = kids( iv_id ).
        LOOP AT lt_kids INTO lv_kid.
          IF ls_node-kind = 'O'.
            lv_part = json_str( name_of( lv_kid ) ) && `:` && to_json( lv_kid ).
          ELSE.
            lv_part = to_json( lv_kid ).
          ENDIF.
          APPEND lv_part TO lt_part.
        ENDLOOP.
        CONCATENATE LINES OF lt_part INTO lv_body SEPARATED BY `,`.
        IF ls_node-kind = 'O'.
          rv = `{` && lv_body && `}`.
        ELSE.
          rv = `[` && lv_body && `]`.
        ENDIF.
      WHEN 'S'.
        rv = json_str( ls_node-value ).
      WHEN 'N' OR 'B'.
        rv = ls_node-value.
      WHEN OTHERS.
        rv = `null`.
    ENDCASE.

  ENDMETHOD.


  METHOD cfg.

    DATA: lv_id  TYPE i,
          lv_val TYPE string.

    rv = iv_default.
    lv_id = child( iv_id = root( ) iv_name = iv_key ).
    IF lv_id > 0.
      lv_val = text( lv_id ).
      IF lv_val IS NOT INITIAL.
        rv = lv_val.
      ENDIF.
    ENDIF.

  ENDMETHOD.


  METHOD cfg_list.

    DATA: lv_id   TYPE i,
          lv_item TYPE i,
          lv_val  TYPE string,
          lt_kids TYPE tt_int.

    CLEAR rt.
    lv_id = child( iv_id = root( ) iv_name = iv_key ).
    IF lv_id = 0.
      RETURN.
    ENDIF.
    lt_kids = kids( lv_id ).
    LOOP AT lt_kids INTO lv_item.
      lv_val = text( lv_item ).
      IF lv_val IS NOT INITIAL.
        APPEND lv_val TO rt.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

ENDCLASS.
