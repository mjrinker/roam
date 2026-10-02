"use client";

import { useState } from "react";
import { ListPlus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { NameDialog } from "@/components/playlists/name-dialog";
import { playlistApi, type EditablePlaylist, type ItemTarget } from "@/components/playlists/playlist-api";

/**
 * "Add to playlist": a checklist of the playlists this profile can edit, ticked
 * where the item is already in. Ticking adds, unticking removes; "New playlist…"
 * creates one and adds the item to it.
 */
export function AddToPlaylistMenu({
  serverId,
  target,
  variant = "hero",
}: {
  serverId: string;
  target: ItemTarget;
  /** `hero` is a labelled button for detail pages; `icon` is a compact round button for list rows. */
  variant?: "hero" | "icon";
}) {
  const [playlists, setPlaylists] = useState<EditablePlaylist[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

  async function load() {
    setLoadError(null);
    const res = await playlistApi.forItem(serverId, target);
    if (res.ok) setPlaylists(res.data.playlists);
    else setLoadError(res.error);
  }

  async function toggle(p: EditablePlaylist, checked: boolean) {
    setBusyId(p.id);
    if (checked) {
      const res = await playlistApi.addItem(p.id, target);
      if (res.ok) {
        setPlaylists((cur) => cur?.map((x) => (x.id === p.id ? { ...x, itemId: res.data.id } : x)) ?? cur);
        toast.success(`Added to "${p.name}".`);
      } else toast.error(res.error);
    } else if (p.itemId) {
      const res = await playlistApi.removeItem(p.id, p.itemId);
      if (res.ok) {
        setPlaylists((cur) => cur?.map((x) => (x.id === p.id ? { ...x, itemId: null } : x)) ?? cur);
        toast.success(`Removed from "${p.name}".`);
      } else toast.error(res.error);
    }
    setBusyId(null);
  }

  async function createAndAdd(name: string): Promise<string | null> {
    const created = await playlistApi.create(serverId, name);
    if (!created.ok) return created.error;
    const added = await playlistApi.addItem(created.data.id, target);
    if (!added.ok) return added.error;
    setPlaylists((cur) => [{ id: created.data.id, name: created.data.name, itemId: added.data.id }, ...(cur ?? [])]);
    toast.success(`Added to "${created.data.name}".`);
    return null;
  }

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger
          render={
            variant === "hero" ? (
              <Button
                variant="secondary"
                className="h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20"
                title="Add to a playlist"
              />
            ) : (
              <button
                type="button"
                aria-label="Add to playlist"
                title="Add to playlist"
                className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:outline-none"
              />
            )
          }
        >
          <ListPlus className={cn(variant === "icon" ? "size-[18px]" : "size-4")} />
          {variant === "hero" && "Add to playlist"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
          {playlists === null && !loadError && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
          {loadError && <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>}
          {playlists?.length === 0 && <DropdownMenuItem disabled>No playlists yet</DropdownMenuItem>}
          {playlists?.map((p) => (
            <DropdownMenuCheckboxItem
              key={p.id}
              checked={p.itemId !== null}
              disabled={busyId === p.id}
              closeOnClick={false}
              onCheckedChange={(checked) => void toggle(p, checked)}
            >
              <span className="truncate">{p.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNaming(true)}>
            <Plus className="size-4" /> New playlist…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {naming && (
        <NameDialog
          open
          onOpenChange={setNaming}
          title="New playlist"
          description="It will be private to you until you share it."
          submitLabel="Create and add"
          onSubmit={createAndAdd}
        />
      )}
    </>
  );
}
