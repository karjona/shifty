// `pnpm dev`: everything needed to play locally, in one command.
//  1. creates the dev lobby key (.dev/lobby-key.json) if missing
//  2. builds the WASM sim for the browser
//  3. builds and runs the race server (WebTransport on UDP :4433)
//  4. runs the Vite dev server (http://localhost:5173), which also stands in
//     for the lobby by handing out signed join tickets
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { ensureDevKey, repoRoot } from "./dev-lobby.ts";

const RACE_PORT = process.env.RACE_PORT ?? "4433";
const key = ensureDevKey();

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
}

const run = (name: string, color: number, cmd: string, args: string[], { cwd = repoRoot, env = {} }: RunOptions) => {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `\x1b[${color}m${name.padEnd(6)}\x1b[0m│ `;
  const pipe = (data: Buffer) => {
    for (const line of data.toString().split("\n")) if (line.trim()) console.log(prefix + line);
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  child.on("exit", (code, signal) => {
    const stopped = shuttingDown || signal === "SIGINT" || signal === "SIGTERM";
    if (!stopped) console.log(`${prefix}exited (${code ?? signal})`);
    shutdown(stopped || code === 0 ? 0 : 1);
    if (!children.some(running)) process.exit(exitCode);
  });
  children.push(child);
};

run("race", 36, "target/debug/race-server", [], {
  env: {
    LOBBY_PUBLIC_KEY: key.publicKey,
    PUBLIC_ADDR: `localhost:${RACE_PORT}`,
    BIND: `[::]:${RACE_PORT}`,
    REGION: "dev",
    DRAIN_TIMEOUT_SECS: "1",
    RUST_LOG: process.env.RUST_LOG ?? "info",
  },
});
run("vite", 35, process.execPath, ["node_modules/vite/bin/vite.js"], {
  cwd: join(repoRoot, "apps/client"),
  env: { RACE_SERVER: `localhost:${RACE_PORT}` },
});

console.log(`
  ▸ open http://localhost:5173/?name=YourName in two browser windows
    URL options: name, room, bots (0-7), surface (0 flat, 1 swells),
                 scale (0.25-1),
                 water=basic (plain swells, for slow machines)
`);
