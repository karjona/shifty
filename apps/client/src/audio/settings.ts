// Volume settings (0-1 each), kept across reloads.

export interface AudioSettings {
  master: number;
  effects: number;
  music: number;
}

export type VolumeKind = keyof AudioSettings;

const KEY = "shifty.audio";

export const AUDIO_DEFAULTS: Readonly<AudioSettings> = { master: 0.8, effects: 1, music: 0.7 };

export function loadAudioSettings(): AudioSettings {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    // Bad JSON: defaults.
  }
  const read = (k: VolumeKind): number => {
    const v: unknown = typeof saved === "object" && saved !== null ? Reflect.get(saved, k) : undefined;
    return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : AUDIO_DEFAULTS[k];
  };
  return { master: read("master"), effects: read("effects"), music: read("music") };
}

export function saveAudioSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage full or blocked: the setting lasts until the page closes.
  }
}

/** A volume setting's gain: squared, so the steps sound even. */
export const volumeGain = (v: number): number => v * v;
