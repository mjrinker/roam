"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Admin only: look this album up on MusicBrainz again on the next scan (after fixing a folder name, say). */
export function AlbumRematchButton({ albumId, matched }: { albumId: string; matched: boolean }) {
  const [busy, setBusy] = useState(false);

  async function rematch() {
    setBusy(true);
    const res = await fetch(`/api/albums/${albumId}/rematch`, { method: "POST" });
    setBusy(false);
    if (res.ok) toast.success("This album will be looked up again on the next scan.");
    else toast.error(res.status === 409 ? "Turn on the MusicBrainz look-up for this library first." : "Couldn't ask for a new look-up.");
  }

  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={rematch} className="gap-2 text-muted-foreground">
      <RefreshCw className="size-3.5" />
      {matched ? "Look up again" : "Look up on MusicBrainz"}
    </Button>
  );
}
