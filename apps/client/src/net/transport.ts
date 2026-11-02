// Transports behind one tiny interface. The game protocol treats every
// message as an unreliable datagram, so WebSocket (reliable, ordered) is a
// drop-in fallback for WebTransport datagrams.

export interface Transport {
  readonly kind: "webtransport" | "websocket";
  send(bytes: Uint8Array<ArrayBuffer>): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export interface JoinTicket {
  token: string;
  room: string;
  webTransportUrl: string;
  webSocketUrl: string;
  /** Base64 SHA-256 of the server certificate (hash mode), or null (domain mode). */
  certHash: string | null;
}

/** Validates a join ticket from the lobby instead of trusting its shape. */
export function parseJoinTicket(v: unknown): JoinTicket {
  if (typeof v !== "object" || v === null) throw new Error("join ticket: not an object");
  const str = (k: string): string => {
    const x: unknown = Reflect.get(v, k);
    if (typeof x !== "string" || x === "") throw new Error(`join ticket: missing ${k}`);
    return x;
  };
  const certHash: unknown = Reflect.get(v, "certHash");
  if (certHash !== null && typeof certHash !== "string") throw new Error("join ticket: bad certHash");
  return {
    token: str("token"),
    room: str("room"),
    webTransportUrl: str("webTransportUrl"),
    webSocketUrl: str("webSocketUrl"),
    certHash: certHash ?? null,
  };
}

export type TransportPreference = "auto" | "webtransport" | "websocket";

export function parseTransportPreference(v: string | null): TransportPreference {
  return v === "webtransport" || v === "websocket" ? v : "auto";
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class Listeners {
  message: ((b: Uint8Array) => void) | null = null;
  close: ((r: string) => void) | null = null;
  closed = false;
  fireClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.close?.(reason);
  }
}

export async function connectWebTransport(ticket: JoinTicket, timeoutMs = 3000): Promise<Transport> {
  const options: WebTransportOptions = {};
  if (ticket.certHash) {
    options.serverCertificateHashes = [{ algorithm: "sha-256", value: base64ToBytes(ticket.certHash) }];
  }
  const wt = new WebTransport(ticket.webTransportUrl, options);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("WebTransport timed out")), timeoutMs),
  );
  await Promise.race([wt.ready, timeout]);

  const listeners = new Listeners();
  const writer = wt.datagrams.writable.getWriter();
  const reader = wt.datagrams.readable.getReader();
  void (async () => {
    try {
      for (;;) {
        // Datagrams must be read one after another.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        listeners.message?.(value);
      }
    } catch {
      // Session closed.
    }
    listeners.fireClose("webtransport closed");
  })();
  wt.closed.then(
    () => listeners.fireClose("webtransport closed"),
    (e: unknown) => listeners.fireClose(`webtransport error: ${String(e)}`),
  );

  return {
    kind: "webtransport",
    send(bytes) {
      // Datagram semantics: never queue behind backpressure.
      if ((writer.desiredSize ?? 1) > 0) writer.write(bytes).catch(() => {});
    },
    onMessage(cb) {
      listeners.message = cb;
    },
    onClose(cb) {
      listeners.close = cb;
    },
    close() {
      wt.close();
    },
  };
}

export async function connectWebSocket(ticket: JoinTicket, timeoutMs = 3000): Promise<Transport> {
  const ws = new WebSocket(ticket.webSocketUrl);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WebSocket timed out")), timeoutMs);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(t);
        reject(new Error("WebSocket failed"));
      },
      { once: true },
    );
  });
  const listeners = new Listeners();
  ws.addEventListener("message", (e: MessageEvent<ArrayBuffer>) => listeners.message?.(new Uint8Array(e.data)));
  ws.addEventListener("close", (e) => listeners.fireClose(`websocket closed (${e.code})`));
  return {
    kind: "websocket",
    send(bytes) {
      // Like a datagram: if the socket is backed up, drop instead of queueing.
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 16_384) ws.send(bytes);
    },
    onMessage(cb) {
      listeners.message = cb;
    },
    onClose(cb) {
      listeners.close = cb;
    },
    close() {
      ws.close();
    },
  };
}

/** WebTransport first; WebSocket when UDP is blocked or unsupported. */
export async function connect(ticket: JoinTicket, prefer: TransportPreference): Promise<Transport> {
  if (prefer !== "websocket" && typeof WebTransport !== "undefined") {
    try {
      return await connectWebTransport(ticket);
    } catch (e) {
      if (prefer === "webtransport") throw e;
      console.warn("WebTransport unavailable, falling back to WebSocket:", e);
    }
  }
  return connectWebSocket(ticket);
}
