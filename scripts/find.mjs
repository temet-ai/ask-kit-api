import { plural } from "../lib.mjs";

export const meta = {
  purpose: "Which operations of the API fit some words, ranked, with the top ones described in full (parameters, request body, response shape). The answer to 'which endpoint lists X', 'how do I create Y', 'what does the API have for Z', 'what does GET /x take and return'.",
  params: { words: "what the operation does, or a path such as /guards, or `METHOD /path`", tag: "only operations with this tag", method: "only this HTTP method", max: "operations listed, default 12", describe: "how many of the best to describe in full, default 1; 0 for none" },
  returns: "{verdict, found, operations:[{id, op, does, changes?, deprecated?}], described:[{id, op, runs, auth, parameters, body?, response, otherResponses?}]}",
  example: 'await scripts.run("find", { words: "list the guards", tag: "guards" })',
};

export default async function ({ api }, { words, tag, method, max = 12, describe = 1 } = {}) {
  const opts = { ...(tag ? { tag } : {}), ...(method ? { method } : {}) };
  let found = await api.find(words ?? "", { ...opts, max: 200 });
  // A concrete path such as /guards/7 belongs to /guards/{id}: put that operation first.
  if (/^(?:(?:get|post|put|patch|delete|head|options)\s+)?\/\S*$/i.test(String(words ?? "").trim())) {
    const exact = await api.describe(String(words).trim()).catch(() => null);
    if (exact) found = [{ id: exact.id, op: exact.op, does: exact.summary ?? "", ...(exact.changes ? { changes: true } : {}) }, ...found.filter((o) => o.id !== exact.id)];
  }
  const shown = found.slice(0, Number(max) || 12);
  const described = [];
  for (const o of shown.slice(0, Math.max(0, Number(describe))))
    described.push(await api.describe(o.id, { depth: 3 }));
  return {
    verdict: found.length ? `${plural(found.length, "operation")} fit${found.length === 1 ? "s" : ""} "${words ?? ""}"; best: ${shown[0].op} (${shown[0].id})` : `no operation fits "${words ?? ""}"; scripts.run("overview") lists the tags`,
    found: found.length,
    operations: shown,
    ...(found.length > shown.length ? { leftOut: found.length - shown.length } : {}),
    described,
  };
}
