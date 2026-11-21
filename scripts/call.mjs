import { argsOf, cap, obj } from "../lib.mjs";

export const meta = {
  purpose: "Call one operation and return what it answered: status, the data (a long list cut to `limit` items), the few headers that matter, and a hint when it failed (401, 403, 404, 429, nothing listening). GET, HEAD and OPTIONS always run; anything that changes data only when the ask may change things. The credential is added for you and never shown.",
  params: { op: "an operationId, `METHOD /path` or a concrete path such as /guards/7 (a path is read with GET)", path: "path parameters as an object, for example {id: 7}", query: "query parameters as an object", body: "the request body, an object", headers: "extra headers as an object (never the credential)", limit: "items kept of a long list in the answer, default 25" },
  returns: "{verdict, status, ok, op, url, data, headers, ms, cut?, redacted?, note?, hint?}",
  example: 'await scripts.run("call", { op: "getGuard", path: { id: "vimes" } })',
};

export default async function ({ api }, p = {}) {
  if (!p.op) throw new Error("call needs `op`: an operationId, `METHOD /path` or a path; scripts.run(\"find\", { words }) finds one");
  const ref = String(p.op).trim();
  const query = obj(p.query, "query");
  const args = argsOf({ path: obj(p.path, "path"), query, body: obj(p.body, "body"), headers: obj(p.headers, "headers"), args: obj(p.args, "args") });
  const r = /^\//.test(ref) ? await api.get(ref, query ?? {}) : await api.call(ref, args);
  const { data, cut, preview, chars } = cap(r.data, Number(p.limit) || 25);
  return {
    verdict: `${r.op}: ${r.status ?? "no answer"}${r.ok ? " ok" : r.status == null ? ` (${r.error})` : " failed"}`,
    ...r,
    data,
    ...(Object.keys(cut).length ? { cut: Object.fromEntries(Object.entries(cut).map(([k, v]) => [k, `${v} items left out`])) } : {}),
    ...(preview ? { note: `${r.note ? `${r.note}; ` : ""}the data is ${chars} characters and is shown as a text preview` } : {}),
  };
}
