*=======================================================================
* 对象:   ZCL_AI_CHAT_SERVICE
* 用途:   AI 对话业务编排(供 OData DPC_EXT 调用)
*         - get_models     : 读取模型配置列表(前端下拉框/模型管理)
*         - analyze        : 核心流程: 提取源码 -> 组装提示词 -> 调大模型 -> 保存消息
*         - save_model_cfg : 模型配置维护(前端"模型管理"保存, upsert)
* 依赖:   ZCL_AI_CODE_PROVIDER / ZCL_AI_LLM_CLIENT
* 表:     ZAI_MODEL_CFG / ZAI_CHAT_MSG
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (适用 S/4HANA 760, ABAP 7.5x)
* V1.2:   前端 V4 的 PROGRAM_NAME 恒为空, 新增 detect_program 从提问
*         文本自动识别 Z/Y 对象名; 其余逻辑与 V1.1 文档一致
* V1.3:   1) detect_program 重写: V1.2 的 \b 正则 ABAP 不支持(POSIX 引擎
*            无 \b, 部分版本直接报 CX_SY_REGEX... ), 改为词元扫描;
*            并经 TADIR 校验, 排除 ZIP/ZOOM 等普通单词误报
*         2) 新增 test_model: 前端"模型管理-测试"按钮的后端实现,
*            发最小请求验证地址/鉴权/网络, 返回耗时与错误原因
*         3) 表结构分析: 识别到 TABL/VIEW 时提示词改为表结构语境
* V1.5:   对象不存在时不再报错中断 —— 降级为普通对话
* V1.6:   表数据分析 —— 提问含"表 XXX"时, 在字段结构外再取样前10行
*         真实数据送入大模型; 对象不存在时把"系统中不存在"作为 system
*         事实注入提示词, 由模型如实告知用户
* V1.7:   事务代码解析 —— 候选词先查 TSTC(如 ZAPP0018 → ZAPP_IDP_0018),
*         命中则分析其主报表程序, meta 提示定位过程; 日常 tcode 习惯直接可用
* V1.8:   表名说法增强 —— 支持"表结构 XXX"与"XXX 表"(名字在前)两种口语;
*         显式提到的表名即使系统不存在也进入分析流程(模型如实告知)
* V2.0:   全量合并版 —— 本文件已并入原 ZAI_CHAT_V8_ADMIN.abap 第三步的
*         全部 V8 管理方法(登录鉴权/角色/泡泡/用户/系统配置, 共 11 个),
*         并修正原稿两处问题: ① V8 方法统一声明为 CLASS-METHODS
*         (DPC_EXT 以 zcl_ai_chat_service=>v8_xxx( ) 静态调用, 原稿的
*         实例方法声明会编译报错); ② 静态方法内不再使用 me-> 自引用。
*         ★ 本版本可直接整类覆盖粘贴, 无需再执行任何"追加"操作。
* V2.1:   条件取样(表数据分析增强) —— 提问中可带过滤条件与行数:
*         "分析表 MARC 中 WERKS=1000 的数据" / "看下 ZTXX 前一百行的 Matnr"
*         新增 detect_where 解析(仅支持 字段=值 AND ... 简单模式), 字段名
*         逐一过 DDIC 白名单校验, 值仅允许数字/带引号字面量(单引号转义),
*         出现 OR/LIKE/子查询等不支持语法时整体放弃条件(降级无条件取样),
*         绝不部分采用 —— 防 SQL 注入, 杜绝拼出意外语句。
*         护栏放宽: 取样 10 行→50 行(提问可指定, 上限 200), 4KB→16KB。
* V2.2:   V10 功能升级 ——
*         1) 模型级开关 SKIP_SOURCE(ZAI_MODEL_CFG 新字段): 勾选后该模型
*            不做源码提取, 提到 tcode/程式也按普通对话处理;
*         2) 智能路由: AnalyzeCode 的 ModelId 传 "AUTO" 时按任务类型自动
*            选模型(有代码/表对象 → 首选未跳过源码的启用模型, 否则默认),
*            手动指定具体模型则完全按手动; LLM 调用失败自动换启用模型兜底;
*         3) 模型级代码权限 USER_HIDE_SRC(ZAI_MODEL_CFG 新字段): 该模型
*            配置"USER 禁看源码"后, 普通用户(USER)提问 tcode/程式时不下发
*            源码, 仅注入程序元信息(名称/类型/标题/修改人), 由模型解释程式
*            用途; ADMIN 不受限; TABL/VIEW 表分析不受管控;
*         4) 超长源码分块 LONG_SRC_CHUNK(ZAI_CHAT_CFG=X): 源码超过 6000 行时
*            按 2000 行/块(最多 5 块)逐块生成摘要, 再级联摘要作答(较慢);
*         5) 表样例指定字段列: "看下 表 MARA 的 MATNR,MTART" → SELECT 指定列,
*            宽表有效样例行数大幅提升(字段过 DD03L 白名单防注入);
*         6) 会话置顶/重命名: ZAI_CHAT_SESS 新增 PINNED, 新增 v8_update_session
*            (FI UpdateSession), 仅限本人会话。
* V2.2.4: 编译修正版(2026-10-01) ——
*         read_program_meta: TRDIRT 的程序名字段是 NAME 而非 PROGNAME
*         (PROGNAME 是 REPOSRC 的字段, 原代码两处混用导致
*         "Unknown column name PROGNAME", 并连带 LV_T 内联声明失败报
*         "The field LV_T is unknown")。REPOSRC 的 progname 用法正确, 保留。
*         ① 会话模式列名修正: MODE 是 DDIC 保留字, SE11 无法建名为 MODE 的列,
*            表字段实际为 SESSION_MODE(见文档表 2-2)。本版将所有对
*            ZAI_CHAT_SESS 的 mode 列/组件引用统一改为 session_mode
*            (analyze 模式校验 / get_sessions / upsert_session);
*            输出结构 ty_session_out 的组件名仍为 mode, 前端与 SEGW 不受影响。
*         ② chat_fallback 的 iv_failed 入参改用 CONV string( ) 传值,
*            避免 ZAI_MODEL_CFG-MODEL_ID 与 string 参数的类型兼容性报错。
*         ③ ty_v8_result 类型定义真正前移: V2.2.1 仅移到 V8 方法组之前,
*            但更早声明的 v8_update_session(L183) 同样引用该类型, 导致
*            激活仍报 "The type TY_V8_RESULT is unknown"。现将其定义移至
*            类 PUBLIC SECTION 头部(所有方法声明之前), 彻底解决。
*=======================================================================
CLASS zcl_ai_chat_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " ---- 模型列表(输出到前端, 不含 API Key 明文) ----
    TYPES: BEGIN OF ty_model_out,
             model_id     TYPE string,
             model_name   TYPE string,
             model_desc   TYPE string,
             model_type   TYPE string,
             endpoint_url TYPE string,
             destination  TYPE string,
             api_model    TYPE string,
             auth_type    TYPE string,
             temperature  TYPE string,
             max_tokens   TYPE string,
             timeout_sec  TYPE string,
             is_active    TYPE string,
             skip_source  TYPE string,   " V2.2: X = 该模型不做源码解析(闲聊/轻量模型)
             user_hide_src TYPE string,  " V2.2: X = USER 角色用此模型时不下发源码(仅程式用途)
             api_key_set  TYPE string,   " X = 已配置密钥
           END OF ty_model_out.
    TYPES tt_models TYPE STANDARD TABLE OF ty_model_out WITH DEFAULT KEY.

    " ---- AnalyzeCode 函数导入返回结构(与 SEGW 复杂类型一致) ----
    TYPES: BEGIN OF ty_analyze_result,
             session_id   TYPE string,
             answer       TYPE string,
             program_name TYPE string,
             model_id     TYPE string,
             code_lines   TYPE i,
             elapsed_ms   TYPE i,
             status       TYPE string,   " OK / ERROR
             message      TYPE string,
           END OF ty_analyze_result.

    " ---- SaveModelCfg 函数导入返回结构 ----
    TYPES: BEGIN OF ty_save_result,
             success TYPE string,        " X = 成功
             message TYPE string,
           END OF ty_save_result.

    " ---- V1.3: TestModel 函数导入返回结构(与 SEGW 复杂类型一致) ----
    TYPES: BEGIN OF ty_test_result,
             success    TYPE string,     " X = 连通
             message    TYPE string,     " 错误原因 / 成功说明
             elapsed_ms TYPE string,     " 往返耗时(毫秒)
           END OF ty_test_result.

    " ================================================================
    " V2.0 合并: V8 权限与配置管理(登录鉴权/角色/泡泡/用户/系统配置)
    " 统一返回结构: Success("X"=成功) / Message / Json(JSON 文本数据)
    " V2.2.3: 类型定义前移 —— v8_update_session / v8_save_user 等所有
    "         V8 方法的 RETURNING 都引用本类型, 必须先定义后使用,
    "         否则激活报 "The type TY_V8_RESULT is unknown"
    " ================================================================
    TYPES: BEGIN OF ty_v8_result,
             success TYPE c LENGTH 1,
             message TYPE string,
             json    TYPE string,
           END OF ty_v8_result.

    " ---- 会话列表(前端左侧历史栏) ----
    " V12: 新增 Mode/AgentType/Status(对话模式与 Agent 模式分离);
    "      老数据 Mode 为空按 CHAT 读取, 不迁移不补写
    TYPES: BEGIN OF ty_session_out,
             session_id TYPE string,
             title      TYPE string,
             model_id   TYPE string,
             msg_count  TYPE string,
             created_at TYPE string,
             changed_at TYPE string,
             pinned     TYPE string,    " V2.2: X = 置顶
             mode       TYPE string,    " V12: CHAT / AGENT(空=CHAT)
             agent_type TYPE string,    " V12: AGENT 时如 INVENTORY
             status     TYPE string,    " V12: Agent 任务状态(RUNNING/COMPLETED/PARTIAL/FAILED)
           END OF ty_session_out.
    TYPES tt_sessions TYPE STANDARD TABLE OF ty_session_out WITH DEFAULT KEY.

    CONSTANTS: gc_max_history TYPE i VALUE 10,    " 送入大模型的上下文条数
               gc_store_max   TYPE i VALUE 100.   " 每会话最多保留的消息条数

    " 读取模型配置列表
    CLASS-METHODS get_models
      EXPORTING et_models TYPE tt_models.

    " 核心分析/对话流程
    CLASS-METHODS analyze
      IMPORTING iv_session_id   TYPE string
                iv_question     TYPE string
                iv_model_id     TYPE string
                iv_program_name TYPE string
      EXPORTING es_result       TYPE ty_analyze_result.

    " 维护模型配置(存在则更新, 不存在则创建)
    CLASS-METHODS save_model_cfg
      IMPORTING iv_model_id     TYPE string
                iv_model_name   TYPE string
                iv_model_desc   TYPE string
                iv_model_type   TYPE string
                iv_endpoint_url TYPE string
                iv_destination  TYPE string
                iv_api_model    TYPE string
                iv_api_key      TYPE string
                iv_auth_type    TYPE string
                iv_temperature  TYPE string
                iv_max_tokens   TYPE string
                iv_timeout_sec  TYPE string
                iv_is_active    TYPE string
                iv_skip_source  TYPE string OPTIONAL
                iv_user_hide_src TYPE string OPTIONAL
      EXPORTING es_result       TYPE ty_save_result.

    " 会话列表(按最近修改排序, 仅当前用户)
    CLASS-METHODS get_sessions
      EXPORTING et_sessions      TYPE tt_sessions.

    " 删除会话及全部消息(仅限本人会话)
    CLASS-METHODS delete_session
      IMPORTING iv_session_id    TYPE string
      EXPORTING es_result        TYPE ty_save_result.

    " V2.2: 更新会话(仅限本人) —— 重命名标题 / 置顶切换(FI UpdateSession)
    CLASS-METHODS v8_update_session
      IMPORTING iv_session_id TYPE string
                iv_title      TYPE string OPTIONAL
                iv_pinned     TYPE string OPTIONAL
      RETURNING VALUE(rs)     TYPE ty_v8_result.

    " V1.3: 测试模型连通性(最小请求, 返回耗时/错误原因)
    CLASS-METHODS test_model
      IMPORTING iv_model_id      TYPE string
      EXPORTING es_result        TYPE ty_test_result.

    " ================================================================
    " V2.0 合并: V8 权限与配置管理(登录鉴权/角色/泡泡/用户/系统配置)
    " (返回结构 ty_v8_result 已在类头部统一定义, 见 V2.2.3 说明)
    " ================================================================

    " 登录鉴权: 网关 Basic 已验密, 此处查授权表(未登记/停用 → 拒绝)
    CLASS-METHODS v8_login
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 角色列表(启用的)
    CLASS-METHODS v8_get_roles
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 角色全量覆盖保存(iv_json = JSON 数组文本 ["a","b"])
    CLASS-METHODS v8_save_roles
      IMPORTING iv_json   TYPE string
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 泡泡提示词列表(启用的, 按 SORT_NO)
    CLASS-METHODS v8_get_prompts
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 泡泡提示词全量覆盖保存(iv_json = JSON 数组文本)
    CLASS-METHODS v8_save_prompts
      IMPORTING iv_json   TYPE string
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 用户列表(仅管理员)
    CLASS-METHODS v8_get_users
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 开通/更新用户(仅管理员; iv_json = {UserId,UserName,Role,Active})
    CLASS-METHODS v8_save_user
      IMPORTING iv_json   TYPE string
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 读系统配置(ConfigKey 如 BACKEND_URL / INITIALIZED)
    CLASS-METHODS v8_get_config
      IMPORTING iv_key    TYPE string
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " 写系统配置(仅管理员; BACKEND_URL 成功 → 自动置 INITIALIZED)
    CLASS-METHODS v8_save_config
      IMPORTING iv_key    TYPE string
                iv_val    TYPE string
      RETURNING VALUE(rs) TYPE ty_v8_result.

    " YYYYMMDDhhmmss 时间戳
    CLASS-METHODS v8_now
      RETURNING VALUE(rv) TYPE char14.

    " 管理员校验(非 ADMIN 抛业务异常, DPC 层转 403 语义)
    CLASS-METHODS v8_require_admin
      RAISING cx_static_check.

  PRIVATE SECTION.

    TYPES: BEGIN OF ty_dbmsg,
             role    TYPE c LENGTH 10,
             content TYPE string,
           END OF ty_dbmsg.
    TYPES tt_dbmsg TYPE STANDARD TABLE OF ty_dbmsg WITH DEFAULT KEY.

    " V2.2: 提问中指定的表字段列清单("表 MARA 的 MATNR,MTART")
    TYPES tt_fields TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    CONSTANTS: gc_chunk_lines  TYPE i VALUE 2000,   " V2.2: 分块摘要每块行数
               gc_chunk_max    TYPE i VALUE 5,      " V2.2: 分块数量上限
               gc_fallback_max TYPE i VALUE 2.      " V2.2: 故障切换最多尝试数

    " 系统提示词
    CLASS-METHODS build_system_prompt
      RETURNING VALUE(rv_prompt) TYPE string.

    " V1.2: 前端 V4 不再自动附带分析对象(PROGRAM_NAME 恒为空),
    " 改为从提问文本中识别第一个 Z/Y 开头的 ABAP 对象名
    " V1.7: 候选词先按事务代码(TSTC)解析 —— 命中则返回其主报表程序,
    "       并经 ev_tcode 带回命中的 tcode 供 meta 提示
    CLASS-METHODS detect_program
      IMPORTING iv_question    TYPE string
      EXPORTING ev_tcode       TYPE string
      RETURNING VALUE(rv_prog) TYPE string.

    " V1.6: 取数据库表/视图的样例数据行(前10行, 单元格截断, 总量≤4KB)
    "       供 analyze 将真实数据一并交给大模型分析; 无权限/无数据等
    "       情况不报错, 经 ev_note 返回说明。
    " V2.1: 支持条件取样 —— it_cond 传入已校验的过滤条件, iv_max_rows
    "       指定行数(默认 50, 上限 200), 护栏放宽至 16KB。
    " V2.2: it_fields 指定字段列(非空时 SELECT 指定列, 仅输出这些列),
    "       宽表场景有效样例行数大幅提升。
    TYPES: BEGIN OF ty_where_cond,
             field TYPE string,          " 已过 DDIC 白名单校验的字段名
             value TYPE string,          " 已转义的安全字面量(字符串带引号)
           END OF ty_where_cond.
    TYPES tt_where_cond TYPE STANDARD TABLE OF ty_where_cond WITH DEFAULT KEY.

    CLASS-METHODS get_table_sample
      IMPORTING iv_tabname      TYPE string
                it_cond         TYPE tt_where_cond OPTIONAL
                it_fields       TYPE tt_fields OPTIONAL
                iv_max_rows     TYPE i DEFAULT 50
      EXPORTING ev_sample       TYPE string
                ev_note         TYPE string.

    " V2.2: 从提问解析「表 XXX 的 F1,F2」指定的字段列清单。
    "   逗号(中英文)/顿号分隔, 逐个过 DD03L 白名单校验, 无效字段剔除;
    "   不足 2 个有效字段视为未指定(返回空), 避免误判普通提问。
    CLASS-METHODS detect_fields
      IMPORTING iv_question      TYPE string
                iv_tabname       TYPE string
      RETURNING VALUE(rt_fields) TYPE tt_fields.

    " V2.1: 从提问解析过滤条件与行数(条件取样)
    "   识别 "WERKS=1000 AND MTART=FERT"、"前 100 行" 等口语;
    "   字段名经 DDIC 校验(白名单), 值仅数字/带引号字面量(转义),
    "   出现不支持语法(OR/LIKE/NOT/括号/子查询)→整体放弃条件;
    "   et_cond 为空 = 无条件(普通取样), 不报错。
    CLASS-METHODS detect_where
      IMPORTING iv_question     TYPE string
                iv_tabname      TYPE string
      EXPORTING et_cond         TYPE tt_where_cond
                ev_rows         TYPE i
                ev_note         TYPE string.

    " V1.3: 读取模型配置(指定 ID 或第一条启用行), analyze/test_model 共用
    CLASS-METHODS read_model_cfg
      IMPORTING iv_model_id      TYPE string
      RETURNING VALUE(rs_cfg)    TYPE zai_model_cfg.

    " V2.2: 模型路由 —— ModelId 为空或 'AUTO' 时按任务类型自动选模型:
    "   有代码/表对象(iv_has_obj=X) → 首选未跳过源码(SKIP_SOURCE<>'X')的启用模型;
    "   无对象(纯闲聊)             → 第一条启用模型;
    "   手动指定具体模型 ID         → 完全按手动(read_model_cfg 原逻辑)。
    CLASS-METHODS route_model
      IMPORTING iv_model_id     TYPE string
                iv_has_obj      TYPE abap_bool
      RETURNING VALUE(rs_cfg)   TYPE zai_model_cfg.

    " V2.2: 读全局开关(ZAI_CHAT_CFG.CFGVALUE='X'), 如 LONG_SRC_CHUNK
    CLASS-METHODS is_cfg_on
      IMPORTING iv_key        TYPE string
      RETURNING VALUE(rv_on)  TYPE abap_bool.

    " V2.2: 当前登录用户的业务角色(ZAI_CHAT_USER.ROLE), 未登记返回空
    CLASS-METHODS v8_get_role
      RETURNING VALUE(rv_role) TYPE string.

    " V2.2: 程序元信息(名称/类型/标题/修改人), 模型开启 USER_HIDE_SRC 时对
    "       普通用户替代源码注入, 让模型讲解程式用途而不展示代码。
    CLASS-METHODS read_program_meta
      IMPORTING iv_prog        TYPE string
      RETURNING VALUE(rv_meta) TYPE string.

    " V2.2: 超长源码分块摘要(LONG_SRC_CHUNK 开启且源码>6000 行时调用):
    "   按 gc_chunk_lines 行/块逐块调 LLM 生成要点摘要, 最多 gc_chunk_max 块,
    "   超出部分注明未纳入; 摘要级联返回给 analyze 组装最终提示词。
    CLASS-METHODS chunk_summarize
      IMPORTING is_cfg        TYPE zai_model_cfg
                iv_prog       TYPE string
                is_src        TYPE zcl_ai_code_provider=>ty_source
      EXPORTING ev_summary    TYPE string
                ev_chunks     TYPE i.

    " V2.2: 故障自动切换 —— 首选模型调用失败后遍历其余启用模型重试
    "       (跳过 iv_failed, 最多 gc_fallback_max 个); 全部失败时
    "       ev_error 返回最后一次错误、ev_model_id 为空。
    CLASS-METHODS chat_fallback
      IMPORTING it_messages  TYPE zcl_ai_llm_client=>tt_messages
                iv_failed    TYPE string
      EXPORTING ev_content   TYPE string
                ev_elapsed   TYPE i
                ev_error     TYPE string
                ev_model_id  TYPE string.

    " 读取会话历史(最近 gc_max_history 条, 时间正序)
    CLASS-METHODS get_history
      IMPORTING iv_session_id TYPE string
      EXPORTING et_messages   TYPE zcl_ai_llm_client=>tt_messages.

    " 写入一条消息, 返回实际写入的序号
    CLASS-METHODS append_msg
      IMPORTING iv_session_id TYPE string
                iv_prev_seq   TYPE zai_chat_msg-msg_seq
                iv_role       TYPE string
                iv_content    TYPE string
                iv_model_id   TYPE string
                iv_program    TYPE string
                iv_lines      TYPE i
                iv_ms         TYPE i
                iv_status     TYPE string
      RETURNING VALUE(rv_seq) TYPE zai_chat_msg-msg_seq.

    " 会话消息数量控制(超过 gc_store_max 删最早的)
    CLASS-METHODS trim_history
      IMPORTING iv_session_id TYPE string.

    " 会话头 upsert(标题取首条提问, 供历史列表)
    CLASS-METHODS upsert_session
      IMPORTING iv_session_id TYPE string
                iv_question   TYPE string
                iv_model_id   TYPE zai_model_cfg-model_id.

ENDCLASS.



CLASS ZCL_AI_CHAT_SERVICE IMPLEMENTATION.


  METHOD analyze.

    DATA: ls_cfg      TYPE zai_model_cfg,
          lt_messages TYPE zcl_ai_llm_client=>tt_messages,
          ls_msg      TYPE zcl_ai_llm_client=>ty_message,
          ls_src      TYPE zcl_ai_code_provider=>ty_source,
          lv_seq      TYPE zai_chat_msg-msg_seq,
          lv_content  TYPE string,
          lv_elapsed  TYPE i,
          lv_error    TYPE string,
          lv_prog     TYPE string.

    CLEAR es_result.
    es_result-session_id = iv_session_id.
    es_result-status     = 'ERROR'.

    " V14 安全修复：仅允许已开通的普通用户调用分析接口。
    " (zai_chat_user 的登录 ID 字段是 USERID; USERNAME 是显示姓名,
    "  拿 sy-uname 匹配 USERNAME 永远查不到 —— 20261005 字段修正)
    SELECT SINGLE userid FROM zai_chat_user
      WHERE userid = @sy-uname AND active = 'X'
      INTO @DATA(lv_active_user).
    IF sy-subrc <> 0.
      es_result-message = '你还没有被赋予此功能的使用权限，请联系管理员'.
      RETURN.
    ENDIF.

    IF iv_session_id IS INITIAL.
      es_result-message = '会话 ID 为空, 请在前端重新打开会话'.
      RETURN.
    ENDIF.
    IF iv_question IS INITIAL.
      es_result-message = '问题内容为空'.
      RETURN.
    ENDIF.

    " ---- V12: 会话模式校验 —— 普通对话接口拒绝处理 Agent 任务会话,
    "      不允许静默改变模式(老会话 SESSION_MODE 为空视为 CHAT, 正常放行)
    " V2.2.2: 列名修正 —— MODE 是 DDIC 保留字, 表字段实际名为 SESSION_MODE
    SELECT SINGLE session_mode FROM zai_chat_sess
      WHERE session_id = @iv_session_id
      INTO @DATA(lv_sess_mode).
    IF sy-subrc = 0 AND lv_sess_mode = 'AGENT'.
      es_result-status  = 'ERROR'.
      es_result-message = '该会话是 Agent 任务会话，请从 Agent 入口发送任务。'.
      RETURN.
    ENDIF.

    " ---- V2.2: 对象识别提前(智能路由需先知道是否代码/表分析任务) ----
    DATA: lv_tcode TYPE string,
          lv_sample TYPE string,
          lt_fields TYPE tt_fields,
          lv_obj_note TYPE string.

    lv_prog = to_upper( iv_program_name ).
    CONDENSE lv_prog.
    IF lv_prog IS INITIAL.
      lv_prog = detect_program( EXPORTING iv_question = iv_question
                                IMPORTING ev_tcode    = lv_tcode ).
    ENDIF.

    IF lv_tcode IS NOT INITIAL.
      es_result-message = |已通过事务代码 { lv_tcode } 定位到程序 { lv_prog }。|.
    ENDIF.

    " ---- V2.2: 模型路由(ModelId=AUTO 按任务类型自动选模型) ----
    ls_cfg = route_model( iv_model_id = iv_model_id
                          iv_has_obj  = xsdbool( lv_prog IS NOT INITIAL ) ).

    IF ls_cfg-model_id IS INITIAL.
      es_result-message = |模型配置 { iv_model_id } 不存在或没有已启用的模型, 请在 SM30/前端"模型管理"中维护 ZAI_MODEL_CFG|.
      RETURN.
    ENDIF.
    IF ls_cfg-is_active <> 'X'.
      es_result-message = |模型 { ls_cfg-model_id } 未启用(IS_ACTIVE 未勾选)|.
      RETURN.
    ENDIF.
    es_result-model_id = ls_cfg-model_id.

    " ---- V2.2: 模型级开关 SKIP_SOURCE: 该模型不做源码提取, 按纯对话处理 ----
    IF ls_cfg-skip_source = 'X'.
      CLEAR: lv_prog, lv_tcode.
    ENDIF.

    " ---- V2.2: 模型级代码权限 USER_HIDE_SRC: 该模型对普通用户隐藏源码 ----
    "         (仅当模型配置了此开关时才查角色; ADMIN 不受限; 表分析不受管控)
    DATA: lv_restricted TYPE abap_bool,
          lv_prog_meta  TYPE string.
    IF ls_cfg-user_hide_src = 'X'.
      lv_restricted = xsdbool( v8_get_role( ) <> 'ADMIN' ).
    ENDIF.

    get_history( EXPORTING iv_session_id = iv_session_id
                 IMPORTING et_messages   = lt_messages ).

    DATA: lv_rows  TYPE i,
          lv_wnote TYPE string,
          lv_cond_txt TYPE string,
          lv_snote TYPE string.

    IF lv_prog IS NOT INITIAL.
      " ---- V2.2: 分块开关开启时按更大上限取源码(供分块摘要) ----
      DATA(lv_src_max) = COND i( WHEN is_cfg_on( 'LONG_SRC_CHUNK' )
                                 THEN gc_chunk_lines * gc_chunk_max
                                 ELSE 0 ).
      IF lv_src_max > 0.
        ls_src = zcl_ai_code_provider=>get_source( iv_name      = lv_prog
                                                   iv_max_lines = lv_src_max ).
      ELSE.
        ls_src = zcl_ai_code_provider=>get_source( lv_prog ).
      ENDIF.

      IF ls_src-error IS NOT INITIAL.
        lv_obj_note = |系统事实：用户提到的对象 { lv_prog } 在当前 SAP 系统中不存在或不可读取。| &&
                      |请如实告知用户该对象在系统中查不到，再基于你的知识回答用户的问题。|.
        es_result-message = |对象 { lv_prog } 在本系统不存在或无法读取({ ls_src-error })，已按普通对话处理。|.
        CLEAR: lv_prog, ls_src.
      ELSE.
        es_result-program_name = lv_prog.
        es_result-code_lines   = ls_src-lines.
        IF ls_src-objtype = 'TABL' OR ls_src-objtype = 'VIEW'.
          " ---- 表/视图: 条件取样 + V2.2 指定字段列 ----
          DATA: lt_cond  TYPE tt_where_cond.
          detect_where( EXPORTING iv_question = iv_question
                                  iv_tabname  = lv_prog
                        IMPORTING et_cond     = lt_cond
                                  ev_rows     = lv_rows
                                  ev_note     = lv_wnote ).

          lt_fields = detect_fields( iv_question = iv_question
                                     iv_tabname  = lv_prog ).

          get_table_sample( EXPORTING iv_tabname  = lv_prog
                                      it_cond     = lt_cond
                                      it_fields   = lt_fields
                                      iv_max_rows = lv_rows
                            IMPORTING ev_sample   = lv_sample
                                      ev_note     = lv_snote ).

          LOOP AT lt_cond INTO DATA(ls_cond).
            lv_cond_txt = COND #( WHEN lv_cond_txt IS INITIAL
                                  THEN |{ ls_cond-field }={ ls_cond-value }|
                                  ELSE |{ lv_cond_txt } AND { ls_cond-field }={ ls_cond-value }| ).
          ENDLOOP.

          DATA(lv_meta) = |表 { lv_prog } 取样：|.
          lv_meta = COND #( WHEN lv_cond_txt IS NOT INITIAL
                            THEN |{ lv_meta }条件 { lv_cond_txt }，|
                            ELSE lv_meta ).
          " V2.2: 指定字段列说明
          IF lt_fields IS NOT INITIAL.
            lv_meta = |{ lv_meta }仅取字段 { concat_lines_of( table = lt_fields sep = ',' ) }，|.
          ENDIF.
          lv_meta = lv_meta && |前 { COND #( WHEN lv_rows BETWEEN 1 AND 200
                                             THEN lv_rows ELSE 50 ) } 行|.
          lv_meta = COND #( WHEN lv_snote IS NOT INITIAL
                            THEN |{ lv_meta }（{ lv_snote }）|
                            ELSE |{ lv_meta }| ).
          lv_meta = COND #( WHEN lv_wnote IS NOT INITIAL
                            THEN |{ lv_meta }；{ lv_wnote }|
                            ELSE lv_meta ).
          es_result-message = lv_meta.
        ELSEIF lv_restricted = abap_true.
          " ---- V2.2: 该模型开启 USER 禁看 + 当前用户非管理员: 隐藏源码, 仅元信息 ----
          lv_prog_meta = read_program_meta( lv_prog ).
          lv_obj_note = lv_prog_meta &&
                        |用户角色无代码查看权限。请仅基于以上元信息, 向用户解释该程式| &&
                        |的用途、所属模块与典型使用场景; 禁止输出任何源码内容, 也不得| &&
                        |编造未提及的代码细节。|.
          es_result-message = |当前模型对普通用户隐藏源码: { lv_prog } 仅提供程式功能说明。|.
          CLEAR ls_src.
        ENDIF.
      ENDIF.
    ENDIF.

    ls_msg-role    = 'system'.
    ls_msg-content = build_system_prompt( ).
    APPEND ls_msg TO lt_messages.

    IF lv_obj_note IS NOT INITIAL.
      CLEAR ls_msg.
      ls_msg-role    = 'system'.
      ls_msg-content = lv_obj_note.
      APPEND ls_msg TO lt_messages.
    ENDIF.

    ls_msg-role    = 'user'.
    ls_msg-content = iv_question.
    IF ls_src-source IS NOT INITIAL.
      IF ls_src-objtype = 'TABL' OR ls_src-objtype = 'VIEW'.
        ls_msg-content =
          |{ iv_question }\n\n请结合以下数据库表/视图结构进行分析 | &&
          |(对象: { lv_prog }, 类型: { ls_src-objtype }, 共 { ls_src-lines } 行字段信息):\n| &&
          |```\n{ ls_src-source }\n```|.
        IF lv_sample IS NOT INITIAL.
          DATA(lv_shead) = |前 { COND #( WHEN lv_rows BETWEEN 1 AND 200
                                         THEN lv_rows ELSE 50 ) } 行|.
          lv_shead = COND #( WHEN lv_cond_txt IS NOT INITIAL
                             THEN |满足条件 { lv_cond_txt } 的{ lv_shead }|
                             ELSE |{ lv_shead }(无条件, 即表头开始)| ).
          " V2.2: 指定字段列说明
          IF lt_fields IS NOT INITIAL.
            lv_shead = |{ lv_shead }, 仅包含指定字段 { concat_lines_of( table = lt_fields sep = ',' ) }|.
          ENDIF.
          ls_msg-content =
            |{ ls_msg-content }\n\n以下是该表的样例数据({ lv_shead }, | &&
            |单元格超长已截断):\n```text\n{ lv_sample }\n```|.
        ENDIF.
      ELSEIF is_cfg_on( 'LONG_SRC_CHUNK' ) AND ls_src-lines > zcl_ai_code_provider=>gc_max_lines.
        " ---- V2.2: 超长源码分块摘要级联(超过默认 6000 行才触发, 小程序不多花时间) ----
        DATA: lv_summary TYPE string,
              lv_nchunks TYPE i.
        chunk_summarize( EXPORTING is_cfg     = ls_cfg
                                   iv_prog    = lv_prog
                                   is_src     = ls_src
                         IMPORTING ev_summary = lv_summary
                                   ev_chunks  = lv_nchunks ).
        IF lv_summary IS NOT INITIAL.
          ls_msg-content =
            |{ iv_question }\n\n程序 { lv_prog } 共 { ls_src-lines } 行, 超出单次送入上限, | &&
            |已按代码顺序分段生成摘要(每段含行号范围):\n\n{ lv_summary }\n| &&
            |请基于以上分段摘要回答用户问题; 若某段摘要不足以支撑结论, | &&
            |请明确指出需要哪一行的原文, 而不要凭空推断。|.
          es_result-message = |{ es_result-message }源码超长({ ls_src-lines } 行), 已按 { lv_nchunks } 块分段摘要分析。|.
        ELSE.
          " 分块全部失败 → 退回截断全文
          ls_msg-content = |{ iv_question }\n\n请分析以下 ABAP 源码(对象: { lv_prog }, 类型: { ls_src-objtype }, 共 { ls_src-lines } 行, 每行前有行号):\n```abap\n{ ls_src-source }\n```|.
        ENDIF.
      ELSE.
        ls_msg-content = |{ iv_question }\n\n请分析以下 ABAP 源码(对象: { lv_prog }, 类型: { ls_src-objtype }, 共 { ls_src-lines } 行, 每行前有行号):\n```abap\n{ ls_src-source }\n```|.
      ENDIF.
    ENDIF.
    APPEND ls_msg TO lt_messages.

    zcl_ai_llm_client=>chat(
      EXPORTING is_cfg      = ls_cfg
                it_messages = lt_messages
      IMPORTING ev_content  = lv_content
                ev_elapsed  = lv_elapsed
                ev_error    = lv_error ).

    " ---- V2.2: 故障自动切换: 首选模型失败时尝试其他启用模型 ----
    IF lv_error IS NOT INITIAL OR lv_content IS INITIAL.
      DATA: lv_fb_model TYPE string.
      CLEAR: lv_content, lv_error, lv_fb_model.
      chat_fallback( EXPORTING it_messages = lt_messages
                               " V2.2.2: CONV 强制转 string, 规避类型兼容性报错
                               iv_failed   = CONV string( ls_cfg-model_id )
                     IMPORTING ev_content  = lv_content
                               ev_elapsed  = lv_elapsed
                               ev_error    = lv_error
                               ev_model_id = lv_fb_model ).
      IF lv_fb_model IS NOT INITIAL.
        es_result-model_id = lv_fb_model.
        lv_content = |{ lv_content }\n\n> 注: 首选模型 { ls_cfg-model_id } 不可用, 本条由模型 { lv_fb_model } 兜底回答。|.
      ENDIF.
    ENDIF.

    IF lv_error IS INITIAL AND lv_content IS NOT INITIAL.
      es_result-answer     = lv_content.
      es_result-status     = 'OK'.
      es_result-elapsed_ms = lv_elapsed.
    ELSE.
      es_result-message    = COND #( WHEN lv_error IS NOT INITIAL
                                     THEN lv_error
                                     ELSE '模型返回了空内容, 请检查 API_MODEL 名称与 ENDPOINT_URL' ).
      es_result-elapsed_ms = lv_elapsed.
    ENDIF.

    lv_seq = append_msg( iv_session_id = iv_session_id iv_prev_seq = '000000'
                         iv_role = 'user' iv_content = iv_question
                         iv_model_id = CONV string( es_result-model_id ) iv_program = lv_prog
                         iv_lines = es_result-code_lines iv_ms = 0 iv_status = 'OK' ).

    append_msg( iv_session_id = iv_session_id iv_prev_seq = lv_seq
                iv_role = 'assistant'
                iv_content = COND #( WHEN es_result-answer IS NOT INITIAL
                                     THEN es_result-answer
                                     ELSE |错误: { es_result-message }| )
                iv_model_id = CONV string( es_result-model_id ) iv_program = lv_prog
                iv_lines = es_result-code_lines iv_ms = lv_elapsed
                iv_status = es_result-status ).

    upsert_session( iv_session_id = iv_session_id iv_question = iv_question iv_model_id = ls_cfg-model_id ).

    COMMIT WORK.
    trim_history( iv_session_id ).

  ENDMETHOD.


  METHOD append_msg.

    DATA: ls_msg  TYPE zai_chat_msg,
          lv_next TYPE zai_chat_msg-msg_seq.

    SELECT MAX( msg_seq )
      FROM zai_chat_msg
      WHERE session_id = @iv_session_id
      INTO @DATA(lv_max).

    lv_next = lv_max + 1.

    ls_msg-mandt        = sy-mandt.
    ls_msg-session_id   = iv_session_id.
    ls_msg-msg_seq      = lv_next.
    ls_msg-role         = iv_role.
    ls_msg-content      = iv_content.
    ls_msg-model_id     = iv_model_id.
    ls_msg-program_name = iv_program.
    ls_msg-code_lines   = iv_lines.
    ls_msg-elapsed_ms   = iv_ms.
    ls_msg-status       = iv_status.
    ls_msg-created_at   = |{ sy-datum }{ sy-uzeit }|.
    ls_msg-created_by   = sy-uname.

    INSERT zai_chat_msg FROM @ls_msg.
    rv_seq = lv_next.

  ENDMETHOD.


  METHOD build_system_prompt.

    rv_prompt =
      |你是一位资深的 SAP ABAP / S/4HANA 开发专家, 擅长代码审查、性能优化、| &&
      |语法分析与重构建议。请使用简体中文回答(用户使用其他语言时跟随用户语言), | &&
      |使用 Markdown 格式组织回答, 代码示例放在 abap 代码块中。| &&
      |分析源码时请依次给出: 1)程序功能概述 2)主要数据结构与数据库表 3)关键业务逻辑 | &&
      |4)潜在问题与优化建议(性能/健壮性/安全), 并给出修改示例。|.

  ENDMETHOD.


  METHOD delete_session.

    DATA: lv_hit TYPE abap_bool.

    CLEAR es_result.

    IF iv_session_id IS INITIAL.
      es_result-message = '会话ID为空'.
      RETURN.
    ENDIF.

    DELETE FROM zai_chat_msg
      WHERE session_id = @iv_session_id
        AND created_by = @sy-uname.
    IF sy-subrc = 0.
      lv_hit = abap_true.
    ENDIF.

    DELETE FROM zai_chat_sess
      WHERE session_id = @iv_session_id
        AND created_by = @sy-uname.
    IF sy-subrc = 0.
      lv_hit = abap_true.
    ENDIF.

    COMMIT WORK.

    IF lv_hit = abap_true.
      es_result-success = 'X'.
      es_result-message = '会话已删除'.
    ELSE.
      es_result-message = '会话不存在或无权限删除'.
    ENDIF.

  ENDMETHOD.


  METHOD v8_update_session.

    DATA: ls_sess TYPE zai_chat_sess.

    CLEAR rs.

    IF iv_session_id IS INITIAL.
      rs-message = '会话ID为空'.
      RETURN.
    ENDIF.

    " 仅本人会话可改(与 delete_session 同一权限口径)
    SELECT SINGLE * FROM zai_chat_sess
      WHERE session_id = @iv_session_id
        AND created_by = @sy-uname
      INTO @ls_sess.
    IF sy-subrc <> 0.
      rs-message = '会话不存在或无权限修改'.
      RETURN.
    ENDIF.

    " 标题非空才改(重命名); pinned X/'' 置顶/取消
    IF iv_title IS NOT INITIAL.
      DATA(lv_title) = iv_title.
      CONDENSE lv_title.
      IF strlen( lv_title ) > 70.
        lv_title = lv_title(70).
      ENDIF.
      ls_sess-title = lv_title.
    ENDIF.
    ls_sess-pinned = COND #( WHEN to_upper( iv_pinned ) = 'X' THEN 'X' ELSE '' ).

    UPDATE zai_chat_sess FROM @ls_sess.
    IF sy-subrc = 0.
      COMMIT WORK.
      rs-success = 'X'.
      rs-message = '已更新'.
    ELSE.
      ROLLBACK WORK.
      rs-message = '更新失败, 请检查表 ZAI_CHAT_SESS 是否已有 PINNED 字段'.
    ENDIF.

  ENDMETHOD.


  METHOD detect_program.

    CLEAR rv_prog.
    CLEAR ev_tcode.

    DATA(lv_up) = to_upper( iv_question ).

    TRY.
        DATA: lv_tab   TYPE string,
              lv_found TYPE abap_bool.
        FIND REGEX '(表结构|表|TABLE)\s*([A-Z][A-Z0-9_]{2,15})'
          IN lv_up SUBMATCHES DATA(lv_mark1) lv_tab.
        IF sy-subrc = 0.
          lv_found = abap_true.
        ELSE.
          FIND REGEX '([A-Z][A-Z0-9_]{2,15})\s*表'
            IN lv_up SUBMATCHES lv_tab.
          IF sy-subrc = 0.
            lv_found = abap_true.
          ENDIF.
        ENDIF.
        IF lv_found = abap_true.
          rv_prog = lv_tab.
          RETURN.
        ENDIF.
      CATCH cx_root.
    ENDTRY.

    FIND ALL OCCURRENCES OF REGEX '[A-Za-z0-9_/]+'
      IN iv_question
      RESULTS DATA(lt_match).

    LOOP AT lt_match INTO DATA(ls_m).
      DATA(lv_tok) = to_upper( substring( val = iv_question
                                          off = ls_m-offset
                                          len = ls_m-length ) ).

      IF strlen( lv_tok ) < 3 OR strlen( lv_tok ) > 40.
        CONTINUE.
      ENDIF.
      IF lv_tok(1) <> 'Z' AND lv_tok(1) <> 'Y'.
        CONTINUE.
      ENDIF.
      IF lv_tok NA '0123456789_' AND strlen( lv_tok ) < 5.
        CONTINUE.
      ENDIF.

      zcl_ai_code_provider=>resolve_tcode(
        EXPORTING iv_tcode = lv_tok
        IMPORTING ev_prog  = DATA(lv_tprog) ).
      IF lv_tprog IS NOT INITIAL.
        rv_prog  = lv_tprog.
        ev_tcode = lv_tok.
        RETURN.
      ENDIF.

      IF zcl_ai_code_provider=>object_exists( lv_tok ) = abap_true.
        rv_prog = lv_tok.
        EXIT.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD detect_where.

    CLEAR: et_cond, ev_rows, ev_note.

    DATA(lv_up) = to_upper( iv_question ).

    FIND REGEX '前\s*([0-9]{1,3})\s*(行|条)'
      IN lv_up SUBMATCHES DATA(lv_n).
    IF sy-subrc <> 0.
      FIND REGEX '([0-9]{1,3})\s*(行|条)'
        IN lv_up SUBMATCHES lv_n.
    ENDIF.
    IF sy-subrc = 0 AND lv_n IS NOT INITIAL.
      ev_rows = lv_n.
      IF ev_rows > 200.
        ev_rows = 200.
        ev_note = '行数上限 200, 已按上限取样'.
      ENDIF.
    ENDIF.

    FIND ALL OCCURRENCES OF REGEX
        '([A-Z_][A-Z0-9_]*)\s*(=|等于|为)\s*(''[^'']*''|[A-Z0-9_.-]+)'
      IN lv_up
      RESULTS DATA(lt_m).

    IF lines( lt_m ) = 0.
      RETURN.   " 提问中没有条件 → 普通取样
    ENDIF.
    IF lines( lt_m ) > 5.
      ev_note = '条件过多(>5), 已按无条件取样'.
      RETURN.
    ENDIF.

    DATA: lv_off  TYPE i,
          lv_next TYPE i.
    DATA(lv_clean) = lv_up.
    LOOP AT lt_m INTO DATA(ls_m0).
      lv_off  = ls_m0-offset.
      lv_next = lv_off + ls_m0-length.
      lv_clean = lv_clean(lv_off) && repeat( val = ` ` occ = ls_m0-length )
                 && lv_clean+lv_next.
    ENDLOOP.
    FIND FIRST OCCURRENCE OF REGEX ' OR |;|--|/\*|SELECT|IN *\('
      IN lv_clean.
    IF sy-subrc = 0.
      ev_note = '条件包含暂不支持的语法(OR/子查询等), 已按无条件取样'.
      RETURN.
    ENDIF.

    DATA: lt_dfies TYPE STANDARD TABLE OF dfies.
    CALL FUNCTION 'DDIF_FIELDINFO_GET'
      EXPORTING
        tabname   = iv_tabname
        langu     = sy-langu
      TABLES
        dfies_tab = lt_dfies
      EXCEPTIONS
        not_found = 1
        OTHERS    = 2.
    IF sy-subrc <> 0.
      ev_note = |无法读取表 { iv_tabname } 的字段信息, 已按无条件取样|.
      RETURN.
    ENDIF.

    LOOP AT lt_m INTO ls_m0.
      DATA(lv_s1)    = ls_m0-submatches[ 1 ].
      DATA(lv_s3)    = ls_m0-submatches[ 3 ].
      DATA(lv_field) = lv_up+lv_s1-offset(lv_s1-length).
      DATA(lv_raw)   = lv_up+lv_s3-offset(lv_s3-length).

      READ TABLE lt_dfies INTO DATA(ls_dfies)
        WITH KEY fieldname = lv_field.
      IF sy-subrc <> 0.
        CLEAR: et_cond, ev_rows.
        ev_note = |条件字段 { lv_field } 在表 { iv_tabname } 中不存在, 已按无条件取样|.
        RETURN.
      ENDIF.

      DATA lv_val TYPE string.
      FIND REGEX '^[0-9]+$' IN lv_raw.
      IF sy-subrc = 0.
        lv_val = lv_raw.
      ELSEIF lv_raw(1) = `'`.
        lv_val = lv_raw.
      ELSE.
        lv_val = |'{ lv_raw }'|.
      ENDIF.

      APPEND VALUE #( field = lv_field value = lv_val ) TO et_cond.
    ENDLOOP.

  ENDMETHOD.


  METHOD detect_fields.

    DATA: lt_dfies TYPE STANDARD TABLE OF dfies.

    CLEAR rt_fields.

    " 识别「表 XXX 的 F1,F2 / F1、F2」「表 XXX: F1,F2」等写法
    " (仅接受字段清单以逗号/顿号分隔且至少 2 项, 避免把普通提问误判成取列)
    DATA(lv_up) = to_upper( iv_question ).
    FIND REGEX '(表结构|表|TABLE)\s*([A-Z][A-Z0-9_]{2,15})\s*(的|:|：)?\s*' &&
               '((?:[A-Z][A-Z0-9_]{2,15}\s*[,，、]\s*)+[A-Z][A-Z0-9_]{2,15})'
      IN lv_up SUBMATCHES DATA(lv_mark) DATA(lv_tab) DATA(lv_sep0) DATA(lv_list).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    " 表名要一致(防止「表 A」命中了「表 B 的字段清单」)
    IF lv_tab <> iv_tabname.
      RETURN.
    ENDIF.

    " 拆分 + 规范化(允许中英文逗号/顿号/空白分隔)
    DATA(lv_norm) = lv_list.
    REPLACE ALL OCCURRENCES OF REGEX '[,，、]' IN lv_norm WITH `|`.
    SPLIT lv_norm AT '|' INTO TABLE DATA(lt_raw).

    " DDIC 白名单校验: 字段必须真实存在, 杜绝拼出意外列
    CALL FUNCTION 'DDIF_FIELDINFO_GET'
      EXPORTING
        tabname   = iv_tabname
        langu     = sy-langu
      TABLES
        dfies_tab = lt_dfies
      EXCEPTIONS
        not_found = 1
        OTHERS    = 2.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    LOOP AT lt_raw INTO DATA(lv_f).
      CONDENSE lv_f.
      CHECK lv_f IS NOT INITIAL AND strlen( lv_f ) <= 30.
      READ TABLE lt_dfies TRANSPORTING NO FIELDS
        WITH KEY fieldname = lv_f.
      IF sy-subrc = 0.
        APPEND lv_f TO rt_fields.
      ENDIF.
    ENDLOOP.

    " 少于 2 个有效字段视为未指定(单个字段用「字段=值」条件表达更合适)
    IF lines( rt_fields ) < 2.
      CLEAR rt_fields.
    ENDIF.

  ENDMETHOD.


  METHOD get_history.

    DATA: lt_hist  TYPE tt_dbmsg,
          ls_msg   TYPE zcl_ai_llm_client=>ty_message,
          lv_lines TYPE i,
          lv_idx   TYPE i.

    CLEAR et_messages.

    " V14 安全修复：会话历史只能由创建者读取，避免 IDOR 越权。
    SELECT SINGLE session_id FROM zai_chat_sess
      WHERE session_id = @iv_session_id AND created_by = @sy-uname
      INTO @DATA(lv_owned_session).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    SELECT role, content
      FROM zai_chat_msg
      WHERE session_id = @iv_session_id
        AND status     = 'OK'
        AND role      IN ( 'user', 'assistant' )
      ORDER BY msg_seq DESCENDING
      INTO CORRESPONDING FIELDS OF TABLE @lt_hist
      UP TO @gc_max_history ROWS.

    lv_lines = lines( lt_hist ).

    DO lv_lines TIMES.
      lv_idx = lv_lines - sy-index + 1.
      READ TABLE lt_hist INTO DATA(ls_hist) INDEX lv_idx.
      IF sy-subrc <> 0.
        EXIT.
      ENDIF.
      ls_msg-role    = ls_hist-role.
      ls_msg-content = ls_hist-content.
      APPEND ls_msg TO et_messages.
    ENDDO.

  ENDMETHOD.


  METHOD get_models.

    CLEAR et_models.

    SELECT * FROM zai_model_cfg
      ORDER BY model_id
      INTO TABLE @DATA(lt_cfg).

    LOOP AT lt_cfg INTO DATA(ls).
      APPEND VALUE #(
        model_id     = ls-model_id
        model_name   = ls-model_name
        model_desc   = ls-model_desc
        model_type   = ls-model_type
        endpoint_url = ls-endpoint_url
        destination  = ls-destination
        api_model    = ls-api_model
        auth_type    = ls-auth_type
        temperature  = |{ ls-temperature }|
        max_tokens   = |{ ls-max_tokens }|
        timeout_sec  = |{ ls-timeout_sec }|
        is_active    = ls-is_active
        skip_source  = ls-skip_source
        user_hide_src = ls-user_hide_src
        api_key_set  = COND #( WHEN ls-api_key IS NOT INITIAL THEN 'X' ELSE '' )
      ) TO et_models.
    ENDLOOP.

  ENDMETHOD.


  METHOD get_sessions.

    CLEAR et_sessions.

    " V2.2: 置顶优先, 再按最近修改
    " V12: 行数上限 50 → 100(对话与 Agent 两类会话共用本列表, 前端按模式过滤)
    SELECT * FROM zai_chat_sess
      WHERE created_by = @sy-uname
      ORDER BY pinned DESCENDING, changed_at DESCENDING
      INTO TABLE @DATA(lt_sess)
      UP TO 100 ROWS.

    LOOP AT lt_sess INTO DATA(ls_sess).
      APPEND VALUE #(
        session_id = ls_sess-session_id
        title      = ls_sess-title
        model_id   = ls_sess-model_id
        msg_count  = |{ ls_sess-msg_count }|
        created_at = ls_sess-created_at
        changed_at = ls_sess-changed_at
        pinned     = ls_sess-pinned
        " V12: 模式字段 —— 老数据 SESSION_MODE 为空按 CHAT 返回(读兼容, 不补写)
        " V2.2.2: 列名修正 —— MODE 是 DDIC 保留字, 表字段实际名为 SESSION_MODE
        mode       = COND #( WHEN ls_sess-session_mode IS NOT INITIAL
                             THEN ls_sess-session_mode ELSE 'CHAT' )
        agent_type = ls_sess-agent_type
        status     = COND #( WHEN ls_sess-status IS NOT INITIAL THEN ls_sess-status ELSE 'IDLE' )
      ) TO et_sessions.
    ENDLOOP.

  ENDMETHOD.


  METHOD get_table_sample.

    CLEAR: ev_sample, ev_note.

    " V14 安全修复：读表前校验 S_TABU_NAM/S_TABU_DIS 权限
    IF iv_tabname IS INITIAL.
      ev_note = '表名不能为空'.
      RETURN.
    ENDIF.

    CALL FUNCTION 'VIEW_AUTHORITY_CHECK'
      EXPORTING
        view               = iv_tabname
      EXCEPTIONS
        no_authorization   = 1
        table_not_found    = 2
        OTHERS             = 3.
    IF sy-subrc <> 0.
      ev_note = |没有权限读取表 { iv_tabname }(需要 S_TABU_NAM/S_TABU_DIS 权限)|.
      RETURN.
    ENDIF.

    DATA(lv_rows) = COND i( WHEN iv_max_rows BETWEEN 1 AND 200
                            THEN iv_max_rows ELSE 50 ).

    DATA: lr_data TYPE REF TO data.
    FIELD-SYMBOLS: <lt_tab> TYPE STANDARD TABLE.

    TRY.
        CREATE DATA lr_data TYPE STANDARD TABLE OF (iv_tabname).
        ASSIGN lr_data->* TO <lt_tab>.
        IF sy-subrc <> 0.
          ev_note = '无法创建表数据对象'.
          RETURN.
        ENDIF.

        " V2.2: 指定字段列(SELECT 列清单, 字段名已过 DD03L 白名单, 无注入风险)
        DATA lv_cols TYPE string.
        IF it_fields IS NOT INITIAL.
          lv_cols = concat_lines_of( table = it_fields sep = `, ` ).
        ENDIF.

        IF it_cond IS NOT INITIAL.
          DATA lv_where TYPE string.
          LOOP AT it_cond INTO DATA(ls_c).
            IF lv_where IS NOT INITIAL.
              lv_where = lv_where && ' AND '.
            ENDIF.
            lv_where = |{ lv_where }{ ls_c-field } = { ls_c-value }|.
          ENDLOOP.
          IF lv_cols IS NOT INITIAL.
            SELECT (lv_cols) FROM (iv_tabname) INTO TABLE <lt_tab>
              UP TO lv_rows ROWS WHERE (lv_where).
          ELSE.
            SELECT * FROM (iv_tabname) INTO TABLE <lt_tab>
              UP TO lv_rows ROWS WHERE (lv_where).
          ENDIF.
        ELSE.
          IF lv_cols IS NOT INITIAL.
            SELECT (lv_cols) FROM (iv_tabname) INTO TABLE <lt_tab>
              UP TO lv_rows ROWS.
          ELSE.
            SELECT * FROM (iv_tabname) INTO TABLE <lt_tab>
              UP TO lv_rows ROWS.
          ENDIF.
        ENDIF.
        IF sy-subrc <> 0.
          ev_note = COND #( WHEN it_cond IS NOT INITIAL
                            THEN |表中没有符合条件的数据({ lv_where })|
                            ELSE '表中暂无数据' ).
          RETURN.
        ENDIF.

        " V8.4 修复: 先取表描述符再取行描述符, 直接 CAST 成 STRUCTDESCR 必抛转型异常
        DATA(lo_tab) = CAST cl_abap_tabledescr(
                         cl_abap_typedescr=>describe_by_data( <lt_tab> ) ).
        DATA(lo_desc) = CAST cl_abap_structdescr( lo_tab->get_table_line_type( ) ).

        DATA: lv_row  TYPE string,
              lv_cell TYPE string,
              lv_first TYPE abap_bool.
        LOOP AT <lt_tab> ASSIGNING FIELD-SYMBOL(<ls_row>).
          lv_row = ''.
          " V2.2: 指定字段时仅输出这些列(未选列为空, 不占用 16KB 预算)
          IF it_fields IS NOT INITIAL.
            LOOP AT it_fields INTO DATA(lv_fname).
              ASSIGN COMPONENT lv_fname OF STRUCTURE <ls_row>
                     TO FIELD-SYMBOL(<lv_fval>).
              IF sy-subrc <> 0.
                CONTINUE.
              ENDIF.
              lv_cell = |{ <lv_fval> }|.
              IF strlen( lv_cell ) > 50.
                lv_cell = lv_cell(50) && '…'.
              ENDIF.
              lv_first = xsdbool( lv_row IS INITIAL ).
              lv_row = COND #( WHEN lv_first = abap_true
                               THEN |{ lv_fname }={ lv_cell }|
                               ELSE |{ lv_row }; { lv_fname }={ lv_cell }| ).
            ENDLOOP.
          ELSE.
            LOOP AT lo_desc->components ASSIGNING FIELD-SYMBOL(<ls_comp>).
              ASSIGN COMPONENT <ls_comp>-name OF STRUCTURE <ls_row>
                     TO FIELD-SYMBOL(<lv_val>).
              IF sy-subrc <> 0.
                CONTINUE.
              ENDIF.
              lv_cell = |{ <lv_val> }|.
              IF strlen( lv_cell ) > 50.
                lv_cell = lv_cell(50) && '…'.
              ENDIF.
              IF lv_row IS INITIAL.
                lv_row = |{ <ls_comp>-name }={ lv_cell }|.
              ELSE.
                lv_row = |{ lv_row }; { <ls_comp>-name }={ lv_cell }|.
              ENDIF.
            ENDLOOP.
          ENDIF.
          IF ev_sample IS INITIAL.
            ev_sample = lv_row.
          ELSE.
            ev_sample = |{ ev_sample }\n{ lv_row }|.
          ENDIF.
          IF strlen( ev_sample ) > 16000.
            ev_sample = ev_sample(16000).
            ev_note   = '样例已按 16KB 上限截断'.
            EXIT.
          ENDIF.
        ENDLOOP.

      CATCH cx_root INTO DATA(lx_err).
        ev_sample = ''.
        ev_note   = |表数据读取失败({ lx_err->get_text( ) })，可能缺少表访问权限|.
    ENDTRY.

  ENDMETHOD.


  METHOD read_model_cfg.

    IF iv_model_id IS NOT INITIAL.
      SELECT SINGLE * FROM zai_model_cfg
        WHERE model_id = @iv_model_id
        INTO @rs_cfg.
      RETURN.
    ENDIF.

    SELECT * FROM zai_model_cfg
      WHERE is_active = @abap_true
      ORDER BY PRIMARY KEY
      INTO TABLE @DATA(lt_cfg).
    IF sy-subrc = 0.
      READ TABLE lt_cfg INTO rs_cfg INDEX 1.
    ENDIF.

  ENDMETHOD.


  METHOD route_model.

    DATA(lv_id) = to_upper( iv_model_id ).
    CONDENSE lv_id.

    " 手动指定具体模型 → 完全按手动
    IF lv_id <> '' AND lv_id <> 'AUTO'.
      rs_cfg = read_model_cfg( lv_id ).
      RETURN.
    ENDIF.

    " 智能路由: 按启用模型中主键序扫描
    SELECT * FROM zai_model_cfg
      WHERE is_active = @abap_true
      ORDER BY PRIMARY KEY
      INTO TABLE @DATA(lt_cfg).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    IF iv_has_obj = abap_true.
      " 代码/表分析任务 → 首选未跳过源码的模型(闲聊模型不拿来解析代码)
      LOOP AT lt_cfg INTO rs_cfg.
        IF rs_cfg-skip_source <> 'X'.
          RETURN.
        ENDIF.
      ENDLOOP.
      " 全部都是闲聊模型时退回第一条启用模型
      READ TABLE lt_cfg INTO rs_cfg INDEX 1.
    ELSE.
      " 纯闲聊 → 第一条启用模型
      READ TABLE lt_cfg INTO rs_cfg INDEX 1.
    ENDIF.

  ENDMETHOD.


  METHOD is_cfg_on.

    DATA(lv_key) = to_upper( iv_key ).
    SELECT SINGLE cfgvalue FROM zai_chat_cfg
      WHERE cfgkey = @lv_key
      INTO @DATA(lv_val).
    rv_on = xsdbool( sy-subrc = 0 AND lv_val = 'X' ).

  ENDMETHOD.


  METHOD v8_get_role.

    SELECT SINGLE role FROM zai_chat_user
      WHERE userid = @sy-uname AND active = 'X'
      INTO @rv_role.

  ENDMETHOD.


  METHOD read_program_meta.

    DATA: lv_title  TYPE string,
          lv_cnam   TYPE syuname,
          lv_udat   TYPE d.

    CLEAR rv_meta.

    " 对象类型(TADIR)
    SELECT SINGLE object FROM tadir
      WHERE pgmid = 'R3TR' AND obj_name = @iv_prog
      INTO @DATA(lv_obj).
    DATA(lv_objtype) = COND string( WHEN sy-subrc = 0 THEN lv_obj ELSE 'UNKNOWN' ).

    " 程序标题(登录语言优先, 回退英文)
    " V2.2.4: TRDIRT 的程序名字段是 NAME(不是 REPOSRC 的 PROGNAME)
    SELECT SINGLE text FROM trdirt
      WHERE name = @iv_prog AND sprsl = @sy-langu
      INTO @DATA(lv_t).
    IF sy-subrc = 0.
      lv_title = lv_t.
    ELSE.
      SELECT SINGLE text FROM trdirt
        WHERE name = @iv_prog AND sprsl = 'E'
        INTO @lv_t.
      IF sy-subrc = 0.
        lv_title = lv_t.
      ENDIF.
    ENDIF.

    " 最后修改人与日期(REPOSRC 激活版)
    SELECT SINGLE cnam, udat FROM reposrc
      WHERE progname = @iv_prog AND r3state = 'A'
      INTO @DATA(ls_repo).
    IF sy-subrc = 0.
      lv_cnam = ls_repo-cnam.
      lv_udat = ls_repo-udat.
    ENDIF.

    rv_meta = |系统事实: 对象 { iv_prog }(类型 { lv_objtype })| &&
              COND #( WHEN lv_title IS NOT INITIAL THEN |, 标题: { lv_title }| ELSE `` ) &&
              COND #( WHEN lv_cnam IS NOT INITIAL
                      THEN |, 最后修改: { lv_cnam } { lv_udat DATE = ISO }| ELSE `` ) &&
              |。\n|.

  ENDMETHOD.


  METHOD chunk_summarize.

    DATA: lt_lines   TYPE STANDARD TABLE OF string WITH DEFAULT KEY,
          lt_msg     TYPE zcl_ai_llm_client=>tt_messages,
          ls_msg     TYPE zcl_ai_llm_client=>ty_message,
          lv_body    TYPE string,
          lv_text    TYPE string,
          lv_content TYPE string,
          lv_elapsed TYPE i,
          lv_err     TYPE string,
          lv_from    TYPE i,
          lv_to      TYPE i,
          lv_total   TYPE i,
          lv_n       TYPE i.

    CLEAR: ev_summary, ev_chunks.

    " 源码带行号前缀, 每行一条(去掉截断注记与空行)
    SPLIT is_src-source AT |\n| INTO TABLE lt_lines.
    DELETE lt_lines WHERE table_line IS INITIAL.
    DELETE lt_lines WHERE table_line CS '已截断至'
                       OR table_line = '……'
                       OR table_line CS '[注意:'.
    lv_total = lines( lt_lines ).
    IF lv_total = 0.
      RETURN.
    ENDIF.

    lv_n = 0.
    DO.
      DATA(lv_rest) = lv_total - lv_n * gc_chunk_lines.
      IF lv_rest <= 0.
        EXIT.
      ENDIF.
      IF lv_n >= gc_chunk_max.
        ev_summary = ev_summary &&
          |(第 { lv_n * gc_chunk_lines + 1 } 行以后的 { lv_rest } 行超出本次分析范围, 未纳入摘要)\n|.
        EXIT.
      ENDIF.
      lv_n   += 1.
      lv_from = lv_n * gc_chunk_lines - gc_chunk_lines + 1.
      lv_to   = lv_from + gc_chunk_lines - 1.
      IF lv_to > lv_total.
        lv_to = lv_total.
      ENDIF.

      CLEAR: lt_msg, lv_body.
      ls_msg-role    = 'system'.
      ls_msg-content = build_system_prompt( ).
      APPEND ls_msg TO lt_msg.

      LOOP AT lt_lines INTO lv_text FROM lv_from TO lv_to.
        lv_body = |{ lv_body }{ lv_text }\n|.
      ENDLOOP.

      CLEAR ls_msg.
      ls_msg-role = 'user'.
      ls_msg-content =
        |以下是 ABAP 程序 { iv_prog } 的第 { lv_n } 段源码(行 { lv_from }-{ lv_to }, | &&
        |全程序共 { lv_total } 行, 每行前有行号)。请用要点输出本段摘要: | &&
        |该段实现什么功能、涉及的数据库表/函数/类/事务、关键判断与业务逻辑。| &&
        |控制在 300 字以内, 不要逐行解释。\n```abap\n{ lv_body }\n```|.
      APPEND ls_msg TO lt_msg.

      CLEAR: lv_content, lv_err.
      zcl_ai_llm_client=>chat(
        EXPORTING is_cfg      = is_cfg
                  it_messages = lt_msg
        IMPORTING ev_content  = lv_content
                  ev_elapsed  = lv_elapsed
                  ev_error    = lv_err ).

      IF lv_err IS NOT INITIAL OR lv_content IS INITIAL.
        " 单块失败不中断整体: 记占位说明
        ev_summary = |{ ev_summary }【第 { lv_n } 段 · 行 { lv_from }-{ lv_to }】\n(本段摘要生成失败: { lv_err })\n\n|.
      ELSE.
        ev_summary = |{ ev_summary }【第 { lv_n } 段 · 行 { lv_from }-{ lv_to }】\n{ lv_content }\n\n|.
      ENDIF.
    ENDDO.

    ev_chunks = lv_n.

  ENDMETHOD.


  METHOD chat_fallback.

    DATA: lv_tried TYPE i.

    CLEAR: ev_content, ev_elapsed, ev_error, ev_model_id.

    SELECT * FROM zai_model_cfg
      WHERE is_active = @abap_true
      ORDER BY PRIMARY KEY
      INTO TABLE @DATA(lt_cfg).

    LOOP AT lt_cfg INTO DATA(ls_cfg).
      IF ls_cfg-model_id = iv_failed.
        CONTINUE.
      ENDIF.
      lv_tried += 1.
      IF lv_tried > gc_fallback_max.
        EXIT.
      ENDIF.
      CLEAR ev_content.
      zcl_ai_llm_client=>chat(
        EXPORTING is_cfg      = ls_cfg
                  it_messages = it_messages
        IMPORTING ev_content  = ev_content
                  ev_elapsed  = ev_elapsed
                  ev_error    = ev_error ).
      IF ev_error IS INITIAL AND ev_content IS NOT INITIAL.
        ev_model_id = ls_cfg-model_id.
        RETURN.
      ENDIF.
    ENDLOOP.

    " 全部失败: ev_error 保留最后一次错误, ev_model_id 为空
    CLEAR ev_content.

  ENDMETHOD.


  METHOD save_model_cfg.

    DATA: ls_cfg TYPE zai_model_cfg,
          lv_int TYPE i.

    CLEAR es_result.

    " V14 安全修复：模型配置必须由管理员修改
    v8_require_admin( ).

    DATA(lv_id) = to_upper( iv_model_id ).
    CONDENSE lv_id.

    IF lv_id IS INITIAL.
      es_result-message = '模型 ID 不能为空'.
      RETURN.
    ENDIF.
    DATA(lv_type) = to_upper( iv_model_type ).
    IF lv_type <> 'OLLAMA' AND lv_type <> 'OPENAI'.
      es_result-message = '接口类型必须是 OLLAMA 或 OPENAI'.
      RETURN.
    ENDIF.

    SELECT SINGLE * FROM zai_model_cfg
      WHERE model_id = @lv_id
      INTO @DATA(ls_old).
    DATA(lv_exists) = xsdbool( sy-subrc = 0 ).

    ls_cfg-mandt        = sy-mandt.
    ls_cfg-model_id     = lv_id.
    ls_cfg-model_name   = COND #( WHEN iv_model_name IS NOT INITIAL THEN iv_model_name ELSE lv_id ).
    ls_cfg-model_desc   = iv_model_desc.
    ls_cfg-model_type   = lv_type.
    ls_cfg-endpoint_url = iv_endpoint_url.
    ls_cfg-destination  = to_upper( iv_destination ).
    ls_cfg-api_model    = iv_api_model.

    IF iv_api_key IS NOT INITIAL.
      ls_cfg-api_key = iv_api_key.
    ELSEIF lv_exists = abap_true.
      ls_cfg-api_key = ls_old-api_key.
    ENDIF.

    ls_cfg-auth_type = to_upper( iv_auth_type ).
    IF ls_cfg-auth_type <> 'NONE' AND ls_cfg-auth_type <> 'BEARER' AND ls_cfg-auth_type <> 'X_API_KEY'.
      ls_cfg-auth_type = 'NONE'.
    ENDIF.

    ls_cfg-temperature = '0.3'.
    IF iv_temperature IS NOT INITIAL.
      TRY.
          ls_cfg-temperature = iv_temperature.
        CATCH cx_root.
          ls_cfg-temperature = '0.3'.
      ENDTRY.
    ENDIF.

    CLEAR lv_int.
    IF iv_max_tokens CO '0123456789 ' AND iv_max_tokens IS NOT INITIAL.
      lv_int = iv_max_tokens.
    ENDIF.
    ls_cfg-max_tokens = lv_int.

    CLEAR lv_int.
    IF iv_timeout_sec CO '0123456789 ' AND iv_timeout_sec IS NOT INITIAL.
      lv_int = iv_timeout_sec.
    ENDIF.
    IF lv_int <= 0.
      lv_int = 300.
    ENDIF.
    ls_cfg-timeout_sec = lv_int.

    ls_cfg-is_active = COND #( WHEN iv_is_active = 'X' THEN 'X' ELSE '' ).
    " V2.2: 模型级开关 —— 该模型不做源码解析(闲聊/轻量模型)
    ls_cfg-skip_source = COND #( WHEN to_upper( iv_skip_source ) = 'X' THEN 'X' ELSE '' ).
    " V2.2: 模型级代码权限 —— USER 角色用此模型时不下发源码(仅程式用途说明)
    ls_cfg-user_hide_src = COND #( WHEN to_upper( iv_user_hide_src ) = 'X' THEN 'X' ELSE '' ).

    IF lv_exists = abap_false.
      ls_cfg-created_by = sy-uname.
      ls_cfg-created_at = |{ sy-datum }{ sy-uzeit }|.
    ELSE.
      ls_cfg-created_by = ls_old-created_by.
      ls_cfg-created_at = ls_old-created_at.
    ENDIF.
    ls_cfg-changed_by = sy-uname.
    ls_cfg-changed_at = |{ sy-datum }{ sy-uzeit }|.

    MODIFY zai_model_cfg FROM @ls_cfg.
    IF sy-subrc = 0.
      COMMIT WORK.
      es_result-success = 'X'.
      es_result-message = COND #( WHEN lv_exists = abap_true THEN '配置已更新' ELSE '配置已创建' ).
    ELSE.
      ROLLBACK WORK.
      es_result-message = '保存失败, 请检查表 ZAI_MODEL_CFG 是否已激活'.
    ENDIF.

  ENDMETHOD.


  METHOD test_model.

    DATA: lt_msg    TYPE zcl_ai_llm_client=>tt_messages,
          ls_msg    TYPE zcl_ai_llm_client=>ty_message,
          lv_text   TYPE string,
          lv_ms     TYPE i,
          lv_err    TYPE string.

    CLEAR es_result.

    " V14 安全修复：测试模型需要管理员权限
    v8_require_admin( ).

    DATA(ls_cfg) = read_model_cfg( iv_model_id ).

    IF ls_cfg-model_id IS INITIAL.
      es_result-message = |模型配置 { iv_model_id } 不存在或没有已启用的模型, 请先保存并启用|.
      RETURN.
    ENDIF.
    IF ls_cfg-is_active <> 'X'.
      es_result-message = |模型 { ls_cfg-model_id } 未启用, 请先在模型管理中勾选启用|.
      RETURN.
    ENDIF.

    ls_msg-role    = 'user'.
    ls_msg-content = 'ping'.
    APPEND ls_msg TO lt_msg.

    zcl_ai_llm_client=>chat(
      EXPORTING is_cfg     = ls_cfg
                it_messages = lt_msg
      IMPORTING ev_content = lv_text
                ev_elapsed = lv_ms
                ev_error   = lv_err ).

    es_result-elapsed_ms = |{ lv_ms }|.

    IF lv_err IS INITIAL.
      es_result-success = 'X'.
      es_result-message = |连接正常({ ls_cfg-model_type } -> { ls_cfg-api_model }), 往返耗时 { lv_ms } ms|.
    ELSE.
      es_result-message = lv_err.
    ENDIF.

  ENDMETHOD.


  METHOD trim_history.

    DATA: lv_count  TYPE i,
          lv_cutoff TYPE zai_chat_msg-msg_seq.

    SELECT COUNT(*) FROM zai_chat_msg
      WHERE session_id = @iv_session_id
      INTO @lv_count.

    IF lv_count <= gc_store_max.
      RETURN.
    ENDIF.

    SELECT msg_seq FROM zai_chat_msg
      WHERE session_id = @iv_session_id
      ORDER BY msg_seq DESCENDING
      INTO TABLE @DATA(lt_seq)
      UP TO @gc_store_max ROWS.

    IF lines( lt_seq ) < gc_store_max.
      RETURN.
    ENDIF.

    lv_cutoff = lt_seq[ lines( lt_seq ) ]-msg_seq.

    DELETE FROM zai_chat_msg
      WHERE session_id = @iv_session_id
        AND msg_seq    < @lv_cutoff.

    COMMIT WORK.

  ENDMETHOD.


  METHOD upsert_session.

    DATA: ls_sess TYPE zai_chat_sess.

    SELECT SINGLE * FROM zai_chat_sess
      INTO @ls_sess
      WHERE session_id = @iv_session_id.

    IF sy-subrc <> 0.
      DATA(lv_title) = iv_question.
      IF strlen( lv_title ) > 60.
        lv_title = lv_title(60) && '...'.
      ENDIF.
      CLEAR ls_sess.
      ls_sess-session_id = iv_session_id.
      ls_sess-title      = lv_title.
      ls_sess-model_id   = iv_model_id.
      ls_sess-msg_count  = 2.
      " V12: 首次发送即落会话模式(普通对话 = CHAT), 后续接口按此校验
      " V2.2.2: 列名修正 —— MODE 是 DDIC 保留字, 表字段实际名为 SESSION_MODE
      ls_sess-session_mode = 'CHAT'.
      ls_sess-created_by = sy-uname.
      ls_sess-created_at = |{ sy-datum }{ sy-uzeit }|.
    ELSE.
      ls_sess-msg_count  = ls_sess-msg_count + 2.
    ENDIF.

    ls_sess-changed_at = |{ sy-datum }{ sy-uzeit }|.

    MODIFY zai_chat_sess FROM @ls_sess.

  ENDMETHOD.


  METHOD v8_get_config.
    DATA(lv_key_g) = to_upper( iv_key ).
    SELECT SINGLE cfgvalue FROM zai_chat_cfg
      WHERE cfgkey = @lv_key_g
      INTO @DATA(lv_val).
    rs-success = 'X'.
    rs-json    = lv_val.   " 前端拿 Json 字段当配置值用
  ENDMETHOD.


  METHOD v8_get_prompts.
    SELECT prompt_id AS promptid, title, content, sort_no AS sortno
      FROM zai_chat_prompt
      WHERE active = 'X'
      ORDER BY sort_no
      INTO TABLE @DATA(lt_p).
    rs-success = 'X'.
    rs-json    = /ui2/cl_json=>serialize( lt_p ).
  ENDMETHOD.


  METHOD v8_get_roles.
    SELECT rolename AS name
      FROM zai_chat_role
      WHERE active = 'X'
      ORDER BY rolename
      INTO TABLE @DATA(lt_roles).
    rs-success = 'X'.
    rs-json    = /ui2/cl_json=>serialize( lt_roles ).
  ENDMETHOD.


  METHOD v8_get_users.
    TRY.
        v8_require_admin( ).
      CATCH cx_static_check.
        rs-success = ''.
        rs-message = '该操作仅管理员可执行'.
        RETURN.
    ENDTRY.
    SELECT userid, username, role, active
      FROM zai_chat_user
      ORDER BY userid
      INTO TABLE @DATA(lt_u).
    rs-success = 'X'.
    rs-json    = /ui2/cl_json=>serialize( lt_u ).
  ENDMETHOD.


  METHOD v8_login.
    SELECT SINGLE userid, username, role
      FROM zai_chat_user
      WHERE userid = @sy-uname AND active = 'X'
      INTO @DATA(ls_user).
    IF sy-subrc <> 0.
      rs-success = ''.
      rs-message = '该账号未开通 SAP AI 使用权限，请联系管理员'.
      RETURN.
    ENDIF.
    rs-success = 'X'.
    rs-json    = |\{ "UserId": "{ ls_user-userid }", | &&
                 |"UserName": "{ ls_user-username }", | &&
                 |"Role": "{ ls_user-role }" \}|.
  ENDMETHOD.


  METHOD v8_now.
    CONCATENATE sy-datum sy-uzeit INTO rv.
  ENDMETHOD.


  METHOD v8_require_admin.
    " V2.2: 角色查询抽取为 v8_get_role(供 analyze 的 USER_HIDE_SRC 复用)
    IF v8_get_role( ) <> 'ADMIN'.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING textid  = /iwbep/cx_mgw_busi_exception=>business_error
                  message = '该操作仅管理员可执行'.
    ENDIF.
  ENDMETHOD.


  METHOD v8_save_config.
    TRY.
        v8_require_admin( ).
      CATCH cx_static_check.
        rs-success = ''.
        rs-message = '该操作仅管理员可执行'.
        RETURN.
    ENDTRY.
    DATA(lv_key) = to_upper( iv_key ).
    SELECT SINGLE cfgkey FROM zai_chat_cfg WHERE cfgkey = @lv_key INTO @DATA(lv_chk).
    IF sy-subrc = 0.
      DATA(lv_now_c) = v8_now( ).
      UPDATE zai_chat_cfg SET cfgvalue = @iv_val, changedby = @sy-uname,
             changedat = @lv_now_c WHERE cfgkey = @lv_key.
    ELSE.
      INSERT zai_chat_cfg FROM @(
        VALUE #( mandt = sy-mandt cfgkey = lv_key cfgvalue = iv_val
                 changedby = sy-uname changedat = v8_now( ) ) ).
    ENDIF.
    IF lv_key = 'BACKEND_URL'.
      MODIFY zai_chat_cfg FROM @(
        VALUE #( mandt = sy-mandt cfgkey = 'INITIALIZED' cfgvalue = 'X'
                 changedby = sy-uname changedat = v8_now( ) ) ).
    ENDIF.
    COMMIT WORK.
    rs-success = 'X'. rs-message = '保存成功'.
  ENDMETHOD.


  METHOD v8_save_prompts.
    TRY.
        v8_require_admin( ).
      CATCH cx_static_check.
        rs-success = ''.
        rs-message = '该操作仅管理员可执行'.
        RETURN.
    ENDTRY.
    TYPES: BEGIN OF ty_p, title TYPE string, prompt TYPE string, END OF ty_p.
    DATA lt_in TYPE STANDARD TABLE OF ty_p WITH DEFAULT KEY.
    /ui2/cl_json=>deserialize( EXPORTING json = iv_json CHANGING data = lt_in ).
    UPDATE zai_chat_prompt SET active = '' WHERE active = 'X'.
    DATA(lv_sort) = CONV numc4( 0 ).
    DATA lv_pid TYPE c LENGTH 32.
    LOOP AT lt_in INTO DATA(ls_p).
      lv_sort += 1.
      CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_32 = lv_pid.
      INSERT zai_chat_prompt FROM @(
        VALUE #( mandt = sy-mandt
                 prompt_id = lv_pid
                 title = ls_p-title content = ls_p-prompt
                 sort_no = lv_sort active = 'X'
                 createdby = sy-uname createdat = v8_now( ) ) ).
    ENDLOOP.
    COMMIT WORK.
    rs-success = 'X'. rs-message = '保存成功'.
  ENDMETHOD.


  METHOD v8_save_roles.
    TRY.
        v8_require_admin( ).
      CATCH cx_static_check.
        rs-success = ''.
        rs-message = '该操作仅管理员可执行'.
        RETURN.
    ENDTRY.
    DATA lt_in TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    /ui2/cl_json=>deserialize( EXPORTING json = iv_json CHANGING data = lt_in ).
    IF sy-subrc <> 0 AND iv_json IS NOT INITIAL.
      rs-message = '入参 JSON 解析失败'. RETURN.
    ENDIF.
    SELECT * FROM zai_chat_role INTO TABLE @DATA(lt_old).
    LOOP AT lt_old INTO DATA(ls_old).
      IF NOT line_exists( lt_in[ table_line = ls_old-rolename ] ).
        UPDATE zai_chat_role SET active = '' WHERE rolename = @ls_old-rolename.
      ENDIF.
    ENDLOOP.
    LOOP AT lt_in INTO DATA(lv_name).
      SELECT SINGLE rolename FROM zai_chat_role WHERE rolename = @lv_name INTO @DATA(lv_chk).
      IF sy-subrc = 0.
        UPDATE zai_chat_role SET active = 'X' WHERE rolename = @lv_name.
      ELSE.
        INSERT zai_chat_role FROM @(
          VALUE #( mandt = sy-mandt rolename = lv_name active = 'X'
                   createdby = sy-uname createdat = v8_now( ) ) ).
      ENDIF.
    ENDLOOP.
    COMMIT WORK.
    rs-success = 'X'. rs-message = '保存成功'.
  ENDMETHOD.


  METHOD v8_save_user.
    TRY.
        v8_require_admin( ).
      CATCH cx_static_check.
        rs-success = ''.
        rs-message = '该操作仅管理员可执行'.
        RETURN.
    ENDTRY.
    TYPES: BEGIN OF ty_u, userid TYPE string, username TYPE string,
             role TYPE string, active TYPE string, password TYPE string, END OF ty_u.
    DATA ls_in TYPE ty_u.
    /ui2/cl_json=>deserialize( EXPORTING json = iv_json CHANGING data = ls_in ).
    DATA(lv_id) = to_upper( ls_in-userid ).
    SELECT SINGLE bname FROM usr02 WHERE bname = @lv_id INTO @DATA(lv_bname).
    IF sy-subrc <> 0.
      rs-message = |SU01 中不存在用户 { lv_id }，请先在 SAP 创建|.
      RETURN.
    ENDIF.
    SELECT SINGLE userid FROM zai_chat_user WHERE userid = @lv_id INTO @DATA(lv_chk).
    IF sy-subrc = 0.
      DATA(lv_now_u) = v8_now( ).
      UPDATE zai_chat_user SET username = @ls_in-username, role = @ls_in-role,
             active = @ls_in-active, changedat = @lv_now_u
        WHERE userid = @lv_id.
    ELSE.
      INSERT zai_chat_user FROM @(
        VALUE #( mandt = sy-mandt userid = lv_id username = ls_in-username
                 role = COND #( WHEN ls_in-role IS INITIAL THEN 'USER' ELSE ls_in-role )
                 active = 'X' createdat = v8_now( ) ) ).
    ENDIF.
    COMMIT WORK.
    rs-success = 'X'. rs-message = '已开通'.
  ENDMETHOD.
ENDCLASS.
