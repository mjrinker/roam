"use client";

import { useRef, useState } from "react";
import { bucketAt, bucketLabel, scrubberMarks } from "@/lib/photos/months";

/**
 * A rail along the right edge for jumping through a big library: press and slide to see the month under
 * your finger, let go to jump there. Months are spaced evenly, so a month with thousands of photos doesn't
 * squeeze the rest out. Keyboard users get a list of months in a select-style menu via the same buttons.
 */
export function PhotoScrubber({ keys, onJump, current }: { keys: string[]; onJump: (key: string) => void; current: string | null }) {
  const rail = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  if (keys.length < 2) return null;

  const marks = scrubberMarks(keys);
  const indexAt = (clientY: number) => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || r.height <= 0) return -1;
    return bucketAt((clientY - r.top) / r.height, keys.length);
  };

  return (
    <div
      ref={rail}
      role="slider"
      tabIndex={0}
      aria-label="Jump to a month"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={keys.length - 1}
      aria-valuenow={Math.max(0, current ? keys.indexOf(current) : 0)}
      aria-valuetext={bucketLabel(keys[Math.max(0, current ? keys.indexOf(current) : 0)])}
      className="fixed bottom-6 right-0 top-28 z-20 w-9 touch-none select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(indexAt(e.clientY));
      }}
      onPointerMove={(e) => {
        if (active !== null) setActive(indexAt(e.clientY));
      }}
      onPointerUp={(e) => {
        const i = indexAt(e.clientY);
        setActive(null);
        if (i >= 0) onJump(keys[i]);
      }}
      onPointerCancel={() => setActive(null)}
      onKeyDown={(e) => {
        const i = Math.max(0, current ? keys.indexOf(current) : 0);
        if (e.key === "ArrowDown" || e.key === "PageDown") {
          e.preventDefault();
          onJump(keys[Math.min(keys.length - 1, i + 1)]);
        } else if (e.key === "ArrowUp" || e.key === "PageUp") {
          e.preventDefault();
          onJump(keys[Math.max(0, i - 1)]);
        } else if (e.key === "Home") onJump(keys[0]);
        else if (e.key === "End") onJump(keys[keys.length - 1]);
      }}
    >
      <div className="absolute inset-y-0 right-1 w-1 rounded-full bg-white/15" aria-hidden />
      {marks.map((m) =>
        m.year ? (
          <span key={m.key} aria-hidden className="pointer-events-none absolute right-3 -translate-y-1/2 rounded bg-black/50 px-1 text-[10px] font-medium text-white/80" style={{ top: `${m.at * 100}%` }}>
            {m.year}
          </span>
        ) : null
      )}
      {active !== null && active >= 0 && (
        <span aria-hidden className="pointer-events-none absolute right-12 -translate-y-1/2 whitespace-nowrap rounded-lg bg-black/80 px-3 py-1.5 text-sm font-medium text-white ring-1 ring-white/20" style={{ top: `${marks[active].at * 100}%` }}>
          {bucketLabel(keys[active])}
        </span>
      )}
    </div>
  );
}
