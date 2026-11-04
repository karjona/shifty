// One Postgres pool per request (Workers can't keep sockets between
// requests); `close` ends it once the response is out.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function openDb(url: string): DbHandle {
  const pool = new Pool({ connectionString: url, max: 3 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
