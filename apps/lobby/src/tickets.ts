// Join tokens for race servers, signed with the lobby's Ed25519 key. Format
// (see crates/protocol/src/token.rs): base64url(claims JSON) "." base64url
// (signature over "shifty-join-v1." + that first part).

/** Courses on the race server (`sim::CourseId`). */
export const COURSE = { summer: 0, winter: 1 } as const;

/** What a room races: the Grand Prix (every season in order) or one event. */
export type EventChoice = "gp" | "summer" | "winter";
export const EVENT_CHOICES: readonly EventChoice[] = ["gp", "summer", "winter"];
export const isEventChoice = (v: unknown): v is EventChoice =>
  typeof v === "string" && (EVENT_CHOICES as readonly string[]).includes(v);

/** The courses of an event choice, in race order. */
export function courses(event: EventChoice): number[] {
  return event === "gp" ? [COURSE.summer, COURSE.winter] : [COURSE[event]];
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
  bots: number;
  surface: number;
  /** First course (older servers read only this). */
  course: number;
  /** Every course of the room, in order (a Grand Prix has several). */
  events: number[];
  /** The rider's appearance bytes (base64url), passed on to the room. */
  look?: string;
  /** Setup per sport (summer, winter), four stats each. */
  setups?: number[][];
}

/** What a client needs to join a race. */
export interface JoinTicket {
  token: string;
  room: string;
  webTransportUrl: string;
  certHash: string | null;
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
  server: { addr: string; certHash: string | null };
  room: string;
  pid: string;
  name: string;
  event: EventChoice;
  bots: number;
  /** The rider, as the race server should show and simulate them. */
  rider?: { look: string; setups: number[][] };
}

export async function mintTicket(seedB64: string, req: TicketRequest, nowMs = Date.now()): Promise<JoinTicket> {
  const events = courses(req.event);
  const claims: JoinClaims = {
    v: 1,
    aud: req.server.addr,
    room: req.room,
    pid: req.pid,
    name: req.name,
    exp: Math.floor(nowMs / 1000) + TOKEN_LIFETIME_SECS,
    bots: req.bots,
    surface: 1,
    course: events[0] ?? COURSE.summer,
    events,
  };
  if (req.rider?.look) claims.look = req.rider.look;
  if (req.rider?.setups.length) claims.setups = req.rider.setups;
  return {
    token: await signJoinToken(seedB64, claims),
    room: req.room,
    webTransportUrl: `https://${req.server.addr}/race`,
    certHash: req.server.certHash,
  };
}

const ROOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random race server room id with a prefix (`m_…` online, `s_…` single player). */
export function roomId(prefix: string): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("")}`;
}
