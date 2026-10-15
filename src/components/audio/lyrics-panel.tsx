"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { lineAt, type LyricLine } from "@/lib/lyrics/lrc";

export interface Lyrics {
  synced: LyricLine[] | null;
  plain: string | null;
  instrumental: boolean;
}

/**
 * A song's lyrics under the player: timed lines follow the music (the line being sung is bright, and clicking a line jumps to it); words alone
 * just read. Shows nothing at all when there are no lyrics, or the thing playing isn't a song.
 */
export function LyricsPanel({ titleId, position, onSeek }: { titleId: string; position: number; onSeek: (seconds: number) => void }) {
  const [state, setState] = useState<{ titleId: string; lyrics: Lyrics | null } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = state?.titleId === titleId && state.lyrics?.synced ? lineAt(state.lyrics.synced, position) : -1;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/lyrics/${titleId}`);
        const lyrics = res.ok ? ((await res.json()) as Lyrics) : null;
        if (!cancelled) setState({ titleId, lyrics });
      } catch {
        if (!cancelled) setState({ titleId, lyrics: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [titleId]);

  // Keep the line being sung in the middle of the box (scrolling the box itself, never the page).
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>("[data-current]");
    if (el && box.current) box.current.scrollTo({ top: el.offsetTop - box.current.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, [current]);

  const lyrics = state?.titleId === titleId ? state.lyrics : null;
  if (!lyrics) return null;
  return <LyricsView lyrics={lyrics} current={current} onSeek={onSeek} boxRef={box} />;
}

/** The lyrics themselves (separate from fetching them, so they can be drawn on their own). */
export function LyricsView({ lyrics, current, onSeek, boxRef }: { lyrics: Lyrics; current: number; onSeek: (seconds: number) => void; boxRef?: React.RefObject<HTMLDivElement | null> }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Lyrics">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Lyrics</h3>
      {lyrics.instrumental && !lyrics.synced && !lyrics.plain ? (
        <p className="rounded-xl bg-white/[0.03] px-3 py-4 text-center text-sm text-muted-foreground ring-1 ring-white/[0.08]">Instrumental</p>
      ) : (
        <div ref={boxRef} className="max-h-56 overflow-y-auto rounded-xl bg-white/[0.03] px-3 py-3 text-center ring-1 ring-white/[0.08]">
          {lyrics.synced ? (
            <ol className="flex flex-col gap-1">
              {lyrics.synced.map((line, i) => (
                <li key={`${i}-${line.t}`} {...(i === current ? { "data-current": "" } : {})}>
                  <button
                    type="button"
                    onClick={() => onSeek(line.t)}
                    className={cn("w-full rounded-md px-2 py-0.5 text-sm transition-colors outline-none hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring", i === current ? "font-semibold text-primary" : "text-muted-foreground", !line.text && "h-3")}
                  >
                    {line.text || " "}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{lyrics.plain}</p>
          )}
        </div>
      )}
      <p className="text-center text-[11px] text-muted-foreground/70">Lyrics from LRCLIB</p>
    </section>
  );
}
