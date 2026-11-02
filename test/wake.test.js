import test from "node:test";
import assert from "node:assert/strict";
import { createWaker } from "../lib/wake.js";

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function messageFactory(value) {
  return value;
}

function makeWaker({ agents, records = [], ...options }) {
  return createWaker({
    getAgents: () => agents,
    getPresets: () => undefined,
    record: async (entry) => { records.push(entry); },
    installModelSelection: () => {},
    createUserMessage: messageFactory,
    ...options,
  });
}

function webhookRule(id, targetSessionId = "session") {
  return {
    id,
    source: "webhook",
    targetSessionId,
    promptTemplate: "{{payload}}",
  };
}

test("two rules targeting one cold session never resume or run concurrently", async () => {
  const releases = [];
  const messages = [];
  let resumeCalls = 0;
  let disposeCalls = 0;
  let active = 0;
  let maxActive = 0;
  const agent = {
    session: { header: {}, requestHeader: () => undefined },
    followup: (message) => messages.push(message),
    runMaintenance: (callback) => callback(),
    whenIdle: () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      releases.push(() => { active -= 1; gate.resolve(); });
      return gate.promise;
    },
  };
  const agents = {
    get: () => undefined,
    resume: async () => {
      resumeCalls += 1;
      return { agent, dispose: async () => { disposeCalls += 1; } };
    },
  };
  const waker = makeWaker({ agents });
  const first = waker.wake(webhookRule("one"), { source: "webhook", payload: "one" });
  const second = waker.wake(webhookRule("two"), { source: "webhook", payload: "two" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumeCalls, 1);
  assert.equal(messages.length, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumeCalls, 2);
  assert.equal(messages.length, 2);
  releases.shift()();
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.outcome), ["ok", "ok"]);
  assert.equal(maxActive, 1);
  assert.equal(disposeCalls, 2);
});

test("fs events arriving during a run coalesce into the next rendered prompt", async () => {
  const releases = [];
  const messages = [];
  const agent = {
    followup: (message) => messages.push(message),
    runMaintenance: (callback) => callback(),
    whenIdle: () => {
      const gate = deferred();
      releases.push(() => gate.resolve());
      return gate.promise;
    },
  };
  const agents = { get: () => agent };
  const records = [];
  const waker = makeWaker({ agents, records });
  const rule = {
    id: "fs",
    source: "fs",
    targetSessionId: "session",
    promptTemplate: "{{count}}|{{paths}}|{{pathsOmitted}}",
  };
  const first = waker.wake(rule, { source: "fs", count: "1", paths: "change a.pdf", omitted: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = waker.wake(rule, { source: "fs", count: "1", paths: "change b.pdf", omitted: "0" });
  const third = waker.wake(rule, { source: "fs", count: "1", paths: "change c.pdf", omitted: "0" });
  assert.equal(records.filter((entry) => entry.outcome === "coalesced").length, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content[0].text, "2|change b.pdf\nchange c.pdf|0");
  releases.shift()();
  assert.deepEqual((await Promise.all([first, second, third])).map((result) => result.outcome), ["ok", "ok", "ok"]);
});

test("busy delivery retries with bounded backoff instead of dropping immediately", async () => {
  let attempts = 0;
  const sleeps = [];
  const agent = {
    followup: () => {},
    runMaintenance: (callback) => {
      attempts += 1;
      if (attempts === 1) throw new Error("busy");
      return callback();
    },
    whenIdle: async () => {},
  };
  const records = [];
  const waker = makeWaker({ agents: { get: () => agent }, records, sleep: async (ms) => { sleeps.push(ms); } });
  const result = await waker.wake(webhookRule("hook"), { source: "webhook", payload: "event" });
  assert.equal(result.outcome, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(records.some((entry) => entry.outcome === "busy-retry"), true);
});

test("per-session queue applies backpressure at its configured bound", async () => {
  const gate = deferred();
  let idleCalls = 0;
  const agent = {
    followup: () => {},
    runMaintenance: (callback) => callback(),
    whenIdle: () => {
      idleCalls += 1;
      return idleCalls === 1 ? gate.promise : Promise.resolve();
    },
  };
  const waker = makeWaker({ agents: { get: () => agent }, maxQueuePerSession: 1 });
  const first = waker.wake(webhookRule("one"), { source: "webhook", payload: "one" });
  assert.equal(waker.enqueue(webhookRule("two"), { source: "webhook", payload: "two" }).accepted, true);
  const rejected = waker.enqueue(webhookRule("three"), { source: "webhook", payload: "three" });
  assert.deepEqual(rejected, { accepted: false, reason: "queue-full" });
  gate.resolve();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  waker.close();
});
