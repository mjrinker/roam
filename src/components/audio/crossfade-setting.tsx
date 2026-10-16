"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { CROSSFADE_CHOICES, volumeIsAdjustable } from "@/lib/music/crossfade";

let deviceAnswer: boolean | null = null;
/** Whether this device lets the page change an audio element's volume (asked once). */
function deviceCanOverlap(): boolean {
  return (deviceAnswer ??= volumeIsAdjustable(new Audio()));
}

/** How long one song overlaps the next in a list: Off (back to back, no gap) to 12 seconds. Kept on this device. */
export function CrossfadeSetting({ value, onChange, canOverlap }: { value: number; onChange: (seconds: number) => void; /** Defaults to asking this device; given in tests. */ canOverlap?: boolean }) {
  const asked = useSyncExternalStore(() => () => undefined, deviceCanOverlap, () => true);
  const overlap = canOverlap ?? asked;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Crossfade{value > 0 && overlap ? ` · ${value} s` : ""}</h3>
      <div className="flex flex-wrap gap-1.5">
        {CROSSFADE_CHOICES.map((seconds) => (
          <button
            key={seconds}
            type="button"
            aria-pressed={value === seconds}
            onClick={() => onChange(seconds)}
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === seconds ? "bg-primary text-primary-foreground ring-primary" : "bg-white/[0.06] text-muted-foreground ring-white/10 hover:bg-white/10 hover:text-foreground"
            )}
          >
            {seconds === 0 ? "Off" : `${seconds} s`}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {overlap ? "Songs in a list always follow each other without a gap; a crossfade also fades one into the next." : "Songs in a list follow each other without a gap. This device can't overlap them, so a crossfade has no effect here."}
      </p>
    </section>
  );
}
