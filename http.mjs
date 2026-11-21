// HTTP and HTTPS requests with a method, headers and a body, a timeout, a size cap and, when
// HTTPS_PROXY or HTTP_PROXY is set (and NO_PROXY does not cover the host), a CONNECT tunnel
// through that proxy. Node's own fetch does not use those variables. Taken from the web kit's
// http.mjs and extended; its private-address guard is gone, because an API on localhost is a main
// use here, and this machine's own addresses never go through a proxy.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import zlib from "node:zlib";

const env = (k) => process.env[k] ?? process.env[k.toLowerCase()] ?? "";
const bare = (host) => host.replace(/^\[|\]$/g, "");
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d+){3}|::1|0\.0\.0\.0)$/i;

/** Whether NO_PROXY covers a host: exact names, .suffixes, *.suffixes and "*". CIDR entries are matched for IPv4 literals. */
export function noProxy(host) {
  const h = bare(host).toLowerCase();
  if (LOOPBACK.test(h)) return true;
  for (const raw of env("NO_PROXY").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const e = raw.replace(/:\d+$/, "");
    if (e === "*") return true;
    if (e.includes("/") && net.isIPv4(h)) {
      const [base, bits] = e.split("/");
      if (net.isIPv4(base)) {
        const n = (ip) => ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
        const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
        if ((n(h) & mask) === (n(base) & mask)) return true;
      }
      continue;
    }
    const suffix = e.replace(/^\*?\./, "");
    if (h === suffix || h.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

export function proxyFor(url) {
  const u = new URL(url);
  if (noProxy(u.hostname)) return null;
  const p = u.protocol === "https:" ? env("HTTPS_PROXY") || env("ALL_PROXY") : env("HTTP_PROXY") || env("ALL_PROXY");
  if (!p) return null;
  try {
    const pu = new URL(p);
    return /^https?:$/.test(pu.protocol) ? pu : null;
  } catch {
    return null;
  }
}

const connectThrough = (proxy, host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const req = (proxy.protocol === "https:" ? https : http).request({ host: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80), method: "CONNECT", path: `${host}:${port}`, headers, timeout: timeoutMs });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`the proxy refused the connection to ${host}: ${res.statusCode} ${res.statusMessage}`), { code: "EPROXY", status: res.statusCode }));
      } else {
        socket.on("error", () => {}); // a tunnel cut after the answer is not an error of the caller's
        resolve(socket);
      }
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out connecting to the proxy"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });

function once(url, { method, timeoutMs, maxBytes, headers, body }) {
  return new Promise(async (resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === "https:";
    const proxy = proxyFor(url);
    const opts = { method, host: bare(u.hostname), port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, headers, timeout: timeoutMs };
    try {
      if (proxy && secure) {
        const socket = await connectThrough(proxy, opts.host, opts.port, timeoutMs);
        opts.createConnection = () => {
          const t = tls.connect({ socket, servername: net.isIP(opts.host) ? undefined : opts.host });
          t.on("error", () => {}); // the request reports it; this keeps a late reset from being unhandled
          return t;
        };
        opts.agent = false;
      } else if (proxy) {
        Object.assign(opts, { host: proxy.hostname, port: proxy.port || 80, path: url, headers: { ...headers, Host: u.host } });
      }
    } catch (e) {
      return reject(e);
    }
    // The whole exchange has one deadline: a server that sends a byte now and then must not hold a cell open.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    const settle = (fn, v) => (clearTimeout(deadline), fn(v));
    const req = (secure ? https : http).request(opts, (res) => {
      const chunks = [];
      let size = 0;
      let cut = false;
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
      const stream = method === "HEAD" ? res : enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : res;
      const done = () => settle(resolve, { status: res.statusCode, statusText: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks), cut });
      stream.on("data", (c) => {
        if (cut) return;
        size += c.length;
        if (size > maxBytes) {
          cut = true;
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          req.destroy();
          done();
        } else chunks.push(c);
      });
      stream.on("end", () => !cut && done());
      stream.on("error", (e) => (chunks.length ? done() : settle(reject, e)));
      res.on("error", (e) => (chunks.length ? done() : settle(reject, e)));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })));
    req.on("error", (e) => settle(reject, e));
    req.end(body ?? undefined);
  });
}

const MEANING = { ENOTFOUND: "the name does not resolve", EAI_AGAIN: "the name does not resolve (DNS did not answer)", ECONNREFUSED: "nothing accepts connections there", ETIMEDOUT: "no answer in time", ECONNRESET: "the connection was cut", EHOSTUNREACH: "no route to the host", ENETUNREACH: "no route to the network", EPIPE: "the connection was cut", CERT_HAS_EXPIRED: "its TLS certificate has expired", DEPTH_ZERO_SELF_SIGNED_CERT: "its TLS certificate is self-signed", SELF_SIGNED_CERT_IN_CHAIN: "its TLS certificate chain holds a self-signed certificate", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its TLS certificate chain does not verify", ERR_TLS_CERT_ALTNAME_INVALID: "its TLS certificate is for another name", EPROXY: "the proxy refused it", EPROTO: "it does not speak TLS on that port (http, not https?)" };

export const sameOrigin = (a, b) => {
  const x = new URL(a);
  const y = new URL(b);
  return x.protocol === y.protocol && x.host === y.host;
};

/**
 * One request. Redirects are followed only for GET and HEAD, up to `redirects` of them, and with
 * `stay: true` only inside the first address's origin (scheme, host and port): a redirect that
 * leaves it comes back as the 3xx answer with `left: <the other origin>`, so headers that hold a
 * credential are never sent anywhere else.
 * Never throws for a network failure: {ok:false, error, code, meaning}. On an answer:
 * {ok, status, statusText, url (final), hops, headers, type, body:Buffer, cut, viaProxy, left?}.
 */
export async function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 30_000, maxBytes = 16 << 20, redirects = 5, stay = false } = {}) {
  const hops = [];
  let current = String(url);
  const m = method.toUpperCase();
  const all = { "User-Agent": "ask-kit-api/0.1 (+https://github.com/temet-ai/ask-kit)", Accept: "application/json, */*;q=0.5", "Accept-Encoding": "gzip, br, deflate", ...headers };
  if (body != null) all["Content-Length"] = Buffer.byteLength(body);
  for (let i = 0; ; i++) {
    const viaProxy = !!proxyFor(current);
    let r;
    try {
      r = await once(current, { method: m, timeoutMs, maxBytes, headers: all, body });
    } catch (e) {
      const code = e.code ?? e.cause?.code ?? "ERROR";
      return { ok: false, url: current, hops, code, error: e.message || code, meaning: MEANING[code] ?? null, viaProxy };
    }
    hops.push({ url: current, status: r.status });
    const loc = r.headers.location;
    let left = null;
    if (r.status >= 300 && r.status < 400 && loc && (m === "GET" || m === "HEAD")) {
      let next = null;
      try {
        next = new URL(loc, current).href;
      } catch {}
      if (next && /^https?:/.test(next)) {
        if (stay && !sameOrigin(next, url)) left = new URL(next).origin;
        else if (i < redirects) {
          current = next;
          continue;
        } else return { ok: false, url: current, hops, code: "EREDIRECTS", error: `more than ${redirects} redirects`, meaning: "a redirect loop or a very long chain", viaProxy };
      }
    }
    const ct = String(r.headers["content-type"] ?? "");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, url: current, hops, headers: r.headers, type: ct.split(";")[0].trim().toLowerCase(), charset: /charset=["']?([\w-]+)/i.exec(ct)?.[1]?.toLowerCase() ?? null, body: r.body, cut: r.cut, viaProxy, ...(left ? { left } : {}) };
  }
}
