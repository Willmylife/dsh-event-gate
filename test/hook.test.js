import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHookHandler } from "../lib/hook.js";

const rule = {
  id: "ci",
  source: "webhook",
  enabled: true,
  token: "super-secret-token",
  targetSessionId: "session",
  promptTemplate: "{{payload}}",
};

function makeRequest({ body = "{}", url = "/hook", token } = {}) {
  const req = new EventEmitter();
  req.method = "POST";
  req.url = url;
  req.socket = { remoteAddress: "127.0.0.1" };
  req.headers = { host: "127.0.0.1" };
  if (token !== undefined) req.headers["x-event-gate-token"] = token;
  req.resume = () => {};
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeResponse() {
  return {
    status: null,
    payload: null,
    writeHead(status) { this.status = status; },
    end(payload) { this.payload = JSON.parse(payload); },
  };
}

test("valid webhook strips credentials and returns queue acceptance", async () => {
  let received;
  const handler = createHookHandler({
    resolveRule: () => rule,
    onEvent: (_rule, payload) => {
      received = payload;
      return { accepted: true, status: "queued" };
    },
  });
  const res = makeResponse();
  await handler(makeRequest({ body: JSON.stringify({ rule: "ci", token: rule.token, message: "failed" }) }), res);
  assert.equal(res.status, 202);
  assert.deepEqual(received, { message: "failed" });
  assert.equal(JSON.stringify(received).includes(rule.token), false);
});

test("query-string token is rejected", async () => {
  let calls = 0;
  const handler = createHookHandler({ resolveRule: () => rule, onEvent: () => { calls += 1; } });
  const res = makeResponse();
  await handler(makeRequest({ url: `/hook?rule=ci&token=${encodeURIComponent(rule.token)}` }), res);
  assert.equal(res.status, 401);
  assert.equal(calls, 0);
});

test("queue backpressure becomes HTTP 429 instead of false acceptance", async () => {
  const handler = createHookHandler({
    resolveRule: () => rule,
    onEvent: () => ({ accepted: false, reason: "queue-full" }),
  });
  const res = makeResponse();
  await handler(makeRequest({ body: JSON.stringify({ rule: "ci", message: "failed" }), token: rule.token }), res);
  assert.equal(res.status, 429);
  assert.equal(res.payload.accepted, false);
});
