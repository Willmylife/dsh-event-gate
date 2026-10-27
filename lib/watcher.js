/**
 * dsh-event-gate — fs 事件源：每条 fs 规则一个递归 fs.watch，按规则防抖。
 *
 * 防抖语义：同一规则在 debounceMs 窗口内的所有事件合并为一次触发，
 * prompt 模板里的 {{paths}} 是合并后的文件列表，{{count}} 是数量。
 * filename 为 null 的事件（部分编辑器会这样报告）记为 "(unknown file)"。
 */

import { watch } from "node:fs";
import { matchesFilter } from "./globmini.js";

/**
 * Create the fs event-source manager.
 * @param opts.log - `(message) => void`，装载失败时的记录出口。
 * @returns `{ applyRules, activeCount, closeAll }`.
 */
export function createWatcherManager({ log }) {
  /** ruleId → { close() } */
  const watchers = new Map();

  /**
   * Reconcile watchers against the current rule set: close removed/disabled,
   * open new. Existing watchers are left untouched (their rule object may
   * still be stale for debounce/filter until restart — documented limitation).
   * @param rules - normalized rules from the store.
   * @param onFire - `(rule, items: string[])` called once per debounced burst.
   */
  function applyRules(rules, onFire) {
    const wanted = new Set(
      rules.filter((rule) => rule.enabled && rule.source === "fs").map((rule) => rule.id),
    );
    for (const [id, entry] of watchers) {
      if (!wanted.has(id)) {
        try {
          entry.close();
        } catch {
          /* watcher already gone */
        }
        watchers.delete(id);
      }
    }
    for (const rule of rules) {
      if (!wanted.has(rule.id) || watchers.has(rule.id)) continue;
      openWatcher(rule, onFire);
    }
  }

  function openWatcher(rule, onFire) {
    let pending = new Set();
    let timer = null;
    try {
      const watcher = watch(
        rule.watch,
        { recursive: true },
        (eventKind, filename) => {
          const label = typeof filename === "string" && filename.length > 0 ? filename : "(unknown file)";
          if (!matchesFilter(rule.filter, label)) return;
          pending.add(`${eventKind} ${label}`);
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => {
            const items = [...pending];
            pending = new Set();
            timer = null;
            try {
              onFire(rule, items);
            } catch (error) {
              log(`规则 ${rule.id} 触发失败：${String(error?.message ?? error)}`);
            }
          }, rule.debounceMs ?? 2000);
        },
      );
      watcher.on("error", (error) => {
        log(`规则 ${rule.id} 的目录监视出错：${String(error?.message ?? error)}`);
      });
      watchers.set(rule.id, {
        close() {
          if (timer !== null) clearTimeout(timer);
          watcher.close();
        },
      });
    } catch (error) {
      log(`规则 ${rule.id} 无法监视目录 ${rule.watch}：${String(error?.message ?? error)}`);
    }
  }

  /** Number of currently open watchers. */
  function activeCount() {
    return watchers.size;
  }

  /** Close everything (host shutdown). */
  function closeAll() {
    for (const entry of watchers.values()) {
      try {
        entry.close();
      } catch {
        /* already closed */
      }
    }
    watchers.clear();
  }

  return { applyRules, activeCount, closeAll };
}
