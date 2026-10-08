【重要】ZCL_AI_DATA_ANALYSIS_SERVICE 恢复指引（2026-10-08）
========================================================

⚠ 本批次交付包里【没有】这个类的源文件——原因：
  我方清理脚本不识别反引号字符串，生成的"无注释版"代码有损坏，已作废。
  请不要使用任何渠道流传的该类"2026-10-08 无注释版"。

恢复步骤（二选一）：

方案 A（推荐，从你系统当前状态恢复）：
  SE24 → ZCL_AI_DATA_ANALYSIS_SERVICE → 源代码
  → 找到常量行（约 L137）：
     CONSTANTS gc_allow_tables TYPE string VALUE 'ZIDPPP099'.
  → 改为：
     CONSTANTS gc_allow_tables TYPE string VALUE 'ZIDPPP099|ZIDPMM455'.
  → 激活。
  说明：如果 SE24 里显示的是我发的"带注释 V13.3 版"（含 unknown comments
  警告的），它本身可激活，只改上面这一行即可；警告"unknown comments"不影响运行。

方案 B（从 10-06 部署包恢复）：
  用你 2026-10-06 部署时的 backend-abap-final 包里的
  ZCL_AI_DATA_ANALYSIS_SERVICE.abap（V13.2）整类重贴，
  然后同方案 A 改 gc_allow_tables 那一行的 VALUE 加 |ZIDPMM455，激活。

改完后验证：
  SE16 → ZAI_TABLE_CFG 无需配置（V13.2 是常量白名单）。
  前端直接问：「分析 ZIDPMM455 表，按 WERKS 统计记录数」
  → Trace 应显示实体 ZIDPMM455 进入能力目录（build_cap_from_ddic 自动生成字段）。
