/**
 * dsh-event-gate — HTTP 小工具：JSON 响应、回环门禁、有界请求体读取。
 */

/** Strip IPv6 brackets and lowercase a hostname (not a Host header with port). */
export function bareHostname(value) {
  return String(value).toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

/** Whether the hostname names the loopback interface. */
export function isLoopback(value) {
  const text = bareHostname(value);
  if (text === "localhost" || text === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(text);
}

/** Parse a Host header without confusing IPv6 colons with a port separator. */
export function hostnameFromHost(value) {
  const text = String(value ?? "").trim();
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed !== null) {
    if (bracketed[2] !== undefined && Number(bracketed[2]) > 65535) return "";
    return bracketed[1];
  }
  if (text.includes("[") || text.includes("]")) return "";
  const colons = text.match(/:/g)?.length ?? 0;
  if (colons === 0) return text;
  if (colons !== 1) return "";
  const [hostname, port] = text.split(":");
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return "";
  return hostname;
}

/** Require both the peer and Host header to name a loopback interface. */
export function gateRequest(req) {
  const remote = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
  if (!isLoopback(remote)) return "bad-remote";
  const host = req.headers.host;
  if (typeof host === "string" && host.length > 0 && !isLoopback(hostnameFromHost(host))) {
    return "bad-host";
  }
  return null;
}

/** Write a JSON response; the route handler owns the whole lifecycle. */
export function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Read one request body without ever exceeding the configured buffer cap.
 * Over-length requests are drained instead of destroying the socket before the
 * handler can send its 413 response. A timeout bounds slow or stalled clients.
 *
 * @returns `{ ok: true, text }` or `{ ok: false, reason }`.
 */
export function readBody(req, cap, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }, true), timeoutMs);

    function finish(result, drain = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) req.resume();
      resolve(result);
    }

    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > cap) {
        chunks = [];
        finish({ ok: false, reason: "body-too-large" }, true);
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("aborted", () => finish({ ok: false, reason: "request-aborted" }));
    req.on("error", () => finish({ ok: false, reason: "read-error" }));
  });
}
