import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gateRequest, hostnameFromHost, readBody } from "../lib/http.js";

function requestWithHost(host, remoteAddress = "::1") {
  return { socket: { remoteAddress }, headers: { host } };
}

class FakeRequest extends EventEmitter {
  resumed = false;
  destroyed = false;
  resume() { this.resumed = true; }
  destroy() { this.destroyed = true; }
}

test("loopback gate accepts IPv4, hostname and bracketed IPv6 with ports", () => {
  assert.equal(gateRequest(requestWithHost("127.0.0.1:61703", "127.0.0.1")), null);
  assert.equal(gateRequest(requestWithHost("localhost:61703")), null);
  assert.equal(gateRequest(requestWithHost("[::1]:61703")), null);
  assert.equal(hostnameFromHost("[::1]:61703"), "::1");
  assert.equal(gateRequest(requestWithHost("example.com:61703")), "bad-host");
  assert.equal(gateRequest(requestWithHost("127.0.0.1:99999")), "bad-host");
});

test("body reader returns bounded UTF-8 text", async () => {
  const req = new FakeRequest();
  const pending = readBody(req, 20, 100);
  req.emit("data", Buffer.from("hello"));
  req.emit("end");
  assert.deepEqual(await pending, { ok: true, text: "hello" });
});

test("over-length body drains without destroying the response socket", async () => {
  const req = new FakeRequest();
  const pending = readBody(req, 5, 100);
  req.emit("data", Buffer.from("123456"));
  assert.deepEqual(await pending, { ok: false, reason: "body-too-large" });
  assert.equal(req.resumed, true);
  assert.equal(req.destroyed, false);
});

test("stalled body has a bounded timeout", async () => {
  const req = new FakeRequest();
  assert.deepEqual(await readBody(req, 5, 5), { ok: false, reason: "timeout" });
  assert.equal(req.resumed, true);
});
