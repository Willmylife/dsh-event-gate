/**
 * dsh-event-gate — 宿主入口。
 *
 * 装配：agents 服务（必需）→ waker；规则文件装载 → fs 监视源 + 规则校验；
 * 固定路由 /__dsh-event-gate/hook（webhook 事件源，按 rule 分发）；
 * /__dsh-event-gate/health（安装与状态验证入口）；trigger_list /
 * trigger_history 两个只读工具。规则文件保存即热更新（无需重启 DSH）。
 */

import { watch } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { gateRequest, respond } from "./http.js";
import { appendHistory, dshHome, ensureDir, eventGateDir, historyPath, loadRules, readHistory, rulesPath } from "./store.js";
import { createWatcherManager } from "./watcher.js";
import { createWaker } from "./wake.js";
import { createHookHandler } from "./hook.js";

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-event-gate";

/** Plugin version, kept in sync with package.json. */
export const version = "0.3.0";

/** Health probe route (install + status evidence). */
export const HEALTH_ROUTE = "/__dsh-event-gate/health";

/** Shared webhook route (dispatches by rule id in body/query). */
export const HOOK_ROUTE = "/__dsh-event-gate/hook";

/** Tool names actually registered into the host tools registry. */
const appliedTools = [];

/** Shared state filled by injections and the rule loader. */
const state = {
  agents: undefined,
  rules: [],
  errors: [],
  note: null,
};

/** History helper: always timestamps. */
function record(entry) {
  return appendHistory(entry);
}

/**
 * Build the health handler: identity, uptime, registered tools, rule counts
 * and loader errors — everything M0/M1 acceptance needs, via curl alone.
 */
function createHealthHandler() {
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
    });
  };
}

/** trigger_list：当前生效的规则 + 装载错误（可观测性）。 */
function createTriggerListTool() {
  return defineTool({
    name: "trigger_list",
    description:
      "列出 dsh-event-gate 插件当前配置的事件触发规则（只读）。返回规则列表、规则文件路径与数量；尚未配置或规则有错时返回明确说明而不是报错。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "number", required: true, description: "生效规则数量" },
          invalid: { type: "number", required: true, description: "装载失败的规则条数" },
          rulesPath: { type: "string", required: true, description: "规则文件绝对路径" },
          rules: { type: "array", required: true, items: { type: "object" }, description: "生效规则列表" },
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
          const detail =
            rule.source === "fs"
              ? `fs：监视 ${rule.watch}${rule.filter !== undefined ? `，过滤 ${rule.filter}` : ""}，防抖 ${rule.debounceMs}ms`
              : `webhook：POST /__dsh-event-gate/hook {"rule":"${rule.id}","token":"..."}；`;
          summaryParts.push(`- ${rule.id} → 唤醒会话 ${rule.targetSessionId}（${detail}）`);
        }
      }
      if (errors.length > 0) {
        summaryParts.push(`有 ${errors.length} 条规则装载失败：\n${errors.map((line) => `- ${line}`).join("\n")}`);
      }
      const result = { count: rules.length, invalid: errors.length, rulesPath: rulesPath(), rules, text: summaryParts.join("\n") };
      if (errors.length > 0) result.note = errors.join("; ");
      return result;
    },
  });
}

/** trigger_history：最近的触发记录（审计）。 */
function createTriggerHistoryTool() {
  return defineTool({
    name: "trigger_history",
    description:
      "查看 dsh-event-gate 插件最近的事件触发记录（只读审计日志，新→旧）。每条含时间、规则 id、事件源与动作结果；尚未触发过时返回明确的空态说明。",
    parameters: {
      limit: {
        type: "number",
        description: "最多返回条数（新→旧），默认 20，上限 200。",
      },
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
      const summary =
        total === 0
          ? `dsh-event-gate 尚无触发记录（历史文件：${path}）。${note ?? ""}`
          : `最近 ${events.length}/${total} 条触发记录（新→旧，文件 ${path}）：\n${events
              .map((event) => {
                const at = typeof event?.at === "string" ? event.at : "?";
                const rule = typeof event?.ruleId === "string" ? event.ruleId : "?";
                const source = typeof event?.source === "string" ? event.source : "?";
                const outcome = typeof event?.outcome === "string" ? event.outcome : "?";
                const detail = typeof event?.detail === "string" ? `：${event.detail}` : "";
                return `- ${at} 规则 ${rule} 源 ${source} → ${outcome}${detail}`;
              })
              .join("\n")}`;
      const result = { total, returned: events.length, historyPath: path, events, text: summary };
      if (note !== null) result.note = note;
      return result;
    },
  });
}

/**
 * Host loader entry.
 * @param ctx - host cordis context.
 */
export function apply(ctx) {
  // agents 是触发功能的核心依赖；tools / webServer 各自独立注入，
  // 缺一个不影响其余部分（与 dsh-notify-me 的生产模式一致）。
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
  });

  const watcher = createWatcherManager({
    log: (message) => void record({ ruleId: "(watcher)", source: "fs", outcome: "log", detail: message.slice(0, 300) }),
  });

  async function reloadRules() {
    const loaded = await loadRules();
    state.rules = loaded.rules;
    state.errors = loaded.errors ?? [];
    state.note = loaded.note ?? null;
    watcher.applyRules(loaded.rules, (rule, items) => {
      void waker.wake(rule, {
        source: "fs",
        count: String(items.length),
        paths: items.slice(0, 50).join("\n"),
      });
    });
    if (loaded.errors.length > 0) {
      await record({
        ruleId: "(rules)",
        source: "load",
        outcome: "invalid",
        detail: loaded.errors.join("; ").slice(0, 500),
      });
    }
  }

  // 启动序列：建目录 → 首次装载 → 监视 rules.json 热更新。
  let reloadTimer = null;
  void (async () => {
    try {
      await ensureDir();
    } catch {
      /* 目录创建失败时，规则装载会给出自己的说明 */
    }
    await reloadRules();
    try {
      watch(eventGateDir(), (_kind, filename) => {
        if (typeof filename === "string" && filename.replace(/\\/g, "/").endsWith("rules.json")) {
          if (reloadTimer !== null) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            reloadTimer = null;
            void reloadRules();
          }, 500);
        }
      });
    } catch {
      /* 热更新不可用时，重启 DSH 也能装载新规则 */
    }
  })();

  ctx.inject(["tools"], (toolsCtx) => {
    toolsCtx.tools.register(createTriggerListTool());
    appliedTools.push("trigger_list");
    toolsCtx.tools.register(createTriggerHistoryTool());
    appliedTools.push("trigger_history");
  });

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: "exact", path: HEALTH_ROUTE, handler: createHealthHandler() }),
      "dsh-event-gate: health route",
    );
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: HOOK_ROUTE,
          handler: createHookHandler({
            resolveRule: (id) => state.rules.find((rule) => rule.id === id),
            onEvent: (rule, payload) => {
              void waker.wake(rule, {
                source: "webhook",
                payload: JSON.stringify(payload).slice(0, 2000),
              });
            },
          }),
        }),
      "dsh-event-gate: webhook hook route",
    );
  });
}
