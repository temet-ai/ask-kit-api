// Checks the rules of api.mjs against the fixture: what a read-only ask may send, that the
// credential never shows, that requests stay on the API's own address. Prints ok or BAD per case
// and exits 1 on any BAD. Run it with the fixture up:  node bench/with-fixture.mjs node bench/hold-check.mjs
import { make } from "../api.mjs";

const base = { API_SPEC: process.env.API_SPEC, API_BASE_URL: process.env.API_BASE_URL, API_TOKEN: process.env.API_TOKEN };
const TOKEN = base.API_TOKEN;
let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok " : "BAD"} ${name}${extra ? `  ${extra}` : ""}`);
};
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return String(e.message);
  }
};
const text = (x) => JSON.stringify(x);

const ro = make({ settings: base, act: false });
const rw = make({ settings: base, act: true });

// A read-only ask
check("GET runs", (await ro.call("getHealth")).status === 200);
check("a GET with the credential runs", (await ro.call("getGuard", { path: { id: "vimes" } })).status === 200);
check("POST that changes is held", /^not in this ask:/.test(await throws(() => ro.call("createIncident", { body: { title: "x", post: "yard" } })) ?? ""));
check("PATCH is held", /^not in this ask:/.test(await throws(() => ro.call("updateGuard", { path: { id: "vimes" }, body: { rank: "captain" } })) ?? ""));
check("DELETE is held", /^not in this ask:/.test(await throws(() => ro.call("DELETE /incidents/WATCH-1")) ?? ""));
check("a POST with no x-readonly mark is held", /^not in this ask:/.test(await throws(() => ro.call("searchGuards", { body: { name: "Vim" } })) ?? ""));
check("a POST marked x-readonly runs", (await ro.call("searchIncidents", { body: { words: "dragon" } })).status === 200);
check("pages refuses an operation that changes", /changes things/.test(await throws(() => ro.pages("createIncident")) ?? ""));
const posts = make({ settings: { ...base, API_READ_POSTS: "searchGuards" }, act: false });
check("API_READ_POSTS lets a named POST run", (await posts.call("searchGuards", { body: { name: "Vim" } })).status === 200);
check("the guard is still unchanged after the held calls", (await ro.call("getGuard", { path: { id: "vimes" } })).data.rank === "commander");

// The credential
const session = text(await ro.call("getSession"));
check("a field named token is redacted", !session.includes(TOKEN) && /"token":"<redacted>"/.test(session));
check("token_type is kept", /"token_type":"bearer"/.test(session));
const info = text(await ro.info());
check("info does not show the token", !info.includes(TOKEN) && /"credentialSet":true/.test(info));
const wrong = make({ settings: { ...base, API_TOKEN: "wrong-token-for-the-test" }, act: false });
const refused = await wrong.call("listPosts");
check("a 401 explains itself and shows no token", refused.status === 401 && /not accept the credential/.test(refused.hint) && !text(refused).includes("wrong-token-for-the-test"));
const none = make({ settings: { ...base, API_TOKEN: "" }, act: false });
check("no token set: the 401 hint says so", /no credential is set/.test((await none.call("listPosts")).hint ?? ""));
const q = make({ settings: { ...base, API_AUTH: "query:api_key" }, act: false });
const qa = text(await q.call("listPosts"));
check("a token sent in the query is not shown", !qa.includes(TOKEN) && /sent as query:api_key/.test(qa));
const e1 = await throws(() => ro.call("getHealth", { headers: { Authorization: "Bearer mine" } }));
check("the Authorization header cannot be set", /not allowed/.test(e1 ?? ""));
const dead = make({ settings: { ...base, API_BASE_URL: "http://127.0.0.1:9", API_TOKEN: "dead-port-token-123" }, act: false });
const gone = await dead.call("getHealth");
check("nothing listening: status null with a hint", gone.status === null && /is the API running/.test(gone.hint) && !text(gone).includes("dead-port-token-123"));
const withPw = make({ settings: { ...base, API_BASE_URL: "http://watch:hunter2secret@127.0.0.1:9" }, act: false });
check("a password in API_BASE_URL is not shown", !text(await withPw.call("getHealth")).includes("hunter2secret"));

// Where requests go
check("a full URL on another host is refused", /not this API's address/.test(await throws(() => ro.get("http://other.invalid/guards")) ?? ""));
const hop = await ro.get("/elsewhere");
check("a redirect to another host is not followed", hop.status === 302 && /not its own address/.test(hop.note ?? ""));
check("api.document cannot send requests", typeof ro.document(base.API_SPEC).call === "undefined");

// Acting
const made = await rw.call("createIncident", { body: { title: "A test report", post: "yard" } });
check("act: POST runs", made.status === 201 && /^WATCH-\d+$/.test(made.data.id), made.data?.id);
check("act: the new incident reads back", (await rw.call("getIncident", { path: { id: made.data.id } })).data.title === "A test report");
check("act: DELETE runs", (await rw.call("deleteIncident", { path: { id: made.data.id } })).status === 204);
check("act: it is gone", (await rw.call("getIncident", { path: { id: made.data.id } })).status === 404);

// Failures that are answers
check("an unknown operation throws with the nearest", /nearest: .*getGuard/.test(await throws(() => ro.call("getGuards")) ?? ""));
check("a missing path parameter throws before sending", /needs path\.id/.test(await throws(() => ro.call("getGuard", {})) ?? ""));
check("a 404 is an answer", (await ro.call("getGuard", { path: { id: "nobody" } })).status === 404);
check("a missing document says what to set", /set API_SPEC/.test(await throws(() => make({ settings: {}, act: false }).info()) ?? ""));
process.exit(bad ? 1 : 0);
