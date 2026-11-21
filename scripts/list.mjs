import { obj } from "../lib.mjs";

export const meta = {
  purpose: "Every item of a list operation, following its pages (a Link header, a next link or cursor in the answer, page numbers or an offset), with how it paged and the total when the API says. The answer to 'how many X are there', 'all the X that ...', 'list every X'.",
  params: { op: "the list operation: an operationId, `GET /path` or a path", query: "query parameters (filters, a page size) as an object", path: "path parameters as an object", pages: "most pages read, default 5, at most 50", items: "stop after this many items", show: "items returned, default 50 (count and total are still the whole)", pick: "keep only these fields of each item, a list of names" },
  returns: "{verdict, op, pagination, pages, count, total?, more, listField?, items, shownItems, redacted?, stopped?}",
  example: 'await scripts.run("list", { op: "listGuards", query: { rank: "sergeant" } })',
};

export default async function ({ api }, p = {}) {
  if (!p.op) throw new Error("list needs `op`: the list operation (an operationId, `GET /path` or a path)");
  const r = await api.pages(String(p.op).trim(), { query: obj(p.query, "query") ?? {}, path: obj(p.path, "path") ?? {} }, { max: p.pages, maxItems: p.items });
  if (r.pagination === "the first request failed" || r.pagination === "the answer holds no list") return { verdict: `${r.op}: ${r.pagination} (status ${r.status ?? "none"})`, ...r };
  const show = Number(p.show) || 50;
  const keep = Array.isArray(p.pick) ? p.pick : typeof p.pick === "string" && p.pick ? p.pick.split(",").map((s) => s.trim()) : null;
  const items = (r.items ?? []).slice(0, show).map((x) => (keep && x && typeof x === "object" ? Object.fromEntries(keep.filter((k) => k in x).map((k) => [k, x[k]])) : x));
  return {
    verdict: `${r.op}: ${r.count} items${r.total != null ? ` of ${r.total}` : ""} in ${r.pages} page${r.pages === 1 ? "" : "s"}${r.more ? ", and there are more pages" : ""}; paged by ${r.pagination}`,
    ...r,
    items,
    shownItems: items.length,
  };
}
