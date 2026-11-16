// Short messages at the bottom of the screen ("coming soon", errors).
import { useSyncExternalStore } from "react";

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** How long a toast stays up: errors long enough to read what went wrong. */
const SHOWN_MS = { info: 3500, error: 6000 };

export function toast(text: string, tone: Toast["tone"] = "info"): void {
  const id = next++;
  toasts = [...toasts.filter((t) => t.text !== text), { id, text, tone }].slice(-3);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, SHOWN_MS[tone]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function Toasts() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
