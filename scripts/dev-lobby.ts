// Dev stand-in for the lobby: owns a dev Ed25519 key pair and signs join
// tokens in exactly the format the real lobby will use
// (see crates/protocol/src/token.rs). Never used in production.
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = join(repoRoot, ".dev", "lobby-key.json");

export interface DevKey {
  privateKey: string; // base64url, 32-byte Ed25519 seed
  publicKey: string; // base64url, 32 bytes
}

export interface JoinClaims {
  v: 1;
  aud: string;
  room: string;
  pid: string;
  name: string;
  exp: number;
  bots: number;
  surface: number;
}

const b64url = (b: Buffer): string => b.toString("base64url");

/** Loads the dev lobby key, creating it on first use. */
export function ensureDevKey(): DevKey {
  if (existsSync(keyPath)) {
    return JSON.parse(readFileSync(keyPath, "utf8")) as DevKey;
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // PKCS#8 and SPKI DER for Ed25519 end with the raw 32-byte key.
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const key: DevKey = { privateKey: b64url(seed), publicKey: b64url(pub) };
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  return key;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Signs a join token: base64url(claims) "." base64url(sig over "shifty-join-v1." + payload). */
export function mintJoinToken(key: DevKey, claims: JoinClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(key.privateKey, "base64url")]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const sig = sign(null, Buffer.from(`shifty-join-v1.${payload}`), privateKey);
  return `${payload}.${b64url(sig)}`;
}

export interface DevJoinOptions {
  name: string;
  room?: string;
  bots?: number;
  surface?: number;
  pid?: string;
}

/** Everything a client needs to join a race, like the real lobby will hand out. */
export function devJoinTicket(raceServer: string, opts: DevJoinOptions) {
  const key = ensureDevKey();
  const claims: JoinClaims = {
    v: 1,
    aud: raceServer,
    room: opts.room ?? "dev",
    pid: opts.pid ?? `dev-${randomUUID().slice(0, 8)}`,
    name: opts.name.slice(0, 24),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
    bots: opts.bots ?? 2,
    surface: opts.surface ?? 1,
  };
  return { token: mintJoinToken(key, claims), claims };
}
