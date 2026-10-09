"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { activeCues, parseSubtitleBytes, MAX_SUBTITLE_BYTES, type Cue } from "@/lib/subtitles/cues";
import { SUBTITLE_LANGUAGES } from "@/lib/subtitles/languages";
import type { SubtitleResult } from "@/lib/subtitles/opensubtitles";

/** Subtitles the viewer loaded for this viewing (nothing about them is stored). */
export interface LoadedTrack {
  id: string;
  label: string;
  cues: Cue[];
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

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : fallback;
}

/** Find a subtitle on OpenSubtitles or load a file from the device. What comes back is handed on and used for this viewing only. */
function SubtitleFinder({ ownerKind, ownerId, onLoaded, onDone }: { ownerKind: string; ownerId: string; onLoaded: (t: LoadedTrack) => void; onDone: () => void }) {
  const [language, setLanguage] = useState("en");
  const [busy, setBusy] = useState<number | "search" | null>(null);
  const [results, setResults] = useState<SubtitleResult[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const field = "h-8 rounded-md border border-white/20 bg-black/40 px-2 text-sm text-white";

  async function search() {
    setBusy("search");
    setMessage(null);
    const res = await fetch(`/api/subtitles/search?ownerKind=${ownerKind}&ownerId=${ownerId}&languages=${encodeURIComponent(language)}`).catch(() => null);
    setBusy(null);
    if (!res || !res.ok) {
      setResults(null);
      setMessage(res ? await errorOf(res, "The search failed.") : "Couldn't reach the server.");
      return;
    }
    setResults((await res.json()).results as SubtitleResult[]);
  }
  async function pick(r: SubtitleResult) {
    setBusy(r.fileId);
    setMessage(null);
    const res = await fetch("/api/subtitles/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKind, ownerId, fileId: r.fileId }) }).catch(() => null);
    setBusy(null);
    if (!res || !res.ok) return setMessage(res ? await errorOf(res, "Couldn't get that subtitle.") : "Couldn't reach the server.");
    const body = (await res.json()) as { cues: Cue[] };
    onLoaded({ id: `os-${r.fileId}-${crypto.randomUUID()}`, label: `${r.language.toUpperCase()} · ${r.release || r.fileName || "OpenSubtitles"}`.slice(0, 60), cues: body.cues });
    onDone();
  }
  async function file(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_SUBTITLE_BYTES) return setMessage("That file is too large for a subtitle file (2 MB at most).");
    const parsed = parseSubtitleBytes(new Uint8Array(await f.arrayBuffer()));
    if (!parsed.ok) return setMessage(parsed.error);
    onLoaded({ id: `file-${crypto.randomUUID()}`, label: f.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Subtitles", cues: parsed.cues });
    onDone();
  }

  return (
    <div className="flex flex-col gap-2 p-2 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-white/70">Load a file from this device</span>
        <input type="file" accept=".srt,.vtt,.ass,.ssa,text/plain,text/vtt" aria-label="Subtitle file" onChange={(e) => void file(e.target.files?.[0])} className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-white/15 file:px-2 file:py-1 file:text-white" />
      </label>
      <div className="flex flex-col gap-1 border-t border-white/15 pt-2">
        <span className="text-white/70">Find on OpenSubtitles</span>
        <div className="flex items-center gap-2">
          <select aria-label="Language to search for" value={language} onChange={(e) => setLanguage(e.target.value)} className={field}>
            {SUBTITLE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void search()} disabled={busy !== null} className="flex h-8 items-center gap-1 rounded-md bg-white/20 px-3 hover:bg-white/30 disabled:opacity-60">
            {busy === "search" && <Loader2 className="size-3.5 animate-spin" />} Search
          </button>
        </div>
      </div>
      {message && (
        <p role="alert" className="text-xs text-red-300">
          {message}
        </p>
      )}
      {results && results.length === 0 && <p className="text-xs text-white/60">Nothing found in that language.</p>}
      {results && results.length > 0 && (
        <ul className="max-h-44 overflow-y-auto">
          {results.map((r) => (
            <li key={r.fileId}>
              <button type="button" disabled={busy !== null} onClick={() => void pick(r)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/15 disabled:opacity-60">
                <span className="min-w-0">
                  <span className="block truncate">{r.release || r.fileName || "Subtitle"}</span>
                  <span className="block text-xs text-white/60">
                    {r.downloads.toLocaleString()} downloads{r.trusted ? " · trusted" : ""}{r.hearingImpaired ? " · SDH" : ""}{r.aiTranslated ? " · machine translated" : ""}
                  </span>
                </span>
                {busy === r.fileId && <Loader2 className="size-4 shrink-0 animate-spin" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onDone} className="self-start rounded-md px-2 py-1 text-white/70 hover:bg-white/15">
        Back
      </button>
    </div>
  );
}

/** The subtitle choices as a panel (the player's settings menu hosts it): off, what has been loaded for this viewing, a delay control, and a way to load more. */
export function SubtitlePanel({ ownerKind, ownerId, tracks, activeId, onSelect, onLoaded, offset, onOffset, onDone }: { ownerKind: string; ownerId: string; tracks: readonly LoadedTrack[]; activeId: string | null; onSelect: (id: string | null) => void; onLoaded: (t: LoadedTrack) => void; offset: number; onOffset: (seconds: number) => void; onDone: () => void }) {
  const [finding, setFinding] = useState(false);
  const item = "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm outline-none hover:bg-white/15 focus-visible:bg-white/15";
  if (finding) return <SubtitleFinder ownerKind={ownerKind} ownerId={ownerId} onLoaded={onLoaded} onDone={() => (setFinding(false), onDone())} />;
  return (
    <div role="menu" aria-label="Subtitles">
      <ul className="max-h-60 overflow-y-auto">
        <li>
          <button type="button" role="menuitemradio" aria-checked={activeId === null} onClick={() => (onSelect(null), onDone())} className={cn(item, activeId === null && "font-semibold text-primary")}>
            Off {activeId === null && <span aria-hidden>✓</span>}
          </button>
        </li>
        {tracks.map((t) => (
          <li key={t.id}>
            <button type="button" role="menuitemradio" aria-checked={activeId === t.id} onClick={() => (onSelect(t.id), onDone())} className={cn(item, activeId === t.id && "font-semibold text-primary")}>
              <span className="truncate">{t.label}</span>
              {activeId === t.id && <span aria-hidden>✓</span>}
            </button>
          </li>
        ))}
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
      <div className="mt-1 border-t border-white/15 pt-1">
        <button type="button" onClick={() => setFinding(true)} className={item}>
          Find or load subtitles…
        </button>
      </div>
    </div>
  );
}
