/**
 * Agent 循环的 JS 验证版（对照 ZCL_AI_AGENT_SERVICE 逻辑）
 * 用途：本地测试 Agent 工作流，无需连接真实 SAP 后端
 * 模型：默认 GLM（https://open.bigmodel.cn/api/paas/v4/chat/completions），
 *       可通过环境变量切换任意 OpenAI 兼容端点
 *
 * 协议口径对齐 ABAP：工具清单写入 system prompt（不用 OpenAI 原生 tools 参数），
 * 模型每轮在 content 输出严格 JSON（对照 ZCL_AI_AGENT_SERVICE 860-913 行）
 */

const axios = require('axios');
const mockTools = require('./mock-tools');

const LLM_API_KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || 'your-key-here';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'glm-4.6';
const MAX_ROUNDS = 10;
const BUDGET_MS = 180000;

/**
 * 意图路由（对照 ZCL_AI_DOMAIN_CARDS::match_domain）
 */
function matchDomain(question) {
  const q = question.toUpperCase();

  // 库存意图优先
  if (/库存|在库|料号|物料号|余量|收发|收货|发料|盘点|库位/.test(q)) {
    return 'INVENTORY';
  }

  // 数据分析意图
  if (/统计|汇总|趋势|分布|占比|多少个|多少种|数量|排名|TOP|分组|饼图|柱状图|折线图|MARA|分析|查询|列出|找出|有哪些|SQL/.test(q)) {
    return 'DATA';
  }

  return 'GENERAL';
}

/**
 * 领域卡（对照 ZCL_AI_DOMAIN_CARDS::get_card）
 */
function getDomainCard(domain) {
  const cards = {
    INVENTORY: `【库存领域知识】
1. 库存查询范围: 指定工厂(WERKS)+料号(MATNR)
2. 当前库存 = 查询时点的库位余额快照
3. 单位(MEINS)多值时禁止跨单位加总

【工具使用】
- resolve_material: 料号不完整时先查候选
- get_stock: 查询当前库存快照
- get_movements: 查询指定日期的收发明细`,

    DATA: `【数据分析领域知识】
1. 取数工具: search_tables(找表) → describe_table(确认字段) → run_sql(执行 SELECT)
2. 写 SQL 前必须先确认表和字段真实存在
3. 0 行结果是有效业务事实，不是失败

【run_sql 写法规范】
1. 只允许一条 SELECT；INTO/UP TO/PACKAGE SIZE 由系统自动添加
2. 首选 SAP Open SQL 格式：表使用 AS 别名，字段使用别名~字段，显式 JOIN ... ON
3. 非聚合字段全部写入 GROUP BY；聚合字段使用英文 ASCII 别名，不使用中文别名
4. 优先使用 COUNT/SUM/AVG/MIN/MAX、GROUP BY、HAVING、ORDER BY；不要 SELECT *
5. 不支持：FROM 子查询/WITH(CTE)/窗口函数
6. 字符串用单引号；日期是 YYYYMMDD 格式
7. run_sql 前必须在本次请求中成功 describe_table 确认 SQL 涉及的每张表；
   未知表名先 search_tables，再 describe_table
8. 报错后只根据错误修正一次，不重复提交相同 SQL

【推荐 SQL 模板】
SELECT H~KUNNR AS CUSTOMER_ID, C~NAME1 AS CUSTOMER_NAME,
       COUNT( DISTINCT H~VBELN ) AS ORDER_CNT,
       SUM( H~NETWR ) AS NETWR_TOTAL
  FROM VBAK AS H
  LEFT OUTER JOIN KNA1 AS C ON H~KUNNR = C~KUNNR
  WHERE H~ERDAT >= '20260101'
  GROUP BY H~KUNNR, C~NAME1
  ORDER BY ORDER_CNT DESCENDING

【常用业务表】
- MM 采购: EKKO(采购订单头)/EKPO(行项目)
- MM 库存: MARA/MARC/MARD/MSEG+MKPF
- SD 销售: VBAK(销售订单头)/VBAP(行项目)/KNA1(客户)
- 自定义: ZIDPPP_TEST01(生产工单，自建测试表)`
  };

  return cards[domain] || '';
}

/**
 * 调用 LLM API（OpenAI 兼容格式）
 * 注意：不传 tools 参数 —— 与 ABAP 端一致，工具靠 system prompt 描述，
 * 模型在 content 里输出协议 JSON，避免模型改用原生 tool_calls 导致解析失败
 */
async function callLLM(messages) {
  const body = {
    model: LLM_MODEL,
    messages: messages,
    temperature: 0.3,
    max_tokens: 2000
  };
  // GLM 推理模型思考档位：老一代(4.5等)支持 disabled；新一代(glm-5.x)始终思考 → low 档
  const isBigmodel = LLM_BASE_URL.includes('bigmodel.cn');
  if (isBigmodel) {
    body.thinking = /^glm-[5-9]/i.test(LLM_MODEL) ? { budget: 'low' } : { type: 'disabled' };
  }
  body.max_tokens = /^glm-[5-9]/i.test(LLM_MODEL) ? 4000 : 2000;  // 思考内容计入 max_tokens，新一代放宽

  const post = b => axios.post(
    LLM_BASE_URL,
    b,
    {
      headers: {
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  let response;
  try {
    response = await post(body);
  } catch (e) {
    // 1210 = 该模型始终思考不支持关闭（如 glm-5.3-flash）→ 改用 low 档思考重试一次
    const code = e.response?.data?.error?.code;
    if (isBigmodel && String(code) === '1210') {
      body.thinking = { budget: 'low' };
      response = await post(body);
    } else {
      throw e;
    }
  }

  return response.data.choices[0].message;
}

/**
 * Agent 主循环
 */
async function runAgent(question) {
  const startTime = Date.now();
  const domain = matchDomain(question);
  const domainCard = getDomainCard(domain);
  const tools = mockTools.getToolsForDomain(domain);
  const trace = [];

  // 工具清单写入 prompt（对照 ZCL_AI_AGENT_SERVICE 860-913 行的 lv_tools 拼接）
  const toolLines = tools.length > 0
    ? tools.map(t => {
        const params = t.parameters
          .map(p => `${p.name}=${p.description}${p.required ? '(必填)' : '(可选)'}`)
          .join(', ');
        return `- ${t.id}[${params}]: ${t.description}`;
      }).join('\n')
    : '（本领域无工具，请基于已有知识直接回答）';

  // 系统 Prompt（简化版，对照 AGENT_SERVICE 的完整版）
  const systemPrompt = `你是 SAP 业务助手。当前问题属于【${domain}】领域。

${domainCard}

【可用工具】
${toolLines}

【协议要求】（对照 ABAP 端 build_protocol_prompt）
1. 每轮仅输出一行严格 JSON，不要包含任何其他文字:
   工具轮: {"action":"tool","tool":"<工具ID>","summary":"<一句话说明>","args":{...}}
   收口轮: {"action":"final","summary":"<一句话说明>","answer":"<最终回答>"}
2. action=tool 时必须指定 tool 和 args
3. action=final 时必须在 answer 里写最终回答（summary 是一句话概述）
4. 工具执行结果会通过 <tool_result> 回填给你，基于结果决定下一步
5. 最多 ${MAX_ROUNDS} 轮，预算 ${BUDGET_MS/1000} 秒
6. 工具返回的信息已足够回答时，下一轮立即 action=final 收口；不要为确认而重复调用已成功的工具
7. search_tables 关键词用简短核心词（如"销售订单"而不是"统计销售订单按客户分组"）
8. search_tables 最多调用 3 次；用不同关键词反复搜索不会找到更多表，找到所需表后立即 describe_table 或收口
9. action=final 的 answer 必须引用工具结果中的具体数据（键值/数量/金额/表名），直接给出结论和数字；不要只说"统计完成"而不给数字`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question }
  ];

  let round = 0;
  let finalAnswer = '';
  const describedTables = new Set();
  let repaired = false;   // 协议修复重试只允许一次（对照 ABAP 计划书 P1-2 / lv_repaired）
  let protocolError = '';

  while (round < MAX_ROUNDS && (Date.now() - startTime) < BUDGET_MS) {
    round++;
    console.log(`\n=== 第 ${round} 轮 ===`);

    // 最后一轮强制收口（对照 ZCL_AI_AGENT_SERVICE：最后一轮注入收口提示，不再调工具）
    if (round === MAX_ROUNDS) {
      messages.push({
        role: 'user',
        content: '【系统提示】这是最后一轮。请基于已获得的工具结果输出 action=final 的最终回答；工具结果不足的项在回答中如实说明，不要再调用工具。'
      });
    }

    // 调用模型
    const assistantMsg = await callLLM(messages);
    messages.push(assistantMsg);

    // 协议解析（宽松提取，对照 ZCL_AI_AGENT_GUARD::parse_model_json）
    let parsed = null;
    let parseErr = '';
    try {
      const jsonMatch = (assistantMsg.content || '').match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('输出中未找到 JSON');
      parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.action) throw new Error('缺少 action 字段');
    } catch (e) {
      parseErr = e.message;
      parsed = null;
    }

    // 非法输出：仅允许一次修复重试（对照 ZCL_AI_AGENT_SERVICE 协议错误处理）
    if (!parsed) {
      console.error('JSON 解析失败:', assistantMsg.content);
      if (!repaired) {
        repaired = true;
        trace.push({ phase: 'ROUND_' + round, label: `协议错误，修复重试(${parseErr})`, status: 'RETRY' });
        messages.push({
          role: 'user',
          content: '【协议错误】你上一条输出不符合协议。请重新仅输出一行 JSON，不要包含任何其他文字：\n{"action":"tool","tool":"<工具ID>","summary":"<一句话说明>","args":{...}}\n或 {"action":"final","summary":"<一句话说明>","answer":"<最终回答>"}'
        });
        continue;
      }
      protocolError = `模型输出两次不符合协议(${parseErr})`;
      break;
    }

    console.log('模型输出:', parsed);

    trace.push({
      phase: 'ROUND_' + round,
      label: parsed.summary || '处理中',
      status: 'OK'
    });

    // 检查是否 final（answer 优先，summary 兜底 —— 对齐 ABAP 协议字段）
    if (parsed.action === 'final') {
      finalAnswer = parsed.answer || parsed.summary || '';
      break;
    }

    // 执行工具（action=tool，兼容旧版 continue）
    if (parsed.tool) {
      console.log(`执行工具: ${parsed.tool}`, parsed.args);

      let toolResult;
      if (parsed.tool === 'run_sql') {
        const sql = String(parsed.args?.sql || '');
        const sqlTables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Z_][A-Z0-9_/]*)/gi)]
          .map(match => match[1].toUpperCase());
        const missingTables = [...new Set(sqlTables)].filter(table => !describedTables.has(table));
        toolResult = {
          status: missingTables.length > 0 ? 'REJECTED' : 'PENDING',
          summary: missingTables.length > 0
            ? `run_sql 被拒绝：请先 describe_table 确认 ${missingTables.join(', ')} 的字段`
            : '',
          data: missingTables.length > 0
            ? { ok: false, error: `执行 run_sql 前必须先 describe_table 确认表和字段：${missingTables.join(', ')}` }
            : null
        };
        if (toolResult.status === 'PENDING') {
          toolResult = await mockTools.execute(parsed.tool, parsed.args || {});
        }
      } else {
        toolResult = await mockTools.execute(parsed.tool, parsed.args || {});
        if (parsed.tool === 'describe_table' && toolResult.status === 'OK') {
          describedTables.add(String(parsed.args?.table || '').toUpperCase());
        }
      }
      console.log('工具结果:', toolResult);

      trace.push({
        phase: 'EXECUTING',
        tool: parsed.tool,
        label: toolResult.summary,
        status: toolResult.status,
        rows: toolResult.rows
      });

      // 回填结果
      messages.push({
        role: 'user',
        content: `<tool_result tool="${parsed.tool}">\n${JSON.stringify(toolResult.data)}\n</tool_result>`
      });
    }
  }

  const status = finalAnswer ? 'OK' : (protocolError ? 'ERROR' : 'TIMEOUT');

  return {
    answer: finalAnswer,
    status: status,
    rounds: round,
    elapsed_ms: Date.now() - startTime,
    trace_json: JSON.stringify(trace)
  };
}

module.exports = { runAgent };
