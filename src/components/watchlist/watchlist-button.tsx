"use client";

import { useState } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** "Add to watch list" / "On your watch list" for a movie, show or audiobook: one click either way (it leaves by itself once you finish it). */
export function WatchlistButton({ titleId, initial }: { titleId: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      const res = await fetch("/api/watchlist", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ titleId, on: next }) });
      if (!res.ok) throw new Error();
      toast.success(next ? "Added to your watch list." : "Removed from your watch list.");
    } catch {
      setOn(!next);
      toast.error("Couldn't update your watch list.");
    }
    setBusy(false);
  }

  return (
    <Button type="button" variant="secondary" disabled={busy} onClick={() => void toggle()} aria-pressed={on} title={on ? "Take it off your watch list" : "Add to your watch list"} className="h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20">
      {on ? <BookmarkCheck className="size-4 text-primary" /> : <Bookmark className="size-4" />}
      {on ? "On your watch list" : "Watch list"}
    </Button>
  );
}
