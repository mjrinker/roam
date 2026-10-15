"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Layers, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NameDialog } from "@/components/playlists/name-dialog";

const send = async (url: string, method: string, body?: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> => {
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return res.ok ? { ok: true, data } : { ok: false, error: typeof data.error === "string" ? data.error : "That didn't work." };
};

/** Admin: makes a new, empty collection in a library and opens it. */
export function NewCollectionButton({ serverId, libraryId }: { serverId: string; libraryId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  async function create(name: string): Promise<string | null> {
    const r = await send("/api/collections", "POST", { libraryId, name });
    if (!r.ok) return r.error;
    router.push(`/s/${serverId}/collection/${r.data.id}`);
    return null;
  }
  return (
    <>
      <Button variant="secondary" className="h-9 gap-2 rounded-xl" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> New collection
      </Button>
      {open && <NameDialog open onOpenChange={setOpen} title="New collection" description="Pick titles for it afterwards, from each title's page." submitLabel="Create" placeholder="Collection name" onSubmit={create} />}
    </>
  );
}

/** Admin: rename and delete a hand-made collection. */
export function CollectionAdminBar({ serverId, libraryId, id, name }: { serverId: string; libraryId: string; id: string; name: string }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  async function rename(next: string): Promise<string | null> {
    const r = await send(`/api/collections/${id}`, "PATCH", { name: next });
    if (!r.ok) return r.error;
    router.refresh();
    return null;
  }
  async function remove() {
    if (!window.confirm(`Delete the collection "${name}"? What is in it stays in the library.`)) return;
    const r = await send(`/api/collections/${id}`, "DELETE");
    if (!r.ok) return void toast.error(r.error);
    router.push(`/s/${serverId}/library/${libraryId}?view=collections`);
  }
  return (
    <div className="flex gap-2">
      <Button variant="secondary" className="h-9 gap-2 rounded-xl" onClick={() => setRenaming(true)}>
        <Pencil className="size-4" /> Rename
      </Button>
      <Button variant="secondary" className="h-9 gap-2 rounded-xl text-destructive" onClick={() => void remove()}>
        <Trash2 className="size-4" /> Delete
      </Button>
      {renaming && <NameDialog open onOpenChange={setRenaming} title="Rename collection" submitLabel="Rename" initialName={name} placeholder="Collection name" onSubmit={rename} />}
    </div>
  );
}

/** Admin: takes one title out of a hand-made collection. */
export function RemoveFromCollectionButton({ collectionId, titleId, titleName }: { collectionId: string; titleId: string; titleName: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label={`Remove ${titleName} from this collection`}
      title="Remove from this collection"
      className="absolute top-2 right-2 z-10 flex size-7 cursor-pointer items-center justify-center rounded-full bg-black/70 text-white opacity-0 backdrop-blur transition group-hover/item:opacity-100 focus-visible:opacity-100"
      onClick={async () => {
        const r = await send(`/api/collections/${collectionId}/items`, "DELETE", { titleId });
        if (!r.ok) return void toast.error(r.error);
        router.refresh();
      }}
    >
      <X className="size-4" />
    </button>
  );
}

interface Option {
  id: string;
  name: string;
  has: boolean;
}

/** Admin: a checklist of the library's hand-made collections for one title, with "New collection…". */
export function AddToCollectionMenu({ libraryId, titleId }: { libraryId: string; titleId: string }) {
  const router = useRouter();
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

  async function load() {
    setError(null);
    const r = await send(`/api/collections?libraryId=${libraryId}&titleId=${titleId}`, "GET");
    if (r.ok) setOptions(r.data.collections as Option[]);
    else setError(r.error);
  }
  async function toggle(o: Option, checked: boolean) {
    const r = checked ? await send(`/api/collections/${o.id}/items`, "PUT", { titleIds: [titleId] }) : await send(`/api/collections/${o.id}/items`, "DELETE", { titleId });
    if (!r.ok) return void toast.error(r.error);
    setOptions((cur) => cur?.map((x) => (x.id === o.id ? { ...x, has: checked } : x)) ?? cur);
    toast.success(checked ? `Added to "${o.name}".` : `Removed from "${o.name}".`);
    router.refresh();
  }
  async function createAndAdd(name: string): Promise<string | null> {
    const made = await send("/api/collections", "POST", { libraryId, name });
    if (!made.ok) return made.error;
    const added = await send(`/api/collections/${made.data.id}/items`, "PUT", { titleIds: [titleId] });
    if (!added.ok) return added.error;
    setOptions((cur) => [...(cur ?? []), { id: made.data.id as string, name, has: true }]);
    toast.success(`Added to "${name}".`);
    router.refresh();
    return null;
  }

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger render={<Button variant="secondary" className="h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20" title="Add to a collection" />}>
          <Layers className="size-4" /> Add to collection
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
          {options === null && !error && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
          {error && <DropdownMenuItem disabled>{error}</DropdownMenuItem>}
          {options?.length === 0 && <DropdownMenuItem disabled>No collections yet</DropdownMenuItem>}
          {options?.map((o) => (
            <DropdownMenuCheckboxItem key={o.id} checked={o.has} closeOnClick={false} onCheckedChange={(checked) => void toggle(o, checked)}>
              <span className="truncate">{o.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNaming(true)}>
            <Plus className="size-4" /> New collection…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {naming && <NameDialog open onOpenChange={setNaming} title="New collection" submitLabel="Create and add" placeholder="Collection name" onSubmit={createAndAdd} />}
    </>
  );
}
