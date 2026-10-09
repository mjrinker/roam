"use client";

import { useEffect } from "react";
import { SeamlessPlayer } from "@/components/player/seamless-player";
import type { DownloadRecord } from "@/lib/offline/types";

/**
 * Plays a downloaded video right where the list is: the player opens at once (with its own loading indicator) instead of waiting for a
 * page to load, and the back arrow and the phone's back button close it at once. The saved files are used, so no page from the server is needed.
 */
export function LocalVideoOverlay({ record, onClose }: { record: DownloadRecord; onClose: () => void }) {
  useEffect(() => {
    window.history.pushState({ roamLocalPlayer: true }, "");
    const closeOnBack = () => onClose();
    window.addEventListener("popstate", closeOnBack);
    return () => window.removeEventListener("popstate", closeOnBack);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] bg-black">
      <SeamlessPlayer
        ownerKind={record.ownerKind}
        ownerId={record.ownerId}
        title={record.title}
        subtitle={record.subtitle}
        backHref="#"
        onBack={() => window.history.back()}
      />
    </div>
  );
}
