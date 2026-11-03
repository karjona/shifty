// Dev Postgres: DATABASE_URL if set (CI), otherwise a container named
// `shifty-postgres` (Apple `container` or Docker) with its data in the
// `shifty-pgdata` volume. It keeps running after `pnpm dev` stops.
import { execFileSync, spawnSync } from "node:child_process";
import { Client } from "pg";

const NAME = "shifty-postgres";
const VOLUME = "shifty-pgdata";
const IMAGE = "docker.io/library/postgres:17-alpine";
const PORT = 54329;
export const DEV_DATABASE_URL = `postgres://shifty:shifty@127.0.0.1:${PORT}/shifty`;

const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

function runtime(): string {
  if (has("container")) return "container";
  if (has("docker")) return "docker";
  throw new Error("Postgres for dev needs Apple `container` or Docker (or set DATABASE_URL)");
}

function state(rt: string): "running" | "stopped" | "missing" {
  const out = spawnSync(rt, ["inspect", NAME], { encoding: "utf8" });
  if (out.status !== 0 || !out.stdout.trim() || out.stdout.trim() === "[]") return "missing";
  return /"(status|Status)"\s*:\s*"running"/u.test(out.stdout) || /"Running"\s*:\s*true/u.test(out.stdout)
    ? "running"
    : "stopped";
}

async function waitReady(url: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const client = new Client({ connectionString: url });
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await client.connect();
      // oxlint-disable-next-line eslint/no-await-in-loop
      await client.query("select 1");
      // oxlint-disable-next-line eslint/no-await-in-loop
      await client.end();
      return;
    } catch (e) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await client.end().catch(() => {});
      if (Date.now() > until) throw new Error(`Postgres not ready at ${url}: ${String(e)}`, { cause: e });
      // oxlint-disable-next-line eslint/no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** A ready Postgres URL for dev. */
export async function ensureDatabase(): Promise<string> {
  if (process.env.DATABASE_URL) {
    await waitReady(process.env.DATABASE_URL);
    return process.env.DATABASE_URL;
  }
  const rt = runtime();
  if (rt === "container" && spawnSync("container", ["system", "status"], { stdio: "ignore" }).status !== 0) {
    execFileSync("container", ["system", "start", "--enable-kernel-install"], { stdio: "inherit" });
  }
  const s = state(rt);
  if (s === "stopped") execFileSync(rt, ["start", NAME], { stdio: "ignore" });
  if (s === "missing") {
    spawnSync(rt, ["volume", "create", VOLUME], { stdio: "ignore" });
    execFileSync(
      rt,
      [
        "run",
        "-d",
        "--name",
        NAME,
        "-e",
        "POSTGRES_USER=shifty",
        "-e",
        "POSTGRES_PASSWORD=shifty",
        "-e",
        "POSTGRES_DB=shifty",
        "-e",
        "PGDATA=/var/lib/postgresql/data/pgdata",
        "-p",
        `127.0.0.1:${PORT}:5432`,
        "-v",
        `${VOLUME}:/var/lib/postgresql/data`,
        IMAGE,
      ],
      { stdio: "ignore" },
    );
  }
  await waitReady(DEV_DATABASE_URL);
  return DEV_DATABASE_URL;
}
