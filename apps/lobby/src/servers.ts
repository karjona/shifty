// The race servers the lobby knows about, from their heartbeats. One
// instance (named "all"). Temporary state: rebuilt from heartbeats.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

export interface ServerInfo {
  /** Public `host:port`; join tokens name it as their audience. */
  addr: string;
  region: string;
  /** The release it runs. */
  version: string;
  /** Base64 SHA-256 of each self-signed certificate it may serve (hash mode;
   * two during a hand-over), else empty. */
  certHashes: string[];
  rooms: number;
  humans: number;
  draining: boolean;
}

interface Entry extends ServerInfo {
  seenAt: number;
}

/** A server that hasn't sent a heartbeat for this long is gone. */
const ALIVE_MS = 15_000;

export class ServerRegistry extends DurableObject<Env> {
  private servers: Map<string, Entry> | null = null;

  private async load(): Promise<Map<string, Entry>> {
    this.servers ??= await this.ctx.storage.list<Entry>();
    return this.servers;
  }

  async heartbeat(info: ServerInfo): Promise<void> {
    const servers = await this.load();
    const entry = { ...info, seenAt: Date.now() };
    servers.set(info.addr, entry);
    await this.ctx.storage.put(info.addr, entry);
  }

  /** The least busy live server on `version`, or null if none is up. */
  async pick(version: string): Promise<ServerInfo | null> {
    const servers = await this.load();
    const now = Date.now();
    let best: Entry | null = null;
    const gone: string[] = [];
    for (const [addr, s] of servers) {
      if (now - s.seenAt > ALIVE_MS * 20) {
        gone.push(addr);
        continue;
      }
      if (s.draining || s.version !== version || now - s.seenAt > ALIVE_MS) continue;
      if (!best || s.humans < best.humans || (s.humans === best.humans && s.rooms < best.rooms)) best = s;
    }
    if (gone.length > 0) {
      for (const addr of gone) servers.delete(addr);
      await this.ctx.storage.delete(gone);
    }
    if (!best) return null;
    // Count the room about to start, so a burst spreads over servers.
    best.rooms += 1;
    const { seenAt: _, ...info } = best;
    return info;
  }

  /** The servers that sent a heartbeat lately. */
  async live(): Promise<ServerInfo[]> {
    const now = Date.now();
    const live: ServerInfo[] = [];
    for (const s of (await this.load()).values()) {
      if (now - s.seenAt > ALIVE_MS) continue;
      const { seenAt: _, ...info } = s;
      live.push(info);
    }
    return live;
  }
}
