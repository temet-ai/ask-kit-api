// One HTTP API for ask-kit, from its OpenAPI (Swagger) document: find an operation, read what it
// takes and returns, call it, and follow its pages. The document stays out of the investigator's
// context: it asks for operations by words and reads one operation at a time.
//
// The rules this module keeps, because what the investigator reads goes to a cloud model and what
// an API answers is text nobody vouched for:
//  - GET, HEAD and OPTIONS always run. POST, PUT, PATCH and DELETE run only when the caller asked
//    for a change (act), except a POST the document marks `x-readonly: true` or API_READ_POSTS names.
//  - The credential is added here and never shown: not in a result, an error, describe or info.
//    Fields of an answer named like a credential are replaced with <redacted>.
//  - Requests go only to the API's own origin (scheme, host and port). A redirect that leaves it
//    is not followed.
import path from "node:path";
import { request, sameOrigin } from "./http.mjs";
import { loadSpec, paramsOf, bodyOf, responsesOf, shape, rank, resolveOp, matchPath, clip, plainUrl, tokens } from "./spec.mjs";

export const REDACTED = "<redacted>";
const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const SECRET_KEY = /pass(word|wd|phrase)|secret(?!ar)|token|api[-_ ]?key|private[-_ ]?key|access[-_ ]?key|credential|^authorization$|^cookie$/i;
const NOT_SECRET = /(next|prev|previous|page|continuation|continue|cursor|sync)[-_ ]?token|token[-_ ]?(type|count|limit|usage|endpoint|url|uri|expir\w*|ttl)|tokens?[-_ ]?(used|remaining|per)/i;
const SECRET_HEADER = /token|key|secret|auth|cookie|session|signature|credential|password/i;
const DULL_HEADER = /^(date|connection|keep-alive|transfer-encoding|content-length|content-encoding|server|vary|via|age|cache-control|pragma|expires|alt-svc|nel|report-to|strict-transport-security|content-security-policy.*|x-frame-options|x-content-type-options|x-xss-protection|referrer-policy|permissions-policy|cross-origin-.*|access-control-.*|x-powered-by|accept-ranges|server-timing|cf-.*|x-cache.*|x-served-by|x-timer|x-github-media-type|x-accepted-.*|github-authentication-token-expiration)$/i;

export const notInThisAsk = (what) => `not in this ask: ${what} changes things, and the caller did not ask for a change (act: true)`;

/**
 * A copy of `value` with every field named like a credential replaced. Numbers, booleans and null
 * stay (a token count is not a token). Returns {value, fields: the names replaced}.
 */
export function redact(value, extra = []) {
  const fields = new Set();
  const swap = (s) => {
    let t = s;
    for (const x of extra) if (x && t.includes(x)) t = t.split(x).join(REDACTED);
    return t;
  };
  const all = (v) => (typeof v === "string" ? REDACTED : Array.isArray(v) ? v.map(all) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, all(x)])) : v);
  const walk = (v, depth) => {
    if (typeof v === "string") return extra.length ? swap(v) : v;
    if (!v || typeof v !== "object" || depth > 60) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && !NOT_SECRET.test(k) && x != null && typeof x !== "number" && typeof x !== "boolean" && !(typeof x === "string" && x === "")) {
        fields.add(k);
        out[k] = all(x);
      } else out[k] = walk(x, depth + 1);
    }
    return out;
  };
  return { value: walk(value, 0), fields: [...fields] };
}

const at = (obj, dotted) => dotted.split(".").reduce((v, k) => (v == null ? undefined : v[k]), obj);

/** One field of an item by a dotted path; a list on the way gives a list of values. */
export function dig(v, dotted) {
  let cur = [v];
  let many = false;
  for (const k of String(dotted).split(".")) {
    const next = [];
    for (const c of cur) {
      if (Array.isArray(c) && !/^\d+$/.test(k)) {
        many = true;
        for (const x of c) if (x != null && x[k] !== undefined) next.push(x[k]);
      } else if (c != null && c[k] !== undefined) next.push(c[k]);
    }
    cur = next;
  }
  return many ? cur : cur[0];
}

const ITEM_KEYS = ["items", "data", "results", "records", "values", "entries", "list", "content", "rows", "objects", "resources", "elements", "nodes", "hits", "value"];

/** The list an answer holds: the answer itself, or its best-known list field. {items, key} or null. */
export function itemsOf(data, depth = 0) {
  if (Array.isArray(data)) return { items: data, key: null };
  if (!data || typeof data !== "object") return null;
  for (const k of ITEM_KEYS) if (Array.isArray(data[k])) return { items: data[k], key: k };
  const lists = Object.entries(data).filter(([, v]) => Array.isArray(v) && (v.length === 0 || (v[0] && typeof v[0] === "object")));
  if (lists.length) {
    const [k, items] = lists.sort((a, b) => b[1].length - a[1].length)[0];
    return { items, key: k };
  }
  if (depth === 0)
    for (const k of ["data", "result", "response", "payload"]) {
      const inner = data[k] && typeof data[k] === "object" ? itemsOf(data[k], 1) : null;
      if (inner) return { items: inner.items, key: `${k}${inner.key ? `.${inner.key}` : ""}` };
    }
  return null;
}

const LINK_PATHS = ["next", "next_url", "nextUrl", "next_page_url", "next_page", "nextPage", "nextLink", "@odata.nextLink", "links.next", "_links.next", "paging.next", "pagination.next", "pagination.next_url", "meta.next", "meta.links.next", "meta.pagination.links.next"];
const CURSORS = [
  [["next_cursor", "nextCursor", "cursor", "meta.next_cursor", "pagination.next_cursor", "paging.next_cursor", "response_metadata.next_cursor", "meta.cursor.next", "paging.cursors.after", "page_info.end_cursor", "pageInfo.endCursor", "cursors.next", "after"], ["cursor", "after", "next_cursor", "page_token", "starting_after", "next"]],
  [["next_page_token", "meta.next_page_token", "pagination.next_page_token"], ["page_token", "pageToken", "next_page_token"]],
  [["nextPageToken"], ["pageToken", "page_token", "nextPageToken"]],
  [["next_token", "nextToken", "NextToken"], ["next_token", "nextToken", "NextToken", "token"]],
  [["continuation_token", "continuationToken", "continuation"], ["continuation_token", "continuationToken", "continuation"]],
];
const SIZE_NAMES = ["per_page", "page_size", "pageSize", "limit", "size", "count", "max_results", "maxResults", "top"];
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const firstNum = (data, paths) => {
  for (const p of paths) {
    const n = num(at(data, p));
    if (n != null) return n;
  }
  return null;
};
const TOTAL_PATHS = ["total", "total_count", "totalCount", "total_items", "totalItems", "totalElements", "total_results", "totalResults", "meta.total", "meta.total_count", "pagination.total", "paging.total", "meta.pagination.total"];

/**
 * Where the next page is, from one answer. {how, url} or {how, query} or null when this is the last
 * page. `declared` holds the operation's query parameter names, `query` what was sent.
 */
export function nextPage({ data, headers, declared, query, count, firstOfPrev }) {
  const link = String(headers?.link ?? "");
  const m = /<([^>]+)>\s*;[^,]*\brel\s*=\s*"?[^",]*\bnext\b/i.exec(link);
  if (m) return { how: "the Link header's rel=next", url: m[1] };
  if (link && /\brel\s*=\s*"?(prev|first|last)/i.test(link)) return null;
  const body = data && typeof data === "object" && !Array.isArray(data) ? data : null;
  if (body) {
    for (const p of LINK_PATHS) {
      let v = at(body, p);
      if (v && typeof v === "object") v = v.href ?? v.url;
      if (typeof v === "string" && /^(https?:\/\/|\/|\?)/.test(v)) return { how: `the answer's \`${p}\` link`, url: v };
    }
    if (body.has_more === false || body.hasMore === false || body.has_next_page === false || at(body, "page_info.has_next_page") === false || at(body, "pageInfo.hasNextPage") === false) return null;
    for (const [paths, names] of CURSORS)
      for (const p of paths) {
        const v = at(body, p);
        if ((typeof v === "string" && v) || typeof v === "number") {
          const name = names.find((n) => declared.has(n)) ?? names.find((n) => n in query) ?? names[0];
          if (String(query[name] ?? "") === String(v)) return null;
          return { how: `a cursor: the answer's \`${p}\` sent as \`${name}\``, query: { [name]: v } };
        }
      }
    if (body.has_more === true && (declared.has("starting_after") || "starting_after" in query)) {
      const list = itemsOf(body)?.items ?? [];
      const last = list[list.length - 1];
      if (last && last.id != null) return { how: "`has_more` with `starting_after` set to the last item's id", query: { starting_after: last.id } };
    }
  }
  const size = (() => {
    for (const n of SIZE_NAMES) if (num(query[n]) != null) return num(query[n]);
    return body ? firstNum(body, ["per_page", "page_size", "pageSize", "limit", "size", "meta.per_page", "pagination.per_page"]) : null;
  })();
  const total = body ? firstNum(body, TOTAL_PATHS) : num(headers?.["x-total-count"]);
  const pageName = ["page", "page_number", "pageNumber", "page[number]", "p"].find((n) => declared.has(n) || n in query);
  const pagesTotal = body ? firstNum(body, ["total_pages", "totalPages", "page_count", "pageCount", "pages", "meta.total_pages", "meta.last_page", "pagination.total_pages", "pagination.pages", "last_page"]) : null;
  if (pageName || (body && num(body.page) != null && pagesTotal != null) || (body && num(body.number) != null && pagesTotal != null)) {
    const name = pageName ?? "page";
    const zero = body && num(body.number) != null && body.page === undefined && pagesTotal != null; // pages counted from 0 (`number`, `totalPages`)
    const current = num(query[name]) ?? (body ? (num(body.page) ?? num(body.number) ?? num(at(body, "meta.current_page")) ?? num(at(body, "pagination.page"))) : null) ?? 1;
    if (count === 0 || (body && body.last === true)) return null;
    if (pagesTotal != null && (zero ? current + 1 >= pagesTotal : current >= pagesTotal)) return null;
    if (pagesTotal == null && size != null && count < size) return null;
    if (pagesTotal == null && firstOfPrev) return null;
    return { how: `a page number: \`${name}\`${size != null ? ` with ${size} a page` : ""}`, query: { [name]: current + 1 } };
  }
  const offName = ["offset", "skip", "start", "from", "startAt", "start_index", "startIndex"].find((n) => declared.has(n) || n in query);
  if (offName) {
    const current = num(query[offName]) ?? (body ? num(body[offName]) : null) ?? 0;
    const next = current + count;
    if (count === 0 || (size != null && count < size) || (total != null && next >= total) || firstOfPrev) return null;
    return { how: `an offset: \`${offName}\` moved on by the items read`, query: { [offName]: next } };
  }
  return null;
}

function parseAuth(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  const m = /^(bearer|basic)$/i.exec(s) ?? /^(header|query|cookie)\s*:\s*([\w.-]+)$/i.exec(s);
  if (!m) throw new Error("API_AUTH must be `bearer`, `basic`, `header:<Name>` or `query:<name>`");
  return { kind: m[1].toLowerCase(), name: m[2] ?? null };
}

const fromScheme = (def) => {
  if (!def || typeof def !== "object") return null;
  const type = String(def.type ?? "").toLowerCase();
  if (type === "http") return { kind: String(def.scheme ?? "bearer").toLowerCase() === "basic" ? "basic" : "bearer", name: null };
  if (type === "basic") return { kind: "basic", name: null };
  if (type === "apikey" && def.name && ["header", "query", "cookie"].includes(def.in)) {
    // Swagger 2.0 has no bearer scheme: an apiKey in the Authorization header carries "Bearer <token>".
    if (def.in === "header" && /^authorization$/i.test(def.name)) return { kind: "bearer", name: null };
    return { kind: def.in, name: String(def.name) };
  }
  if (type === "oauth2" || type === "openidconnect") return { kind: "bearer", name: null };
  return null;
};
const authText = (a) => (a.name ? `${a.kind}:${a.name}` : a.kind);

export function make({ settings = {}, push = () => {}, act = false } = {}) {
  const workdir = path.resolve(settings.WORKDIR || process.cwd());
  const token = String(settings.API_TOKEN ?? "").trim().replace(/^Bearer\s+/i, "");
  const readPosts = String(settings.API_READ_POSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const secrets = [];
  if (token.length > 3) {
    secrets.push(token, encodeURIComponent(token), Buffer.from(token).toString("base64"));
    if (token.includes(":")) secrets.push(token.slice(token.indexOf(":") + 1));
  }
  try {
    const b = settings.API_BASE_URL ? new URL(settings.API_BASE_URL) : null;
    if (b?.password) secrets.push(b.password, decodeURIComponent(b.password));
  } catch {}
  const live = [...new Set(secrets)].filter((s) => s && s.length > 3).sort((a, b) => b.length - a.length);
  const scrub = (text) => {
    let t = String(text ?? "");
    for (const s of live) if (t.includes(s)) t = t.split(s).join(REDACTED);
    return t;
  };
  /** Every function of the global goes through this: an error never carries the credential. */
  const guarded = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      const err = new Error(scrub(e?.message ?? e));
      err.stack = `Error: ${err.message}`;
      throw err;
    }
  };

  const spec = (source) => loadSpec(source ?? settings.API_SPEC, { workdir, push });
  const isReadPost = (op) => {
    if (op.method !== "POST") return false;
    if (op.readOnlyMark) return true;
    return readPosts.some((entry) => {
      const e = entry.replace(/^post\s+/i, "");
      if (!e.startsWith("/")) return e.toLowerCase() === op.id.toLowerCase();
      const re = new RegExp(`^${e.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}/?$`, "i");
      return re.test(op.path);
    });
  };
  const changes = (op) => !READS.has(op.method) && !isReadPost(op);
  const label = (op) => `${op.method} ${op.path}`;

  /** The base address's path with no trailing slash: "" for the root. */
  const prefix = (base) => base.pathname.replace(/\/+$/, "");
  const baseOf = (s) => {
    const raw = String(settings.API_BASE_URL ?? "").trim() || s.servers[0] || "";
    let u = null;
    try {
      u = /^https?:\/\//i.test(raw) ? new URL(raw) : s.isUrl ? new URL(raw || "/", s.src) : null;
    } catch {}
    if (!u) throw new Error(`no address to send requests to: the document's \`servers\` ${raw ? `entry "${clip(raw, 80)}" is not a full URL` : "list is empty"}. Set API_BASE_URL (for example http://127.0.0.1:8080)`);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u;
  };

  /** How the credential is sent for one operation: {kind, name, from} or null when the operation takes none. */
  const authFor = (s, op) => {
    if (op && Array.isArray(op.raw.security) && op.raw.security.length === 0) return null;
    const set = parseAuth(settings.API_AUTH);
    if (set) return { ...set, from: "API_AUTH" };
    const reqs = (op && Array.isArray(op.raw.security) ? op.raw.security : null) ?? (Array.isArray(s.doc.security) ? s.doc.security : []);
    for (const r of reqs)
      for (const name of Object.keys(r ?? {})) {
        const a = fromScheme(s.deref(s.schemes[name]));
        if (a) return { ...a, from: `the document's ${name} scheme` };
      }
    for (const [name, def] of Object.entries(s.schemes)) {
      const a = fromScheme(s.deref(def));
      if (a) return { ...a, from: `the document's ${name} scheme` };
    }
    return { kind: "bearer", name: null, from: "the default" };
  };

  const shownHeaders = (h) => {
    const out = {};
    for (const [k, v] of Object.entries(h ?? {})) {
      if (DULL_HEADER.test(k)) continue;
      const text = [].concat(v).join(", ");
      out[k] = SECRET_HEADER.test(k) && !/^(www-authenticate|x-ratelimit.*|ratelimit.*|x-oauth-scopes|x-accepted-oauth-scopes)$/i.test(k) ? REDACTED : clip(scrub(k === "location" ? text.replace(/([?&][^=&]*(?:token|key|secret|sig|password|auth)[^=&]*=)[^&]*/gi, `$1${REDACTED}`) : text), 400);
    }
    return out;
  };

  const queryString = (query, declared) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        if (declared.get(k)?.explode === false) sp.append(k, v.join(","));
        else for (const x of v) sp.append(k, String(x));
      } else sp.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return sp;
  };

  /**
   * Send one request and return the raw answer (the investigator never gets this one: `tidy` makes
   * what it sees). `target` is a path under the base URL, or a full address inside the API's origin.
   */
  async function send(s, { op, method, target, query = {}, body, bodyType, headers = {}, timeoutMs }) {
    const base = baseOf(s);
    let u;
    if (/^https?:\/\//i.test(target)) {
      u = new URL(target);
      if (!sameOrigin(u, base)) throw new Error(`not allowed: ${u.host} is not this API's address (${base.host}). Requests and the credential go only there; read another address with the web kit`);
    } else u = new URL(`${base.origin}${prefix(base)}${target.startsWith("/") ? "" : "/"}${target}`);
    u.username = "";
    u.password = "";
    const declared = new Map(op ? paramsOf(s, op).filter((p) => p.in === "query").map((p) => [p.name, p]) : []);
    for (const [k, v] of queryString(query, declared)) u.searchParams.append(k, v);
    const shown = scrub(`${u.pathname}${u.search.replace(/([?&][^=&]*(?:token|key|secret|sig|password)[^=&]*=)[^&]*/gi, `$1${REDACTED}`)}`);
    const all = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (v == null) continue;
      if (/^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection)$/i.test(k)) throw new Error(`not allowed: the ${k} header is set by the kit; the credential is sent for you`);
      all[k] = String(v);
    }
    const auth = authFor(s, op);
    if (auth?.name && Object.keys(all).some((k) => k.toLowerCase() === auth.name.toLowerCase())) throw new Error(`not allowed: the ${auth.name} header carries the credential and is set by the kit`);
    let sentAuth = null;
    if (token && auth) {
      if (auth.kind === "bearer") all.Authorization = `Bearer ${token}`;
      else if (auth.kind === "basic") all.Authorization = `Basic ${token.includes(":") ? Buffer.from(token).toString("base64") : token}`;
      else if (auth.kind === "header") all[auth.name] = token;
      else if (auth.kind === "cookie") all.Cookie = `${auth.name}=${token}`;
      else if (auth.kind === "query") u.searchParams.set(auth.name, token);
      sentAuth = authText(auth);
    }
    let payload = null;
    if (body !== undefined && body !== null) {
      const type = bodyType ?? "application/json";
      if (/multipart/i.test(type)) throw new Error(`${op ? label(op) : target} takes a multipart upload, which this kit does not send`);
      if (typeof body === "string") payload = body;
      else if (/x-www-form-urlencoded/i.test(type)) payload = queryString(body, new Map()).toString();
      else payload = JSON.stringify(body);
      if (!Object.keys(all).some((k) => k.toLowerCase() === "content-type")) all["Content-Type"] = typeof body === "string" && !bodyType ? "text/plain" : type;
    }
    const started = Date.now();
    const r = await request(u.href, { method, headers: all, body: payload, timeoutMs: Math.min(Math.max(Number(timeoutMs) || 30_000, 1000), 120_000), stay: true });
    const ms = Date.now() - started;
    push({ kind: "api", detail: clip(`${method} ${shown}`, 200), ms, code: r.status ?? 1, size: r.body?.length ?? 0 });
    const out = { op, method, shown, ms, sentAuth, auth, base, finalUrl: r.url };
    if (r.status == null) return { ...out, ok: false, status: null, error: scrub(r.error), code: r.code, meaning: r.meaning };
    let data = null;
    let note = null;
    const buf = r.body;
    if (buf.length) {
      const jsonType = /json/i.test(r.type);
      const text = buf.toString("utf8");
      if (jsonType || /^\s*[[{]/.test(text.slice(0, 50))) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
          note = r.cut ? "the answer was cut at 16 MB, so it is text, not parsed JSON" : jsonType ? "the answer says it is JSON and does not parse; it is given as text" : null;
        }
      } else if (/^(text\/|application\/(xml|.*\+xml|x-www-form-urlencoded|yaml|x-yaml|javascript|problem))/i.test(r.type) || (!r.type && !buf.subarray(0, 2000).includes(0))) data = text;
      else note = `the answer is ${buf.length} bytes of ${r.type || "an unnamed type"}, not text; it is not shown`;
      if (r.cut && !note) note = "the answer was cut at 16 MB";
    }
    if (r.left) note = `${note ? `${note}; ` : ""}the API redirected to ${r.left}, which is not its own address (${base.host}); the redirect was not followed, so the credential went nowhere else`;
    return { ...out, ok: r.ok, status: r.status, statusText: r.statusText, data, headers: r.headers, type: r.type, note };
  }

  /** What the investigator sees of an answer: parsed data with credential-like fields replaced, a few headers, hints. */
  const tidy = (raw, how) => {
    const head = { op: raw.op ? `${label(raw.op)}${raw.op.id.includes(" ") ? "" : ` (${raw.op.id})`}` : `${raw.method} ${raw.shown.split("?")[0]} (not in the document)`, ...(how && !/^exact$/.test(how) ? { matched: how } : {}), url: raw.shown };
    if (raw.status == null) return { status: null, ok: false, ...head, error: raw.error, code: raw.code, ...(raw.meaning ? { meaning: raw.meaning } : {}), ms: raw.ms, hint: `nothing answered at ${raw.base.host}: is the API running, and is API_BASE_URL right?` };
    const { value, fields } = redact(raw.data, live);
    const out = { status: raw.status, ok: raw.ok, ...head, data: value, headers: shownHeaders(raw.headers), ms: raw.ms };
    if (fields.length) out.redacted = `fields named like a credential were replaced with ${REDACTED}: ${fields.slice(0, 12).join(", ")}${fields.length > 12 ? `, +${fields.length - 12} more` : ""}`;
    if (raw.note) out.note = raw.note;
    if (raw.status === 401 || raw.status === 403)
      out.hint = !token
        ? `${raw.status}: no credential is set. API_TOKEN holds it${raw.auth ? ` (it would be sent as ${authText(raw.auth)})` : ""}`
        : !raw.sentAuth
          ? `${raw.status}: the document says this operation takes no credential, so none was sent`
          : raw.status === 401
            ? `401: the API did not accept the credential (API_TOKEN, sent as ${raw.sentAuth}, from ${raw.auth.from}). API_AUTH changes how it is sent`
            : `403: the credential was sent (${raw.sentAuth}) and is not allowed to do this`;
    else if (raw.status === 404 && !raw.op) out.hint = "404, and the document has no such path: api.find(words) lists the operations there are";
    else if (raw.status === 429) out.hint = `429: the API is limiting requests${raw.headers?.["retry-after"] ? `; retry after ${raw.headers["retry-after"]}` : ""}. Do not repeat the call in a loop`;
    return out;
  };

  /** Put the caller's arguments where the operation takes them, and check the ones it must have. */
  function place(s, op, args = {}, pathArgs = {}) {
    if (args == null || typeof args !== "object" || Array.isArray(args)) throw new Error(`${op.id} takes one object of arguments: {path, query, body, headers}`);
    const params = paramsOf(s, op);
    const out = { path: { ...pathArgs, ...(args.path && typeof args.path === "object" ? args.path : {}) }, query: { ...(args.query && typeof args.query === "object" ? args.query : {}) }, headers: { ...(args.headers ?? {}) }, body: args.body };
    const loose = Object.keys(args).filter((k) => !["path", "query", "body", "headers"].includes(k));
    const body = bodyOf(s, op);
    const extra = {};
    for (const k of loose) {
      const p = params.find((x) => x.name === k);
      if (p?.in === "path") out.path[k] = args[k];
      else if (p?.in === "query") out.query[k] = args[k];
      else if (p?.in === "header") out.headers[k] = args[k];
      else if (body && args.body === undefined) extra[k] = args[k];
      else if (READS.has(op.method) && !body) out.query[k] = args[k];
      else throw new Error(`${op.id} has no parameter "${clip(k, 40)}"; it takes ${takes(params, body)}`);
    }
    if (Object.keys(extra).length) out.body = extra;
    const missing = params.filter((p) => p.required && (p.in === "path" ? out.path[p.name] == null || out.path[p.name] === "" : p.in === "query" ? out.query[p.name] == null : false));
    if (missing.length) throw new Error(`${op.id} (${label(op)}) needs ${missing.map((p) => `${p.in}.${p.name}`).join(", ")}; it takes ${takes(params, body)}`);
    if (body?.required && out.body == null) throw new Error(`${op.id} (${label(op)}) needs a body; api.describe("${op.id}") shows its shape`);
    const target = op.path.replace(/\{([^}]+)\}/g, (m, k) => encodeURIComponent(String(out.path[k])));
    return { target, query: out.query, headers: out.headers, body: out.body, bodyType: out.body != null ? body?.contentType : undefined };
  }
  const takes = (params, body) => {
    const by = (where) => params.filter((p) => p.in === where).map((p) => `${p.name}${p.required ? "" : "?"}`);
    const parts = [by("path").length ? `path: ${by("path").join(", ")}` : "", by("query").length ? `query: ${by("query").slice(0, 25).join(", ")}` : "", by("header").length ? `headers: ${by("header").join(", ")}` : "", body ? "a body" : ""].filter(Boolean);
    return parts.length ? parts.join("; ") : "no arguments";
  };

  const gate = (op) => {
    if (changes(op) && !act) throw new Error(notInThisAsk(`${label(op)}${op.id.includes(" ") ? "" : ` (${op.id})`}`));
  };

  async function rawCall(s, ref, args, opts = {}) {
    const { op, how, pathArgs } = resolveOp(s, ref);
    gate(op);
    const placed = place(s, op, args, pathArgs);
    const raw = await send(s, { op, method: op.method, ...placed, timeoutMs: opts.timeoutMs });
    return { raw, how, op, placed };
  }

  async function rawGet(s, target, query = {}, opts = {}) {
    let p = String(target ?? "").trim();
    if (!p) throw new Error("api.get needs a path, such as /guards or /guards/7");
    const base = baseOf(s);
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p);
      if (!sameOrigin(u, base)) throw new Error(`not allowed: ${u.host} is not this API's address (${base.host}). Requests and the credential go only there; read another address with the web kit`);
      p = `${u.pathname}${u.search}`;
      if (prefix(base) && p.startsWith(`${prefix(base)}/`)) p = p.slice(prefix(base).length);
    } else if (!p.startsWith("/")) p = `/${p}`;
    const [pathOnly, qs] = p.split(/\?(.*)/s);
    const q = { ...Object.fromEntries(new URLSearchParams(qs ?? "")), ...(query ?? {}) };
    let hit = matchPath(s, "GET", pathOnly);
    let sendPath = pathOnly;
    if (!hit && prefix(base) && pathOnly.startsWith(`${prefix(base)}/`)) {
      hit = matchPath(s, "GET", pathOnly.slice(prefix(base).length));
      sendPath = pathOnly.slice(prefix(base).length);
    }
    const raw = await send(s, { op: hit?.op ?? null, method: "GET", target: sendPath, query: q, timeoutMs: opts.timeoutMs });
    return { raw, how: hit && hit.op.path !== sendPath ? `the path fits ${hit.op.path}` : null, op: hit?.op ?? null, placed: { target: sendPath, query: q, headers: {} } };
  }

  async function pages(ref, args = {}, opts = {}) {
    const s = await spec();
    const max = Math.min(Math.max(Number(opts.max) || 5, 1), 50);
    const maxItems = Number(opts.maxItems) > 0 ? Number(opts.maxItems) : Infinity;
    const isPath = typeof ref === "string" && /^\//.test(ref.trim());
    let first = isPath ? await rawGet(s, ref, args?.query ?? {}, opts) : await rawCall(s, ref, args, opts);
    const { op, placed, how } = first;
    if (op && changes(op)) throw new Error(`${label(op)} changes things; api.pages reads a list. Use api.call for it`);
    const declared = new Set(op ? paramsOf(s, op).filter((p) => p.in === "query").map((p) => p.name) : []);
    const items = [];
    let raw = first.raw;
    let query = { ...placed.query };
    let n = 0;
    let used = null;
    let more = false;
    let key;
    let total = null;
    let stopped = null;
    let prevFirst = null;
    for (;;) {
      n++;
      if (raw.status == null || !raw.ok) {
        if (n === 1) return { ...tidy(raw, how), pagination: "the first request failed", pages: 0, count: 0, items: [] };
        stopped = `page ${n} failed: ${raw.status ?? raw.error}`;
        n--;
        break;
      }
      const found = itemsOf(raw.data);
      if (!found) {
        if (n === 1) return { ...tidy(raw, how), pagination: "the answer holds no list", pages: 1, count: 0, items: [] };
        stopped = `page ${n} held no list`;
        break;
      }
      key ??= found.key;
      const firstJson = found.items.length ? JSON.stringify(found.items[0]) : null;
      const repeat = n > 1 && firstJson != null && firstJson === prevFirst;
      prevFirst = firstJson;
      if (repeat) {
        stopped = "the next page repeated the one before it, so the paging parameter had no effect";
        n--;
        break;
      }
      items.push(...found.items);
      total ??= raw.data && !Array.isArray(raw.data) ? firstNum(raw.data, TOTAL_PATHS) : null;
      total ??= num(raw.headers?.["x-total-count"]);
      const next = nextPage({ data: raw.data, headers: raw.headers, declared, query, count: found.items.length, firstOfPrev: false });
      if (!next) break;
      used ??= next.how;
      if (n >= max || items.length >= maxItems) {
        more = true;
        break;
      }
      if (next.url) {
        let u;
        try {
          u = new URL(next.url, raw.finalUrl);
        } catch {
          stopped = "the link to the next page is not an address";
          break;
        }
        if (!sameOrigin(u, raw.base)) {
          stopped = `the next page is at ${u.host}, not this API's address (${raw.base.host}); it was not followed`;
          more = true;
          break;
        }
        // The link holds the whole query; the credential, when it travels in the query, is added again by send.
        if (raw.auth?.kind === "query") u.searchParams.delete(raw.auth.name);
        query = Object.fromEntries(u.searchParams);
        raw = await send(s, { op, method: "GET", target: `${u.origin}${u.pathname}`, query, headers: placed.headers, timeoutMs: opts.timeoutMs });
      } else {
        query = { ...query, ...next.query };
        raw = await send(s, { op, method: op?.method ?? "GET", target: placed.target, query, headers: placed.headers, body: placed.body, bodyType: placed.bodyType, timeoutMs: opts.timeoutMs });
      }
    }
    const shown = items.length > maxItems ? items.slice(0, maxItems) : items;
    const { value, fields } = redact(shown, live);
    return {
      status: first.raw.status,
      ok: true,
      op: tidy(first.raw, how).op,
      pagination: used ?? "none: the answer was one page and offered no next one",
      pages: n,
      count: value.length,
      ...(total != null ? { total } : {}),
      more: more || items.length > maxItems,
      ...(key ? { listField: key } : {}),
      items: value,
      ...(fields.length ? { redacted: `fields named like a credential were replaced with ${REDACTED}: ${fields.slice(0, 12).join(", ")}` } : {}),
      ...(stopped ? { stopped } : {}),
    };
  }

  // ---- reading the document ----

  const line = (op) => ({ id: op.id, op: label(op), does: clip(op.summary || op.description, 110), ...(changes(op) ? { changes: true } : {}), ...(op.deprecated ? { deprecated: true } : {}) });
  const tagsOf = (s) => {
    const by = new Map();
    for (const op of s.ops)
      for (const t of op.tags.length ? op.tags : ["untagged"]) {
        const e = by.get(t) ?? by.set(t, { tag: t, operations: 0, reads: 0, changes: 0 }).get(t);
        e.operations++;
        e[changes(op) ? "changes" : "reads"]++;
      }
    return [...by.values()].map((e) => ({ ...e, ...(s.tagAbout.get(e.tag) ? { about: s.tagAbout.get(e.tag) } : {}) }));
  };

  const reader = (source) => {
    const doc = () => spec(source);
    return {
      async info() {
        const s = await doc();
        let base = null;
        let baseNote = null;
        try {
          const b = baseOf(s);
          base = `${b.origin}${prefix(b)}`;
        } catch (e) {
          baseNote = e.message;
        }
        const auth = authFor(s, null);
        const tags = tagsOf(s);
        return {
          ...(settings.API_NAME && !source ? { name: clip(settings.API_NAME, 120) } : {}),
          title: s.title,
          version: s.apiVersion,
          document: `${s.version}, ${s.format}, from ${s.from}`,
          ...(s.description ? { about: clip(s.description, 400) } : {}),
          baseUrl: source ? (s.servers[0] ?? null) : base,
          ...(baseNote && !source ? { baseUrlProblem: baseNote } : {}),
          ...(s.servers.length > 1 ? { servers: s.servers.slice(0, 6) } : {}),
          auth: source ? { sentAs: authText(fromSchemeOnly(s) ?? { kind: "none stated" }) } : { sentAs: authText(auth), from: auth.from, credentialSet: !!token },
          operations: s.ops.length,
          reads: s.ops.filter((o) => !changes(o)).length,
          changes: s.ops.filter((o) => changes(o)).length,
          tags: tags.length > 60 ? [...tags.slice(0, 60), { tag: `+${tags.length - 60} more tags` }] : tags,
          ...(s.ops.some(isReadPost) ? { readingPosts: s.ops.filter(isReadPost).slice(0, 20).map((o) => o.id) } : {}),
          ...(s.remote.size ? { remoteReferences: `${s.remote.size} reference(s) to other files or addresses were not fetched: ${[...s.remote].slice(0, 3).map((r) => clip(r, 60)).join(", ")}` } : {}),
          ...(s.note ? { note: s.note } : {}),
        };
      },
      async find(words, o = {}) {
        const s = await doc();
        const opts = typeof o === "number" ? { max: o } : (o ?? {});
        const max = Math.min(Math.max(Number(opts.max) || 15, 1), 200);
        return rank(s, words, opts).slice(0, max).map(line);
      },
      async count(words, o = {}) {
        return rank(await doc(), words, o ?? {}).length;
      },
      async tags() {
        return tagsOf(await doc());
      },
      async describe(ref, o = {}) {
        const s = await doc();
        const { op, how } = resolveOp(s, ref);
        const depth = Math.min(Math.max(Number(o?.depth) || 3, 1), 8);
        const params = paramsOf(s, op);
        const body = bodyOf(s, op);
        const { success, others } = responsesOf(s, op);
        const auth = authFor(s, op);
        const out = {
          id: op.id,
          op: label(op),
          ...(how !== "exact" ? { matched: how } : {}),
          ...(op.summary ? { summary: op.summary } : {}),
          ...(op.description && clip(op.description, 700) !== op.summary ? { description: clip(op.description, 700) } : {}),
          ...(op.tags.length ? { tags: op.tags } : {}),
          changes: changes(op),
          runs: changes(op) ? (act ? "this ask may change things, so it runs" : "only when the caller asked for a change (act: true)") : op.method === "POST" ? "always: a POST that only reads" : "always",
          ...(op.deprecated ? { deprecated: true } : {}),
          auth: auth ? `${authText(auth)}, sent for you` : "none: the document says this operation takes no credential",
          parameters: params.slice(0, 40).map((p) => {
            const sch = s.deref(p.schema) ?? {};
            return { name: p.name, in: p.in, required: p.required, type: shape(s, p.schema, { depth: 1, maxLines: 6 }).replace(/\s*\n\s*/g, " "), ...(sch.default !== undefined ? { default: sch.default } : {}), ...(p.description ? { about: clip(p.description, 160) } : {}), ...(p.deprecated ? { deprecated: true } : {}) };
          }),
          ...(params.length > 40 ? { moreParameters: params.slice(40).map((p) => p.name).join(", ") } : {}),
        };
        if (body) out.body = { required: body.required, contentType: body.contentType, ...(body.types.length > 1 ? { alsoTakes: body.types.filter((t) => t !== body.contentType).slice(0, 4) } : {}), shape: shape(s, body.schema, { depth }) };
        out.response = success ? { status: success.status, ...(success.description ? { about: success.description } : {}), ...(success.contentType ? { contentType: success.contentType } : {}), shape: success.schema ? shape(s, success.schema, { depth }) : "no body described" } : "no response described";
        if (others.length) out.otherResponses = others.slice(0, 12);
        return out;
      },
      async schema(name, o = {}) {
        const s = await doc();
        const all = (s.swagger2 ? s.doc.definitions : s.doc.components?.schemas) ?? {};
        const names = Object.keys(all);
        const want = String(name ?? "");
        const use = names.find((n) => n === want) ?? names.find((n) => n.toLowerCase() === want.toLowerCase()) ?? (want.length > 2 ? names.filter((n) => n.toLowerCase().includes(want.toLowerCase())) : []);
        if (Array.isArray(use) && use.length !== 1) throw new Error(`${use.length ? `"${clip(want, 40)}" fits ${use.length} schemas: ${use.slice(0, 20).join(", ")}` : `no schema "${clip(want, 40)}"; have: ${names.slice(0, 40).join(", ")}${names.length > 40 ? `, +${names.length - 40} more` : ""}`}`);
        const n = Array.isArray(use) ? use[0] : use;
        return { name: n, shape: shape(s, all[n], { depth: Math.min(Math.max(Number(o?.depth) || 3, 1), 8), maxLines: 120 }) };
      },
    };
  };
  const fromSchemeOnly = (s) => {
    for (const def of Object.values(s.schemes)) {
      const a = fromScheme(s.deref(def));
      if (a) return a;
    }
    return null;
  };

  const own = reader(null);
  const api = {
    ...own,
    /** The reading functions over another document. It cannot be called: requests go to the configured API only. */
    document(source) {
      if (!source || typeof source !== "string") throw new Error("api.document needs the document's URL or file path");
      const r = reader(source);
      return Object.fromEntries(Object.entries(r).map(([k, f]) => [k, guarded(f)]));
    },
    async call(ref, args = {}, opts = {}) {
      const s = await spec();
      const { raw, how } = await rawCall(s, ref, args, opts);
      return tidy(raw, how);
    },
    async get(target, query = {}, opts = {}) {
      const s = await spec();
      const { raw, how } = await rawGet(s, target, query, opts);
      return tidy(raw, how);
    },
    pages,
    /** The cheapest reading operations to try the API with: GET, no required parameter. */
    async probes() {
      const s = await spec();
      const cheap = s.ops.filter((op) => op.method === "GET" && !op.deprecated && !paramsOf(s, op).some((p) => p.required));
      const score = (op) => (/(^|\/)(health|healthz|ping|status|version|me|whoami|user|info)$/i.test(op.path) ? 0 : 10) + op.path.split("/").length + op.path.length / 100;
      const open = (op) => Array.isArray(op.raw.security) && op.raw.security.length === 0;
      const sizes = (op) => paramsOf(s, op).filter((p) => p.in === "query" && SIZE_NAMES.includes(p.name)).map((p) => p.name)[0] ?? null;
      const row = (op) => ({ id: op.id, op: label(op), takesCredential: !open(op), sizeParam: sizes(op) });
      const sorted = [...cheap].sort((a, b) => score(a) - score(b));
      return { open: sorted.filter(open).slice(0, 3).map(row), guarded: sorted.filter((o) => !open(o)).slice(0, 3).map(row), credentialSet: !!token };
    },
    act,
  };
  for (const k of Object.keys(api)) if (typeof api[k] === "function" && k !== "document") api[k] = guarded(api[k]);
  return api;
}

export { tokens };
