// `pnpm dev`: everything needed to play locally, in one command.
//  1. creates the dev keys and secrets (.dev/) if missing
//  2. starts Postgres (see dev-db.ts), migrates it and seeds menu content
//  3. builds the WASM sim for the browser
//  4. runs the lobby Worker (wrangler dev, http://127.0.0.1:8787)
//  5. builds and runs the race server (WebTransport on UDP :4433), which
//     reports to the lobby
//  6. once the race server has registered, runs the Vite dev server
//     (http://localhost:5173): the game, with /api proxied to the lobby, and
//     dev-only quick join tickets for tests
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDatabase } from "./dev-db.ts";
import { ensureDevKey, repoRoot } from "./dev-lobby.ts";

const RACE_PORT = process.env.RACE_PORT ?? "4433";
const LOBBY_PORT = process.env.LOBBY_PORT ?? "8787";
const key = ensureDevKey();

/** Dev secrets, made once and kept in .dev/ (gitignored). */
function devSecrets(): { betterAuth: string; raceServer: string } {
  const path = join(repoRoot, ".dev", "lobby-secrets.json");
  if (existsSync(path)) {
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof saved === "object" &&
      saved !== null &&
      "betterAuth" in saved &&
      "raceServer" in saved &&
      typeof saved.betterAuth === "string" &&
      typeof saved.raceServer === "string"
    ) {
      return { betterAuth: saved.betterAuth, raceServer: saved.raceServer };
    }
  }
  const secrets = {
    betterAuth: randomBytes(32).toString("base64url"),
    raceServer: randomBytes(32).toString("base64url"),
  };
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return secrets;
}
const secrets = devSecrets();

console.log("▸ starting Postgres…");
const databaseUrl = await ensureDatabase();
const lobbyDir = join(repoRoot, "apps/lobby");
const dbEnv = { ...process.env, DATABASE_URL: databaseUrl };
execFileSync(process.execPath, ["scripts/migrate.ts"], { cwd: lobbyDir, stdio: "inherit", env: dbEnv });
execFileSync(process.execPath, ["scripts/seed.ts"], { cwd: lobbyDir, stdio: "inherit", env: dbEnv });

// The lobby's settings: generated ones first, then .dev/lobby.env (your
// GitHub OAuth app, if any) overrides them.
const lobbyEnv = join(repoRoot, ".dev", "lobby.generated.env");
writeFileSync(
  lobbyEnv,
  Object.entries({
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: "http://localhost:5173",
    BETTER_AUTH_SECRET: secrets.betterAuth,
    LOBBY_SIGNING_KEY: key.privateKey,
    RACE_SERVER_SECRET: secrets.raceServer,
    MAIL_MODE: "console",
    DEV_MAILBOX: "1",
    SIGNUPS: process.env.SIGNUPS ?? "open",
    MATCH_WAIT_SECS: process.env.MATCH_WAIT_SECS ?? "10",
  })
    .map(([k, v]) => `${k}=${v}\n`)
    .join(""),
  { mode: 0o600 },
);
const userEnv = join(repoRoot, ".dev", "lobby.env");

console.log("▸ building WASM sim…");
execFileSync("node", ["scripts/build-wasm.ts"], { cwd: repoRoot, stdio: "inherit" });
console.log("▸ building race server…");
execFileSync("cargo", ["build", "-p", "race-server"], { cwd: repoRoot, stdio: "inherit" });

const children: ChildProcess[] = [];
const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

let shuttingDown = false;
let exitCode = 0;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  for (const c of children) if (running(c)) c.kill("SIGTERM");
  if (!children.some(running)) process.exit(exitCode);
  setTimeout(() => process.exit(exitCode), 3000).unref();
}
// Ctrl-C signals the whole process group: the children stop on their own and
// this script waits for them before exiting.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => shutdown());

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Sees every whole line the process prints. */
  onLine?: (line: string) => void;
}

const run = (
  name: string,
  color: number,
  cmd: string,
  args: string[],
  { cwd = repoRoot, env = {}, onLine }: RunOptions,
) => {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `\x1b[${color}m${name.padEnd(6)}\x1b[0m│ `;
  const pipe = () => {
    let partial = "";
    return (data: Buffer) => {
      const lines = (partial + data.toString()).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(line);
        // Race servers check in every few seconds; that's noise in dev.
        if (line.trim() && !line.includes("POST /api/servers/heartbeat 200")) console.log(prefix + line);
      }
    };
  };
  child.stdout?.on("data", pipe());
  child.stderr?.on("data", pipe());
  child.on("exit", (code, signal) => {
    const stopped = shuttingDown || signal === "SIGINT" || signal === "SIGTERM";
    if (!stopped) console.log(`${prefix}exited (${code ?? signal})`);
    shutdown(stopped || code === 0 ? 0 : 1);
    if (!children.some(running)) process.exit(exitCode);
  });
  children.push(child);
};

run(
  "lobby",
  33,
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--port",
    LOBBY_PORT,
    "--ip",
    "127.0.0.1",
    "--persist-to",
    join(repoRoot, ".dev", "wrangler"),
    "--show-interactive-dev-session=false",
    "--env-file",
    lobbyEnv,
    ...(existsSync(userEnv) ? ["--env-file", userEnv] : []),
  ],
  { cwd: lobbyDir, env: { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl } },
);
// The game only opens once the race server has registered: until then the
// lobby may still hand out tickets for the race server of an earlier run,
// whose certificate is gone.
let viteStarted = false;
function startVite() {
  viteStarted = true;
  run("vite", 35, process.execPath, ["node_modules/vite/bin/vite.js"], {
    cwd: join(repoRoot, "apps/client"),
    env: { RACE_SERVER: `localhost:${RACE_PORT}`, LOBBY: `http://127.0.0.1:${LOBBY_PORT}` },
  });
  console.log(`
  ▸ open http://localhost:5173 (sign-in codes show up in the lobby log)
    quick race without the menus: http://localhost:5173/?name=YourName
    URL options: name, room, bots (0-7), event (snow), surface (0-3),
                 scale (0.25-1), water=basic (plain swells, for slow machines)
`);
}

console.log("▸ waiting for the race server to register with the lobby…");
run("race", 36, "target/debug/race-server", [], {
  env: {
    LOBBY_PUBLIC_KEY: key.publicKey,
    LOBBY_URL: `http://127.0.0.1:${LOBBY_PORT}`,
    RACE_SERVER_SECRET: secrets.raceServer,
    PUBLIC_ADDR: `localhost:${RACE_PORT}`,
    BIND: `[::]:${RACE_PORT}`,
    REGION: "dev",
    DRAIN_TIMEOUT_SECS: "1",
    RUST_LOG: process.env.RUST_LOG ?? "info",
  },
  onLine: (line) => {
    if (!viteStarted && line.includes("registered with the lobby")) startVite();
  },
});
