"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatSpeed } from "@/lib/player/speed";
import { SpeedPanel, type DefaultSpeed } from "@/components/player/speed-menu";
import { SubtitlePanel, type LoadedTrack } from "@/components/player/subtitles";

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
  tracks: readonly LoadedTrack[];
  activeTrack: string | null;
  onSelectTrack: (id: string | null) => void;
  onLoadedTrack: (t: LoadedTrack) => void;
  subtitleOffset: number;
  onSubtitleOffset: (seconds: number) => void;
  /** The resolution versions on offer (shown only when there is more than one) and the one playing. */
  qualities: readonly QualityOption[];
  quality: string;
  onQuality: (label: string) => void;
}

type View = "main" | "speed" | "subtitles" | "quality";

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
  const qualityName = p.qualities.find((q) => q.label === p.quality)?.name ?? "";
  const row = "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-white/15 focus-visible:bg-white/15";
  const title: Record<Exclude<View, "main">, string> = { speed: "Speed", subtitles: "Subtitles", quality: "Quality" };

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
              <button type="button" role="menuitem" onClick={() => setView("subtitles")} className={row}>
                <span>Subtitles</span>
                <span className="flex min-w-0 items-center gap-1 text-white/70">
                  <span className="truncate">{activeLabel}</span> <ChevronRight className="size-4 shrink-0" />
                </span>
              </button>
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
                  <SubtitlePanel ownerKind={p.ownerKind} ownerId={p.ownerId} tracks={p.tracks} activeId={p.activeTrack} onSelect={p.onSelectTrack} onLoaded={p.onLoadedTrack} offset={p.subtitleOffset} onOffset={p.onSubtitleOffset} onDone={close} />
                )}
                {view === "quality" && (
                  <div role="menu" aria-label="Quality">
                    {p.qualities.map((q) => (
                      <button key={q.label} type="button" role="menuitemradio" aria-checked={q.label === p.quality} onClick={() => (p.onQuality(q.label), close())} className={cn(row, q.label === p.quality && "font-semibold text-primary")}>
                        <span>{q.name}</span>
                        {q.label === p.quality && <span aria-hidden>✓</span>}
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
