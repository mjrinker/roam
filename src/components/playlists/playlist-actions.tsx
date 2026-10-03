"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, LogOut, Pencil, Play, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/playlists/confirm-dialog";
import { NameDialog } from "@/components/playlists/name-dialog";
import { playlistApi } from "@/components/playlists/playlist-api";
import { ShareDialog } from "@/components/playlists/share-dialog";
import { showShareButton, type ShareCaps } from "@/components/playlists/sharing";

export interface PlaylistActionFlags {
  rename: boolean;
  delete: boolean;
  leave: boolean;
  copy: boolean;
}

const secondary = "h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20";

/** Play all, plus copy / rename / leave / delete according to what this profile is allowed to do. */
export function PlaylistActions({
  serverId,
  playlistId,
  name,
  playHref,
  can,
  visibility,
  ownerId,
  shareCaps,
}: {
  serverId: string;
  playlistId: string;
  name: string;
  /** Where "Play all" goes, or null when nothing in the playlist is playable. */
  playHref: string | null;
  can: PlaylistActionFlags;
  visibility: "private" | "server";
  ownerId: string | null;
  shareCaps: ShareCaps;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const listHref = `/s/${serverId}/playlists`;

  async function copy() {
    setCopying(true);
    const res = await playlistApi.copy(playlistId);
    setCopying(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Copied ${res.data.itemsCopied} item${res.data.itemsCopied === 1 ? "" : "s"} to "${res.data.name}".`);
    router.push(`${listHref}/${res.data.id}`);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        {playHref ? (
          <Button
            render={<Link href={playHref} />}
            className="h-12 gap-2.5 rounded-xl px-8 text-base font-semibold shadow-[0_10px_34px_-8px_oklch(0.853_0.163_169/0.7)]"
          >
            <Play className="size-5" fill="currentColor" /> Play all
          </Button>
        ) : (
          <Button disabled className="h-12 gap-2.5 rounded-xl px-8 text-base font-semibold" title="Nothing here is playable yet">
            <Play className="size-5" fill="currentColor" /> Play all
          </Button>
        )}
        {can.copy && (
          <Button variant="secondary" className={secondary} disabled={copying} onClick={copy} title="Make your own copy">
            <Copy className="size-4" /> {copying ? "Copying…" : "Copy"}
          </Button>
        )}
        {showShareButton(shareCaps) && (
          <Button variant="secondary" className={secondary} onClick={() => setSharing(true)}>
            <Share2 className="size-4" /> Share
          </Button>
        )}
        {can.rename && (
          <Button variant="secondary" className={secondary} onClick={() => setRenaming(true)}>
            <Pencil className="size-4" /> Rename
          </Button>
        )}
        {can.leave && (
          <Button variant="secondary" className={secondary} onClick={() => setLeaving(true)}>
            <LogOut className="size-4" /> Leave
          </Button>
        )}
        {can.delete && (
          <Button variant="secondary" className={secondary} onClick={() => setDeleting(true)}>
            <Trash2 className="size-4" /> Delete
          </Button>
        )}
      </div>

      {sharing && (
        <ShareDialog
          open
          onOpenChange={setSharing}
          serverId={serverId}
          playlistId={playlistId}
          visibility={visibility}
          ownerId={ownerId}
          caps={shareCaps}
          onChanged={() => router.refresh()}
        />
      )}
      {renaming && (
        <NameDialog
          open
          onOpenChange={setRenaming}
          title="Rename playlist"
          submitLabel="Save"
          initialName={name}
          onSubmit={async (next) => {
            const res = await playlistApi.rename(playlistId, next);
            if (!res.ok) return res.error;
            router.refresh();
            return null;
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${name}"?`}
        description="This removes the playlist for everyone it's shared with. The movies and shows themselves aren't touched."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          const res = await playlistApi.remove(playlistId);
          if (!res.ok) return res.error;
          router.push(listHref);
          return null;
        }}
      />
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave "${name}"?`}
        description="It will disappear from your playlists. The owner can share it with you again."
        confirmLabel="Leave"
        onConfirm={async () => {
          const res = await playlistApi.leave(playlistId);
          if (!res.ok) return res.error;
          router.push(listHref);
          return null;
        }}
      />
    </>
  );
}
