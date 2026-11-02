// Single-process entry: works in restricted environments where node:test cannot
// spawn one child process per file, and remains compatible with Node 22.5.
import "./globmini.test.js";
import "./hook.test.js";
import "./http.test.js";
import "./http-integration.test.js";
import "./store.test.js";
import "./wake.test.js";
import "./watcher.test.js";
