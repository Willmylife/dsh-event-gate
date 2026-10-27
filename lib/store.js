/**
 * dsh-event-gate — 数据与规则存储。
 *
 * 数据放在 $DSH_HOME（默认 ~/.dsh）/event-gate 下，与 dsh-proactive 的
 * $DSH_HOME/proactive 同一约定。规则 rules.json（JSON 数组），触发历史
 * history.jsonl（JSONL 追加，超量裁剪）。所有读取失败都降级为空态 + 说明，
 * 绝不向上抛——可观测性工具必须永远能回答。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Absolute DSH home (mirrors @deepseek-ai/dsh-home-paths). */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return join(homedir(), ".dsh");
}

/** Absolute path of the plugin data directory. */
export function eventGateDir() {
  return join(dshHome(), "event-gate");
}

/** Absolute path of the rules file (JSON array). */
export function rulesPath() {
  return join(eventGateDir(), "rules.json");
}

/** Absolute path of the trigger history file (JSONL). */
export function historyPath() {
  return join(eventGateDir(), "history.jsonl");
}

/** Create the data directory; caller decides whether failure is fatal. */
export async function ensureDir() {
  await mkdir(eventGateDir(), { recursive: true });
}

/**
 * Normalize and validate one raw rule object.
 * @returns `{ rule }` on success or `{ error }` with a human-readable reason.
 */
export function normalizeRule(raw, index) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "不是对象" };
  }
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    return { error: "缺少 id（非空字符串）" };
  }
  if (raw.source !== "fs" && raw.source !== "webhook") {
    return { error: 'source 必须是 "fs" 或 "webhook"' };
  }
  if (typeof raw.targetSessionId !== "string" || raw.targetSessionId.trim().length === 0) {
    return { error: "缺少 targetSessionId（要唤醒的会话 id）" };
  }
  if (typeof raw.promptTemplate !== "string" || raw.promptTemplate.trim().length === 0) {
    return { error: "缺少 promptTemplate（注入会话的 prompt 模板）" };
  }
  const rule = {
    id: raw.id.trim(),
    source: raw.source,
    enabled: raw.enabled !== false,
    targetSessionId: raw.targetSessionId.trim(),
    promptTemplate: raw.promptTemplate,
  };
  if (raw.source === "fs") {
    if (typeof raw.watch !== "string" || raw.watch.trim().length === 0) {
      return { error: "fs 规则缺少 watch（要监视的目录绝对路径）" };
    }
    rule.watch = raw.watch.trim();
    if (raw.filter !== undefined) {
      if (typeof raw.filter !== "string") return { error: "filter 必须是 glob 字符串" };
      rule.filter = raw.filter;
    }
    const debounce = Number(raw.debounceMs);
    rule.debounceMs = Number.isFinite(debounce) ? Math.min(Math.max(Math.floor(debounce), 100), 60000) : 2000;
  } else {
    if (typeof raw.token !== "string" || raw.token.length < 8) {
      return { error: "webhook 规则缺少 token 或 token 短于 8 字符（防本机任意进程指挥 agent）" };
    }
    rule.token = raw.token;
  }
  return { rule };
}

/**
 * Load, normalize and validate the rules file.
 * @returns `{ rules, errors }` — valid rules plus per-index error strings.
 */
export async function loadRules() {
  const path = rulesPath();
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { rules: [], errors: [], note: `规则文件尚未创建：${path}` };
    }
    return { rules: [], errors: [`规则文件读取失败：${String(error?.message ?? error)}`], note: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rules: [], errors: ["规则文件不是有效 JSON"], note: null };
  }
  if (!Array.isArray(parsed)) {
    return { rules: [], errors: ["规则文件顶层必须是 JSON 数组"], note: null };
  }
  const rules = [];
  const errors = [];
  const seen = new Set();
  for (let index = 0; index < parsed.length; index += 1) {
    const { rule, error } = normalizeRule(parsed[index], index);
    if (error !== undefined) {
      errors.push(`第 ${index + 1} 条（${typeof parsed[index]?.id === "string" ? parsed[index].id : "未命名"}）：${error}`);
      continue;
    }
    if (seen.has(rule.id)) {
      errors.push(`第 ${index + 1} 条：id "${rule.id}" 重复，已忽略`);
      continue;
    }
    seen.add(rule.id);
    rules.push(rule);
  }
  return { rules, errors, note: null };
}

/** History file size cap: rewrite keeps the newest entries. */
const HISTORY_KEEP = 500;
const HISTORY_TRIM_AT = 600;

/**
 * Append one entry to the JSONL history, adding a timestamp. Best-effort:
 * failures resolve normally (the trigger must not crash because history broke).
 * @param entry - plain object without `at`; timestamp is added here.
 */
export async function appendHistory(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  try {
    await ensureDir();
    await appendFile(historyPath(), line + "\n", "utf8");
    await trimHistory();
  } catch {
    /* 历史失败不反噬触发主链路 */
  }
}

/** Rewrite the history file keeping only the newest entries when oversized. */
async function trimHistory() {
  const path = historyPath();
  const raw = await readFile(path, "utf8").catch(() => "");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < HISTORY_TRIM_AT) return;
  await writeFile(path, lines.slice(-HISTORY_KEEP).join("\n") + "\n", "utf8");
}

/**
 * Read the history file (used by the trigger_history tool).
 * @param limit - maximum entries, newest first.
 * @returns `{ path, events, total, note }`.
 */
export async function readHistory(limit) {
  const path = historyPath();
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path, events: [], total: 0, note: "尚无触发记录（插件还没触发过任何规则）" };
    }
    return { path, events: [], total: 0, note: `历史文件读取失败：${String(error?.message ?? error)}` };
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const events = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  const newestFirst = events.slice(-limit).reverse();
  return {
    path,
    events: newestFirst,
    total: events.length,
    note: malformed > 0 ? `${malformed} 行无法解析，已跳过` : null,
  };
}
