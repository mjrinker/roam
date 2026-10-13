"use client";

import { useEffect, useState } from "react";
import { useVideoSessionActions } from "@/components/player/video-session";
import type { VideoSessionInfo } from "@/components/player/video-session-state";

/**
 * What the watch page renders: it asks the video session (kept above the pages) to fill the screen with this video. When the viewer leaves
 * the watch pages, the session shrinks the player to the floating bar instead of stopping it.
 */
export function WatchSession({ ownerKind, ownerId, title, subtitle, backHref, nextHref, nextLabel, watchHref, startAt }: VideoSessionInfo) {
  const actions = useVideoSessionActions();
  // One request per time this page opens, so choosing the same chapter again (while the video is still open) seeks again.
  const [startToken] = useState(() => Date.now());
  useEffect(() => {
    if (!actions) return;
    actions.open({ ownerKind, ownerId, title, subtitle, backHref, nextHref, nextLabel, watchHref, startAt, startToken });
    // Nothing on the way out: the session shrinks the player itself once the address is no longer a watch page.
  }, [actions, ownerKind, ownerId, title, subtitle, backHref, nextHref, nextLabel, watchHref, startAt, startToken]);
  // The player itself is drawn over the page by the session; this just keeps the screen black until it is there.
  return <div className="h-dvh bg-black" />;
}
