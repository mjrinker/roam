"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { formatSpeed, parseSpeedInput, SPEED_MAX, SPEED_MIN, SPEED_PRESETS } from "@/lib/player/speed";
import { saveDefaultSpeed } from "@/lib/player/save-default-speed";
import { cn } from "@/lib/utils";

/** A small dialog to type a custom speed (0.25 to 3). */
export function SpeedDialog({ open, onOpenChange, current, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; current: number; onPick: (speed: number) => void }) {
  const [text, setText] = useState(String(current));
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const speed = parseSpeedInput(text);
    if (speed === null) {
      setError(`Enter a speed from ${SPEED_MIN} to ${SPEED_MAX}, like 1.35.`);
      return;
    }
    onPick(speed);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Custom speed</DialogTitle>
          <DialogDescription>
            From {SPEED_MIN}x to {SPEED_MAX}x.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input autoFocus inputMode="decimal" value={text} onChange={(e) => (setText(e.target.value), setError(null))} aria-label="Speed" placeholder="1.35" />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Set speed</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What a speed menu needs to let a profile keep a starting speed for the library: which library, and the speed saved now (null = normal). */
export interface DefaultSpeed {
  libraryId: string;
  saved: number | null;
}

// What this browser has saved this session, per library: menus close and reopen (and a player may keep playing from an older manifest), so the
// row can't rely on the value the player loaded with.
const savedHere = new Map<string, number | null>();

/** "Make this my default here" under the speed list: saves the current speed as this profile's starting speed for the library (or clears it). */
function DefaultSpeedRow({ rate, setting, dark }: { rate: number; setting: DefaultSpeed; dark?: boolean }) {
  const [saved, setSaved] = useState<number | null>(savedHere.has(setting.libraryId) ? (savedHere.get(setting.libraryId) ?? null) : setting.saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isCurrent = saved !== null && Math.abs(saved - rate) < 1e-9;
  async function save(next: number | null) {
    setBusy(true);
    setMessage(null);
    const error = await saveDefaultSpeed(setting.libraryId, next);
    setBusy(false);
    if (error) return setMessage(error);
    savedHere.set(setting.libraryId, next);
    setSaved(next);
    setMessage(next === null ? "Starts at normal speed here." : `Starts at ${formatSpeed(next)} here.`);
  }
  const button = cn("w-full rounded-lg px-3 py-1.5 text-left text-sm outline-none focus-visible:bg-white/15 disabled:opacity-50", dark ? "hover:bg-white/15" : "hover:bg-accent");
  return (
    <div className="flex flex-col" data-testid="default-speed">
      <button type="button" disabled={busy || isCurrent} onClick={() => void save(rate)} className={button}>
        {isCurrent ? `✓ ${formatSpeed(rate)} is your default here` : `Make ${formatSpeed(rate)} my default here`}
      </button>
      {saved !== null && !isCurrent && (
        <button type="button" disabled={busy} onClick={() => void save(null)} className={button}>
          Reset my default ({formatSpeed(saved)})
        </button>
      )}
      {message && <p role="status" className="px-3 pb-1 text-xs opacity-70">{message}</p>}
    </div>
  );
}

/**
 * The playback speed control: the current speed on a button, a menu of 0.25x steps up to 3x, and "Custom…" for anything in between.
 * Picking a speed only changes this player; it is not saved unless the profile chooses to make it their default for the library.
 */
export function SpeedMenu({ rate, onChange, side = "top", className, defaultSpeed }: { rate: number; onChange: (speed: number) => void; side?: "top" | "bottom"; className?: string; defaultSpeed?: DefaultSpeed }) {
  const [custom, setCustom] = useState(false);
  const isPreset = SPEED_PRESETS.some((p) => Math.abs(p - rate) < 1e-9);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Playback speed, ${formatSpeed(rate)}`}
          title="Playback speed"
          className={cn("flex h-9 min-w-11 items-center justify-center rounded-full px-2 text-sm font-medium tabular-nums outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring", className)}
        >
          {formatSpeed(rate)}
        </DropdownMenuTrigger>
        <DropdownMenuContent side={side} align="end" className="max-h-80 w-40">
          <DropdownMenuLabel>Speed</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={isPreset ? String(rate) : "custom"} onValueChange={(v) => v !== "custom" && onChange(Number(v))}>
            {!isPreset && <DropdownMenuRadioItem value="custom">{formatSpeed(rate)} (custom)</DropdownMenuRadioItem>}
            {SPEED_PRESETS.map((r) => (
              <DropdownMenuRadioItem key={r} value={String(r)}>
                {formatSpeed(r)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCustom(true)}>Custom…</DropdownMenuItem>
          {defaultSpeed && (
            <>
              <DropdownMenuSeparator />
              <DefaultSpeedRow key={defaultSpeed.libraryId} rate={rate} setting={defaultSpeed} />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {custom && <SpeedDialog open onOpenChange={setCustom} current={rate} onPick={onChange} />}
    </>
  );
}

/**
 * The speed choices drawn as a panel inside the page (the player's settings menu hosts it): a fullscreen video hides anything drawn
 * outside it, so this can't be a floating layer. A list of the 0.25x steps, a box for a custom speed, and "make this my default here".
 */
export function SpeedPanel({ rate, onChange, onDone, defaultSpeed }: { rate: number; onChange: (speed: number) => void; onDone: () => void; defaultSpeed?: DefaultSpeed }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  function pick(speed: number) {
    onChange(speed);
    onDone();
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const speed = parseSpeedInput(text);
    if (speed === null) return setBad(true);
    setText("");
    setBad(false);
    pick(speed);
  }

  return (
    <div role="menu" aria-label="Speed">
      <ul className="max-h-60 overflow-y-auto">
        {SPEED_PRESETS.map((r) => (
          <li key={r}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={Math.abs(r - rate) < 1e-9}
              onClick={() => pick(r)}
              className={cn("flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm tabular-nums outline-none hover:bg-white/15 focus-visible:bg-white/15", Math.abs(r - rate) < 1e-9 && "font-semibold text-primary")}
            >
              {formatSpeed(r)}
              {Math.abs(r - rate) < 1e-9 && <span aria-hidden>✓</span>}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="mt-1 flex items-center gap-1.5 border-t border-white/15 px-1.5 pt-2 pb-1">
        <input
          inputMode="decimal"
          value={text}
          onChange={(e) => (setText(e.target.value), setBad(false))}
          placeholder="Custom"
          aria-label="Custom speed"
          aria-invalid={bad}
          className={cn("h-8 min-w-0 flex-1 rounded-md bg-white/10 px-2 text-sm text-white outline-none placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-ring", bad && "ring-2 ring-destructive")}
        />
        <button type="submit" className="h-8 rounded-md bg-white/15 px-2.5 text-sm font-medium hover:bg-white/25">
          Set
        </button>
      </form>
      {bad && <p className="px-2.5 pb-1 text-xs text-red-300">{SPEED_MIN} to {SPEED_MAX}</p>}
      {defaultSpeed && (
        <div className="mt-1 border-t border-white/15 pt-1">
          <DefaultSpeedRow key={defaultSpeed.libraryId} rate={rate} setting={defaultSpeed} dark />
        </div>
      )}
    </div>
  );
}
