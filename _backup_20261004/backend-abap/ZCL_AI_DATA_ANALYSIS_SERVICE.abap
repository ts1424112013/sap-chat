*=======================================================================
* 对象:   ZCL_AI_DATA_ANALYSIS_SERVICE
* 用途:   SAP 数据分析公共服务(《SAP数据分析能力_开发计划_V1.0_20261002》§5/§6/§8)
*         - 能力目录: 声明实体/字段/维度/指标/操作/上限/权限(P0 固定注册
*           MARA, P2 迁移配置表); 未注册实体/字段一律拒绝
*         - 查询计划校验: 只接受结构化计划(intent/queries), 不接受 SQL、
*           动态表名和任意 OData URL; 操作符白名单 eq/ne/like/ge/le/between
*         - 受控查询执行: detail/group/trend 三种操作, 每条查询独立执行、
*           独立返回; 单条失败不丢弃其他数据集(status/error 保留)
*         - 统一数据集: columns/rows/total_rows/truncated/elapsed_ms,
*           手工序列化 JSON(数值列不加引号, 与计划 §8 契约一致)
*         - 结构化分析 JSON 组装: summary/findings/charts + datasets
*           (模型输出先经 ZCL_AI_AGENT_GUARD 清洗, 本类只做安全转义拼装)
* 安全:   - 过滤值白名单字符集(A-Z0-9_./-*), 单引号二次转义兜底
*         - 日期值必须 YYYYMMDD 且通过 DATE_CHECK_PLAUSIBILITY
*         - 列名/表名只来自能力目录白名单, 不拼接任何模型输入
*         - 只读 SELECT; 行数上限 = min(能力声明, 10000 绝对上限)+1 探测截断
*         - MARA 无工厂字段, P0 不做 W_WERKS_MAT 检查; 表级授权按
*           S_TABU_DIS/S_TABU_NAM 在 SAP 端确认(见计划 §11)
* 依赖:   无 ABAP 类依赖(纯本地查询), 被 ZCL_AI_AGENT_SERVICE /
*         ZCL_AI_AGENT_GUARD / ZCL_ZAI_CHAT_DPC_EXT 消费
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (适用 S/4HANA 760, ABAP 7.5x)
* 激活顺序: 本类 -> ZCL_AI_TOOL_REGISTRY -> ZCL_AI_AGENT_GUARD
*           -> ZCL_AI_AGENT_SERVICE -> ZCL_ZAI_CHAT_DPC_EXT
*=======================================================================
CLASS zcl_ai_data_analysis_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " ---- 能力目录: 实体字段声明 ----
    TYPES: BEGIN OF ty_field,
             name      TYPE string,      " 字段名(白名单键, 大写)
             label     TYPE string,      " 业务标签(数据集列名)
             ftype     TYPE c LENGTH 1,  " C=字符 D=日期 N=数值
             length    TYPE i,           " 字段长度上限(过滤值校验)
             dimension TYPE abap_bool,   " X = 可作为分组维度
             numeric   TYPE abap_bool,   " X = JSON 数值输出(不加引号)
           END OF ty_field.
    TYPES tt_field TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_capability,
             entity           TYPE string,   " 实体名(白名单键)
             label            TYPE string,
             fields           TYPE tt_field,
             operations       TYPE string,   " 逗号分隔: detail,group,trend
             metrics          TYPE string,   " 支持的指标: count
             date_field       TYPE string,   " trend 专用日期字段
             max_rows         TYPE i,        " 单数据集行数上限
             timeout_sec      TYPE i,
             permission       TYPE string,   " 权限要求说明(前端展示)
             sensitive_fields TYPE string,   " 敏感字段说明(不入目录即不返回)
           END OF ty_capability.
    TYPES tt_capability TYPE STANDARD TABLE OF ty_capability WITH DEFAULT KEY.

    " ---- 查询计划(模型唯一可输出的取数协议, 计划 §6) ----
    TYPES: BEGIN OF ty_filter,
             field    TYPE string,
             operator TYPE string,        " eq/ne/like/ge/le/between
             value    TYPE string,
             value_to TYPE string,        " 仅 between 使用
           END OF ty_filter.
    TYPES tt_filter TYPE STANDARD TABLE OF ty_filter WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_query,
             name       TYPE string,
             entity     TYPE string,
             operation  TYPE string,       " detail/group/trend
             dimensions TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
             metrics    TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
             filters    TYPE tt_filter,
           END OF ty_query.
    TYPES tt_query TYPE STANDARD TABLE OF ty_query WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_plan,
             intent  TYPE string,           " 固定 table_analysis
             queries TYPE tt_query,
           END OF ty_plan.

    " ---- 统一数据集(计划 §8) ----
    TYPES: BEGIN OF ty_column,
             name    TYPE string,
             label   TYPE string,
             numeric TYPE abap_bool,      " X = 数值列(JSON 不加引号)
           END OF ty_column.
    TYPES tt_column TYPE STANDARD TABLE OF ty_column WITH DEFAULT KEY.

    TYPES tt_cells TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    TYPES tt_rows  TYPE STANDARD TABLE OF tt_cells WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_dataset,
             name       TYPE string,
             status     TYPE string,       " OK / DENIED / ERROR
             error      TYPE string,       " 用户可读错误(已脱敏)
             columns    TYPE tt_column,
             rows       TYPE tt_rows,
             total_rows TYPE i,
             truncated  TYPE abap_bool,
             elapsed_ms TYPE i,
             source     TYPE string,
           END OF ty_dataset.
    TYPES tt_dataset TYPE STANDARD TABLE OF ty_dataset WITH DEFAULT KEY.

    " ---- 模型结构化分析结果(计划 §9; 字段经 GUARD 清洗后传入) ----
    TYPES: BEGIN OF ty_finding,
             title    TYPE string,
             detail   TYPE string,
             severity TYPE string,         " info/warn/error
           END OF ty_finding.
    TYPES tt_finding TYPE STANDARD TABLE OF ty_finding WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_chart,
             type    TYPE string,           " bar/line/pie
             title   TYPE string,
             dataset TYPE string,           " 引用数据集名称
             x       TYPE string,
             y       TYPE string,
           END OF ty_chart.
    TYPES tt_chart TYPE STANDARD TABLE OF ty_chart WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_analysis,
             summary  TYPE string,
             findings TYPE tt_finding,
             charts   TYPE tt_chart,
           END OF ty_analysis.

    CONSTANTS: gc_intent      TYPE string VALUE 'table_analysis',
               gc_max_queries TYPE i VALUE 4,      " 单请求查询上限(计划 §7)
               gc_abs_row_max TYPE i VALUE 10000,  " 单数据集绝对行上限(计划 §8)
               gc_model_chars TYPE i VALUE 120000, " 回填模型总字符预算(计划 §8)
               gc_source      TYPE string VALUE 'SAP ABAP Service'.

    " 能力目录(P0 固定注册; P2 迁配置表)
    CLASS-METHODS get_capabilities
      RETURNING VALUE(rt_caps) TYPE tt_capability.

    " 计划白名单校验: 实体/字段/维度/指标/操作/操作符/过滤值全量核对
    " (通过返回空, 否则返回用户可读错误; 不修改计划)
    CLASS-METHODS validate_plan
      IMPORTING is_plan       TYPE ty_plan
      RETURNING VALUE(rv_err) TYPE string.

    " 执行计划: 每条查询独立执行与返回(单条失败不丢弃其他数据集);
    " 执行前对每条查询做防御性二次校验
    CLASS-METHODS execute_plan
      IMPORTING is_plan         TYPE ty_plan
      RETURNING VALUE(rt_datas) TYPE tt_dataset.

    " 数据集数组 -> JSON(数值列不加引号; iv_max_chars > 0 时按行裁剪并
    " 注明截断, 用于回填模型; 0 表示不裁剪, 用于 AnalysisJson)
    CLASS-METHODS build_datasets_json
      IMPORTING it_datas     TYPE tt_dataset
                iv_max_chars TYPE i DEFAULT gc_model_chars
      RETURNING VALUE(rv)    TYPE string.

    " 结构化分析 + 数据集 -> AnalysisJson(计划 §9; 全量数据集供前端渲染)
    CLASS-METHODS build_analysis_json
      IMPORTING is_analysis TYPE ty_analysis
                it_datas    TYPE tt_dataset
      RETURNING VALUE(rv)   TYPE string.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_group_row,
             dimval TYPE c LENGTH 18,   " 维度值统一 CHAR18(DATS 可转换)
             cnt    TYPE i,
           END OF ty_group_row.

    " 单条查询校验(消息带序号前缀; validate_plan / execute_plan 共用)
    CLASS-METHODS validate_query
      IMPORTING iv_index      TYPE i
                is_query      TYPE ty_query
      RETURNING VALUE(rv_err) TYPE string.

    " 单条查询执行 -> 统一数据集
    CLASS-METHODS exec_query
      IMPORTING is_query      TYPE ty_query
      RETURNING VALUE(rs_ds)  TYPE ty_dataset.

    " 过滤条件 -> 动态 WHERE 片段(值已过白名单, 单引号再转义兜底)
    CLASS-METHODS build_where
      IMPORTING is_cap        TYPE ty_capability
                it_filters    TYPE tt_filter
                iv_trend      TYPE abap_bool
      RETURNING VALUE(rv)     TYPE string.

    " 按字段类型格式化单元格(日期 ISO; 空值 -> (空); 去尾部空格)
    CLASS-METHODS format_cell
      IMPORTING is_field      TYPE ty_field
                iv_raw        TYPE clike
      RETURNING VALUE(rv)     TYPE string.

    " JSON 字符串字面量(转义 \ " 与换行/制表)
    CLASS-METHODS json_str
      IMPORTING iv            TYPE clike
      RETURNING VALUE(rv)     TYPE string.

    " 过滤值统一校验与规范化(大写/料号补零; CHANGING 回写规范值)
    CLASS-METHODS check_value
      IMPORTING iv_field      TYPE ty_field
                iv_op         TYPE string
      CHANGING  cv_val        TYPE string
      RETURNING VALUE(rv_err) TYPE string.

    " 能力目录查找(大小写不敏感)
    CLASS-METHODS find_cap
      IMPORTING iv_entity     TYPE string
      RETURNING VALUE(rs_cap) TYPE ty_capability.

    " 字段查找(大小写不敏感; 未注册返回空 name)
    CLASS-METHODS find_field
      IMPORTING is_cap        TYPE ty_capability
                iv_name       TYPE string
      RETURNING VALUE(rs_fld) TYPE ty_field.

ENDCLASS.


CLASS zcl_ai_data_analysis_service IMPLEMENTATION.


  METHOD get_capabilities.

    CLEAR rt_caps.

    " ---- P0: 仅注册 MARA(物料主档), 计划 §5 ----
    " 字段即列白名单(返回投影) + 可过滤字段 + 可分组维度;
    " 敏感字段不进目录即不会出现在任何结果中
    DATA ls_cap TYPE ty_capability.
    ls_cap-entity           = 'MARA'.
    ls_cap-label            = '物料主档'.
    ls_cap-operations       = 'detail,group,trend'.
    ls_cap-metrics          = 'count'.
    ls_cap-date_field       = 'ERSDA'.
    ls_cap-max_rows         = 1000.
    ls_cap-timeout_sec      = 30.
    ls_cap-permission       = 'S_TABU_DIS/S_TABU_NAM(需SAP端确认)'.
    CLEAR ls_cap-sensitive_fields.

    APPEND VALUE #( name = 'MATNR' label = '物料号'   ftype = 'C' length = 18
                    dimension = abap_true ) TO ls_cap-fields.
    APPEND VALUE #( name = 'MTART' label = '物料类型' ftype = 'C' length = 4
                    dimension = abap_true ) TO ls_cap-fields.
    APPEND VALUE #( name = 'MATKL' label = '物料组'   ftype = 'C' length = 9
                    dimension = abap_true ) TO ls_cap-fields.
    APPEND VALUE #( name = 'ERSDA' label = '创建日期' ftype = 'D' length = 8
                    dimension = abap_true ) TO ls_cap-fields.
    APPEND VALUE #( name = 'MEINS' label = '基本单位' ftype = 'C' length = 3
                    dimension = abap_true ) TO ls_cap-fields.

    APPEND ls_cap TO rt_caps.

  ENDMETHOD.


  METHOD validate_plan.

    CLEAR rv_err.

    IF is_plan-intent <> gc_intent.
      rv_err = |计划 intent 必须为 { gc_intent }|.
      RETURN.
    ENDIF.

    DATA(lv_n) = lines( is_plan-queries ).
    IF lv_n = 0.
      rv_err = '计划缺少查询(queries 不能为空)'.
      RETURN.
    ENDIF.
    IF lv_n > gc_max_queries.
      rv_err = |查询数量 { lv_n } 超过单请求上限 { gc_max_queries }|.
      RETURN.
    ENDIF.

    LOOP AT is_plan-queries INTO DATA(ls_q).
      rv_err = validate_query( iv_index = sy-tabix is_query = ls_q ).
      IF rv_err IS NOT INITIAL.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD validate_query.

    CLEAR rv_err.

    DATA(ls_cap) = find_cap( is_query-entity ).
    IF ls_cap-entity IS INITIAL.
      rv_err = |查询 { iv_index }: 实体 { is_query-entity } 不在能力目录中, 当前支持: MARA|.
      RETURN.
    ENDIF.

    DATA(lv_op) = to_lower( is_query-operation ).
    CONDENSE lv_op NO-GAPS.

    " 操作必须在实体声明的 operations 内
    SPLIT ls_cap-operations AT ',' INTO TABLE DATA(lt_ops).
    DATA lv_op_ok TYPE abap_bool.
    lv_op_ok = abap_false.
    LOOP AT lt_ops INTO DATA(lv_op_reg).
      CONDENSE lv_op_reg.
      IF lv_op = lv_op_reg.
        lv_op_ok = abap_true.
      ENDIF.
    ENDLOOP.
    IF lv_op_ok = abap_false.
      rv_err = |查询 { iv_index }: 实体 { ls_cap-entity } 不支持操作 { is_query-operation }|.
      RETURN.
    ENDIF.

    " ---- 维度规则: detail 无维度; group 恰好 1 个声明维度;
    "      trend 恰好 1 个且必须为目录声明的日期字段 ----
    DATA(lv_ndim) = lines( is_query-dimensions ).
    CASE lv_op.
      WHEN 'detail'.
        IF lv_ndim > 0.
          rv_err = |查询 { iv_index }: operation=detail 不允许 dimensions|.
          RETURN.
        ENDIF.
      WHEN 'group'.
        IF lv_ndim <> 1.
          rv_err = |查询 { iv_index }: operation=group 需要且仅需要 1 个维度|.
          RETURN.
        ENDIF.
      WHEN 'trend'.
        IF lv_ndim <> 1.
          rv_err = |查询 { iv_index }: operation=trend 需要且仅需要 1 个日期维度|.
          RETURN.
        ENDIF.
      WHEN OTHERS.
        rv_err = |查询 { iv_index }: 未知操作 { is_query-operation }|.
        RETURN.
    ENDCASE.

    LOOP AT is_query-dimensions INTO DATA(lv_dim).
      DATA(ls_fld) = find_field( is_cap = ls_cap iv_name = lv_dim ).
      IF ls_fld-name IS INITIAL OR ls_fld-dimension <> abap_true.
        rv_err = |查询 { iv_index }: 维度 { lv_dim } 不是实体 { ls_cap-entity } 声明的可分组字段|.
        RETURN.
      ENDIF.
      IF lv_op = 'trend' AND ls_fld-name <> ls_cap-date_field.
        rv_err = |查询 { iv_index }: trend 仅支持日期维度 { ls_cap-date_field }|.
        RETURN.
      ENDIF.
    ENDLOOP.

    " ---- 指标规则: detail 无指标; group/trend 仅 count ----
    DATA(lv_nmet) = lines( is_query-metrics ).
    IF lv_op = 'detail'.
      IF lv_nmet > 0.
        rv_err = |查询 { iv_index }: operation=detail 不允许 metrics|.
        RETURN.
      ENDIF.
    ELSE.
      IF lv_nmet <> 1.
        rv_err = |查询 { iv_index }: { lv_op } 需要且仅需要 1 个指标|.
        RETURN.
      ENDIF.
      READ TABLE is_query-metrics INTO DATA(lv_met) INDEX 1.
      IF to_lower( lv_met ) <> 'count'.
        rv_err = |查询 { iv_index }: 指标 { lv_met } 不支持, 仅允许 count|.
        RETURN.
      ENDIF.
    ENDIF.

    " ---- 过滤条件: 字段/操作符白名单 + 值字符集/长度/日期校验 ----
    DATA lt_seen TYPE tt_filter.
    DATA(lv_nflt) = lines( is_query-filters ).
    IF lv_nflt > 10.
      rv_err = |查询 { iv_index }: 过滤条件超过 10 个上限|.
      RETURN.
    ENDIF.

    LOOP AT is_query-filters INTO DATA(ls_f).

      ls_fld = find_field( is_cap = ls_cap iv_name = ls_f-field ).
      IF ls_fld-name IS INITIAL.
        rv_err = |查询 { iv_index }: 过滤字段 { ls_f-field } 不是实体 { ls_cap-entity } 声明的字段|.
        RETURN.
      ENDIF.

      DATA(lv_opf) = to_lower( ls_f-operator ).
      CONDENSE lv_opf NO-GAPS.
      CASE lv_opf.
        WHEN 'eq' OR 'ne' OR 'like' OR 'ge' OR 'le' OR 'between'.
        WHEN OTHERS.
          rv_err = |查询 { iv_index }: 不支持的操作符 { ls_f-operator }|.
          RETURN.
      ENDCASE.

      " 重复过滤字段拒绝(同字段区间请用 between)
      READ TABLE lt_seen TRANSPORTING NO FIELDS WITH KEY field = ls_fld-name.
      IF sy-subrc = 0.
        rv_err = |查询 { iv_index }: 过滤字段重复: { ls_fld-name }|.
        RETURN.
      ENDIF.
      APPEND VALUE #( field = ls_fld-name ) TO lt_seen.

      " like 仅字符字段
      IF lv_opf = 'like' AND ls_fld-ftype <> 'C'.
        rv_err = |查询 { iv_index }: 操作符 like 仅支持字符字段, { ls_fld-name } 不适用|.
        RETURN.
      ENDIF.

      " 主值校验
      DATA lv_val TYPE string.
      lv_val = ls_f-value.
      CONDENSE lv_val.
      IF lv_val IS INITIAL.
        rv_err = |查询 { iv_index }: 过滤字段 { ls_fld-name } 缺少 value|.
        RETURN.
      ENDIF.
      rv_err = check_value( EXPORTING iv_field = ls_fld iv_op = lv_opf
                             CHANGING  cv_val  = lv_val ).
      IF rv_err IS NOT INITIAL.
        RETURN.
      ENDIF.

      " between 必须带 value_to
      IF lv_opf = 'between'.
        DATA lv_val2 TYPE string.
        lv_val2 = ls_f-value_to.
        CONDENSE lv_val2.
        IF lv_val2 IS INITIAL.
          rv_err = |查询 { iv_index }: 过滤字段 { ls_fld-name } 使用 between 时缺少 value_to|.
          RETURN.
        ENDIF.
        rv_err = check_value( EXPORTING iv_field = ls_fld iv_op = 'eq'
                               CHANGING  cv_val  = lv_val2 ).
        IF rv_err IS NOT INITIAL.
          RETURN.
        ENDIF.
      ENDIF.

    ENDLOOP.

  ENDMETHOD.


  METHOD execute_plan.

    CLEAR rt_datas.

    LOOP AT is_plan-queries INTO DATA(ls_q).

      " 防御性二次校验: 不通过记 ERROR 数据集, 不中断其他查询
      DATA(lv_verr) = validate_query( iv_index = sy-tabix is_query = ls_q ).
      IF lv_verr IS NOT INITIAL.
        APPEND VALUE #( name      = COND #( WHEN ls_q-name IS INITIAL
                                            THEN |查询 { sy-tabix }| ELSE ls_q-name )
                        status    = 'ERROR'
                        error     = lv_verr
                        source    = gc_source ) TO rt_datas.
        CONTINUE.
      ENDIF.

      DATA(ls_ds) = exec_query( ls_q ).
      APPEND ls_ds TO rt_datas.

    ENDLOOP.

  ENDMETHOD.


  METHOD exec_query.

    CLEAR rs_ds.

    DATA: lv_t0 TYPE i,
          lv_t1 TYPE i,
          ls_cells TYPE tt_cells.
    GET RUN TIME FIELD lv_t0.

    " 查询名兜底(模型可省略 name)
    rs_ds-name = COND #( WHEN is_query-name IS INITIAL
                         THEN '未命名查询' ELSE is_query-name ).
    rs_ds-source = gc_source.

    DATA(ls_cap) = find_cap( is_query-entity ).
    IF ls_cap-entity IS INITIAL.
      rs_ds-status = 'ERROR'.
      rs_ds-error  = |实体 { is_query-entity } 不在能力目录中|.
      RETURN.
    ENDIF.

    DATA(lv_op) = to_lower( is_query-operation ).
    DATA(lv_cap) = COND i( WHEN ls_cap-max_rows < gc_abs_row_max
                           THEN ls_cap-max_rows ELSE gc_abs_row_max ).
    " 上限+1 探测截断
    DATA(lv_fetch) = lv_cap + 1.

    " ---- 动态 WHERE(过滤值已经 validate_query 白名单校验) ----
    DATA(lv_where) = build_where( is_cap     = ls_cap
                                  it_filters = is_query-filters
                                  iv_trend   = COND #( WHEN lv_op = 'trend'
                                                       THEN abap_true
                                                       ELSE abap_false ) ).

    TRY.
        CASE lv_op.

          WHEN 'detail'.
            " 固定列投影 = 能力目录声明字段(计划 §11 返回字段按白名单投影)
            SELECT matnr, mtart, matkl, ersda, meins
              FROM mara
              WHERE (lv_where)
              ORDER BY matnr
              INTO TABLE @DATA(lt_detail)
              UP TO @lv_fetch ROWS.

            rs_ds-columns = VALUE #(
              ( name = 'MATNR' label = '物料号'   numeric = abap_false )
              ( name = 'MTART' label = '物料类型' numeric = abap_false )
              ( name = 'MATKL' label = '物料组'   numeric = abap_false )
              ( name = 'ERSDA' label = '创建日期' numeric = abap_false )
              ( name = 'MEINS' label = '基本单位' numeric = abap_false ) ).

            DATA(ls_f_matnr) = find_field( is_cap = ls_cap iv_name = 'MATNR' ).
            DATA(ls_f_mtart) = find_field( is_cap = ls_cap iv_name = 'MTART' ).
            DATA(ls_f_matkl) = find_field( is_cap = ls_cap iv_name = 'MATKL' ).
            DATA(ls_f_ersda) = find_field( is_cap = ls_cap iv_name = 'ERSDA' ).
            DATA(ls_f_meins) = find_field( is_cap = ls_cap iv_name = 'MEINS' ).

            LOOP AT lt_detail INTO DATA(ls_d).
              CLEAR ls_cells.
              APPEND format_cell( is_field = ls_f_matnr iv_raw = ls_d-matnr ) TO ls_cells.
              APPEND format_cell( is_field = ls_f_mtart iv_raw = ls_d-mtart ) TO ls_cells.
              APPEND format_cell( is_field = ls_f_matkl iv_raw = ls_d-matkl ) TO ls_cells.
              APPEND format_cell( is_field = ls_f_ersda iv_raw = ls_d-ersda ) TO ls_cells.
              APPEND format_cell( is_field = ls_f_meins iv_raw = ls_d-meins ) TO ls_cells.
              APPEND ls_cells TO rs_ds-rows.
            ENDLOOP.

          WHEN OTHERS.
            " group / trend: 动态维度分组计数(维度名来自白名单标识符)
            DATA(lv_dim) = CONV string( is_query-dimensions[ 1 ] ).
            TRANSLATE lv_dim TO UPPER CASE.
            DATA(ls_dimf) = find_field( is_cap = ls_cap iv_name = lv_dim ).

            DATA lt_group TYPE STANDARD TABLE OF ty_group_row WITH DEFAULT KEY.
            DATA(lv_cols) = |{ lv_dim } AS dimval, COUNT( * ) AS cnt|.

            SELECT (lv_cols)
              FROM mara
              WHERE (lv_where)
              GROUP BY (lv_dim)
              INTO CORRESPONDING FIELDS OF TABLE @lt_group
              UP TO @lv_fetch ROWS.

            IF lv_op = 'group'.
              SORT lt_group BY cnt DESCENDING.
            ELSE.
              SORT lt_group BY dimval ASCENDING.
            ENDIF.

            rs_ds-columns = VALUE #(
              ( name = ls_dimf-name label = ls_dimf-label numeric = abap_false )
              ( name = 'COUNT' label = '数量' numeric = abap_true ) ).

            LOOP AT lt_group INTO DATA(ls_g).
              CLEAR ls_cells.
              APPEND format_cell( is_field = ls_dimf iv_raw = ls_g-dimval ) TO ls_cells.
              APPEND CONV string( ls_g-cnt ) TO ls_cells.
              APPEND ls_cells TO rs_ds-rows.
            ENDLOOP.

        ENDCASE.

      CATCH cx_root INTO DATA(lx_root).
        rs_ds-status = 'ERROR'.
        rs_ds-error  = |SAP 查询执行失败: { lx_root->get_text( ) }|.
        GET RUN TIME FIELD lv_t1.
        rs_ds-elapsed_ms = ( lv_t1 - lv_t0 ) / 1000.
        RETURN.
    ENDTRY.

    " ---- 截断探测(取回上限+1 行则标记 truncated) ----
    DATA(lv_lines) = lines( rs_ds-rows ).
    IF lv_lines > lv_cap.
      DELETE rs_ds-rows INDEX lv_lines.
      rs_ds-truncated = abap_true.
      lv_lines = lv_cap.
    ENDIF.
    rs_ds-total_rows = lv_lines.
    rs_ds-status     = 'OK'.

    GET RUN TIME FIELD lv_t1.
    rs_ds-elapsed_ms = ( lv_t1 - lv_t0 ) / 1000.

  ENDMETHOD.


  METHOD build_where.

    DATA lt_pieces TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    " trend: 排除空日期(00000000)
    IF iv_trend = abap_true AND is_cap-date_field IS NOT INITIAL.
      APPEND |{ is_cap-date_field } <> '00000000'| TO lt_pieces.
    ENDIF.

    LOOP AT it_filters INTO DATA(ls_f).

      DATA(ls_fld) = find_field( is_cap = is_cap iv_name = ls_f-field ).
      IF ls_fld-name IS INITIAL.
        CONTINUE.   " 已被 validate_query 拒绝, 双保险跳过
      ENDIF.

      DATA(lv_op) = to_lower( ls_f-operator ).
      CONDENSE lv_op NO-GAPS.

      " 统一走 check_value: 二次校验 + 规范化(大写/料号补零)双保险
      DATA lv_val TYPE string.
      lv_val = CONV string( ls_f-value ).
      CONDENSE lv_val.
      DATA(lv_verr) = check_value( EXPORTING iv_field = ls_fld iv_op = lv_op
                                   CHANGING  cv_val  = lv_val ).
      IF lv_verr IS NOT INITIAL.
        CONTINUE.   " 校验不过的过滤条件直接丢弃(validate_query 已拦截, 不应发生)
      ENDIF.
      " 兜底转义(白名单已排除单引号)
      REPLACE ALL OCCURRENCES OF `'` IN lv_val WITH `''`.

      DATA lv_val2 TYPE string.
      CLEAR lv_val2.
      IF lv_op = 'between'.
        lv_val2 = CONV string( ls_f-value_to ).
        CONDENSE lv_val2.
        DATA(lv_verr2) = check_value( EXPORTING iv_field = ls_fld iv_op = 'eq'
                                      CHANGING  cv_val  = lv_val2 ).
        IF lv_verr2 IS NOT INITIAL.
          CONTINUE.
        ENDIF.
        REPLACE ALL OCCURRENCES OF `'` IN lv_val2 WITH `''`.
      ENDIF.

      " like 通配符 * -> %
      IF lv_op = 'like'.
        REPLACE ALL OCCURRENCES OF `*` IN lv_val WITH `%`.
      ENDIF.

      CASE lv_op.
        WHEN 'eq'.
          APPEND |{ ls_fld-name } = '{ lv_val }'| TO lt_pieces.
        WHEN 'ne'.
          APPEND |{ ls_fld-name } <> '{ lv_val }'| TO lt_pieces.
        WHEN 'like'.
          APPEND |{ ls_fld-name } LIKE '{ lv_val }'| TO lt_pieces.
        WHEN 'ge'.
          APPEND |{ ls_fld-name } >= '{ lv_val }'| TO lt_pieces.
        WHEN 'le'.
          APPEND |{ ls_fld-name } <= '{ lv_val }'| TO lt_pieces.
        WHEN 'between'.
          APPEND |{ ls_fld-name } BETWEEN '{ lv_val }' AND '{ lv_val2 }'| TO lt_pieces.
      ENDCASE.

    ENDLOOP.

    " 无条件时退回恒真片段(避免动态空 WHERE 语法错误; 行数上限仍生效)
    IF lt_pieces IS INITIAL.
      DATA lv_first TYPE string.
      lv_first = 'MATNR'.
      IF is_cap-fields IS NOT INITIAL.
        lv_first = is_cap-fields[ 1 ]-name.
      ENDIF.
      rv = |{ lv_first } <> ''|.
      RETURN.
    ENDIF.

    CONCATENATE LINES OF lt_pieces INTO rv SEPARATED BY ' AND '.

  ENDMETHOD.


  METHOD format_cell.

    DATA lv_s TYPE string.
    lv_s = |{ iv_raw }|.          " 字符模板去掉 CHAR 尾部空格

    IF is_field-ftype = 'D'.
      " DATS -> ISO(YYYY-MM-DD); 空日期输出空串
      DATA(lv_raw) = CONV string( iv_raw ).
      IF strlen( lv_raw ) = 8 AND lv_raw <> '00000000'.
        lv_s = |{ lv_raw(4) }-{ lv_raw+4(2) }-{ lv_raw+6(2) }|.
      ELSE.
        CLEAR lv_s.
      ENDIF.
    ENDIF.

    IF lv_s IS INITIAL.
      rv = '(空)'.
    ELSE.
      rv = lv_s.
    ENDIF.

  ENDMETHOD.


  METHOD json_str.

    rv = CONV string( iv ).

    REPLACE ALL OCCURRENCES OF `\` IN rv WITH `\\`.
    REPLACE ALL OCCURRENCES OF `"` IN rv WITH `\"`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv WITH `\t`.

    rv = |"{ rv }"|.

  ENDMETHOD.


  METHOD find_cap.

    CLEAR rs_cap.
    DATA(lv_e) = to_upper( iv_entity ).
    CONDENSE lv_e NO-GAPS.

    LOOP AT get_capabilities( ) INTO DATA(ls_cap).
      IF ls_cap-entity = lv_e.
        rs_cap = ls_cap.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD find_field.

    CLEAR rs_fld.
    DATA(lv_n) = to_upper( iv_name ).
    CONDENSE lv_n NO-GAPS.

    LOOP AT is_cap-fields INTO DATA(ls_f).
      IF ls_f-name = lv_n.
        rs_fld = ls_f.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD check_value.

    CLEAR rv_err.

    " 过滤值统一校验: 日期 YYYYMMDD+合理性 / 字符白名单+长度;
    " 通过校验的值原地规范化(CHANGING 回写), build_where 直接采用
    IF iv_field-ftype = 'D'.
      IF strlen( cv_val ) <> 8 OR cv_val CN '0123456789'.
        rv_err = |过滤字段 { iv_field-name } 日期格式应为 YYYYMMDD: { cv_val }|.
        RETURN.
      ENDIF.
      CALL FUNCTION 'DATE_CHECK_PLAUSIBILITY'
        EXPORTING date                      = CONV d( cv_val )
        EXCEPTIONS plausibility_check_failed = 1
                   OTHERS                    = 2.
      IF sy-subrc <> 0.
        rv_err = |过滤字段 { iv_field-name } 不是有效日期: { cv_val }|.
        RETURN.
      ENDIF.
      RETURN.
    ENDIF.

    TRANSLATE cv_val TO UPPER CASE.
    IF iv_op = 'like'.
      " like 允许通配符 *
      IF cv_val CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-*'.
        rv_err = |过滤值含不允许的字符(字段 { iv_field-name }): { cv_val }|.
        RETURN.
      ENDIF.
    ELSE.
      IF cv_val CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-'.
        rv_err = |过滤值含不允许的字符(字段 { iv_field-name }): { cv_val }|.
        RETURN.
      ENDIF.
    ENDIF.
    IF strlen( cv_val ) > iv_field-length + 2.
      rv_err = |过滤值超过字段 { iv_field-name } 长度上限|.
      RETURN.
    ENDIF.
    " 数值型料号补前导零(与库存工具口径一致)
    IF iv_field-name = 'MATNR' AND iv_op <> 'like' AND cv_val CO '0123456789'.
      WHILE strlen( cv_val ) < 18.
        cv_val = |0{ cv_val }|.
      ENDWHILE.
    ENDIF.

  ENDMETHOD.


  METHOD build_datasets_json.

    " 组织: [ {name,status,error,columns,rows,total_rows,truncated,
    "          elapsed_ms,source} ]
    " 数值列不加引号(计划 §8 契约); iv_max_chars > 0 时按行裁剪并注明
    " (仅用于回填模型), = 0 时不裁剪(AnalysisJson 用)

    rv = `[`.

    LOOP AT it_datas INTO DATA(ls_ds).

      IF sy-tabix > 1.
        rv = rv && `,`.
      ENDIF.

      rv = rv && `{"name":` && json_str( ls_ds-name ).

      DATA lv_seg TYPE string.
      lv_seg = `,"status":` && json_str( ls_ds-status ).
      IF ls_ds-error IS NOT INITIAL.
        lv_seg = lv_seg && `,"error":` && json_str( ls_ds-error ).
      ENDIF.

      " ---- columns ----
      lv_seg = lv_seg && `,"columns":[`.
      LOOP AT ls_ds-columns INTO DATA(ls_col).
        IF sy-tabix > 1.
          lv_seg = lv_seg && `,`.
        ENDIF.
        lv_seg = lv_seg && `{"name":` && json_str( ls_col-name ) &&
                 `,"label":` && json_str( ls_col-label ) &&
                 `,"numeric":` && COND string( WHEN ls_col-numeric = abap_true
                                               THEN `true` ELSE `false` ) && `}`.
      ENDLOOP.
      rv = rv && lv_seg && `]`.

      " ---- rows(受字符预算约束; 预算检查含后续字段约 60 字符余量) ----
      DATA lv_rows TYPE string.
      lv_rows = `,"rows":[`.
      DATA lv_row_n TYPE i.
      lv_row_n = 0.
      DATA lv_budget_cut TYPE abap_bool.
      lv_budget_cut = abap_false.

      LOOP AT ls_ds-rows INTO DATA(ls_cells).
        DATA lv_row TYPE string.
        lv_row = `[`.
        LOOP AT ls_cells INTO DATA(lv_cell).
          IF sy-tabix > 1.
            lv_row = lv_row && `,`.
          ENDIF.
          READ TABLE ls_ds-columns INTO DATA(ls_col_c) INDEX sy-tabix.
          IF sy-subrc = 0 AND ls_col_c-numeric = abap_true
             AND lv_cell CO '0123456789.-'.
            lv_row = lv_row && lv_cell.        " 数值列原样输出
          ELSE.
            lv_row = lv_row && json_str( lv_cell ).
          ENDIF.
        ENDLOOP.
        lv_row = lv_row && `]`.

        IF iv_max_chars > 0
           AND strlen( rv ) + strlen( lv_rows ) + strlen( lv_row ) + 60 > iv_max_chars.
          lv_budget_cut = abap_true.
          EXIT.
        ENDIF.

        IF lv_row_n > 0.
          lv_rows = lv_rows && `,`.
        ENDIF.
        lv_rows = lv_rows && lv_row.
        lv_row_n = lv_row_n + 1.
      ENDLOOP.

      rv = rv && lv_rows && `]`.

      lv_seg = |,"total_rows":{ lv_row_n }| &&
               |,"truncated":{ COND string( WHEN ls_ds-truncated = abap_true
                                            THEN 'true' ELSE 'false' ) }| &&
               |,"elapsed_ms":{ ls_ds-elapsed_ms }| &&
               |,"source":{ json_str( ls_ds-source ) }|.
      IF lv_budget_cut = abap_true.
        lv_seg = lv_seg && `,"note":"已按回填字符预算截断"`.
      ENDIF.
      rv = rv && lv_seg && `}`.

    ENDLOOP.

    rv = rv && `]`.

  ENDMETHOD.


  METHOD build_analysis_json.

    " AnalysisJson(计划 §9): 模型分析结果(已过 GUARD 清洗)+ 全量数据集;
    " 全部字符串经 json_str 安全转义, 不存在注入路径
    rv = `{"summary":` && json_str( is_analysis-summary ) && `,"findings":[`.

    LOOP AT is_analysis-findings INTO DATA(ls_f).
      IF sy-tabix > 1.
        rv = rv && `,`.
      ENDIF.
      rv = rv && `{"title":` && json_str( ls_f-title ) &&
                 `,"detail":` && json_str( ls_f-detail ) &&
                 `,"severity":` && json_str( ls_f-severity ) && `}`.
    ENDLOOP.

    rv = rv && `],"charts":[`.

    LOOP AT is_analysis-charts INTO DATA(ls_c).
      IF sy-tabix > 1.
        rv = rv && `,`.
      ENDIF.
      rv = rv && `{"type":` && json_str( ls_c-type ) &&
                 `,"title":` && json_str( ls_c-title ) &&
                 `,"dataset":` && json_str( ls_c-dataset ) &&
                 `,"x":` && json_str( ls_c-x ) &&
                 `,"y":` && json_str( ls_c-y ) && `}`.
    ENDLOOP.

    rv = rv && `],"datasets":` && build_datasets_json( it_datas     = it_datas
                                                       iv_max_chars = 0 ) && `}`.

  ENDMETHOD.


ENDCLASS.
