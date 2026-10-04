"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ViewerAvatar } from "@/components/profiles/viewer-avatar";
import { ConfirmDialog } from "@/components/playlists/confirm-dialog";
import { playlistApi } from "@/components/playlists/playlist-api";

export interface ModerationItem {
  id: string;
  name: string;
  owner: { name: string; avatarKey: string } | null;
}

/** The server's public playlists, each with a delete button for admins. */
export function ModerationList({ serverId, playlists }: { serverId: string; playlists: ModerationItem[] }) {
  const router = useRouter();
  const [target, setTarget] = useState<ModerationItem | null>(null);

  return (
    <>
      <ul className="flex flex-col gap-2">
        {playlists.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08]">
            {p.owner ? <ViewerAvatar avatarKey={p.owner.avatarKey} size="sm" /> : <span className="size-9 shrink-0" />}
            <div className="flex min-w-0 flex-1 flex-col">
              <Link href={`/s/${serverId}/playlists/${p.id}`} className="truncate text-sm font-medium hover:text-primary">
                {p.name}
              </Link>
              <span className="text-xs text-muted-foreground">{p.owner ? p.owner.name : "No owner"}</span>
            </div>
            <Button variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setTarget(p)}>
              <Trash2 className="size-4" /> Delete
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={target ? `Delete “${target.name}”?` : "Delete playlist"}
        description="It's visible to everyone on this server. This removes it for everyone and can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!target) return null;
          const res = await playlistApi.remove(target.id);
          if (!res.ok) return res.status === 404 ? "It's already gone." : res.error;
          toast.success("Playlist deleted.");
          router.refresh();
          return null;
        }}
      />
    </>
  );
}
