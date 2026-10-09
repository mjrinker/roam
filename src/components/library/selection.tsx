"use client";

import { useCallback, useState } from "react";
import { Check, ListChecks, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BulkDownloadButton, BulkPlaylistMenu } from "@/components/library/bulk-actions";

/** What is chosen on a library page, plus Shift-click ranges. `order` is the items as shown, so a range follows what the viewer sees. */
export function useSelection() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  const toggle = useCallback(
    (order: readonly { id: string }[], index: number, shift: boolean) => {
      setSelected((cur) => {
        const next = new Set(cur);
        const range = shift && anchor !== null ? order.slice(Math.min(anchor, index), Math.max(anchor, index) + 1) : [order[index]];
        const turnOn = !cur.has(order[index].id);
        for (const t of range) {
          if (turnOn) next.add(t.id);
          else next.delete(t.id);
        }
        return next;
      });
      setAnchor(index);
    },
    [anchor]
  );
  const selectMany = useCallback((ids: readonly string[]) => setSelected((cur) => new Set([...cur, ...ids])), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const stop = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    setAnchor(null);
  }, []);
  return { selecting, setSelecting, selected, toggle, selectMany, clear, stop };
}

/** The "Select" toggle for a page's toolbar. */
export function SelectToggle({ selecting, onClick }: { selecting: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selecting}
      onClick={onClick}
      className={cn("flex h-10 items-center gap-2 rounded-xl px-3 text-sm ring-1 transition", selecting ? "bg-primary/15 text-primary ring-primary/40" : "bg-white/[0.06] ring-white/[0.08] hover:bg-white/[0.09]")}
    >
      <ListChecks className="size-4" />
      Select
    </button>
  );
}

/** The checkbox laid over a card while selecting: a click chooses it instead of opening it. */
export function SelectOverlay({ name, checked, onToggle, round }: { name: string; checked: boolean; onToggle: (shift: boolean) => void; round?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Select ${name}`}
      onClick={(e) => onToggle(e.shiftKey)}
      className={cn("absolute inset-0 z-10 cursor-pointer outline-none transition focus-visible:ring-2 focus-visible:ring-primary", round ? "rounded-2xl" : "rounded-xl", checked ? "bg-primary/10 ring-2 ring-primary" : "hover:bg-white/5")}
    >
      <span className={cn("absolute top-2 left-2 flex size-6 items-center justify-center rounded-full ring-2 ring-white/70", checked ? "bg-primary text-primary-foreground ring-primary" : "bg-black/50")}>
        {checked && <Check className="size-3.5" strokeWidth={3} />}
      </span>
    </button>
  );
}

/**
 * The bar shown while selecting: how many are chosen, Select all (the label says how many that is), Clear, the actions, and Done.
 * `resolve` gives the title ids the actions work on (for music it turns albums and artists into their songs).
 */
export function SelectionBar({
  serverId,
  count,
  selectAllLabel,
  allSelected,
  selectingAll,
  onSelectAll,
  onClear,
  onDone,
  resolve,
  canPlaylist = true,
  canDownload = true,
}: {
  serverId: string;
  count: number;
  selectAllLabel: string;
  allSelected: boolean;
  selectingAll?: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
  resolve: () => Promise<string[]>;
  canPlaylist?: boolean;
  canDownload?: boolean;
}) {
  const none = count === 0;
  return (
    <div role="toolbar" aria-label="Selected" className="sticky top-16 z-20 -mt-2 flex flex-wrap items-center gap-2 rounded-2xl bg-popover/95 p-3 ring-1 ring-white/10 backdrop-blur">
      <span className="mr-auto text-sm font-medium tabular-nums">{none ? "Choose some" : `${count.toLocaleString()} selected`}</span>
      <button type="button" disabled={allSelected || selectingAll} onClick={onSelectAll} className="flex h-10 items-center gap-2 rounded-xl px-3 text-sm text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:opacity-40">
        {selectingAll && <Loader2 className="size-4 animate-spin" />}
        {selectAllLabel}
      </button>
      <button type="button" disabled={none} onClick={onClear} className="h-10 rounded-xl px-3 text-sm text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:opacity-40">
        Clear
      </button>
      {canPlaylist && <BulkPlaylistMenu serverId={serverId} resolve={resolve} count={count} disabled={none} />}
      {canDownload && <BulkDownloadButton serverId={serverId} resolve={resolve} count={count} disabled={none} />}
      <button type="button" onClick={onDone} className="h-10 rounded-xl px-3 text-sm font-medium text-primary transition hover:bg-primary/10">
        Done
      </button>
    </div>
  );
}
