/**
 * dsh-event-gate — webhook 事件源。
 *
 * 所有规则共享固定路由，按 body/查询里的 rule 字段分发。
 * token 仅接受 body.token / x-event-gate-token，禁止放在 URL 查询参数中。
 * HTTP 202 只表示事件已进入内存队列；队列满或宿主不可用会明确失败。
 */

import { gateRequest, readBody, respond } from "./http.js";

const BODY_CAP = 1_000_000;

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
    const result = await readBody(req, BODY_CAP);
    if (!result.ok) {
      const status = result.reason === "body-too-large" ? 413 : result.reason === "timeout" ? 408 : 400;
      respond(res, status, { ok: false, reason: result.reason });
      return;
    }
    let body;
    try {
      body = result.text.length > 0 ? JSON.parse(result.text) : {};
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
    const token = typeof body.token === "string" ? body.token : req.headers["x-event-gate-token"];
    const rule = typeof ruleId === "string" ? resolveRule(ruleId) : undefined;
    if (rule === undefined || rule.source !== "webhook" || rule.enabled === false) {
      respond(res, 404, { ok: false, reason: "unknown-or-disabled-rule" });
      return;
    }
    if (typeof token !== "string" || token !== rule.token) {
      respond(res, 401, { ok: false, reason: "bad-token" });
      return;
    }

    const { token: _token, rule: _rule, ...payload } = body;
    try {
      const acceptance = await onEvent(rule, payload);
      if (acceptance?.accepted === false) {
        const status = acceptance.reason === "queue-full" ? 429 : 503;
        respond(res, status, { ok: false, rule: rule.id, accepted: false, reason: acceptance.reason });
        return;
      }
      respond(res, 202, { ok: true, rule: rule.id, accepted: true, status: acceptance?.status ?? "queued" });
    } catch {
      respond(res, 503, { ok: false, rule: rule.id, accepted: false, reason: "enqueue-failed" });
    }
  };
}
