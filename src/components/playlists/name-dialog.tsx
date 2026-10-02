"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** A one-field dialog: "Name your playlist" / "Rename playlist". `onSubmit` returns an error string to show, or null on success. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  initialName = "",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  initialName?: string;
  onSubmit: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const failure = await onSubmit(trimmed);
    setBusy(false);
    if (failure) setError(failure);
    else onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            autoFocus
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder="Playlist name"
            aria-label="Playlist name"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
