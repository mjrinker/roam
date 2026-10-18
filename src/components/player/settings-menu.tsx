"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSpeed } from "@/lib/player/speed";
import { SpeedPanel, type DefaultSpeed } from "@/components/player/speed-menu";
import { SubtitlePanel, type LoadedTrack } from "@/components/player/subtitles";

export interface AudioChoice {
  index: number;
  label: string;
  supported: boolean;
}

export interface QualityOption {
  label: string;
  name: string;
}

interface SettingsMenuProps {
  rate: number;
  onRate: (speed: number) => void;
  defaultSpeed?: DefaultSpeed;
  ownerKind: string;
  ownerId: string;
  /** The audio tracks inside the video (shown only when there is more than one), the one playing, and a problem playing another. */
  /** Whether the next episode starts by itself after a countdown (shown only when there is a next one to start). */
  autoplay?: boolean;
  onAutoplay?: (on: boolean) => void;
  /** The admin may keep subtitles they load for everyone. */
  canKeepSubtitles?: boolean;
  audioOptions?: readonly AudioChoice[];
  audioIndex?: number;
  onAudio?: (index: number) => void;
  audioProblem?: string | null;
  tracks: readonly LoadedTrack[];
  activeTrack: string | null;
  onSelectTrack: (id: string | null) => void;
  onLoadedTrack: (t: LoadedTrack) => void;
  subtitleOffset: number;
  onSubtitleOffset: (seconds: number) => void;
  /** The resolution versions on offer (shown only when there is more than one) and the one playing. */
  qualities: readonly QualityOption[];
  quality: string;
  /** A version's label, or "@auto" / "@original" to let the player choose (and keep choosing, on this device). */
  onQuality: (choice: string) => void;
  qualityMode?: "auto" | "original" | "pick";
}

type View = "main" | "speed" | "subtitles" | "quality" | "language";

/**
 * The player's settings: one gear button opening a list of Speed, Subtitles and (when the title has several versions) Quality, each
 * leading to its own choices. Drawn inside the player so it also works in fullscreen.
 */
export function SettingsMenu(p: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("main");
  const box = useRef<HTMLDivElement>(null);
  const close = () => (setOpen(false), setView("main"));

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && (setOpen(false), setView("main"));
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (view === "main") setOpen(false);
      setView("main");
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, view]);

  const activeLabel = p.tracks.find((t) => t.id === p.activeTrack)?.label ?? "Off";
  const audioChoices = p.audioOptions ?? [];
  const audioName = audioChoices.find((a) => a.index === (p.audioIndex ?? 0))?.label ?? "";
  const mode = p.qualityMode ?? "pick";
  const playing = p.qualities.find((q) => q.label === p.quality)?.name ?? "";
  const qualityName = mode === "auto" ? `Automatic${playing ? ` (${playing})` : ""}` : mode === "original" ? `Original${playing ? ` (${playing})` : ""}` : playing;
  const best = p.qualities[0]?.name ?? "";
  const row = "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-white/15 focus-visible:bg-white/15";
  const title: Record<Exclude<View, "main">, string> = { speed: "Speed", subtitles: "Subtitles", quality: "Quality", language: "Audio" };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings"
        onClick={() => (setOpen((o) => !o), setView("main"))}
        className={cn("flex size-10 items-center justify-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-ring", open && "bg-white/15")}
      >
        <Settings className="size-5" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-10 mb-2 w-72 rounded-xl bg-black/90 p-1.5 text-white shadow-xl ring-1 ring-white/15 backdrop-blur">
          {view === "main" ? (
            <div role="menu" aria-label="Settings">
              <button type="button" role="menuitem" onClick={() => setView("speed")} className={row}>
                <span>Speed</span>
                <span className="flex items-center gap-1 text-white/70">
                  {formatSpeed(p.rate)} <ChevronRight className="size-4" />
                </span>
              </button>
              {audioChoices.length > 1 && (
                <button type="button" role="menuitem" onClick={() => setView("language")} className={row}>
                  <span>Audio</span>
                  <span className="flex min-w-0 items-center gap-1 text-white/70">
                    <span className="truncate">{audioName}</span> <ChevronRight className="size-4 shrink-0" />
                  </span>
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => setView("subtitles")} className={row}>
                <span>Subtitles</span>
                <span className="flex min-w-0 items-center gap-1 text-white/70">
                  <span className="truncate">{activeLabel}</span> <ChevronRight className="size-4 shrink-0" />
                </span>
              </button>
              {p.autoplay !== undefined && (
                <button type="button" role="menuitemcheckbox" aria-checked={p.autoplay} onClick={() => p.onAutoplay?.(!p.autoplay)} className={row}>
                  <span>Autoplay next</span>
                  <span className="text-white/70">{p.autoplay ? "On" : "Off"}</span>
                </button>
              )}
              {p.qualities.length > 1 && (
                <button type="button" role="menuitem" onClick={() => setView("quality")} className={row}>
                  <span>Quality</span>
                  <span className="flex items-center gap-1 text-white/70">
                    {qualityName} <ChevronRight className="size-4" />
                  </span>
                </button>
              )}
            </div>
          ) : (
            <>
              <button type="button" onClick={() => setView("main")} className={cn(row, "justify-start font-semibold")}>
                <ChevronLeft className="size-4" /> {title[view]}
              </button>
              <div className="border-t border-white/15 pt-1">
                {view === "speed" && <SpeedPanel rate={p.rate} onChange={p.onRate} onDone={close} defaultSpeed={p.defaultSpeed} />}
                {view === "subtitles" && (
                  <SubtitlePanel ownerKind={p.ownerKind} ownerId={p.ownerId} tracks={p.tracks} activeId={p.activeTrack} onSelect={p.onSelectTrack} onLoaded={p.onLoadedTrack} offset={p.subtitleOffset} onOffset={p.onSubtitleOffset} onDone={close} canKeep={p.canKeepSubtitles} />
                )}
                {view === "language" && (
                  <div role="menu" aria-label="Audio">
                    {audioChoices.map((a) => (
                      <button key={a.index} type="button" role="menuitemradio" aria-checked={a.index === (p.audioIndex ?? 0)} disabled={!a.supported} onClick={() => (p.onAudio?.(a.index), close())} className={cn(row, a.index === (p.audioIndex ?? 0) && "font-semibold text-primary", !a.supported && "opacity-50")}>
                        <span className="truncate">{a.label}{!a.supported && " (not supported here)"}</span>
                        {a.index === (p.audioIndex ?? 0) && <span aria-hidden>✓</span>}
                      </button>
                    ))}
                    {p.audioProblem && <p className="px-3 py-2 text-xs text-red-300">{p.audioProblem}</p>}
                  </div>
                )}
                {view === "quality" && (
                  <div role="menu" aria-label="Quality">
                    <button type="button" role="menuitemradio" aria-checked={mode === "auto"} onClick={() => (p.onQuality("@auto"), close())} className={cn(row, "flex-col items-start gap-0", mode === "auto" && "font-semibold text-primary")}>
                      <span className="flex w-full items-center justify-between">
                        <span>Automatic</span>
                        {mode === "auto" && <span aria-hidden>✓</span>}
                      </span>
                      <span className="text-xs font-normal text-white/60">Fitted to this screen and connection, each time</span>
                    </button>
                    <button type="button" role="menuitemradio" aria-checked={mode === "original"} onClick={() => (p.onQuality("@original"), close())} className={cn(row, "flex-col items-start gap-0", mode === "original" && "font-semibold text-primary")}>
                      <span className="flex w-full items-center justify-between">
                        <span>Original{best ? ` (${best})` : ""}</span>
                        {mode === "original" && <span aria-hidden>✓</span>}
                      </span>
                      <span className="text-xs font-normal text-white/60">The best version of every title</span>
                    </button>
                    <div className="my-1 border-t border-white/15" />
                    {p.qualities.map((q) => (
                      <button key={q.label} type="button" role="menuitemradio" aria-checked={mode === "pick" && q.label === p.quality} onClick={() => (p.onQuality(q.label), close())} className={cn(row, mode === "pick" && q.label === p.quality && "font-semibold text-primary")}>
                        <span>{q.name}</span>
                        {q.label === p.quality && <span aria-hidden className={mode === "pick" ? undefined : "text-white/40"}>{mode === "pick" ? "✓" : "playing"}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
