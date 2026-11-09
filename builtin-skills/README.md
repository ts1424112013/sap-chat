# 灵犀内置技能

这里是内置技能的源文件。它们**不进前端包**：`node scripts/build-builtin-skills.js` 打成内置技能包 `部署产物/builtin-skills.json`，
管理员在「设置 → 技能 → 技能管理 → 内置 → 导入内置技能包」导入到 SAP 表 `ZAI_BSKILL`（《03》〇-AV）。
用户用新引擎提问时，SAP 只下发启用的、适用场景和他开放的场景有交集的内置技能（`metadata.scenes`）；只开了报表 / Fiori 的普通用户拿不到。
模型觉得和问题相关时先读 `SKILL.md` 再回答，过程里只显示「使用技能：xxx（内置）」；引擎规则不让模型把原文、文件清单给用户看。
不占 SAP 技能的 3000 字限制。管理员在「内置」里可以看全文、单个启用 / 停用。

## 目前的技能

来源：[sap-trench](https://github.com/shrek-abaper/sap-functional-skill/tree/main/skills/sap-trench-skill)（MIT，见 `LICENSE-sap-trench`，取自 517c562 / 2026-05-30）。
按模块拆开，每个技能开头加了「怎么用」：回答结构、S/4HANA 的表和口径差异、灵犀里只讲知识不执行操作。车辆管理（IS-AUTO VMS）一节没有收。

| 目录 | 名称 | 原文件 |
|---|---|---|
| sap-troubleshooting | SAP 报错排查案例 | troubleshooting.md |
| sap-tcode-tables | SAP 事务码与表速查 | reference-tables.md |
| sap-mm | MM 采购与库存 | mm.md |
| sap-sd | SD 销售、交货与开票 | sd.md |
| sap-fico | FI/CO 财务与成本 | fico.md |
| sap-pp | PP 生产计划 | pp.md |
| sap-wm | WM 仓库管理 | wm.md |
| sap-qm | QM 质量管理 | qm.md |
| sap-pm | PM 设备维护 | pm.md |
| sap-abap | ABAP 增强与性能 | abap.md |
| sap-integration | SAP 接口集成 | integration.md |
| sap-auth | SAP 权限排查 | auth.md |
| sap-print | SAP 打印与表单 | print.md |

### ABAP 代码类（2026-11-10 加）

| 目录 | 名称 | 来源（许可） | 附带资料 |
|---|---|---|---|
| abap-code-review | ABAP 代码审查 | [sap-engineering-skill](https://github.com/shrek-abaper/sap-engineering-skill) abap-code-review（MIT，845e920），主文件译成中文并按灵犀工具改写 | references/：安全规则、Clean ABAP 规则、报告模板（原文英文） |
| clean-abap | Clean ABAP 规范 | [abap-skills](https://github.com/likweitan/abap-skills) abap（MIT，b3306be），去掉 abaplint，命名前缀按公司习惯 | references/：检查清单、正反例速查（原文英文） |
| abap-unit-testing | ABAP 单元测试 | [abap-skills](https://github.com/likweitan/abap-skills) abap-unit-testing（MIT，b3306be），去掉 RAP 部分 | references/：测试环境例子（原文英文） |
| abap-syntax-755 | ABAP 7.55 语法边界 | 参考 [superclaude-for-sap](https://github.com/babamba2/superclaude-for-sap) abap-release-reference（MIT，fab560a），按 7.55 重写并核对（原文有几处版本标错） | 无 |

许可证原文：`LICENSE-sap-trench`、`LICENSE-sap-engineering-skill`、`LICENSE-likweitan-abap-skills`、`LICENSE-superclaude-for-sap`。

## 增加或修改技能

1. 新建 `builtin-skills/<目录>/SKILL.md`，目录名只用小写字母、数字和连字符。开头写：

   ```
   ---
   name: <和目录名一样>
   description: "<中文名称>：什么情况下用（模型靠这句决定读不读，写具体）"
   metadata:
     scenes: "DATA,CODE"   # 适用场景：REPORT / FIORI / DATA / CODE，逗号分隔；只下发给开放了其中任一场景的用户
     order: <列表里的顺序，数字小的在前>
     title: "<中文名称>"
     source: "<出处>"
   ---
   ```

   同目录下的其他 `.md`（如 `references/xxx.md`）会作为附带资料一起打包，在 SKILL.md 里写清什么时候读哪份。
2. 运行 `node scripts/build-builtin-skills.js`，生成 `部署产物/builtin-skills.json`（`npm run build` 前也会自动跑）。
3. 在技能管理 →「内置」→「导入内置技能包」选这个文件。不用重新打前端包，SAP 后台也不用改。

技能只是做法和知识，不改变任何权限：查数据、执行报表仍按用户本人的场景、报表授权和 SAP 表权限检查。
新引擎跑在浏览器里，模型读到的内容在浏览器开发者工具里仍看得到；真正要保密的公司内部内容不要写进技能。
