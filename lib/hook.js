/**
 * dsh-event-gate — webhook 事件源。
 *
 * 设计：所有 webhook 规则共享一条固定路由 /__dsh-event-gate/hook，
 * 按 body/查询里的 rule 字段分发——避免动态注册/注销路由的生命周期问题。
 *
 * 安全（MVP 就位，不可协商）：
 * - 回环门禁（同 dsh-notify-me 的 gateRequest）；
 * - 每条 webhook 规则必须配置 >=8 字符 token，装载期强制；
 * - token 通过 body.token / x-event-gate-token 头 / ?token= 传入，
 *   **绝不**进入传给会话的 payload（防止密钥泄漏进对话上下文）。
 */

import { gateRequest, readBody, respond } from "./http.js";

/** Maximum accepted webhook body: 1 MiB. */
const BODY_CAP = 1_000_000;

/**
 * Create the shared webhook route handler.
 * @param deps.resolveRule - `(id) => normalized rule | undefined`.
 * @param deps.onEvent - `(rule, payload) => void`，payload 已剥离 token/rule.
 * @returns the route handler.
 */
export function createHookHandler({ resolveRule, onEvent }) {
  return async function handleHook(req, res) {
    if (req.method !== "POST") {
      respond(res, 405, { ok: false, reason: "method-not-allowed（POST only）" });
      return;
    }
    const refusal = gateRequest(req);
    if (refusal !== null) {
      respond(res, 403, { ok: false, reason: refusal });
      return;
    }
    const raw = await readBody(req, BODY_CAP);
    if (raw === null) {
      respond(res, 413, { ok: false, reason: "body-too-large" });
      return;
    }
    let body;
    try {
      body = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      respond(res, 400, { ok: false, reason: "invalid-json" });
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      respond(res, 400, { ok: false, reason: "body 必须是 JSON 对象" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ruleId = typeof body.rule === "string" ? body.rule : url.searchParams.get("rule");
    const token =
      typeof body.token === "string"
        ? body.token
        : (req.headers["x-event-gate-token"] ?? url.searchParams.get("token"));

    const rule = typeof ruleId === "string" ? resolveRule(ruleId) : undefined;
    if (rule === undefined || rule.source !== "webhook" || rule.enabled === false) {
      respond(res, 404, { ok: false, reason: "unknown-or-disabled-rule" });
      return;
    }
    if (typeof token !== "string" || token !== rule.token) {
      respond(res, 401, { ok: false, reason: "bad-token" });
      return;
    }

    // 剥离 token 与 rule，其余整体作为 payload；{{payload}} 是压缩 JSON。
    const { token: _token, rule: _rule, ...payload } = body;
    respond(res, 202, { ok: true, rule: rule.id, accepted: true });
    try {
      onEvent(rule, payload);
    } catch {
      /* onEvent 自行记录历史 */
    }
  };
}
