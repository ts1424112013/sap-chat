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
* V1.1.1 20261006: 修复 SE24 激活错 get_tools_for_domain
*   同一方法内两次 DATA(ls_tool) 内联声明("LS_TOOL was already declared")
*   → DATA 分支 LOOP 改 INTO ls_tool(沿用 INVENTORY 分支声明)
*   ★ 重贴后核对标记: 本方法内应只有一处 "INTO DATA(ls_tool)"
* V15 20261007(P1): get_tools_for_domain 改为委托 get_tools_for_module
*   正向白名单 —— 修复 INVENTORY 排除法误带 SQL 三工具; REPORT 模块
*   不注入模型侧执行工具(执行只走 StartReportRun 结构化接口)
*   ★ 重贴后核对标记: get_tools_for_module 为正向清单选取;
*   INVENTORY 只含 resolve_material/get_stock_snapshot/get_daily_movement/
*   get_batch_stock, 不得出现 search_tables/describe_table/run_sql
* V15 20261007 注: gc_tool_resolve_rpt/gc_tool_rpt_params/gc_tool_rpt_result
*   为报表工具 ID 预留常量(P2 登记/参数/结果只读工具; 白名单在
*   REPORT_READ_ENABLED 开启时才注入, 且依赖 ZCL_AI_REPORT_SERVICE)
* V15.1 20261011: 代码分析场景(对话页不再读 SAP, 读源码迁入 Agent) ——
*   新增只读工具 read_program_source(程序/类/函数组源码, 事务码自动解析
*   主程序, start_line 翻页; 执行见 AGENT_SERVICE.exec_read_source);
*   CODE 模块白名单 = read_program_source + describe_table
*   ★ 重贴后核对标记: get_tools_for_module 有 WHEN ...gc_mod_code 分支
* V15.7 20261028(10.28 记录 #01): read_program_source 新增可选参数 keyword
*   (按关键词定位报错文案/字段/FORM, 执行见 AGENT_SERVICE V15.7 exec_read_source)
*   ★ 重贴后核对标记: read_program_source 有 name / start_line / keyword 三个参数
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
               gc_tool_run_sql       TYPE string VALUE 'run_sql',
               " V15(P2): 报表模块工具(登记/参数/已有结果, 只读;
               " 执行类工具 start_report_run 单独见 P3/REPORT_EXEC_ENABLED)
               gc_tool_resolve_rpt   TYPE string VALUE 'resolve_report',
               gc_tool_rpt_params    TYPE string VALUE 'get_report_parameters',
               gc_tool_rpt_result    TYPE string VALUE 'get_report_result',
               " V15.1: 代码分析场景只读工具
               gc_tool_read_source   TYPE string VALUE 'read_program_source'.

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
    " V15(P1): 委托 get_tools_for_module 正向白名单(修复 INVENTORY
    " 排除法误带 SQL 三工具的问题)
    CLASS-METHODS get_tools_for_domain
      IMPORTING iv_domain       TYPE string
      RETURNING VALUE(rt_tools) TYPE tt_tools.

    " V15(P1): 模块正向白名单(每个模块只拿明确声明的工具;
    " 工具必须同时满足"已注册 + 当前模块允许"才会返回)
    CLASS-METHODS get_tools_for_module
      IMPORTING iv_module       TYPE string
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
                    && '首选格式: 表使用 AS 别名, 字段使用 别名~字段, 显式 JOIN ... ON; '
                    && '非聚合字段全部写入 GROUP BY; 聚合字段使用英文 ASCII 别名; '
                    && '不要 SELECT * 或中文别名; ORDER BY 优先使用 SELECT 别名。'
                    && 'run_sql 前本次请求必须成功 describe_table 确认涉及的每张表; '
                    && '已明确表名时可直接 describe_table, 否则先 search_tables; '
                    && '大表明细必须带 WHERE; 汇总场景优先 GROUP BY。'
                    && 'args: {"sql":"<SELECT 语句>","purpose":"<一句话说明, 作为结果标题>"}'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

    " V15.1: read_program_source —— 只读源码(仅 Z/Y/命名空间对象; 模型级
    " USER_HIDE_SRC 对普通用户只给元信息; 执行见 AGENT_SERVICE.exec_read_source)
    CLEAR lt_p.
    APPEND VALUE #( name = 'name' ptype = gc_pt_text required = abap_true )
      TO lt_p.
    APPEND VALUE #( name = 'start_line' ptype = gc_pt_text required = abap_false )
      TO lt_p.
    " V15.7(20261028): keyword = 按关键词定位(报错文案/字段名/FORM 名), 返回命中行与前后几行
    APPEND VALUE #( name = 'keyword' ptype = gc_pt_text required = abap_false )
      TO lt_p.
    APPEND VALUE #(
      tool_id     = gc_tool_read_source
      description = '读取自开发 ABAP 对象的源码(程序/类/函数组, 每行带行号; 事务码会自动解析到主程序)。'
                    && '给 keyword 时按关键词定位(不区分大小写, 最长 40 字符): 返回命中的行号 hit_lines 和每处前后 6 行; '
                    && '问报错文案、消息、字段或 FORM 在哪时先用 keyword 搜, 再用 start_line 读命中处附近。'
                    && '不给 keyword 时分页读取: 每次最多约 400 行, more=true 时用 start_line=上次 end_line+1 继续读; '
                    && '只读需要的部分, 不要一次性把整个大程序全部读完。'
                    && 'args: {"name":"<程序名/事务码/类名, 如 ZRMM_IDP_0702 或 ZDPMM702>","keyword":"<可选, 要找的文字>","start_line":"<可选, 起始行号, 默认 1>"}'
      params      = lt_p
      read_only   = abap_true ) TO rt_tools.

  ENDMETHOD.


  METHOD get_tools_for_domain.

    " V13: 按领域返回候选工具; V15 改为模块正向白名单委托:
    " 每个模块只拿到明确声明的工具(INVENTORY 修复: 不再误带 SQL 三工具,
    " 计划 01 §2; REPORT 只在 REPORT 模块注入, 05 提示词 P1-7)
    rt_tools = get_tools_for_module( iv_domain ).

  ENDMETHOD.


  " V15(P1): 模块正向白名单 —— 只按清单正向选取, 不再用"排除法":
  "   INVENTORY → 库存 4 工具(修复 V13 排除法把 SQL 三工具带入的问题)
  "   DATA      → 受控查询计划 + 动态 SQL 三工具
  "   REPORT    → 报表只读三工具(REPORT_READ_ENABLED 开启时, P2)
  "   CODE      → 读源码 + 读表结构(V15.1)
  "   GENERAL/其他 → 空(无工具由 Agent 直接分析回答, 不虚构执行)
  METHOD get_tools_for_module.

    CLEAR rt_tools.

    " 各模块允许的工具 ID 正向清单
    DATA: lt_allow TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    CASE to_upper( iv_module ).
      WHEN zcl_ai_task_service=>gc_mod_inventory.
        APPEND 'resolve_material'   TO lt_allow.
        APPEND 'get_stock_snapshot' TO lt_allow.
        APPEND 'get_daily_movement' TO lt_allow.
        APPEND 'get_batch_stock'    TO lt_allow.
      WHEN zcl_ai_task_service=>gc_mod_data.
        APPEND gc_tool_data_analysis TO lt_allow.
        APPEND gc_tool_search_tables TO lt_allow.
        APPEND gc_tool_describe_tab  TO lt_allow.
        APPEND gc_tool_run_sql       TO lt_allow.
      WHEN zcl_ai_task_service=>gc_mod_code.
        " V15.1: 代码分析 = 读源码 + 读表结构(不取表数据, 不写 SQL)
        APPEND gc_tool_read_source  TO lt_allow.
        APPEND gc_tool_describe_tab TO lt_allow.
      WHEN zcl_ai_task_service=>gc_mod_report.
        " 报表模块工具只在 REPORT_READ_ENABLED 开启时可用(P2 登记/参数;
        " 执行工具不属于白名单, 走独立的 StartReportRun 结构化接口)
        IF zcl_ai_report_service=>read_enabled( ) = abap_true.
          APPEND gc_tool_resolve_rpt TO lt_allow.
          APPEND gc_tool_rpt_params  TO lt_allow.
          APPEND gc_tool_rpt_result  TO lt_allow.
        ENDIF.
      WHEN OTHERS.
        RETURN.   " 无工具 → 通用 Agent 直接分析回答, 不虚构执行
    ENDCASE.

    " 正向选取: 只有在清单内且已注册的工具才返回
    LOOP AT get_tools( ) INTO DATA(ls_tool).
      READ TABLE lt_allow TRANSPORTING NO FIELDS
        WITH KEY table_line = ls_tool-tool_id.
      IF sy-subrc = 0.
        APPEND ls_tool TO rt_tools.
      ENDIF.
    ENDLOOP.

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
