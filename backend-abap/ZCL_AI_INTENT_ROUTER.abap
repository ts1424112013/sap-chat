*=======================================================================
* 对象:   ZCL_AI_INTENT_ROUTER
* 用途:   结构化意图路由与任务选择(《Agent多业务任务与报表分析》P1)
*         - 分两步不让模型直接执行(01 计划 §5.1): 本类只产出"候选意图",
*           对象是否存在/是否登记/是否有权限由后端(任务服务/报表服务)核验;
*           模型输出的 TaskId/TCode/表名一律只是候选值, 不是授权依据
*         - 确定性快捷规则只覆盖无歧义对象和明确动作(省一次模型调用),
*           不明确的自然语言仍走旧 match_domain 路由
*         - 任务选择优先级(01 计划 §5.2):
*           显式任务/结果编号 > 当前消息明确对象 > 指代+候选匹配 >
*           当前聚焦任务(仅缺省提示) > 候选不唯一时追问
*         - 指代不明确时不猜唯一对象, 返回候选列表(needs_clarify)
* 规则:   - "表 X" 关键词优先于库存词 → DATA(03 验收场景 2: 分析表
*           ZTEST_DATA 不得误判成 REPORT)
*         - 执行/运行/跑一下 + TCode 形对象(Z 开头) → REPORT 候选
*         - "继续/恢复 + TCode" → RESUME 已有任务; 多个候选必须追问
*         - 库存词 → INVENTORY(沿用领域卡词表)
* 依赖:   ZCL_AI_TASK_SERVICE(任务候选/归属), ZCL_AI_DOMAIN_CARDS(词表兜底)
* 安装:   SE24 -> 创建类 -> 源代码粘帖 (ABAP 7.50)
* V1.0    20261007: 首版(结构化意图协议校验 + 确定性快捷规则)
* ★ 重贴后核对标记: quick_route 中 "表+表名" 规则必须在执行/继续规则
*   之前(防 "分析表 ZTEST_DATA" 因 Z 开头误判 REPORT); 偏移/长度
*   已全部先落中间变量(§2.1-2)
*=======================================================================
CLASS zcl_ai_intent_router DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.

    " ---- 结构化意图(01 计划 P1-5; INTENT_CODE 存 ZAI_TASK-INTENT_CODE) ----
    CONSTANTS: gc_int_run_analyze   TYPE string VALUE 'RUN_AND_ANALYZE_REPORT',
               gc_int_view_report   TYPE string VALUE 'VIEW_REPORT_RESULT',
               gc_int_analyze_art   TYPE string VALUE 'ANALYZE_ARTIFACT',
               gc_int_inventory     TYPE string VALUE 'INVENTORY_QUERY',
               gc_int_table_data    TYPE string VALUE 'TABLE_ANALYSIS',
               gc_int_general       TYPE string VALUE 'GENERAL_CHAT',
               gc_int_code          TYPE string VALUE 'CODE_ANALYSIS'.

    " ---- 任务动作(02 设计 §4.3 TaskAction 白名单来源) ----
    CONSTANTS: gc_act_create  TYPE string VALUE 'CREATE_TASK',
               gc_act_resume  TYPE string VALUE 'RESUME_TASK',
               gc_act_supply  TYPE string VALUE 'SUPPLY_PARAM',
               gc_act_view    TYPE string VALUE 'VIEW_RESULT',
               gc_act_execute TYPE string VALUE 'EXECUTE',
               gc_act_analyze TYPE string VALUE 'ANALYZE'.

    TYPES: BEGIN OF ty_intent,
             module_id     TYPE string,       " REPORT/INVENTORY/DATA/CODE/GENERAL
             intent_code   TYPE string,       " 上述 gc_int_* 之一
             action        TYPE string,       " 上述 gc_act_* 之一
             object_kind   TYPE string,       " TCODE / TABLE / MATERIAL / NONE
             object_value  TYPE string,       " 候选对象值(未核验!)
             task_id       TYPE string,       " 候选任务(未核验!)
             needs_clarify TYPE abap_bool,
             reason        TYPE string,
           END OF ty_intent.

    " 确定性快捷路由(供 AGENT_SERVICE 在 match_domain 之后调用):
    " 命中无歧义规则时返回意图与对象; 未命中返回 general(调用方降级旧链路)
    CLASS-METHODS quick_route
      IMPORTING iv_question   TYPE string
                iv_session_id TYPE string
      RETURNING VALUE(rs)     TYPE ty_intent.

    " 校验模型输出的结构化意图(02 设计 §4.1):
    " intent 是否注册 / module 与 intent 匹配 / 对象格式合法;
    " 只做协议层校验, 不做存在性/权限核验(那是后端事实源职责)
    CLASS-METHODS validate_plan
      IMPORTING iv_intent      TYPE string
                iv_module      TYPE string
                iv_object_kind TYPE string
                iv_object_val  TYPE string
      EXPORTING ev_ok          TYPE abap_bool
                ev_reason      TYPE string.

    " 是否 TCode 形对象: Z 开头 4~20 位大写字母数字(Z 报表约定)
    CLASS-METHODS is_tcode_like
      IMPORTING iv_token    TYPE string
      RETURNING VALUE(rv)   TYPE abap_bool.

  PRIVATE SECTION.

    " 从问题里提取 TCode 形词元(Z 开头, 去掉标点)
    CLASS-METHODS extract_tcode_token
      IMPORTING iv_question TYPE string
      RETURNING VALUE(rv)   TYPE string.

    " 指代消歧: 给定 TCode 形对象, 在会话任务里找候选
    CLASS-METHODS resolve_task_by_object
      IMPORTING iv_session_id TYPE string
                iv_object     TYPE string
                iv_module_id  TYPE string
      EXPORTING ev_task_id    TYPE string
                ev_ambiguous  TYPE abap_bool
                et_candidates TYPE zcl_ai_task_service=>tt_candidate.

ENDCLASS.



CLASS zcl_ai_intent_router IMPLEMENTATION.


  METHOD quick_route.

    CLEAR rs.
    " 缺省: 通用(调用方继续走旧 match_domain 链路, 不受影响)
    rs-module_id   = zcl_ai_task_service=>gc_mod_general.
    rs-intent_code = gc_int_general.
    rs-action      = gc_act_create.

    DATA(lv_up) = to_upper( iv_question ).

    " ---- 规则 1(最高优先): "表 + 表名" → DATA(03 场景 2) ----
    " 分析表 ZTEST_DATA / 统计 ZTEST_DATA 表 的记录分布 → 表分析,
    " 不因 Z 开头误判报表, 也不因"分析"误判报表执行
    FIND REGEX '表[\s:：]*([A-Z][A-Z0-9_]{2,29})' IN lv_up
      SUBMATCHES DATA(lv_tab).
    IF sy-subrc = 0.
      rs-module_id    = zcl_ai_task_service=>gc_mod_data.
      rs-intent_code  = gc_int_table_data.
      rs-action       = gc_act_create.
      rs-object_kind  = 'TABLE'.
      rs-object_value = lv_tab.
      rs-reason       = |问题明确指定表 { lv_tab }, 按表数据分析处理|.
      RETURN.
    ENDIF.

    " ---- 规则 2: 执行/运行/跑一下 + TCode 形对象 → REPORT 候选 ----
    " (是否真的有该报表由 REPORT_SERVICE 按登记表核验; 未登记即拒绝)
    DATA(lv_tcode) = extract_tcode_token( iv_question ).
    IF lv_tcode IS NOT INITIAL.
      FIND REGEX '执行|运行|跑一下|跑一次|提交|重跑' IN lv_up.
      IF sy-subrc = 0.
        rs-module_id    = zcl_ai_task_service=>gc_mod_report.
        rs-intent_code  = gc_int_run_analyze.
        rs-action       = gc_act_execute.
        rs-object_kind  = 'TCODE'.
        rs-object_value = lv_tcode.
        " 恢复同对象已有任务(草稿/参数保留), 没有则创建
        resolve_task_by_object(
          EXPORTING iv_session_id = iv_session_id
                    iv_object     = lv_tcode
                    iv_module_id  = zcl_ai_task_service=>gc_mod_report
          IMPORTING ev_task_id    = rs-task_id ).
        rs-reason = |用户要求执行报表 { lv_tcode }(对象待后端登记核验)|.
        RETURN.
      ENDIF.

      " ---- 规则 3: 继续/恢复 + TCode → RESUME; 多候选必须追问 ----
      FIND REGEX '继续|恢复|刚才|之前|那个' IN lv_up.
      IF sy-subrc = 0.
        DATA: lv_found   TYPE string,
              lv_amb     TYPE abap_bool,
              lt_cand    TYPE zcl_ai_task_service=>tt_candidate.
        resolve_task_by_object(
          EXPORTING iv_session_id = iv_session_id
                    iv_object     = lv_tcode
                    iv_module_id  = zcl_ai_task_service=>gc_mod_report
          IMPORTING ev_task_id    = lv_found
                    ev_ambiguous  = lv_amb
                    et_candidates = lt_cand ).
        IF lv_amb = abap_true.
          " 03 场景 4: 多个候选任务时不猜唯一, 必须追问
          rs-module_id    = zcl_ai_task_service=>gc_mod_report.
          rs-intent_code  = gc_int_view_report.
          rs-action       = gc_act_resume.
          rs-object_kind  = 'TCODE'.
          rs-object_value = lv_tcode.
          rs-needs_clarify = abap_true.
          rs-reason = |存在多个 { lv_tcode } 相关任务, 需要用户选择|.
        ELSEIF lv_found IS NOT INITIAL.
          rs-module_id    = zcl_ai_task_service=>gc_mod_report.
          rs-intent_code  = gc_int_view_report.
          rs-action       = gc_act_resume.
          rs-object_kind  = 'TCODE'.
          rs-object_value = lv_tcode.
          rs-task_id      = lv_found.
          rs-reason       = |恢复唯一匹配的报表任务|.
        ELSE.
          " 无已有任务: 当作新报表意图(参数待核验, 由报表服务回答)
          rs-module_id    = zcl_ai_task_service=>gc_mod_report.
          rs-intent_code  = gc_int_view_report.
          rs-action       = gc_act_create.
          rs-object_kind  = 'TCODE'.
          rs-object_value = lv_tcode.
          rs-reason       = |提到报表 { lv_tcode } 但会话内无对应任务|.
        ENDIF.
        RETURN.
      ENDIF.

      " ---- 规则 4: "分析 ZM001"(无执行词): 执行语义不能默认 ----
      " 01 计划 §8.2: "分析"不隐含"重新执行"; 有唯一可用结果 → 分析它,
      " 否则澄清(查看已有结果 / 填参数执行)
      FIND REGEX '分析|看看|解读' IN lv_up.
      IF sy-subrc = 0.
        rs-module_id    = zcl_ai_task_service=>gc_mod_report.
        rs-intent_code  = gc_int_analyze_art.
        rs-action       = gc_act_analyze.
        rs-object_kind  = 'TCODE'.
        rs-object_value = lv_tcode.
        DATA: lv_f2 TYPE string,
              lv_a2 TYPE abap_bool,
              lt_c2 TYPE zcl_ai_task_service=>tt_candidate.
        resolve_task_by_object(
          EXPORTING iv_session_id = iv_session_id
                    iv_object     = lv_tcode
                    iv_module_id  = zcl_ai_task_service=>gc_mod_report
          IMPORTING ev_task_id    = lv_f2
                    ev_ambiguous  = lv_a2
                    et_candidates = lt_c2 ).
        IF lv_a2 = abap_true.
          rs-needs_clarify = abap_true.
          rs-reason = |多个 { lv_tcode } 结果, 需要用户选择分析哪一份|.
        ELSEIF lv_f2 IS NOT INITIAL.
          rs-task_id = lv_f2.
          rs-reason  = |分析已有报表结果(不触发重新执行)|.
        ELSE.
          rs-needs_clarify = abap_true.
          rs-reason = |无已有结果; 需要用户确认是查看结果还是填写参数执行|.
        ENDIF.
        RETURN.
      ENDIF.
    ENDIF.

    " ---- 规则 5: "先看库存"/库存词 → INVENTORY(沿用领域卡词表) ----
    DATA(lv_domain) = zcl_ai_domain_cards=>match_domain( iv_question ).
    IF lv_domain = zcl_ai_domain_cards=>gc_dom_inventory.
      rs-module_id    = zcl_ai_task_service=>gc_mod_inventory.
      rs-intent_code  = gc_int_inventory.
      rs-action       = gc_act_create.
      rs-object_kind  = 'MATERIAL'.
      rs-reason       = |库存意图, 创建或恢复库存任务(其他任务保留)|.
    ELSEIF lv_domain = zcl_ai_domain_cards=>gc_dom_data.
      rs-module_id    = zcl_ai_task_service=>gc_mod_data.
      rs-intent_code  = gc_int_table_data.
      rs-action       = gc_act_create.
      rs-object_kind  = 'NONE'.
      rs-reason       = |数据分析意图, 创建或恢复数据任务|.
    ENDIF.
    " GENERAL/其他: 保持缺省, 旧链路处理

  ENDMETHOD.


  METHOD validate_plan.

    CLEAR: ev_ok, ev_reason.

    DATA(lv_intent) = to_upper( iv_intent ).
    DATA(lv_module) = to_upper( iv_module ).

    " intent 必须在注册表内
    CASE lv_intent.
      WHEN gc_int_run_analyze OR gc_int_view_report OR gc_int_analyze_art
        OR gc_int_inventory OR gc_int_table_data OR gc_int_general
        OR gc_int_code.
      WHEN OTHERS.
        ev_reason = |未注册的意图: { iv_intent }|.
        RETURN.
    ENDCASE.

    " module 必须在注册表内
    CASE lv_module.
      WHEN zcl_ai_task_service=>gc_mod_report
        OR zcl_ai_task_service=>gc_mod_inventory
        OR zcl_ai_task_service=>gc_mod_data
        OR zcl_ai_task_service=>gc_mod_code
        OR zcl_ai_task_service=>gc_mod_general.
      WHEN OTHERS.
        ev_reason = |未注册的业务模块: { iv_module }|.
        RETURN.
    ENDCASE.

    " intent 与 module 匹配(防跨模块越权: 报表执行不能伪装成 DATA)
    DATA: lv_expect_mod TYPE string.
    CASE lv_intent.
      WHEN gc_int_run_analyze OR gc_int_view_report OR gc_int_analyze_art.
        lv_expect_mod = zcl_ai_task_service=>gc_mod_report.
      WHEN gc_int_inventory.
        lv_expect_mod = zcl_ai_task_service=>gc_mod_inventory.
      WHEN gc_int_table_data.
        lv_expect_mod = zcl_ai_task_service=>gc_mod_data.
      WHEN gc_int_code.
        lv_expect_mod = zcl_ai_task_service=>gc_mod_code.
      WHEN OTHERS.
        lv_expect_mod = zcl_ai_task_service=>gc_mod_general.
    ENDCASE.
    IF lv_module <> lv_expect_mod.
      ev_reason = |意图 { lv_intent } 只能属于模块 { lv_expect_mod }|.
      RETURN.
    ENDCASE.

    " 对象格式: TCODE 必须 TCode 形; 其他 kind 暂只允许 NONE/TABLE
    CASE to_upper( iv_object_kind ).
      WHEN 'TCODE'.
        IF is_tcode_like( iv_object_val ) = abap_false.
          ev_reason = |对象值 { iv_object_val } 不是合法的事务代码形式|.
          RETURN.
        ENDIF.
      WHEN 'TABLE'.
        IF iv_object_val CN 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_ '.
          ev_reason = |对象值 { iv_object_val } 不是合法的表名形式|.
          RETURN.
        ENDIF.
      WHEN 'MATERIAL' OR 'NONE' OR ''.
        " 通过(具体校验由各模块工具参数 Schema 承担)
      WHEN OTHERS.
        ev_reason = |未注册的对象类型: { iv_object_kind }|.
        RETURN.
    ENDCASE.

    ev_ok = abap_true.

  ENDMETHOD.


  METHOD is_tcode_like.

    " Z 自开发事务约定: Z 开头, 4~20 位大写字母数字
    rv = xsdbool( strlen( iv_token ) BETWEEN 4 AND 20
                  AND iv_token(1) = 'Z'
                  AND iv_token CO 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' ).

  ENDMETHOD.


  METHOD extract_tcode_token.

    CLEAR rv.
    " 提取 Z 开头的词元(前后是非字母数字或行首行尾), 去掉尾随标点
    FIND REGEX '([Z][A-Z0-9_]{3,19})' IN to_upper( iv_question )
      SUBMATCHES rv.
    IF sy-subrc <> 0.
      CLEAR rv.
      RETURN.
    ENDIF.
    " 去掉下划线结尾(常见于表名误命中); ABAP 偏移量不允许算式,
    " 先算出末位下标再取单字符比较
    DATA lv_last TYPE i.
    lv_last = strlen( rv ) - 1.
    WHILE lv_last >= 0 AND rv+lv_last(1) = '_'.
      rv = rv+0(lv_last).
      lv_last = lv_last - 1.
    ENDWHILE.
    " 剩余长度不足 4 则不算 TCode(防止误吞表名/字段名)
    IF strlen( rv ) < 4.
      CLEAR rv.
    ENDIF.

  ENDMETHOD.


  METHOD resolve_task_by_object.

    CLEAR: ev_task_id, ev_ambiguous, et_candidates.

    " 在会话内找标题或对象值与 TCode 相关的任务(候选仅限当前用户会话)
    " (LOOP AT 的 WHERE 不支持 IN 值清单, 活跃态判断走 TASK_SERVICE 辅助方法)
    DATA(lt_tasks) = zcl_ai_task_service=>list_tasks( iv_session_id ).
    LOOP AT lt_tasks INTO DATA(ls_t)
         WHERE module_id = iv_module_id.
      IF zcl_ai_task_service=>is_selectable_status( ls_t-status ) = abap_false.
        CONTINUE.
      ENDIF.
      " 标题含 TCode 或意图对象匹配(标题由后端生成时写入对象值)
      IF ls_t-title CS iv_object OR ls_t-intent_code CS iv_object.
        APPEND VALUE #( task_id  = ls_t-task_id
                        short_id = zcl_ai_task_service=>short_id( ls_t-task_id )
                        module_id = ls_t-module_id
                        title    = ls_t-title
                        status   = ls_t-status ) TO et_candidates.
      ENDIF.
    ENDLOOP.

    IF lines( et_candidates ) = 1.
      ev_task_id = et_candidates[ 1 ]-task_id.
    ELSEIF lines( et_candidates ) > 1.
      ev_ambiguous = abap_true.
    ENDIF.
    " 0 候选: 两者都不置, 调用方决定创建/澄清

  ENDMETHOD.


ENDCLASS.

