"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getSnapshot, initDownloads, subscribe } from "./manager";
import type { DownloadRecord } from "./types";

const empty: DownloadRecord[] = [];

/** The downloads on this device, kept current while they run. Empty on the server and until they have loaded. */
export function useDownloads(): DownloadRecord[] {
  useEffect(() => {
    void initDownloads();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, () => empty);
}
