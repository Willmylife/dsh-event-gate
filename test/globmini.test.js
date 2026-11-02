import test from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesFilter } from "../lib/globmini.js";

test("glob supports recursive paths and single-segment stars", () => {
  assert.equal(matchesFilter("**/*.pdf", "root.pdf"), true);
  assert.equal(matchesFilter("**/*.pdf", "nested\\report.PDF"), true);
  assert.equal(matchesFilter("src/*.js", "src/main.js"), true);
  assert.equal(matchesFilter("src/*.js", "src/nested/main.js"), false);
  assert.equal(matchesFilter("report-*.csv", "nested/report-01.csv"), true);
});

test("glob escapes regexp punctuation and fails closed when invalid", () => {
  assert.equal(matchesFilter("a+b?.txt", "a+b1.txt"), true);
  assert.equal(matchesFilter("a+b?.txt", "aa+b1.txt"), false);
  assert.equal(globToRegExp(""), null);
  assert.equal(matchesFilter("", "anything.txt"), false);
});
