/**
 * 任务存储(纯逻辑, 无 HTTP / 无 LLM 依赖)
 * 对照后端 ZCL_AI_TASK_SERVICE(《Agent多业务任务与报表分析》P1)
 * 用途: test-server 协议 Mock + task-protocol-tests.js 本地单元测试
 *
 * 契约与 ABAP 侧一致:
 * - TASK_CONTEXT_ENABLED 关闭时所有方法优雅返回(旧链路零影响)
 * - TaskId/ArtifactId 服务端生成; 输入的 taskId 只是候选值,
 *   归属(session+user)校验不过即拒绝, 不猜唯一对象
 * - 乐观锁: updateStatus 带版本号, 版本不匹配拒绝
 * - 上下文包: 当前任务状态 + 结果元数据 + 有限相关消息(不塞全量历史)
 */

const STATE_KEYS = {
  OPEN: 1, WAITING_INPUT: 1, QUEUED: 1, RUNNING: 1, ANALYZING: 1,
  PAUSED: 1, COMPLETED: 1, PARTIAL: 1, FAILED: 1, CANCELLED: 1, EXPIRED: 1
};

const MODULES = { REPORT: 1, INVENTORY: 1, DATA: 1, CODE: 1, GENERAL: 1 };

const ACTIVE_STATUSES = ['OPEN', 'WAITING_INPUT', 'QUEUED', 'RUNNING', 'ANALYZING', 'PAUSED'];

function isActiveStatus(s) { return ACTIVE_STATUSES.includes(s); }
function isSelectableStatus(s) { return isActiveStatus(s) || s === 'COMPLETED' || s === 'PARTIAL'; }

function newId(prefix) {
  // 32 位十六进制(与 GUID_32 等价的确定性唯一)
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return (prefix || '') + s;
}

function shortId(id) { return String(id || '').substring(0, 8); }

function now14() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class TaskStore {
  /**
   * @param {object} opts {enabled: boolean} — 模拟 TASK_CONTEXT_ENABLED(默认 false, 安全默认)
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled === true;
    this.tasks = new Map();       // taskId -> task
    this.msgLinks = new Map();    // `${taskId}:${msgSeq}` -> {taskId, sessionId, msgSeq, role}
    this.artifacts = new Map();   // artifactId -> artifact
  }

  taskEnabled() { return this.enabled === true; }

  setEnabled(v) { this.enabled = v === true; }

  getOwned(taskId, sessionId, user) {
    if (!this.taskEnabled() || !taskId) return null;
    const t = this.tasks.get(taskId);
    if (!t) return null;
    if (t.owner !== user) return null;
    if (sessionId && t.session_id !== sessionId) return null;
    return t;
  }

  listTasks(sessionId, user) {
    if (!this.taskEnabled()) return [];
    const out = [];
    for (const t of this.tasks.values()) {
      if (t.session_id === sessionId && t.owner === user) out.push(t);
    }
    out.sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)));
    return out;
  }

  getActive(sessionId, user) {
    const list = this.listTasks(sessionId, user).filter(t => isActiveStatus(t.status));
    return list[0] || null;
  }

  /**
   * 任务选择规则(与 ABAP pick_or_create 一致):
   * 1) 显式 taskId 归属正确 → 用它; 显式但归属不符 → needsClarify(不猜)
   * 2) 同模块活跃任务 → 恢复(草稿/运行保留)
   * 3) 创建新任务
   */
  pickOrCreate(sessionId, taskId, moduleId, intent, title, user) {
    if (!this.taskEnabled()) return { task_id: '', created: false, needs_clarify: false, reason: '任务上下文能力未开启' };
    if (!MODULES[moduleId]) return { task_id: '', created: false, needs_clarify: false, reason: `未注册的模块 ${moduleId}` };

    if (taskId) {
      const t = this.getOwned(taskId, sessionId, user);
      if (t) return { task_id: t.task_id, created: false, needs_clarify: false, reason: '' };
      return { task_id: '', created: false, needs_clarify: true, reason: '指定的任务不存在或不属于当前会话' };
    }

    for (const t of this.listTasks(sessionId, user)) {
      if (t.module_id === moduleId && isActiveStatus(t.status)) {
        return { task_id: t.task_id, created: false, needs_clarify: false, reason: '' };
      }
    }

    const now = now14();
    const t = {
      task_id: newId(),
      session_id: sessionId,
      module_id: moduleId,
      intent_code: intent || '',
      title: String(title || '').substring(0, 120),
      status: 'OPEN',
      owner: user,
      focus_artifact_id: '',
      current_version: 1,
      pending_json: '',
      summary_text: '',
      created_at: now,
      changed_at: now
    };
    this.tasks.set(t.task_id, t);
    return { task_id: t.task_id, created: true, needs_clarify: false, reason: '' };
  }

  /** 乐观锁状态更新; 版本不匹配 → {ok:false} */
  updateStatus(taskId, version, status, summary, user) {
    if (!this.taskEnabled()) return { ok: false, reason: '任务上下文能力未开启' };
    if (!STATE_KEYS[status]) return { ok: false, reason: `未注册的任务状态 ${status}` };
    const t = this.tasks.get(taskId);
    if (!t || t.owner !== user) return { ok: false, reason: '任务不存在或不属于当前用户' };
    if (t.current_version !== version) {
      return { ok: false, reason: '任务已被其他操作更新(版本不一致), 请刷新后重试' };
    }
    t.status = status;
    t.current_version += 1;
    if (summary) t.summary_text = String(summary).substring(0, 120);
    t.changed_at = now14();
    return { ok: true, task: t };
  }

  attachMessages(taskId, sessionId, msgs, user) {
    if (!this.taskEnabled() || !Array.isArray(msgs)) return false;
    const t = this.getOwned(taskId, sessionId, user);
    if (!t) return false;
    for (const m of msgs) {
      this.msgLinks.set(`${taskId}:${m.msg_seq}`, {
        task_id: taskId, session_id: sessionId, msg_seq: m.msg_seq, role: m.role
      });
    }
    return true;
  }

  registerArtifact(taskId, sessionId, { type, sourceType, sourceRef, label, rowCount, datasetId, reportRunId, owner }) {
    if (!this.taskEnabled()) return '';
    const t = this.getOwned(taskId, sessionId, owner);
    if (!t) return '';
    const id = newId();
    this.artifacts.set(id, {
      artifact_id: id, task_id: taskId, session_id: sessionId,
      artifact_type: type, source_type: sourceType || 'QUERY', source_ref: sourceRef || '',
      report_run_id: reportRunId || '', dataset_id: datasetId || '',
      label: String(label || '').substring(0, 120),
      status: 'AVAILABLE', row_count: rowCount || 0,
      summary_json: '', owner, created_at: now14()
    });
    if (!t.focus_artifact_id) t.focus_artifact_id = id;
    return id;
  }

  listArtifacts(taskId, user) {
    if (!this.taskEnabled()) return [];
    const out = [];
    for (const a of this.artifacts.values()) {
      if (a.task_id === taskId && a.owner === user) out.push(a);
    }
    out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return out;
  }

  /** 上下文包: 结构化状态 + 结果元数据 + 有限相关消息(默认 2 轮, 单条 500 字) */
  buildContext(sessionId, taskId, user, ctxPairs = 2, ctxChars = 500) {
    if (!this.taskEnabled()) return null;
    const t = this.getOwned(taskId, sessionId, user);
    if (!t) return null;
    const artifacts = this.listArtifacts(taskId, user).map(a => ({
      id: a.artifact_id, short_id: shortId(a.artifact_id), type: a.artifact_type,
      label: a.label, status: a.status, row_count: a.row_count
    }));
    const related = this.listTasks(sessionId, user)
      .filter(x => x.task_id !== taskId)
      .map(x => ({ id: x.task_id, short_id: shortId(x.task_id), module: x.module_id, status: x.status, title: x.title }));
    // 任务内相关消息(按关联指针; mock 中消息正文由调用方注入)
    const msgs = [];
    for (const l of this.msgLinks.values()) {
      if (l.task_id === taskId) msgs.push(l);
    }
    msgs.sort((a, b) => b.msg_seq - a.msg_seq);
    const limited = msgs.slice(0, ctxPairs * 2).reverse();
    return {
      task_id: t.task_id, module: t.module_id, intent: t.intent_code, status: t.status,
      pending: t.pending_json ? JSON.parse(t.pending_json) : null,
      artifacts, related_tasks: related,
      recent_messages: limited.map(m => ({
        role: m.role, content: String(m.content || '').substring(0, ctxChars)
      }))
    };
  }
}

module.exports = { TaskStore, isActiveStatus, isSelectableStatus, shortId, newId, now14, MODULES, STATE_KEYS };
