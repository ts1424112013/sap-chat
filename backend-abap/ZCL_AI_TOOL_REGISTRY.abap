*=======================================================================
* 对象:   ZCL_AI_TOOL_REGISTRY
* 用途:   Agent 工具白名单注册表(《库存场景走查与Agent工具借鉴》P1-3)
*         - 仅注册本文(功能计划书)定义的只读工具, 工具 ID 不可由
*           模型扩展; 任何未注册的工具调用一律按协议错误拒绝
*         - 每个工具声明强类型参数 Schema(名称/类型/必填), 供
*           ZCL_AI_AGENT_GUARD 在执行前做参数校验
*         - needs_confirm 预留给二期人工审批(human-in-the-loop);
*           首期只读工具恒为空, 注册写入类工具前必须先落地审批流
* 依赖:   无(纯数据注册, 被 AGENT_SERVICE / AGENT_GUARD / DOMAIN_CARDS 消费)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (适用 S/4HANA 760, ABAP 7.5x)
* V1.0:   首期 4 个库存工具:
*         resolve_material   按精确料号或受限前缀查找候选(最多 10 条)
*         get_stock_snapshot 指定工厂/料号的库位库存与库存类型汇总(MARD)
*         get_daily_movement 指定过账日期的收发汇总(MSEG, 按移动类型/方向)
*         get_batch_stock    批次库存明细(MCHB, 批次管理料号按需调用)
* V1.1:   新增数据分析工具(《SAP数据分析能力_开发计划》§13.2):
*         sap_data_analysis  受控查询计划取数(能力目录白名单实体/字段),
*                            args 直接承载计划 JSON 对象(不走扁平 kv),
*                            解析/校验见 AGENT_GUARD.parse_analysis_plan,
*                            执行见 ZCL_AI_DATA_ANALYSIS_SERVICE
*=======================================================================
CLASS zcl_ai_tool_registry DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " 工具 ID 常量(白名单键; AGENT_SERVICE 分发/GUARD 提示共用)
    CONSTANTS: gc_tool_data_analysis TYPE string VALUE 'sap_data_analysis',
               " V14: 动态 SQL 工具(《SAP动态SQL业务分析_开发计划》§6)
               gc_tool_search_tables TYPE string VALUE 'search_tables',
               gc_tool_describe_tab  TYPE string VALUE 'describe_table',
               gc_tool_run_sql       TYPE string VALUE 'run_sql'.

    " 参数类型枚举(强类型 Schema, 值格式由 GUARD 逐一校验):
    "   PLANT     工厂 4 位字母数字
    "   MATERIAL  料号 ≤18 位大写字母数字/-_., 调用前统一 TO_UPPER
    "   DATE      过账日期 YYYYMMDD(8 位数字, ABAP 解析为 DATS)
    "   TEXT      受限短文本(≤40 字符, 不进 SQL, 仅检索提示)
    "   LONGTEXT  长文本(≤4000 字符, 保留大小写, 供 run_sql 的 SQL 语句)
    TYPES: ty_param_type TYPE c LENGTH 10.
    CONSTANTS: gc_pt_plant     TYPE ty_param_type VALUE 'PLANT',
               gc_pt_material  TYPE ty_param_type VALUE 'MATERIAL',
               gc_pt_date      TYPE ty_param_type VALUE 'DATE',
               gc_pt_text      TYPE ty_param_type VALUE 'TEXT',
               gc_pt_longtext  TYPE ty_param_type VALUE 'LONGTEXT'.

    TYPES: BEGIN OF ty_param_spec,
             name     TYPE string,          " 参数名(JSON 小写)
             ptype    TYPE ty_param_type,   " 强类型
             required TYPE abap_bool,       " X = 缺失即拒绝执行
           END OF ty_param_spec.
    TYPES tt_param_spec TYPE STANDARD TABLE OF ty_param_spec WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_tool,
             tool_id       TYPE string,        " 工具唯一 ID(白名单键)
             description   TYPE string,        " 给模型看的用途说明
             params        TYPE tt_param_spec, " 参数 Schema
             needs_confirm TYPE abap_bool,     " 二期人工审批标志(首期恒空)
             read_only     TYPE abap_bool,     " X = 只读(首期全部为 X)
           END OF ty_tool.
    TYPES tt_tools TYPE STANDARD TABLE OF ty_tool WITH DEFAULT KEY.

    " 全量注册表(每次调用现算, 便于后续迁到 Z 表配置化)
    CLASS-METHODS get_tools
      RETURNING VALUE(rt_tools) TYPE tt_tools.

    " V13: 按领域返回候选工具 —— 通用 Agent 按问题意图选域:
    " INVENTORY → 库存 4 工具; 其他域 → 空(无工具时由 Agent 继续
    " 文本分析完成回答, 不因没有工具而失败)
    CLASS-METHODS get_tools_for_domain
      IMPORTING iv_domain       TYPE string
      RETURNING VALUE(rt_tools) TYPE tt_tools.

    " 工具是否已注册(白名单校验)
    CLASS-METHODS is_registered
      IMPORTING iv_tool      TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.

    " 读取单个工具定义(未注册返回空 tool_id)
    CLASS-METHODS get_tool
      IMPORTING iv_tool     TYPE string
      RETURNING VALUE(rs_tool) TYPE ty_tool.

ENDCLASS.



CLASS zcl_ai_tool_registry IMPLEMENTATION.


  METHOD get_tools.

    DATA lt_p TYPE tt_param_spec.

    " ---- 1) resolve_material: 主档校验 / 候选确认 ----
    CLEAR lt_p.
    APPEND VALUE #( name = 'material_hint' ptype = gc_pt_text     required = abap_true  ) TO lt_p.
    APPEND VALUE #( name = 'plant'         ptype = gc_pt_plant    required = abap_false ) TO lt_p.
    APPEND VALUE #(
      tool_id     = 'resolve_material'
      description = '按精确料号或受限前缀查找候选料号, 返回最多 10 条(MATNR/MEINS/MTART/MATKL)。'
                    && '用户给出的料号不完整或有别名时必须先调用本工具确认, 候选不唯一时向用户确认。'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " ---- 2) get_stock_snapshot: 当前库存快照(MARD) ----
    CLEAR lt_p.
    APPEND VALUE #( name = 'plant'    ptype = gc_pt_plant    required = abap_true ) TO lt_p.
    APPEND VALUE #( name = 'material' ptype = gc_pt_material required = abap_true ) TO lt_p.
    APPEND VALUE #(
      tool_id     = 'get_stock_snapshot'
      description = '返回指定工厂、料号的当前库位库存与库存类型汇总(非限制/质检/冻结/退货/在转), '
                    && '含批次管理标志。库存为查询时点快照, 无时间维度。'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " ---- 3) get_daily_movement: 指定过账日收发(MSEG) ----
    CLEAR lt_p.
    APPEND VALUE #( name = 'plant'        ptype = gc_pt_plant    required = abap_true  ) TO lt_p.
    APPEND VALUE #( name = 'material'     ptype = gc_pt_material required = abap_true  ) TO lt_p.
    APPEND VALUE #( name = 'posting_date' ptype = gc_pt_date     required = abap_false ) TO lt_p.
    APPEND VALUE #(
      tool_id     = 'get_daily_movement'
      description = '返回指定过账日期的收发汇总: 按移动类型(BWART)/借贷标识(SHKZG S借H贷)/单位(MEINS) '
                    && '汇总数量。不传 posting_date 时默认当天。空结果=当天无收发, 是有效业务事实。'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " ---- 4) get_batch_stock: 批次库存(MCHB, 按需) ----
    CLEAR lt_p.
    APPEND VALUE #( name = 'plant'    ptype = gc_pt_plant    required = abap_true  ) TO lt_p.
    APPEND VALUE #( name = 'material' ptype = gc_pt_material required = abap_true  ) TO lt_p.
    APPEND VALUE #( name = 'lgort'    ptype = gc_pt_text     required = abap_false ) TO lt_p.
    APPEND VALUE #(
      tool_id     = 'get_batch_stock'
      description = '返回指定工厂、料号的批次库存明细(MCHB: 批次/库存地点/非限制/质检/冻结)。'
                    && '仅在料号为批次管理或用户明确追问批次时调用, 明细行数受限。'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " ---- 5) sap_data_analysis: 受控数据分析(计划 §6/§13.2) ----
    " args 不是扁平 kv, 而是查询计划 JSON 对象本身(嵌套 queries/filters),
    " 因此 params 留空; 解析/校验/执行分别由 AGENT_GUARD.parse_analysis_plan
    " 与 ZCL_AI_DATA_ANALYSIS_SERVICE 承担(AGENT_SERVICE 统一分发分支)
    CLEAR lt_p.
    APPEND VALUE #(
      tool_id     = gc_tool_data_analysis
      description = 'SAP 数据分析(受控查询计划): 对能力目录声明的实体做明细/分组/趋势取数, '
                    && '返回统一数据集(表格+图表可用)。args 必须是查询计划 JSON 对象: '
                    && '{"intent":"table_analysis","queries":[{"name":"<查询名>",'
                    && '"entity":"<实体>","operation":"detail|group|trend",'
                    && '"dimensions":["<维度字段>"],"metrics":["count"],'
                    && '"filters":[{"field":"<字段>","operator":"eq|ne|like|ge|le|between",'
                    && '"value":"<值>","value_to":"<between第二值>"}]}]}。'
                    && '用户问统计/汇总/趋势/分布/占比类问题且需要物料主档数据时调用本工具。'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " V14: 动态 SQL 三工具(只读; 校验见 ZCL_AI_SQL_GUARD, 执行见 SQL_EXECUTOR)
    " search_tables: 按业务关键词定位表
    CLEAR lt_p.
    APPEND VALUE #( name = 'keyword' ptype = gc_pt_text required = abap_true )
      TO lt_p.
    APPEND VALUE #(
      tool_id     = gc_tool_search_tables
      description = '按业务关键词搜索 SAP 表(中文/英文描述模糊匹配, 最多 30 张)。'
                    && '写 SQL 前先用本工具找到候选表, 再用 describe_table 确认字段。'
                    && 'args: {"keyword":"<业务关键词, 如 库存/销售订单/供应商>"}'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " describe_table: 读字段清单
    CLEAR lt_p.
    APPEND VALUE #( name = 'table' ptype = gc_pt_text required = abap_true )
      TO lt_p.
    APPEND VALUE #(
      tool_id     = gc_tool_describe_tab
      description = '读取指定表的字段清单(字段名/描述/类型/长度/主键/检查表, 最多 150 个)。'
                    && 'args: {"table":"<表名, 如 MARA>"}'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " run_sql: 执行单条只读 SELECT(后端词法校验 + 表权限 + 行数上限)
    CLEAR lt_p.
    APPEND VALUE #( name = 'sql' ptype = gc_pt_longtext required = abap_true )
      TO lt_p.
    APPEND VALUE #( name = 'purpose' ptype = gc_pt_text required = abap_false )
      TO lt_p.
    APPEND VALUE #(
      tool_id     = gc_tool_run_sql
      description = '执行一条只读 SELECT(Open SQL)并返回数据集。约束: '
                    && '单条语句; 禁止 INTO/UP TO/PACKAGE SIZE(系统自动添加); '
                    && '禁止 INSERT/UPDATE/DELETE/子查询(FROM 后); 字符串常量用单引号; '
                    && '最多关联 8 张表; 支持多表 JOIN/GROUP BY/HAVING/聚合/CASE。'
                    && '先 search_tables/describe_table 确认表和字段再写 SQL; '
                    && '大表明细必须带 WHERE; 汇总场景优先 GROUP BY。'
                    && 'args: {"sql":"<SELECT 语句>","purpose":"<一句话说明, 作为结果标题>"}'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

  ENDMETHOD.


  METHOD get_tools_for_domain.

    " V13: 按领域返回候选工具; V1.1 新增 DATA 域(数据分析, 计划 §3):
    " INVENTORY → 库存 4 工具; DATA → sap_data_analysis;
    " 其他域 → 空(无工具时由 Agent 继续文本分析完成回答, 不因没有工具而失败)
    CASE to_upper( iv_domain ).
      WHEN 'INVENTORY'.
        DATA lt_inv TYPE tt_tools.
        LOOP AT get_tools( ) INTO DATA(ls_tool).
          IF ls_tool-tool_id <> gc_tool_data_analysis.
            APPEND ls_tool TO lt_inv.
          ENDIF.
        ENDLOOP.
        rt_tools = lt_inv.
      WHEN 'DATA'.
        " V14: 数据分析域 = 受控查询计划(sap_data_analysis) + 动态 SQL 三工具
        LOOP AT get_tools( ) INTO DATA(ls_tool).
          IF ls_tool-tool_id = gc_tool_data_analysis
             OR ls_tool-tool_id = gc_tool_search_tables
             OR ls_tool-tool_id = gc_tool_describe_tab
             OR ls_tool-tool_id = gc_tool_run_sql.
            APPEND ls_tool TO rt_tools.
          ENDIF.
        ENDLOOP.
      WHEN OTHERS.
        CLEAR rt_tools.   " 无工具 → 通用 Agent 直接分析回答, 不虚构执行
    ENDCASE.

  ENDMETHOD.


  METHOD is_registered.
    rv_ok = xsdbool( get_tool( iv_tool )-tool_id IS NOT INITIAL ).
  ENDMETHOD.


  METHOD get_tool.

    CLEAR rs_tool.

    DATA(lv_tool) = to_lower( iv_tool ).
    CONDENSE lv_tool NO-GAPS.

    LOOP AT get_tools( ) INTO DATA(ls_tool).
      IF ls_tool-tool_id = lv_tool.
        rs_tool = ls_tool.
        RETURN.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


ENDCLASS.
