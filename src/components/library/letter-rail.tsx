"use client";

import { useRef, useState } from "react";
import { RAIL_KEYS } from "@/lib/library/browse";
import { cn } from "@/lib/utils";

/**
 * Contacts-style 0–Z strip pinned to the right edge (over the scrollbar
 * gutter): tap a letter, or drag a finger along it to scrub. Letters with no
 * titles are dimmed and skipped over.
 */
export function LetterRail({
  available,
  descending,
  onJump,
}: {
  /** Rail keys that have at least one title. */
  available: ReadonlySet<string>;
  descending: boolean;
  onJump: (key: string, smooth: boolean) => void;
}) {
  const keys = descending ? [...RAIL_KEYS].reverse() : RAIL_KEYS;
  const navRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string | null>(null);

  function keyAt(clientY: number): string | null {
    const rect = navRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return null;
    const index = Math.min(keys.length - 1, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * keys.length)));
    // The nearest lettered bucket at or after the finger, else the last one before it.
    for (let i = index; i < keys.length; i++) if (available.has(keys[i])) return keys[i];
    for (let i = index - 1; i >= 0; i--) if (available.has(keys[i])) return keys[i];
    return null;
  }

  function scrub(e: React.PointerEvent) {
    if (e.pointerType === "mouse") return;
    const key = keyAt(e.clientY);
    if (!key) return;
    if (key !== active) onJump(key, false);
    setActive(key);
  }

  return (
    <>
      <nav
        ref={navRef}
        aria-label="Jump to letter"
        data-no-pull
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e);
        }}
        onPointerUp={() => setActive(null)}
        onPointerCancel={() => setActive(null)}
        className="fixed top-1/2 right-0.5 z-20 sm:right-3 flex h-[min(30rem,calc(100dvh-10rem))] w-5 -translate-y-1/2 touch-none flex-col rounded-full bg-background/60 py-1 ring-1 ring-white/[0.06] backdrop-blur-md select-none"
      >
        {keys.map((k) => {
          const on = available.has(k);
          return (
            <button
              key={k}
              type="button"
              disabled={!on}
              aria-label={k === "0" ? "Jump to 0–9" : `Jump to ${k}`}
              onClick={() => onJump(k, true)}
              className={cn(
                "flex min-h-0 flex-1 items-center justify-center text-[10px] leading-none font-semibold transition-colors",
                on ? "text-muted-foreground hover:text-primary" : "text-muted-foreground/30",
                active === k && "text-primary"
              )}
            >
              {k}
            </button>
          );
        })}
      </nav>
      {active && (
        <div
          aria-hidden
          className="pointer-events-none fixed top-1/2 left-1/2 z-40 flex size-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl bg-popover/90 text-4xl font-semibold text-primary shadow-2xl ring-1 ring-white/10"
        >
          {active}
        </div>
      )}
    </>
  );
}
