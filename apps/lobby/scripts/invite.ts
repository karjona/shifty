// Invite links from the command line:
//   pnpm --filter lobby invite                          one link, one sign-up
//   pnpm --filter lobby invite --uses 5 --days 14 --note "Marc's crew"
//   pnpm --filter lobby invite --count 3                three links
//   pnpm --filter lobby invite --list                   every code and its uses
// The dev database and http://localhost:5173 by default (DATABASE_URL picks
// another database); --prod uses production's (.dev/neon.env) and its site.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEV_DATABASE_URL } from "../../../scripts/dev-db.ts";
import { openDb } from "../src/db/client.ts";
import { createInvites, formatInviteCode, listInvites } from "../src/invite-codes.ts";

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "1" },
    uses: { type: "string", default: "1" },
    days: { type: "string" },
    note: { type: "string" },
    list: { type: "boolean", default: false },
    prod: { type: "boolean", default: false },
  },
});

function positive(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number above 0`);
  return n;
}

const site = values.prod ? "https://23.4shifty.gg" : "http://localhost:5173";

function databaseUrl(): string {
  if (!values.prod) return process.env.DATABASE_URL ?? DEV_DATABASE_URL;
  const file = join(dirname(fileURLToPath(import.meta.url)), "../../../.dev/neon.env");
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error(`no DATABASE_URL in ${file}`);
  return line.slice("DATABASE_URL=".length).replaceAll(/^'|'$/gu, "");
}

const { db, close } = openDb(databaseUrl());
try {
  if (values.list) {
    for (const i of await listInvites(db)) {
      const expires = i.expiresAt ? `, expires ${i.expiresAt.toISOString().slice(0, 10)}` : "";
      console.log(`${formatInviteCode(i.code)}  ${i.uses}/${i.maxUses} used${expires}${i.note ? `  ${i.note}` : ""}`);
    }
  } else {
    const codes = await createInvites(db, {
      count: positive("count", values.count),
      uses: positive("uses", values.uses),
      days: values.days === undefined ? null : positive("days", values.days),
      note: values.note ?? null,
    });
    for (const code of codes) console.log(`${site}/invite/${formatInviteCode(code)}`);
  }
} finally {
  await close();
}
