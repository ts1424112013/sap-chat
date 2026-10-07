*=======================================================================
* 对象:   ZCL_AI_TASK_SERVICE
* 用途:   业务任务服务(《Agent多业务任务与报表分析》P1: 任务与上下文基础)
*         - 会话(SessionId)/任务(TaskId)/运行/结果 四层模型的任务层:
*           一个会话可挂多个业务任务(INVENTORY/REPORT/DATA/CODE/GENERAL),
*           任务跨多轮继续, 状态与消息关联、结果索引独立保存
*         - 旁路新增 + 开关控制: 全部表访问都在 task_enabled( ) 之后,
*           TASK_CONTEXT_ENABLED 未开启(默认关闭)时所有公开方法优雅
*           返回初始值, 旧链路(AnalyzeAgent/AnalyzeCode/旧会话)零影响
*         - 复用现有 ZAI_CHAT_CFG 配置(不新建第二套配置系统)
* 数据:   ZAI_TASK(任务主表) / ZAI_TASK_MSG(任务-消息关联)
*         / ZAI_ARTIFACT(结果索引)  —— SE11 净新增表, 建表前本类
*         无法激活; 建表/激活属 SAP 端阻塞项, 见《SE11对象与配置清单》
* 兼容:   不改 ZAI_CHAT_MSG / ZAI_CHAT_SESS 主键与旧查询语义
*         (消息正文仍在 ZAI_CHAT_MSG, 关联表只存指针)
* 安全:   - TaskId/ArtifactId 一律服务端生成(GUID), 模型输出的 ID
*           只是候选值, 使用前必须过本类归属校验(session+owner)
*         - 乐观锁: 更新任务状态必须带 current_version,
*           版本不匹配即拒绝(两个页面并发覆盖保护)
*         - 上下文包只注入当前任务结构化状态 + 有限相关消息,
*           不把整段聊天历史发给模型
* 依赖:   无 ABAP 类依赖(纯表服务), JSON 组装用 /ui2/cl_json
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50, 755 已核对)
* V1.0    20261007: 首版(任务模型/消息关联/结果索引/上下文组装/状态机)
* V1.0.1  20261007: 踩坑清单自查修正 —— build_context 序列化去掉
*         pretty_mode-low_case(存在性未经本环境验证), 改默认原样输出
*         (字段名列名不变, JS/模型消费方无感)
* ★ 重贴后核对标记: task_enabled 应读取 ZAI_CHAT_CFG 的
*   TASK_CONTEXT_ENABLED(缺省关闭); 全文不得出现 name_values/low_case
*=======================================================================
CLASS zcl_ai_task_service DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " ---- 任务状态(02 设计 §2.2; CANCELLED 仅在真实取消确认后写入,
    "      EXPIRED 仅在保留期限核验后写入; 本类不产生这两态) ----
    CONSTANTS: gc_st_open          TYPE string VALUE 'OPEN',
               gc_st_waiting_input TYPE string VALUE 'WAITING_INPUT',
               gc_st_queued        TYPE string VALUE 'QUEUED',
               gc_st_running       TYPE string VALUE 'RUNNING',
               gc_st_analyzing     TYPE string VALUE 'ANALYZING',
               gc_st_paused        TYPE string VALUE 'PAUSED',
               gc_st_completed     TYPE string VALUE 'COMPLETED',
               gc_st_partial       TYPE string VALUE 'PARTIAL',
               gc_st_failed        TYPE string VALUE 'FAILED',
               gc_st_cancelled     TYPE string VALUE 'CANCELLED',
               gc_st_expired       TYPE string VALUE 'EXPIRED'.

    " ---- 业务模块(02 设计 §3.1 MODULE_ID) ----
    CONSTANTS: gc_mod_report    TYPE string VALUE 'REPORT',
               gc_mod_inventory TYPE string VALUE 'INVENTORY',
               gc_mod_data      TYPE string VALUE 'DATA',
               gc_mod_code      TYPE string VALUE 'CODE',
               gc_mod_general   TYPE string VALUE 'GENERAL'.

    " ---- 任务消息关联 RELEVANCE(02 设计 §3.2) ----
    CONSTANTS: gc_rel_current   TYPE string VALUE 'CURRENT',
               gc_rel_summary   TYPE string VALUE 'SUMMARY',
               gc_rel_reference TYPE string VALUE 'REFERENCE'.

    " ---- 结果类型(02 设计 §3.3 ARTIFACT_TYPE) ----
    CONSTANTS: gc_art_report_res TYPE string VALUE 'REPORT_RESULT',
               gc_art_table_data TYPE string VALUE 'TABLE_DATA',
               gc_art_inventory  TYPE string VALUE 'INVENTORY_RESULT',
               gc_art_analysis   TYPE string VALUE 'ANALYSIS'.

    " ---- 结果来源(02 设计 §3.3 SOURCE_TYPE) ----
    CONSTANTS: gc_src_ztable  TYPE string VALUE 'ZTABLE',
               gc_src_query   TYPE string VALUE 'QUERY',
               gc_src_snapshot TYPE string VALUE 'SNAPSHOT',
               gc_src_inline  TYPE string VALUE 'INLINE'.

    " 任务结构(字段名与 ZAI_TASK 列一一对应, 除 PENDING/SUMMARY JSON)
    TYPES: BEGIN OF ty_task,
             task_id           TYPE string,
             session_id        TYPE string,
             parent_task_id    TYPE string,
             module_id         TYPE string,
             intent_code       TYPE string,
             title             TYPE string,
             status            TYPE string,
             owner             TYPE string,
             focus_artifact_id TYPE string,
             current_version   TYPE i,
             pending_json      TYPE string,
             summary_text      TYPE string,
             created_at        TYPE string,
             changed_at        TYPE string,
           END OF ty_task.
    TYPES tt_task TYPE STANDARD TABLE OF ty_task WITH DEFAULT KEY.

    " 结果索引条目(对应 ZAI_ARTIFACT)
    TYPES: BEGIN OF ty_artifact,
             artifact_id   TYPE string,
             task_id       TYPE string,
             session_id    TYPE string,
             artifact_type TYPE string,
             source_type   TYPE string,
             source_ref    TYPE string,
             report_run_id TYPE string,
             dataset_id    TYPE string,
             label         TYPE string,
             status        TYPE string,
             row_count     TYPE i,
             summary_json  TYPE string,
             created_at    TYPE string,
             owner         TYPE string,
           END OF ty_artifact.
    TYPES tt_artifact TYPE STANDARD TABLE OF ty_artifact WITH DEFAULT KEY.

    " 任务候选(指代消歧用; 只给模型/前端看短信息)
    TYPES: BEGIN OF ty_candidate,
             task_id     TYPE string,
             short_id    TYPE string,
             module_id   TYPE string,
             title       TYPE string,
             status      TYPE string,
           END OF ty_candidate.
    TYPES tt_candidate TYPE STANDARD TABLE OF ty_candidate WITH DEFAULT KEY.

    " 任务解析结果(确定性任务选择规则输出, 05 提示词 P1-6)
    TYPES: BEGIN OF ty_task_pick,
             task_id       TYPE string,
             created       TYPE abap_bool,
             needs_clarify TYPE abap_bool,
             reason        TYPE string,
             candidates    TYPE tt_candidate,
           END OF ty_task_pick.

    " 上下文包(02 设计 §8; 组装为 JSON 给模型, 不含完整历史)
    TYPES: BEGIN OF ty_ctx_msg,
             role    TYPE string,
             content TYPE string,
           END OF ty_ctx_msg.
    TYPES tt_ctx_msg TYPE STANDARD TABLE OF ty_ctx_msg WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_context,
             task_id        TYPE string,
             module_id      TYPE string,
             intent_code    TYPE string,
             status         TYPE string,
             pending_json   TYPE string,
             summary_text   TYPE string,
             artifacts_json TYPE string,   " 结果元数据数组 JSON(无明细)
             related_json   TYPE string,   " 其他任务短目录 JSON
             messages       TYPE tt_ctx_msg, " 有限相关消息(已截断)
           END OF ty_context.

    " 消息指针(save_chat 后由 AGENT_SERVICE 回填)
    TYPES: BEGIN OF ty_msg_ref,
             msg_seq   TYPE i,
             role      TYPE string,
           END OF ty_msg_ref.

    " ---- 开关与配置(复用 ZAI_CHAT_CFG) ----

    " TASK_CONTEXT_ENABLED 是否开启('X'); 未配置 = 关闭(安全默认)
    CLASS-METHODS task_enabled
      RETURNING VALUE(rv_on) TYPE abap_bool.

    " 读 ZAI_CHAT_CFG 字符串配置(不存在返回空串; 供 REPORT_SERVICE 复用)
    CLASS-METHODS read_cfg_str
      IMPORTING iv_key         TYPE string
      RETURNING VALUE(rv_val)  TYPE string.

    " ---- 任务生命周期 ----

    " 是否"可继续选择"的任务状态(非终态 + COMPLETED/PARTIAL 可引用结果;
    " FAILED/CANCELLED/EXPIRED 不可作为恢复候选)
    CLASS-METHODS is_selectable_status
      IMPORTING iv_status    TYPE string
      RETURNING VALUE(rv)    TYPE abap_bool.

    " 是否"进行中/待输入"的活跃状态(会话当前焦点候选)
    CLASS-METHODS is_active_status
      IMPORTING iv_status    TYPE string
      RETURNING VALUE(rv)    TYPE abap_bool.

    " 取当前活跃任务(该会话下非终态的最近任务); 无活跃任务返回 initial
    CLASS-METHODS get_active_task
      IMPORTING iv_session_id TYPE string
      RETURNING VALUE(rs_task) TYPE ty_task.

    " 按 ID 取任务(带归属校验: session + 当前用户; 不属于返回 initial)
    CLASS-METHODS get_task_owned
      IMPORTING iv_task_id     TYPE string
                iv_session_id  TYPE string
      RETURNING VALUE(rs_task) TYPE ty_task.

    " 会话任务列表(前端任务区)
    CLASS-METHODS list_tasks
      IMPORTING iv_session_id TYPE string
      RETURNING VALUE(rt)     TYPE tt_task.

    " 选择或创建任务(确定性规则:
    "   1) 显式 TaskId 且归属正确 → 用它
    "   2) 会话内已有同模块活跃任务 → 恢复它(跨业务切换时草稿保留)
    "   3) 否则创建新任务
    " 不会因指代不明而猜唯一对象 —— 歧义场景由 INTENT_ROUTER 先产出
    " 候选, 本方法只在无歧义时落库)
    CLASS-METHODS pick_or_create
      IMPORTING iv_session_id TYPE string
                iv_task_id    TYPE string      " 可空: 前端/模型候选
                iv_module_id  TYPE string
                iv_intent     TYPE string
                iv_title      TYPE string
      RETURNING VALUE(rs)     TYPE ty_task_pick.

    " 更新任务状态(乐观锁; 版本不匹配返回拒绝)
    CLASS-METHODS update_status
      IMPORTING iv_task_id  TYPE string
                iv_version  TYPE i
                iv_status   TYPE string
                iv_summary  TYPE string        " 可选
                iv_pending  TYPE string        " 可选: 待办参数 JSON
      EXPORTING ev_ok       TYPE abap_bool
                ev_reason   TYPE string.

    " 任务消息关联(save_chat 后调用; 不动 ZAI_CHAT_MSG)
    CLASS-METHODS attach_messages
      IMPORTING iv_task_id    TYPE string
                iv_session_id TYPE string
                it_msgs       TYPE tt_msg_ref.

    " ---- 结果索引 ----

    " 登记可引用结果(数据集/库存结果等; 只存元数据与摘要, 不存明细)
    CLASS-METHODS register_artifact
      IMPORTING iv_task_id       TYPE string
                iv_session_id    TYPE string
                iv_type          TYPE string
                iv_source_type   TYPE string
                iv_source_ref    TYPE string
                iv_label         TYPE string
                iv_row_count     TYPE i
                iv_summary_json  TYPE string    " 受控摘要(非明细)
                iv_dataset_id    TYPE string    " 可空
      RETURNING VALUE(rv_art_id) TYPE string.

    " 任务的结果列表(前端"已有结果"引用)
    CLASS-METHODS list_artifacts
      IMPORTING iv_task_id TYPE string
      RETURNING VALUE(rt)  TYPE tt_artifact.

    " ---- 上下文组装 ----

    " 组装当前任务上下文包(预算原则: 结构化状态 + 结果元数据 +
    " 有限相关消息; 其他业务只给短目录; 不发完整聊天历史)
    CLASS-METHODS build_context
      IMPORTING iv_session_id  TYPE string
                iv_task_id     TYPE string
                iv_ctx_pairs   TYPE i DEFAULT 2   " 相关消息轮数上限
                iv_ctx_chars   TYPE i DEFAULT 500 " 单条截断
      RETURNING VALUE(rs)      TYPE ty_context.

    " 上下文包转模型可读 JSON(失败返回空串, 调用方降级旧上下文)
    CLASS-METHODS context_json
      IMPORTING is_ctx    TYPE ty_context
      RETURNING VALUE(rv) TYPE string.

    " ---- 展示辅助 ----

    " 可读短标识(TaskId/ArtifactId 前 8 位; 仅展示, 校验用全值)
    CLASS-METHODS short_id
      IMPORTING iv_id     TYPE string
      RETURNING VALUE(rv) TYPE string.

  PRIVATE SECTION.

    " JSON 字符串转义(反斜杠/双引号/换行; 供手工拼装上下文包使用)
    CLASS-METHODS json_escape
      IMPORTING iv_text    TYPE string
      RETURNING VALUE(rv)  TYPE string.

    " 任务行 <-> 结构转换(表列名避开 MODE/ROWS/DOMAIN 等保留字)
    CLASS-METHODS row_to_task
      IMPORTING is_row        TYPE zai_task
      RETURNING VALUE(rs)     TYPE ty_task.

    CLASS-METHODS now14
      RETURNING VALUE(rv) TYPE string.

ENDCLASS.



CLASS zcl_ai_task_service IMPLEMENTATION.


  METHOD task_enabled.

    rv_on = xsdbool( read_cfg_str( 'TASK_CONTEXT_ENABLED' ) = 'X' ).

  ENDMETHOD.


  METHOD read_cfg_str.

    CLEAR rv_val.
    SELECT SINGLE cfgvalue FROM zai_chat_cfg
      WHERE cfgkey = @iv_key
      INTO @rv_val.

  ENDMETHOD.


  METHOD is_selectable_status.

    " 恢复/引用候选范围: 活跃态 + 已完成可引用结果的两态
    rv = xsdbool( is_active_status( iv_status ) = abap_true
                  OR iv_status = gc_st_completed
                  OR iv_status = gc_st_partial ).

  ENDMETHOD.


  METHOD is_active_status.

    rv = xsdbool( iv_status = gc_st_open
                  OR iv_status = gc_st_waiting_input
                  OR iv_status = gc_st_queued
                  OR iv_status = gc_st_running
                  OR iv_status = gc_st_analyzing
                  OR iv_status = gc_st_paused ).

  ENDMETHOD.


  METHOD get_active_task.

    CLEAR rs_task.
    IF task_enabled( ) = abap_false.
      RETURN.
    ENDIF.

    " 取会话下最近一条活跃任务作当前焦点(终态不作为焦点)
    SELECT * FROM zai_task
      WHERE session_id = @iv_session_id
        AND owner      = @sy-uname
        AND status     IN ( 'OPEN', 'WAITING_INPUT', 'QUEUED',
                            'RUNNING', 'ANALYZING', 'PAUSED' )
      ORDER BY changed_at DESCENDING
      INTO TABLE @DATA(lt).
    IF sy-subrc = 0.
      rs_task = row_to_task( lt[ 1 ] ).
    ENDIF.

  ENDMETHOD.


  METHOD get_task_owned.

    CLEAR rs_task.
    IF task_enabled( ) = abap_false OR iv_task_id IS INITIAL.
      RETURN.
    ENDIF.

    " 归属校验: 任务必须属于当前用户且在指定会话内
    " (模型/前端给的 TaskId 只是候选值, 这里是授权事实源)
    SELECT SINGLE * FROM zai_task
      WHERE task_id   = @iv_task_id
        AND owner     = @sy-uname
      INTO @DATA(ls_row).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    IF iv_session_id IS NOT INITIAL AND ls_row-session_id <> iv_session_id.
      RETURN.
    ENDIF.
    rs_task = row_to_task( ls_row ).

  ENDMETHOD.


  METHOD list_tasks.

    CLEAR rt.
    IF task_enabled( ) = abap_false.
      RETURN.
    ENDIF.

    SELECT * FROM zai_task
      WHERE session_id = @iv_session_id
        AND owner      = @sy-uname
      ORDER BY changed_at DESCENDING
      INTO TABLE @DATA(lt).
    LOOP AT lt INTO DATA(ls_row).
      APPEND row_to_task( ls_row ) TO rt.
    ENDLOOP.

  ENDMETHOD.


  METHOD pick_or_create.

    CLEAR: rs.
    IF task_enabled( ) = abap_false.
      rs-reason = '任务上下文能力未开启(TASK_CONTEXT_ENABLED)'.
      RETURN.
    ENDIF.

    " 规则 1: 显式 TaskId(前端任务卡点击) → 归属校验通过即用
    IF iv_task_id IS NOT INITIAL.
      DATA(ls_t) = get_task_owned( iv_task_id = iv_task_id
                                   iv_session_id = iv_session_id ).
      IF ls_t-task_id IS NOT INITIAL.
        rs-task_id = ls_t-task_id.
        rs-created = abap_false.
        RETURN.
      ENDIF.
      " 显式指定但归属不符: 不猜, 明确拒绝(不静默换任务)
      rs-needs_clarify = abap_true.
      rs-reason = '指定的任务不存在或不属于当前会话'.
      RETURN.
    ENDIF.

    " 规则 2: 同模块活跃任务 → 恢复(报表草稿/运行状态在切换时保留)
    " (LOOP AT 的 WHERE 不支持 IN 值清单, 活跃态判断用辅助方法)
    DATA(lt_tasks) = list_tasks( iv_session_id ).
    LOOP AT lt_tasks INTO DATA(ls_task)
         WHERE module_id = iv_module_id.
      IF is_active_status( ls_task-status ) = abap_true.
        rs-task_id       = ls_task-task_id.
        rs-created       = abap_false.
        RETURN.
      ENDIF.
    ENDLOOP.

    " 规则 3: 创建新任务(32 位 GUID; 标题截断 120)
    DATA lv_id TYPE c LENGTH 32.
    CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_32 = lv_id.
    DATA(lv_title) = iv_title.
    IF strlen( lv_title ) > 120.
      lv_title = lv_title(120).
    ENDIF.

    INSERT zai_task FROM @(
      VALUE #( mandt            = sy-mandt
               task_id          = lv_id
               session_id       = iv_session_id
               module_id        = iv_module_id
               intent_code      = iv_intent
               title            = lv_title
               status           = gc_st_open
               owner            = sy-uname
               current_version  = 1
               created_at       = now14( )
               changed_at       = now14( ) ) ).
    COMMIT WORK.

    rs-task_id = lv_id.
    rs-created = abap_true.

  ENDMETHOD.


  METHOD update_status.

    CLEAR: ev_ok, ev_reason.
    IF task_enabled( ) = abap_false.
      ev_reason = '任务上下文能力未开启'.
      RETURN.
    ENDIF.

    " 乐观锁: 只在版本匹配时更新, 并把版本 +1
    " (两个页面并发提交时后到者被拒绝, 不会覆盖新焦点/新状态)
    DATA(lv_now) = now14( ).
    UPDATE zai_task
      SET status          = @iv_status,
          current_version = @iv_version + 1,
          changed_at      = @lv_now
      WHERE task_id         = @iv_task_id
        AND owner           = @sy-uname
        AND current_version = @iv_version.

    IF sy-subrc <> 0.
      " 版本不匹配或任务不存在 → 拒绝; 补充可读原因
      ev_reason = '任务已被其他操作更新(版本不一致), 请刷新任务状态后重试'.
      RETURN.
    ENDIF.

    " 可选字段单独更新(空串不覆盖)
    IF iv_summary IS NOT INITIAL OR iv_pending IS NOT INITIAL.
      UPDATE zai_task
        SET summary_text = @iv_summary,
            pending_json = @iv_pending
          WHERE task_id  = @iv_task_id
            AND owner    = @sy-uname
            AND current_version = @iv_version + 1.
    ENDIF.

    COMMIT WORK.
    ev_ok = abap_true.

  ENDMETHOD.


  METHOD attach_messages.

    IF task_enabled( ) = abap_false OR it_msgs IS INITIAL.
      RETURN.
    ENDIF.

    " 会话归属二次校验: 防止把消息关联到其他会话的任务
    SELECT SINGLE task_id FROM zai_task
      WHERE task_id = @iv_task_id
        AND session_id = @iv_session_id
        AND owner = @sy-uname
      INTO @DATA(lv_chk).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    LOOP AT it_msgs INTO DATA(ls_m).
      INSERT zai_task_msg FROM @(
        VALUE #( mandt       = sy-mandt
                 task_id     = iv_task_id
                 session_id  = iv_session_id
                 msg_seq     = ls_m-msg_seq
                 role        = ls_m-role
                 relevance   = gc_rel_current
                 created_at  = now14( ) ) ).
    ENDLOOP.
    COMMIT WORK.

  ENDMETHOD.


  METHOD register_artifact.

    CLEAR rv_art_id.
    IF task_enabled( ) = abap_false.
      RETURN.
    ENDIF.

    " 任务归属校验
    SELECT SINGLE task_id FROM zai_task
      WHERE task_id = @iv_task_id
        AND session_id = @iv_session_id
        AND owner = @sy-uname
      INTO @DATA(lv_chk).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    DATA lv_id TYPE c LENGTH 32.
    CALL FUNCTION 'GUID_CREATE' IMPORTING ev_guid_32 = lv_id.

    DATA(lv_label) = iv_label.
    IF strlen( lv_label ) > 120.
      lv_label = lv_label(120).
    ENDIF.

    INSERT zai_artifact FROM @(
      VALUE #( mandt          = sy-mandt
               artifact_id    = lv_id
               task_id        = iv_task_id
               session_id     = iv_session_id
               artifact_type  = iv_type
               source_type    = iv_source_type
               source_ref     = iv_source_ref
               dataset_id     = iv_dataset_id
               label          = lv_label
               status         = 'AVAILABLE'
               row_count      = iv_row_count
               summary_json   = iv_summary_json
               owner          = sy-uname
               created_at     = now14( ) ) ).
    COMMIT WORK.

    " 首个结果自动成为任务焦点(后续结果不自动切焦点, 由引用动作决定)
    SELECT SINGLE focus_artifact_id FROM zai_task
      WHERE task_id = @iv_task_id
      INTO @DATA(lv_focus).
    IF lv_focus IS INITIAL.
      UPDATE zai_task SET focus_artifact_id = @lv_id
        WHERE task_id = @iv_task_id AND owner = @sy-uname.
      COMMIT WORK.
    ENDIF.

    rv_art_id = lv_id.

  ENDMETHOD.


  METHOD list_artifacts.

    CLEAR rt.
    IF task_enabled( ) = abap_false.
      RETURN.
    ENDIF.

    SELECT artifact_id task_id session_id artifact_type source_type
           source_ref  report_run_id dataset_id label status
           row_count   summary_json created_at owner
      FROM zai_artifact
      WHERE task_id = @iv_task_id
        AND owner   = @sy-uname
      ORDER BY created_at ASCENDING
      INTO CORRESPONDING FIELDS OF TABLE @rt.

  ENDMETHOD.


  METHOD build_context.

    CLEAR rs.
    IF task_enabled( ) = abap_false.
      RETURN.
    ENDIF.

    DATA(ls_task) = get_task_owned( iv_task_id = iv_task_id
                                    iv_session_id = iv_session_id ).
    IF ls_task-task_id IS INITIAL.
      RETURN.
    ENDIF.

    rs-task_id      = ls_task-task_id.
    rs-module_id    = ls_task-module_id.
    rs-intent_code  = ls_task-intent_code.
    rs-status       = ls_task-status.
    rs-pending_json = ls_task-pending_json.
    rs-summary_text = ls_task-summary_text.

    " ---- 当前任务结果元数据(不给明细, 给 DatasetId/行数/状态) ----
    " (不带 pretty_name 序列化 = 字段名原样输出, 消费方按 task_id 等
    " 原名列读取; 不依赖 pretty_mode-low_case —— 存在性未经本环境验证)
    DATA(lt_art) = list_artifacts( ls_task-task_id ).
    IF lt_art IS NOT INITIAL.
      rs-artifacts_json = /ui2/cl_json=>serialize( data = lt_art compress = abap_true ).
    ENDIF.

    " ---- 其他任务短目录(跨业务切换提示, 只有 id/模块/状态/标题) ----
    DATA: lt_rel  TYPE tt_candidate,
          lt_all  TYPE tt_task.
    lt_all = list_tasks( iv_session_id ).
    LOOP AT lt_all INTO DATA(ls_t) WHERE task_id <> ls_task-task_id.
      APPEND VALUE #( task_id  = ls_t-task_id
                      short_id = short_id( ls_t-task_id )
                      module_id = ls_t-module_id
                      title    = ls_t-title
                      status   = ls_t-status ) TO lt_rel.
    ENDLOOP.
    IF lt_rel IS NOT INITIAL.
      rs-related_json = /ui2/cl_json=>serialize(
                          data = lt_rel compress = abap_true ).
    ENDIF.

    " ---- 有限相关消息: 只取与本任务关联的最新 N 条, 单条截断 ----
    " (旧链路的 get_recent_ctx 取会话最近 2 轮; 任务链路按任务过滤,
    "  防止其他业务的长历史把上下文挤爆)
    SELECT tm~msg_seq tm~role m~content
      FROM zai_task_msg AS tm
      INNER JOIN zai_chat_msg AS m
        ON m~session_id = tm~session_id
       AND m~msg_seq    = tm~msg_seq
      WHERE tm~task_id   = @ls_task-task_id
        AND tm~session_id = @iv_session_id
        AND tm~role      IN ( 'user', 'assistant' )
        AND m~status      = 'OK'
      ORDER BY tm~msg_seq DESCENDING
      INTO TABLE @DATA(lt_hist)
      UP TO @( iv_ctx_pairs * 2 ) ROWS.
    IF sy-subrc = 0.
      " 时间正序回填
      DATA(lv_n) = lines( lt_hist ).
      DO lv_n TIMES.
        READ TABLE lt_hist INTO DATA(ls_hist) INDEX lv_n - sy-index + 1.
        IF sy-subrc <> 0.
          EXIT.
        ENDIF.
        DATA(lv_content) = ls_hist-content.
        IF strlen( lv_content ) > iv_ctx_chars.
          lv_content = lv_content(iv_ctx_chars) && '…'.
        ENDIF.
        APPEND VALUE #( role = ls_hist-role content = lv_content )
          TO rs-messages.
      ENDDO.
    ENDIF.

  ENDMETHOD.


  METHOD context_json.

    CLEAR rv.
    IF is_ctx-task_id IS INITIAL.
      RETURN.
    ENDIF.

    " 02 设计 §8 上下文包: 固定结构, 后端生成, 模型不能修改
    DATA lv_sum TYPE string.
    IF is_ctx-summary_text IS INITIAL.
      lv_sum = 'null'.
    ELSE.
      lv_sum = json_escape( is_ctx-summary_text ).
    ENDIF.

    rv = |\{| &&
      |"current_task":\{"id":"{ is_ctx-task_id }",| &&
      |"module":"{ is_ctx-module_id }",| &&
      |"intent":"{ is_ctx-intent_code }",| &&
      |"status":"{ is_ctx-status }"\}| &&
      |,"task_summary":{ lv_sum }| &&
      COND string( WHEN is_ctx-pending_json IS NOT INITIAL
                   THEN |,"pending":{ is_ctx-pending_json }| ELSE '' ) &&
      COND string( WHEN is_ctx-artifacts_json IS NOT INITIAL
                   THEN |,"artifacts":{ is_ctx-artifacts_json }| ELSE '' ) &&
      COND string( WHEN is_ctx-related_json IS NOT INITIAL
                   THEN |,"related_tasks":{ is_ctx-related_json }| ELSE '' ).

    " 相关消息(截断后的文本, 转义后拼装)
    rv = rv && |,"recent_messages":[|.
    DATA lv_first TYPE abap_bool VALUE abap_true.
    LOOP AT is_ctx-messages INTO DATA(ls_m).
      IF lv_first = abap_false.
        rv = rv && ','.
      ENDIF.
      lv_first = abap_false.
      rv = rv && |\{"role":"{ ls_m-role }","content":"{ json_escape( ls_m-content ) }"\}|.
    ENDLOOP.
    rv = rv && |]| && |\}|.

  ENDMETHOD.


  METHOD short_id.

    " 可读短标识: 全 ID 前 8 位(展示用; 授权校验一律用全值)
    CLEAR rv.
    IF strlen( iv_id ) >= 8.
      rv = iv_id(8).
    ELSE.
      rv = iv_id.
    ENDIF.

  ENDMETHOD.


  METHOD json_escape.

    rv = iv_text.
    REPLACE ALL OCCURRENCES OF '\' IN rv WITH '\\'.
    REPLACE ALL OCCURRENCES OF '"' IN rv WITH '\"'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv WITH '\n'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv WITH '\n'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv WITH '\t'.

  ENDMETHOD.


  METHOD row_to_task.

    rs-task_id           = is_row-task_id.
    rs-session_id        = is_row-session_id.
    rs-parent_task_id    = is_row-parent_task_id.
    rs-module_id         = is_row-module_id.
    rs-intent_code       = is_row-intent_code.
    rs-title             = is_row-title.
    rs-status            = is_row-status.
    rs-owner             = is_row-owner.
    rs-focus_artifact_id = is_row-focus_artifact_id.
    rs-current_version   = is_row-current_version.
    rs-pending_json      = is_row-pending_json.
    rs-summary_text      = is_row-summary_text.
    rs-created_at        = is_row-created_at.
    rs-changed_at        = is_row-changed_at.

  ENDMETHOD.


  METHOD now14.
    rv = |{ sy-datum }{ sy-uzeit }|.
  ENDMETHOD.


ENDCLASS.

