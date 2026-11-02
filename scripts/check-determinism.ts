// Proves the WASM build of the sim is bit-identical to the native build:
// runs the same seeded scenario in both and compares state hashes.
// Usage: node scripts/check-determinism.ts [ticks]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ticks = Number(process.argv[2] ?? 3000);

const wasm = await import(new URL("../apps/client/src/wasm/sim.js", import.meta.url).href);
wasm.initSync({ module: readFileSync(new URL("../apps/client/src/wasm/sim_bg.wasm", import.meta.url)) });
const wasmHash: string = wasm.determinismHash(ticks);

const nativeHash = execFileSync("cargo", ["run", "-q", "--release", "-p", "devkit", "--", "determinism", String(ticks)], {
  cwd: root,
  encoding: "utf8",
}).trim();

console.log(`ticks=${ticks} native=${nativeHash} wasm=${wasmHash}`);
if (nativeHash !== wasmHash) {
  console.error("DETERMINISM BROKEN: native and WASM builds disagree");
  process.exit(1);
}
console.log("OK: native and WASM are bit-identical");
