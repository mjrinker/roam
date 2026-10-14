"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CATEGORY_LABELS, SEVERITY_LABELS, type ContentFilterPrefs, type FilterCategory, type FilterSeverity } from "@/lib/content-filter/categories";
import { DddCredit } from "@/components/library/ddd-credit";
import { mergeGuideLines } from "@/lib/ddd/transform";
import type { GuideLine } from "@/lib/content-filter/playback";
import { choosableLines, extraFromPicks, stricterThan, withSkipParam } from "@/lib/content-filter/preplay";
import { encodeSkipParam } from "@/lib/content-filter/timeline";
import { cn } from "@/lib/utils";

const OPTION_LABEL: Record<FilterSeverity, string> = { high: "Skip strong", medium: "Skip moderate and up", low: "Skip all, even mild" };

/** What the dialog asks, and where playing goes. The choices apply to that play only and are never saved. */
function ChoicesDialog({ open, onOpenChange, href, lines, prefs }: { open: boolean; onOpenChange: (open: boolean) => void; href: string; lines: GuideLine[]; prefs: ContentFilterPrefs }) {
  const router = useRouter();
  const [picks, setPicks] = useState<Partial<Record<FilterCategory, FilterSeverity>>>({});
  function play() {
    onOpenChange(false);
    router.push(withSkipParam(href, encodeSkipParam(extraFromPicks(picks, prefs))));
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Before you watch</DialogTitle>
          <DialogDescription>
            Choose scenes to skip for this viewing only. What your profile already skips is skipped as well, and nothing here is remembered.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2.5">
          {lines.map((l) => {
            const profile = prefs[l.category];
            const options = stricterThan(profile);
            return (
              <div key={l.category} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <label htmlFor={`play-${l.category}`} className="min-w-0 sm:flex-1">
                  <span className="block truncate text-sm font-medium">{CATEGORY_LABELS[l.category]}</span>
                  <span className="block text-xs text-muted-foreground">
                    {l.source === "community" ? "Community reports" : SEVERITY_LABELS[l.severity]} · {l.scenes} scene{l.scenes === 1 ? "" : "s"}
                  </span>
                </label>
                <select
                  id={`play-${l.category}`}
                  value={picks[l.category] ?? "off"}
                  onChange={(e) => setPicks((p) => ({ ...p, [l.category]: e.target.value === "off" ? undefined : (e.target.value as FilterSeverity) }))}
                  className={cn("h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm sm:h-8 sm:w-56 sm:shrink-0")}
                >
                  <option value="off" className="bg-popover">
                    {profile ? `Your profile: ${OPTION_LABEL[profile].toLowerCase()}` : "Don't skip"}
                  </option>
                  {options.map((s) => (
                    <option key={s} value={s} className="bg-popover">
                      {OPTION_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        {lines.some((l) => l.source === "community") && <DddCredit className="text-xs text-muted-foreground" />}
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={play}>
            Play
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared by the two kinds of button: whether to ask first, and the dialog to ask with. With `dddUrl` (limited access, nothing kept yet),
 * the first press asks the server for the community's scenes for this title, then opens the choices if there are any (else just plays).
 */
function usePlayChoices(href: string, lines: GuideLine[], prefs: ContentFilterPrefs, dddUrl?: string) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fetched, setFetched] = useState<GuideLine[] | null>(null);
  const all = fetched ? mergeGuideLines(lines, fetched) : lines;
  const choosable = choosableLines(all, prefs);
  const wantsLookup = !!dddUrl && fetched === null;
  return {
    asks: choosable.length > 0 || wantsLookup,
    busy,
    activate: async () => {
      if (!wantsLookup) return setOpen(true);
      setBusy(true);
      let found: GuideLine[] = [];
      try {
        const res = await fetch(dddUrl!, { signal: AbortSignal.timeout(5000) });
        if (res.ok) found = ((await res.json()) as { lines?: GuideLine[] }).lines ?? [];
      } catch {
        // No answer in time: carry on without it.
      }
      setBusy(false);
      setFetched(found);
      if (choosableLines(mergeGuideLines(lines, found), prefs).length > 0) setOpen(true);
      else router.push(href);
    },
    dialog: choosable.length > 0 ? <ChoicesDialog open={open} onOpenChange={setOpen} href={href} lines={choosable} prefs={prefs} /> : null,
  };
}

/**
 * A big play button that, when the movie or episode has scenes this profile could still choose to skip, first asks what to skip for this
 * viewing. Without any, it is just a link to the player.
 */
export function PlayChoicesButton({ href, lines, prefs, dddUrl, className, children }: { href: string; lines: GuideLine[]; prefs: ContentFilterPrefs; dddUrl?: string; className?: string; children: React.ReactNode }) {
  const choices = usePlayChoices(href, lines, prefs, dddUrl);
  return (
    <>
      <Button
        render={<Link href={href} />}
        className={className}
        aria-busy={choices.busy || undefined}
        onClick={(e) => {
          if (!choices.asks) return;
          e.preventDefault();
          if (!choices.busy) void choices.activate();
        }}
      >
        {children}
      </Button>
      {choices.dialog}
    </>
  );
}

/** The same for a plain link (an episode's row). */
export function PlayChoicesLink({ href, lines, prefs, dddUrl, className, children }: { href: string; lines: GuideLine[]; prefs: ContentFilterPrefs; dddUrl?: string; className?: string; children: React.ReactNode }) {
  const choices = usePlayChoices(href, lines, prefs, dddUrl);
  return (
    <>
      <Link
        href={href}
        className={className}
        aria-busy={choices.busy || undefined}
        onClick={(e) => {
          if (!choices.asks) return;
          e.preventDefault();
          if (!choices.busy) void choices.activate();
        }}
      >
        {children}
      </Link>
      {choices.dialog}
    </>
  );
}
