import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWatcherManager } from "../lib/watcher.js";

function fakeNativeWatcher() {
  const active = new Map();
  return {
    active,
    watchImpl(path, _options, callback) {
      const emitter = new EventEmitter();
      emitter.closed = false;
      emitter.close = () => { emitter.closed = true; };
      active.set(path, { emitter, callback });
      return emitter;
    },
    emit(path, filename, kind = "change") {
      active.get(path)?.callback(kind, filename);
    },
  };
}

function fsRule(watch, overrides = {}) {
  return {
    id: "fs-rule",
    source: "fs",
    enabled: true,
    watch,
    filter: "**/*.pdf",
    debounceMs: 20,
    maxWaitMs: 100,
    targetSessionId: "session",
    promptTemplate: "old",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

test("same-id rule updates close the old watcher and use the new rule", async () => {
  const native = fakeNativeWatcher();
  const first = deferred();
  const second = deferred();
  const manager = createWatcherManager({ log: () => {}, watchImpl: native.watchImpl });
  manager.applyRules([fsRule("/a")], (_rule, items) => first.resolve(items));
  native.emit("/a", "a.pdf");
  assert.deepEqual(await first.promise, ["change a.pdf"]);

  manager.applyRules([fsRule("/b", { promptTemplate: "new" })], (rule, items) => second.resolve({ rule, items }));
  assert.equal(native.active.get("/a").emitter.closed, true);
  native.emit("/a", "ignored.pdf");
  native.emit("/b", "b.pdf");
  const fired = await second.promise;
  assert.equal(fired.rule.promptTemplate, "new");
  assert.deepEqual(fired.items, ["change b.pdf"]);
  manager.closeAll();
});

test("maxWait flushes a continuously refreshed debounce window", async () => {
  const native = fakeNativeWatcher();
  const fired = deferred();
  const manager = createWatcherManager({ log: () => {}, watchImpl: native.watchImpl });
  manager.applyRules([fsRule("/a", { debounceMs: 40, maxWaitMs: 70 })], (_rule, items) => fired.resolve(items));
  native.emit("/a", "a.pdf");
  const interval = setInterval(() => native.emit("/a", `${Date.now()}.pdf`), 20);
  const items = await fired.promise;
  clearInterval(interval);
  assert.ok(items.length >= 1);
  manager.closeAll();
});

test("watcher errors are logged and remove stale active entries", () => {
  const native = fakeNativeWatcher();
  const messages = [];
  const manager = createWatcherManager({ log: (message) => messages.push(message), watchImpl: native.watchImpl });
  manager.applyRules([fsRule("/a")], () => {});
  assert.equal(manager.activeCount(), 1);
  native.active.get("/a").emitter.emit("error", new Error("gone"));
  assert.equal(manager.activeCount(), 0);
  assert.match(messages[0], /gone/);
  manager.closeAll();
});
