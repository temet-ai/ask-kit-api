export const meta = {
  purpose: "Whether the API answers and whether the credential works: it tries the cheapest reading operations (an open one such as /health, then one that takes the credential) and says what came back. The answer to 'is the API up', 'does my token work', 'why do I get 401'.",
  params: {},
  returns: "{verdict, address, credentialSet, tried:[{op, takesCredential, status, ok, ms, hint?, error?}]}",
  example: 'await scripts.run("check")',
};

export default async function ({ api }) {
  const info = await api.info();
  const probes = await api.probes();
  const picks = [...probes.open.slice(0, 1), ...probes.guarded.slice(0, 2)];
  const tried = await Promise.all(picks.map(async (p) => {
    const r = await api.call(p.id, {});
    return { op: r.op, takesCredential: p.takesCredential, status: r.status, ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error } : {}), ...(r.hint ? { hint: r.hint } : {}) };
  }));
  const answered = tried.some((t) => t.status != null);
  const guarded = tried.filter((t) => t.takesCredential);
  const good = guarded.find((t) => t.ok);
  const refused = guarded.find((t) => t.status === 401 || t.status === 403);
  const verdict = !tried.length ? "the document has no reading operation without required parameters to try"
    : !answered ? `nothing answers at ${info.baseUrl ?? "(no address)"}: ${tried[0].error ?? "no connection"}`
    : good ? `the API answers and accepts the credential: ${good.op} answered ${good.status}`
    : refused ? `the API answers and refuses the credential: ${refused.op} answered ${refused.status}`
    : guarded.length ? `the API answers; the operations that need the credential gave ${guarded.map((t) => t.status).join(", ")}`
    : `the API answers; no operation to test the credential with`;
  return { verdict, address: info.baseUrl, credentialSet: info.auth?.credentialSet, tried, ...(info.baseUrlProblem ? { problem: info.baseUrlProblem } : {}) };
}
