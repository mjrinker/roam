"use client";

import { ChevronUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, type FeedbackStatus } from "@/lib/feedback/rules";

export async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

const STATUS_STYLE: Record<FeedbackStatus, string> = {
  new: "bg-white/10 text-muted-foreground",
  planned: "bg-sky-500/15 text-sky-300",
  in_progress: "bg-amber-500/15 text-amber-300",
  done: "bg-emerald-500/15 text-emerald-300",
  declined: "bg-white/10 text-muted-foreground line-through",
  duplicate: "bg-white/10 text-muted-foreground",
};

export function StatusBadge({ status }: { status: FeedbackStatus }) {
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[status])}>{STATUS_LABEL[status]}</span>;
}

export function KindBadge({ kind }: { kind: "bug" | "feature" }) {
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", kind === "bug" ? "bg-red-500/15 text-red-300" : "bg-primary/15 text-primary")}>{kind === "bug" ? "Bug" : "Idea"}</span>;
}

/** The vote button: the count, and whether it is yours. */
export function VoteButton({ votes, voted, busy, disabled, onClick }: { votes: number; voted: boolean; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-pressed={voted}
      aria-label={voted ? `Remove your vote (${votes})` : `Vote (${votes})`}
      className={cn("flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-sm font-semibold ring-1 transition disabled:opacity-60", voted ? "bg-primary/20 text-primary ring-primary/40" : "bg-white/[0.05] text-foreground ring-white/10 hover:bg-white/10")}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ChevronUp className="size-4" />}
      {votes}
    </button>
  );
}
