"use client";

import { useState } from "react";
import { DownloadsList as List } from "@/components/offline/downloads-list";
import { LocalVideoOverlay } from "@/components/offline/local-video-overlay";
import type { DownloadRecord } from "@/lib/offline/types";

/** The downloads list on the server's own pages: a downloaded video opens in a player over the list at once. */
export function DownloadsList() {
  const [playing, setPlaying] = useState<DownloadRecord | null>(null);
  return (
    <>
      <List onPlayVideo={setPlaying} />
      {playing && <LocalVideoOverlay record={playing} onClose={() => setPlaying(null)} />}
    </>
  );
}
