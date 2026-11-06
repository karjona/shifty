// Dev Postgres: DATABASE_URL if set (CI), otherwise a container named
// `shifty-postgres` (Apple `container` or Docker) with its data in the
// `shifty-postgres` volume. It keeps running after `pnpm dev` stops.
// Production runs on Neon, so the major version follows Neon's.
import { execFileSync, spawnSync } from "node:child_process";
import { Client } from "pg";

const NAME = "shifty-postgres";
const VOLUME = "shifty-postgres";
const IMAGE = "docker.io/library/postgres:18-alpine";
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

/** The image the existing container was made from (Apple `container` or Docker). */
function imageOf(rt: string): string | undefined {
  const out = spawnSync(rt, ["inspect", NAME], { encoding: "utf8" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    return undefined;
  }
  const at = (...path: (string | number)[]): unknown =>
    path.reduce<unknown>((v, key) => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined), parsed);
  const image = at(0, "configuration", "image", "reference") ?? at(0, "Config", "Image");
  return typeof image === "string" ? image : undefined;
}

async function waitReady(url: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (e) {
      await client.end().catch(() => {});
      if (Date.now() > until) throw new Error(`Postgres not ready at ${url}: ${String(e)}`, { cause: e });
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
  const image = s === "missing" ? IMAGE : imageOf(rt);
  if (image && image !== IMAGE) {
    throw new Error(
      `${NAME} runs ${image}, but dev wants ${IMAGE}. ` +
        `Keep its data with \`${rt} exec ${NAME} pg_dump -U shifty -d shifty -Fc > shifty.dump\`, ` +
        `remove it with \`${rt} rm -f ${NAME}\` and start dev again, then restore with ` +
        `\`${rt} exec -i ${NAME} pg_restore -U shifty -d shifty --clean --if-exists < shifty.dump\`.`,
    );
  }
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
        "-p",
        `127.0.0.1:${PORT}:5432`,
        "-v",
        `${VOLUME}:/var/lib/postgresql`,
        IMAGE,
      ],
      { stdio: "ignore" },
    );
  }
  await waitReady(DEV_DATABASE_URL);
  return DEV_DATABASE_URL;
}
