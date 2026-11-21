// Helpers the scripts share.

const MAX_CHARS = 16000;

/**
 * A copy of an answer's data that fits in a reply: a list longer than `n` is cut to `n` items, and
 * what is cut is counted in `cut`. Data that is still over 16,000 characters becomes a text
 * preview. Returns {data, cut: {where: itemsLeftOut}, preview?: true}.
 */
export function cap(data, n = 25) {
  const cut = {};
  const walk = (v, where, depth) => {
    if (Array.isArray(v)) {
      if (v.length > n) cut[where || "(the answer)"] = v.length - n;
      return v.slice(0, n).map((x) => (depth < 1 ? walk(x, `${where}[]`, depth + 1) : x));
    }
    if (v && typeof v === "object" && depth < 2) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, where ? `${where}.${k}` : k, depth + 1)]));
    return v;
  };
  const data2 = walk(data, "", 0);
  const text = JSON.stringify(data2);
  if (text && text.length > MAX_CHARS) return { data: `${text.slice(0, MAX_CHARS)}…`, cut, preview: true, chars: text.length };
  return { data: data2, cut };
}

/** An operation's id and method and path for a sentence. */
export const op = (r) => r?.op ?? "the request";

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The arguments of a call from the script's params: `args` as given, with path, query, body and headers kept apart. */
export function argsOf({ path, query, body, headers, args } = {}) {
  const out = { ...(args && typeof args === "object" ? args : {}) };
  if (path !== undefined) out.path = path;
  if (query !== undefined) out.query = query;
  if (body !== undefined) out.body = body;
  if (headers !== undefined) out.headers = headers;
  return out;
}

/** Params that arrive as text (key=value on a command line) and should be objects. */
export function obj(v, name) {
  if (v == null || typeof v === "object") return v;
  try {
    const x = JSON.parse(v);
    if (x && typeof x === "object") return x;
  } catch {}
  throw new Error(`${name} must be an object (JSON), got "${String(v).slice(0, 40)}"`);
}
