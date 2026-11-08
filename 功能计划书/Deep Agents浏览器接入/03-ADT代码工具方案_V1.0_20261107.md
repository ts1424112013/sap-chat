# 新引擎接入 ADT 代码工具 —— 方案 V1.0

> 日期：2026-11-07 ｜ 状态：**M1 已实现（2026-11-08，引擎 0.7.0 / AGENT_SERVICE V15.25 / AGENT_HTTP V1.5，部署见《03》《04》〇-AN）**，未上 SAP ｜ 前置：《02-方案与开发计划 V2.0》的 M1 ~ M3（〇-AF / AG / AH）
> 参考：github.com/marianfoo/sap-ai-mcp-servers 目录里的 ADT 类 MCP（mario-andreschak/mcp-abap-adt、oisee/vibing-steampunk、ARC-1），接口细节以 marcellourbani/abap-adt-api（VS Code ABAP 插件用的库）为准

---

> **实现与方案的差别（2026-11-08）**
> - M0 已在 QAS 确认（discovery / 搜索 / 读源码 / 域固定值 / CDS 源码能打开，无开发权限账号 403）。
> - 审计按 〇-AJ 的约定写进 `ZAI_BSTEP`（`KIND = ADT`、`SEQ` 从 1001 起），不另建表；收尾重写过程记录时不删 ADT 行。
> - 工具参数 `object` 既可以是对象地址，也可以直接给对象名（引擎按名字精确搜到地址），省一轮。
> - `adt_read_source` 对域 / 数据元素返回定义和固定值（M0 第 5 项，数据分析可用）；另支持 `keyword` 只看命中行。
> - 场景只作权限（〇-AK）后，条件 2 改为「用户开放了代码分析」。

## 1. 要解决什么

「代码分析」场景现在只有一个读源码工具 `read_program_source`（按名字读报表 / 函数 / 类的源码，分页）。用户真正想问的往往是：

- 「哪些程序调用了 `Z_AI_RFC_RUN`？」——要**被谁使用**（where-used）。
- 「ZCL_AI_AGENT_SERVICE 有哪些方法？」——要**对象结构**，而不是整份几千行源码。
- 「找一下名字带 RPT 的类」——要**按名字搜对象**。
- 「这个包里有什么」——要**包内容**。
- 「这段代码能不能激活 / 有没有语法错误」——要**语法检查**。
- 「这个 CDS / 表 / 结构的定义」——要读 DDIC 和 CDS 的源码。

这些 SAP 自带的 **ADT 接口**（`/sap/bc/adt/…`，Eclipse ABAP 开发工具用的就是它）都现成提供。

## 2. 思路：浏览器直接调 ADT，不新增服务

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 新引擎在浏览器里**直接调本机 ADT 接口**，用用户自己的登录 | 不用新服务、不用存密码；同源（灵犀页面和 ADT 在同一个 SAP 主机）；能力全；权限就是用户本人在 Eclipse 里的权限 | 只有新引擎能用；依赖 ADT 服务开着、用户有开发显示权限 |
| B | 部署一个 ADT 类 MCP 服务（Node / Go） | 现成 | 要另找机器跑、存技术用户密码、浏览器调不到 stdio 服务；公司无外网装依赖也麻烦 |
| C | 在 ABAP 里用标准函数自己实现（`RS_EU_CROSSREF`、`SYNTAX-CHECK`、`TADIR` 等） | 新旧引擎都能用 | 工作量大，等于重写一遍 ADT |

**选 A**。安全边界是 SAP 自己的授权（`S_ADT_RES`、`S_DEVELOP`），灵犀不放大任何权限：用户能在 Eclipse 里看到的，灵犀才看得到。灵犀额外做三件事：
1. **白名单**：引擎只拼固定几类只读地址，模型给不了任意 URL。
2. **开关与名单**：SAP 决定这次运行能不能用 ADT（见 §5）。
3. **审计**：每次 ADT 调用都报给 SAP 记一笔、计入工具次数上限（见 §6）。

## 3. 工具清单（第一期，全部只读）

| 工具 | 做什么 | ADT 接口 |
|---|---|---|
| `adt_search` | 按名字搜对象（可用 `*`，可限类型），返回对象名、类型、说明、包、**对象地址** | `GET /sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=…&maxResults=50[&objectType=CLAS]` |
| `adt_read_source` | 读源码（带行号，按行分页，每次最多 400 行） | `GET {对象地址}/source/main`；类的局部定义 / 实现 / 测试类：`{类地址}/includes/definitions` 等 |
| `adt_structure` | 对象结构：类的方法 / 属性、程序的 FORM / 包含程序、函数组的函数 | `GET {对象地址}/objectstructure` |
| `adt_where_used` | 被谁使用（最多 200 条：对象名、类型、包） | `POST /sap/bc/adt/repository/informationsystem/usageReferences?uri={对象地址}`（固定请求体，见 §4） |
| `adt_package` | 包里的对象（按类型分组） | `POST /sap/bc/adt/repository/nodestructure?parent_type=DEVC/K&parent_name=…&withShortDescriptions=true` |
| `adt_syntax_check` | 对**已激活版本**做语法检查，返回错误 / 警告与行号 | `POST /sap/bc/adt/checkruns?reporters=abapCheckRun`（请求体指定对象地址、`version="active"`） |

对象地址由 `adt_search` 返回，其余工具都用它，模型不用记各类对象的地址规则。白名单（引擎里校验，地址必须匹配其一，名字只允许 `A-Z0-9_/` 和命名空间）：

```
/sap/bc/adt/programs/programs/{名}        报表
/sap/bc/adt/programs/includes/{名}        包含程序
/sap/bc/adt/oo/classes/{名}               类（含 /includes/definitions|implementations|macros|testclasses）
/sap/bc/adt/oo/interfaces/{名}            接口
/sap/bc/adt/functions/groups/{组}[/fmodules/{函数}]   函数组 / 函数
/sap/bc/adt/ddic/ddl/sources/{名}         CDS
/sap/bc/adt/ddic/tables/{名}              表
/sap/bc/adt/ddic/structures/{名}          结构
/sap/bc/adt/ddic/dataelements/{名}        数据元素
/sap/bc/adt/ddic/domains/{名}             域
/sap/bc/adt/packages/{名}                 包
```

**明确不做**（不进白名单）：
- `datapreview`（数据预览 / 自由 SQL）——会绕过灵犀的 SQL 校验与审计。部分 ADT 类 MCP 用它读表数据，我们不用；查数仍走 `run_sql`。
- 写源码、加锁、激活、建传输、删除、重构。
- `classrun`（执行类）、ABAP Unit 运行、调试、跟踪——都会执行代码。
- ATC 第一期不做（异步、要轮询，见 §8）。

## 4. 调用细节（以 abap-adt-api 为准，M0 在 7.55 上实测确认）

- **同源**：灵犀 BSP 页面和 `/sap/bc/adt` 在同一主机端口，浏览器自动带登录 Cookie，不涉及跨域。
- **client / 语言**：所有请求带 `sap-client`、`sap-language`（从页面地址取，和 OData 一致）。
- **CSRF**：GET 不需要。两个 POST（where-used、语法检查）需要令牌：先 `GET /sap/bc/adt/discovery`，请求头带 `x-csrf-token: fetch`，取回应头里的令牌，之后 POST 都带上；遇到 403 且回应头 `x-csrf-token: Required` 时重取一次再试。
- **Accept**：源码 `text/plain`；其余 `application/*`（ADT 会回 XML，浏览器用 `DOMParser` 解析，取需要的属性，不把整份 XML 交给模型）。
- **where-used 请求体**（固定，不让模型改）：

```xml
<?xml version="1.0" encoding="ASCII"?>
<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">
  <usagereferences:affectedObjects/>
</usagereferences:usageReferenceRequest>
```

- **语法检查请求体**（固定，只填对象地址）：

```xml
<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
  <chkrun:checkObject adtcore:uri="{对象地址}" chkrun:version="active"/>
</chkrun:checkObjectList>
```

- **大小与超时**：单次回应超过 2 MB 截断；单次 60 秒超时；返回给模型的内容和其他工具一样裁到 6 万字符以内，长源码靠分页。

## 5. SAP 端：谁能用、什么时候用

`/run/start`（`browser_start`）多回一个 `adt:true/false`，引擎据此决定下发不下发 ADT 工具：

1. 配置 `BROWSER_ADT_ON = X`（新键，默认关）。
2. 场景是「代码分析」（之后视情况放开「自动」）。
3. 用户有开发显示权限：`AUTHORITY-CHECK OBJECT 'S_DEVELOP' ID 'ACTVT' FIELD '03'`（其余字段 DUMMY），和现在 `ZCL_AI_CODE_PROVIDER` 读源码的检查一致。
4. 可选名单 `BROWSER_ADT_USERS`（逗号分隔，空 = 所有满足上面条件的人），试点用。

ADT 自己还会再按 `S_ADT_RES`、`S_DEVELOP` 逐个对象检查；没权限时 ADT 回 403，工具把「没有权限查看 xxx」交给模型如实转告。

## 6. 审计：每次 ADT 调用都记一笔

浏览器直连 ADT，SAP 端的 `browser_tool` 看不到，所以加一个轻量接口：

- 新路径 `POST /sap/bc/zai_agent/tools/audit`：`{ runId, tool, target, status, ms, rows }`。
- SAP 校验运行号（同 `brun_get`）→ `TOOL_CALLS` 原子 +1（超 `BRUN_MAX_TOOL` 返回 429，引擎**先报后调**，被拒就不调 ADT）→ 写一行新表 `ZAI_BSTEP`。
- `ZAI_BSTEP` 顺带作为新引擎的**逐步审计表**（M1 遗留的缺口）：以后 SAP 工具、文件夹改动也可以写进来。

| 字段 | 类型 | 说明 |
|---|---|---|
| MANDT / RUN_ID / SEQ | 键 | 运行号 + 序号 |
| TOOL | CHAR 40 | 工具名 |
| TARGET | SSTRING 512 | ADT 地址 / 对象名（不含源码内容） |
| STATUS | CHAR 10 | OK / DENIED / ERROR |
| MS / ROWS | INT4 | 耗时 / 条数 |
| CREATED_AT | TIMESTAMPL | 时间 |

## 7. 改动范围与工作量

| 部分 | 内容 | 估计 |
|---|---|---|
| 引擎 `agent-bundle` | 新文件 `adt-client.js`（白名单、CSRF、XML 解析、分页）+ 6 个工具；`/run/start` 回 `adt:true` 才挂上 | 0.5 天 |
| SAP | `browser_start` 多回 `adt`；新 `/tools/audit` + `ZAI_BSTEP`；2 个配置键 | 0.5 天 |
| 前端 | 工具中文名（搜对象 / 读源码 / 结构 / 被谁使用 / 包内容 / 语法检查）；演示后端加一份假 ADT（几段示例源码与结构） | 0.3 天 |
| 测试 | 引擎自测加 ADT 场景（模拟 ADT 回应、白名单拒绝、CSRF 重取、403）；ABAP 静态检查 | 0.3 天 |
| 文档 | 《03》《04》新节 + 验收 | 0.2 天 |

旧引擎、`read_program_source` 不动；ADT 不可用时代码场景照旧用 `read_program_source`。

## 8. 分期

- **M0（你在 SAP 上做，约 15 分钟）**——见 §9，确认 ADT 能用、拿到真实回应样本。**M0 不通过就不开工。**
- **M1（本方案）**：§3 六个只读工具 + 审计 + 开关。
- **M2（以后再议）**：ATC 检查（`/sap/bc/adt/atc/worklists` → `/atc/runs` → 取结果，异步）；「把整个类 / 包的源码存到文件夹」（配合新引擎的文件夹，便于离线比对、代码评审）；版本历史比较（`/revisions`）。
- **M3（暂不建议）**：改代码。需要加锁、改源码、激活、选传输请求，出错影响大；即使要做，也必须走和改文件一样的「改前对比 → 用户点应用」，并只允许 `$TMP` 或指定的包。

## 9. M0：请在 SAP 上先确认这几件事

用一个开发账号登录灵犀（HTTPS），在同一个浏览器标签页里：

1. 地址栏打开 `https://<主机:端口>/sap/bc/adt/discovery?sap-client=<客户端>` → 能看到一大段 XML。看不到：SICF 里 `/sap/bc/adt` 没激活（Eclipse ADT 用户一般已经开着）。
2. 打开 `https://<主机:端口>/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=ZCL_AI*&maxResults=10&sap-client=<客户端>` → 能看到灵犀自己的几个类。
3. 打开 `https://<主机:端口>/sap/bc/adt/oo/classes/zcl_ai_agent_http/source/main?sap-client=<客户端>` → 能看到源码。
4. 换一个**没有开发权限**的普通账号试第 3 步 → 应该是 403（说明权限由 SAP 把关，灵犀不会放大）。
5. 把第 2 步的 XML 存一份发我，我按真实格式写解析。

## 10. 风险

| 风险 | 应对 |
|---|---|
| ADT 回应格式随版本略有不同 | M0 拿真实样本；解析只取少数属性，取不到就给原文摘要 |
| 模型拼出白名单外的地址 | 引擎只接受 `adt_search` 返回的地址或按白名单规则校验，不匹配直接拒绝，不发请求 |
| 读大量源码导致上下文过长 | 分页（400 行）、`adt_structure` 先看结构再读具体方法；长结果自动外存 |
| 绕过灵犀 SQL 审计 | 不开放 `datapreview` |
| 审计漏记 | 先报 `/tools/audit` 拿到许可再调 ADT；报不了就不调 |
