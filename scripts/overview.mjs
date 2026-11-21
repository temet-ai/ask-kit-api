export const meta = {
  purpose: "What the API is: its title and version, the address requests go to, how the credential is sent, how many operations it has (and how many change things), its tags with their operation counts, and the cheapest operations to try. Start here for 'what does this API do' and 'what is in it'.",
  params: { tags: "tags listed, default 30" },
  returns: "{verdict, title, version, document, about?, baseUrl, auth:{sentAs, from, credentialSet}, operations, reads, changes, tags:[{tag, operations, reads, changes, about?}], tryFirst:{open:[...], guarded:[...]}}",
  example: 'await scripts.run("overview")',
};

export default async function ({ api }, { tags = 30 } = {}) {
  const info = await api.info();
  const probes = await api.probes();
  const all = info.tags ?? [];
  const n = Number(tags) || 30;
  const { tags: _t, ...rest } = info;
  return {
    verdict: `${info.title || "an API"} ${info.version ?? ""}: ${info.operations} operations (${info.reads} read, ${info.changes} change things) in ${all.length} tags; requests go to ${info.baseUrl ?? "no address (API_BASE_URL is not set)"}`.replace(/\s+/g, " "),
    ...rest,
    tags: all.slice(0, n),
    ...(all.length > n ? { moreTags: all.length - n } : {}),
    tryFirst: { open: probes.open, guarded: probes.guarded },
  };
}
