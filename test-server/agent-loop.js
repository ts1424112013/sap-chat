/**
 * Agent 循环的 JS 验证版（对照 ZCL_AI_AGENT_SERVICE 逻辑）
 * 用途：本地测试 Agent 工作流，无需连接真实 SAP 后端
 * 模型：DeepSeek API (https://api.deepseek.com/v1/chat/completions)
 */

const axios = require('axios');
const mockTools = require('./mock-tools');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'your-key-here';
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
1. 只允许一条 SELECT; INTO/UP TO 由系统自动添加
2. 支持: 多表 JOIN(最多 8 张)/GROUP BY/聚合/ORDER BY
3. 不支持: FROM 子查询/WITH(CTE)/窗口函数
4. 字符串用单引号; 日期是 YYYYMMDD 格式

【常用业务表】
- MM 采购: EKKO(采购订单头)/EKPO(行项目)
- MM 库存: MARA/MARC/MARD/MSEG+MKPF
- SD 销售: VBAK(销售订单头)/VBAP(行项目)/KNA1(客户)`
  };

  return cards[domain] || '';
}

/**
 * 调用 DeepSeek API
 */
async function callLLM(messages, tools) {
  const response = await axios.post(
    'https://api.deepseek.com/v1/chat/completions',
    {
      model: 'deepseek-chat',
      messages: messages,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.id,
          description: t.description,
          parameters: {
            type: 'object',
            properties: t.parameters.reduce((acc, p) => {
              acc[p.name] = { type: p.type, description: p.description };
              return acc;
            }, {}),
            required: t.parameters.filter(p => p.required).map(p => p.name)
          }
        }
      })),
      temperature: 0.7,
      max_tokens: 2000
    },
    {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

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

  // 系统 Prompt（简化版，对照 AGENT_SERVICE 的完整版）
  const systemPrompt = `你是 SAP 业务助手。当前问题属于【${domain}】领域。

${domainCard}

【协议要求】
1. 每轮输出严格 JSON: {"action":"continue|final", "summary":"简短摘要(≤60字符)", "tool":"工具ID", "args":{...}}
2. action=continue 时必须指定 tool 和 args
3. action=final 时必须在 summary 里写最终回答
4. 工具执行结果会通过 <tool_result> 回填给你，基于结果决定下一步
5. 最多 ${MAX_ROUNDS} 轮，预算 ${BUDGET_MS/1000} 秒`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question }
  ];

  let round = 0;
  let finalAnswer = '';

  while (round < MAX_ROUNDS && (Date.now() - startTime) < BUDGET_MS) {
    round++;
    console.log(`\n=== 第 ${round} 轮 ===`);

    // 调用模型
    const assistantMsg = await callLLM(messages, tools);
    messages.push(assistantMsg);

    // 解析 JSON 输出
    let parsed;
    try {
      const jsonMatch = assistantMsg.content.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('JSON 解析失败:', assistantMsg.content);
      break;
    }

    console.log('模型输出:', parsed);

    trace.push({
      phase: 'ROUND_' + round,
      label: parsed.summary || '处理中',
      status: 'OK'
    });

    // 检查是否 final
    if (parsed.action === 'final') {
      finalAnswer = parsed.summary;
      break;
    }

    // 执行工具
    if (parsed.tool) {
      console.log(`执行工具: ${parsed.tool}`, parsed.args);

      const toolResult = await mockTools.execute(parsed.tool, parsed.args);
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

  return {
    answer: finalAnswer,
    status: finalAnswer ? 'OK' : 'TIMEOUT',
    rounds: round,
    elapsed_ms: Date.now() - startTime,
    trace_json: JSON.stringify(trace)
  };
}

module.exports = { runAgent };
