// The Watch API of watch-api.yaml, on 127.0.0.1, for trying the api kit by hand.
//   node bench/fixture/server.mjs [port]        (default 8765)
// It wants `Authorization: Bearer <WATCH_TOKEN>`; the default token is octarine-fixture-token.
// Everything lives in memory and is gone when the server stops. Nothing here is real.
import http from "node:http";

const port = Number(process.argv[2] ?? process.env.PORT ?? 8765);
const TOKEN = process.env.WATCH_TOKEN ?? "octarine-fixture-token";
const ELSEWHERE = process.env.WATCH_ELSEWHERE ?? "http://patrician.invalid/office";

const posts = [
  { id: "yard", name: "Pseudopolis Yard", district: "Isle of Gods" },
  { id: "treacle", name: "Treacle Mine Road", district: "The Shades" },
  { id: "cable", name: "Cable Street", district: "Dolly Sisters" },
];
const post = (id) => posts.find((p) => p.id === id) ?? null;
const g = (id, name, badge, rank, species, at, joined) => ({ id, name, badge, rank, species, post: post(at), joined, locker_password: `${id}-swordfish` });
const guards = [
  g("vimes", "Sam Vimes", 177, "commander", "human", "yard", "1955-03-01"),
  g("carrot", "Carrot Ironfoundersson", 902, "captain", "human", "yard", "1985-05-25"),
  g("angua", "Angua von Uberwald", 911, "sergeant", "werewolf", "yard", "1988-08-15"),
  g("colon", "Fred Colon", 310, "sergeant", "human", "yard", "1950-06-12"),
  g("detritus", "Detritus", 913, "sergeant", "troll", "treacle", "1988-08-15"),
  g("littlebottom", "Cheery Littlebottom", 934, "sergeant", "dwarf", "yard", "1990-02-02"),
  g("nobbs", "Nobby Nobbs", 322, "corporal", "human (certified)", "yard", "1952-11-30"),
  g("swires", "Buggy Swires", 951, "corporal", "gnome", "cable", "1993-04-09"),
  g("shoe", "Reg Shoe", 940, "constable", "zombie", "treacle", "1991-10-31"),
  g("dorfl", "Dorfl", 945, "constable", "golem", "cable", "1992-01-20"),
  g("visit", "Visit-the-Infidel-with-Explanatory-Pamphlets", 921, "constable", "human", "cable", "1989-07-07"),
  g("humpeding", "Sally von Humpeding", 977, "lance-constable", "vampire", "yard", "1999-09-09"),
];
const patrols = [
  { id: 1, beat: "The Shades", shift: "night", guards: ["detritus", "shoe"] },
  { id: 2, beat: "Short Street", shift: "day", guards: ["colon", "nobbs"] },
  { id: 3, beat: "The Brass Bridge", shift: "day", guards: ["colon"] },
  { id: 4, beat: "Treacle Mine Road", shift: "night", guards: ["angua", "humpeding"] },
  { id: 5, beat: "Cable Street", shift: "day", guards: ["visit", "dorfl"] },
  { id: 6, beat: "The Plaza of Broken Moons", shift: "night", guards: ["carrot"] },
  { id: 7, beat: "Elm Street", shift: "day", guards: ["swires"] },
];
const titles = ["A stolen sausage-inna-bun cart", "Unlicensed thieving on Short Street", "A dragon over the Shades", "Clacks tower tampered with", "Brawl at the Mended Drum", "Golem walking without a chem", "Counterfeit stamps at the Post Office", "A missing Librarian's banana", "Troll and dwarf dispute on Koom Valley Day", "Burglary at the Royal Art Museum", "Arson at the Dwarf Bread Museum", "Suspicious pies near the Cattle Market"];
const incidents = titles.map((title, k) => ({ title, post: posts[k % 3].id, reported_by: guards[(k * 5) % 12].id, id: `WATCH-${k + 1}`, status: k % 3 === 0 ? "closed" : "open", opened: `1998-${String(k + 1).padStart(2, "0")}-14T09:30:00Z`, assigned_to: k % 4 === 3 ? null : guards[(k * 7) % 12] }));
let nextIncident = incidents.length + 1;

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve(null);
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const q = u.searchParams;
  const send = (status, body, headers = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { ...(text ? { "Content-Type": "application/json" } : {}), "X-Watch-House": "Pseudopolis Yard", "Set-Cookie": "watch_session=treacle; HttpOnly", ...headers });
    res.end(text);
  };
  const notFound = (what) => send(404, { error: "not_found", message: `no ${what} with that id` });
  const route = `${req.method} ${u.pathname.replace(/\/+$/, "") || "/"}`;
  let m;

  if (route === "GET /health") return send(200, { status: "ok", city: "Ankh-Morpork" });
  if (route === "GET /elsewhere") return send(302, undefined, { Location: ELSEWHERE });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorised", message: req.headers.authorization ? "that token was not issued by the Watch" : "a bearer token is needed" }, { "WWW-Authenticate": 'Bearer realm="watch"' });

  if (route === "GET /session") return send(200, { guard: "Sam Vimes", token: TOKEN, api_key: "ak_treacle_mine_road", token_type: "bearer" });

  if (route === "GET /guards") {
    let rows = guards.filter((x) => (!q.get("rank") || x.rank === q.get("rank")) && (!q.get("post") || x.post?.id === q.get("post")));
    const per = Math.min(Number(q.get("per_page")) || 5, 50);
    const page = Math.max(Number(q.get("page")) || 1, 1);
    const total = rows.length;
    rows = rows.slice((page - 1) * per, page * per);
    const headers = { "X-Total-Count": String(total) };
    const link = (p, rel) => {
      const n = new URL(u);
      n.searchParams.set("page", String(p));
      return `<${n.href}>; rel="${rel}"`;
    };
    const links = [];
    if (page * per < total) links.push(link(page + 1, "next"));
    if (page > 1) links.push(link(page - 1, "prev"));
    if (links.length) headers.Link = links.join(", ");
    return send(200, rows, headers);
  }
  if (route === "POST /guards/search") {
    const b = await readBody(req);
    if (!b) return send(400, { error: "bad_request", message: "the body is not JSON" });
    return send(200, { results: guards.filter((x) => (!b.name || x.name.toLowerCase().includes(String(b.name).toLowerCase())) && (!b.rank || x.rank === b.rank) && (!b.species || x.species.includes(b.species))) });
  }
  if ((m = /^(GET|PATCH) \/guards\/([^/]+)$/.exec(route))) {
    const guard = guards.find((x) => x.id === decodeURIComponent(m[2]));
    if (!guard) return notFound("guard");
    if (m[1] === "PATCH") {
      const b = await readBody(req);
      if (!b) return send(400, { error: "bad_request", message: "the body is not JSON" });
      if (b.rank) guard.rank = b.rank;
      if (b.post) guard.post = post(b.post) ?? guard.post;
    }
    return send(200, guard);
  }
  if (route === "GET /posts") return send(200, { items: posts });
  if (route === "GET /patrols") {
    const rows = patrols.filter((x) => !q.get("shift") || x.shift === q.get("shift"));
    const offset = Number(q.get("offset")) || 0;
    const limit = Number(q.get("limit")) || 3;
    return send(200, { total: rows.length, offset, limit, patrols: rows.slice(offset, offset + limit) });
  }
  if (route === "GET /incidents") {
    const rows = incidents.filter((x) => !q.get("status") || x.status === q.get("status")).reverse();
    const limit = Number(q.get("limit")) || 4;
    const start = q.get("cursor") ? Number(Buffer.from(q.get("cursor"), "base64url").toString()) || 0 : 0;
    const end = start + limit;
    return send(200, { data: rows.slice(start, end), next_cursor: end < rows.length ? Buffer.from(String(end)).toString("base64url") : null });
  }
  if (route === "POST /incidents") {
    const b = await readBody(req);
    if (!b || !b.title || !post(b.post)) return send(400, { error: "bad_request", message: "a report needs a title and a known post" });
    const row = { title: String(b.title), post: b.post, reported_by: b.reported_by ?? null, id: `WATCH-${nextIncident++}`, status: "open", opened: new Date().toISOString(), assigned_to: null };
    incidents.push(row);
    return send(201, row, { Location: `/incidents/${row.id}` });
  }
  if (route === "POST /incidents/search") {
    const b = await readBody(req);
    if (!b || !b.words) return send(400, { error: "bad_request", message: "words are needed" });
    const words = String(b.words).toLowerCase().split(/\s+/);
    return send(200, { results: incidents.filter((x) => words.every((w) => x.title.toLowerCase().includes(w)) && (!b.status || x.status === b.status)) });
  }
  if ((m = /^(GET|DELETE) \/incidents\/([^/]+)$/.exec(route))) {
    const k = incidents.findIndex((x) => x.id === decodeURIComponent(m[2]));
    if (k < 0) return notFound("incident");
    if (m[1] === "DELETE") {
      incidents.splice(k, 1);
      return send(204);
    }
    return send(200, incidents[k]);
  }
  return send(404, { error: "not_found", message: `the Watch has no ${route}` });
});

server.listen(port, "127.0.0.1", () => console.log(`the Watch API listens on http://127.0.0.1:${port} (bearer token: ${process.env.WATCH_TOKEN ? "the value of WATCH_TOKEN" : TOKEN})`));
