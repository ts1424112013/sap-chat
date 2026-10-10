/**
 * Agent 测评模块(webapp/utils/AgentEval.js)纯逻辑测试 —— 无网络、无 LLM
 * 运行: node agent-eval-tests.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// sap.ui.define 垫片: 直接取工厂函数返回值
let AgentEval = null;
const sandbox = { sap: { ui: { define: (deps, fn) => { AgentEval = fn(); } } }, console, Promise, Date, RegExp, Math, JSON };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webapp/utils/AgentEval.js'), 'utf8'), sandbox);
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../webapp/model/evalCases.json'), 'utf8'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const res = (o) => Object.assign({ answer: '', status: 'OK', rounds: 2, elapsedMs: 1000, message: '', trace: [], taskModule: '', needsInput: false }, o);
const exec = (tool, status = 'OK', rows = 3) => ({ phase: 'EXECUTING', tool, status, rows, label: '' });

(async () => {
  console.log('\n━━ 题库');
  const n = AgentEval.normalizeCases(cases);
  check('内置题库全部有效', n.invalid === 0 && n.cases.length === cases.cases.length, `有效 ${n.cases.length} 无效 ${n.invalid}`);
  check('ID 唯一', new Set(n.cases.map(c => c.id)).size === n.cases.length);
  check('每个场景都有题', ['REPORT', 'DATA', 'INVENTORY', 'CODE', 'AUTO'].every(s => n.cases.some(c => c.scene === s)));
  const n2 = AgentEval.normalizeCases({ cases: [{ turns: [] }, { question: '单问题写法' }, { scene: 'xx', turns: ['a'] }] });
  check('无问题的题被忽略、question 兼容写法', n2.invalid === 1 && n2.cases.length === 2 && n2.cases[0].turns[0] === '单问题写法');
  check('未知场景归为自动', n2.cases[1].scene === 'AUTO');

  console.log('\n━━ 评分');
  const C = (expect) => ({ id: 'T', name: 't', scene: 'DATA', turns: ['q'], expect });
  const T = (o, q = 'q') => AgentEval.turnRecord(q, res(o), 2000, '');
  let s = AgentEval.score(C({ toolsAny: ['run_sql', 'sap_data_analysis'], answerAny: ['ABG1'] }),
    [T({ trace: [exec('describe_table'), exec('run_sql')], answer: '工厂 ABG1 共 5 条' })]);
  check('工具 + 回答命中 → 通过', s.pass, s.reasons.join('；'));
  s = AgentEval.score(C({ tools: ['run_sql'] }), [T({ trace: [exec('run_sql', 'REJECTED')] })]);
  check('只有被拒的调用不算调用过', !s.pass && /没有调用 run_sql/.test(s.reasons[0]));
  s = AgentEval.score(C({ noTools: true }), [T({ trace: [exec('search_tables')] })]);
  check('不该调工具却调了 → 失败', !s.pass);
  s = AgentEval.score(C({ toolsNotOk: ['run_sql'] }), [T({ trace: [exec('run_sql', 'REJECTED')], answer: '只读, 不能删除' })]);
  check('安全用例: run_sql 被拒 → 通过', s.pass, s.reasons.join('；'));
  s = AgentEval.score(C({ toolsNotOk: ['run_sql'] }), [T({ trace: [exec('run_sql', 'OK')] })]);
  check('安全用例: run_sql 执行成功 → 失败', !s.pass);
  s = AgentEval.score(C({ maxRounds: 3 }), [T({ rounds: 5 })]);
  check('超轮数 → 失败', !s.pass && /轮数 5/.test(s.reasons[0]));
  s = AgentEval.score(C({ maxSeconds: 1 }), [T({})]);
  check('超时限(按前端实测耗时) → 失败', !s.pass && /耗时/.test(s.reasons[0]));
  s = AgentEval.score(C({}), [T({ status: 'TIMEOUT' })]);
  check('默认只接受 OK', !s.pass);
  s = AgentEval.score(C({ status: ['OK', 'TIMEOUT'] }), [T({ status: 'TIMEOUT' })]);
  check('expect.status 可放宽', s.pass);
  s = AgentEval.score(C({ module: 'REPORT', needsInput: true, deterministic: true }),
    [T({ rounds: 0, message: '确定性应答(未调用模型): 报表参数待填写', taskModule: 'REPORT', needsInput: true })]);
  check('报表参数卡(确定性/模块/待填参数) → 通过', s.pass, s.reasons.join('；'));
  s = AgentEval.score(C({ deterministic: true }), [T({ rounds: 2 })]);
  check('预期确定性却调用了模型 → 失败', !s.pass);
  s = AgentEval.score(C({ answerAll: ['sap'] }), [T({ answer: 'SAP 是企业软件' })]);
  check('回答匹配不区分大小写', s.pass);
  s = AgentEval.score(C({ answerRegex: '\\d' }), [T({ answer: '共 42 条' })]);
  check('answerRegex', s.pass);
  s = AgentEval.score({ id: 'M', name: 'm', scene: 'DATA', turns: ['a', 'b'], expect: { tools: ['run_sql'] } },
    [T({ status: 'ERROR', message: 'boom' }, 'a'), T({ trace: [exec('run_sql')] }, 'b')]);
  check('任何一轮 ERROR 都失败(即使最后一轮满足预期)', !s.pass && /第 1 轮/.test(s.reasons[0]));
  const tr = AgentEval.turnRecord('q', res({ message: '模型输出两次不符合协议, 终止', status: 'ERROR' }), 10, '');
  check('识别协议错误', tr.protocolError === true);

  console.log('\n━━ 执行(假通道)');
  const sent = [], deleted = [];
  let id = 0;
  const send = (p) => {
    sent.push(p);
    if (p.question === 'boom') { return Promise.reject(new Error('HTTP 500')); }
    return Promise.resolve(res({ trace: [exec('run_sql')], answer: 'ABG1 3 条' }));
  };
  const runCases = [
    { id: 'A', name: 'a', scene: 'DATA', turns: ['q1', 'q2'], expect: { tools: ['run_sql'] } },
    { id: 'B', name: 'b', scene: 'CODE', turns: ['q3'], expect: {}, requiresScene: true },
    { id: 'C', name: 'c', scene: 'AUTO', turns: ['boom', 'never'], expect: {} }
  ];
  const progress = [];
  const out = await AgentEval.run({
    cases: runCases, repeat: 2, modelId: 'M1', sceneSupported: false,
    send, del: (sid) => { deleted.push(sid); return Promise.resolve(); }, newId: () => 'S' + (++id),
    cleanup: true, onProgress: (o) => progress.push(o.done ? 'done:' + o.item.id : 'start:' + o.item.id)
  });
  check('用例 × 次数 = 6 条结果', out.length === 6, String(out.length));
  check('需场景的用例在后端不支持时跳过', out.filter(r => r.id === 'B').every(r => r.skipped));
  check('多轮在同一会话里发送', sent.filter(p => p.question === 'q1' || p.question === 'q2').length === 4 &&
    sent[0].sessionId === sent[1].sessionId);
  check('出错后不再追问', !sent.some(p => p.question === 'never'));
  check('出错用例记为失败并带原因', out.filter(r => r.id === 'C').every(r => !r.pass && /HTTP 500/.test(r.reasons[0])));
  check('自动场景不发送 scene, 其他场景发送', sent.find(p => p.question === 'boom').scene === '' && sent[0].scene === 'DATA');
  check('传入模型 ID', sent.every(p => p.modelId === 'M1'));
  check('测完删除会话(跳过的不建会话)', deleted.length === 4, String(deleted.length));
  check('进度事件: 跳过的也有 done', progress.filter(x => x === 'done:B').length === 2);
  let stopAfter = 1, n3 = 0;
  const out2 = await AgentEval.run({ cases: runCases, repeat: 1, sceneSupported: true, send, newId: () => 'X' + (++n3),
    shouldStop: () => sent.length > 0 && (stopAfter-- <= 0) });
  check('停止标志生效(不再开始新题)', out2.length < 3, String(out2.length));

  console.log('\n━━ 汇总与报告');
  const S = AgentEval.summarize(out);
  check('汇总: 执行/跳过/通过', S.all.total === 6 && S.all.skipped === 2 && S.all.pass === 2, JSON.stringify(S.all));
  check('汇总: 按场景', S.byScene.DATA.passRate === 100 && S.byScene.AUTO.passRate === 0 && S.byScene.CODE.run === 0);
  const md = AgentEval.toMarkdown({ results: out, modelId: 'M1', repeat: 2, sceneSupported: false, caseCount: 3, startedAt: 'now', durationMs: 1234 });
  check('Markdown 报告含汇总表与失败回答', /## 汇总/.test(md) && /\| 全部 \|/.test(md) && /## 失败用例的回答/.test(md) && /HTTP 500/.test(md));

  console.log(`\n${'='.repeat(40)}\n总计: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
