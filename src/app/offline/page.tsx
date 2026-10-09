"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useDownloads } from "@/lib/offline/use-downloads";
import { DownloadsList } from "@/components/offline/downloads-list";
import { SeamlessPlayer } from "@/components/player/seamless-player";
import { AudioPlayerProvider } from "@/components/audio/audio-player-provider";
import { MiniPlayer } from "@/components/audio/mini-player";

const subscribeToLocation = () => () => undefined;
const playParam = () => new URLSearchParams(window.location.search).get("play");

/**
 * What opens when the app is started with no connection (the service worker answers every page with this one): the downloads saved on this
 * device, and a player for them. It needs nothing from the server, which is why it is a plain static page.
 */
export default function OfflinePage() {
  const records = useDownloads();
  const playId = useSyncExternalStore(subscribeToLocation, playParam, () => null);
  const online = useOnline();
  const playing = playId ? records.find((r) => r.id === playId && r.status === "complete") : undefined;

  if (playing && playing.kind === "watch") {
    return (
      <AudioPlayerProvider>
        <SeamlessPlayer ownerKind={playing.ownerKind} ownerId={playing.ownerId} title={playing.title} subtitle={playing.subtitle} backHref="/offline" />
      </AudioPlayerProvider>
    );
  }
  return (
    <AudioPlayerProvider>
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-10 sm:px-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{online ? "Downloads" : "You're offline"}</h1>
        <p className="mt-1 text-muted-foreground">{online ? "Saved on this device." : "What you've downloaded to this device is here to play."}</p>
      </header>
      <DownloadsList playTo={(r) => `/offline?play=${encodeURIComponent(r.id)}`} />
    </main>
    <MiniPlayer serverId="offline" />
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
