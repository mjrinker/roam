"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NameDialog } from "@/components/playlists/name-dialog";
import { playlistApi } from "@/components/playlists/playlist-api";

export function NewPlaylistButton({ serverId }: { serverId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function create(name: string): Promise<string | null> {
    const res = await playlistApi.create(serverId, name);
    if (!res.ok) return res.error;
    router.push(`/s/${serverId}/playlists/${res.data.id}`);
    return null;
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} className="gap-2 rounded-xl">
        <Plus className="size-4" /> New playlist
      </Button>
      {open && (
        <NameDialog
          open
          onOpenChange={setOpen}
          title="New playlist"
          description="It will be private to you until you share it."
          submitLabel="Create"
          onSubmit={create}
        />
      )}
    </>
  );
}
