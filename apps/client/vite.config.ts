import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { devJoinTicket, repoRoot } from "../../scripts/dev-lobby.ts";
import pkg from "./package.json" with { type: "json" };

// Where the race server listens in dev. Clients reach it directly; this is
// also the audience their join tokens are signed for.
const RACE_SERVER = process.env.RACE_SERVER ?? "localhost:4433";
/** The lobby Worker in dev (wrangler dev); the game's `/api` goes there. */
const LOBBY = process.env.LOBBY ?? "http://127.0.0.1:8787";

/** A number from the query, or undefined if absent or not a whole number. */
const whole = (q: URLSearchParams, k: string): number | undefined => {
  const v = q.get(k);
  return v !== null && /^\d+$/u.test(v) ? Number(v) : undefined;
};

/**
 * Dev-only quick join (`/?name=You` and the netcode tests skip the menus):
 * `GET /__dev/join?name=..&room=..&bots=..&surface=..&tilt=1` (the Tilt) or
 * `..&course=..&season=..&weather=..&turns=..&time=..&seed=..` (one race,
 * each left out to be drawn) returns a join ticket: a token signed with the
 * dev lobby key, the race server URL and (hash mode) its certificate hashes.
 * Not part of builds.
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
            tilt: q.get("tilt") === "1",
            race: Object.fromEntries(
              (["course", "season", "weather", "turns", "time"] as const).flatMap((k) => {
                const v = whole(q, k);
                return v === undefined ? [] : [[k, v]];
              }),
            ),
            seed: whole(q, "seed"),
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
  [/Shifty sound board/u, "the dev sound board"],
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

/** The folders of public/ that hold the game's art. */
const ART_DIRS = ["riders", "rides", "env"];
const ART_ID = "virtual:art";

/**
 * `virtual:art`: every file of the art in public/ (by path, e.g.
 * `riders/male/body.glb`) with its size in bytes and, in builds, a hash of
 * its content. Loaders know what exists and how big it is before asking,
 * and ask for a file by its hash, so a browser keeps it until it changes
 * (see public/_headers).
 */
const art = (): Plugin => {
  let root = "";
  let hashed = false;
  const list = () => {
    const files: Record<string, [number, string]> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const st = statSync(file);
        if (st.isDirectory()) walk(file);
        else if (!name.startsWith(".")) {
          const hash = hashed ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10) : "";
          files[relative(root, file).split(sep).join("/")] = [st.size, hash];
        }
      }
    };
    for (const dir of ART_DIRS) walk(join(root, dir));
    return files;
  };
  return {
    name: "shifty-art",
    configResolved(config) {
      root = config.publicDir;
      hashed = config.command === "build";
    },
    resolveId: (id) => (id === ART_ID ? `\0${ART_ID}` : null),
    load: (id) => (id === `\0${ART_ID}` ? `export default ${JSON.stringify(list())};` : null),
    configureServer(server) {
      // Art built while the dev server runs: the list follows, and the page reloads.
      const changed = (file: string) => {
        const rel = relative(root, file);
        if (rel.startsWith("..") || !ART_DIRS.includes(rel.split(sep)[0] ?? "")) return;
        const mod = server.moduleGraph.getModuleById(`\0${ART_ID}`);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);
    },
  };
};

/**
 * The boot's download plan, put in the page: the game's code (the chunk
 * behind main.tsx's `import("./start.tsx")`, its imports and styles) and
 * the WASM sim, each with its size, so the boot screen can count them in
 * as they come (main.tsx). Builds only: the dev server serves modules one
 * by one.
 */
const bootPlan = (): Plugin => ({
  name: "shifty-boot-plan",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler(_html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) return [];
      const chunks = Object.values(bundle).filter((f) => f.type === "chunk");
      const start = chunks.find((c) => c.facadeModuleId?.endsWith("/src/start.tsx"));
      const entry = chunks.find((c) => c.isEntry);
      if (!start) return [];
      const files = new Set<string>();
      const add = (name: string) => {
        if (files.has(name) || name === entry?.fileName) return;
        files.add(name);
        const chunk = bundle[name];
        if (chunk?.type !== "chunk") return;
        for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(css);
        for (const i of chunk.imports) add(i);
      };
      add(start.fileName);
      for (const f of Object.values(bundle))
        if (f.type === "asset" && f.fileName.endsWith(".wasm")) files.add(f.fileName);
      const sizeOf = (name: string) => {
        const f = bundle[name];
        if (!f) return 0;
        return f.type === "chunk"
          ? Buffer.byteLength(f.code)
          : typeof f.source === "string"
            ? Buffer.byteLength(f.source)
            : f.source.byteLength;
      };
      const plan = [...files].map((f) => [`/${f}`, sizeOf(f)]);
      // The fonts the boot screen's wordmark is set in come first: no flash of another face.
      const fonts = Object.values(bundle)
        .filter((f) => f.type === "asset" && /archivo-latin-wdth-(normal|italic)-.*\.woff2$/u.test(f.fileName))
        .map((f) => ({
          tag: "link",
          attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: `/${f.fileName}` },
          injectTo: "head" as const,
        }));
      return [
        ...fonts,
        {
          tag: "script",
          attrs: { type: "application/json", id: "boot-plan" },
          children: JSON.stringify(plan),
          injectTo: "head",
        },
      ];
    },
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
  plugins: [react(), art(), bootPlan(), devLobby(), noDevCode(), rustNotices()],
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
