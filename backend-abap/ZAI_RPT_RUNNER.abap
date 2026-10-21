*&---------------------------------------------------------------------*
*& Report ZAI_RPT_RUNNER
*&---------------------------------------------------------------------*
*& 用途: 报表执行的通用后台作业入口 —— ZCL_AI_REPORT_EXEC_SAP 把它作为作业步骤
*&       (SUBMIT ZAI_RPT_RUNNER VIA JOB), 它再 SUBMIT 登记的报表程序并采集 ALV 数据,
*&       业务报表程序零改动(不再需要 P_AICAP / P_RUNID / FORM ai_capture)
*& 安全: 程序名与参数都不来自本屏 —— 只读 ZAI_RPT_RUN(运行记录, 创建时已冻结),
*&       并复核登记(ZAI_RPT_DEF 活动 + 开放执行 + 程序名一致)和运行归属,
*&       手工运行也无法借它执行任意程序
*& 安装: SE38 新建「可执行程序(类型 1)」, 贴入本文件; 激活顺序在
*&       ZCL_AI_ALV_CAPTURE / ZCL_AI_REPORT_EXEC_SAP 之后
*& V1.0 20261021: 首版
*&---------------------------------------------------------------------*
REPORT zai_rpt_runner.

PARAMETERS p_runid TYPE c LENGTH 32 OBLIGATORY.

START-OF-SELECTION.
  zcl_ai_report_exec_sap=>run_captured( iv_report_run_id = CONV string( p_runid ) ).
