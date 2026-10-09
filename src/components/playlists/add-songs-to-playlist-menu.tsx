"use client";

import { useState } from "react";
import { ListPlus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NameDialog } from "@/components/playlists/name-dialog";
import { playlistApi, type SongsTarget } from "@/components/playlists/playlist-api";

/** What to say after adding songs: how many went in, and how many were already there. */
export function addedMessage(name: string, added: number, skipped: number): string {
  const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;
  if (added === 0) return `All ${songs(skipped)} ${skipped === 1 ? "was" : "were"} already in "${name}".`;
  return skipped === 0 ? `Added ${songs(added)} to "${name}".` : `Added ${songs(added)} to "${name}" (${skipped} already there).`;
}

/**
 * "Add to playlist" for a whole album or all of an artist's songs: pick a playlist and every song goes in as its own item (songs
 * already in it are skipped). "New playlist…" makes one and adds to it.
 */
export function AddSongsToPlaylistMenu({ serverId, target, label = "Add to playlist" }: { serverId: string; target: SongsTarget; label?: string }) {
  const [playlists, setPlaylists] = useState<{ id: string; name: string }[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoadError(null);
    const res = await playlistApi.editable(serverId);
    if (res.ok) setPlaylists(res.data.playlists);
    else setLoadError(res.error);
  }

  async function add(playlistId: string, name: string): Promise<string | null> {
    setBusy(true);
    const res = await playlistApi.addSongs(playlistId, target);
    setBusy(false);
    if (!res.ok) return res.error;
    toast.success(addedMessage(name, res.data.added, res.data.skipped));
    return null;
  }

  async function createAndAdd(name: string): Promise<string | null> {
    const created = await playlistApi.create(serverId, name);
    if (!created.ok) return created.error;
    setPlaylists((cur) => [{ id: created.data.id, name: created.data.name }, ...(cur ?? [])]);
    return add(created.data.id, created.data.name);
  }

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger render={<Button variant="secondary" disabled={busy} className="h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20" title={label} />}>
          <ListPlus className="size-4" />
          {label}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
          {playlists === null && !loadError && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
          {loadError && <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>}
          {playlists?.length === 0 && <DropdownMenuItem disabled>No playlists yet</DropdownMenuItem>}
          {playlists?.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onClick={async () => {
                const error = await add(p.id, p.name);
                if (error) toast.error(error);
              }}
            >
              <span className="truncate">{p.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNaming(true)}>
            <Plus className="size-4" /> New playlist…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {naming && <NameDialog open onOpenChange={setNaming} title="New playlist" description="It will be private to you until you share it." submitLabel="Create and add" onSubmit={createAndAdd} />}
    </>
  );
}
