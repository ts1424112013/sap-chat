---
name: lynx-result-analysis
description: "报表结果分析：用户问「这个结果 / 上面的报表 / 刚才的数据」、要排名、Top N、按某列汇总、筛选计数、翻页看明细、拿结果里的料号去别的表补字段、把结果里的值带进下一张报表、或把结果导出成 Excel / CSV、写成分析报告时用。"
metadata:
  scenes: "REPORT,FIORI,DATA"
  order: 3
  title: "报表结果分析"
  source: "灵犀项目自编（按 2026-11 的工具清单）"
---

# 报表结果分析

报表结果存在 SAP，可能有几万行。你看到的概况只有统计和举例行；**全量结论一律让后端算**，不要用举例行推算。

## 基本顺序

1. `list_results`：找结果号（最新在前）。用户说「刚才那个」通常是第一个；有几份说得通时 `ask_user`。
2. `read_result`：看列名（列标题可能是繁体中文，按原文写）、总行数、后端统计、举例行。行数少时会给全部明细，可以直接用。
3. 按问题选工具：

| 要做的事 | 工具与写法 |
|---|---|
| 排名 / Top N | `query_result`：`group_by` + `metrics`（sum / count …）+ `sort` desc + `limit` |
| 按某列汇总 | `query_result`：`group_by:["列"]`，`metrics:[{"column":"数量列","agg":"sum"}]` |
| 筛选计数 | `query_result`：`filters` + `metrics:[{"agg":"count"}]`（count 不给 column = 行数） |
| 看某个值的明细 | `query_result`：`filters` + `columns` + `sort` |
| 「后面的 / 下一页」 | 同样的条件再调，`offset` 填上次的 `next_offset` |
| 结果里的料号去表 X 补字段 / 关联表 X | `lookup_by_result`：`table`、`key_field`（表里的关联字段）、`source_column`（结果里的列）、`fields`；可同时带 `group_by` 等在接好的数据上算 |
| 把结果里某列的值带进另一张报表 | `prefill_report`：`tcode`、`target_param`（必须是多值或范围参数）、`source_column`，可先 `filters`；成功后运行结束 |
| 导出成文件 | `save_result_to_folder`：`.xlsx` 或 `.csv`，数据由 SAP 直接写，不要自己拼表格 |

每次调用都写 `purpose`（一句话，会作为结果标题）。

## 注意

- **单位、币种分开算**：数量列有不同单位（PC / KG）、金额有不同币种时，`group_by` 里带上单位 / 币种列，不要直接相加。
- 返回里 `total` 是符合条件的总行数（分组时是组数），`more = true` 表示后面还有；回答里说清「共 N 条，列出前 10」。
- `lookup_by_result` 返回的 `keys_miss` > 0 时要说明「有 X 个料号在表里没查到」。
- 关联值、带入值由后端从全部行里取，**不要自己罗列料号**塞进参数。
- 不知道表 X 的关联字段名时，先 `describe_table`（有这个工具时），不要猜。
- Fiori 结果只有用户点了「交给模型分析」才在会话里。

## 回答格式

1. 先直接回答原来的问题（「库存最高的是 A，共 1,200 PC」）。
2. 再给支撑数字（小表格，最多十几行），说明来自哪份结果、按什么条件算的。
3. 有截断、单位混合、没查到的值时，最后一句说明。

用户要「做成报告」时：数字先用工具算好，再用 `create_word_file` 写成文档（结论 → 表格 → 说明）；要表格文件用 `save_result_to_folder`，汇总后的小表可以用 `create_excel_file`。
