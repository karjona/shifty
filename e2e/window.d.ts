// The test hooks the game puts on `window` (see apps/client/src/game/race.ts).
declare global {
  interface Window {
    __shifty: {
      phase(): number;
      slot(): number;
      transport: string;
      renderer: string;
      sport(): "jetski" | "snow";
      stats(): {
        snapshots: number;
        mispredictions: number;
        lastSnapshotBytes: number;
        rttMs: number;
        inputLead: number;
      };
      riders(): { slot: number; x: number; y: number; z: number; speed: number; isMe: boolean }[];
      race(): { phase: number; laps: number; racers: number; eventCount: number };
      names(): Record<string, string>;
      /** The course is built and drawn (its loading card is coming off). */
      ready(): boolean;
      setInput(v: { steer?: number; throttle?: number; lean?: number; buttons?: number } | null): void;
      net: { lagMs: number; jitterMs: number; lossPct: number };
    };
  }
}

export type ShiftyHooks = Window["__shifty"];
