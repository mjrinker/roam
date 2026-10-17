"use client";

import { useState } from "react";
import { Plus, Tag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NameDialog } from "@/components/playlists/name-dialog";

interface TitleLabel {
  id: string;
  name: string;
  has: boolean;
}

/** "Labels" on a movie, show or book: a checklist of the profile's own labels, ticked where the title is under it, and a way to make a new one. */
export function LabelsMenu({ titleId, initialCount = 0 }: { titleId: string; /** How many labels the title has now, for the button's badge. */ initialCount?: number }) {
  const [labels, setLabels] = useState<TitleLabel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const count = labels ? labels.filter((l) => l.has).length : initialCount;

  async function load() {
    setLoadError(null);
    try {
      const res = await fetch(`/api/labels?title=${titleId}`);
      const body = (await res.json().catch(() => ({}))) as { labels?: TitleLabel[]; error?: string };
      if (!res.ok || !body.labels) throw new Error(body.error ?? "Couldn't load your labels.");
      setLabels(body.labels);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  async function toggle(label: TitleLabel, on: boolean) {
    setBusyId(label.id);
    setLabels((cur) => cur?.map((l) => (l.id === label.id ? { ...l, has: on } : l)) ?? cur);
    try {
      const res = await fetch(`/api/labels/${label.id}/items`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ titleId, on }) });
      if (!res.ok) throw new Error();
    } catch {
      setLabels((cur) => cur?.map((l) => (l.id === label.id ? { ...l, has: !on } : l)) ?? cur);
      toast.error("Couldn't change that label.");
    }
    setBusyId(null);
  }

  async function createAndAdd(name: string): Promise<string | null> {
    const res = await fetch("/api/labels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, titleId }) });
    const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
    if (!res.ok || !body.id) return body.error ?? "Couldn't make that label.";
    setLabels((cur) => [...(cur ?? []), { id: body.id as string, name: body.name ?? name, has: true }].sort((a, b) => a.name.localeCompare(b.name)));
    toast.success(`Labelled "${body.name ?? name}".`);
    return null;
  }

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger render={<Button variant="secondary" className="h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20" title="Your labels for this" />}>
          <Tag className="size-4" />
          Labels{count > 0 ? ` · ${count}` : ""}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
          {labels === null && !loadError && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
          {loadError && <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>}
          {labels?.length === 0 && <DropdownMenuItem disabled>No labels yet</DropdownMenuItem>}
          {labels?.map((l) => (
            <DropdownMenuCheckboxItem key={l.id} checked={l.has} disabled={busyId === l.id} closeOnClick={false} onCheckedChange={(on) => void toggle(l, on)}>
              <span className="truncate">{l.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNaming(true)}>
            <Plus className="size-4" /> New label…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {naming && (
        <NameDialog open onOpenChange={setNaming} title="New label" description="Only you see your labels. Use them to filter a library or a smart playlist." submitLabel="Create and add" placeholder="Label name, like Date night" onSubmit={createAndAdd} />
      )}
    </>
  );
}
