/**
 * dsh-event-gate — 宿主入口。
 * 规则串行热更新；fs / webhook 事件进入按目标会话隔离的调度器；
 * 所有 watcher、timer 和队列都纳入插件生命周期清理。
 */

import { watch } from "node:fs";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { gateRequest, respond } from "./http.js";
import {
  appendHistory,
  dshHome,
  ensureDir,
  eventGateDir,
  historyPath,
  historyStatus,
  loadRules,
  readHistory,
  rulesPath,
  sanitizeRule,
} from "./store.js";
import { createWatcherManager } from "./watcher.js";
import { createWaker } from "./wake.js";
import { createHookHandler } from "./hook.js";

export const name = "dsh-event-gate";
export const version = "0.3.0";
export const HEALTH_ROUTE = "/__dsh-event-gate/health";
export const HOOK_ROUTE = "/__dsh-event-gate/hook";

const appliedTools = [];
const state = {
  agents: undefined,
  rules: [],
  errors: [],
  note: null,
  hotReload: false,
  lastReloadAt: null,
  lastReloadError: null,
};

function record(entry) {
  return appendHistory(entry);
}

function createHealthHandler({ watcher, waker }) {
  const startedAt = Date.now();
  return function handleHealth(req, res) {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      respond(res, 405, { ok: false, reason: "method-not-allowed" });
      return;
    }
    const refusal = gateRequest(req);
    if (refusal !== null) {
      respond(res, 403, { ok: false, reason: refusal });
      return;
    }
    req.resume();
    const fsCount = state.rules.filter((rule) => rule.source === "fs" && rule.enabled).length;
    const hookCount = state.rules.filter((rule) => rule.source === "webhook" && rule.enabled).length;
    respond(res, 200, {
      ok: true,
      plugin: name,
      version,
      route: HEALTH_ROUTE,
      uptimeMs: Date.now() - startedAt,
      platform: process.platform,
      dshHome: dshHome(),
      tools: [...appliedTools],
      rules: { count: state.rules.length, fs: fsCount, webhook: hookCount, invalid: state.errors.length },
      ruleErrors: state.errors,
      rulesPath: rulesPath(),
      historyPath: historyPath(),
      agentsReady: state.agents !== undefined,
      watchers: { active: watcher.activeCount(), hotReload: state.hotReload },
      queue: waker.queueStatus(),
      history: historyStatus(),
      lastReloadAt: state.lastReloadAt,
      lastReloadError: state.lastReloadError,
    });
  };
}

function createTriggerListTool() {
  return defineTool({
    name: "trigger_list",
    description:
      "列出 dsh-event-gate 插件当前配置的事件触发规则（只读，webhook token 已脱敏）。返回规则列表、规则文件路径与数量；规则有错时返回明确说明。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "number", required: true, description: "生效规则数量" },
          invalid: { type: "number", required: true, description: "装载失败的规则条数" },
          rulesPath: { type: "string", required: true, description: "规则文件绝对路径" },
          rules: { type: "array", required: true, items: { type: "object" }, description: "已脱敏的生效规则列表" },
          note: { type: "string", description: "空态或异常说明；正常时省略" },
          text: { type: "string", required: true, description: "给模型读的摘要" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute() {
      const { rules, errors } = await loadRules();
      const summaryParts = [];
      if (rules.length === 0) {
        summaryParts.push(`dsh-event-gate 当前没有生效规则。规则文件：${rulesPath()}（编辑保存即热更新）。`);
      } else {
        summaryParts.push(`dsh-event-gate 共 ${rules.length} 条生效规则（编辑 ${rulesPath()} 保存即热更新）：`);
        for (const rule of rules) {
          const detail = rule.source === "fs"
            ? `fs：监视 ${rule.watch}${rule.filter !== undefined ? `，过滤 ${rule.filter}` : ""}，防抖 ${rule.debounceMs}ms`
            : `webhook：POST /__dsh-event-gate/hook {"rule":"${rule.id}","token":"..."}；`;
          summaryParts.push(`- ${rule.id} → 唤醒会话 ${rule.targetSessionId}（${detail}）`);
        }
      }
      if (errors.length > 0) {
        summaryParts.push(`有 ${errors.length} 条规则装载失败：\n${errors.map((line) => `- ${line}`).join("\n")}`);
      }
      const result = {
        count: rules.length,
        invalid: errors.length,
        rulesPath: rulesPath(),
        rules: rules.map(sanitizeRule),
        text: summaryParts.join("\n"),
      };
      if (errors.length > 0) result.note = errors.join("; ");
      return result;
    },
  });
}

function createTriggerHistoryTool() {
  return defineTool({
    name: "trigger_history",
    description:
      "查看 dsh-event-gate 插件最近的事件触发记录（只读审计日志，新→旧）。每条含时间、规则 id、事件源与动作结果。",
    parameters: {
      limit: { type: "number", description: "最多返回条数（新→旧），默认 20，上限 200。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "number", required: true, description: "历史记录总数" },
          returned: { type: "number", required: true, description: "本次返回条数" },
          historyPath: { type: "string", required: true, description: "历史文件绝对路径" },
          events: { type: "array", required: true, items: { type: "object" }, description: "触发记录，新→旧" },
          note: { type: "string", description: "空态或异常说明；正常时省略" },
          text: { type: "string", required: true, description: "给模型读的摘要" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args) {
      const requested = Number(args?.limit);
      const limit = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), 200) : 20;
      const { path, events, total, note } = await readHistory(limit);
      const summary = total === 0
        ? `dsh-event-gate 尚无触发记录（历史文件：${path}）。${note ?? ""}`
        : `最近 ${events.length}/${total} 条触发记录（新→旧，文件 ${path}）：\n${events.map((event) => {
            const at = typeof event?.at === "string" ? event.at : "?";
            const rule = typeof event?.ruleId === "string" ? event.ruleId : "?";
            const source = typeof event?.source === "string" ? event.source : "?";
            const outcome = typeof event?.outcome === "string" ? event.outcome : "?";
            const detail = typeof event?.detail === "string" ? `：${event.detail}` : "";
            return `- ${at} 规则 ${rule} 源 ${source} → ${outcome}${detail}`;
          }).join("\n")}`;
      const result = { total, returned: events.length, historyPath: path, events, text: summary };
      if (note !== null) result.note = note;
      return result;
    },
  });
}

function boundedPayload(payload) {
  const full = JSON.stringify(payload);
  if (full.length <= 2000) {
    return { payload: full, payloadTruncated: "false", payloadOriginalLength: String(full.length) };
  }
  return {
    payload: JSON.stringify({ truncated: true, originalLength: full.length, preview: full.slice(0, 1800) }),
    payloadTruncated: "true",
    payloadOriginalLength: String(full.length),
  };
}

export function apply(ctx) {
  ctx.inject(["agents"], (agentsCtx) => {
    state.agents = agentsCtx.agents;
  });

  const waker = createWaker({
    getAgents: () => state.agents,
    getPresets: () => {
      try {
        return ctx.get("agentPresets", false);
      } catch {
        return undefined;
      }
    },
    record,
    installModelSelection,
    createUserMessage,
  });
  const watcher = createWatcherManager({
    log: (message) => void record({ ruleId: "(watcher)", source: "fs", outcome: "log", detail: message.slice(0, 300) }),
  });

  let disposed = false;
  let reloadTimer = null;
  let rulesRetryTimer = null;
  let rulesWatcher = null;
  let rulesRetryDelay = 5000;
  let reloadTail = Promise.resolve();

  async function reloadRules() {
    if (disposed) return;
    try {
      const loaded = await loadRules();
      if (disposed) return;
      state.rules = loaded.rules;
      state.errors = loaded.errors ?? [];
      state.note = loaded.note ?? null;
      watcher.applyRules(loaded.rules, (rule, items, stats) => {
        void waker.wake(rule, {
          source: "fs",
          count: String(stats.total),
          paths: items.join("\n"),
          omitted: String(stats.omitted),
        });
      });
      state.lastReloadAt = new Date().toISOString();
      state.lastReloadError = null;
      if (loaded.errors.length > 0) {
        await record({ ruleId: "(rules)", source: "load", outcome: "invalid", detail: loaded.errors.join("; ").slice(0, 500) });
      }
    } catch (error) {
      state.lastReloadError = String(error?.message ?? error).slice(0, 300);
      await record({ ruleId: "(rules)", source: "load", outcome: "failed", detail: state.lastReloadError });
    }
  }

  function scheduleReload() {
    reloadTail = reloadTail.then(reloadRules);
    return reloadTail;
  }

  function scheduleRulesWatcherRetry() {
    if (disposed || rulesRetryTimer !== null) return;
    rulesRetryTimer = setTimeout(() => {
      rulesRetryTimer = null;
      startRulesWatcher();
    }, rulesRetryDelay);
    rulesRetryDelay = Math.min(rulesRetryDelay * 2, 30000);
  }

  function startRulesWatcher() {
    if (disposed || rulesWatcher !== null) return;
    try {
      const instance = watch(eventGateDir(), (_kind, filename) => {
        if (typeof filename === "string" && filename.replace(/\\/g, "/").endsWith("rules.json")) {
          if (reloadTimer !== null) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            reloadTimer = null;
            void scheduleReload();
          }, 500);
        }
      });
      rulesWatcher = instance;
      state.hotReload = true;
      rulesRetryDelay = 5000;
      instance.on("error", (error) => {
        if (rulesWatcher === instance) rulesWatcher = null;
        state.hotReload = false;
        try {
          instance.close();
        } catch {
          // Already closed.
        }
        void record({ ruleId: "(rules)", source: "load", outcome: "log", detail: `规则热更新监视出错：${String(error?.message ?? error)}`.slice(0, 300) });
        scheduleRulesWatcherRetry();
      });
    } catch (error) {
      state.hotReload = false;
      void record({ ruleId: "(rules)", source: "load", outcome: "log", detail: `无法监视规则目录：${String(error?.message ?? error)}`.slice(0, 300) });
      scheduleRulesWatcherRetry();
    }
  }

  ctx.effect(() => {
    void (async () => {
      try {
        await ensureDir();
      } catch {
        // Rule loading reports the concrete filesystem error.
      }
      await scheduleReload();
      startRulesWatcher();
    })();
    return () => {
      disposed = true;
      state.hotReload = false;
      if (reloadTimer !== null) clearTimeout(reloadTimer);
      if (rulesRetryTimer !== null) clearTimeout(rulesRetryTimer);
      reloadTimer = null;
      rulesRetryTimer = null;
      if (rulesWatcher !== null) {
        try {
          rulesWatcher.close();
        } catch {
          // Already closed.
        }
        rulesWatcher = null;
      }
      watcher.closeAll();
      waker.close();
    };
  });

  ctx.inject(["tools"], (toolsCtx) => {
    toolsCtx.tools.register(createTriggerListTool());
    if (!appliedTools.includes("trigger_list")) appliedTools.push("trigger_list");
    toolsCtx.tools.register(createTriggerHistoryTool());
    if (!appliedTools.includes("trigger_history")) appliedTools.push("trigger_history");
  });

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: "exact", path: HEALTH_ROUTE, handler: createHealthHandler({ watcher, waker }) }),
      "dsh-event-gate: health route",
    );
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: "exact",
        path: HOOK_ROUTE,
        handler: createHookHandler({
          resolveRule: (id) => state.rules.find((rule) => rule.id === id),
          onEvent: (rule, payload) => waker.enqueue(rule, { source: "webhook", ...boundedPayload(payload) }),
        }),
      }),
      "dsh-event-gate: webhook hook route",
    );
  });
}
