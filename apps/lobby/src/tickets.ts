// Join tokens for race servers, signed with the lobby's Ed25519 key. Format
// (see crates/protocol/src/token.rs): base64url(claims JSON) "." base64url
// (signature over "shifty-join-v1." + that first part).

import { type PlanRequest, type RaceSpec, TILT } from "@shifty/rider";

/** What `match.event` records: the Tilt, or one race. */
export const planName = (plan: PlanRequest): "gp" | "race" => (plan.tilt ? "gp" : "race");

/** A plan from what `match.event` records (rooms made before plans name their event). */
export function legacyPlan(event: unknown): PlanRequest {
  if (event === "summer") return { tilt: false, race: { course: 0, season: 0 } };
  if (event === "winter") return { tilt: false, race: { course: 1, season: 2 } };
  if (event === "race") return { tilt: false, race: {} };
  return TILT;
}

/** A random seed for a plan's draw (every ticket of a room carries the same). */
export function planSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export interface JoinClaims {
  v: 1;
  /** The race server's public address: a token only works there. */
  aud: string;
  room: string;
  /** The player's account id. */
  pid: string;
  name: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** Signed at, unix seconds. */
  iat: number;
  bots: number;
  surface: number;
  /** The Tilt: a year, everything drawn... */
  tilt?: true;
  /** ...or these races, each field picked or left out to be drawn. */
  races?: RaceSpec[];
  /** Seeds the plan's draw. */
  seed: number;
  /** The rider's appearance bytes (base64url), passed on to the room. */
  look?: string;
  /** Setup per sport (summer, winter), four stats each. */
  setups?: number[][];
  /** How many people the room's first race waits for on the grid. */
  humans?: number;
  /** A time trial: one race with its circuit and season picked, the rider alone, every run recorded. */
  trial?: true;
}

/** The race server a ticket is for. */
export interface TicketServer {
  addr: string;
  /** The release it runs (the client must match it). */
  version: string;
  certHashes: string[];
}

/** What a client needs to join a race. */
export interface JoinTicket {
  token: string;
  room: string;
  webTransportUrl: string;
  /** The race server's release. */
  version: string;
  /** Base64 SHA-256 of each certificate the race server may serve (hash
   * mode), else empty. */
  certHashes: string[];
}

/** A race spec's fields in the claims' order, only those picked. */
function raceClaims(spec: RaceSpec): RaceSpec {
  const out: RaceSpec = {};
  for (const k of ["course", "season", "weather", "turns", "time"] as const)
    if (spec[k] !== undefined) out[k] = spec[k];
  return out;
}

const TOKEN_LIFETIME_SECS = 10 * 60;
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();

function signingKey(seedB64: string): Promise<CryptoKey> {
  let key = keys.get(seedB64);
  if (!key) {
    const seed = b64urlDecode(seedB64);
    if (seed.length !== 32) throw new Error("LOBBY_SIGNING_KEY must be a 32-byte Ed25519 seed (base64url)");
    const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    der.set(PKCS8_ED25519_PREFIX);
    der.set(seed, PKCS8_ED25519_PREFIX.length);
    key = crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    keys.set(seedB64, key);
  }
  return key;
}

export async function signJoinToken(seedB64: string, claims: JoinClaims): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const message = new TextEncoder().encode(`shifty-join-v1.${payload}`);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, await signingKey(seedB64), message);
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export interface TicketRequest {
  server: TicketServer;
  room: string;
  pid: string;
  name: string;
  plan: PlanRequest;
  /** The plan's seed: the same for every ticket of a room. */
  seed: number;
  bots: number;
  /** The rider, as the race server should show and simulate them. */
  rider?: { look: string; setups: number[][] };
  /** Everyone sent to this race (its first one waits on the grid until they have all arrived). */
  humans?: number;
  /** A time trial (its plan: one race, its circuit and season picked). */
  trial?: boolean;
}

export async function mintTicket(seedB64: string, req: TicketRequest, nowMs = Date.now()): Promise<JoinTicket> {
  const claims: JoinClaims = {
    v: 1,
    aud: req.server.addr,
    room: req.room,
    pid: req.pid,
    name: req.name,
    exp: Math.floor(nowMs / 1000) + TOKEN_LIFETIME_SECS,
    iat: Math.floor(nowMs / 1000),
    bots: req.bots,
    surface: 1,
    ...(req.plan.tilt ? { tilt: true } : { races: [raceClaims(req.plan.race)] }),
    seed: req.seed >>> 0,
  };
  if (req.rider?.look) claims.look = req.rider.look;
  if (req.rider?.setups.length) claims.setups = req.rider.setups;
  if (req.humans) claims.humans = req.humans;
  if (req.trial) claims.trial = true;
  return {
    token: await signJoinToken(seedB64, claims),
    room: req.room,
    webTransportUrl: `https://${req.server.addr}/race`,
    version: req.server.version,
    certHashes: req.server.certHashes,
  };
}

const ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random race server room id with a prefix (`m_…` online, `s_…` single player, `t_…` time trial). */
export function roomId(prefix: string): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("")}`;
}
