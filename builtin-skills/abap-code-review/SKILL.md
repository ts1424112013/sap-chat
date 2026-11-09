---
name: abap-code-review
description: "ABAP 代码审查：要审查一个 ABAP 程序、类、函数或增强能不能上线，查安全漏洞、权限检查、性能、异常处理、编码规范、接口风险时用。按 9 个维度逐项审，每条问题带代码证据和规则编号，最后给出能否上线的结论（可以上线 / 有条件上线 / 不能上线）和一份审查报告。"
metadata:
  scenes: "CODE"
  order: 140
  title: "ABAP 代码审查"
  source: "abap-code-review（github.com/shrek-abaper/sap-engineering-skill，MIT）"
---

# ABAP 代码审查

上线前对 ABAP 程序做安全和质量审查，给出能否上线的结论和一份可以存档、签字的审查报告。

本系统是 ABAP 7.55（ABAP Platform 2020，本地部署）：按标准 ABAP 审，不按 ABAP Cloud 的限制（不要求只用已发布 API）。

## 第 0 步：先读规则

读源码之前，先读这两份（规则编号以它们为准）：

1. `references/REF_ABAP_SECURITY.md`：安全、权限、接口规则（SEC-*、AUTH-*）
2. `references/REF_CLEAN_ABAP.md`：编码规范规则（[L-*]、[C-*]、[M-*]、[E-*]、[T-*] 等）

读不到时照常审，用自己的 ABAP 知识，在报告「审查范围限制」里写明规则文件没读到。

## 第 1 步：读源码

- 有 ADT 工具时：先用 `adt_search` 找对象，`adt_structure` 看结构，`adt_read_source` 逐个读（报表读主程序和所有 INCLUDE；类读定义和每个方法；函数读目标函数和同函数组里相关的函数；增强读增强点定义和所有生效的实现）。要看谁在用它，用 `adt_where_used`。
- 只有 `read_program_source` 时用它读。
- 都没有时，请用户把代码贴进来，并说明要审哪些 INCLUDE、方法或函数。
- 用户在文件夹里给了代码文件的，直接读文件。
- 读不到的对象：报告里列为「未审查」，不能当作没问题。

顺序：主程序 / 类定义 → INCLUDE（按出现顺序）→ 方法（逐个）。代码很长时分段读，用关键字定位，不要一次读全部。

## 第 2 步：9 个维度逐项审

9 个维度按顺序都要写，没有问题就写「未发现问题」。

**[SEC] 安全漏洞**（规则见 REF_ABAP_SECURITY.md）

```
优先查：
  EXEC SQL                    → SEC-SQL-2
  GENERATE SUBROUTINE POOL    → SEC-CODE-1
  INSERT REPORT               → SEC-CODE-2
  CALL 'SYSTEM' / SXPG_*      → SEC-OS-1/2/3
  WHERE ( <变量> ) 动态条件    → SEC-SQL-1
  DESTINATION ( <变量> )      → SEC-RFC-1
其次查：
  cl_sql_statement            → 是否用 set_param 参数化
  OPEN DATASET                → 路径来源 + SY-SUBRC 检查
  CALL FUNCTION DESTINATION   → RFC 目标从哪来
  含 password / key / token 的常量 → SEC-CRED-1
```

**[AUTH] 权限检查**（AUTH-MISS-*、AUTH-BYP-*）

高风险表在读写前要有 AUTHORITY-CHECK：财务凭证（BKPF/BSEG/ACDOCA）、物料凭证（MKPF/MSEG/MATDOC）、销售（VBAK/VBAP）、采购（EKKO/EKPO）、人事（PA*/HRP*）。
检查：① 敏感表操作前有 AUTHORITY-CHECK → ② 紧跟着检查 SY-SUBRC → ③ 没有按 SY-UNAME 写死放行 → ④ 可远程调用的函数（RFC）自己做了权限检查。

> 特别规则：[SEC] 或 [AUTH] 里的「高」级问题，一律按「严重」处理（不能上线）。

**[DATA] 数据完整性与异常处理**（[E-2]、[E-3]）

CALL FUNCTION 后检查 SY-SUBRC → READ TABLE / SELECT SINGLE 后检查 SY-SUBRC → OPEN DATASET 后检查 SY-SUBRC → 写数据前加锁（ENQUEUE）→ COMMIT WORK 不在循环里 → 出错路径有 ROLLBACK WORK → 没有吞掉异常的空 CATCH。

**[PERF] 性能风险**（[T-1]、[T-2]、[T-3]）

循环里 SELECT（大表时为严重）→ SELECT * 没有指定字段 → 没有 WHERE 的全表读取 → 循环里对标准表 READ TABLE WITH KEY（改用排序表 / 哈希表）→ 大表（ACDOCA/BSEG/MATDOC/MSEG 等）没有行数或期间限制。

**[STD] 编码规范**（[L-*]、[C-*]、[N-*]、[M-*]）

过时语句（[L-3]）、写死的业务值如公司代码 / 工厂 / 客户端（[C-3]，企业里一般算「高」）、过长的方法（[M-2]，超过 20 条语句提示）、整段注释掉的代码（[CM-3]）、Unicode 兼容。
命名前缀（lv_ / ls_ / lt_ / iv_ / rv_ 等）按公司现有习惯，不当作问题；也不要求把可用的旧写法全部改成新语法。

**[INTERFACE] 接口与集成风险**（SEC-RFC-*、SEC-WEB-*）

RFC 函数里有对话框消息 MESSAGE TYPE A/I/W（SEC-RFC-3）→ RFC 参数都有类型 → EXCEPTIONS 声明完整 → CALL FUNCTION DESTINATION 有超时处理 → OData（SEGW 的 DPC_EXT）有后台权限检查（SEC-WEB-2）。

**[CHANGE] 变更影响**

列出读、写、删的所有数据库表 → 是否修改了 SAP 标准对象 → 是否和其他程序共用 INCLUDE 或函数（可用 `adt_where_used` 查）→ 传输的前置条件和跨系统依赖。

**[COMP] 合规与审计**

读取、导出个人信息有没有依据 → 财务记账有没有双人控制 → 主数据修改有没有写修改记录（CDHDR/CDPOS）→ 程序有没有记录执行人、时间、参数 → 有没有一个人既能发起又能批准（职责分离）。

**[FUNC] 功能完整性**（可选）

只有用户给了需求说明才做；没有就在报告里写跳过原因，不要自己猜需求。做的话：入口覆盖业务场景 → 边界情况（空值、零、大数据量）→ 核心逻辑和计算是否符合需求 → 输出字段完整 → 接口传的数据完整。

## 第 3 步：严重程度

| 级别 | 含义 | 对上线的影响 |
|---|---|---|
| 🔴 严重 | 会出错、丢数据、有安全漏洞 | 不能上线 |
| 🟠 高 | 明确的缺陷或明显风险 | 原则上不能上线 |
| 🟡 中 | 应该改 | 下次迭代改 |
| 🟢 低 | 建议 | 不影响 |
| ℹ️ 提示 | 说明 | 不用处理 |

拿不准时取高一级。

## 第 4 步：上线结论

```
有「严重」                      → 不能上线（NO-GO）
[SEC] 或 [AUTH] 有「高」          → 不能上线（特别规则）
其他维度有「高」                  → 有条件上线（CONDITIONAL GO，要技术负责人签字接受）
只有「中 / 低 / 提示」            → 可以上线（GO）
```

## 第 5 步：出报告

读 `references/REPORT_TEMPLATE.md`，严格按它的结构写，不增减章节。**报告用中文写**；规则编号、维度代号（SEC、AUTH 等）和结论标记（GO / CONDITIONAL GO / NO-GO）保留英文。

- 用户选了文件夹：存成 `ABAP审查_<对象名>_<YYYYMMDD>.md`（有「严重」时前面加 `严重_`），存好告诉用户路径。
- 没有文件夹：在回答里直接给出完整报告。
- 回答开头先用两三句话说结论和最重要的问题，再给报告。

## 规则

| 规则 | 要求 |
|---|---|
| 先读规则 | 第 0 步没做完不开始读源码 |
| 有证据 | 每条问题都要贴真实代码（不超过 15 行），没有代码证据的问题不算 |
| 有编号 | [SEC] / [AUTH] / [STD] 的问题必须写规则编号 |
| 不漏报 | 没读到的对象标「部分审查」，不能写「未发现问题」 |
| 不重复 | 同一种问题出现在多处，合并成一条，列出所有位置 |
| 需求门槛 | 没有需求说明就跳过 [FUNC] 并说明原因 |
| 只审不改 | 只给修改建议和示例代码，不去改 SAP 里的代码；示例代码要能在 7.55 上激活，拿不准时用 `adt_syntax_check` 检查 |
