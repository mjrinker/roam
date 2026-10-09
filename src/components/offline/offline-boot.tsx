"use client";

import { useEffect } from "react";
import { initDownloads } from "@/lib/offline/manager";
import { flushProgress } from "@/lib/offline/sync";

/**
 * Starts the offline support when the app opens: registers the service worker (so the app can open with no connection), brings back the
 * downloads (those interrupted by closing the page carry on), and sends progress made offline as soon as there is a connection.
 */
export function OfflineBoot() {
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    void initDownloads().catch(() => undefined);
    const flush = () => void flushProgress();
    if (navigator.onLine) flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, []);
  return null;
}
