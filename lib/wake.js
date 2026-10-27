/**
 * dsh-event-gate — 唤醒管线（逆向自 dsh-proactive v0.3.2 的 wake.ts）。
 *
 * 形状全部对齐生产实现：
 * - 活会话：agents.get(sessionId) 复用；冷会话：agents.resume({...}) →
 *   {agent, dispose()}，句柄用完必 dispose。
 * - prompt 注入：createUserMessage({content:[{type:"text",text}],
 *   source:{kind:"plugin:dsh-event-gate", form:"notice", summary}})——
 *   会话格式 v4 硬拒旧的 {kind:"plugin",plugin} 包装。
 * - 投递：agent.runMaintenance(() => { agent.followup(msg); return
 *   Promise.resolve(true) })，忙时 throw → 记 busy 不重试（事件已发生，
 *   重放旧事件没有意义，用户重新触碰文件即可）。
 * - 冷唤醒组合：installModelSelection（会话自己的 requestHeader 优先，
 *   否则交给请求瀑布流）+ 尽力挂回该会话的预设，避免工具全部 unknown。
 * - 防重入：每条规则一个 in-flight 守卫。
 */

import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { renderTemplate } from "./template.js";

/**
 * Model selection from the session's last committed request header, or
 * undefined (provider/model resolved by the request waterfall). Mirrors
 * dsh-proactive's selectionFromHeader.
 */
function selectionFromHeader(header) {
  const config = header?.config;
  if (config === undefined || config === null) return undefined;
  if (config.provider === undefined || config.model === undefined) return undefined;
  const selection = { provider: config.provider, model: config.model };
  if (config.reasoningEffort !== undefined) selection.reasoningEffort = config.reasoningEffort;
  return selection;
}

/** Mutable selection ref for a resumed agent: header first, waterfall after. */
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

/**
 * Compose a cold-resumed agent: model selection + best-effort preset join.
 * 每一步独立 try/catch——组合失败只降级（工具可能缺失），绝不阻止唤醒。
 */
async function composeAgent(agentCtx, agent, getPresets) {
  try {
    installModelSelection(agentCtx, makeSelectionRef(agent));
  } catch {
    /* 选择安装失败：交给请求瀑布流 */
  }
  const presets = typeof getPresets === "function" ? getPresets() : undefined;
  if (presets === undefined || presets === null) return;
  try {
    const presetId = agent.session?.header?.agentPreset ?? presets.defaultId;
    if (typeof presets.mount === "function") {
      await presets.mount(agentCtx, presetId);
    }
  } catch {
    /* 预设挂载失败：保持宿主平面工具集 */
  }
}

/**
 * Create the waker.
 * @param deps.getAgents - `() => agents service | undefined`.
 * @param deps.getPresets - `() => agentPresets | undefined`（可选服务）.
 * @param deps.record - `(entry) => Promise<void>`，写触发历史.
 * @returns `{ wake }`.
 */
export function createWaker({ getAgents, getPresets, record }) {
  /** Rule ids with a wake currently in flight. */
  const inflight = new Set();

  /**
   * Wake one rule's target session with the rendered prompt.
   * @param rule - normalized rule.
   * @param vars - flat template variables (source/ruleId set by callers).
   * @returns `{ outcome: "ok" | "busy" | "failed", detail? }`.
   */
  async function wake(rule, vars) {
    if (inflight.has(rule.id)) {
      await record({ ruleId: rule.id, source: vars.source, outcome: "busy-skipped", detail: "上一触发尚未完成，本次事件已丢弃" });
      return { outcome: "busy" };
    }
    inflight.add(rule.id);
    let handle = null;
    try {
      const agents = getAgents();
      if (agents === undefined || agents === null) {
        await record({ ruleId: rule.id, source: vars.source, outcome: "failed", detail: "agents 服务不可用（宿主未就绪或非宿主组合）" });
        return { outcome: "failed" };
      }
      const text = renderTemplate(rule.promptTemplate, { ...vars, ruleId: rule.id });
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
          setup: (agentCtx, resumed) => composeAgent(agentCtx, resumed, getPresets),
        });
        agent = handle.agent;
        presence = "cold";
      }

      let claimed = false;
      try {
        claimed = await agent.runMaintenance(() => {
          agent.followup(message);
          return Promise.resolve(true);
        });
      } catch {
        claimed = false;
      }
      if (!claimed) {
        await record({ ruleId: rule.id, source: vars.source, outcome: "busy", detail: "目标会话正忙，本次事件已丢弃" });
        return { outcome: "busy" };
      }
      await agent.whenIdle();
      await record({
        ruleId: rule.id,
        source: vars.source,
        outcome: "ok",
        detail: `已投递并完成（${presence} 会话 ${rule.targetSessionId}）`,
      });
      return { outcome: "ok" };
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 300);
      await record({ ruleId: rule.id, source: vars.source, outcome: "failed", detail });
      return { outcome: "failed", detail };
    } finally {
      inflight.delete(rule.id);
      if (handle !== null) {
        try {
          await handle.dispose();
        } catch {
          /* dispose 尽力而为 */
        }
      }
    }
  }

  return { wake };
}
