"use client";

import { useEffect } from "react";
import { useVideoSessionActions } from "@/components/player/video-session";
import type { VideoSessionInfo } from "@/components/player/video-session-state";

/**
 * What the watch page renders: it asks the video session (kept above the pages) to fill the screen with this video, and when the page goes
 * away it asks for the player to shrink to the floating bar instead of stopping.
 */
export function WatchSession({ ownerKind, ownerId, title, subtitle, backHref, nextHref, nextLabel, watchHref }: VideoSessionInfo) {
  const actions = useVideoSessionActions();
  useEffect(() => {
    if (!actions) return;
    actions.open({ ownerKind, ownerId, title, subtitle, backHref, nextHref, nextLabel, watchHref });
    return () => actions.minimize();
  }, [actions, ownerKind, ownerId, title, subtitle, backHref, nextHref, nextLabel, watchHref]);
  // The player itself is drawn over the page by the session; this just keeps the screen black until it is there.
  return <div className="h-dvh bg-black" />;
}
