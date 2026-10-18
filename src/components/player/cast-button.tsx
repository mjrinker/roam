"use client";

import { Cast } from "lucide-react";
import { cn } from "@/lib/utils";

/** Sends the picture to a Chromecast (shown only when there is one) or, in Safari, opens the AirPlay picker. */
export function CastButton({ available, airPlay, onCast, onAirPlay, problem }: { available: boolean; airPlay: boolean; onCast: () => void; onAirPlay: () => void; problem: string | null }) {
  if (!available && !airPlay) return null;
  return (
    <button type="button" aria-label={available ? "Cast to a TV" : "AirPlay"} title={problem ?? (available ? "Cast to a TV" : "AirPlay")} onClick={available ? onCast : onAirPlay} className={cn("flex size-10 items-center justify-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-ring", problem && "text-red-300")}>
      <Cast className="size-5" />
    </button>
  );
}
