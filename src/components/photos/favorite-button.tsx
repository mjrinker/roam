"use client";

import { useState } from "react";
import { Heart } from "lucide-react";

/** The heart in the viewer. Flips at once and puts itself back if the server says no. */
export function FavoriteButton({ id, initial, addLabel, removeLabel }: { id: string; initial: boolean; addLabel: string; removeLabel: string }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/photos/${id}/favorite`, { method: next ? "PUT" : "DELETE", credentials: "same-origin" });
      if (!res.ok) setOn(!next);
    } catch {
      setOn(!next);
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
