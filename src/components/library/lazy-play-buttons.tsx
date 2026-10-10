"use client";

import { useState } from "react";
import { Loader2, Play, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { useAudioPlayer } from "@/components/audio/audio-player-provider";
import { Button } from "@/components/ui/button";
import { shuffled } from "@/lib/music/list-queue";

/**
 * Play and Shuffle for a whole list that the page only shows a part of (all the songs of a library, or of one artist, album or genre):
 * the songs are listed when a button is pressed, then queued so the player carries on through them. `idsUrl` lists the song ids.
 */
export function LazyPlayButtons({ idsUrl, noun = "songs" }: { idsUrl: string; noun?: string }) {
  const p = useAudioPlayer();
  const [busy, setBusy] = useState<"play" | "shuffle" | null>(null);

  async function start(mode: "play" | "shuffle") {
    if (!p) return;
    setBusy(mode);
    try {
      const res = await fetch(idsUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`Couldn't list the ${noun}.`);
      const { ids } = (await res.json()) as { ids: string[] };
      if (ids.length === 0) throw new Error(`There are no ${noun} to play.`);
      const result = await p.playList(mode === "shuffle" ? shuffled(ids) : ids, 0);
      if (!result.ok) throw new Error(result.error ?? "Couldn't start playing.");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={!p || busy !== null} onClick={() => void start("play")} className="h-11 gap-2 rounded-xl px-6 font-semibold">
        {busy === "play" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" fill="currentColor" />} Play
      </Button>
      <Button variant="secondary" disabled={!p || busy !== null} onClick={() => void start("shuffle")} className="h-11 gap-2 rounded-xl px-5">
        {busy === "shuffle" ? <Loader2 className="size-4 animate-spin" /> : <Shuffle className="size-4" />} Shuffle
      </Button>
    </div>
  );
}
