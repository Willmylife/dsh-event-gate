/**
 * dsh-event-gate — 唤醒管线。
 *
 * 同一目标会话串行 resume / followup，避免多规则并发恢复同一会话。
 * fs 事件在等待期间按规则合并；webhook 事件进入有界 FIFO。
 * busy 投递按 5s、10s、30s 封顶退避，不再立即丢弃。
 * 宿主 SDK 通过参数注入，便于在无 DSH 环境下做确定性单元测试。
 */

import { renderTemplate } from "./template.js";

const MAX_MERGED_PATHS = 2000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function selectionFromHeader(header) {
  const config = header?.config;
  if (config === undefined || config === null) return undefined;
  if (config.provider === undefined || config.model === undefined) return undefined;
  const selection = { provider: config.provider, model: config.model };
  if (config.reasoningEffort !== undefined) selection.reasoningEffort = config.reasoningEffort;
  return selection;
}

function makeSelectionRef(agent) {
  let picked;
  return {
    get current() {
      if (picked !== undefined) return picked;
      try {
        return selectionFromHeader(agent.session?.requestHeader?.());
      } catch {
        return undefined;
      }
    },
    set current(next) {
      picked = next;
    },
    assembled: undefined,
  };
}

async function composeAgent(agentCtx, agent, getPresets, installModelSelection) {
  try {
    installModelSelection(agentCtx, makeSelectionRef(agent));
  } catch {
    // Model selection falls back to the host request waterfall.
  }
  const presets = typeof getPresets === "function" ? getPresets() : undefined;
  if (presets === undefined || presets === null) return;
  try {
    const presetId = agent.session?.header?.agentPreset ?? presets.defaultId;
    if (typeof presets.mount === "function") await presets.mount(agentCtx, presetId);
  } catch {
    // A missing preset must not prevent prompt delivery.
  }
}

function mergeFsVars(previous, next) {
  const paths = [];
  const seen = new Set();
  for (const value of [previous.paths, next.paths]) {
    if (typeof value !== "string" || value.length === 0) continue;
    for (const item of value.split("\n")) {
      if (seen.has(item)) continue;
      seen.add(item);
      paths.push(item);
    }
  }
  const previousCount = Number(previous.count);
  const nextCount = Number(next.count);
  const previousOmitted = Number(previous.omitted);
  const nextOmitted = Number(next.omitted);
  const omitted = (Number.isFinite(previousOmitted) ? previousOmitted : 0)
    + (Number.isFinite(nextOmitted) ? nextOmitted : 0)
    + Math.max(0, paths.length - MAX_MERGED_PATHS);
  return {
    ...previous,
    ...next,
    count: String((Number.isFinite(previousCount) ? previousCount : 0) + (Number.isFinite(nextCount) ? nextCount : 0)),
    paths: paths.slice(0, MAX_MERGED_PATHS).join("\n"),
    omitted: String(omitted),
  };
}

function renderVars(rule, vars) {
  if (rule.source !== "fs") return vars;
  const paths = typeof vars.paths === "string" && vars.paths.length > 0 ? vars.paths.split("\n") : [];
  const visible = paths.slice(0, 50);
  const omitted = Number(vars.omitted);
  const totalOmitted = (Number.isFinite(omitted) ? omitted : 0) + Math.max(0, paths.length - visible.length);
  return {
    ...vars,
    paths: visible.join("\n"),
    pathsOmitted: String(totalOmitted),
    pathsTruncated: totalOmitted > 0 ? "true" : "false",
  };
}

/**
 * Create the waker and its per-target-session scheduler.
 * @returns `{ enqueue, wake, queueStatus, close }`.
 */
export function createWaker({
  getAgents,
  getPresets,
  record,
  installModelSelection,
  createUserMessage,
  sleep = defaultSleep,
  maxDeliverAttempts = 3,
  maxQueuePerSession = 100,
}) {
  const queues = new Map();
  let sequence = 0;
  let closed = false;

  function queueFor(targetSessionId) {
    let queue = queues.get(targetSessionId);
    if (queue === undefined) {
      queue = { running: false, jobs: new Map(), order: [] };
      queues.set(targetSessionId, queue);
    }
    return queue;
  }

  function submit(rule, vars, waiter) {
    if (closed) return { accepted: false, reason: "plugin-closed" };
    if (getAgents() === undefined || getAgents() === null) {
      void record({ ruleId: rule.id, source: vars.source, outcome: "failed", detail: "agents 服务不可用（宿主未就绪或非宿主组合）" });
      return { accepted: false, reason: "agents-unavailable" };
    }
    const queue = queueFor(rule.targetSessionId);
    const key = rule.source === "fs" ? rule.id : `${rule.id}:${sequence += 1}`;
    const existing = queue.jobs.get(key);
    if (existing !== undefined) {
      existing.vars = mergeFsVars(existing.vars, vars);
      if (waiter !== undefined) existing.waiters.push(waiter);
      void record({ ruleId: rule.id, source: vars.source, outcome: "coalesced", detail: "事件已合并到等待中的下一轮触发" });
      return { accepted: true, status: "coalesced", queueDepth: queue.jobs.size };
    }
    if (queue.jobs.size >= maxQueuePerSession) {
      void record({ ruleId: rule.id, source: vars.source, outcome: "dropped", detail: `目标会话等待队列已满（${maxQueuePerSession}）` });
      return { accepted: false, reason: "queue-full" };
    }
    const job = { rule, vars, waiters: waiter === undefined ? [] : [waiter] };
    queue.jobs.set(key, job);
    queue.order.push(key);
    void pump(rule.targetSessionId, queue);
    return { accepted: true, status: "queued", queueDepth: queue.jobs.size };
  }

  /** Synchronous acceptance result for the HTTP boundary. */
  function enqueue(rule, vars) {
    return submit(rule, vars);
  }

  /** Resolve after the event (or its coalesced successor) finishes delivery. */
  function wake(rule, vars) {
    return new Promise((resolve) => {
      const accepted = submit(rule, vars, resolve);
      if (!accepted.accepted) resolve({ outcome: "failed", detail: accepted.reason });
    });
  }

  async function pump(targetSessionId, queue) {
    if (queue.running) return;
    queue.running = true;
    try {
      while (!closed && queue.order.length > 0) {
        const key = queue.order.shift();
        const job = queue.jobs.get(key);
        queue.jobs.delete(key);
        if (job === undefined) continue;
        const result = await deliverWithRetry(job.rule, job.vars);
        for (const waiter of job.waiters) waiter(result);
      }
    } finally {
      queue.running = false;
      if (queue.order.length === 0) {
        queues.delete(targetSessionId);
      } else if (!closed) {
        void pump(targetSessionId, queue);
      }
    }
  }

  async function deliverWithRetry(rule, vars) {
    let handle = null;
    try {
      const agents = getAgents();
      if (agents === undefined || agents === null) {
        const detail = "agents 服务不可用（宿主未就绪或非宿主组合）";
        await record({ ruleId: rule.id, source: vars.source, outcome: "failed", detail });
        return { outcome: "failed", detail };
      }
      const text = renderTemplate(rule.promptTemplate, { ...renderVars(rule, vars), ruleId: rule.id });
      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin:dsh-event-gate", form: "notice", summary: `事件触发：${rule.id}` },
      });
      let agent = typeof agents.get === "function" ? agents.get(rule.targetSessionId) : undefined;
      let presence = "live";
      if (agent === undefined) {
        handle = await agents.resume({
          resumeSessionId: rule.targetSessionId,
          agentOptions: undefined,
          setup: (agentCtx, resumed) => composeAgent(agentCtx, resumed, getPresets, installModelSelection),
        });
        agent = handle.agent;
        presence = "cold";
      }
      for (let attempt = 1; attempt <= maxDeliverAttempts; attempt += 1) {
        let claimed = false;
        try {
          claimed = await agent.runMaintenance(() => {
            agent.followup(message);
            return Promise.resolve(true);
          });
        } catch {
          claimed = false;
        }
        if (claimed) {
          await agent.whenIdle();
          await record({
            ruleId: rule.id,
            source: vars.source,
            outcome: "ok",
            detail: `已投递并完成（${presence} 会话 ${rule.targetSessionId}）`,
          });
          return { outcome: "ok" };
        }
        const exhausted = attempt === maxDeliverAttempts;
        await record({
          ruleId: rule.id,
          source: vars.source,
          outcome: exhausted ? "busy" : "busy-retry",
          detail: exhausted ? `目标会话持续忙碌，${maxDeliverAttempts} 次投递均未成功` : "目标会话正忙，将按退避策略重试",
        });
        if (!exhausted) await sleep(Math.min(30000, 5000 * (2 ** (attempt - 1))));
      }
      return { outcome: "busy", detail: "delivery attempts exhausted" };
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 300);
      await record({ ruleId: rule.id, source: vars.source, outcome: "failed", detail });
      return { outcome: "failed", detail };
    } finally {
      if (handle !== null) {
        try {
          await handle.dispose();
        } catch {
          // Disposal is best-effort during host shutdown.
        }
      }
    }
  }

  function queueStatus() {
    let pending = 0;
    let running = 0;
    for (const queue of queues.values()) {
      pending += queue.jobs.size;
      if (queue.running) running += 1;
    }
    return { sessions: queues.size, pending, running };
  }

  function close() {
    closed = true;
    for (const [targetSessionId, queue] of queues) {
      for (const job of queue.jobs.values()) {
        for (const waiter of job.waiters) waiter({ outcome: "failed", detail: "plugin closed" });
      }
      queue.jobs.clear();
      queue.order = [];
      if (!queue.running) queues.delete(targetSessionId);
    }
  }

  return { enqueue, wake, queueStatus, close };
}
