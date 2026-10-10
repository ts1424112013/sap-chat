/**
 * 确定性意图路由(纯逻辑, 无 LLM)
 * 对照后端 ZCL_AI_INTENT_ROUTER(《Agent多业务任务与报表分析》P1)
 *
 * 规则与 ABAP 侧一致:
 * - "表 X" 优先 → DATA(不得因 Z 开头误判 REPORT)
 * - 执行/运行/跑一下 + Z 开头 TCode 形对象 → REPORT 候选(未核验)
 * - 继续/恢复/刚才 + TCode → 恢复任务; 多候选必须追问(不猜唯一)
 * - "分析 ZM001"(无执行词) → 分析已有结果, 不隐含重新执行
 * - 库存词 → INVENTORY; 未命中 → GENERAL(走旧链路)
 * V1.0.3/V1.0.4(20261011, 与 ABAP 同步):
 * - 表名双语序("表ZIDPPP099的数据" / "ZIDPPP099表数据"); 报表/图表/列表/表格/表单 不算表名标记
 * - TCode 块内"分析/看看/解读"先于"继续/刚才"
 * - 规则 4b: 指代报表结果("这个结果/上面的数据/报表结果") + 分析类动作 → ANALYZE_ARTIFACT(object_kind=ARTIFACT)
 */

function isTcodeLike(tok) {
  return /^[Z][A-Z0-9_]{3,19}$/.test(tok || '') && !tok.endsWith('_');
}

function extractTcode(question) {
  const m = String(question || '').toUpperCase().match(/([Z][A-Z0-9_]{3,19})/);
  if (!m) return '';
  let tok = m[1];
  while (tok.endsWith('_')) tok = tok.slice(0, -1);
  return tok.length >= 4 ? tok : '';
}

/**
 * @param {string} question 用户消息
 * @returns {{module_id, intent_code, action, object_kind, object_value, task_id, needs_clarify, reason}}
 */
function routeAuto(question, opts = {}) {
  const out = {
    module_id: 'GENERAL', intent_code: 'GENERAL_CHAT', action: 'CREATE_TASK',
    object_kind: '', object_value: '', task_id: '', needs_clarify: false, reason: '通用问题, 走旧链路'
  };
  const q = String(question || '').toUpperCase();

  // 规则 1: "表 + 表名" → DATA(优先级最高; 场景: 分析表 ZTEST_DATA)
  // V1.0.4: 先屏蔽 报表/图表/列表/表格/表单; V1.0.3: 支持反语序 "X表"
  const qTab = q.replace(/报表|图表|列表|表格|表单/g, '#');
  const tab = qTab.match(/表[\s:：]*([A-Z][A-Z0-9_]{2,29})/) || qTab.match(/([A-Z][A-Z0-9_]{2,29})\s*表/);
  if (tab) {
    out.module_id = 'DATA';
    out.intent_code = 'TABLE_ANALYSIS';
    out.object_kind = 'TABLE';
    out.object_value = tab[1];
    out.reason = `问题明确指定表 ${tab[1]}, 按表数据分析处理`;
    return out;
  }

  const tcode = extractTcode(question);
  if (tcode) {
    // 规则 2: 执行/运行 + TCode → REPORT 执行意图
    if (/执行|运行|跑一下|跑一次|提交|重跑/.test(q)) {
      out.module_id = 'REPORT';
      out.intent_code = 'RUN_AND_ANALYZE_REPORT';
      out.action = 'EXECUTE';
      out.object_kind = 'TCODE';
      out.object_value = tcode;
      out.task_id = opts.findTaskId ? (opts.findTaskId(tcode) || '') : '';
      out.reason = `用户要求执行报表 ${tcode}(对象待后端登记核验)`;
      return out;
    }
    // 规则 4: 分析 + TCode(无执行词) → 分析已有结果, 不隐含执行(V1.0.4: 先于规则 3)
    if (/分析|看看|解读/.test(q)) {
      out.module_id = 'REPORT';
      out.intent_code = 'ANALYZE_ARTIFACT';
      out.action = 'ANALYZE';
      out.object_kind = 'TCODE';
      out.object_value = tcode;
      if (opts.findTaskCandidates) {
        const cands = opts.findTaskCandidates(tcode) || [];
        if (cands.length > 1) {
          out.needs_clarify = true;
          out.reason = `多个 ${tcode} 结果, 需要用户选择分析哪一份`;
        } else if (cands.length === 1) {
          out.task_id = cands[0].task_id;
          out.reason = '分析已有报表结果(不触发重新执行)';
        } else {
          out.needs_clarify = true;
          out.reason = '无已有结果; 需要用户确认是查看结果还是填写参数执行';
        }
      }
      return out;
    }
    // 规则 3: 继续/恢复 + TCode → RESUME(多候选追问)
    if (/继续|恢复|刚才|之前|那个/.test(q)) {
      out.module_id = 'REPORT';
      out.intent_code = 'VIEW_REPORT_RESULT';
      out.action = 'RESUME_TASK';
      out.object_kind = 'TCODE';
      out.object_value = tcode;
      if (opts.findTaskCandidates) {
        const cands = opts.findTaskCandidates(tcode) || [];
        if (cands.length > 1) {
          out.needs_clarify = true;
          out.reason = `存在多个 ${tcode} 相关任务, 需要用户选择`;
        } else if (cands.length === 1) {
          out.task_id = cands[0].task_id;
          out.reason = '恢复唯一匹配的报表任务';
        } else {
          out.action = 'CREATE_TASK';
          out.reason = `提到报表 ${tcode} 但会话内无对应任务`;
        }
      }
      return out;
    }
  }

  // 规则 4b(V1.0.4): 指代报表结果 + 分析类动作 → ANALYZE_ARTIFACT(结果由 Agent 定位/校验)
  const qRef = q.replace(/数据库|数据元素|数据类型|数据字典/g, '#');
  let refHit = /(这个|这份|这些|该|此|上面|上述|刚才|刚刚|前面|以上)的?(报表)?(运行)?(结果|数据)/.test(qRef) ||
    /(报表|运行)的?结果/.test(qRef);
  if (refHit) {
    refHit = /分析|解读|总结|看看|看一下|说明|洞察|结论|怎么样|如何|有什么|有哪些|趋势|异常|汇总|统计|对比|排名|占比|分布|最多|最少|最大|最小|最高|最低|哪个|哪些|多少/.test(qRef);
  } else {
    refHit = /(分析|解读|总结)(一下|下)?的?结果|结果(分析|解读|总结)/.test(qRef);
  }
  if (refHit) {
    out.module_id = 'REPORT';
    out.intent_code = 'ANALYZE_ARTIFACT';
    out.action = 'ANALYZE';
    out.object_kind = 'ARTIFACT';
    out.reason = '分析会话中的报表结果(不重新执行, 不新建数据任务)';
    return out;
  }

  // 规则 5: 库存词 → INVENTORY
  if (/库存|在库|料号|物料号|余量|收发|收货|发料|盘点|库位/.test(q)) {
    out.module_id = 'INVENTORY';
    out.intent_code = 'INVENTORY_QUERY';
    out.object_kind = 'MATERIAL';
    out.reason = '库存意图, 创建或恢复库存任务(其他任务保留)';
    return out;
  }
  // 规则 6: 数据分析词 → DATA
  if (/统计|汇总|趋势|分布|占比|排名|分组|SQL/.test(q)) {
    out.module_id = 'DATA';
    out.intent_code = 'TABLE_ANALYSIS';
    out.reason = '数据分析意图, 创建或恢复数据任务';
  }
  return out;
}

/* ===== V1.0.5(20261011, 与 ABAP 同步): 会话场景约束 ===== */
const SCENES = ['REPORT', 'DATA', 'INVENTORY', 'CODE'];

function normalizeScene(s) {
  const v = String(s || '').toUpperCase().trim();
  return SCENES.includes(v) ? v : 'AUTO';
}

function applyScene(question, scene, r, opts) {
  const q = String(question || '').toUpperCase();
  const tc = extractTcode(question);
  const exec = !!tc && /执行|运行|跑一下|跑一次|重跑/.test(q);
  const base = { action: 'CREATE_TASK', object_kind: '', object_value: '', task_id: '',
    needs_clarify: false, reason: '', out_of_scene: false };
  const out = (o) => Object.assign({}, base, o);
  if (scene === 'REPORT') {
    if (r.module_id === 'REPORT') return r;
    if (r.object_kind === 'TABLE' || r.module_id === 'INVENTORY') {
      return Object.assign({}, r, { out_of_scene: true,
        reason: r.object_kind === 'TABLE' ? '查表/统计表数据属于「数据分析」场景' : '库存查询属于「库存查询」场景' });
    }
    if (tc) {
      return out({ module_id: 'REPORT', intent_code: exec ? 'RUN_AND_ANALYZE_REPORT' : 'VIEW_REPORT_RESULT',
        action: exec ? 'EXECUTE' : 'CREATE_TASK', object_kind: 'TCODE', object_value: tc,
        task_id: opts.findTaskId ? (opts.findTaskId(tc) || '') : '', reason: `报表场景: 按报表 ${tc} 处理` });
    }
    return out({ module_id: 'REPORT', intent_code: 'ANALYZE_ARTIFACT', action: 'ANALYZE',
      object_kind: 'ARTIFACT', reason: '报表场景: 追问本会话的报表结果' });
  }
  if (scene === 'DATA') {
    if (r.module_id === 'REPORT') {
      if (r.intent_code === 'RUN_AND_ANALYZE_REPORT' && exec) {
        return Object.assign({}, r, { out_of_scene: true, reason: '执行报表属于「报表执行」场景' });
      }
      return r.object_kind === 'TCODE' && tc
        ? out({ module_id: 'DATA', intent_code: 'TABLE_ANALYSIS', object_kind: 'TABLE', object_value: tc, reason: `数据分析场景: ${tc} 按表名处理` })
        : out({ module_id: 'DATA', intent_code: 'TABLE_ANALYSIS', object_kind: 'NONE', reason: '数据分析场景: 追问已有数据结果' });
    }
    if (r.module_id !== 'DATA') {
      return out({ module_id: 'DATA', intent_code: 'TABLE_ANALYSIS', object_kind: 'NONE', reason: '数据分析场景' });
    }
    return r;
  }
  if (scene === 'INVENTORY') {
    if (r.module_id === 'REPORT' && r.intent_code === 'RUN_AND_ANALYZE_REPORT' && exec) {
      return Object.assign({}, r, { out_of_scene: true, reason: '执行报表属于「报表执行」场景' });
    }
    if (r.object_kind === 'TABLE') {
      return Object.assign({}, r, { out_of_scene: true, reason: '查表/写 SQL 属于「数据分析」场景' });
    }
    return out({ module_id: 'INVENTORY', intent_code: 'INVENTORY_QUERY', object_kind: 'MATERIAL', reason: '库存查询场景' });
  }
  if (scene === 'CODE') {
    if (r.module_id === 'REPORT' && r.intent_code === 'RUN_AND_ANALYZE_REPORT' && exec) {
      return Object.assign({}, r, { out_of_scene: true, reason: '执行报表属于「报表执行」场景(这里可以解读该报表的程序逻辑)' });
    }
    if (r.object_kind === 'TABLE') {
      return out({ module_id: 'CODE', intent_code: 'CODE_ANALYSIS', object_kind: 'TABLE', object_value: r.object_value, reason: '代码分析场景' });
    }
    return out({ module_id: 'CODE', intent_code: 'CODE_ANALYSIS', object_kind: tc ? 'PROGRAM' : 'NONE',
      object_value: tc || '', reason: '代码分析场景' });
  }
  return r;
}

/** V1.0.5: 先按原混合规则判, 再按会话场景(opts.scene)收窄 */
function quickRoute(question, opts = {}) {
  const r = Object.assign({ out_of_scene: false }, routeAuto(question, opts));
  const scene = normalizeScene(opts.scene);
  return scene === 'AUTO' ? r : applyScene(question, scene, r, opts);
}

module.exports = { quickRoute, isTcodeLike, extractTcode, normalizeScene };
