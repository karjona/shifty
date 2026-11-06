// The lobby's bindings and settings. Secrets come from `wrangler secret` in
// production and from env files in dev (see scripts/dev.ts).
import type { Matchmaker } from "./matchmaker.ts";
import type { RoomLobby } from "./rooms.ts";
import type { ServerRegistry } from "./servers.ts";

export interface Env {
  /** Postgres through Cloudflare Hyperdrive (production). */
  HYPERDRIVE?: Hyperdrive;
  /** Postgres directly (dev, self-hosting with workerd). */
  DATABASE_URL?: string;
  /** Better Auth: signs sessions and encrypts tokens. 32+ random bytes. */
  BETTER_AUTH_SECRET: string;
  /** The public origin players open, e.g. `http://localhost:5173`. */
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Ed25519 private key (base64url 32-byte seed) that signs join tokens. */
  LOBBY_SIGNING_KEY: string;
  /** Race servers send it as a bearer token (heartbeats, results). */
  RACE_SERVER_SECRET: string;
  /** `console` prints sign-in codes to the log instead of sending mail. */
  MAIL_MODE?: string;
  /** Cloudflare Email Service. Sign-in codes go out through it. */
  EMAIL?: SendEmail;
  /** The address sign-in codes come from, on a domain onboarded for sending. */
  MAIL_FROM?: string;
  /** `1`: keep the last code per address readable at /api/dev/mailbox (tests). */
  DEV_MAILBOX?: string;
  /** `open`: anyone can make an account. Otherwise (the default) a new account needs an invite code. */
  SIGNUPS?: string;
  /** Seconds matchmaking waits for more players before racing with bots. */
  MATCH_WAIT_SECS?: string;
  ROOMS: DurableObjectNamespace<RoomLobby>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  SERVERS: DurableObjectNamespace<ServerRegistry>;
}

/** The settings accounts need: Better Auth, sign-in mail and the sign-up gate. */
export type AuthEnv = Pick<
  Env,
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "MAIL_MODE"
  | "EMAIL"
  | "MAIL_FROM"
  | "DEV_MAILBOX"
  | "SIGNUPS"
>;

/** The Postgres connection string, from Hyperdrive or the environment. */
export function databaseUrl(env: Env): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error("no database: bind HYPERDRIVE or set DATABASE_URL");
  return url;
}
