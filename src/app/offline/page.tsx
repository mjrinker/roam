"use client";

import { useCallback, useEffect, useState } from "react";
import { DownloadsList } from "@/components/offline/downloads-list";
import { LocalVideoOverlay } from "@/components/offline/local-video-overlay";
import { AudioPlayerProvider } from "@/components/audio/audio-player-provider";
import { MiniPlayer } from "@/components/audio/mini-player";
import type { DownloadRecord } from "@/lib/offline/types";

/**
 * What opens when the app is started with no connection (the service worker answers every page with this one): the downloads saved on this
 * device, and a player for them. It needs nothing from the server, which is why it is a plain static page.
 */
export default function OfflinePage() {
  const online = useOnline();
  const [playing, setPlaying] = useState<DownloadRecord | null>(null);
  const close = useCallback(() => setPlaying(null), []);
  return (
    <AudioPlayerProvider>
      <main className="mx-auto flex min-h-dvh w-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-10 sm:px-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{online ? "Downloads" : "You're offline"}</h1>
          <p className="mt-1 text-muted-foreground">{online ? "Saved on this device." : "What you've downloaded to this device is here to play."}</p>
        </header>
        <DownloadsList onPlayVideo={setPlaying} />
      </main>
      <MiniPlayer serverId="offline" />
      {playing && <LocalVideoOverlay record={playing} onClose={close} />}
    </AudioPlayerProvider>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
