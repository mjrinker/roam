"use client";

import { useState } from "react";
import { Loader2, Radio } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAudioPlayer } from "@/components/audio/audio-player-provider";

/** The address that asks for a radio: from an artist, or from one song (which then plays first). */
export function radioUrl(seed: { artistId: string } | { songId: string }): string {
  return "artistId" in seed ? `/api/music/radio?artist=${encodeURIComponent(seed.artistId)}` : `/api/music/radio?song=${encodeURIComponent(seed.songId)}`;
}

/** Starts a radio: songs from this library that sound like the artist (or song), played one after another. */
export function RadioButton({ seed, variant = "button" }: { seed: { artistId: string } | { songId: string }; variant?: "button" | "icon" }) {
  const p = useAudioPlayer();
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!p || busy) return;
    setBusy(true);
    try {
      const res = await fetch(radioUrl(seed));
      const body = (await res.json().catch(() => ({}))) as { ids?: string[]; artistName?: string; error?: string };
      if (!res.ok || !body.ids?.length) throw new Error(body.error ?? "No radio for this one.");
      const result = await p.playList(body.ids, 0);
      if (!result.ok) throw new Error(result.error ?? "Couldn't start the radio.");
      toast.success(`Radio from ${body.artistName ?? "this artist"}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const icon = busy ? <Loader2 className="size-4 animate-spin" /> : <Radio className={variant === "icon" ? "size-[18px]" : "size-4"} />;
  if (variant === "icon") {
    return (
      <button type="button" aria-label="Start radio from this song" title="Start radio from this song" disabled={!p || busy} onClick={() => void start()} className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:opacity-40">
        {icon}
      </button>
    );
  }
  return (
    <Button variant="secondary" disabled={!p || busy} onClick={() => void start()} title="Songs from this library that sound like this artist" className="h-12 gap-2 rounded-xl px-5">
      {icon} Radio
    </Button>
  );
}
