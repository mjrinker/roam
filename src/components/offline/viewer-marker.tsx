"use client";

import { useEffect } from "react";
import { setOfflineViewer } from "@/lib/offline/viewer";
import { notifyViewerChanged } from "@/lib/offline/manager";

/** Records which profile is using this browser (rendered by the signed-in layout), so downloads are kept per profile. */
export function ViewerMarker({ viewerId }: { viewerId: string }) {
  useEffect(() => {
    setOfflineViewer(viewerId);
    notifyViewerChanged();
  }, [viewerId]);
  return null;
}
