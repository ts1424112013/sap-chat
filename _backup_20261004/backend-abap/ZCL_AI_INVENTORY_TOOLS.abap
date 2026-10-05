CLASS zcl_ai_inventory_tools DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    TYPES: BEGIN OF ty_step,
             tool        TYPE string,
             status      TYPE string,
             result_json TYPE string,     " 受限结构化结果(回填模型/审计)
             rows        TYPE i,          " 返回数据行数
             summary     TYPE string,     " Trace/审计摘要(脱敏口径)
             elapsed_ms  TYPE i,
           END OF ty_step.

    CLASS-METHODS execute
      IMPORTING iv_tool        TYPE string
                it_args        TYPE zcl_ai_agent_guard=>tt_kv
      RETURNING VALUE(rs_step) TYPE ty_step.

  PRIVATE SECTION.

    CONSTANTS: gc_cand_max  TYPE i VALUE 10,   " resolve_material 候选上限
               gc_loc_max   TYPE i VALUE 20,   " 库位明细行上限
               gc_batch_max TYPE i VALUE 50.   " 批次明细行上限

    CLASS-METHODS tool_resolve_material
      IMPORTING it_args        TYPE zcl_ai_agent_guard=>tt_kv
      RETURNING VALUE(rs_step) TYPE ty_step.

    CLASS-METHODS tool_stock_snapshot
      IMPORTING it_args        TYPE zcl_ai_agent_guard=>tt_kv
      RETURNING VALUE(rs_step) TYPE ty_step.

    CLASS-METHODS tool_daily_movement
      IMPORTING it_args        TYPE zcl_ai_agent_guard=>tt_kv
      RETURNING VALUE(rs_step) TYPE ty_step.

    CLASS-METHODS tool_batch_stock
      IMPORTING it_args        TYPE zcl_ai_agent_guard=>tt_kv
      RETURNING VALUE(rs_step) TYPE ty_step.

ENDCLASS.

CLASS zcl_ai_inventory_tools IMPLEMENTATION.

  METHOD execute.

    DATA lv_t1 TYPE i.
    DATA lv_t2 TYPE i.
    GET RUN TIME FIELD lv_t1.

    CASE to_lower( iv_tool ).
      WHEN 'resolve_material'.
        rs_step = tool_resolve_material( it_args ).
      WHEN 'get_stock_snapshot'.
        rs_step = tool_stock_snapshot( it_args ).
      WHEN 'get_daily_movement'.
        rs_step = tool_daily_movement( it_args ).
      WHEN 'get_batch_stock'.
        rs_step = tool_batch_stock( it_args ).
      WHEN OTHERS.
        rs_step-tool   = iv_tool.
        rs_step-status = 'ERROR'.
        rs_step-summary = |未注册的工具(不应发生, 白名单已在 GUARD 拦截): { iv_tool }|.
    ENDCASE.

    GET RUN TIME FIELD lv_t2.
    rs_step-elapsed_ms = ( lv_t2 - lv_t1 ) / 1000.

  ENDMETHOD.

  METHOD tool_resolve_material.

    TYPES: BEGIN OF ty_cand,
             matnr TYPE string,
             meins TYPE string,
             mtart TYPE string,
             matkl TYPE string,
             werks TYPE string,       " 传了工厂时给出该料号在此工厂的扩展标志
           END OF ty_cand.
    TYPES: BEGIN OF ty_res,
             found      TYPE i,
             materials  TYPE STANDARD TABLE OF ty_cand WITH DEFAULT KEY,
             note       TYPE string,
           END OF ty_res.

    DATA ls_res TYPE ty_res.

    rs_step-tool = 'resolve_material'.

    DATA(lv_hint) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'material_hint' ).
    DATA(lv_plant) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'plant' ).
    CONDENSE: lv_hint, lv_plant.
    TRANSLATE lv_hint TO UPPER CASE.
    TRANSLATE lv_plant TO UPPER CASE.

    REPLACE ALL OCCURRENCES OF REGEX '[^A-Z0-9*_.-]' IN lv_hint WITH ``.
    IF lv_hint IS INITIAL.
      rs_step-status   = 'ERROR'.
      rs_step-summary  = 'material_hint 清洗后为空, 拒绝检索'.
      RETURN.
    ENDIF.

    IF lv_plant IS NOT INITIAL
       AND zcl_ai_agent_guard=>check_plant_auth( lv_plant ) <> abap_true.
      rs_step-status  = 'DENIED'.
      rs_step-summary = |权限拒绝: 工厂 { lv_plant }(W_WERKS_MAT)|.
      rs_step-result_json = |\{ "status": "DENIED", | &&
                            |"note": "你没有工厂 { lv_plant } 的查询权限, 请向用户说明无法查询该工厂" \}|.
      RETURN.
    ENDIF.

    REPLACE ALL OCCURRENCES OF '*' IN lv_hint WITH '%'.
    IF lv_hint NA '%'.
      IF lv_hint CO '0123456789'.
        WHILE strlen( lv_hint ) < 18.
          lv_hint = |0{ lv_hint }|.
        ENDWHILE.
      ENDIF.
      lv_hint = lv_hint && '%'.
    ENDIF.

    TRY.
        IF lv_plant IS NOT INITIAL.
          SELECT a~matnr, a~meins, a~mtart, a~matkl
            FROM mara AS a INNER JOIN marc AS c
              ON c~matnr = a~matnr
            WHERE a~matnr LIKE @lv_hint
              AND c~werks = @lv_plant
            ORDER BY a~matnr
            INTO TABLE @DATA(lt_mara)
            UP TO @gc_cand_max ROWS.
        ELSE.
          SELECT matnr, meins, mtart, matkl
            FROM mara
            WHERE matnr LIKE @lv_hint
            ORDER BY matnr
            INTO TABLE @lt_mara
            UP TO @gc_cand_max ROWS.
        ENDIF.
      CATCH cx_root INTO DATA(lx_root).
        rs_step-status  = 'ERROR'.
        rs_step-summary = |MARA 读取失败: { lx_root->get_text( ) }|.
        RETURN.
    ENDTRY.

    LOOP AT lt_mara INTO DATA(ls_mara).
      APPEND VALUE #( matnr = ls_mara-matnr
                      meins = ls_mara-meins
                      mtart = ls_mara-mtart
                      matkl = ls_mara-matkl
                      werks = lv_plant ) TO ls_res-materials.
    ENDLOOP.
    ls_res-found = lines( ls_res-materials ).

    IF ls_res-found = 0.
      ls_res-note = '未找到匹配料号(0 条)。主档不存在时不得编造库存或收发数据, 请如实告知用户。'.
    ELSEIF ls_res-found = 1.
      READ TABLE ls_res-materials INTO DATA(ls_one) INDEX 1.
      ls_res-note = |唯一候选 { ls_one-matnr }, 可直接用于后续工具调用。|.
    ELSE.
      ls_res-note = |命中 { ls_res-found } 个候选, 候选不唯一时必须请用户确认后再继续。|.
    ENDIF.

    rs_step-status      = 'OK'.
    rs_step-rows        = ls_res-found.
    rs_step-result_json = /ui2/cl_json=>serialize(
                            data        = ls_res
                            compress    = abap_true
                            pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
    rs_step-summary     = |MARA 前缀 { lv_hint } 命中 { ls_res-found } 条| &&
                          COND #( WHEN lv_plant IS NOT INITIAL
                                  THEN |(工厂 { lv_plant })| ELSE `` ).

  ENDMETHOD.

  METHOD tool_stock_snapshot.

    TYPES: BEGIN OF ty_loc,
             lgort TYPE mard-lgort,
             labst TYPE mard-labst,              " 非限制
             insme TYPE mard-insme,              " 质检
             einme TYPE mard-einme,              " 限制使用
             speme TYPE mard-speme,              " 冻结/冻结库存
             retme TYPE mard-retme,              " 退货
             umlme TYPE mard-umlme,              " 在转
           END OF ty_loc.
    TYPES: BEGIN OF ty_res,
             plant         TYPE string,
             material      TYPE string,
             unit          TYPE string,
             material_type TYPE string,
             batch_managed TYPE string,           " X = 批次管理(MARC.XCHPF)
             totals        TYPE ty_loc,           " 按库存类型合计(同单位)
             locations     TYPE STANDARD TABLE OF ty_loc WITH DEFAULT KEY,
             location_rows TYPE i,                " 实际库存地点总数
             detail_rows   TYPE i,                " 本次返回的库存地点明细数
             truncated     TYPE string,
             note          TYPE string,
           END OF ty_res.

    DATA: ls_res  TYPE ty_res,
          ls_tot  TYPE ty_loc.

    rs_step-tool = 'get_stock_snapshot'.

    DATA(lv_plant) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'plant' ).
    DATA(lv_matnr) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'material' ).

    IF zcl_ai_agent_guard=>check_plant_auth( lv_plant ) <> abap_true.
      rs_step-status  = 'DENIED'.
      rs_step-summary = |权限拒绝: 工厂 { lv_plant }(W_WERKS_MAT)|.
      rs_step-result_json = |\{ "status": "DENIED", | &&
                            |"note": "你没有工厂 { lv_plant } 的查询权限, 请向用户说明无法查询该工厂" \}|.
      RETURN.
    ENDIF.

    ls_res-plant    = lv_plant.
    ls_res-material = lv_matnr.

    SELECT SINGLE matnr, meins, mtart
      FROM mara WHERE matnr = @lv_matnr
      INTO @DATA(ls_mara).
    IF sy-subrc <> 0.
      rs_step-status      = 'OK'.
      rs_step-rows        = 0.
      ls_res-note         = |料号 { lv_matnr } 主档不存在(MARA 0 条)。请如实告知用户, 不要编造库存数字。|.
      rs_step-result_json = /ui2/cl_json=>serialize(
                              data        = ls_res
                              compress    = abap_true
                              pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
      rs_step-summary     = |MARA 主档不存在: { lv_matnr }|.
      RETURN.
    ENDIF.
    ls_res-unit          = ls_mara-meins.
    ls_res-material_type = ls_mara-mtart.

    SELECT SINGLE xchpf FROM marc
      WHERE matnr = @lv_matnr AND werks = @lv_plant
      INTO @DATA(lv_xchpf).
    ls_res-batch_managed = COND #( WHEN sy-subrc = 0 AND lv_xchpf = abap_true THEN 'X' ELSE '' ).

    TRY.
        SELECT SUM( labst ) AS labst,
               SUM( insme ) AS insme,
               SUM( einme ) AS einme,
               SUM( speme ) AS speme,
               SUM( retme ) AS retme,
               SUM( umlme ) AS umlme
          FROM mard
          WHERE matnr = @lv_matnr AND werks = @lv_plant
          INTO CORRESPONDING FIELDS OF @ls_tot.
        SELECT COUNT( * ) FROM mard
          WHERE matnr = @lv_matnr AND werks = @lv_plant
          INTO @DATA(lv_location_total).
        SELECT lgort, labst, insme, einme, speme, retme, umlme
          FROM mard
          WHERE matnr = @lv_matnr AND werks = @lv_plant
          ORDER BY lgort
          INTO TABLE @DATA(lt_mard)  " 修正: 内联声明不能与 INTO CORRESPONDING 连用
          UP TO @gc_loc_max ROWS.
      CATCH cx_root INTO DATA(lx_root).
        rs_step-status  = 'ERROR'.
        rs_step-summary = |MARD 读取失败: { lx_root->get_text( ) }|.
        RETURN.
    ENDTRY.

    LOOP AT lt_mard INTO DATA(ls_mard).
      APPEND VALUE #( lgort = ls_mard-lgort
                      labst = ls_mard-labst
                      insme = ls_mard-insme
                      einme = ls_mard-einme
                      speme = ls_mard-speme
                      retme = ls_mard-retme
                      umlme = ls_mard-umlme ) TO ls_res-locations.
    ENDLOOP.
    ls_res-totals        = ls_tot.
    ls_res-location_rows = lv_location_total.
    ls_res-detail_rows   = lines( lt_mard ).
    ls_res-truncated     = COND #( WHEN lv_location_total > gc_loc_max THEN 'X' ELSE '' ).

    IF ls_res-location_rows = 0.
      ls_res-note = |该料号在工厂 { lv_plant } 的 MARD 无库存记录(有效业务结论, 不是查询失败)。| &&
                    |若为批次管理料号, 批次库存可能在 MCHB, 可调用 get_batch_stock 复核。|.
    ELSE.
      ls_res-note = '库存为查询时点快照(无时间维度); totals 覆盖全部库存地点，LABST 仅非限制库存。'.
      IF ls_res-truncated = 'X'.
        ls_res-note = |{ ls_res-note } 库位明细仅返回前 { gc_loc_max } 条，共 { lv_location_total } 个库存地点。|.
      ENDIF.
    ENDIF.

    rs_step-status      = 'OK'.
    rs_step-rows        = ls_res-location_rows.
    rs_step-result_json = /ui2/cl_json=>serialize(
                            data        = ls_res
                            compress    = abap_true
                            pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
    rs_step-summary     = |MARD { lv_plant }/{ lv_matnr }: { ls_res-location_rows } 个库存地点, | &&
                          |非限制 { ls_tot-labst } { ls_mara-meins }|.

  ENDMETHOD.

  METHOD tool_daily_movement.

    TYPES: BEGIN OF ty_move,
             bwart     TYPE mseg-bwart,           " 移动类型
             direction TYPE string,               " 借(S) / 贷(H)，收发口径由业务移动类型确认
             meins     TYPE mseg-meins,
             qty       TYPE mseg-menge,
           END OF ty_move.
    TYPES: BEGIN OF ty_res,
             plant        TYPE string,
             material     TYPE string,
             posting_date TYPE string,
             movements    TYPE STANDARD TABLE OF ty_move WITH DEFAULT KEY,
             note         TYPE string,
           END OF ty_res.

    DATA ls_res TYPE ty_res.

    rs_step-tool = 'get_daily_movement'.

    DATA(lv_plant) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'plant' ).
    DATA(lv_matnr) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'material' ).
    DATA(lv_budat) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'posting_date' ).

    IF zcl_ai_agent_guard=>check_plant_auth( lv_plant ) <> abap_true.
      rs_step-status  = 'DENIED'.
      rs_step-summary = |权限拒绝: 工厂 { lv_plant }(W_WERKS_MAT)|.
      rs_step-result_json = |\{ "status": "DENIED", | &&
                            |"note": "你没有工厂 { lv_plant } 的查询权限, 请向用户说明无法查询该工厂" \}|.
      RETURN.
    ENDIF.

    IF lv_budat IS INITIAL.
      lv_budat = |{ sy-datum }|.
    ENDIF.
    IF strlen( lv_budat ) <> 8 OR lv_budat CN '0123456789'.
      rs_step-status  = 'ERROR'.
      rs_step-summary = |posting_date 日期值不合法: { lv_budat }|.
      RETURN.
    ENDIF.
    DATA(lv_date) = CONV d( lv_budat ).
    CALL FUNCTION 'DATE_CHECK_PLAUSIBILITY'
      EXPORTING date                       = lv_date
      EXCEPTIONS plausibility_check_failed = 1
                 OTHERS                     = 2.
    IF sy-subrc <> 0.
      rs_step-status  = 'ERROR'.
      rs_step-summary = |posting_date 不是有效日期: { lv_budat }|.
      RETURN.
    ENDIF.

    ls_res-plant        = lv_plant.
    ls_res-material     = lv_matnr.
    ls_res-posting_date = lv_budat.

    TRY.
        SELECT bwart, shkzg, meins, SUM( menge ) AS qty
          FROM mseg
          WHERE budat_mkpf = @lv_date
            AND werks      = @lv_plant
            AND matnr      = @lv_matnr
          GROUP BY bwart, shkzg, meins
          ORDER BY bwart
          INTO TABLE @DATA(lt_sum).
      CATCH cx_root INTO DATA(lx_root).
        rs_step-status  = 'ERROR'.
        rs_step-summary = |MSEG 读取失败: { lx_root->get_text( ) }(S/4 需按 P0-2 验证 MSEG/MATDOC)|.
        RETURN.
    ENDTRY.

    LOOP AT lt_sum INTO DATA(ls_sum).
      APPEND VALUE #( bwart     = ls_sum-bwart
                      direction = CONV #( COND string( WHEN ls_sum-shkzg = 'S' THEN 'S-借'
                                                       WHEN ls_sum-shkzg = 'H' THEN 'H-贷'
                                                       ELSE ls_sum-shkzg ) )
                      meins     = ls_sum-meins
                      qty       = ls_sum-qty ) TO ls_res-movements.
    ENDLOOP.

    IF lines( lt_sum ) = 0.
      ls_res-note = |过账日 { lv_budat } 无收发记录 —— 这是有效业务事实(当天无收发), 不是查询失败。|.
    ELSE.
      ls_res-note = '数量按 移动类型/方向/单位 分组; MEINS 多值时禁止跨单位加总, 报告须分单位呈现。'.
    ENDIF.

    rs_step-status      = 'OK'.
    rs_step-rows        = lines( lt_sum ).
    rs_step-result_json = /ui2/cl_json=>serialize(
                            data        = ls_res
                            compress    = abap_true
                            pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
    rs_step-summary     = |MSEG { lv_plant }/{ lv_matnr } 过账日 { lv_budat }: { rs_step-rows } 组收发|.

  ENDMETHOD.

  METHOD tool_batch_stock.

    TYPES: BEGIN OF ty_batch,
             charg TYPE mchb-charg,
             lgort TYPE mchb-lgort,
             clabs TYPE mchb-clabs,               " 非限制
             cinsm TYPE mchb-cinsm,               " 质检
             cspem TYPE mchb-cspem,               " 冻结
           END OF ty_batch.
    TYPES: BEGIN OF ty_res,
             plant     TYPE string,
             material  TYPE string,
             unit      TYPE string,
             batches   TYPE STANDARD TABLE OF ty_batch WITH DEFAULT KEY,
             note      TYPE string,
           END OF ty_res.

    DATA ls_res TYPE ty_res.

    rs_step-tool = 'get_batch_stock'.

    DATA(lv_plant) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'plant' ).
    DATA(lv_matnr) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'material' ).
    DATA(lv_lgort) = zcl_ai_agent_guard=>kv_get( it_kv = it_args iv_name = 'lgort' ).

    IF zcl_ai_agent_guard=>check_plant_auth( lv_plant ) <> abap_true.
      rs_step-status  = 'DENIED'.
      rs_step-summary = |权限拒绝: 工厂 { lv_plant }(W_WERKS_MAT)|.
      rs_step-result_json = |\{ "status": "DENIED", | &&
                            |"note": "你没有工厂 { lv_plant } 的查询权限, 请向用户说明无法查询该工厂" \}|.
      RETURN.
    ENDIF.

    ls_res-plant    = lv_plant.
    ls_res-material = lv_matnr.

    SELECT SINGLE meins FROM mara
      WHERE matnr = @lv_matnr INTO @DATA(lv_meins).
    ls_res-unit = lv_meins.

    TRY.
        IF lv_lgort IS NOT INITIAL.
          SELECT charg, lgort, clabs, cinsm, cspem
            FROM mchb
            WHERE matnr = @lv_matnr AND werks = @lv_plant AND lgort = @lv_lgort
            ORDER BY charg, lgort
            INTO TABLE @DATA(lt_mchb)  " 修正: 内联声明不能与 INTO CORRESPONDING 连用
            UP TO @gc_batch_max ROWS.
        ELSE.
          SELECT charg, lgort, clabs, cinsm, cspem
            FROM mchb
            WHERE matnr = @lv_matnr AND werks = @lv_plant
            ORDER BY charg, lgort
            INTO CORRESPONDING FIELDS OF TABLE @lt_mchb
            UP TO @gc_batch_max ROWS.
        ENDIF.
      CATCH cx_root INTO DATA(lx_root).
        rs_step-status  = 'ERROR'.
        rs_step-summary = |MCHB 读取失败: { lx_root->get_text( ) }|.
        RETURN.
    ENDTRY.

    LOOP AT lt_mchb INTO DATA(ls_mchb).
      APPEND VALUE #( charg = ls_mchb-charg
                      lgort = ls_mchb-lgort
                      clabs = ls_mchb-clabs
                      cinsm = ls_mchb-cinsm
                      cspem = ls_mchb-cspem ) TO ls_res-batches.
    ENDLOOP.

    IF lines( lt_mchb ) = 0.
      ls_res-note = 'MCHB 无批次记录: 该料号可能不是批次管理, 或当前无批次库存(有效业务事实)。'.
    ELSEIF lines( lt_mchb ) = gc_batch_max.
      ls_res-note = |批次明细已按 { gc_batch_max } 行上限截断, 仅展示前 { gc_batch_max } 条。|.
    ENDIF.

    rs_step-status      = 'OK'.
    rs_step-rows        = lines( lt_mchb ).
    rs_step-result_json = /ui2/cl_json=>serialize(
                            data        = ls_res
                            compress    = abap_true
                            pretty_name = /ui2/cl_json=>pretty_mode-camel_case ).
    rs_step-summary     = |MCHB { lv_plant }/{ lv_matnr }: { rs_step-rows } 条批次| &&
                          COND #( WHEN lv_lgort IS NOT INITIAL
                                  THEN |(库存地点 { lv_lgort })| ELSE `` ).

  ENDMETHOD.

ENDCLASS.
