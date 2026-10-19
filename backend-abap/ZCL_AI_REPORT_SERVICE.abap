*=======================================================================
* 对象:   ZCL_AI_REPORT_SERVICE
* 用途:   受控报表服务(《Agent多业务任务与报表分析》P2/P3)
*         - P2: 报表登记(ZAI_RPT_DEF)与参数(ZAI_RPT_PARAM)读取、
*           服务端参数校验(类型/必填/范围/值域/默认值), 只读已有结果;
*           不开放真实执行
*         - P3: 幂等运行(ZAI_RPT_RUN, ClientRequestId 唯一)、状态查询、
*           结果绑定(ZAI_ARTIFACT)与分析状态; 执行走 Mock 适配器
*           (ZCL_AI_REPORT_MOCK, 契约与未来真实作业适配器一致)
* 安全边界(05 提示词 二/六, 全部服务端强制):
*         - REPORT_READ_ENABLED / REPORT_EXEC_ENABLED 双开关(默认关闭,
*           存 ZAI_CHAT_CFG, 复用现有配置系统)
*         - 未登记 TCode / 停用报表 / EXEC 开关未开 / 参数校验失败
*           / 归属校验失败 → 一律拒绝, 不创建运行, 不提交任何作业
*         - 禁止把用户输入拼进 SQL 或程序执行器: 参数只做规范化快照,
*           真正传值是未来 SAP 适配器(SUBMIT WITH SELECTION-TABLE)的职责
*         - 模型输出的 TCode/ReportRunId/ArtifactId 只是候选值,
*           使用前必须过归属/状态校验
*         - TIMEOUT ≠ 作业已停止; UNKNOWN 继续查询; CANCELLED 只在真实
*           取消确认后写入; 空结果(0 行)是有效事实不是失败
* 数据:   ZAI_RPT_DEF / ZAI_RPT_PARAM / ZAI_RPT_RUN / ZAI_RPT_STEP
*         —— SE11 净新增表(见《SE11对象与配置清单》), 建表前本类
*         无法激活, 属 SAP 端阻塞项
* 依赖:   ZCL_AI_TASK_SERVICE(任务归属/状态/结果索引)
*         / ZCL_AI_REPORT_MOCK(测试 double; 真实作业适配器为阻塞项)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50, 755 已核对)
* V1.0    20261007: 首版(登记/参数校验/幂等运行/状态/结果/分析状态)
* V1.0.1  20261007: 踩坑清单自查修正 ——
*         ① 参数解析弃用 /ui2/cl_json=>name_values/name_value/
*           pretty_mode-low_case(本环境零部署先例, 激活风险),
*           改 parse_flat_kv(与 AGENT_GUARD.parse_flat_json 同款正则);
*         ② norm_json 由 [{name,value}] 数组改为扁平对象 {"k":"v"}
*           (与 MOCK read_scenario 解析口径一致, 修复自不一致);
*         ③ fnv_hash 去掉 CONV x1(DDIC 依赖), 改 x LENGTH 1 局部变量
* ★ 重贴后核对标记: parse_flat_kv 正则应与 AGENT_GUARD.parse_flat_json
*   同款; 全文不得出现 name_values/low_case/CONV x1; validate_params
*   的 norm_json 为扁平对象拼装(json_escape 转义)
* V1.0.2  20261008: DDIC 保留字修复 —— LABEL/PROGRAM 是 ABAP 词典保留字,
*   SE11 建表实测报错"是保留字"; 预防性一并改 TITLE/LENGTH/DECIMALS 同族:
*   ZAI_RPT_DEF.PROGRAM→PROGNAME, ZAI_RPT_RUN.PROGRAM→PROGNAME,
*   ZAI_RPT_PARAM.LABEL→DISPLAY_LABEL / LENGTH→TYPE_LENGTH
*   / DECIMALS→TYPE_DECIMALS; 代码内 DB 映射结构同步
*   (ty_def.progname/ty_param 三组件/row_to_def/INSERT/SELECT 清单);
*   ty_result.label 为内部视图名(JSON 键 label), 不变
* V1.0.3  20261008: strict mode 修复 —— 含 @宿主变量的 SELECT 清单必须
*   逗号分隔(SE24 报 "elements must be separated using commas"):
*   get_params 17 列清单、get_result 的 SELECT SINGLE status, report_id
*   两处加逗号; 其余 SELECT 均为单列/SELECT * 无此问题
* V1.0.4  20261008: SE24 激活 10 错修复 ——
*   ① start_run 幂等检查 SELECT SINGLE report_run_id status 两列加逗号
*     (连锁: 内联声明失败→LV_RUN_ID/LV_RUN_STS unknown);
*   ② CHAR32 实参直传 TYPE string 形参一律 CONV(§2.1 模式7, 9 处):
*     lv_id/lv_run_id→short_id, add_step/submit/read_result 的
*     iv_report_run_id, ls_run-task_id→get_task_owned/add_step,
*     ls_run-report_run_id→short_id, ls_art-report_run_id→read_result,
*     lv_rid→get_def; ("No value passed to IV_SUMMARY" 为参数表
*     解析中断的连锁误报, 随②消除)
*   ③ ZCL_AI_REPORT_MOCK unknown = 依赖类未建, 非源码错误:
*     MOCK 与本类互相引用(常量 gc_run_*/parse_flat_kv), 操作法 =
*     两类都贴好(全 inactive)后一起激活
* V1.0.5  20261008: GET_RUN_STATUS 报 Unknown column "ARTIFACT_ID" ——
*   ZAI_RPT_RUN 表无此列(它是 ZAI_ARTIFACT 主键): 拆两条 SELECT,
*   error_code/error_message 取 run 表; artifact_id/row_count 从
*   ZAI_ARTIFACT 按 report_run_id+owner 反查(登记时写入, run 表
*   row_count 不回填恒空); IV_SUMMARY 误报=MOCK 未建时参数表
*   解析中断连锁, 贴好 MOCK 即消
* V1.0.6  20261008: submit 的 iv_user = sy-uname(CHAR12) 直传 string
*   形参报 not compatible(§2.1 模式7 第 10 处) → CONV string;
*   另一错 IV_SUMMARY 缺参 = TASK_SERVICE.update_status 签名
*   iv_summary/iv_pending 未标 OPTIONAL(V1.0.5 已修, 重贴 TASK_SERVICE)
* V1.0.7  20261008: 链路断裂修复 —— 报表链路无人登记结果索引:
*   get_run_status 状态推进到 READY 时补 register_artifact(幂等:
*   先查 zai_artifact 有无, 0 条才登记), 行数/摘要从 mock read_result
*   取(MAX_ROWS 按登记定义), 来源=GC_SRC_SNAPSHOT, dataset_id=运行 ID;
*   此前 zai_artifact 恒空 → ReportResult 永远查空(06 文档链路第4步)
* V1.0.8  20261008: register_artifact 的 iv_source_ref = ls_run-report_id
*   (CHAR 列)直传 string 形参报 not compatible → CONV string(模式7 第11处;
*   同段其余实参均已核对: task_id 已 CONV/session_id 为 string 组件/
*   label 为模板内插/dataset_id 为方法入参 string)
* V1.0.9  20261009: READY 登记结果索引加固(回执校验+兜底+审计可见化) ——
*   ① register_artifact 静默失败(开关/归属校验)无任何可见信息, 前端只
*     会看到"结果不存在或不属于当前用户";
*   ② TASK_SERVICE.register_artifact 的 INSERT 未写 report_run_id 列
*     (表有列/代码漏写) -> 登记成功反查也恒空;
*   ③ /ui2/cl_json serialize(compress) 丢空值键 -> 前端 artifactId 为
*     undefined -> URL 出现字面量 ArtifactId=undefined -> 后端按非空
*     ID 查询报"结果不存在"; 修复 = COUNT 双口径(dataset_id OR
*     report_run_id) + register 成功补写 report_run_id + 失败本类
*     兜底 INSERT(双写两列) + ARTIFACT 审计行(回执/行数/sess/owner)
*     + 失败写 run.error_message
* V1.0.10 20261009: 真实作业适配器接入(ZCL_AI_REPORT_EXEC_SAP) ——
*   路由: ZAI_CHAT_CFG 键 REPORT_EXEC_REAL='X' 走真实 SUBMIT VIA JOB,
*   缺省/其他值走 MOCK(回归通道); submit/poll/read_result 调用点改经
*   ad_submit/ad_poll/ad_read_result 路由(add_step 审计仍共用 MOCK);
*   依赖: ZAI_RPT_PARAM 加列 SEL_KIND CHAR1(P=PARAMETER S=SELECT-OPTION)
*         + 新表 ZAI_RPT_RESULT + 程序端 P_AICAP/P_RUNID 采集参数
*         + ZAI_CHAT_CFG 键 REPORT_EXEC_REAL(缺省关闭=MOCK)
* V1.0.11 20261011: 10.09 遗留问题修复 ——
*   ① 已提交运行的 poll/read_result 按运行自身作业记录路由
*     (adapter_real_for_run: 作业名 ZAI_RPT_* = 真实作业), 中途切换
*     REPORT_EXEC_REAL 不再把 MOCK 运行交给真实适配器查(反之亦然);
*   ② UNKNOWN 是非终态, 不再写 finished_at;
*   ③ 运行 READY → 任务 COMPLETED / FAILED → 任务 FAILED(任务徽标与
*     任务列表不再停在 QUEUED);
*   ④ 提交失败(ad_submit 返回 FAILED)把原因写入 run.error_code/
*     error_message, 轮询/前端步骤条直接显示失败原因;
*   ⑤ validate_params: 多值/范围参数按逗号(兼容竖线)拆分逐项校验 ——
*     原先整串校验, 日期范围 "20261001,20261009" 必报 TYPE、多值超长误报;
*     范围两端次序校验(DATE 字典序 / NUM 数值);
*   ⑥ 新增 find_latest_artifact(会话最近可用报表结果, 可按 TCode 过滤),
*     供 AGENT_SERVICE 对话式结果分析定位结果
* ★ 重贴后核对标记: 全文应有 adapter_real_for_run 与 find_latest_artifact;
*   ad_poll/ad_read_result 内调用 adapter_real_for_run(而非 adapter_real)
* V1.0.12 20261019(改进清单 BE-11): parse_flat_kv 支持 JSON 字符串转义 ——
*   照 AGENT_GUARD V1.1.3 parse_flat_json: 值正则改 "((?:[^"\\]|\\.)*)"
*   按转义成对匹配(值里的 \" 不再截断), 取出后经新私有方法 json_unescape
*   还原(包成 {"v":"..."} 交 /ui2/cl_json); FIND 包 TRY, 正则异常返回空表
*   (由 validate_params 按缺参处理); 冒号两侧 [ ]* 改 \s*。
*   注: V1.0.1 起"parse_flat_kv 与 parse_flat_json 同款正则"的标记以本版为准
* ★ 重贴后核对标记: parse_flat_kv 内有 json_unescape( lv_raw ) 与
*   (?:[^"\\]|\\.)*; PRIVATE SECTION 有 json_unescape 声明
*=======================================================================
CLASS zcl_ai_report_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " ---- 运行状态(02 设计 §2.2; 与任务状态分开保存) ----
    CONSTANTS: gc_run_created   TYPE string VALUE 'CREATED',
               gc_run_submitted TYPE string VALUE 'SUBMITTED',
               gc_run_running   TYPE string VALUE 'RUNNING',
               gc_run_ready     TYPE string VALUE 'READY',
               gc_run_failed    TYPE string VALUE 'FAILED',
               gc_run_timeout   TYPE string VALUE 'TIMEOUT',
               gc_run_unknown   TYPE string VALUE 'UNKNOWN'.

    " 报表定义(对应 ZAI_RPT_DEF)
    TYPES: BEGIN OF ty_def,
             report_id      TYPE string,
             tcode          TYPE string,
             progname       TYPE string,  " V1.0.2: PROGRAM 是 DDIC 保留字
             report_name    TYPE string,
             description    TYPE string,
             report_kind    TYPE string,
             result_mode    TYPE string,
             result_ref     TYPE string,
             exec_mode      TYPE string,
             read_enabled   TYPE abap_bool,
             exec_enabled   TYPE abap_bool,
             analyze_enabled TYPE abap_bool,
             max_rows       TYPE i,
             config_version TYPE string,
             active         TYPE abap_bool,
           END OF ty_def.
    TYPES tt_def TYPE STANDARD TABLE OF ty_def WITH DEFAULT KEY.

    " 参数定义(对应 ZAI_RPT_PARAM)
    TYPES: BEGIN OF ty_param,
             param_id       TYPE string,
             abap_name      TYPE string,
             display_label  TYPE string,  " V1.0.2: LABEL 是 DDIC 保留字
             data_type      TYPE string,
             type_length    TYPE i,       " V1.0.2: LENGTH 是 ABAP 保留词
             type_decimals  TYPE i,       " V1.0.2: DECIMALS 是 ABAP 保留词
             required       TYPE abap_bool,
             multi_value    TYPE abap_bool,
             range_allowed  TYPE abap_bool,
             default_type   TYPE string,
             default_value  TYPE string,
             allowed_ops    TYPE string,
             value_source   TYPE string,
             validation_rule TYPE string,
             help_text      TYPE string,
             sort_no        TYPE i,
             active         TYPE abap_bool,
           END OF ty_param.
    TYPES tt_param TYPE STANDARD TABLE OF ty_param WITH DEFAULT KEY.

    " 参数校验错误(DEFAULTED 类不进 errors, 单独放 defaulted)
    TYPES: BEGIN OF ty_perr,
             param_id TYPE string,
             code     TYPE string,    " REQUIRED/TYPE/RANGE/DOMAIN/TOO_MANY/...
             message  TYPE string,
           END OF ty_perr.
    TYPES tt_perr TYPE STANDARD TABLE OF ty_perr WITH DEFAULT KEY.

    " 扁平 JSON 键值(键已转小写; 解析见 parse_flat_kv —— 沿用
    " AGENT_GUARD.parse_flat_json 已部署验证的正则模式, 不依赖
    " /ui2/cl_json 的 name_values 类型(踩坑清单 §3.B 存在性自查))
    TYPES: BEGIN OF ty_kv,
             name  TYPE string,
             value TYPE string,
           END OF ty_kv.
    TYPES tt_kv TYPE STANDARD TABLE OF ty_kv WITH DEFAULT KEY.

    " 参数校验结果
    TYPES: BEGIN OF ty_pvres,
             ok          TYPE abap_bool,
             needs_input TYPE abap_bool,   " 缺参数 → WAITING_INPUT, 不创建运行
             errors      TYPE tt_perr,
             norm_json   TYPE string,      " 规范化参数快照 JSON
             hash        TYPE string,      " 参数一致性哈希(非安全哈希)
             defaulted   TYPE tt_perr,     " 被默认值补齐的项(前端提示用)
           END OF ty_pvres.

    " 运行启动结果
    TYPES: BEGIN OF ty_run_start,
             report_run_id TYPE string,
             short_id      TYPE string,
             task_id       TYPE string,
             report_id     TYPE string,
             status        TYPE string,
             created       TYPE abap_bool,  " false = 幂等命中已有运行
             rejected      TYPE abap_bool,
             needs_input   TYPE abap_bool,
             message       TYPE string,
           END OF ty_run_start.

    " 运行状态视图(前端/TaskContext 用)
    TYPES: BEGIN OF ty_run_status,
             report_run_id TYPE string,
             short_id      TYPE string,
             task_id       TYPE string,
             report_id     TYPE string,
             status        TYPE string,
             artifact_id   TYPE string,
             artifact_short TYPE string,
             row_count     TYPE i,
             error_code    TYPE string,
             error_message TYPE string,
             message       TYPE string,
           END OF ty_run_status.

    " 结果读取视图(schema + 受控摘要 + 受限样例, 不含全量明细)
    TYPES: BEGIN OF ty_result,
             artifact_id  TYPE string,
             report_run_id TYPE string,
             report_id    TYPE string,
             label        TYPE string,
             status       TYPE string,
             schema_json  TYPE string,
             summary_json TYPE string,
             rows_json    TYPE string,  " 前 N 行样例(上限 = 定义 MAX_ROWS)
             row_count    TYPE i,
             message      TYPE string,
           END OF ty_result.

    " ---- 开关(复用 ZAI_CHAT_CFG) ----

    " REPORT_READ_ENABLED: 登记报表/参数/已有结果可见; 默认关闭
    " ---- V1.0.10: 适配器路由(MOCK <-> EXEC_SAP 透明切换) ----
    CLASS-METHODS adapter_real
      RETURNING VALUE(rv_real) TYPE abap_bool.
    " V1.0.11: 已提交运行按自身作业记录选适配器(不随开关漂移)
    CLASS-METHODS adapter_real_for_run
      IMPORTING iv_report_run_id TYPE string
      RETURNING VALUE(rv_real)   TYPE abap_bool.
    CLASS-METHODS ad_submit
      IMPORTING iv_report_run_id TYPE string
                iv_program       TYPE string
                iv_params_json   TYPE string
                iv_user          TYPE string
      EXPORTING ev_status        TYPE string
                ev_message       TYPE string.
    CLASS-METHODS ad_poll
      IMPORTING iv_report_run_id TYPE string
      EXPORTING ev_status        TYPE string
                ev_message       TYPE string.
    CLASS-METHODS ad_read_result
      IMPORTING iv_report_run_id TYPE string
                iv_max_rows      TYPE i
      EXPORTING ev_schema_json   TYPE string
                ev_summary_json  TYPE string
                ev_rows_json     TYPE string
                ev_row_count     TYPE i
                ev_message       TYPE string.
    CLASS-METHODS read_enabled
      RETURNING VALUE(rv_on) TYPE abap_bool.

    " REPORT_EXEC_ENABLED: 允许创建运行并提交执行; 默认关闭(安全默认)
    CLASS-METHODS exec_enabled
      RETURNING VALUE(rv_on) TYPE abap_bool.

    " ---- 定义与参数(P2) ----

    " 按 TCode 取登记报表(大写; 未登记/停用 → initial, 调用方必须拒绝)
    CLASS-METHODS get_def_by_tcode
      IMPORTING iv_tcode     TYPE string
      RETURNING VALUE(rs)    TYPE ty_def.

    " 按内部编号取登记报表
    CLASS-METHODS get_def
      IMPORTING iv_report_id TYPE string
      RETURNING VALUE(rs)    TYPE ty_def.

    " 登记报表清单(仅 read_enabled 时; 前端能力目录)
    CLASS-METHODS list_defs
      RETURNING VALUE(rt)   TYPE tt_def.

    " 参数定义清单(版本一致; 未登记返回空)
    CLASS-METHODS get_params
      IMPORTING iv_report_id TYPE string
                iv_config_version TYPE string
      RETURNING VALUE(rt)    TYPE tt_param.

    " 服务端参数校验与规范化(纯校验, 无任何拼接/执行):
    " 必填缺失 → needs_input(应转 WAITING_INPUT); 类型/范围/值域错误 → errors
    CLASS-METHODS validate_params
      IMPORTING is_def     TYPE ty_def
                iv_params_json TYPE string   " 用户/模型提交的候选参数
      RETURNING VALUE(rs)  TYPE ty_pvres.

    " ---- 运行(P3; Mock 闭环) ----

    " 幂等启动运行: 同一 ClientRequestId(同一用户)重试返回同一运行;
    " 用户主动重跑必须换新 RequestId
    CLASS-METHODS start_run
      IMPORTING iv_task_id     TYPE string
                iv_session_id  TYPE string
                iv_report_id   TYPE string
                iv_params_json TYPE string
                iv_request_id  TYPE string
      RETURNING VALUE(rs)      TYPE ty_run_start.

    " 运行状态查询(归属校验 → 适配器推进状态机 → 返回视图)
    CLASS-METHODS get_run_status
      IMPORTING iv_report_run_id TYPE string
      RETURNING VALUE(rs)        TYPE ty_run_status.

    " 结果读取(必须 READY + Artifact AVAILABLE + 归属正确;
    " 结果来源无法确认时拒绝分析, 不按"最新数据"猜)
    CLASS-METHODS get_result
      IMPORTING iv_artifact_id TYPE string
      RETURNING VALUE(rs)      TYPE ty_result.

    " 结果可用判定(前端/分析链路用; EXPIRED 只读不删除)
    CLASS-METHODS is_artifact_available
      IMPORTING iv_artifact_id TYPE string
      RETURNING VALUE(rv)      TYPE abap_bool.

    " V1.0.11: 会话内最近一份可用的报表结果(当前用户; AVAILABLE; 有运行号)。
    " iv_tcode 非空时只取该 TCode 的运行。对话式结果分析在前端未带
    " FocusedArtifactId 时用它定位; 找不到返回空(调用方决定回落)
    CLASS-METHODS find_latest_artifact
      IMPORTING iv_session_id    TYPE string
                iv_tcode         TYPE string OPTIONAL
      RETURNING VALUE(rv_art_id) TYPE string.

    " 扁平 JSON 键值解析(仅对象形态, 值限字符串/数字/bool/null, 不支持
    " 嵌套; 正则模式与 AGENT_GUARD.parse_flat_json V1.1.3 一致(V1.0.12 起
    " 支持转义)。键统一转小写; 供本类参数校验与 REPORT_MOCK 场景读取共用)
    CLASS-METHODS parse_flat_kv
      IMPORTING iv_json     TYPE string
      RETURNING VALUE(rt)   TYPE tt_kv.

    " JSON 字符串值转义(手工拼装 norm_json 用)
    CLASS-METHODS json_escape
      IMPORTING iv_text    TYPE string
      RETURNING VALUE(rv)  TYPE string.

  PRIVATE SECTION.

    " V1.0.12(BE-11): JSON 字符串内容反转义(\" \\ \n \uXXXX 等)
    CLASS-METHODS json_unescape
      IMPORTING iv            TYPE string
      RETURNING VALUE(rv)     TYPE string.

    " 定义行 <-> 结构
    CLASS-METHODS row_to_def
      IMPORTING is_row     TYPE zai_rpt_def
      RETURNING VALUE(rs)  TYPE ty_def.

    " 单参数校验(类型/范围/值域); ev_norm 输出规范化值
    CLASS-METHODS validate_one
      IMPORTING is_p      TYPE ty_param
                iv_val    TYPE string
      EXPORTING ev_norm   TYPE string
                ev_err    TYPE string.

    " 滚动窗口一致性哈希(非安全哈希, 仅参数一致性比对):
    " 纯位运算 + x 串移位, 无算术溢出; 输出 16 位十六进制。
    " SAP 端 P0 可按需换标准哈希工具(字段已留 CHAR64), 只要求同系统内确定。
    CLASS-METHODS fnv_hash
      IMPORTING iv_text   TYPE string
      RETURNING VALUE(rv) TYPE string.

    CLASS-METHODS now14
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS ZCL_AI_REPORT_SERVICE IMPLEMENTATION.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>EXEC_ENABLED
* +-------------------------------------------------------------------------------------------------+
* | [<-()] RV_ON                          TYPE        ABAP_BOOL
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD exec_enabled.
    " 双重开关: 全局 REPORT_EXEC_ENABLED 且任务层开关也开
    " (执行必须先有任务归属链路; 任一关闭都拒绝)
    rv_on = xsdbool( zcl_ai_task_service=>read_cfg_str( 'REPORT_EXEC_ENABLED' ) = 'X'
                     AND zcl_ai_task_service=>task_enabled( ) = abap_true ).
  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Private Method ZCL_AI_REPORT_SERVICE=>FNV_HASH
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_TEXT                        TYPE        STRING
* | [<-()] RV                             TYPE        STRING
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD fnv_hash.

    " 一致性哈希(非安全; 位置混入 XOR, 顺序敏感): 每字节写入
    " 槽位 = 位置 MOD 8, 并向相邻槽混入位置低 8 位 —— 字节/顺序变化
    " 都会改变结果; x 类型无算术溢出; 同系统内确定。
    DATA: lv_x   TYPE xstring,
          lv_win TYPE x LENGTH 8,
          lv_len TYPE i,
          lv_i   TYPE i,
          lv_b   TYPE x LENGTH 1,
          lv_s1  TYPE i,
          lv_s2  TYPE i,
          lv_pos TYPE x LENGTH 1.

    TRY.
        lv_x = iv_text.
      CATCH cx_root.
        lv_x = '00'.
    ENDTRY.
    lv_len = xstrlen( lv_x ).
    DO lv_len TIMES.
      lv_i = sy-index - 1.
      lv_b = lv_x+lv_i(1).
      lv_s1 = lv_i MOD 8.
      lv_s2 = ( lv_i + 3 ) MOD 8.
      " i → 单字节(取低 8 位; 不依赖 DDIC 数据元素 X1)
      lv_pos = lv_i MOD 256.
      lv_win+lv_s1(1) = lv_win+lv_s1(1) BIT-XOR lv_b.
      lv_win+lv_s2(1) = lv_win+lv_s2(1) BIT-XOR lv_pos.
    ENDDO.
    rv = lv_win.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>GET_DEF
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_REPORT_ID                   TYPE        STRING
* | [<-()] RS                             TYPE        TY_DEF
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD get_def.

    CLEAR rs.
    IF read_enabled( ) = abap_false.
      RETURN.
    ENDIF.
    SELECT SINGLE * FROM zai_rpt_def
      WHERE report_id = @iv_report_id AND active = 'X'
      INTO @DATA(ls_row).
    IF sy-subrc = 0.
      rs = row_to_def( ls_row ).
    ENDIF.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>GET_DEF_BY_TCODE
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_TCODE                       TYPE        STRING
* | [<-()] RS                             TYPE        TY_DEF
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD get_def_by_tcode.

    CLEAR rs.
    IF read_enabled( ) = abap_false.
      RETURN.
    ENDIF.
    DATA(lv_tc) = to_upper( iv_tcode ).
    CONDENSE lv_tc NO-GAPS.
    SELECT SINGLE * FROM zai_rpt_def
      WHERE tcode = @lv_tc AND active = 'X'
      INTO @DATA(ls_row).
    IF sy-subrc = 0.
      rs = row_to_def( ls_row ).
    ENDIF.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>GET_PARAMS
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_REPORT_ID                   TYPE        STRING
* | [--->] IV_CONFIG_VERSION              TYPE        STRING
* | [<-()] RT                             TYPE        TT_PARAM
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD get_params.

    CLEAR rt.
    IF read_enabled( ) = abap_false OR iv_report_id IS INITIAL.
      RETURN.
    ENDIF.

    " CONFIG_VERSION 必须与主表当前版本一致(不一致 → 视为未登记参数)
    SELECT SINGLE config_version FROM zai_rpt_def
      WHERE report_id = @iv_report_id AND active = 'X'
      INTO @DATA(lv_ver).
    IF sy-subrc <> 0 OR ( iv_config_version IS NOT INITIAL
                          AND iv_config_version <> lv_ver ).
      RETURN.
    ENDIF.

    " V1.0.3: strict mode(含 @宿主变量)要求 SELECT 清单逗号分隔
    SELECT param_id, abap_name, display_label, data_type, type_length,
           type_decimals, required, multi_value, range_allowed,
           default_type, default_value, allowed_ops, value_source,
           validation_rule, help_text, sort_no, active
      FROM zai_rpt_param
      WHERE report_id = @iv_report_id
        AND config_version = @lv_ver
        AND active = 'X'
      ORDER BY sort_no, param_id
      INTO CORRESPONDING FIELDS OF TABLE @rt.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>GET_RESULT
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_ARTIFACT_ID                 TYPE        STRING
* | [<-()] RS                             TYPE        TY_RESULT
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD get_result.

    CLEAR rs.
    IF iv_artifact_id IS INITIAL.
      rs-message = '缺少结果编号'.
      RETURN.
    ENDIF.

    " Artifact 归属 + 状态
    SELECT SINGLE * FROM zai_artifact
      WHERE artifact_id = @iv_artifact_id AND owner = @sy-uname
      INTO @DATA(ls_art).
    IF sy-subrc <> 0.
      rs-message = '结果不存在或不属于当前用户'.
      RETURN.
    ENDIF.
    IF ls_art-status <> 'AVAILABLE'.
      rs-message = |结果当前状态为 { ls_art-status }, 不可读取(过期/失效需重新执行)|.
      RETURN.
    ENDIF.
    IF ls_art-report_run_id IS INITIAL.
      rs-message = '该结果不是报表运行产物, 请走数据分析链路'.
      RETURN.
    ENDIF.

    " 运行必须 READY(结果来源可确认才允许分析; 不按"最新数据"猜)
    SELECT SINGLE status, report_id FROM zai_rpt_run
      WHERE report_run_id = @ls_art-report_run_id AND created_by = @sy-uname
      INTO ( @DATA(lv_sts), @DATA(lv_rid) ).
    IF sy-subrc <> 0.
      rs-message = '无法确认结果来源运行, 已拒绝分析'.
      RETURN.
    ENDIF.
    IF lv_sts <> gc_run_ready.
      rs-message = |运行状态为 { lv_sts }, 结果尚不可读|.
      RETURN.
    ENDIF.

    " 读取受控结果(样例行数受报表 MAX_ROWS 上限约束)
    DATA: lv_def  TYPE ty_def,
          lv_schema TYPE string, lv_summary TYPE string, lv_rows TYPE string,
          lv_cnt TYPE i, lv_msg TYPE string.
    CLEAR: lv_schema, lv_summary, lv_rows, lv_cnt, lv_msg.
    lv_def = get_def( CONV string( lv_rid ) ).
    ad_read_result( 
      EXPORTING iv_report_run_id = CONV string( ls_art-report_run_id )
                iv_max_rows      = lv_def-max_rows
      IMPORTING ev_schema_json   = lv_schema
                ev_summary_json  = lv_summary
                ev_rows_json     = lv_rows
                ev_row_count     = lv_cnt
                ev_message       = lv_msg ).

    IF lv_msg IS NOT INITIAL AND lv_cnt = 0.
      rs-message = lv_msg.
      RETURN.
    ENDIF.

    rs-artifact_id   = ls_art-artifact_id.
    rs-report_run_id = ls_art-report_run_id.
    rs-report_id     = lv_rid.
    rs-label         = ls_art-display_label.
    rs-status        = 'AVAILABLE'.
    rs-schema_json   = lv_schema.
    rs-summary_json  = lv_summary.
    rs-rows_json     = lv_rows.
    rs-row_count     = lv_cnt.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>GET_RUN_STATUS
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_REPORT_RUN_ID               TYPE        STRING
* | [<-()] RS                             TYPE        TY_RUN_STATUS
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD get_run_status.

    CLEAR rs.
    IF iv_report_run_id IS INITIAL.
      rs-message = '缺少运行编号'.
      RETURN.
    ENDIF.

    SELECT SINGLE * FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
        AND created_by = @sy-uname
      INTO @DATA(ls_run).
    IF sy-subrc <> 0.
      rs-message = '运行不存在或不属于当前用户'.
      RETURN.
    ENDIF.

    " 归属链: 运行 → 任务(任务 owner 已由 WHERE 过滤当前用户)
    DATA(ls_task) = zcl_ai_task_service=>get_task_owned(
                      iv_task_id = CONV string( ls_run-task_id ) iv_session_id = '' ).
    IF ls_task-task_id IS INITIAL.
      rs-message = '运行所属任务不可访问'.
      RETURN.
    ENDIF.

    " 未终态: 让适配器推进状态机(Mock: 到时转 READY/FAILED/...;
    " 真实适配器: 查作业状态。TIMEOUT 不等于作业已停止; UNKNOWN 需继续查询)
    IF ls_run-status = gc_run_created OR ls_run-status = gc_run_submitted
       OR ls_run-status = gc_run_running OR ls_run-status = gc_run_unknown.
      DATA: lv_new_sts TYPE string,
            lv_msg     TYPE string.
      CLEAR: lv_new_sts, lv_msg.
      ad_poll( 
        EXPORTING iv_report_run_id = iv_report_run_id
        IMPORTING ev_status        = lv_new_sts
                  ev_message       = lv_msg ).
      IF lv_new_sts IS NOT INITIAL AND lv_new_sts <> ls_run-status.
        DATA(lv_now) = now14( ).
        CASE lv_new_sts.
          WHEN gc_run_ready.
            UPDATE zai_rpt_run SET status = @lv_new_sts, finished_at = @lv_now
              WHERE report_run_id = @iv_report_run_id.
            " V1.0.9: READY 登记结果索引 —— 回执校验 + 本类兜底 + 全程审计
            " 修复: ①register_artifact 静默失败无可见信息
            "       ②TASK_SERVICE 的 INSERT 漏写 report_run_id 列 -> 反查恒空
            "       ③compress 丢空值键 -> 前端 URL 出现字面量 'undefined'
            " 口径: COUNT 双口径; 兜底 INSERT 双写; register 成功后补写
            SELECT COUNT(*) FROM zai_artifact
              WHERE dataset_id = @iv_report_run_id
                 OR report_run_id = @iv_report_run_id.
            IF sy-dbcnt = 0.
              DATA(ls_def_r) = get_def( CONV string( ls_run-report_id ) ).
              DATA: lv_rc   TYPE i,
                    lv_sj   TYPE string,
                    lv_art  TYPE string,
                    lv_art2 TYPE c LENGTH 32.
              CLEAR: lv_rc, lv_sj, lv_art, lv_art2.
              ad_read_result( 
                EXPORTING iv_report_run_id = iv_report_run_id
                          iv_max_rows      = ls_def_r-max_rows
                IMPORTING ev_row_count     = lv_rc
                          ev_summary_json  = lv_sj ).
              lv_art = zcl_ai_task_service=>register_artifact(
                iv_task_id      = CONV string( ls_run-task_id )
                iv_session_id   = ls_task-session_id
                iv_type         = zcl_ai_task_service=>gc_art_report_res
                iv_source_type  = zcl_ai_task_service=>gc_src_snapshot
                iv_source_ref   = CONV string( ls_run-report_id )
                iv_label        = |{ ls_run-tcode } 运行结果|
                iv_row_count    = lv_rc
                iv_summary_json = lv_sj
                iv_dataset_id   = iv_report_run_id ).
              IF lv_art IS NOT INITIAL.
                " register 成功但旧版 INSERT 未写 report_run_id -> 补写, 保证反查口径
                UPDATE zai_artifact SET report_run_id = @iv_report_run_id
                  WHERE artifact_id = @lv_art.
              ELSE.
                " 兜底: register 静默失败(开关/归属校验)时本类直接登记
                " (归属已由本方法开头 created_by + get_task_owned 校验过)
                CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_32 = lv_art2.
                INSERT zai_artifact FROM @(
                  VALUE #( mandt          = sy-mandt
                           artifact_id    = lv_art2
                           task_id        = ls_run-task_id
                           session_id     = ls_task-session_id
                           artifact_type  = zcl_ai_task_service=>gc_art_report_res
                           source_type    = zcl_ai_task_service=>gc_src_snapshot
                           source_ref     = ls_run-report_id
                           dataset_id     = iv_report_run_id
                           report_run_id  = iv_report_run_id
                           display_label  = |{ ls_run-tcode } 运行结果|
                           status         = 'AVAILABLE'
                           row_count      = lv_rc
                           summary_json   = lv_sj
                           owner          = sy-uname
                           created_at     = now14( ) ) ).
                IF sy-subrc = 0.
                  lv_art = lv_art2.
                ENDIF.
              ENDIF.
              " 登记结果全程可见(回执/行数/会话), 失败不再无感
              zcl_ai_report_mock=>add_step(
                iv_report_run_id = iv_report_run_id
                iv_task_id       = CONV string( ls_run-task_id )
                iv_phase         = 'ARTIFACT'
                iv_status        = COND #( WHEN lv_art IS NOT INITIAL THEN 'OK' ELSE 'ERROR' )
                iv_summary       = |结果索引登记: 回执={ lv_art } 行数={ lv_rc } sess={ ls_task-session_id } owner={ sy-uname }| ).
              IF lv_art IS INITIAL.
                " V1.0.9a: UPDATE SET 多列必须逗号分隔(SE24 strict, V1.0.3 同款坑)
                UPDATE zai_rpt_run SET error_code   = 'ARTIFACT_REG',
                                       error_message = '结果索引登记失败(兜底 INSERT 未命中, 见 ARTIFACT 审计行)'
                  WHERE report_run_id = @iv_report_run_id.
              ENDIF.
            ENDIF.
            " V1.0.11: 运行就绪 → 任务完成(乐观锁; 版本冲突仅不推进, 不影响运行)
            zcl_ai_task_service=>update_status(
              iv_task_id = CONV string( ls_run-task_id )
              iv_version = ls_task-current_version
              iv_status  = zcl_ai_task_service=>gc_st_completed
              iv_summary = |{ ls_run-tcode } 运行完成, 结果已登记| ).
          WHEN gc_run_failed OR gc_run_timeout.
            UPDATE zai_rpt_run SET status = @lv_new_sts, finished_at = @lv_now
              WHERE report_run_id = @iv_report_run_id.
            " V1.0.11: 失败 → 任务 FAILED(TIMEOUT 不等于作业已停止, 任务不动)
            IF lv_new_sts = gc_run_failed.
              zcl_ai_task_service=>update_status(
                iv_task_id = CONV string( ls_run-task_id )
                iv_version = ls_task-current_version
                iv_status  = zcl_ai_task_service=>gc_st_failed
                iv_summary = |{ ls_run-tcode } 运行失败| ).
            ENDIF.
          WHEN OTHERS.
            " V1.0.11: UNKNOWN 等非终态只记状态, 不写 finished_at
            UPDATE zai_rpt_run SET status = @lv_new_sts
              WHERE report_run_id = @iv_report_run_id.
        ENDCASE.
        COMMIT WORK.
        zcl_ai_report_mock=>add_step(
          iv_report_run_id = iv_report_run_id iv_task_id = CONV string( ls_run-task_id )
          iv_phase = 'POLL' iv_status = 'OK'
          iv_summary = |状态推进 { ls_run-status } -> { lv_new_sts }| ).
        ls_run-status = lv_new_sts.
      ENDIF.
    ENDIF.

    " 结果绑定状态(READY 时应已有 Artifact; 没有则为结果错误, 拒绝分析)
    " V1.0.5: ZAI_RPT_RUN 无 ARTIFACT_ID 列(SE24 报 Unknown column) ——
    " 结果绑定从 ZAI_ARTIFACT 反查(V1.0.9: 登记双写 report_run_id, 反查必命中);
    " row_count 以登记值为准(run 表该列运行时不回填, 恒空);
    " 错误摘要仍在 run 表
    SELECT SINGLE error_code, error_message
      FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO ( @rs-error_code, @rs-error_message ).
    CLEAR: rs-artifact_id, rs-row_count.
    SELECT SINGLE artifact_id, row_count
      FROM zai_artifact
      WHERE report_run_id = @iv_report_run_id AND owner = @sy-uname
      INTO ( @rs-artifact_id, @rs-row_count ).

    rs-report_run_id = ls_run-report_run_id.
    rs-short_id      = zcl_ai_task_service=>short_id( CONV string( ls_run-report_run_id ) ).
    rs-task_id       = ls_run-task_id.
    rs-report_id     = ls_run-report_id.
    rs-status        = ls_run-status.
    rs-artifact_short = COND #( WHEN rs-artifact_id IS NOT INITIAL
                                THEN zcl_ai_task_service=>short_id( rs-artifact_id ) ELSE '' ).

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>IS_ARTIFACT_AVAILABLE
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_ARTIFACT_ID                 TYPE        STRING
* | [<-()] RV                             TYPE        ABAP_BOOL
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD is_artifact_available.

    rv = abap_false.
    IF iv_artifact_id IS INITIAL.
      RETURN.
    ENDIF.
    SELECT SINGLE status FROM zai_artifact
      WHERE artifact_id = @iv_artifact_id AND owner = @sy-uname
      INTO @DATA(lv_sts).
    rv = xsdbool( sy-subrc = 0 AND lv_sts = 'AVAILABLE' ).

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>FIND_LATEST_ARTIFACT
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_SESSION_ID                  TYPE        STRING
* | [--->] IV_TCODE                       TYPE        STRING(optional)
* | [<-()] RV_ART_ID                      TYPE        STRING
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD find_latest_artifact.

    " V1.0.11: 只认当前用户、本会话、AVAILABLE 且来自报表运行的结果;
    " 读取时仍须过 get_result 的 READY/归属校验(这里只做定位)
    CLEAR rv_art_id.
    IF iv_session_id IS INITIAL.
      RETURN.
    ENDIF.
    DATA(lv_tc) = to_upper( iv_tcode ).
    CONDENSE lv_tc NO-GAPS.

    SELECT artifact_id, report_run_id, created_at
      FROM zai_artifact
      WHERE session_id    = @iv_session_id
        AND owner         = @sy-uname
        AND status        = 'AVAILABLE'
        AND report_run_id <> ' '
      ORDER BY created_at DESCENDING
      INTO TABLE @DATA(lt_a)
      UP TO 20 ROWS.

    LOOP AT lt_a INTO DATA(ls_a).
      IF lv_tc IS NOT INITIAL.
        SELECT SINGLE tcode FROM zai_rpt_run
          WHERE report_run_id = @ls_a-report_run_id
          INTO @DATA(lv_run_tc).
        IF sy-subrc <> 0 OR lv_run_tc <> lv_tc.
          CONTINUE.
        ENDIF.
      ENDIF.
      rv_art_id = ls_a-artifact_id.
      RETURN.
    ENDLOOP.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>JSON_ESCAPE
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_TEXT                        TYPE        STRING
* | [<-()] RV                             TYPE        STRING
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD json_escape.

    rv = iv_text.
    REPLACE ALL OCCURRENCES OF '\' IN rv WITH '\\'.
    REPLACE ALL OCCURRENCES OF '"' IN rv WITH '\"'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv WITH ' '.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv WITH ' '.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Private Method ZCL_AI_REPORT_SERVICE=>JSON_UNESCAPE
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV                             TYPE        STRING
* | [<-()] RV                             TYPE        STRING
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD json_unescape.

    TYPES: BEGIN OF ty_box,
             v TYPE string,
           END OF ty_box.
    DATA: ls_box  TYPE ty_box,
          lv_json TYPE string.

    rv = iv.
    IF find( val = iv sub = `\` ) < 0.
      RETURN.
    ENDIF.

    " parse_flat_kv 的正则已保证 iv 是合法的 JSON 字符串内容(转义成对),
    " 包成 {"v":"..."} 交 /ui2/cl_json 还原(与 AGENT_GUARD.json_unescape 同法);
    " 失败时保留原文(由 validate_params 按原样校验)
    lv_json = `{"v":"` && iv && `"}`.
    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json          = lv_json
                    name_mappings = VALUE #( ( abap = 'V' json = 'v' ) )
          CHANGING  data          = ls_box ).
        rv = ls_box-v.
      CATCH cx_root.
        rv = iv.
    ENDTRY.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>LIST_DEFS
* +-------------------------------------------------------------------------------------------------+
* | [<-()] RT                             TYPE        TT_DEF
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD list_defs.

    CLEAR rt.
    IF read_enabled( ) = abap_false.
      RETURN.
    ENDIF.
    SELECT * FROM zai_rpt_def
      WHERE active = 'X'
      ORDER BY PRIMARY KEY
      INTO TABLE @DATA(lt).
    LOOP AT lt INTO DATA(ls_row).
      APPEND row_to_def( ls_row ) TO rt.
    ENDLOOP.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Private Method ZCL_AI_REPORT_SERVICE=>NOW14
* +-------------------------------------------------------------------------------------------------+
* | [<-()] RV                             TYPE        STRING
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD now14.
    rv = |{ sy-datum }{ sy-uzeit }|.
  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>PARSE_FLAT_KV
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_JSON                        TYPE        STRING
* | [<-()] RT                             TYPE        TT_KV
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD parse_flat_kv.

    " 扁平键值解析(正则模式与已部署的 AGENT_GUARD.parse_flat_json 一致;
    " 偏移/长度先落中间变量 —— 踩坑清单 §2.1-2 三犯模式对策)
    " 只接受对象形态; 值限 "字符串" / 数字 / true / false / null
    CLEAR rt.
    DATA(lv_inner) = iv_json.
    IF strlen( lv_inner ) >= 2 AND lv_inner(1) = '{'.
      DATA(lv_len)  = strlen( lv_inner ).
      DATA(lv_body) = lv_len - 2.
      lv_inner = lv_inner+1(lv_body).
    ELSE.
      RETURN.
    ENDIF.

    " V1.0.12(BE-11): 字符串值按 JSON 转义成对匹配, 取出后反转义;
    "   正则异常(值过长等)返回空表, 由 validate_params 按缺参处理
    DATA: lt_m   TYPE match_result_tab,
          lv_raw TYPE string.
    TRY.
        FIND ALL OCCURRENCES OF REGEX
          '"([A-Za-z0-9_]+)"\s*:\s*("((?:[^"\\]|\\.)*)"|(-?[0-9]+(\.[0-9]+)?|true|false|null))'
          IN lv_inner RESULTS lt_m.
      CATCH cx_root.
        RETURN.
    ENDTRY.

    LOOP AT lt_m INTO DATA(ls_m).
      DATA(lv_s1) = ls_m-submatches[ 1 ].
      DATA(lv_s3) = ls_m-submatches[ 3 ].
      DATA(lv_s4) = ls_m-submatches[ 4 ].
      DATA(lv_key) = to_lower( substring( val = lv_inner
                                          off = lv_s1-offset
                                          len = lv_s1-length ) ).
      DATA(lv_val) = ``.
      IF lv_s3-length > 0.
        " 带引号字符串: 取引号内内容并反转义(V1.0.12)
        lv_raw = substring( val = lv_inner off = lv_s3-offset len = lv_s3-length ).
        lv_val = json_unescape( lv_raw ).
      ELSEIF lv_s4-length > 0.
        lv_val = substring( val = lv_inner off = lv_s4-offset len = lv_s4-length ).
      ENDIF.
      APPEND VALUE #( name = lv_key value = lv_val ) TO rt.
    ENDLOOP.

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>READ_ENABLED
* +-------------------------------------------------------------------------------------------------+
* | [<-()] RV_ON                          TYPE        ABAP_BOOL
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD adapter_real.
    " V1.0.10: REPORT_EXEC_REAL='X' -> 真实作业适配器; 缺省=MOCK(安全默认)
    rv_real = xsdbool( zcl_ai_task_service=>read_cfg_str( 'REPORT_EXEC_REAL' ) = 'X' ).
  ENDMETHOD.


  METHOD adapter_real_for_run.
    " V1.0.11: 运行一旦提交, 由它自己的作业记录决定适配器:
    " 作业名 ZAI_RPT_*(EXEC_SAP 写入) = 真实作业; 有其他值 = MOCK;
    " 尚无作业记录(未提交/提交失败)才按当前开关
    SELECT SINGLE sap_job_name FROM zai_rpt_run
      WHERE report_run_id = @iv_report_run_id
      INTO @DATA(lv_jn).
    IF sy-subrc = 0 AND lv_jn CP 'ZAI_RPT_*'.
      rv_real = abap_true.
    ELSEIF sy-subrc = 0 AND lv_jn IS NOT INITIAL.
      rv_real = abap_false.
    ELSE.
      rv_real = adapter_real( ).
    ENDIF.
  ENDMETHOD.


  METHOD ad_submit.
    CLEAR: ev_status, ev_message.
    IF adapter_real( ) = abap_true.
      zcl_ai_report_exec_sap=>submit(
        EXPORTING iv_report_run_id = iv_report_run_id
                  iv_program       = iv_program
                  iv_params_json   = iv_params_json
                  iv_user          = iv_user
        IMPORTING ev_status        = ev_status
                  ev_message       = ev_message ).
    ELSE.
      zcl_ai_report_mock=>submit(
        EXPORTING iv_report_run_id = iv_report_run_id
                  iv_program       = iv_program
                  iv_params_json   = iv_params_json
                  iv_user          = iv_user
        IMPORTING ev_status        = ev_status
                  ev_message       = ev_message ).
    ENDIF.
  ENDMETHOD.


  METHOD ad_poll.
    CLEAR: ev_status, ev_message.
    IF adapter_real_for_run( iv_report_run_id ) = abap_true.
      zcl_ai_report_exec_sap=>poll(
        EXPORTING iv_report_run_id = iv_report_run_id
        IMPORTING ev_status        = ev_status
                  ev_message       = ev_message ).
    ELSE.
      zcl_ai_report_mock=>poll(
        EXPORTING iv_report_run_id = iv_report_run_id
        IMPORTING ev_status        = ev_status
                  ev_message       = ev_message ).
    ENDIF.
  ENDMETHOD.


  METHOD ad_read_result.
    CLEAR: ev_schema_json, ev_summary_json, ev_rows_json, ev_row_count, ev_message.
    IF adapter_real_for_run( iv_report_run_id ) = abap_true.
      zcl_ai_report_exec_sap=>read_result(
        EXPORTING iv_report_run_id = iv_report_run_id
                  iv_max_rows      = iv_max_rows
        IMPORTING ev_schema_json   = ev_schema_json
                  ev_summary_json  = ev_summary_json
                  ev_rows_json     = ev_rows_json
                  ev_row_count     = ev_row_count
                  ev_message       = ev_message ).
    ELSE.
      zcl_ai_report_mock=>read_result(
        EXPORTING iv_report_run_id = iv_report_run_id
                  iv_max_rows      = iv_max_rows
        IMPORTING ev_schema_json   = ev_schema_json
                  ev_summary_json  = ev_summary_json
                  ev_rows_json     = ev_rows_json
                  ev_row_count     = ev_row_count
                  ev_message       = ev_message ).
    ENDIF.
  ENDMETHOD.


  METHOD read_enabled.
    rv_on = xsdbool( zcl_ai_task_service=>read_cfg_str( 'REPORT_READ_ENABLED' ) = 'X' ).
  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Private Method ZCL_AI_REPORT_SERVICE=>ROW_TO_DEF
* +-------------------------------------------------------------------------------------------------+
* | [--->] IS_ROW                         TYPE        ZAI_RPT_DEF
* | [<-()] RS                             TYPE        TY_DEF
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD row_to_def.

    rs-report_id       = is_row-report_id.
    rs-tcode           = is_row-tcode.
    rs-progname         = is_row-progname.
    rs-report_name     = is_row-report_name.
    rs-description     = is_row-description.
    rs-report_kind     = is_row-report_kind.
    rs-result_mode     = is_row-result_mode.
    rs-result_ref      = is_row-result_ref.
    rs-exec_mode       = is_row-exec_mode.
    rs-read_enabled    = xsdbool( is_row-read_enabled = 'X' ).
    rs-exec_enabled    = xsdbool( is_row-exec_enabled = 'X' ).
    rs-analyze_enabled = xsdbool( is_row-analyze_enabled = 'X' ).
    rs-max_rows        = is_row-max_rows.
    rs-config_version  = is_row-config_version.
    rs-active          = xsdbool( is_row-active = 'X' ).

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>START_RUN
* +-------------------------------------------------------------------------------------------------+
* | [--->] IV_TASK_ID                     TYPE        STRING
* | [--->] IV_SESSION_ID                  TYPE        STRING
* | [--->] IV_REPORT_ID                   TYPE        STRING
* | [--->] IV_PARAMS_JSON                 TYPE        STRING
* | [--->] IV_REQUEST_ID                  TYPE        STRING
* | [<-()] RS                             TYPE        TY_RUN_START
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD start_run.

    CLEAR rs.
    rs-task_id   = iv_task_id.
    rs-report_id = iv_report_id.

    " ---- 开关: 执行能力默认关闭 ----
    IF exec_enabled( ) = abap_false.
      rs-rejected = abap_true.
      rs-message  = '报表执行能力未开启(REPORT_EXEC_ENABLED), 已拒绝提交'.
      RETURN.
    ENDIF.

    " ---- 定义核验: 已登记 + 活跃 + 该报表 EXEC 开 ----
    DATA(ls_def) = get_def( iv_report_id ).
    IF ls_def-report_id IS INITIAL.
      " 未登记的报表绝不因模型/用户输入临时加入白名单
      rs-rejected = abap_true.
      rs-message  = |报表 { iv_report_id } 未登记或已停用, 无法执行|.
      RETURN.
    ENDIF.
    IF ls_def-exec_enabled = abap_false.
      rs-rejected = abap_true.
      rs-message  = |报表 { ls_def-report_name } 未开放执行权限|.
      RETURN.
    ENDIF.

    " ---- 任务归属核验(运行挂在任务下) ----
    DATA(ls_task) = zcl_ai_task_service=>get_task_owned(
                      iv_task_id = iv_task_id iv_session_id = iv_session_id ).
    IF ls_task-task_id IS INITIAL.
      rs-rejected = abap_true.
      rs-message  = '任务不存在或不属于当前会话, 已拒绝提交'.
      RETURN.
    ENDIF.

    " ---- RequestId 幂等(网络重试返回同一运行, 不产生第二个运行) ----
    IF iv_request_id IS INITIAL.
      rs-rejected = abap_true.
      rs-message  = '缺少 ClientRequestId, 已拒绝提交'.
      RETURN.
    ENDIF.
    " V1.0.4: 两列清单加逗号(strict mode)
    SELECT SINGLE report_run_id, status FROM zai_rpt_run
      WHERE request_id = @iv_request_id AND created_by = @sy-uname
      INTO ( @DATA(lv_run_id), @DATA(lv_run_sts) ).
    IF sy-subrc = 0.
      rs-report_run_id = lv_run_id.
      rs-short_id      = zcl_ai_task_service=>short_id( CONV string( lv_run_id ) ).
      rs-status        = lv_run_sts.
      rs-created       = abap_false.
      rs-message       = '请求已存在, 返回原有运行(幂等)'.
      RETURN.
    ENDIF.

    " ---- 参数校验: 缺参数/类型错 → WAITING_INPUT, 不创建运行 ----
    DATA(ls_pv) = validate_params( is_def = ls_def iv_params_json = iv_params_json ).
    IF ls_pv-ok = abap_false.
      rs-rejected    = abap_true.
      rs-needs_input = ls_pv-needs_input.
      IF ls_pv-needs_input = abap_true.
        rs-status  = zcl_ai_task_service=>gc_st_waiting_input.
        rs-message = '参数未齐或校验未通过, 请补填后重试(本次未创建运行)'.
      ELSE.
        rs-message = '参数校验未通过, 已拒绝提交(本次未创建运行)'.
      ENDIF.
      RETURN.
    ENDIF.

    " ---- 创建运行(参数/配置版本冻结在运行记录; 后改草稿不影响) ----
    DATA lv_id TYPE c LENGTH 32.
    CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_32 = lv_id.

    INSERT zai_rpt_run FROM @(
      VALUE #( mandt          = sy-mandt
               report_run_id  = lv_id
               task_id        = iv_task_id
               request_id     = iv_request_id
               report_id      = ls_def-report_id
               config_version = ls_def-config_version
               tcode          = ls_def-tcode
               progname       = ls_def-progname
               params_json    = ls_pv-norm_json
               params_hash    = ls_pv-hash
               status         = gc_run_created
               created_by     = sy-uname
               created_at     = now14( ) ) ).
    COMMIT WORK.

    " 步骤审计: VALIDATE OK(脱敏摘要, 不写完整参数)
    " V1.0.4: CHAR32 实参直传 TYPE string 形参一律 CONV(§2.1 模式7)
    zcl_ai_report_mock=>add_step(
      iv_report_run_id = CONV string( lv_id ) iv_task_id = iv_task_id
      iv_phase = 'VALIDATE' iv_status = 'OK'
      iv_summary = |参数校验通过(哈希 { ls_pv-hash })| ).

    " ---- 提交(Mock 适配器; 真实 SAP 作业适配器为阻塞项) ----
    " 适配器只拿规范化参数快照与运行 ID, 不做任何字符串拼接执行
    DATA: lv_sub_sts TYPE string, lv_sub_msg TYPE string.
    ad_submit( 
      EXPORTING iv_report_run_id = CONV string( lv_id )
                iv_program       = ls_def-progname
                iv_params_json   = ls_pv-norm_json
                iv_user          = CONV string( sy-uname )  " V1.0.6: CHAR12→string 形参(§2.1 模式7)
      IMPORTING ev_status        = lv_sub_sts
                ev_message       = lv_sub_msg ).

    DATA(lv_now) = now14( ).
    UPDATE zai_rpt_run
      SET status = @lv_sub_sts, started_at = @lv_now
      WHERE report_run_id = @lv_id.
    " V1.0.11: 提交失败原因落 run 表(轮询返回 error_message, 前端步骤条直接展示;
    " 原先只写状态, 用户只看到"失败"不知原因)。宿主变量按列类型声明 → 超长自动截断
    IF lv_sub_sts = gc_run_failed.
      DATA lv_sub_err TYPE zai_rpt_run-error_message.
      lv_sub_err = lv_sub_msg.
      UPDATE zai_rpt_run SET error_code    = 'SUBMIT',
                             error_message = @lv_sub_err,
                             finished_at   = @lv_now
        WHERE report_run_id = @lv_id.
    ENDIF.
    COMMIT WORK.

    zcl_ai_report_mock=>add_step(
      iv_report_run_id = CONV string( lv_id ) iv_task_id = iv_task_id
      iv_phase = 'SUBMIT' iv_status = COND #( WHEN lv_sub_sts = gc_run_submitted
                                              THEN 'OK' ELSE 'ERROR' )
      iv_summary = lv_sub_msg ).

    rs-report_run_id = lv_id.
    rs-short_id      = zcl_ai_task_service=>short_id( CONV string( lv_id ) ).
    rs-status        = lv_sub_sts.
    rs-created       = abap_true.
    rs-message       = lv_sub_msg.

    " 任务状态推进(乐观锁; 版本冲突不影响运行记录, 下次查询时补偿)
    " V1.0.11: 提交即失败时任务直接 FAILED(不再挂在 QUEUED)
    zcl_ai_task_service=>update_status(
      iv_task_id = iv_task_id iv_version = ls_task-current_version
      iv_status  = COND #( WHEN lv_sub_sts = gc_run_failed
                           THEN zcl_ai_task_service=>gc_st_failed
                           ELSE zcl_ai_task_service=>gc_st_queued ) ).

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Private Method ZCL_AI_REPORT_SERVICE=>VALIDATE_ONE
* +-------------------------------------------------------------------------------------------------+
* | [--->] IS_P                           TYPE        TY_PARAM
* | [--->] IV_VAL                         TYPE        STRING
* | [<---] EV_NORM                        TYPE        STRING
* | [<---] EV_ERR                         TYPE        STRING
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD validate_one.

    CLEAR: ev_norm, ev_err.

    " ---- BOOL ----
    IF is_p-data_type = 'BOOL'.
      IF iv_val = 'true' OR iv_val = 'X' OR iv_val = 'x' OR iv_val = '1'.
        ev_norm = 'X'.
      ELSEIF iv_val = 'false' OR iv_val = '0'.
        ev_norm = ''.
      ELSE.
        ev_err = 'TYPE'.
      ENDIF.
      RETURN.
    ENDIF.

    " ---- DATE: YYYYMMDD 且合法(1900 起, 月/日有效) ----
    IF is_p-data_type = 'DATE'.
      IF strlen( iv_val ) <> 8 OR iv_val CN '0123456789'.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      DATA lv_dat TYPE d.
      lv_dat = iv_val.
      IF lv_dat IS INITIAL OR lv_dat(4) < '1900'.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      IF lv_dat+4(2) BETWEEN '01' AND '12' AND lv_dat+6(2) BETWEEN '01' AND '31'.
        ev_norm = iv_val.
      ELSE.
        ev_err = 'TYPE'.
      ENDIF.
      RETURN.
    ENDIF.

    " ---- NUM: 数字(允许负号/小数点), 长度上限, 可解析性 ----
    IF is_p-data_type = 'NUM'.
      IF iv_val CN '0123456789.-'.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      DATA(lv_v) = condense( val = iv_val ).
      IF is_p-type_length > 0 AND strlen( lv_v ) > is_p-type_length.
        ev_err = 'TYPE'.
        RETURN.
      ENDIF.
      TRY.
          DATA(lv_f) = CONV f( lv_v ).
          ev_norm = |{ lv_f }|.
        CATCH cx_root.
          ev_err = 'TYPE'.
          RETURN.
      ENDTRY.
      ev_norm = lv_v.
      RETURN.
    ENDIF.

    " ---- ENUM: 值域(允许值清单存 VALIDATION_RULE, 逗号分隔) ----
    IF is_p-data_type = 'ENUM'.
      IF is_p-validation_rule IS NOT INITIAL.
        SPLIT is_p-validation_rule AT ',' INTO TABLE DATA(lt_list).
        READ TABLE lt_list TRANSPORTING NO FIELDS
          WITH KEY table_line = iv_val.
        IF sy-subrc <> 0.
          ev_err = 'DOMAIN'.
          RETURN.
        ENDIF.
      ENDIF.
      ev_norm = iv_val.
      RETURN.
    ENDIF.

    " ---- CHAR(默认): 长度上限 ----
    IF is_p-type_length > 0 AND strlen( iv_val ) > is_p-type_length.
      ev_err = 'TYPE'.
      RETURN.
    ENDIF.
    ev_norm = iv_val.

    " 说明: 范围/多值按契约在前端序列化为 "low|high" / "a|b";
    " 本层逐项校验标量, 真实选择表转换属未来 SAP 适配器。

  ENDMETHOD.


* <SIGNATURE>---------------------------------------------------------------------------------------+
* | Static Public Method ZCL_AI_REPORT_SERVICE=>VALIDATE_PARAMS
* +-------------------------------------------------------------------------------------------------+
* | [--->] IS_DEF                         TYPE        TY_DEF
* | [--->] IV_PARAMS_JSON                 TYPE        STRING
* | [<-()] RS                             TYPE        TY_PVRES
* +--------------------------------------------------------------------------------------</SIGNATURE>
  METHOD validate_params.

    CLEAR rs.
    rs-ok = abap_true.

    " 参数定义必须存在(未登记参数的报表不可交互)
    DATA(lt_p) = get_params( iv_report_id = is_def-report_id
                             iv_config_version = is_def-config_version ).
    IF lt_p IS INITIAL.
      rs-ok = abap_false.
      APPEND VALUE #( param_id = ''
                      code = 'NO_SCHEMA'
                      message = |报表 { is_def-report_id } 没有可用的参数定义| )
        TO rs-errors.
      RETURN.
    ENDIF.

    " 解析用户参数 JSON 为 name→value 映射(扁平键值, 键小写;
    " 多值约定: 前端按参数 Schema 把数组序列化为 "|" 分隔字符串,
    " 真实 SAP 选择表转换是未来适配器职责, 本层不做任何拼接执行)
    DATA: lt_kv TYPE tt_kv,
          ls_kv TYPE ty_kv.
    IF iv_params_json IS NOT INITIAL.
      lt_kv = parse_flat_kv( iv_params_json ).
    ENDIF.

    " 逐参数校验(顺序 = 表单顺序); 规范化快照手工拼装为扁平对象
    " {"p_werks":"1000",...}(键小写; 值经转义)
    DATA: lt_norm TYPE tt_kv,
          lv_norm_json TYPE string.
    LOOP AT lt_p INTO DATA(ls_p).
      CLEAR ls_kv.
      READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-param_id ).
      IF sy-subrc <> 0.
        READ TABLE lt_kv INTO ls_kv WITH KEY name = to_lower( ls_p-abap_name ).
      ENDIF.

      DATA(lv_val) = COND string( WHEN sy-subrc = 0 THEN ls_kv-value ELSE `` ).

      " 缺值 → 默认值补齐或必填报错
      IF lv_val IS INITIAL.
        CASE to_upper( ls_p-default_type ).
          WHEN 'STATIC'.
            lv_val = ls_p-default_value.
            APPEND VALUE #( param_id = ls_p-param_id code = 'DEFAULTED'
                            message = |{ ls_p-display_label } 已按默认值 { lv_val } 补齐| )
              TO rs-defaulted.
          WHEN 'USER'.
            lv_val = sy-uname.
            APPEND VALUE #( param_id = ls_p-param_id code = 'DEFAULTED'
                            message = |{ ls_p-display_label } 已按当前用户补齐| )
              TO rs-defaulted.
          WHEN OTHERS.
            IF ls_p-required = abap_true.
              rs-ok = abap_false.
              rs-needs_input = abap_true.
              APPEND VALUE #( param_id = ls_p-param_id code = 'REQUIRED'
                              message = |{ ls_p-display_label } 为必填项, 请填写后重试| )
                TO rs-errors.
            ENDIF.
            CONTINUE.
        ENDCASE.
        IF lv_val IS INITIAL.
          CONTINUE.
        ENDIF.
      ENDIF.

      " 单值校验(类型/范围/值域)
      DATA: lv_norm TYPE string, lv_err TYPE string.
      CLEAR: lv_norm, lv_err.
      IF ls_p-multi_value = abap_true OR ls_p-range_allowed = abap_true.
        " V1.0.11: 多值/范围逐项校验 —— 前端 AskCard 多值 "a,b,c"、范围
        " "low,high"(兼容 "|"); 规范化为逗号分隔, EXEC_SAP 据此拆成选择表行
        DATA: lt_items TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
              lv_item  TYPE string,
              lv_inorm TYPE string,
              lv_ierr  TYPE string,
              lv_split TYPE string.
        CLEAR: lt_items, lv_inorm, lv_ierr.
        lv_split = lv_val.
        REPLACE ALL OCCURRENCES OF '|' IN lv_split WITH ','.
        SPLIT lv_split AT ',' INTO TABLE lt_items.
        LOOP AT lt_items INTO lv_item.
          CONDENSE lv_item.
          IF lv_item IS INITIAL.
            CONTINUE.
          ENDIF.
          validate_one( EXPORTING is_p = ls_p iv_val = lv_item
                        IMPORTING ev_norm = lv_inorm ev_err = lv_ierr ).
          IF lv_ierr IS NOT INITIAL.
            lv_err = lv_ierr.
            EXIT.
          ENDIF.
          lv_norm = COND #( WHEN lv_norm IS INITIAL THEN lv_inorm
                            ELSE lv_norm && ',' && lv_inorm ).
        ENDLOOP.
        " 范围两端次序(仅范围、非多值、恰好两项): DATE 字典序即时间序, NUM 按数值
        IF lv_err IS INITIAL AND ls_p-range_allowed = abap_true
           AND ls_p-multi_value = abap_false.
          DATA: lv_rlo TYPE string,
                lv_rhi TYPE string.
          CLEAR: lv_rlo, lv_rhi.
          SPLIT lv_norm AT ',' INTO lv_rlo lv_rhi.
          IF lv_rlo IS NOT INITIAL AND lv_rhi IS NOT INITIAL.
            IF ls_p-data_type = 'NUM'.
              TRY.
                  IF CONV f( lv_rlo ) > CONV f( lv_rhi ).
                    lv_err = 'RANGE'.
                  ENDIF.
                CATCH cx_root.
                  lv_err = 'TYPE'.
              ENDTRY.
            ELSEIF lv_rlo > lv_rhi.
              lv_err = 'RANGE'.
            ENDIF.
          ENDIF.
        ENDIF.
      ELSE.
        validate_one( EXPORTING is_p = ls_p iv_val = lv_val
                      IMPORTING ev_norm = lv_norm ev_err = lv_err ).
      ENDIF.
      IF lv_err IS NOT INITIAL.
        rs-ok = abap_false.
        APPEND VALUE #( param_id = ls_p-param_id
                        code     = lv_err
                        message  = |{ ls_p-display_label }: 值 "{ lv_val }" 校验未通过({ lv_err })| )
          TO rs-errors.
        CONTINUE.
      ENDIF.
      APPEND VALUE #( name = to_lower( ls_p-param_id ) value = lv_norm )
        TO lt_norm.
    ENDLOOP.

    " 提交了未定义的参数 → 拒绝(不静默丢弃, 防越权字段)
    LOOP AT lt_kv INTO ls_kv.
      DATA(lv_defined) = abap_false.
      LOOP AT lt_p INTO DATA(ls_chk).
        IF to_lower( ls_chk-param_id ) = ls_kv-name
           OR to_lower( ls_chk-abap_name ) = ls_kv-name.
          lv_defined = abap_true.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_defined = abap_false.
        rs-ok = abap_false.
        APPEND VALUE #( param_id = ls_kv-name code = 'UNKNOWN_PARAM'
                        message = |参数 { ls_kv-name } 不在该报表的登记参数中, 已拒绝| )
          TO rs-errors.
      ENDIF.
    ENDLOOP.

    IF rs-ok = abap_true.
      " 跨参数规则(VALIDATION_RULE 引用 'GE:<param_id>' / 'LE:<param_id>'):
      " 如 结束日期 GE 开始日期(DATE 按字典序/NUM 按数值比较)
      LOOP AT lt_p INTO DATA(ls_rule) WHERE validation_rule CS 'GE:'
                                         OR validation_rule CS 'LE:'.
        DATA: lv_op  TYPE string,
              lv_ref TYPE string.
        SPLIT ls_rule-validation_rule AT ':' INTO lv_op lv_ref.
        CONDENSE: lv_op, lv_ref.
        DATA(lv_self) = VALUE string( ).
        DATA(lv_base) = VALUE string( ).
        READ TABLE lt_norm INTO DATA(ls_n1) WITH KEY name = to_lower( ls_rule-param_id ).
        IF sy-subrc = 0. lv_self = ls_n1-value. ENDIF.
        READ TABLE lt_norm INTO ls_n1 WITH KEY name = to_lower( lv_ref ).
        IF sy-subrc = 0. lv_base = ls_n1-value. ENDIF.
        IF lv_self IS INITIAL OR lv_base IS INITIAL.
          CONTINUE.
        ENDIF.
        DATA lv_bad TYPE abap_bool.
        IF lv_self CN '0123456789.-' OR lv_base CN '0123456789.-'
           OR lv_self IS INITIAL OR lv_base IS INITIAL.
          " 非数值(DATE 等)按字符串比较(YYYYMMDD 字典序即时间序)
          IF lv_op = 'GE'.
            lv_bad = xsdbool( lv_self < lv_base ).
          ELSE.
            lv_bad = xsdbool( lv_self > lv_base ).
          ENDIF.
        ELSE.
          DATA: lv_f1 TYPE f, lv_f2 TYPE f.
          lv_f1 = CONV f( lv_self ).
          lv_f2 = CONV f( lv_base ).
          IF lv_op = 'GE'.
            lv_bad = xsdbool( lv_f1 < lv_f2 ).
          ELSE.
            lv_bad = xsdbool( lv_f1 > lv_f2 ).
          ENDIF.
        ENDIF.
        IF lv_bad = abap_true.
          rs-ok = abap_false.
          APPEND VALUE #( param_id = ls_rule-param_id code = 'RANGE'
                          message = |{ ls_rule-display_label } 与基准参数 { lv_ref } 违反 { lv_op } 关系| )
            TO rs-errors.
        ENDIF.
      ENDLOOP.
    ENDIF.

    IF rs-ok = abap_false.
      RETURN.
    ENDIF.

    " 规范化快照(扁平对象 JSON) + 一致性哈希
    " (绑定 ReportRun; 修改参数 → 新哈希 → 旧授权失效)
    DATA lv_first_kv TYPE abap_bool VALUE abap_true.
    lv_norm_json = '{'.
    LOOP AT lt_norm INTO DATA(ls_nkv).
      IF lv_first_kv = abap_false.
        lv_norm_json = lv_norm_json && ','.
      ENDIF.
      lv_first_kv = abap_false.
      lv_norm_json = lv_norm_json && '"' && ls_nkv-name && '":"' &&
                     json_escape( ls_nkv-value ) && '"'.
    ENDLOOP.
    lv_norm_json = lv_norm_json && '}'.

    rs-norm_json = lv_norm_json.
    rs-hash = fnv_hash( |{ is_def-report_id }{ is_def-config_version }| && rs-norm_json ).

  ENDMETHOD.
ENDCLASS.
