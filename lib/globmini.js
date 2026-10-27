/**
 * dsh-event-gate — 极简 glob → RegExp（无依赖）。
 * 支持 `**`（跨目录）、`*`（单段内任意）、`?`（单字符）；其余字符按字面
 * 匹配。Windows 路径分隔符先归一为 `/`。大小写不敏感（Windows 文件系统）。
 */

/**
 * Compile a glob pattern into a RegExp.
 * @param pattern - glob 字符串：双星匹配跨目录（如匹配任意层级的 pdf），
 *   单星限单段（如 "report-*.csv"）。
 * @returns case-insensitive RegExp, or `null` for an unusable pattern.
 */
export function globToRegExp(pattern) {
  if (typeof pattern !== "string" || pattern.trim().length === 0) return null;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // 吞掉连续的 `**`（以及其后紧跟的 `/`），匹配跨段任意
        while (pattern[index] === "*") index += 1;
        if (pattern[index] === "/") index += 1;
        source += ".*";
        index -= 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "i");
  } catch {
    return null;
  }
}

/**
 * Whether a reported path passes the rule's filter (empty/absent = match all).
 * @param filter - glob string or undefined.
 * @param reportedPath - filename as reported by the event source.
 * @returns whether the path matches.
 */
export function matchesFilter(filter, reportedPath) {
  if (filter === undefined || filter === null) return true;
  const normalized = String(reportedPath ?? "").replace(/\\/g, "/");
  const re = globToRegExp(filter);
  if (re === null) return true;
  return re.test(normalized) || re.test(normalized.split("/").pop() ?? "");
}
