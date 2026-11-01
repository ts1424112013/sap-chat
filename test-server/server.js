/**
 * 测试服务器入口
 * 用途：模拟 SAP Gateway OData 的 AnalyzeAgent 函数导入
 * 启动：node server.js
 * 测试：curl -X POST http://localhost:3000/AnalyzeAgent -H "Content-Type: application/json" -d '{"question":"统计物料主数据"}'
 */

const express = require('express');
const cors = require('cors');
const { runAgent, wrapThink } = require('./agent-loop');
const { TaskStore, shortId } = require('./task-store');
const { ReportStore, RUN_STATUS } = require('./report-store');
const { quickRoute } = require('./intent-route');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ============================================================
// V15: 任务/报表协议 Mock(对照 ZCL_AI_TASK_SERVICE / ZCL_AI_REPORT_SERVICE)
// 开关默认关闭(安全默认): 用环境变量打开
//   TASK_CONTEXT_ENABLED / REPORT_READ_ENABLED / REPORT_EXEC_ENABLED = 1
// ZM001 为演示登记(非真实报表); Mock 不能证明真实 SAP 权限/作业/结果锁
// ============================================================
const MOCK_USER = 'MOCKUSER';
const MOCK_SESSION = 'MOCK_SESSION';
const taskStore = new TaskStore({ enabled: process.env.TASK_CONTEXT_ENABLED === '1' });
const reportStore = new ReportStore({
  readEnabled: process.env.REPORT_READ_ENABLED === '1',
  execEnabled: process.env.REPORT_EXEC_ENABLED === '1',
  taskStore
});
reportStore.register({
  report_id: 'ZM001_DEMO', tcode: 'ZM001',
  report_name: '物料收发存汇总(演示)',
  description: '示例 ZM001: 仅文档与 Mock 使用, 不是真实报表',
  exec_enabled: true, max_rows: 200
}, [
  { param_id: 'P_WERKS', label: '工厂', data_type: 'CHAR', length: 4, required: true, sort_no: 1 },
  { param_id: 'P_DATE_FROM', label: '开始日期', data_type: 'DATE', required: true, sort_no: 2 },
  { param_id: 'P_DATE_TO', label: '结束日期', data_type: 'DATE', required: true, validation_rule: 'GE:P_DATE_FROM', sort_no: 3 },
  { param_id: 'MOCK_SCENARIO', label: 'Mock 场景', data_type: 'CHAR', required: false, sort_no: 99 },
  { param_id: 'MOCK_DELAY_SEC', label: 'Mock 延迟秒', data_type: 'NUM', required: false, sort_no: 100 }
]);

function taskCandidates(tcode) {
  return taskStore.listTasks(MOCK_SESSION, MOCK_USER)
    .filter(t => t.module_id === 'REPORT'
      && (t.status === 'OPEN' || t.status === 'WAITING_INPUT' || t.status === 'QUEUED'
        || t.status === 'RUNNING' || t.status === 'ANALYZING' || t.status === 'PAUSED'
        || t.status === 'COMPLETED' || t.status === 'PARTIAL')
      && (t.title.includes(tcode) || (t.intent_code || '').includes(tcode)))
    .map(t => ({ task_id: t.task_id, title: t.title, status: t.status }));
}

/** REPORT 意图确定性应答(不调 LLM, 不虚构执行; 对照 AGENT_SERVICE.build_report_intro) */
function handleReportIntent(route, sessionId, user) {
  const pick = taskStore.pickOrCreate(sessionId, route.task_id, 'REPORT', route.intent_code, `报表 ${route.object_value}`, user);
  if (pick.needs_clarify) {
    return { TaskId: '', TaskStatus: '', Answer: `存在多个 ${route.object_value} 相关任务, 请指定要继续哪一个。`, NeedsInput: '' };
  }
  const def = reportStore.getDefByTcode(route.object_value);
  if (!def) {
    return {
      TaskId: pick.task_id, TaskModule: 'REPORT', TaskStatus: '',
      Answer: `【报表未登记】事务代码 ${route.object_value} 未在系统报表登记表中, 或已被停用。为避免误执行, 系统不会尝试运行未登记的报表。`,
      NeedsInput: '', PendingParamsJson: ''
    };
  }
  const params = reportStore.getParams(def.report_id, def.config_version);
  const required = params.filter(p => p.required);
  const needs = required.length > 0;
  const pending = params.map(p => ({
    param_id: p.param_id, label: p.label, required: p.required === true,
    data_type: p.data_type, multi_value: p.multi_value === true, range_allowed: p.range_allowed === true
  }));
  const task = pick.task_id ? taskStore.getOwned(pick.task_id, sessionId, user) : null;
  if (needs && task) {
    taskStore.updateStatus(task.task_id, task.current_version, 'WAITING_INPUT', '', user);
    task.pending_json = JSON.stringify(pending);
  }
  const lines = params.map(p =>
    `- ${p.label}(${p.required ? '必填' : '可选'}${p.multi_value ? ', 多值' : ''}${p.range_allowed ? ', 范围' : ''})`).join('\n');
  return {
    TaskId: pick.task_id, TaskModule: 'REPORT',
    TaskStatus: needs ? 'WAITING_INPUT' : (task ? task.status : 'OPEN'),
    Answer: `【报表 ${def.report_name}】(${def.tcode} / ${def.report_id})\n${def.description}\n\n`
      + (needs ? `【需要填写参数】(在任务卡表单中填写后提交执行; 聊天内不会直接提交作业)\n${lines}\n` : '')
      + (reportStore.execEnabled
        ? '\n(报表执行能力已开启: 参数确认后可通过任务卡提交后台运行。)'
        : '\n(报表执行能力当前关闭(REPORT_EXEC_ENABLED), 只能查看参数与已有结果。)'),
    NeedsInput: needs ? 'X' : '',
    PendingParamsJson: JSON.stringify(pending)
  };
}

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
    const result = await runAgent(question, {scene: req.body.scene || "", skillId: req.body.skill_id || ""});

    // 返回 OData JSON 格式（对照后端 ty_agent_result）
    res.json({
      d: {
        SessionId: session_id || `TEST_${Date.now()}`,
        // 20261029：思考过程放在回答前面（对照 DPC V15.10 wrap_think），前端拆开显示
        Answer: wrapThink(result.reasoning, result.answer),
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
  res.json({
    status: 'ok',
    message: 'SAP Mock Server Running',
    task_context_enabled: taskStore.taskEnabled(),
    report_read_enabled: reportStore.readEnabled,
    report_exec_enabled: reportStore.execEnabled
  });
});

// ============================================================
// V15: 任务/报表协议端点(GenericResult 契约 {Success,Message,ResultJson})
// ============================================================

app.post('/AnalyzeTask', async (req, res) => {
  const { question, session_id, task_id } = req.body || {};
  if (!question) {
    return res.status(400).json({ d: { Answer: '', Status: 'ERROR', Message: '缺少 question 参数' } });
  }
  if (!taskStore.taskEnabled()) {
    // 任务层未开启 → 与旧 AnalyzeAgent 相同(前端能力回退由 ChatService 承担)
    return res.status(404).json({ d: { Message: '任务上下文能力未开启(TASK_CONTEXT_ENABLED)' } });
  }
  const route = quickRoute(question, { findTaskCandidates: (tc) => taskCandidates(tc) });
  if (route.module_id === 'REPORT' && route.object_kind === 'TCODE') {
    const det = handleReportIntent(route, session_id || MOCK_SESSION, MOCK_USER);
    return res.json({
      d: {
        SessionId: session_id || MOCK_SESSION,
        Answer: det.Answer, Status: 'OK', ModelId: 'deterministic',
        Rounds: '0', ElapsedMs: '0', TraceJson: '[]', AnalysisJson: '',
        Message: '确定性应答(未调用模型)',
        TaskId: det.TaskId, TaskModule: det.TaskModule, TaskStatus: det.TaskStatus,
        NeedsInput: det.NeedsInput, PendingParamsJson: det.PendingParamsJson,
        ArtifactRefsJson: '[]'
      }
    });
  }
  // 非 REPORT 意图: 任务选择/创建后走 LLM Agent(同旧链路)
  const pick = taskStore.pickOrCreate(session_id || MOCK_SESSION, route.task_id,
    route.module_id, route.intent_code, question, MOCK_USER);
  try {
    const result = await runAgent(question, {scene: req.body.scene || "", skillId: req.body.skill_id || ""});
    const task = pick.task_id ? taskStore.getOwned(pick.task_id, session_id || MOCK_SESSION, MOCK_USER) : null;
    if (task) {
      const sts = result.status === 'OK' ? 'COMPLETED' : (result.status === 'TIMEOUT' ? 'PARTIAL' : 'FAILED');
      taskStore.updateStatus(task.task_id, task.current_version, sts, '', MOCK_USER);
      taskStore.attachMessages(task.task_id, session_id || MOCK_SESSION,
        [{ msg_seq: Date.now() % 100000, role: 'user' }], MOCK_USER);
    }
    res.json({
      d: {
        SessionId: session_id || MOCK_SESSION,
        Answer: wrapThink(result.reasoning, result.answer), Status: result.status, ModelId: 'deepseek-chat',
        Rounds: String(result.rounds), ElapsedMs: String(result.elapsed_ms),
        TraceJson: result.trace_json, AnalysisJson: '',
        Message: result.status === 'OK' ? '' : '超时或异常',
        TaskId: pick.task_id, TaskModule: route.module_id, TaskStatus: '',
        NeedsInput: '', PendingParamsJson: '', ArtifactRefsJson: '[]'
      }
    });
  } catch (error) {
    res.status(500).json({ d: { Answer: '', Status: 'ERROR', Message: error.message } });
  }
});

app.get('/Tasks', (req, res) => {
  const list = taskStore.listTasks(MOCK_SESSION, MOCK_USER).map(t => ({
    task_id: t.task_id, short_id: shortId(t.task_id), module_id: t.module_id,
    intent_code: t.intent_code, title: t.title, status: t.status,
    version: t.current_version, pending_json: t.pending_json, summary_text: t.summary_text
  }));
  res.json({ d: { Success: 'X', Message: '', ResultJson: JSON.stringify(list) } });
});

app.get('/TaskContext', (req, res) => {
  const ctx = taskStore.buildContext(MOCK_SESSION, req.query.TaskId || '', MOCK_USER);
  if (!ctx) {
    return res.json({ d: { Success: '', Message: '任务不存在、能力未开启或不属于当前用户', ResultJson: '' } });
  }
  res.json({ d: { Success: 'X', Message: '', ResultJson: JSON.stringify(ctx) } });
});

app.get('/ReportDefinitions', (req, res) => {
  if (!reportStore.readEnabled) {
    return res.json({ d: { Success: 'X', Message: '报表读取能力未开启(REPORT_READ_ENABLED)', ResultJson: '[]' } });
  }
  const defs = reportStore.listDefs().map(d => ({
    report_id: d.report_id, tcode: d.tcode, name: d.report_name,
    description: d.description, exec_enabled: d.exec_enabled ? 'X' : '',
    config_version: d.config_version,
    params: reportStore.getParams(d.report_id, d.config_version)
  }));
  res.json({ d: { Success: 'X', Message: '', ResultJson: JSON.stringify(defs) } });
});

app.post('/StartReportRun', (req, res) => {
  const b = req.body || {};
  const st = reportStore.startRun(b.TaskId || '', b.SessionId || MOCK_SESSION,
    b.ReportId || '', b.ParamsJson || '{}', b.ClientRequestId || '', MOCK_USER);
  res.json({ d: { Success: st.rejected ? '' : 'X', Message: st.message, ResultJson: JSON.stringify(st) } });
});

app.get('/ReportRunStatus', (req, res) => {
  const out = reportStore.pollStatus(req.query.ReportRunId || '', MOCK_USER);
  if (!out.run) {
    return res.json({ d: { Success: '', Message: out.message, ResultJson: '' } });
  }
  const view = {
    report_run_id: out.run.report_run_id, short_id: shortId(out.run.report_run_id),
    task_id: out.run.task_id, report_id: out.run.report_id, status: out.status,
    artifact_id: out.run.artifact_id, artifact_short: out.run.artifact_id ? shortId(out.run.artifact_id) : '',
    row_count: out.run.row_count, error_code: out.run.error_code,
    error_message: out.run.error_message, message: out.message
  };
  res.json({ d: { Success: 'X', Message: out.message, ResultJson: JSON.stringify(view) } });
});

app.get('/ReportResult', (req, res) => {
  const out = reportStore.getResult(req.query.ArtifactId || '', MOCK_USER);
  res.json({ d: { Success: out.artifact_id && !out.message ? 'X' : '', Message: out.message, ResultJson: JSON.stringify(out) } });
});

app.post('/TaskAction', (req, res) => {
  const b = req.body || {};
  const task = taskStore.getOwned(b.TaskId || '', b.SessionId || MOCK_SESSION, MOCK_USER);
  if (!task) {
    return res.json({ d: { Success: '', Message: '任务不存在、能力未开启或不属于当前会话', ResultJson: '' } });
  }
  const act = String(b.Action || '').toUpperCase();
  if (act === 'VIEW') {
    const ctx = taskStore.buildContext(b.SessionId || MOCK_SESSION, task.task_id, MOCK_USER);
    return res.json({ d: { Success: 'X', Message: '', ResultJson: JSON.stringify(ctx) } });
  }
  if (act === 'PAUSE' || act === 'RESUME' || act === 'REANALYZE') {
    const target = act === 'PAUSE' ? 'PAUSED' : (act === 'RESUME' ? 'OPEN' : 'ANALYZING');
    const ok = taskStore.updateStatus(task.task_id, task.current_version, target, '', MOCK_USER);
    return res.json({
      d: {
        Success: ok.ok ? 'X' : '', Message: ok.ok ? '' : (ok.reason || '状态更新失败'),
        ResultJson: ok.ok ? JSON.stringify({ task_id: task.task_id, status: target }) : ''
      }
    });
  }
  res.json({ d: { Success: '', Message: `未支持的任务动作: ${act}(白名单: VIEW/PAUSE/RESUME/REANALYZE)`, ResultJson: '' } });
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
║   模型: ${process.env.LLM_MODEL || 'glm-4.6'}                        ║
╚════════════════════════════════════════╝

测试命令:
  curl -X POST http://localhost:3000/AnalyzeAgent \\
    -H "Content-Type: application/json" \\
    -d '{"question":"查询物料 MAT001 在工厂 1000 的库存"}'

前端配置:
  修改 webapp/service/ChatService.js:
  var sServiceUrl = "http://localhost:3000";

环境变量:
  export LLM_API_KEY=your-key-here
  `);
});
