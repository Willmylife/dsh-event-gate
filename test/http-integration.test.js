import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createHookHandler } from "../lib/hook.js";

function post(port, body, token = "super-secret-token") {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/__dsh-event-gate/hook",
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-event-gate-token": token,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("real HTTP requests receive queue acceptance and an intact over-length response", async (t) => {
  const rule = {
    id: "ci",
    source: "webhook",
    enabled: true,
    token: "super-secret-token",
    targetSessionId: "session",
    promptTemplate: "{{payload}}",
  };
  const handler = createHookHandler({
    resolveRule: () => rule,
    onEvent: () => ({ accepted: true, status: "queued" }),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const accepted = await post(address.port, JSON.stringify({ rule: "ci", message: "ok" }));
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.accepted, true);

  const tooLarge = await post(address.port, JSON.stringify({ rule: "ci", message: "x".repeat(1_000_100) }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.reason, "body-too-large");
});
