// The loading sign: up while the 3D behind the menus gets something ready
// (see game/loading.ts).
import { useSyncExternalStore } from "react";
import { busy, onBusy } from "../game/loading.ts";
import { useT } from "../i18n/index.ts";

export function Busy() {
  const t = useT();
  const on = useSyncExternalStore(onBusy, busy);
  return on ? (
    <div className="busy" role="status">
      {t.common.loading}
    </div>
  ) : null;
}
