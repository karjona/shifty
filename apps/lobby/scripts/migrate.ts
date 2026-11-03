// Applies the Drizzle migrations in ../drizzle to DATABASE_URL.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "../drizzle") });
  console.log("database migrated");
} finally {
  await pool.end();
}
