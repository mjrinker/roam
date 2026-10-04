"use client";

import { useEffect, useState } from "react";
import { Globe, Loader2, Lock, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { LibraryAccess } from "@/lib/db/schema";

interface Person {
  accountId: string;
  name: string;
  isAdmin: boolean;
  granted: boolean;
}

/** Who can see a library: everyone on the server, or only server admins plus the people picked here. */
export function LibraryAccessDialog({
  libraryId,
  libraryName,
  open,
  onOpenChange,
  onSaved,
}: {
  libraryId: string;
  libraryName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (access: LibraryAccess) => void;
}) {
  const [access, setAccess] = useState<LibraryAccess>("restricted");
  const [people, setPeople] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The dialog mounts fresh each time it opens, so `loading` starts true.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/libraries/${libraryId}/access`);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError("Couldn't load who can see this library.");
      } else {
        const body = (await res.json()) as { access: LibraryAccess; people: Person[] };
        setAccess(body.access);
        setPeople(body.people);
        const granted = new Set(body.people.filter((p) => p.granted).map((p) => p.accountId));
        setSelected(new Set(granted));
        setInitial(granted);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  function toggle(accountId: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/libraries/${libraryId}/access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // Only what changed, so accounts this dialog never listed keep their access.
      body: JSON.stringify({
        access,
        grant: [...selected].filter((id) => !initial.has(id)),
        revoke: [...initial].filter((id) => !selected.has(id)),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(typeof body.error === "string" ? body.error : "Couldn't save.");
      return;
    }
    toast.success("Library access saved.");
    onSaved(access);
    onOpenChange(false);
  }

  const options = [
    { value: "restricted", label: "Only people I choose", hint: "Server admins plus the people checked below.", icon: Lock },
    { value: "everyone", label: "Everyone on this server", hint: "Anyone who's a member can see it.", icon: Globe },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Who can see “{libraryName}”</DialogTitle>
          <DialogDescription>Profiles with an age limit still only see what that limit allows.</DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        {!loading && !loadError && (
          <>
            <div className="grid gap-2">
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={access === o.value}
                  onClick={() => setAccess(o.value)}
                  className={cn(
                    "flex items-start gap-3 rounded-xl px-3 py-2.5 text-left ring-1 transition",
                    access === o.value ? "bg-primary/15 ring-primary/40" : "bg-white/[0.05] ring-white/10 hover:bg-white/[0.08]"
                  )}
                >
                  <o.icon className="mt-0.5 size-4 shrink-0" />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{o.label}</span>
                    <span className="text-xs text-muted-foreground">{o.hint}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className={cn("flex flex-col gap-1", access === "everyone" && "opacity-60")}>
              <h3 className="text-sm font-medium">People</h3>
              {access === "everyone" && (
                <p className="text-xs text-muted-foreground">Your choices are kept for if you restrict this library again.</p>
              )}
              <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                {people.map((p) => (
                  <li key={p.accountId}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg p-1.5 text-sm hover:bg-white/[0.05]">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        checked={p.isAdmin || selected.has(p.accountId)}
                        disabled={p.isAdmin}
                        onChange={() => toggle(p.accountId)}
                      />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.isAdmin && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <ShieldCheck className="size-3.5" /> Admin, always
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={loading || !!loadError || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
