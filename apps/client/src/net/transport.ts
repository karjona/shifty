// The race connection (WebTransport datagrams) behind a tiny interface, so the
// game code and the fake-bad-network wrapper don't depend on what is underneath.

export interface Transport {
  readonly kind: "webtransport";
  send(bytes: Uint8Array<ArrayBuffer>): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export interface JoinTicket {
  token: string;
  room: string;
  webTransportUrl: string;
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
    certHash: certHash ?? null,
  };
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

/** Thrown when this browser or network can't do WebTransport. */
export class WebTransportUnavailable extends Error {}

/**
 * The spec replaced `datagrams.writable` with `datagrams.createWritable()`.
 * Browsers ship either or both: Chrome only has `writable`, Safari only `createWritable()`.
 */
function datagramWritable(wt: WebTransport): WritableStream<Uint8Array> {
  const datagrams: WebTransportDatagramDuplexStream & { createWritable?: () => WritableStream<Uint8Array> } =
    wt.datagrams;
  return datagrams.createWritable ? datagrams.createWritable() : datagrams.writable;
}

export async function connect(ticket: JoinTicket, timeoutMs = 4000): Promise<Transport> {
  if (typeof WebTransport === "undefined") {
    throw new WebTransportUnavailable(
      "This browser doesn't support WebTransport. Please use a recent Chrome, Edge, Firefox or Safari.",
    );
  }
  const options: WebTransportOptions = {};
  if (ticket.certHash) {
    options.serverCertificateHashes = [{ algorithm: "sha-256", value: base64ToBytes(ticket.certHash) }];
  }
  const wt = new WebTransport(ticket.webTransportUrl, options);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("WebTransport timed out")), timeoutMs),
  );
  try {
    await Promise.race([wt.ready, timeout]);
  } catch {
    wt.close();
    throw new WebTransportUnavailable("Couldn't reach the race server. Your network may be blocking UDP.");
  }

  const listeners = new Listeners();
  const writer = datagramWritable(wt).getWriter();
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
