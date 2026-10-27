/**
 * dsh-event-gate — HTTP 小工具：JSON 响应、回环门禁、有界请求体读取。
 * 与 dsh-notify-me 的同名模式一致（生产验证过的形状）。
 */

/** Strip IPv6 brackets and lowercase a hostname. */
export function bareHostname(value) {
  return String(value).toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

/** Whether the hostname names the loopback interface. */
export function isLoopback(value) {
  const text = bareHostname(value);
  if (text === "localhost" || text === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(text);
}

/**
 * Loopback gate for plugin routes: peer must be loopback and, when a Host
 * header is present, it must name loopback too. Blocks DNS-rebinding pages
 * from reaching the route with a forged Host.
 * @param req - the incoming request.
 * @returns a short refusal reason, or `null` when the request may proceed.
 */
export function gateRequest(req) {
  const remote = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
  if (!isLoopback(remote)) return "bad-remote";
  const host = req.headers.host;
  if (typeof host === "string" && host.length > 0 && !isLoopback(host.split(":")[0])) {
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
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Read the request body as UTF-8 text, bounded.
 * @param req - the incoming request.
 * @param cap - maximum accepted byte length; over-length resolves `null`.
 * @returns the body text, or `null` on over-length / read error.
 */
export function readBody(req, cap) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}
