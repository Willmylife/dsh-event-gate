import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appendHistory,
  historyStatus,
  normalizeRule,
  readHistory,
  sanitizeRule,
} from "../lib/store.js";

test("rule validation rejects invalid filters and tool DTOs redact tokens", () => {
  const invalid = normalizeRule({
    id: "fs",
    source: "fs",
    watch: process.cwd(),
    filter: "",
    targetSessionId: "session",
    promptTemplate: "{{paths}}",
  });
  assert.match(invalid.error, /filter/);

  const { rule, error } = normalizeRule({
    id: "hook",
    source: "webhook",
    token: "super-secret-token",
    targetSessionId: "session",
    promptTemplate: "{{payload}}",
  });
  assert.equal(error, undefined);
  const safe = sanitizeRule(rule);
  assert.equal(safe.token, undefined);
  assert.equal(safe.tokenConfigured, true);
  assert.equal(JSON.stringify(safe).includes("super-secret-token"), false);
});

test("concurrent history appends preserve complete entries across trim and later writes", async () => {
  const root = await mkdtemp(join(process.cwd(), ".event-gate-store-test-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    await Promise.all(Array.from({ length: 650 }, (_, index) => appendHistory({
      ruleId: `rule-${index}`,
      source: "test",
      outcome: "ok",
    })));
    const result = await readHistory(600);
    assert.equal(result.total, 550);
    assert.equal(result.events.length, 550);
    assert.equal(result.events[0].ruleId, "rule-649");
    assert.equal(result.events.at(-1).ruleId, "rule-100");
    assert.equal(new Set(result.events.map((event) => event.ruleId)).size, 550);
    assert.equal(result.note, null);
    assert.equal(historyStatus().lastError, null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
