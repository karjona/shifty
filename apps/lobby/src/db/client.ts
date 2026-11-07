// One Postgres pool per request (Workers can't keep sockets between
// requests). It ends once the response is out and the request's background
// work is done.
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

export interface RequestDb {
  db: Db;
  /** Work that may run after the response is out, still on this pool. */
  background: (work: Promise<unknown>) => void;
  /** Ends the pool once all background work is done. */
  finish: () => void;
}

export function openRequestDb(url: string, waitUntil: (p: Promise<unknown>) => void): RequestDb {
  const { db, close } = openDb(url);
  const work: Promise<unknown>[] = [];
  const drain = async (): Promise<void> => {
    const seen = work.length;
    await Promise.allSettled(work);
    if (work.length !== seen) return drain();
    return close();
  };
  return {
    db,
    background: (p) => {
      work.push(p);
      waitUntil(p);
    },
    finish: () => waitUntil(drain()),
  };
}
