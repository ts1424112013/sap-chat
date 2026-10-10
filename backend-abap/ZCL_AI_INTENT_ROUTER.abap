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
* V1.0.1  20261008: validate_plan 内 IF 闭合笔误 ENDCASE→ENDIF(源码
*   自带缺陷, SE24 报 Incorrect nesting CASE/ENDCASE; 无逻辑变更)
* V1.0.2  20261008: 保留字修复连锁 —— resolve_task_by_object 引用
*   ty_task.title 已随 V1.0.2(TASK_SERVICE) 改名 task_title, 同步 2 处;
*   ty_candidate.title 视图键不变(模型/前端无感)
* V1.0.3  20261009: 表名双语序 —— "表ZIDPPP099的数据" 与 "ZIDPPP099表数据"
*   均命中规则 1(本版按 10.09 日报复原, 整类替换即可)
* V1.0.4  20261011: 对话式结果分析(10.09 遗留问题 1) ——
*   ① 新规则 4b: 指代报表结果("这个结果/上面的数据/报表结果") + 分析类
*     动作, 或"分析一下结果" → REPORT/ANALYZE_ARTIFACT, object_kind=ARTIFACT
*     (原先落到规则 5 被"分析"判成新建 DATA 任务); 结果由 AGENT_SERVICE
*     定位(前端聚焦结果 > 会话最近可用报表结果)并校验, 找不到回落旧路由;
*   ② TCode 块内"分析/看看/解读"(规则 4)提前到"继续/刚才"(规则 3)之前:
*     "分析一下刚才 ZDPMM702 的结果" 应分析结果, 而不是再出参数卡;
*   ③ 规则 1 表名匹配前先屏蔽 报表/图表/列表/表格/表单 —— 防 "执行报表
*     ZDPMM702" 被当成表分析、"ALV表格" 被当成表 ALV;
*   ④ validate_plan 允许 object_kind = ARTIFACT
* V1.0.5  20261011: 会话场景(一个 Agent 入口 + 会话级场景, AGENT_TYPE) ——
*   quick_route 新增可选 iv_scene: AUTO(缺省/旧会话) = 原混合路由不变;
*   REPORT/DATA/INVENTORY/CODE = 先按原规则判, 再按场景约束(apply_scene):
*   报表场景只出报表意图(点名 Z 对象 = 报表卡, 其余 = 追问本会话报表结果),
*   数据分析场景永不触发报表(Z 词元按表名), 库存场景只走库存, 代码场景只
*   走代码; 场景外的诉求置 out_of_scene(由 AGENT_SERVICE 如实提示换场景);
*   原 quick_route 主体原样改名为私有 route_auto; ty_intent 末尾加 out_of_scene;
*   validate_plan 允许 object_kind = PROGRAM
* ★ 重贴后核对标记: quick_route 中 "表+表名" 规则必须在执行/继续规则
*   之前(防 "分析表 ZTEST_DATA" 因 Z 开头误判 REPORT); 偏移/长度
*   已全部先落中间变量(§2.1-2); 规则 4b 在 TCode 块之后、规则 5 之前;
*   V1.0.5: 规则主体在 route_auto, quick_route 只做 route_auto + apply_scene
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
    " ---- V1.0.5: 会话场景(存 ZAI_CHAT_SESS.AGENT_TYPE; 空/GENERAL = AUTO) ----
    CONSTANTS: gc_scene_auto      TYPE string VALUE 'AUTO',
               gc_scene_report    TYPE string VALUE 'REPORT',
               gc_scene_data      TYPE string VALUE 'DATA',
               gc_scene_inventory TYPE string VALUE 'INVENTORY',
               gc_scene_code      TYPE string VALUE 'CODE'.

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
             out_of_scene  TYPE abap_bool,    " V1.0.5: 诉求不属于当前会话场景
           END OF ty_intent.

    " 确定性快捷路由(供 AGENT_SERVICE 在 match_domain 之后调用):
    " 命中无歧义规则时返回意图与对象; 未命中返回 general(调用方降级旧链路)
    " V1.0.5: iv_scene 非 AUTO 时按会话场景约束结果(见 apply_scene)
    CLASS-METHODS quick_route
      IMPORTING iv_question   TYPE string
                iv_session_id TYPE string
                iv_scene      TYPE string OPTIONAL
      RETURNING VALUE(rs)     TYPE ty_intent.

    " V1.0.5: AGENT_TYPE → 场景(空/GENERAL/未知 = AUTO; 旧 INVENTORY 会话 = 库存)
    CLASS-METHODS normalize_scene
      IMPORTING iv_agent_type TYPE string
      RETURNING VALUE(rv)     TYPE string.

    " V1.0.5: 场景中文名(提示文案用)
    CLASS-METHODS scene_label
      IMPORTING iv_scene  TYPE string
      RETURNING VALUE(rv) TYPE string.

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

    " V1.0.5: 原 quick_route 主体(混合路由规则 1~5, 逻辑未改)
    CLASS-METHODS route_auto
      IMPORTING iv_question   TYPE string
                iv_session_id TYPE string
      RETURNING VALUE(rs)     TYPE ty_intent.

    " V1.0.5: 会话场景约束(只收窄, 不新增能力; 场景外置 out_of_scene)
    CLASS-METHODS apply_scene
      IMPORTING iv_question   TYPE string
                iv_session_id TYPE string
                iv_scene      TYPE string
      CHANGING  cs_intent     TYPE ty_intent.

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

    " V1.0.5: 先按原混合规则判, 再按会话场景收窄
    rs = route_auto( iv_question = iv_question iv_session_id = iv_session_id ).
    DATA(lv_scene) = normalize_scene( iv_scene ).
    IF lv_scene <> gc_scene_auto.
      apply_scene( EXPORTING iv_question   = iv_question
                             iv_session_id = iv_session_id
                             iv_scene      = lv_scene
                   CHANGING  cs_intent     = rs ).
    ENDIF.

  ENDMETHOD.


  METHOD normalize_scene.

    rv = to_upper( iv_agent_type ).
    CONDENSE rv NO-GAPS.
    CASE rv.
      WHEN gc_scene_report OR gc_scene_data OR gc_scene_inventory OR gc_scene_code.
        " 显式场景
      WHEN OTHERS.
        rv = gc_scene_auto.   " 空 / GENERAL / AUTO / 未知 → 原混合路由
    ENDCASE.

  ENDMETHOD.


  METHOD scene_label.

    DATA(lv_scene) = normalize_scene( iv_scene ).
    CASE lv_scene.
      WHEN gc_scene_report.
        rv = '报表执行'.
      WHEN gc_scene_data.
        rv = '数据分析'.
      WHEN gc_scene_inventory.
        rv = '库存查询'.
      WHEN gc_scene_code.
        rv = '代码分析'.
      WHEN OTHERS.
        rv = '自动'.
    ENDCASE.

  ENDMETHOD.


  METHOD apply_scene.

    DATA(lv_up) = to_upper( iv_question ).
    DATA(lv_tc) = extract_tcode_token( iv_question ).
    " "要执行报表"的明确动作(不含"提交": 数据问题里常见"提交日期"等字样)
    FIND REGEX '执行|运行|跑一下|跑一次|重跑' IN lv_up.
    DATA(lv_exec) = xsdbool( sy-subrc = 0 AND lv_tc IS NOT INITIAL ).

    CASE iv_scene.

      WHEN gc_scene_report.
        " ---- 报表执行: 只出报表意图; 结果分析不调工具 ----
        IF cs_intent-module_id = zcl_ai_task_service=>gc_mod_report.
          RETURN.   " 执行 / 查看 / 分析结果, 原样
        ENDIF.
        IF cs_intent-object_kind = 'TABLE'
           OR cs_intent-module_id = zcl_ai_task_service=>gc_mod_inventory.
          cs_intent-out_of_scene = abap_true.
          cs_intent-reason = COND #( WHEN cs_intent-object_kind = 'TABLE'
                                     THEN |查表/统计表数据属于「数据分析」场景|
                                     ELSE |库存查询属于「库存查询」场景| ).
          RETURN.
        ENDIF.
        IF lv_tc IS NOT INITIAL.
          " 点名 Z 对象 = 报表(登记卡/参数; 未登记由报表服务如实拒绝)
          CLEAR cs_intent.
          cs_intent-module_id    = zcl_ai_task_service=>gc_mod_report.
          cs_intent-intent_code  = COND #( WHEN lv_exec = abap_true
                                           THEN gc_int_run_analyze ELSE gc_int_view_report ).
          cs_intent-action       = COND #( WHEN lv_exec = abap_true
                                           THEN gc_act_execute ELSE gc_act_create ).
          cs_intent-object_kind  = 'TCODE'.
          cs_intent-object_value = lv_tc.
          resolve_task_by_object(
            EXPORTING iv_session_id = iv_session_id
                      iv_object     = lv_tc
                      iv_module_id  = zcl_ai_task_service=>gc_mod_report
            IMPORTING ev_task_id    = cs_intent-task_id ).
          cs_intent-reason = |报表场景: 按报表 { lv_tc } 处理|.
          RETURN.
        ENDIF.
        " 其余问题 = 对本会话报表结果的追问(AGENT_SERVICE 定位结果/无结果给场景说明)
        CLEAR cs_intent.
        cs_intent-module_id   = zcl_ai_task_service=>gc_mod_report.
        cs_intent-intent_code = gc_int_analyze_art.
        cs_intent-action      = gc_act_analyze.
        cs_intent-object_kind = 'ARTIFACT'.
        cs_intent-reason      = |报表场景: 追问本会话的报表结果|.

      WHEN gc_scene_data.
        " ---- 数据分析: 永不触发报表; Z 词元按表名 ----
        IF cs_intent-module_id = zcl_ai_task_service=>gc_mod_report.
          IF cs_intent-intent_code = gc_int_run_analyze AND lv_exec = abap_true.
            cs_intent-out_of_scene = abap_true.
            cs_intent-reason = |执行报表属于「报表执行」场景|.
            RETURN.
          ENDIF.
          DATA(lv_kind) = cs_intent-object_kind.
          CLEAR cs_intent.
          cs_intent-module_id   = zcl_ai_task_service=>gc_mod_data.
          cs_intent-intent_code = gc_int_table_data.
          cs_intent-action      = gc_act_create.
          IF lv_kind = 'TCODE' AND lv_tc IS NOT INITIAL.
            cs_intent-object_kind  = 'TABLE'.
            cs_intent-object_value = lv_tc.
            cs_intent-reason       = |数据分析场景: { lv_tc } 按表名处理|.
          ELSE.
            cs_intent-object_kind = 'NONE'.
            cs_intent-reason      = |数据分析场景: 追问已有数据结果|.
          ENDIF.
          RETURN.
        ENDIF.
        IF cs_intent-module_id <> zcl_ai_task_service=>gc_mod_data.
          " 库存/通用问题在本场景统一用数据分析工具回答
          cs_intent-module_id   = zcl_ai_task_service=>gc_mod_data.
          cs_intent-intent_code = gc_int_table_data.
          cs_intent-action      = gc_act_create.
          cs_intent-object_kind = 'NONE'.
          cs_intent-reason      = |数据分析场景|.
        ENDIF.

      WHEN gc_scene_inventory.
        " ---- 库存查询: 只走库存工具 ----
        IF cs_intent-module_id = zcl_ai_task_service=>gc_mod_report
           AND cs_intent-intent_code = gc_int_run_analyze AND lv_exec = abap_true.
          cs_intent-out_of_scene = abap_true.
          cs_intent-reason = |执行报表属于「报表执行」场景|.
          RETURN.
        ENDIF.
        IF cs_intent-object_kind = 'TABLE'.
          cs_intent-out_of_scene = abap_true.
          cs_intent-reason = |查表/写 SQL 属于「数据分析」场景|.
          RETURN.
        ENDIF.
        CLEAR cs_intent.
        cs_intent-module_id   = zcl_ai_task_service=>gc_mod_inventory.
        cs_intent-intent_code = gc_int_inventory.
        cs_intent-action      = gc_act_create.
        cs_intent-object_kind = 'MATERIAL'.
        cs_intent-reason      = |库存查询场景|.

      WHEN gc_scene_code.
        " ---- 代码分析: 只读源码/表结构, 不执行报表 ----
        IF cs_intent-module_id = zcl_ai_task_service=>gc_mod_report
           AND cs_intent-intent_code = gc_int_run_analyze AND lv_exec = abap_true.
          cs_intent-out_of_scene = abap_true.
          cs_intent-reason = |执行报表属于「报表执行」场景(这里可以解读该报表的程序逻辑)|.
          RETURN.
        ENDIF.
        DATA(lv_tab_kind) = xsdbool( cs_intent-object_kind = 'TABLE' ).
        DATA(lv_obj) = cs_intent-object_value.
        CLEAR cs_intent.
        cs_intent-module_id   = zcl_ai_task_service=>gc_mod_code.
        cs_intent-intent_code = gc_int_code.
        cs_intent-action      = gc_act_create.
        IF lv_tab_kind = abap_true.
          cs_intent-object_kind  = 'TABLE'.
          cs_intent-object_value = lv_obj.
        ELSEIF lv_tc IS NOT INITIAL.
          cs_intent-object_kind  = 'PROGRAM'.
          cs_intent-object_value = lv_tc.
        ELSE.
          cs_intent-object_kind = 'NONE'.
        ENDIF.
        cs_intent-reason = |代码分析场景|.

    ENDCASE.

  ENDMETHOD.


  METHOD route_auto.

    CLEAR rs.
    " 缺省: 通用(调用方继续走旧 match_domain 链路, 不受影响)
    rs-module_id   = zcl_ai_task_service=>gc_mod_general.
    rs-intent_code = gc_int_general.
    rs-action      = gc_act_create.

    DATA(lv_up) = to_upper( iv_question ).

    " ---- 规则 1(最高优先): "表 + 表名" → DATA(03 场景 2) ----
    " 分析表 ZTEST_DATA / 统计 ZTEST_DATA 表 的记录分布 → 表分析,
    " 不因 Z 开头误判报表, 也不因"分析"误判报表执行
    " V1.0.4: 报表/图表/列表/表格/表单 里的"表"不是表名标记, 先屏蔽
    DATA(lv_tabsrc) = lv_up.
    REPLACE ALL OCCURRENCES OF REGEX '报表|图表|列表|表格|表单' IN lv_tabsrc WITH '#'.
    FIND REGEX '表[\s:：]*([A-Z][A-Z0-9_]{2,29})' IN lv_tabsrc
      SUBMATCHES DATA(lv_tab).
    IF sy-subrc <> 0.
      " V1.0.3: 反语序 "ZIDPPP099表数据" / "MARA 表"
      FIND REGEX '([A-Z][A-Z0-9_]{2,29})\s*表' IN lv_tabsrc
        SUBMATCHES lv_tab.
    ENDIF.
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

      " ---- 规则 4: "分析 ZM001"(无执行词): 执行语义不能默认 ----
      " V1.0.4: 先于规则 3 判断 —— "分析一下刚才 ZM001 的结果" 是分析, 不是恢复
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
    ENDIF.

    " ---- 规则 4b(V1.0.4): 指代报表结果 + 分析类动作 → ANALYZE_ARTIFACT ----
    " "分析一下这个结果" / "上面的数据哪个工厂最多" / "解读报表结果":
    " 原先落到规则 5 被"分析"判成新建 DATA 任务, 结果数据也不在上下文。
    " 这里只给候选意图; 结果定位/归属/READY 校验在 AGENT_SERVICE
    " (找不到可用报表结果时回落旧路由, 不硬拒)
    DATA(lv_refsrc) = lv_up.
    REPLACE ALL OCCURRENCES OF REGEX '数据库|数据元素|数据类型|数据字典' IN lv_refsrc WITH '#'.
    DATA(lv_ref_hit) = abap_false.
    FIND REGEX '(这个|这份|这些|该|此|上面|上述|刚才|刚刚|前面|以上)的?(报表)?(运行)?(结果|数据)'
      IN lv_refsrc.
    IF sy-subrc = 0.
      lv_ref_hit = abap_true.
    ELSE.
      FIND REGEX '(报表|运行)的?结果' IN lv_refsrc.
      IF sy-subrc = 0.
        lv_ref_hit = abap_true.
      ENDIF.
    ENDIF.
    IF lv_ref_hit = abap_true.
      FIND REGEX '分析|解读|总结|看看|看一下|说明|洞察|结论|怎么样|如何|有什么|有哪些|趋势|异常|汇总|统计|对比|排名|占比|分布|最多|最少|最大|最小|最高|最低|哪个|哪些|多少'
        IN lv_refsrc.
      IF sy-subrc <> 0.
        lv_ref_hit = abap_false.
      ENDIF.
    ELSE.
      " 无指代词但明确说"结果": 分析一下结果 / 结果分析
      FIND REGEX '(分析|解读|总结)(一下|下)?的?结果|结果(分析|解读|总结)' IN lv_refsrc.
      IF sy-subrc = 0.
        lv_ref_hit = abap_true.
      ENDIF.
    ENDIF.
    IF lv_ref_hit = abap_true.
      rs-module_id    = zcl_ai_task_service=>gc_mod_report.
      rs-intent_code  = gc_int_analyze_art.
      rs-action       = gc_act_analyze.
      rs-object_kind  = 'ARTIFACT'.
      rs-reason       = |分析会话中的报表结果(不重新执行, 不新建数据任务)|.
      RETURN.
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
    ENDIF.

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
      WHEN 'MATERIAL' OR 'NONE' OR '' OR 'ARTIFACT' OR 'PROGRAM'.   " V1.0.4: ARTIFACT = 会话内报表结果; V1.0.5: PROGRAM = 代码对象
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
      " V1.0.2: ty_task.title→task_title(DDIC 保留字修复连锁), 视图键 title 不变
      IF ls_t-task_title CS iv_object OR ls_t-intent_code CS iv_object.
        APPEND VALUE #( task_id  = ls_t-task_id
                        short_id = zcl_ai_task_service=>short_id( ls_t-task_id )
                        module_id = ls_t-module_id
                        title    = ls_t-task_title
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

