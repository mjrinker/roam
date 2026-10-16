"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { starsText } from "@/lib/ratings/stars";

/**
 * Your own rating of a title, an episode or an album, in half stars: click the left or right half of a star; clicking the rating you gave
 * clears it. (Only you see it.) Each half is a button, so it works from the keyboard too.
 */
export function StarRating({ kind, id, initial, className, compact = false }: { kind: "title" | "episode" | "album"; id: string; initial: number | null; className?: string; compact?: boolean }) {
  const [value, setValue] = useState<number | null>(initial);
  const [hover, setHover] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = hover ?? value ?? 0;

  async function rate(half: number) {
    const next = half === value ? null : half;
    const before = value;
    setValue(next);
    setBusy(true);
    try {
      const res = await fetch("/api/ratings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id, halfStars: next }) });
      if (!res.ok) throw new Error();
    } catch {
      setValue(before);
      toast.error("Couldn't save your rating.");
    }
    setBusy(false);
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div role="radiogroup" aria-label="Your rating" className="flex" onMouseLeave={() => setHover(null)}>
        {[1, 2, 3, 4, 5].map((star) => (
          <span key={star} className={cn("relative inline-flex items-center justify-center", compact ? "size-5" : "size-7")}>
            <Star className={cn(compact ? "size-4" : "size-6", "text-white/25")} />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" style={{ width: shown >= star * 2 ? "100%" : shown === star * 2 - 1 ? "50%" : "0%" }}>
              <Star className={cn("absolute shrink-0 fill-primary text-primary", compact ? "left-0.5 size-4" : "left-0.5 size-6")} />
            </span>
            {[star * 2 - 1, star * 2].map((half) => (
              <button
                key={half}
                type="button"
                role="radio"
                aria-checked={value === half}
                aria-label={`${starsText(half)} ${half === 2 ? "star" : "stars"}`}
                disabled={busy}
                onMouseEnter={() => setHover(half)}
                onFocus={() => setHover(half)}
                onBlur={() => setHover(null)}
                onClick={() => void rate(half)}
                className={cn("absolute top-0 h-full w-1/2 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/70", half % 2 ? "left-0 rounded-l" : "right-0 rounded-r")}
              />
            ))}
          </span>
        ))}
      </div>
      <span className="min-w-8 text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {shown ? starsText(shown) : "Rate"}
      </span>
    </div>
  );
}
