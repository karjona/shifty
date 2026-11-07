import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { devJoinTicket, repoRoot } from "../../scripts/dev-lobby.ts";
import pkg from "./package.json" with { type: "json" };

// Where the race server listens in dev. Clients reach it directly; this is
// also the audience their join tokens are signed for.
const RACE_SERVER = process.env.RACE_SERVER ?? "localhost:4433";
/** The lobby Worker in dev (wrangler dev); the game's `/api` goes there. */
const LOBBY = process.env.LOBBY ?? "http://127.0.0.1:8787";

/**
 * Dev-only quick join (`/?name=You` and the netcode tests skip the menus):
 * `GET /__dev/join?name=..&room=..&bots=..&surface=..&course=..` returns a
 * join ticket: a token signed with the dev lobby key, the race server URL
 * and (hash mode) its certificate hashes. Not part of builds.
 */
const devLobby = (): Plugin => ({
  name: "shifty-dev-lobby",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__dev/join", (req, res) => {
      void (async () => {
        try {
          const q = new URL(req.url ?? "", "http://x").searchParams;
          const body: unknown = await (await fetch(`http://${RACE_SERVER}/cert-hash`)).json();
          const hashes: unknown = typeof body === "object" && body !== null && "hashes" in body ? body.hashes : null;
          const certHashes = Array.isArray(hashes) ? hashes.filter((h) => typeof h === "string") : [];
          const { token, claims } = devJoinTicket(RACE_SERVER, {
            name: q.get("name") || "Rider",
            room: q.get("room") || "dev",
            bots: Number(q.get("bots") ?? 2),
            surface: Number(q.get("surface") ?? 1),
            course: Number(q.get("course") ?? 0),
            events: (q.get("events") ?? "").split(",").filter(Boolean).map(Number),
            pid: q.get("pid") || undefined,
          });
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              token,
              room: claims.room,
              webTransportUrl: `https://${RACE_SERVER}/race`,
              version: pkg.version,
              certHashes,
            }),
          );
        } catch (e) {
          res.statusCode = 502;
          res.end(`race server not reachable at ${RACE_SERVER}: ${String(e)}`);
        }
      })();
    });
  },
});

/** Dev-only code a build must not contain, and what it is. */
const DEV_ONLY: [RegExp, string][] = [
  [/\/__dev\//u, "the quick race (it fetches /__dev/join)"],
  [/__shifty/u, "the e2e test hooks (window.__shifty)"],
  [/__celFly/u, "the flyover capture hook (window.__celFly)"],
  [/Shifty debug \(F1\)/u, "the netcode debug panel"],
  [/URLSearchParams\(\s*(?:window\.|globalThis\.|self\.)?location\.search/u, "a read of the page's URL query"],
  [/dev-params-read-in-a-build/u, "a URL switch read outside import.meta.env.DEV (dev-params.ts)"],
];

/**
 * Fails the build if dev-only code made it into the bundle. URL switches
 * are dev-only too: in a build, dev-params.ts is empty and nothing else may
 * read the query (the router reads only its own routes).
 */
const noDevCode = (): Plugin => ({
  name: "shifty-no-dev-code",
  apply: "build",
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      const text = file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "";
      for (const [pattern, what] of DEV_ONLY) {
        if (pattern.test(text)) this.error(`${file.fileName} contains dev-only code: ${what}`);
      }
    }
  },
});

/**
 * Emits `licenses/rust.md`: the license notices of the Rust crates compiled
 * into the WASM sim. Needs `cargo-about` (version pinned in CI).
 */
const rustNotices = (): Plugin => ({
  name: "shifty-rust-notices",
  apply: "build",
  generateBundle() {
    let source: string;
    try {
      source = execFileSync(
        "cargo",
        [
          "about",
          "generate",
          "--locked",
          "--fail",
          "--manifest-path",
          "crates/sim-wasm/Cargo.toml",
          "--target",
          "wasm32-unknown-unknown",
          "about.hbs",
        ],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
    } catch (e) {
      this.error(
        `cargo-about failed (install it with \`cargo install cargo-about --locked --features cli\`): ${String(e)}`,
      );
    }
    this.emitFile({ type: "asset", fileName: "licenses/rust.md", source });
  },
});

const LOBBY_ORIGIN = process.env.LOBBY_ORIGIN;

type ProxyReq = { setHeader: (k: string, v: string) => void };

/** Proxy setup that sends every request and socket upgrade with the given Origin. */
function asOrigin(origin: string) {
  return (proxy: { on: (e: string, f: (req: ProxyReq) => void) => void }) => {
    proxy.on("proxyReq", (req) => req.setHeader("origin", origin));
    proxy.on("proxyReqWs", (req) => req.setHeader("origin", origin));
  };
}

export default defineConfig({
  plugins: [react(), devLobby(), noDevCode(), rustNotices()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: LOBBY,
        ws: true,
        // A checkout on another port speaks to the shared dev lobby as its origin.
        ...(LOBBY_ORIGIN ? { configure: asOrigin(LOBBY_ORIGIN) } : {}),
      },
    },
  },
  build: { target: "es2024", license: { fileName: "licenses/npm.md" } },
});
