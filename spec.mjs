// An OpenAPI 3.0 or 3.1 or a Swagger 2.0 document, read from a file or a URL (JSON or YAML) and
// turned into a list of operations that can be searched, described and called. `$ref` is followed
// inside the document; a reference to another file or address is reported and not fetched.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml } from "./yaml.mjs";
import { request } from "./http.mjs";

export const stateDir = () => path.join(process.env.ASK_KIT_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "ask-kit"), "api");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
export const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const firstSentence = (s, n) => clip(String(s ?? "").split(/\n\s*\n|(?<=[.!?])\s/)[0], n);
export const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const URL_TTL_MS = 60 * 60_000;
const memo = new Map();

const writeQuietly = (file, text) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
};

/** A URL without its password and without query values, for messages. */
export const plainUrl = (u) => {
  try {
    const x = new URL(u);
    x.username = "";
    x.password = "";
    x.search = "";
    return x.href;
  } catch {
    return String(u);
  }
};

/**
 * Read and parse the document at `source` (a URL or a file path, relative to `workdir`).
 * A YAML document's parsed form is kept under the state folder, named after the hash of its text.
 * A document from a URL is kept for an hour; when the address does not answer, the last copy is used.
 */
export async function loadSpec(source, { workdir = process.cwd(), push = () => {}, fresh = false } = {}) {
  const src = String(source ?? "").trim();
  if (!src) throw new Error("no OpenAPI document: set API_SPEC to its URL or file path (JSON or YAML)");
  const isUrl = /^https?:\/\//i.test(src);
  let text;
  let from;
  let note;
  let key;
  if (isUrl) {
    from = plainUrl(src);
    key = `url ${src}`;
    const hit = memo.get(key);
    if (hit?.spec && !fresh && Date.now() - hit.at < URL_TTL_MS) return hit.spec;
    const copy = path.join(stateDir(), "spec", `${sha(src)}.txt`);
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(copy).mtimeMs;
    } catch {}
    if (!fresh && age < URL_TTL_MS) text = fs.readFileSync(copy, "utf8");
    else {
      const started = Date.now();
      const r = await request(src, { timeoutMs: 60_000, maxBytes: 64 << 20, headers: { Accept: "application/json, application/yaml, text/yaml, */*;q=0.5" } });
      push({ kind: "api", detail: `GET ${from} (the document)`, ms: Date.now() - started, code: r.status ?? 1, size: r.body?.length ?? 0 });
      if (r.ok && !r.cut) {
        text = r.body.toString("utf8");
        writeQuietly(copy, text);
      } else {
        const why = r.cut ? "it is larger than 64 MB" : r.status ? `it answered ${r.status}` : `${r.error}${r.meaning ? ` (${r.meaning})` : ""}`;
        if (age === Infinity) throw new Error(`cannot read the OpenAPI document at ${from}: ${why}. It is fetched without the credential; when it needs one, save it to a file and set API_SPEC to the file`);
        text = fs.readFileSync(copy, "utf8");
        note = `the document's address did not answer (${why}); this is the copy from ${Math.round(age / 60_000)} minutes ago`;
      }
    }
  } else {
    const file = path.resolve(workdir, src.replace(/^~(?=$|\/)/, os.homedir()));
    from = file;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new Error(`cannot read the OpenAPI document: no file ${file}. API_SPEC is a URL or a file path; a relative path starts at ${workdir}`);
    }
    if (!st.isFile()) throw new Error(`cannot read the OpenAPI document: ${file} is not a file`);
    if (st.size > 64 << 20) throw new Error(`cannot read the OpenAPI document: ${file} is larger than 64 MB`);
    key = `file ${file}`;
    const hit = memo.get(key);
    if (hit?.spec && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.spec;
    const started = Date.now();
    text = fs.readFileSync(file, "utf8");
    push({ kind: "api", detail: `read ${file}`, ms: Date.now() - started, code: 0, size: text.length });
    memo.set(key, { mtime: st.mtimeMs, size: st.size });
  }
  const hash = sha(text);
  const json = /^\s*\{/.test(text.slice(0, 200).replace(/^﻿/, ""));
  let doc;
  let cached = false;
  if (json) {
    try {
      doc = JSON.parse(text.replace(/^﻿/, ""));
    } catch (e) {
      throw new Error(`${from} starts like JSON and does not parse: ${String(e.message).replace(/in JSON at/, "at").replace(/"[^"]*"\.\.\. is not valid JSON/, "not valid JSON").slice(0, 120)}`);
    }
  } else {
    const file = path.join(stateDir(), "cache", `${hash}.json`);
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
      cached = true;
    } catch {
      try {
        doc = parseYaml(text);
      } catch (e) {
        throw new Error(`${from} does not parse as YAML: ${e.message}`);
      }
      if (text.length > 200_000) writeQuietly(file, JSON.stringify(doc));
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !(doc.openapi || doc.swagger) || !doc.paths || typeof doc.paths !== "object")
    throw new Error(`${from} is not an OpenAPI or Swagger document: it has no \`openapi\` or \`swagger\` field with \`paths\``);
  const spec = build(doc, { from, isUrl, src, format: json ? "JSON" : "YAML", hash, cached, note });
  memo.set(key, { ...(memo.get(key) ?? {}), at: Date.now(), spec });
  return spec;
}

const unescapePointer = (s) => {
  let t = s.replace(/~1/g, "/").replace(/~0/g, "~");
  if (t.includes("%"))
    try {
      t = decodeURIComponent(t);
    } catch {}
  return t;
};

function build(doc, meta) {
  const swagger2 = !doc.openapi;
  const remote = new Set();
  const refs = new Map();
  /** What a `$ref` points at, inside the document. A remote reference gives {remote}. */
  const target = (ref) => {
    if (refs.has(ref)) return refs.get(ref);
    let v;
    if (typeof ref !== "string" || !ref.startsWith("#")) {
      remote.add(String(ref));
      v = { remote: String(ref) };
    } else {
      v = doc;
      for (const part of ref.slice(1).split("/").slice(1)) v = v == null ? undefined : v[unescapePointer(part)];
      if (v === undefined) v = { missing: ref };
    }
    refs.set(ref, v);
    return v;
  };
  const deref = (node) => {
    for (let n = 0; node && typeof node === "object" && typeof node.$ref === "string" && n < 20; n++) node = target(node.$ref);
    return node;
  };

  const servers = [];
  if (swagger2) {
    const schemes = [].concat(doc.schemes ?? []);
    const scheme = schemes.includes("https") ? "https" : (schemes[0] ?? (meta.isUrl ? new URL(meta.src).protocol.replace(":", "") : "https"));
    const host = doc.host ?? (meta.isUrl ? new URL(meta.src).host : null);
    if (host) servers.push(`${scheme}://${host}${doc.basePath ?? ""}`);
    else if (doc.basePath) servers.push(doc.basePath);
  } else
    for (const s of [].concat(doc.servers ?? [])) {
      if (!s || typeof s.url !== "string") continue;
      servers.push(s.url.replace(/\{([^}]+)\}/g, (m, k) => (s.variables?.[k]?.default != null ? String(s.variables[k].default) : m)));
    }

  const ops = [];
  const ids = new Map();
  for (const [p, rawItem] of Object.entries(doc.paths)) {
    const item = deref(rawItem);
    if (!item || typeof item !== "object" || !p.startsWith("/")) continue;
    for (const m of METHODS) {
      const o = item[m];
      if (!o || typeof o !== "object") continue;
      const METHOD = m.toUpperCase();
      let id = typeof o.operationId === "string" && o.operationId.trim() ? o.operationId.trim() : `${METHOD} ${p}`;
      if (ids.has(id.toLowerCase())) id = `${METHOD} ${p}`;
      const op = { id, method: METHOD, path: p, summary: clip(o.summary ?? "", 200), description: typeof o.description === "string" ? o.description : "", tags: [].concat(o.tags ?? []).map(String), deprecated: o.deprecated === true, readOnlyMark: o["x-readonly"] === true || o["x-read-only"] === true, raw: o, item };
      ops.push(op);
      ids.set(id.toLowerCase(), op);
    }
  }

  const declared = new Map([].concat(doc.tags ?? []).filter((t) => t && t.name).map((t) => [String(t.name), clip(t.description ?? "", 160)]));
  const schemes = (swagger2 ? doc.securityDefinitions : doc.components?.securitySchemes) ?? {};
  return {
    doc,
    ...meta,
    swagger2,
    version: swagger2 ? `Swagger ${doc.swagger}` : `OpenAPI ${doc.openapi}`,
    title: clip(doc.info?.title ?? "", 120),
    apiVersion: doc.info?.version != null ? String(doc.info.version) : null,
    description: typeof doc.info?.description === "string" ? doc.info.description : "",
    servers,
    ops,
    ids,
    tagAbout: declared,
    schemes,
    remote,
    deref,
    target,
  };
}

// ---- one operation's parts ----

export function paramsOf(spec, op) {
  if (op.params) return op.params;
  const seen = new Map();
  for (const raw of [...[].concat(op.item.parameters ?? []), ...[].concat(op.raw.parameters ?? [])]) {
    const p = spec.deref(raw);
    if (!p || typeof p !== "object" || !p.name || !p.in) continue;
    if (p.in === "body" || p.in === "formData") continue;
    const schema = p.schema ?? (p.content ? Object.values(p.content)[0]?.schema : null) ?? (p.type ? { type: p.type, format: p.format, enum: p.enum, items: p.items, default: p.default } : null);
    seen.set(`${p.in} ${p.name}`, { name: String(p.name), in: p.in, required: p.in === "path" || p.required === true, schema, description: typeof p.description === "string" ? p.description : "", explode: p.explode ?? (p.collectionFormat ? p.collectionFormat === "multi" : (p.style ?? "form") === "form"), deprecated: p.deprecated === true });
  }
  return (op.params = [...seen.values()]);
}

const pickType = (types) => types.find((t) => /^application\/(.+\+)?json/i.test(t)) ?? types.find((t) => /x-www-form-urlencoded/i.test(t)) ?? types[0] ?? null;

export function bodyOf(spec, op) {
  if (op.body !== undefined) return op.body;
  let body = null;
  if (spec.swagger2) {
    const all = [...[].concat(op.item.parameters ?? []), ...[].concat(op.raw.parameters ?? [])].map(spec.deref).filter((p) => p && typeof p === "object");
    const consumes = [].concat(op.raw.consumes ?? spec.doc.consumes ?? []);
    const b = all.filter((p) => p.in === "body").pop();
    const form = all.filter((p) => p.in === "formData");
    if (b) body = { required: b.required === true, contentType: pickType(consumes) ?? "application/json", schema: b.schema ?? null, types: consumes };
    else if (form.length)
      body = { required: form.some((p) => p.required), contentType: consumes.find((t) => /multipart/i.test(t)) && form.some((p) => p.type === "file") ? "multipart/form-data" : "application/x-www-form-urlencoded", schema: { type: "object", required: form.filter((p) => p.required).map((p) => p.name), properties: Object.fromEntries(form.map((p) => [p.name, { type: p.type, format: p.format, description: p.description, enum: p.enum }])) }, types: consumes };
  } else {
    const rb = spec.deref(op.raw.requestBody);
    if (rb && typeof rb === "object" && rb.content && typeof rb.content === "object") {
      const types = Object.keys(rb.content);
      const contentType = pickType(types);
      body = { required: rb.required === true, contentType, schema: rb.content[contentType]?.schema ?? null, types, description: typeof rb.description === "string" ? rb.description : "" };
    }
  }
  return (op.body = body);
}

export function responsesOf(spec, op) {
  const all = op.raw.responses && typeof op.raw.responses === "object" ? op.raw.responses : {};
  const codes = Object.keys(all);
  const order = ["200", "201", ...codes.filter((c) => /^2\d\d$/.test(c)).sort(), "2XX", "2xx", "default"];
  const code = order.find((c) => c in all) ?? null;
  let success = null;
  if (code) {
    const r = spec.deref(all[code]) ?? {};
    let contentType = null;
    let schema = null;
    if (spec.swagger2) {
      schema = r.schema ?? null;
      contentType = schema ? (pickType([].concat(op.raw.produces ?? spec.doc.produces ?? [])) ?? "application/json") : null;
    } else if (r.content && typeof r.content === "object") {
      contentType = pickType(Object.keys(r.content));
      schema = r.content[contentType]?.schema ?? null;
    }
    success = { status: code, description: clip(r.description ?? "", 160), contentType, schema };
  }
  const others = codes.filter((c) => c !== code).map((c) => `${c} ${clip(spec.deref(all[c])?.description ?? "", 70)}`.trim());
  return { success, others };
}

// ---- shapes: a schema as a few readable lines ----

const refName = (ref) => unescapePointer(String(ref).split("/").pop());

/** A schema written like a type, clipped at `depth` levels of nested objects and `maxLines` lines. */
export function shape(spec, schema, { depth = 3, maxLines = 70, maxProps = 40 } = {}) {
  const walk = (s, d, ind, stack) => {
    if (s == null || s === true) return "any";
    if (typeof s !== "object") return "any";
    if (typeof s.$ref === "string") {
      const name = refName(s.$ref);
      if (stack.includes(s.$ref)) return `${name} (itself again)`;
      const t = spec.target(s.$ref);
      if (t?.remote) return `${name} (a reference to ${clip(t.remote, 80)}, not fetched)`;
      if (t?.missing) return `${name} (not in the document)`;
      return walk(t, d, ind, [...stack, s.$ref]);
    }
    let nullable = s.nullable === true;
    let types = [].concat(s.type ?? []);
    if (types.includes("null")) {
      nullable = true;
      types = types.filter((t) => t !== "null");
    }
    const orNull = (t) => (nullable ? `${t} | null` : t);
    if (Array.isArray(s.allOf) && s.allOf.length) {
      const merged = { type: "object", properties: { ...(s.properties ?? {}) }, required: [...[].concat(s.required ?? [])] };
      let plain = null;
      for (const part of s.allOf) {
        const p = spec.deref(part);
        if (!p || typeof p !== "object") continue;
        const inner = Array.isArray(p.allOf) ? flatten(p) : p;
        if (inner.properties) Object.assign(merged.properties, inner.properties);
        else if (!plain && (inner.type || inner.enum || inner.oneOf || inner.anyOf)) plain = part;
        merged.required.push(...[].concat(inner.required ?? []));
        if (inner.additionalProperties && merged.additionalProperties === undefined) merged.additionalProperties = inner.additionalProperties;
      }
      if (!Object.keys(merged.properties).length && plain) return orNull(walk(plain, d, ind, stack));
      return orNull(walk(merged, d, ind, stack));
    }
    for (const k of ["oneOf", "anyOf"]) {
      if (!Array.isArray(s[k]) || !s[k].length) continue;
      const alts = s[k].filter((a) => !(a && a.type === "null"));
      if (alts.length < s[k].length) nullable = true;
      const shown = alts.slice(0, 4).map((a) => walk(a, d - 1, ind, stack));
      return orNull(shown.join(" | ") + (alts.length > 4 ? ` | +${alts.length - 4} more` : ""));
    }
    if ("const" in s) return orNull(JSON.stringify(s.const));
    if (Array.isArray(s.enum)) return orNull(s.enum.slice(0, 8).map((v) => JSON.stringify(v)).join(" | ") + (s.enum.length > 8 ? ` | +${s.enum.length - 8} more` : ""));
    const type = types[0] ?? (s.properties || s.additionalProperties ? "object" : s.items ? "array" : null);
    if (type === "array") {
      const item = walk(s.items ?? null, d, ind, stack);
      return orNull(/[ |]/.test(item) && !item.startsWith("{") ? `(${item})[]` : `${item}[]`);
    }
    if (type === "object") {
      const props = s.properties && typeof s.properties === "object" ? Object.entries(s.properties) : [];
      const extra = s.additionalProperties && typeof s.additionalProperties === "object" ? walk(s.additionalProperties, d - 1, ind, stack) : s.additionalProperties === true && !props.length ? "any" : null;
      if (!props.length) return orNull(extra ? `{ [key]: ${extra} }` : "object");
      if (d <= 0) return orNull(`{ ${props.slice(0, 8).map(([k]) => k).join(", ")}${props.length > 8 ? `, +${props.length - 8} more` : ""} }`);
      const req = new Set([].concat(s.required ?? []));
      const lines = props.slice(0, maxProps).map(([k, v]) => {
        const r = spec.deref(v) ?? {};
        const about = [r.deprecated ? "deprecated" : "", r.readOnly ? "read only" : "", firstSentence(v?.description ?? r.description, 80)].filter(Boolean).join("; ");
        return `${ind}  ${/^[\w$-]+$/.test(k) ? k : JSON.stringify(k)}${req.has(k) ? "" : "?"}: ${walk(v, d - 1, `${ind}  `, stack)}${about ? `  // ${about}` : ""}`;
      });
      if (props.length > maxProps) lines.push(`${ind}  +${props.length - maxProps} more: ${props.slice(maxProps, maxProps + 30).map(([k]) => k).join(", ")}`);
      if (extra) lines.push(`${ind}  [key]: ${extra}`);
      return orNull(`{\n${lines.join("\n")}\n${ind}}`);
    }
    if (!type) return nullable ? "any | null" : "any";
    return orNull(s.format ? `${type}(${s.format})` : type);
  };
  const flatten = (s) => {
    const out = { properties: { ...(s.properties ?? {}) }, required: [...[].concat(s.required ?? [])] };
    for (const part of s.allOf ?? []) {
      const p = spec.deref(part);
      if (!p || typeof p !== "object") continue;
      const inner = Array.isArray(p.allOf) ? flatten(p) : p;
      Object.assign(out.properties, inner.properties ?? {});
      out.required.push(...[].concat(inner.required ?? []));
    }
    return out;
  };
  const text = walk(schema, depth, "", []);
  const lines = text.split("\n");
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more lines: ask with a smaller depth, or read one named schema with api.schema(name)` : text;
}

// ---- finding operations ----

const STOP = new Set("the a an of to for in on by with all is are how do does i can what which this that api endpoint endpoints operation operations and or from me my it its there any".split(" "));
const VERBS = { GET: ["list", "get", "show", "fetch", "read", "find", "search", "view", "retrieve", "lookup"], POST: ["create", "add", "new", "post", "make", "open", "submit"], PUT: ["update", "edit", "change", "modify", "set", "replace", "put"], PATCH: ["update", "edit", "change", "modify", "set", "patch"], DELETE: ["delete", "remove", "destroy", "close", "cancel"] };
const stem = (t) => (t.length > 4 && t.endsWith("ies") ? `${t.slice(0, -3)}y` : t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
export const tokens = (s) =>
  String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);

const hay = (op) =>
  (op.hay ??= {
    id: new Set(tokens(op.id.includes(" ") ? "" : op.id)),
    idText: op.id.toLowerCase(),
    path: new Set(tokens(op.path.replace(/\{[^}]*\}/g, " "))),
    tags: new Set(tokens(op.tags.join(" "))),
    summary: new Set(tokens(op.summary)),
    text: `${op.summary} ${op.description}`.toLowerCase(),
  });

const weight = (h, t) => Math.max(h.id.has(t) ? 6 : t.length > 2 && h.idText.includes(t) ? 3 : 0, h.path.has(t) ? 5 : 0, h.summary.has(t) ? 4 : 0, h.tags.has(t) ? 3 : 0, t.length > 2 && h.text.includes(t) ? 1 : 0);

/** Operations ranked by how well they fit some words. With no words, all of them in the document's order. */
export function rank(spec, words, { tag, method } = {}) {
  let pool = spec.ops;
  if (tag) {
    const want = String(tag).toLowerCase();
    const names = [...new Set(spec.ops.flatMap((o) => (o.tags.length ? o.tags : ["untagged"])))];
    const use = names.find((n) => n.toLowerCase() === want) ?? names.find((n) => n.toLowerCase().includes(want));
    if (!use) throw new Error(`no tag "${clip(tag, 60)}"; have: ${names.slice(0, 40).join(", ")}${names.length > 40 ? `, +${names.length - 40} more` : ""}`);
    pool = pool.filter((o) => (o.tags.length ? o.tags : ["untagged"]).includes(use));
  }
  if (method) pool = pool.filter((o) => o.method === String(method).toUpperCase());
  const q = String(words ?? "").trim();
  if (!q) return pool;
  const asPath = /(^|\s)(\/[^\s]*)/.exec(q)?.[2]?.toLowerCase();
  const asMethod = /^(get|post|put|patch|delete|head|options)\b/i.exec(q)?.[1]?.toUpperCase();
  const terms = [...new Set(tokens(q))].filter((t) => !STOP.has(t) && !(asMethod && t === asMethod.toLowerCase()));
  if (!terms.length && !asPath) return asMethod ? pool.filter((o) => o.method === asMethod) : pool;
  const df = terms.map((t) => pool.reduce((n, o) => n + (weight(hay(o), t) > 0 ? 1 : 0), 0));
  const scored = [];
  for (const op of pool) {
    const h = hay(op);
    let score = 0;
    let hit = 0;
    terms.forEach((t, k) => {
      const w = weight(h, t);
      if (w) {
        hit++;
        score += w * Math.log(1 + pool.length / (1 + df[k]));
      }
      if (VERBS[op.method]?.includes(t)) score += 1.5;
    });
    if (terms.length) score *= 0.4 + 0.6 * (hit / terms.length);
    if (asPath && op.path.toLowerCase().includes(asPath)) score += 20 + (op.path.toLowerCase() === asPath ? 10 : 0);
    if (asMethod && op.method === asMethod) score += 2;
    if (!hit && !(asPath && op.path.toLowerCase().includes(asPath))) continue;
    if (op.deprecated) score *= 0.7;
    scored.push([score, op]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].path.length - b[1].path.length || METHODS.indexOf(a[1].method.toLowerCase()) - METHODS.indexOf(b[1].method.toLowerCase()));
  return scored.map((x) => x[1]);
}

const matcher = (op) =>
  (op.re ??= new RegExp(
    `^${op.path
      .split(/(\{[^}]+\})/)
      .map((part) => (/^\{[^}]+\}$/.test(part) ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("")}/?$`,
  ));
const paramNames = (op) => [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

/** The operation a concrete path belongs to ("/guards/7" is `/guards/{id}`), with the values of its path parameters. */
export function matchPath(spec, method, p) {
  const clean = p.split(/[?#]/)[0] || "/";
  let best = null;
  for (const op of spec.ops) {
    if (op.method !== method) continue;
    if (op.path === clean) return { op, pathArgs: {} };
    const m = matcher(op).exec(clean);
    if (!m) continue;
    const names = paramNames(op);
    if (!best || names.length < best.names.length) best = { op, names, values: m.slice(1) };
  }
  if (!best) return null;
  const pathArgs = {};
  best.names.forEach((n, k) => {
    try {
      pathArgs[n] = decodeURIComponent(best.values[k]);
    } catch {
      pathArgs[n] = best.values[k];
    }
  });
  return { op: best.op, pathArgs };
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/** An operation from what the caller wrote: an operationId, "METHOD /path", or a path. Says how it matched. */
export function resolveOp(spec, ref) {
  const r = String(ref ?? "").trim();
  if (!r) throw new Error("an operation is needed: an operationId or `METHOD /path`; api.find(words) lists them");
  const exact = spec.ids.get(r.toLowerCase());
  if (exact) return { op: exact, how: exact.id === r ? "exact" : "exact, ignoring case", pathArgs: {} };
  const mp = /^(?:(get|post|put|patch|delete|head|options)\s+)?(\/\S*)$/i.exec(r);
  if (mp) {
    const p = mp[2];
    const methods = mp[1] ? [mp[1].toUpperCase()] : ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    for (const m of methods) {
      const hit = matchPath(spec, m, p);
      if (hit) return { ...hit, how: hit.op.path === p.split(/[?#]/)[0] ? "exact" : `the path fits ${hit.op.path}` };
    }
    const same = spec.ops.filter((o) => o.path === p.split(/[?#]/)[0]);
    throw new Error(`no operation ${r}${same.length ? `; that path has: ${same.map((o) => o.method).join(", ")}` : `; nearest: ${rank(spec, p).slice(0, 5).map((o) => `${o.method} ${o.path}`).join(", ") || "none"}`}. api.find(words) lists operations`);
  }
  const sq = squash(r);
  const same = spec.ops.filter((o) => squash(o.id) === sq);
  if (same.length === 1) return { op: same[0], how: "exact, ignoring punctuation", pathArgs: {} };
  const part = sq.length > 2 ? spec.ops.filter((o) => !o.id.includes(" ") && squash(o.id).includes(sq)) : [];
  if (part.length === 1) return { op: part[0], how: `"${clip(r, 40)}" is part of ${part[0].id}`, pathArgs: {} };
  const near = (part.length ? part : rank(spec, r)).slice(0, 6).map((o) => o.id);
  throw new Error(`${part.length > 1 ? `"${clip(r, 60)}" fits ${part.length} operations` : `no operation "${clip(r, 60)}"`}; ${near.length ? `nearest: ${near.join(", ")}` : "nothing near it"}. api.find(words) lists operations`);
}
