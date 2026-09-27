"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Asks for a profile's 4-digit PIN. `onSubmit` returns an error message, or null on success. */
export function PinDialog({
  profileName,
  open,
  onOpenChange,
  onSubmit,
}: {
  profileName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (pin: string) => Promise<string | null>;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const message = await onSubmit(pin);
    setBusy(false);
    if (message) {
      setError(message);
      setPin("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Enter PIN</DialogTitle>
            <DialogDescription>{profileName}&apos;s profile is protected.</DialogDescription>
          </DialogHeader>
          <Input
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
              setError(null);
            }}
            inputMode="numeric"
            autoComplete="off"
            type="password"
            maxLength={4}
            aria-label="PIN"
            aria-invalid={!!error}
            className="text-center text-2xl tracking-[0.5em]"
            autoFocus
          />
          {error && <p className="text-center text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || pin.length !== 4}>
            Continue
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
