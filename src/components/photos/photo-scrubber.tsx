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
  // While pressed: where along the rail the finger is (0..1, continuous), so the marker and label glide with it
  // instead of stepping from month to month.
  const [finger, setFinger] = useState<number | null>(null);
  if (keys.length < 2) return null;

  const marks = scrubberMarks(keys);
  const fractionAt = (clientY: number) => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || r.height <= 0) return 0;
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  };
  const currentIndex = Math.max(0, current ? keys.indexOf(current) : 0);
  const pressedIndex = finger === null ? -1 : bucketAt(finger, keys.length);
  // Where the marker sits: under the finger while pressed, otherwise at the month on screen.
  const markerAt = finger !== null ? finger : (marks[currentIndex]?.at ?? 0);
  const label = bucketLabel(keys[finger !== null ? pressedIndex : currentIndex]);

  return (
    <div
      ref={rail}
      role="slider"
      tabIndex={0}
      aria-label="Jump to a month"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={keys.length - 1}
      aria-valuenow={currentIndex}
      aria-valuetext={bucketLabel(keys[currentIndex])}
      className="fixed bottom-6 right-0 top-28 z-20 w-10 touch-none select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setFinger(fractionAt(e.clientY));
      }}
      onPointerMove={(e) => {
        if (finger !== null) setFinger(fractionAt(e.clientY));
      }}
      onPointerUp={(e) => {
        const i = bucketAt(fractionAt(e.clientY), keys.length);
        setFinger(null);
        if (i >= 0) onJump(keys[i]);
      }}
      onPointerCancel={() => setFinger(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "PageDown") {
          e.preventDefault();
          onJump(keys[Math.min(keys.length - 1, currentIndex + 1)]);
        } else if (e.key === "ArrowUp" || e.key === "PageUp") {
          e.preventDefault();
          onJump(keys[Math.max(0, currentIndex - 1)]);
        } else if (e.key === "Home") onJump(keys[0]);
        else if (e.key === "End") onJump(keys[keys.length - 1]);
      }}
    >
      <div className={`absolute inset-y-0 right-1.5 rounded-full bg-white/15 transition-all duration-200 ${finger !== null ? "w-1.5 bg-white/25" : "w-1"}`} aria-hidden />
      {marks.map((m) =>
        m.year ? (
          <span key={m.key} aria-hidden className={`pointer-events-none absolute right-4 -translate-y-1/2 rounded bg-black/50 px-1 text-[10px] font-medium text-white/80 transition-opacity duration-200 ${finger !== null ? "opacity-100" : "opacity-60"}`} style={{ top: `${m.at * 100}%` }}>
            {m.year}
          </span>
        ) : null
      )}
      {/* The marker glides: it eases to wherever it should be, and follows the finger closely while pressed. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute right-0.5 -translate-y-1/2 rounded-full bg-primary shadow-md ring-2 ring-black/40 transition-[top,width,height] ${finger !== null ? "size-4 duration-75" : "size-2.5 duration-300 ease-out"}`}
        style={{ top: `${markerAt * 100}%` }}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute right-12 -translate-y-1/2 whitespace-nowrap rounded-xl bg-black/80 px-3 py-1.5 text-sm font-medium text-white ring-1 ring-white/20 transition-[top,opacity,transform] duration-75 ${finger !== null ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
        style={{ top: `${markerAt * 100}%` }}
      >
        {label}
      </span>
    </div>
  );
}
