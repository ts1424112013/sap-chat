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
function quickRoute(question, opts = {}) {
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

module.exports = { quickRoute, isTcodeLike, extractTcode };
