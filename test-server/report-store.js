/**
 * 报表存储与 Mock 执行器(纯逻辑, 无 HTTP / 无 LLM 依赖)
 * 对照后端 ZCL_AI_REPORT_SERVICE / ZCL_AI_REPORT_MOCK(P2/P3)
 * 用途: test-server 协议 Mock + task-protocol-tests.js 本地单元测试
 *
 * 契约与 ABAP 侧一致:
 * - REPORT_READ_ENABLED / REPORT_EXEC_ENABLED 默认关闭(安全默认)
 * - 未登记 TCode / 停用报表 / 参数校验失败 / 归属不符 → 拒绝,
 *   不创建运行, 不提交任何执行
 * - ClientRequestId 幂等: 同一请求重试返回同一 run; 用户主动重跑换新 id
 * - 状态机: CREATED → SUBMITTED → RUNNING → READY / FAILED / TIMEOUT / UNKNOWN
 *   TIMEOUT ≠ 作业停止; UNKNOWN 需继续查询; 0 行结果是有效事实
 * - Mock 场景: mock_scenario = SUCCESS/EMPTY/FAIL/TIMEOUT/UNKNOWN/EXPIRED
 *   (ZM001 只是文档与 Mock 示例, 不是真实报表)
 */

const { shortId, newId, now14 } = require('./task-store');

const RUN_STATUS = {
  CREATED: 'CREATED', SUBMITTED: 'SUBMITTED', RUNNING: 'RUNNING',
  READY: 'READY', FAILED: 'FAILED', TIMEOUT: 'TIMEOUT', UNKNOWN: 'UNKNOWN'
};

const SCENARIOS = ['SUCCESS', 'EMPTY', 'FAIL', 'TIMEOUT', 'UNKNOWN', 'EXPIRED'];

class ReportStore {
  /**
   * @param {object} opts {readEnabled, execEnabled, taskStore, nowMs}
   *   nowMs: 可注入时钟(测试用), 默认 Date.now
   */
  constructor(opts = {}) {
    this.readEnabled = opts.readEnabled === true;    // 默认关闭
    this.execEnabled = opts.execEnabled === true;    // 默认关闭
    this.taskStore = opts.taskStore || null;
    this._now = opts.nowMs || (() => Date.now());
    this.defs = new Map();     // reportId -> def
    this.byTcode = new Map();  // tcode -> reportId
    this.params = new Map();   // reportId -> [param]
    this.runs = new Map();     // reportRunId -> run
    this.runByRequest = new Map(); // requestId -> reportRunId (幂等)
    this.mockRuns = new Map(); // reportRunId -> {scenario, delayMs, startMs}
  }

  // ---------------- 定义与参数(P2) ----------------

  /** 登记报表(仅测试/演示用; 真实清单须在 SAP 端核验后维护) */
  register(def, params) {
    const d = {
      report_id: def.report_id,
      tcode: String(def.tcode || '').toUpperCase(),
      program: def.program || '',
      report_name: def.report_name || def.report_id,
      description: def.description || '',
      exec_enabled: def.exec_enabled === true,       // 报表级执行授权(默认关)
      max_rows: def.max_rows || 200,
      config_version: def.config_version || 'V1',
      active: def.active !== false
    };
    this.defs.set(d.report_id, d);
    this.byTcode.set(d.tcode, d.report_id);
    this.params.set(d.report_id, (params || []).map(p => ({
      param_id: p.param_id, abap_name: p.abap_name || p.param_id,
      label: p.label || p.param_id, data_type: p.data_type || 'CHAR',
      length: p.length || 0, required: p.required === true,
      multi_value: p.multi_value === true, range_allowed: p.range_allowed === true,
      default_type: p.default_type || 'NONE', default_value: p.default_value || '',
      validation_rule: p.validation_rule || '', help_text: p.help_text || '',
      sort_no: p.sort_no || 0, active: p.active !== false
    })));
    return d;
  }

  getDefByTcode(tcode) {
    if (!this.readEnabled) return null;
    const id = this.byTcode.get(String(tcode || '').toUpperCase());
    if (!id) return null;
    const d = this.defs.get(id);
    return d && d.active ? d : null;
  }

  getDef(reportId) {
    if (!this.readEnabled) return null;
    const d = this.defs.get(reportId);
    return d && d.active ? d : null;
  }

  listDefs() {
    if (!this.readEnabled) return [];
    return [...this.defs.values()].filter(d => d.active);
  }

  getParams(reportId, configVersion) {
    if (!this.readEnabled) return [];
    const d = this.defs.get(reportId);
    if (!d || !d.active) return [];
    if (configVersion && configVersion !== d.config_version) return [];
    return (this.params.get(reportId) || []).filter(p => p.active);
  }

  /**
   * 参数校验(纯校验, 不拼接不执行):
   * 必填缺失 → needsInput; 类型/值域错误 → errors
   * 多值: "a,b,c"(兼容 "|"); 范围: "low,high"(V1.0.11 与前端 AskCard 对齐)
   */
  validateParams(def, paramsJson) {
    const res = { ok: true, needs_input: false, errors: [], defaulted: [], norm: {}, norm_json: '', hash: '' };
    const defs = this.getParams(def.report_id, def.config_version);
    if (!defs.length) {
      res.ok = false;
      res.errors.push({ param_id: '', code: 'NO_SCHEMA', message: `报表 ${def.report_id} 没有可用的参数定义` });
      return res;
    }
    let input = {};
    if (paramsJson) {
      try { input = JSON.parse(paramsJson) || {}; } catch (e) {
        res.ok = false;
        res.errors.push({ param_id: '', code: 'BAD_JSON', message: '参数不是合法 JSON' });
        return res;
      }
    }
    const provided = new Set(Object.keys(input));

    for (const p of defs) {
      let v = input[p.param_id] !== undefined ? input[p.param_id] : input[p.abap_name];
      if (v === undefined || v === null || v === '') {
        if (p.default_type === 'STATIC' && p.default_value) {
          v = p.default_value;
          res.defaulted.push({ param_id: p.param_id, message: `${p.label} 已按默认值补齐` });
        } else if (p.default_type === 'USER') {
          v = '__USER__';
          res.defaulted.push({ param_id: p.param_id, message: `${p.label} 已按当前用户补齐` });
        } else if (p.required) {
          res.ok = false;
          res.needs_input = true;
          res.errors.push({ param_id: p.param_id, code: 'REQUIRED', message: `${p.label} 为必填项` });
          continue;
        } else {
          continue;
        }
      }
      const err = this._validateOne(p, String(v));
      if (err) {
        res.ok = false;
        res.errors.push({ param_id: p.param_id, code: err, message: `${p.label}: 值 "${v}" 校验未通过(${err})` });
        continue;
      }
      res.norm[p.param_id] = v;
    }

    // 未定义参数 → 拒绝(不静默丢弃)
    for (const k of provided) {
      const known = defs.some(p => p.param_id === k || p.abap_name === k);
      if (!known) {
        res.ok = false;
        res.errors.push({ param_id: k, code: 'UNKNOWN_PARAM', message: `参数 ${k} 不在该报表的登记参数中, 已拒绝` });
      }
    }
    if (res.ok) {
      // 跨参数规则(VIEW_RULE 引用; 当前支持 GE:\<param_id\> = 不小于基准参数):
      // 如 结束日期 GE 开始日期(基准可以是 DATE/NUM, 按字典序/数值比较)
      for (const p of defs) {
        const m = /^(GE|LE):([A-Za-z0-9_]+)$/.exec(p.validation_rule || '');
        if (!m) continue;
        const vSelf = res.norm[p.param_id];
        const vBase = res.norm[m[2]];
        if (vSelf === undefined || vBase === undefined) continue;
        let cmp;
        if (/^-?\d+(\.\d+)?$/.test(vSelf) && /^-?\d+(\.\d+)?$/.test(vBase)) {
          cmp = +vSelf - +vBase;
        } else {
          cmp = String(vSelf).localeCompare(String(vBase));
        }
        const bad = m[1] === 'GE' ? cmp < 0 : cmp > 0;
        if (bad) {
          res.ok = false;
          res.errors.push({
            param_id: p.param_id, code: 'RANGE',
            message: `${p.label} 与基准参数 ${m[2]} 违反 ${m[1]} 关系`
          });
        }
      }
    }
    if (res.ok) {
      res.norm_json = JSON.stringify(res.norm);
      res.hash = this._hash(def.report_id + def.config_version + res.norm_json);
    }
    return res;
  }

  /**
   * V1.0.11(与 ABAP validate_params 同口径): 多值/范围参数按逗号(兼容竖线)
   * 拆分逐项校验 —— 前端 AskCard 多值 "a,b,c"、范围 "low,high";
   * 范围(非多值)恰好两项时校验次序(NUM 按数值, 其余字典序 = YYYYMMDD 时间序)
   */
  _validateOne(p, v) {
    if (p.multi_value || p.range_allowed) {
      const items = String(v).split(/[|,]/).map(s => s.trim()).filter(Boolean);
      for (const it of items) {
        const e = this._validateScalar(p, it);
        if (e) return e;
      }
      if (p.range_allowed && !p.multi_value && items.length === 2) {
        const [a, b] = items;
        if (p.data_type === 'NUM' ? +a > +b : a > b) return 'RANGE';
      }
      return null;
    }
    return this._validateScalar(p, v);
  }

  _validateScalar(p, v) {
    if (p.data_type === 'BOOL') {
      return ['true', 'false', 'X', 'x', '1', '0'].includes(v) ? null : 'TYPE';
    }
    if (p.data_type === 'DATE') {
      if (!/^\d{8}$/.test(v)) return 'TYPE';
      const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
      if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return 'TYPE';
      return null;
    }
    if (p.data_type === 'NUM') {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return 'TYPE';
      if (p.length && v.length > p.length) return 'TYPE';
      return null;
    }
    if (p.data_type === 'ENUM') {
      const list = (p.validation_rule || '').split(',').map(s => s.trim()).filter(Boolean);
      if (list.length && !list.includes(v)) return 'DOMAIN';
      return null;
    }
    if (p.length && v.length > p.length) return 'TYPE';
    return null;
  }

  /** 一致性哈希(非安全; 位置混入 XOR, 顺序敏感; 仅同系统内确定) */
  _hash(s) {
    const win = Buffer.alloc(8);
    const buf = Buffer.from(String(s), 'utf8');
    for (let pos = 0; pos < buf.length; pos++) {
      const i = pos & 7;
      win[i] = win[i] ^ buf[pos];
      win[(i + 3) & 7] = win[(i + 3) & 7] ^ (pos & 0xFF);
    }
    return win.toString('hex');
  }

  // ---------------- 运行(P3; Mock 闭环) ----------------

  /**
   * 幂等启动运行。rejected=true 时未创建任何运行。
   * @returns {report_run_id, short_id, status, created, rejected, needs_input, message}
   */
  startRun(taskId, sessionId, reportId, paramsJson, requestId, user) {
    const out = { report_run_id: '', short_id: '', task_id: taskId, report_id: reportId, status: '', created: false, rejected: false, needs_input: false, message: '' };

    if (!this.readEnabled || !this.execEnabled) {
      out.rejected = true;
      out.message = '报表执行能力未开启(REPORT_EXEC_ENABLED), 已拒绝提交';
      return out;
    }
    const def = this.getDef(reportId);
    if (!def) {
      out.rejected = true;
      out.message = `报表 ${reportId} 未登记或已停用, 无法执行`;
      return out;
    }
    if (!def.exec_enabled) {
      out.rejected = true;
      out.message = `报表 ${def.report_name} 未开放执行权限`;
      return out;
    }
    const task = this.taskStore && this.taskStore.getOwned(taskId, sessionId, user);
    if (!task) {
      out.rejected = true;
      out.message = '任务不存在或不属于当前会话, 已拒绝提交';
      return out;
    }
    if (!requestId) {
      out.rejected = true;
      out.message = '缺少 ClientRequestId, 已拒绝提交';
      return out;
    }

    // 幂等: 同一 RequestId(同一用户)返回原运行
    const existId = this.runByRequest.get(`${user}:${requestId}`);
    if (existId) {
      const r = this.runs.get(existId);
      if (r) {
        out.report_run_id = r.report_run_id;
        out.short_id = shortId(r.report_run_id);
        out.status = r.status;
        out.created = false;
        out.message = '请求已存在, 返回原有运行(幂等)';
        return out;
      }
    }

    const pv = this.validateParams(def, paramsJson);
    if (!pv.ok) {
      out.rejected = true;
      out.needs_input = pv.needs_input;
      out.status = pv.needs_input ? 'WAITING_INPUT' : '';
      out.errors = pv.errors;
      out.message = pv.needs_input ? '参数未齐或校验未通过, 请补填后重试(本次未创建运行)'
        : '参数校验未通过, 已拒绝提交(本次未创建运行)';
      return out;
    }

    const id = newId();
    const run = {
      report_run_id: id, task_id: taskId, request_id: requestId,
      report_id: def.report_id, config_version: def.config_version,
      tcode: def.tcode, program: def.program,
      params_json: pv.norm_json, params_hash: pv.hash,
      status: RUN_STATUS.CREATED, artifact_id: '', row_count: 0,
      error_code: '', error_message: '',
      created_by: user, created_at: now14(), started_at: '', finished_at: ''
    };
    this.runs.set(id, run);
    this.runByRequest.set(`${user}:${requestId}`, id);

    // Mock submit: 场景与延迟(由参数快照 mock_scenario / mock_delay_sec 决定;
    // 键按 param_id 原样保存, 这里大小写不敏感读取, 与 ABAP to_lower 口径等价)
    let scenario = 'SUCCESS', delayMs = 5000;
    try {
      const pj = JSON.parse(pv.norm_json || '{}');
      const pick = (name) => {
        const k = Object.keys(pj).find(x => String(x).toLowerCase() === name);
        return k !== undefined ? pj[k] : undefined;
      };
      if (pick('mock_scenario') && SCENARIOS.includes(String(pick('mock_scenario')).toUpperCase())) {
        scenario = String(pick('mock_scenario')).toUpperCase();
      }
      if (pick('mock_delay_sec') !== undefined && /^\d+$/.test(String(pick('mock_delay_sec')))) {
        delayMs = Math.min(60000, parseInt(pick('mock_delay_sec'), 10) * 1000);
      }
    } catch (e) { /* 默认场景 */ }
    this.mockRuns.set(id, { scenario, delayMs, startMs: this._now() });

    run.status = RUN_STATUS.SUBMITTED;
    run.started_at = now14();
    out.report_run_id = id;
    out.short_id = shortId(id);
    out.status = run.status;
    out.created = true;
    out.message = `已提交(Mock 适配器, 场景 ${scenario}); Mock 不能证明真实 SAP 权限与后台作业行为`;

    // 任务置 QUEUED(乐观锁失败不影响运行记录)
    if (this.taskStore) {
      this.taskStore.updateStatus(taskId, task.current_version, 'QUEUED', '', user);
    }
    return out;
  }

  /** 轮询推进状态机; 返回 {status, message, run} */
  pollStatus(reportRunId, user) {
    const run = this.runs.get(reportRunId);
    if (!run || run.created_by !== user) {
      return { status: '', message: '运行不存在或不属于当前用户', run: null };
    }
    const mock = this.mockRuns.get(reportRunId);
    if (!mock) {
      // Mock 进程重启导致内存丢失: 如实返回 UNKNOWN(不伪造状态)
      if (['CREATED', 'SUBMITTED', 'RUNNING'].includes(run.status)) {
        return { status: RUN_STATUS.UNKNOWN, message: 'Mock 状态已丢失(进程重启), 需继续轮询或人工核对', run };
      }
      return { status: run.status, message: '', run };
    }
    if (['READY', 'FAILED', 'TIMEOUT'].includes(run.status)) {
      return { status: run.status, message: '', run };
    }

    const elapsed = this._now() - mock.startMs;
    if (elapsed < mock.delayMs) {
      run.status = RUN_STATUS.RUNNING;
      return { status: RUN_STATUS.RUNNING, message: `运行中(Mock, ${Math.round(elapsed / 1000)}s / 预计 ${Math.round(mock.delayMs / 1000)}s)`, run };
    }

    switch (mock.scenario) {
      case 'SUCCESS':
      case 'EXPIRED':
        run.status = RUN_STATUS.READY;
        break;
      case 'EMPTY':
        run.status = RUN_STATUS.READY;   // 0 行是有效事实
        break;
      case 'FAIL':
        run.status = RUN_STATUS.FAILED;
        run.error_code = 'MOCK_JOB_FAIL';
        run.error_message = '运行失败(Mock): 模拟作业取消/转储(脱敏错误码)';
        break;
      case 'TIMEOUT':
        run.status = RUN_STATUS.TIMEOUT;
        run.error_message = '超过预期时长(Mock); 超时非终态、不等于作业已终止, 需核对作业状态';
        break;
      case 'UNKNOWN':
        run.status = RUN_STATUS.UNKNOWN;
        run.error_message = '作业状态未知(Mock: 模拟状态来源不可信), 需继续轮询或人工核对';
        break;
      default:
        run.status = RUN_STATUS.UNKNOWN;
    }
    run.finished_at = now14();

    // READY → 结果绑定(EMPTY 也绑定 0 行结果; 绑定必须携带 ReportRunId,
    // 否则结果来源不可确认, 读取与分析会被拒绝 —— 这是安全行为而非缺陷)
    if (run.status === RUN_STATUS.READY && !run.artifact_id && this.taskStore) {
      const rows = mock.scenario === 'EMPTY' ? [] : this._mockRows();
      const aid = this.taskStore.registerArtifact(run.task_id, '', {
        type: 'REPORT_RESULT', sourceType: 'SNAPSHOT', sourceRef: `MOCK:${run.report_id}`,
        label: `${run.report_id} 运行 ${shortId(run.report_run_id)}`,
        rowCount: rows.length, reportRunId: run.report_run_id, owner: run.created_by
      });
      run.artifact_id = aid;
      run.row_count = rows.length;
    }
    return { status: run.status, message: run.error_message || '', run };
  }

  /** Mock 结果(确定性数据, 标注 MOCK; EXPIRED 场景返回过期) */
  getResult(artifactId, user) {
    const out = { artifact_id: '', report_run_id: '', report_id: '', label: '', status: '', schema_json: '', summary_json: '', rows_json: '', row_count: 0, message: '' };
    if (!this.taskStore) {
      out.message = '结果读取需要任务存储';
      return out;
    }
    const art = this.taskStore.artifacts.get(artifactId);
    if (!art || art.owner !== user) {
      out.message = '结果不存在或不属于当前用户';
      return out;
    }
    if (art.status !== 'AVAILABLE') {
      out.message = `结果当前状态为 ${art.status}, 不可读取(过期/失效需重新执行)`;
      return out;
    }
    const run = this.runs.get(art.report_run_id);
    if (!run || run.created_by !== user) {
      out.message = '无法确认结果来源运行, 已拒绝分析';
      return out;
    }
    if (run.status !== RUN_STATUS.READY) {
      out.message = `运行状态为 ${run.status}, 结果尚不可读`;
      return out;
    }
    const mock = this.mockRuns.get(run.report_run_id);
    if (mock && mock.scenario === 'EXPIRED') {
      art.status = 'EXPIRED';   // 只读不删除, 来源与原因可见
      out.message = 'EXPIRED';
      out.artifact_id = artifactId;
      return out;
    }
    const rows = mock && mock.scenario === 'EMPTY' ? [] : this._mockRows();
    out.artifact_id = artifactId;
    out.report_run_id = run.report_run_id;
    out.report_id = run.report_id;
    out.label = art.label;
    out.status = 'AVAILABLE';
    out.schema_json = JSON.stringify({
      columns: [
        { name: 'PLANT', label: '工厂(MOCK)', type: 'CHAR' },
        { name: 'MATERIAL', label: '物料(MOCK)', type: 'CHAR' },
        { name: 'QTY', label: '数量(MOCK)', type: 'NUM' }
      ]
    });
    out.rows_json = JSON.stringify(rows);
    out.row_count = rows.length;
    out.summary_json = JSON.stringify({ total_rows: rows.length, note: 'MOCK 数据, 非真实业务结果' });
    return out;
  }

  _mockRows() {
    const plants = ['1000', '2000', '3000'];
    const mats = ['M001', 'M002', 'M003', 'M004'];
    const rows = [];
    for (const p of plants) {
      for (const m of mats) {
        rows.push({ PLANT: p, MATERIAL: m, QTY: (mats.indexOf(m) + 1) * 100 + plants.indexOf(p) * 7 });
      }
    }
    return rows;
  }
}

module.exports = { ReportStore, RUN_STATUS, SCENARIOS };
