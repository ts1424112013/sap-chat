*&---------------------------------------------------------------------*
*& Report ZAI_SCHED_RUNNER
*&---------------------------------------------------------------------*
*& 用途: 定时任务的后台作业步骤(设计: 功能计划书/定时任务/01-方案与开发计划 V1.1)
*&       ZCL_AI_SCHEDULE_SERVICE 保存定时任务时, 以创建人身份为每个触发建一个周期作业,
*&       作业步骤就是本程序; 它只调 run_one: 今天不该跑 / 已暂停 / 被停用就直接结束
*& 安全: 只认定时任务号; 运行内容(数据来源、参数、指令)全部从 ZAI_SCHEDULE 读,
*&       且定时任务的创建人必须是当前作业用户, 手工运行也只能跑自己的定时任务
*& 安装: SE38 新建「可执行程序(类型 1)」, 贴入本文件; 激活顺序在 ZCL_AI_SCHEDULE_SERVICE 之后
*& V1.0 20261104: 首版
*&---------------------------------------------------------------------*
REPORT zai_sched_runner.

PARAMETERS: p_sched TYPE c LENGTH 32 OBLIGATORY,
            p_trig  TYPE c LENGTH 1 DEFAULT '0'.

START-OF-SELECTION.
  DATA lv_trig TYPE i.
  IF p_trig CO '0123456789'.
    lv_trig = p_trig.
  ENDIF.
  zcl_ai_schedule_service=>run_one( iv_sched_id = CONV string( p_sched )
                                    iv_trig_no  = lv_trig ).
