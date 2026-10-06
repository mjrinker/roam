"use client";

import { useEffect, useRef, useState } from "react";
import { bucketLabel, scrubberMarks, scrubTarget } from "@/lib/photos/months";

/**
 * A rail along the right edge for moving through a big library. Press and slide and the page scrolls live,
 * continuously, under your finger (the library is laid out in advance, so any point on the rail is a real
 * scroll position); the marker follows the finger and shows the month you are over. When you are not
 * touching it, the marker glides along as the page scrolls. Months are spaced evenly along the rail, so a
 * month with thousands of photos doesn't squeeze the rest out.
 */
export function PhotoScrubber({
  keys,
  position,
  onScrub,
  onJump,
}: {
  keys: string[];
  /** Where the page is now, as a month number with a fraction (2.5 is halfway through the third month), or null. */
  position: number | null;
  /** The finger is at `within` (0..1) of month number `index`: scroll there. */
  onScrub: (index: number, within: number) => void;
  /** Go to the start of a month (the keyboard). */
  onJump: (key: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const latest = useRef<number | null>(null);
  // While pressed: where along the rail the finger is (0..1, continuous).
  const [finger, setFinger] = useState<number | null>(null);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  if (keys.length < 2) return null;

  const last = keys.length - 1;
  const marks = scrubberMarks(keys);
  const fractionAt = (clientY: number) => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || r.height <= 0) return 0;
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  };
  const scrubTo = (fraction: number) => {
    setFinger(fraction);
    latest.current = fraction;
    // At most once per frame, however fast the finger reports.
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const f = latest.current;
        if (f === null) return;
        const { index, within } = scrubTarget(f, keys.length);
        onScrub(index, within);
      });
    }
  };

  const here = Math.min(last, Math.max(0, position ?? 0));
  const currentIndex = Math.round(here);
  const fingerIndex = finger === null ? -1 : scrubTarget(finger, keys.length).index;
  // The marker is under the finger while pressed; otherwise it follows the page.
  const markerAt = finger !== null ? finger : here / last;
  const label = bucketLabel(keys[finger !== null ? fingerIndex : currentIndex]);

  return (
    <div
      ref={rail}
      role="slider"
      tabIndex={0}
      // The app's pull-down-to-refresh must not start from here: sliding down the rail is a scroll, not a refresh.
      data-no-pull
      aria-label="Jump to a month"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={currentIndex}
      aria-valuetext={bucketLabel(keys[currentIndex])}
      className="fixed bottom-6 right-0 top-28 z-20 w-10 touch-none select-none overscroll-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        scrubTo(fractionAt(e.clientY));
      }}
      onPointerMove={(e) => {
        if (finger !== null) scrubTo(fractionAt(e.clientY));
      }}
      onPointerUp={() => {
        latest.current = null;
        setFinger(null);
      }}
      onPointerCancel={() => {
        latest.current = null;
        setFinger(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "PageDown") {
          e.preventDefault();
          onJump(keys[Math.min(last, currentIndex + 1)]);
        } else if (e.key === "ArrowUp" || e.key === "PageUp") {
          e.preventDefault();
          onJump(keys[Math.max(0, currentIndex - 1)]);
        } else if (e.key === "Home") onJump(keys[0]);
        else if (e.key === "End") onJump(keys[last]);
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
      {/* The marker: straight under the finger while pressed (no delay), a short ease as the page scrolls it otherwise. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute right-0.5 -translate-y-1/2 rounded-full bg-primary shadow-md ring-2 ring-black/40 transition-[width,height] ${finger !== null ? "size-4" : "size-2.5"}`}
        style={{ top: `${markerAt * 100}%`, transition: finger !== null ? "width 120ms, height 120ms" : "top 120ms linear, width 120ms, height 120ms" }}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute right-12 -translate-y-1/2 whitespace-nowrap rounded-xl bg-black/80 px-3 py-1.5 text-sm font-medium text-white ring-1 ring-white/20 ${finger !== null ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
        style={{ top: `${markerAt * 100}%`, transition: finger !== null ? "opacity 120ms, transform 120ms" : "top 120ms linear, opacity 200ms, transform 200ms" }}
      >
        {label}
      </span>
    </div>
  );
}
