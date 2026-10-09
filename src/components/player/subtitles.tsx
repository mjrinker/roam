"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Captions } from "lucide-react";
import { cn } from "@/lib/utils";
import { activeCues, type Cue } from "@/lib/subtitles/cues";

export interface PlayerTrack {
  id: string;
  language: string;
  label: string;
  hearingImpaired: boolean;
}

/**
 * The words on the picture, drawn from the player's own clock so they stay right across the parts of a title that is split into several
 * files. Plain text only (never HTML); `lifted` raises them above the controls while those are showing.
 */
export function SubtitleOverlay({ cues, getTime, offset, lifted }: { cues: readonly Cue[]; getTime: () => number; offset: number; lifted: boolean }) {
  const [shown, setShown] = useState<readonly Cue[]>([]);
  const key = useRef("");
  useEffect(() => {
    const tick = () => {
      const now = activeCues(cues, getTime(), offset);
      const next = now.map((c) => `${c[0]}:${c[1]}`).join("|");
      if (next !== key.current) {
        key.current = next;
        setShown(now);
      }
    };
    key.current = ""; // new words (another track or video) always redraw, even if the active timings match
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [cues, getTime, offset]);
  if (shown.length === 0) return null;
  return (
    <div aria-live="off" className={cn("pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1 px-[6%] text-center transition-[bottom] duration-300", lifted ? "bottom-28" : "bottom-10")}>
      {shown.map((c, i) => (
        <p key={`${i}-${c[0]}-${c[1]}`} className="max-w-full rounded-md bg-black/55 px-3 py-1 text-[clamp(1rem,2.3vw,1.9rem)] leading-snug whitespace-pre-line text-white [text-shadow:0_0_3px_#000,0_0_6px_#000]">
          {c[2]}
        </p>
      ))}
    </div>
  );
}

const DELAY_STEP = 0.1;

/** The captions button and its menu: off, each track, a delay control, and (for the admin) a link to add or remove subtitles. Drawn inside the player so it works in fullscreen. */
export function SubtitleMenu({ tracks, activeId, onSelect, offset, onOffset, manageHref }: { tracks: readonly PlayerTrack[]; activeId: string | null; onSelect: (id: string | null) => void; offset: number; onOffset: (seconds: number) => void; manageHref?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  // Nothing to choose and nobody who can add any: no button at all.
  if (tracks.length === 0 && !manageHref) return null;
  const item = "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm outline-none hover:bg-white/15 focus-visible:bg-white/15";
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={activeId ? "Subtitles, on" : "Subtitles, off"}
        title="Subtitles"
        onClick={() => setOpen((o) => !o)}
        className={cn("flex size-10 items-center justify-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-ring", open && "bg-white/15", activeId && "text-primary")}
      >
        <Captions className="size-5" />
      </button>
      {open && (
        <div role="menu" aria-label="Subtitles" className="absolute right-0 bottom-full z-10 mb-2 w-60 rounded-xl bg-black/90 p-1.5 text-white shadow-xl ring-1 ring-white/15 backdrop-blur">
          <ul className="max-h-60 overflow-y-auto">
            <li>
              <button type="button" role="menuitemradio" aria-checked={activeId === null} onClick={() => (onSelect(null), setOpen(false))} className={cn(item, activeId === null && "font-semibold text-primary")}>
                Off {activeId === null && <span aria-hidden>✓</span>}
              </button>
            </li>
            {tracks.map((t) => (
              <li key={t.id}>
                <button type="button" role="menuitemradio" aria-checked={activeId === t.id} onClick={() => (onSelect(t.id), setOpen(false))} className={cn(item, activeId === t.id && "font-semibold text-primary")}>
                  <span className="truncate">{t.label}</span>
                  {activeId === t.id && <span aria-hidden>✓</span>}
                </button>
              </li>
            ))}
            {tracks.length === 0 && <li className="px-3 py-1.5 text-sm text-white/60">No subtitles yet</li>}
          </ul>
          {activeId && (
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-white/15 px-3 pt-2 pb-1 text-sm">
              <span className="text-white/70">Delay</span>
              <span className="flex items-center gap-1">
                <button type="button" aria-label="Subtitles earlier" onClick={() => onOffset(Math.round((offset - DELAY_STEP) * 10) / 10)} className="size-7 rounded-md bg-white/15 hover:bg-white/25">
                  −
                </button>
                <span className="w-14 text-center tabular-nums">{offset > 0 ? "+" : ""}{offset.toFixed(1)}s</span>
                <button type="button" aria-label="Subtitles later" onClick={() => onOffset(Math.round((offset + DELAY_STEP) * 10) / 10)} className="size-7 rounded-md bg-white/15 hover:bg-white/25">
                  +
                </button>
              </span>
            </div>
          )}
          {manageHref && (
            <div className="mt-1 border-t border-white/15 pt-1">
              <Link href={manageHref} className={item}>
                Add or remove subtitles…
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
