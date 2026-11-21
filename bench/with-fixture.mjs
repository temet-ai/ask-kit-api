// Runs a command with the fixture API up, and stops the API when the command ends.
//   node bench/with-fixture.mjs                       runs bench/hold-check.mjs (no model)
//   node bench/with-fixture.mjs ask-kit kit test api   runs the bench (its questions call a model)
//   node bench/with-fixture.mjs ask-kit run api check  runs that command instead
// The command gets API_SPEC (bench/fixture/watch-api.yaml), API_BASE_URL (the fixture on a free
// port of 127.0.0.1) and API_TOKEN (the fixture's token) in its environment. Nothing real is called.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const token = "octarine-fixture-token";
const server = spawn(process.execPath, [path.join(here, "fixture", "server.mjs"), String(port)], { env: { ...process.env, WATCH_TOKEN: token }, stdio: ["ignore", "pipe", "inherit"] });
const stop = () => server.kill("SIGKILL");
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stop(), process.exit(130)));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.once("exit", () => reject(new Error("the fixture server ended before it listened")));
  server.stdout.once("data", resolve);
});

const [cmd, ...args] = process.argv.length > 2 ? process.argv.slice(2) : [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), "hold-check.mjs")];
const child = spawn(cmd, args, { stdio: "inherit", cwd: path.join(here, ".."), env: { ...process.env, API_SPEC: path.join(here, "fixture", "watch-api.yaml"), API_BASE_URL: `http://127.0.0.1:${port}`, API_TOKEN: token } });
const code = await new Promise((resolve) => {
  child.on("error", (e) => (console.error(e.message), resolve(127)));
  child.on("exit", (c, sig) => resolve(c ?? (sig ? 1 : 0)));
});
stop();
process.exit(code);
