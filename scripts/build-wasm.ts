// Builds crates/sim-wasm and generates the JS bindings the client imports.
// Usage: node scripts/build-wasm.ts [--dev]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./dev-lobby.ts";

const release = !process.argv.includes("--dev");
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });

run("cargo", ["build", "-p", "sim-wasm", "--target", "wasm32-unknown-unknown", ...(release ? ["--release"] : [])]);
const wasm = join(repoRoot, "target/wasm32-unknown-unknown", release ? "release" : "debug", "sim_wasm.wasm");
try {
  run("wasm-bindgen", [wasm, "--target", "web", "--out-dir", "apps/client/src/wasm", "--out-name", "sim"]);
} catch {
  const lock = readFileSync(join(repoRoot, "Cargo.lock"), "utf8");
  const version = /\nname = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1] ?? "<see Cargo.lock>";
  console.error(
    `\nwasm-bindgen failed. Install the CLI matching Cargo.lock:\n  cargo install wasm-bindgen-cli --version ${version} --locked\n`,
  );
  process.exit(1);
}
