/**
 * dsh-event-gate — fs 事件源：每条 fs 规则一个递归 fs.watch，按规则防抖。
 *
 * 同一规则在 debounceMs 窗口内合并事件；maxWaitMs 防止持续写入无限推迟。
 * 同 ID 规则的任何有效配置变化都会重建 watcher，避免热更新沿用旧闭包。
 */

import { watch } from "node:fs";
import { globToRegExp, matchesFilter } from "./globmini.js";

function watcherSignature(rule) {
  return JSON.stringify([
    rule.watch,
    rule.filter ?? null,
    rule.debounceMs,
    rule.maxWaitMs,
    rule.targetSessionId,
    rule.promptTemplate,
  ]);
}

/**
 * Create the fs event-source manager.
 * watchImpl/maxPending are injectable for deterministic unit tests.
 */
export function createWatcherManager({ log, watchImpl = watch, maxPending = 1000 }) {
  /** ruleId → { signature, close() } */
  const watchers = new Map();

  /** Reconcile watchers against the current rule set. */
  function applyRules(rules, onFire) {
    const wanted = new Map(
      rules.filter((rule) => rule.enabled && rule.source === "fs").map((rule) => [rule.id, rule]),
    );
    for (const [id, entry] of watchers) {
      const rule = wanted.get(id);
      if (rule === undefined || entry.signature !== watcherSignature(rule)) {
        entry.close();
        watchers.delete(id);
      }
    }
    for (const rule of wanted.values()) {
      if (!watchers.has(rule.id)) openWatcher(rule, onFire);
    }
  }

  function openWatcher(rule, onFire) {
    const filter = rule.filter === undefined ? undefined : globToRegExp(rule.filter);
    if (filter === null) {
      log(`规则 ${rule.id} 的 glob 无法编译，已停止监视`);
      return;
    }
    let pending = new Set();
    let overflow = 0;
    let debounceTimer = null;
    let maxTimer = null;
    let closed = false;

    function clearTimers() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (maxTimer !== null) clearTimeout(maxTimer);
      debounceTimer = null;
      maxTimer = null;
    }

    function flush() {
      if (closed) return;
      clearTimers();
      const items = [...pending];
      const omitted = overflow;
      pending = new Set();
      overflow = 0;
      if (items.length === 0 && omitted === 0) return;
      try {
        onFire(rule, items, { total: items.length + omitted, omitted });
      } catch (error) {
        log(`规则 ${rule.id} 触发失败：${String(error?.message ?? error)}`);
      }
    }

    try {
      const watcher = watchImpl(
        rule.watch,
        { recursive: true },
        (eventKind, filename) => {
          if (closed) return;
          const label = typeof filename === "string" && filename.length > 0 ? filename : "(unknown file)";
          if (!matchesFilter(rule.filter, label, filter)) return;
          const item = `${eventKind} ${label}`;
          if (pending.has(item)) {
            // Duplicate native events do not increase the bounded set.
          } else if (pending.size < maxPending) {
            pending.add(item);
          } else {
            overflow += 1;
          }
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(flush, rule.debounceMs ?? 2000);
          if (maxTimer === null) maxTimer = setTimeout(flush, rule.maxWaitMs ?? 30000);
        },
      );
      const entry = {
        signature: watcherSignature(rule),
        close() {
          if (closed) return;
          closed = true;
          clearTimers();
          pending = new Set();
          overflow = 0;
          try {
            watcher.close();
          } catch {
            // The native watcher may already be closed after an error.
          }
        },
      };
      watcher.on("error", (error) => {
        if (watchers.get(rule.id) === entry) watchers.delete(rule.id);
        entry.close();
        log(`规则 ${rule.id} 的目录监视出错：${String(error?.message ?? error)}`);
      });
      watchers.set(rule.id, entry);
    } catch (error) {
      log(`规则 ${rule.id} 无法监视目录 ${rule.watch}：${String(error?.message ?? error)}`);
    }
  }

  function activeCount() {
    return watchers.size;
  }

  function closeAll() {
    for (const entry of watchers.values()) entry.close();
    watchers.clear();
  }

  return { applyRules, activeCount, closeAll };
}
