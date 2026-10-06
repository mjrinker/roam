"use client";

import { useState } from "react";
import { Heart } from "lucide-react";

/** Tells the timeline (which may restore an older saved list on Back) what this profile changed. */
function remember(libraryId: string, id: string, favorite: boolean) {
  try {
    const key = `roam:photos:fav:${libraryId}`;
    const map = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, boolean>;
    map[id] = favorite;
    sessionStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* storage unavailable: the list just refreshes from the server next time */
  }
}

/** The heart in the viewer. Flips at once and puts itself back if the server says no. */
export function FavoriteButton({ id, libraryId, initial, addLabel, removeLabel, onChange }: { id: string; libraryId: string; initial: boolean; addLabel: string; removeLabel: string; onChange?: (id: string, favorite: boolean) => void }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    const next = !on;
    setOn(next);
    onChange?.(id, next);
    setBusy(true);
    try {
      const res = await fetch(`/api/photos/${id}/favorite`, { method: next ? "PUT" : "DELETE", credentials: "same-origin" });
      if (!res.ok) {
        setOn(!next);
        onChange?.(id, !next);
      } else remember(libraryId, id, next);
    } catch {
      setOn(!next);
      onChange?.(id, !next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={() => void toggle()} aria-pressed={on} aria-label={on ? removeLabel : addLabel} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
      <Heart className={`size-4 ${on ? "fill-rose-500 text-rose-500" : ""}`} />
    </button>
  );
}
