CLASS zcl_ai_domain_cards DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    CONSTANTS: gc_dom_inventory TYPE string VALUE 'INVENTORY',
               gc_dom_data      TYPE string VALUE 'DATA',      " V1.1: 数据分析域
               gc_dom_general   TYPE string VALUE 'GENERAL'.

    CLASS-METHODS match_domain
      IMPORTING iv_question     TYPE string
      RETURNING VALUE(rv_domain) TYPE string.

    CLASS-METHODS get_card
      IMPORTING iv_domain     TYPE string
      RETURNING VALUE(rv_card) TYPE string.

ENDCLASS.

CLASS zcl_ai_domain_cards IMPLEMENTATION.

  METHOD match_domain.

    DATA(lv_up) = to_upper( iv_question ).

    " 库存意图优先(关键词更具体; 库存场景仍走专用只读工具)
    FIND REGEX '库存|在库|料号|物料号|余量|收发|收货|发料|盘点|库位|库存地点|批次库存'
      IN lv_up.
    IF sy-subrc = 0.
      rv_domain = gc_dom_inventory.
      RETURN.
    ENDIF.

    " V1.1: 数据分析意图(统计/汇总/趋势/分布/占比等, 计划 §3 领域路由)。
    " V14: 加入 分析/查询/列出 等通用词 —— DATA 域现在携带动态 SQL 工具,
    " 命中后可对任意业务表做只读取数(库存意图在上面优先拦截, 不受影响)
    FIND REGEX '统计|汇总|趋势|分布|占比|多少个|多少种|多少条|数量|排名|TOP|分组|饼图|柱状图|条形图|折线图|物料主档|MARA|分析|查询|列出|找出|有哪些|SQL'
      IN lv_up.
    IF sy-subrc = 0.
      rv_domain = gc_dom_data.
      RETURN.
    ENDIF.

    rv_domain = gc_dom_general.

  ENDMETHOD.

  METHOD get_card.

    DATA(lv_domain) = to_upper( iv_domain ).

    IF lv_domain = gc_dom_inventory.

      rv_card =
        |【库存领域知识】(当前问题命中库存意图, 以下口径必须遵守)\n| &&
        |\n| &&
        |1. 库存查询范围: 指定工厂(WERKS)+料号(MATNR)。\n| &&
        |2. 当前库存 = 查询时点的库位余额快照, 无时间维度。\n| &&
        |3. "当天"的另一层含义 = 指定过账日期的收发变动, 按过账日期统计。\n| &&
        |4. 用户问"分析当天库存"时: 必须同时查询【当前库存快照】与【当天收发】,\n| &&
        |   在报告中分别呈现并注明口径不同(快照 vs 按过账日统计), 不得表述为\n| &&
        |   期初/期末勾稽关系。\n| &&
        |5. 非限制库存(LABST)仅是库存类型之一; 报告需按库存类型(非限制/质检/\n| &&
        |   冻结/退货/在转)拆分; 收发方向看借贷标识: S=收, H=发。\n| &&
        |6. 单位(MEINS)多值时禁止跨单位加总, 必须分单位呈现。\n| &&
        |\n| &&
        |【工具使用要点】\n| &&
        |- 料号不完整/有别名时先 resolve_material 查候选(最多 10 条); 候选不唯一\n| &&
        |  必须向用户确认, 不得擅自选择物料。\n| &&
        |- get_batch_stock 仅在料号为批次管理或用户明确追问批次时调用。\n| &&
        |\n| &&
        |【库存报告自查清单(final 前逐项自答, 不通过不得收口)】\n| &&
        |1. 料号主档存在? 0 条 → 如实告知未找到, 不带数字编答案。\n| &&
        |2. MARD 0 行且主档存在 → 有效结论(该料号在此工厂无库存记录), 不是失败。\n| &&
        |3. 当天收发 0 行 → "当天无收发"是有效业务事实, 不算失败。\n| &&
        |4. 数量口径齐了吗? 只拿到非限制库存时需确认其他库存类型后再收口。\n| &&
        |5. 单位一致? 多单位分单位呈现, 禁止跨单位加总。\n| &&
        |6. 数字可溯源? 报告中每个数字都要能对应到某次工具结果。\n| &&
        |\n| &&
        |【库存报告模板(参考)】\n| &&
        |【料号 在 工厂 的库存分析】(单位: XX)\n| &&
        |◆ 当前库存合计 N(非限制 a / 质检 b / 冻结 c / 退货 d)\n| &&
        |  - 库位 1001: x ｜ 库位 1002: y\n| &&
        |◆ 当天收发(MM-DD): 收 R(移动类型), 发 I(移动类型), 净变动 ±Z\n|.

    ELSEIF lv_domain = gc_dom_data.

      " V1.1: 数据分析领域卡(《SAP数据分析能力_开发计划》§11/§9 口径)
      rv_card =
        |【数据分析领域知识】(当前问题命中数据统计意图, 以下口径必须遵守)\n| &&
        |\n| &&
        |1. 取数工具二选一: 常规统计分析可用 sap_data_analysis(查询计划,\n| &&
        |   MARA 受控取数); 目录之外的业务数据(采购/销售/生产/财务等)\n| &&
        |   用动态 SQL 工作流: search_tables(按关键词找表) →\n| &&
        |   describe_table(确认字段) → run_sql(执行单条只读 SELECT)。\n| &&
        |   写 SQL 前必须先确认表和字段真实存在, 不得编造表名/字段名。\n| &&
        |2. 一个问题可以拆成多条查询(最多 4 条)一起提交, 例如:\n| &&
        |   "按物料类型分组" + "按创建日期趋势" 放进同一个 queries 数组。\n| &&
        |3. 每条查询要有简短的中文名称(name), 便于用户理解与图表引用。\n| &&
        |4. 0 行结果是有效业务事实, 不是失败; 数据集错误时如实转述错误信息,\n| &&
        |   不要重试超过一次。\n| &&
        |5. 报告中的每个数字都要能对应到某个数据集的行列; count 指标是记录数,\n| &&
        |   不是数量总和, 表述时写"X 条物料"而不是"X 个数量"。\n| &&
        |6. 图表引用必须使用数据集名称与列名(原样), 数据集未返回时不要编图表。\n| &&
        |\n| &&
        |【分析报告自查清单(final 前逐项自答, 不通过不得收口)】\n| &&
        |1. 查询计划覆盖了用户问题的全部口径? (分组维度/时间范围/过滤条件)\n| &&
        |2. 数据集都返回 OK? 有 ERROR/DENIED 的数据集必须在回答中如实说明。\n| &&
        |3. 数字可溯源? 结论中的每个数字都来自数据集行。\n| &&
        |\n| &&
        |【报告模板(参考)】\n| &&
        |◆ 总量: 共 N 条物料(来源: 查询"按物料类型统计")\n| &&
        |◆ 分布: 类型 FERT 最多(占比 x%), 其次 ROH\n| &&
        |◆ 趋势: 近 X 月创建量上升/下降(来源: 查询"按创建日期趋势")\n| &&
        |\n| &&
        |【run_sql 写法规范(必须逐条遵守, 违反会被后端拒绝)】\n| &&
        |1. 只允许一条 SELECT; INTO/UP TO/PACKAGE SIZE 由系统自动添加,\n| &&
        |   语句中出现这些子句会被直接拒绝。\n| &&
        |2. 推荐统一使用以下 SAP Open SQL 写法: 表使用别名(如 VBAK AS H),\n| &&
        |   字段使用别名加波浪号(如 H~KUNNR), 多表使用显式 JOIN ... ON。\n| &&
        |   JOIN 优先写 LEFT OUTER JOIN/INNER JOIN, 不要混用隐式逗号连接。\n| &&
        |3. 支持: 多表 JOIN(最多 8 张)/GROUP BY/HAVING/聚合(COUNT/SUM/AVG/\n| &&
        |   MIN/MAX)/CASE WHEN/ORDER BY。当前系统 7.50: 不支持 FROM 子查询、\n| &&
        |   不支持 WITH(CTE)和窗口函数, 不要尝试。\n| &&
        |4. SELECT 中的非聚合字段必须全部出现在 GROUP BY。聚合字段使用英文\n| &&
        |   ASCII 别名, 只用字母/数字/下划线(如 ORDER_CNT、NETWR_TOTAL),\n| &&
        |   不要使用中文别名。不要使用 SELECT *, 只取回答问题所需字段。\n| &&
        |5. ORDER BY 优先引用 SELECT 中的英文别名, 例如 ORDER BY ORDER_CNT\n| &&
        |   DESCENDING。COUNT(DISTINCT 字段) 仅在确实需要去重计数时使用。\n| &&
        |6. 字符串常量用单引号(如 WHERE MTART = 'FERT'); 日期字段是 YYYYMMDD\n| &&
        |   格式的字符串(如 ERDAT >= '20260101')。\n| &&
        |7. 大表(MSEG/BSEG/ACDOCA/MATDOC/VBFA/CDPOS)取明细必须带 WHERE 条件;\n| &&
        |   统计类问题优先 GROUP BY, 不要把几千行明细拉回来。\n| &&
        |8. 金额/数量列必须连同货币/单位列一起查询或分组, 禁止跨币种/跨单位加总。\n| &&
        |9. 单次请求最多执行 5 次 run_sql(含修正重试); 语句编译/执行报错时\n| &&
        |   按报错信息修正后重试, 同一错误不要重试超过一次。\n| &&
        |10. 表权限不足或表属于受保护表时, 如实告知用户, 不要换表绕过。\n| &&
        |\n| &&
        |【推荐 SQL 模板】\n| &&
        |SELECT H~KUNNR AS CUSTOMER_ID, C~NAME1 AS CUSTOMER_NAME,\n| &&
        |       COUNT( DISTINCT H~VBELN ) AS ORDER_CNT,\n| &&
        |       SUM( H~NETWR ) AS NETWR_TOTAL\n| &&
        |  FROM VBAK AS H\n| &&
        |  LEFT OUTER JOIN KNA1 AS C ON H~KUNNR = C~KUNNR\n| &&
        |  WHERE H~ERDAT >= '20260101'\n| &&
        |  GROUP BY H~KUNNR, C~NAME1\n| &&
        |  ORDER BY ORDER_CNT DESCENDING\n| &&
        |\n| &&
        |【常用业务表地图(写 SQL 前仍应 describe_table 确认字段)】\n| &&
        |- MM 采购: EKKO(采购订单头)/EKPO(行项目)/EBAN(采购申请)\n| &&
        |- MM 库存: MARA/MARC(工厂视图)/MARD(库位)/MSEG+MKPF(物料凭证)\n| &&
        |- SD 销售: VBAK(销售订单头)/VBAP(行项目)/LIKP+LIPS(交货)/VBRK+VBRP(开票)/KNA1(客户)\n| &&
        |- PP 生产: AFKO(订单头)/AFPO(订单项)/RESB(预留)\n| &&
        |- FI/CO: BKPF(凭证头)/BSEG(凭证行)/ACDOCA(总账行项目)/SKAT(科目文本)/CSKS(成本中心)\n|.

    ELSE.

      CLEAR rv_card.

    ENDIF.

  ENDMETHOD.

ENDCLASS.
