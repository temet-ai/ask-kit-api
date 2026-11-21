export const meta = {
  purpose: "One operation in full: what it does, whether it changes anything, how the credential is sent, each parameter (where it goes, type, required, default), the request body and the response as a typed shape, and the other status codes. Also one named schema.",
  params: { op: "an operationId, `METHOD /path` or a path (a concrete path such as /guards/7 is matched to /guards/{id})", schema: "a schema name from the document instead of an operation", depth: "levels of nested objects shown, default 3" },
  returns: "{verdict, ...operation} (id, op, summary, changes, runs, auth, parameters, body?, response, otherResponses?) or {name, shape} for a schema",
  example: 'await scripts.run("describe", { op: "createIncident" })',
};

export default async function ({ api }, { op, schema, depth = 3 } = {}) {
  if (schema) {
    const s = await api.schema(schema, { depth: Number(depth) });
    return { verdict: `schema ${s.name}`, ...s };
  }
  if (!op) throw new Error("describe needs `op` (an operationId, `METHOD /path` or a path) or `schema`");
  const d = await api.describe(op, { depth: Number(depth) });
  return { verdict: `${d.op}: ${d.changes ? "changes things" : "reads"}; ${d.parameters.length} parameters${d.body ? ", takes a body" : ""}; answers ${d.response?.status ?? "no documented status"}`, ...d };
}
