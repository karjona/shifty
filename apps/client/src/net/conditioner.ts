import type { Transport } from "./transport.ts";

/** Fake bad network, applied in both directions. For testing netcode by feel. */
export interface NetConditions {
  /** Added round-trip time, ms (split evenly between directions). */
  lagMs: number;
  /** Random extra delay per packet, ms (can reorder packets). */
  jitterMs: number;
  /** Packet loss per direction, percent. */
  lossPct: number;
}

export function conditioned(inner: Transport, cond: NetConditions): Transport {
  let onMessage: ((b: Uint8Array) => void) | null = null;
  const delay = () => cond.lagMs / 2 + Math.random() * cond.jitterMs;
  const dropped = () => Math.random() * 100 < cond.lossPct;
  const quiet = () => cond.lagMs === 0 && cond.jitterMs === 0 && cond.lossPct === 0;

  inner.onMessage((bytes) => {
    if (quiet()) return onMessage?.(bytes);
    if (dropped()) return;
    const copy = bytes.slice();
    setTimeout(() => onMessage?.(copy), delay());
  });

  return {
    kind: inner.kind,
    send(bytes) {
      if (quiet()) return inner.send(bytes);
      if (dropped()) return;
      const copy = bytes.slice();
      setTimeout(() => inner.send(copy), delay());
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      inner.onClose(cb);
    },
    close() {
      inner.close();
    },
  };
}
