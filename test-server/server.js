/**
 * 测试服务器入口
 * 用途：模拟 SAP Gateway OData 的 AnalyzeAgent 函数导入
 * 启动：node server.js
 * 测试：curl -X POST http://localhost:3000/AnalyzeAgent -H "Content-Type: application/json" -d '{"question":"统计物料主数据"}'
 */

const express = require('express');
const cors = require('cors');
const { runAgent } = require('./agent-loop');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

/**
 * 模拟 SAP OData 的 AnalyzeAgent 函数导入
 * 对照后端：DPC_EXT 的 /IWBEP/IF_MGW_APPL_SRV_RUNTIME~EXECUTE_ACTION
 */
app.post('/AnalyzeAgent', async (req, res) => {
  const { question, session_id } = req.body;

  if (!question) {
    return res.status(400).json({
      d: {
        Answer: '',
        Status: 'ERROR',
        Message: '缺少 question 参数'
      }
    });
  }

  console.log(`\n======================================`);
  console.log(`新请求: ${question}`);
  console.log(`会话: ${session_id || 'new'}`);
  console.log(`======================================`);

  try {
    const result = await runAgent(question);

    // 返回 OData JSON 格式（对照后端 ty_agent_result）
    res.json({
      d: {
        SessionId: session_id || `TEST_${Date.now()}`,
        Answer: result.answer,
        Status: result.status,
        ModelId: 'deepseek-chat',
        Rounds: String(result.rounds),
        ElapsedMs: String(result.elapsed_ms),
        TraceJson: result.trace_json,
        AnalysisJson: '',
        Message: result.status === 'OK' ? '' : '超时或异常'
      }
    });

  } catch (error) {
    console.error('Agent 执行错误:', error);
    res.status(500).json({
      d: {
        Answer: '',
        Status: 'ERROR',
        Message: error.message
      }
    });
  }
});

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'SAP Mock Server Running' });
});

/**
 * 模拟 Metadata（前端可能需要）
 */
app.get('/$metadata', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="ZSAP_AI_CHAT_SRV">
      <ComplexType Name="AgentResult">
        <Property Name="SessionId" Type="Edm.String"/>
        <Property Name="Answer" Type="Edm.String"/>
        <Property Name="Status" Type="Edm.String"/>
        <Property Name="TraceJson" Type="Edm.String"/>
      </ComplexType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   SAP Agent Mock Server 已启动         ║
║   端口: ${PORT}                         ║
║   模型: DeepSeek API                   ║
╚════════════════════════════════════════╝

测试命令:
  curl -X POST http://localhost:3000/AnalyzeAgent \\
    -H "Content-Type: application/json" \\
    -d '{"question":"查询物料 MAT001 在工厂 1000 的库存"}'

前端配置:
  修改 webapp/service/ChatService.js:
  var sServiceUrl = "http://localhost:3000";

环境变量:
  export DEEPSEEK_API_KEY=your-key-here
  `);
});
