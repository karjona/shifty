import { defineConfig, type Plugin } from "vite";
import { devJoinTicket } from "../../scripts/dev-lobby.ts";

// Where the race server listens in dev. Clients reach it directly; this is
// also the audience their join tokens are signed for.
const RACE_SERVER = process.env.RACE_SERVER ?? "localhost:4433";

/**
 * Dev-only lobby: `GET /__dev/join?name=..&room=..&bots=..&surface=..` returns
 * a join ticket: a signed join token, the race server URL and (hash mode) its
 * certificate hash. Not part of builds.
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
          const hash =
            typeof body === "object" && body !== null && "hash" in body && typeof body.hash === "string"
              ? body.hash
              : null;
          const { token, claims } = devJoinTicket(RACE_SERVER, {
            name: q.get("name") || "Rider",
            room: q.get("room") || "dev",
            bots: Number(q.get("bots") ?? 2),
            surface: Number(q.get("surface") ?? 1),
            pid: q.get("pid") || undefined,
          });
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              token,
              room: claims.room,
              webTransportUrl: `https://${RACE_SERVER}/race`,
              certHash: hash,
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

export default defineConfig({
  plugins: [devLobby()],
  server: { port: 5173, strictPort: true },
  build: { target: "es2024" },
});
