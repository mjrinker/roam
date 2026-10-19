"use client";

import { useEffect } from "react";
import { LAST_SERVER_COOKIE } from "@/lib/auth/last-server";

/** Remembers which server this browser (or installed app) was last in, so opening Roam goes straight back to it. A year, this site only. */
export function RememberServer({ serverId }: { serverId: string }) {
  useEffect(() => {
    document.cookie = `${LAST_SERVER_COOKIE}=${serverId}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  }, [serverId]);
  return null;
}
