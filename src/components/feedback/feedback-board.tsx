"use client";

import Link from "next/link";
import { useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FeedbackDialog } from "@/components/feedback/feedback-dialog";
import { call, KindBadge, StatusBadge, VoteButton } from "@/components/feedback/feedback-bits";
import { cn } from "@/lib/utils";
import type { FeedbackView } from "@/lib/feedback/service";

export type BoardTab = "ideas" | "bugs" | "mine";

const TABS: { id: BoardTab; label: string }[] = [
  { id: "ideas", label: "Ideas" },
  { id: "bugs", label: "Known bugs" },
  { id: "mine", label: "Your reports" },
];

/** The board: public ideas (and bugs the team made public) to vote on, and your own reports with their status and replies. */
export function FeedbackBoard({ serverId, tab, items: initial, canWrite, q }: { serverId: string; tab: BoardTab; items: FeedbackView[]; canWrite: boolean; q: string }) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const base = `/s/${serverId}/feedback`;

  async function toggle(item: FeedbackView) {
    setBusy(item.id);
    const r = await call(item.iVoted ? "DELETE" : "PUT", `/api/feedback/${item.id}/vote`);
    setBusy(null);
    if (!r.ok) return toast.error(typeof r.data.error === "string" ? r.data.error : "Couldn't vote.");
    setItems((all) => all.map((i) => (i.id === item.id ? { ...i, votes: r.data.votes as number, iVoted: !i.iVoted } : i)));
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Feedback</h1>
          <p className="text-sm text-muted-foreground">Vote for what you would like next, or tell us about a problem.</p>
        </div>
        {canWrite && (
          <Button onClick={() => setSending(true)} className="gap-2">
            <Plus className="size-4" /> Send feedback
          </Button>
        )}
      </header>
      <nav aria-label="Feedback views" className="flex w-fit gap-1 rounded-xl bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
        {TABS.map((t) => (
          <Link key={t.id} href={t.id === "ideas" ? base : `${base}?tab=${t.id}`} aria-current={tab === t.id ? "page" : undefined} className={cn("rounded-lg px-4 py-1.5 text-sm font-medium transition", tab === t.id ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab !== "mine" && (
        <form action={base} method="get" role="search" className="max-w-sm">
          {tab === "bugs" && <input type="hidden" name="tab" value="bugs" />}
          <input type="search" name="q" defaultValue={q} placeholder="Search" aria-label="Search feedback" className="h-9 w-full rounded-xl bg-white/[0.06] px-3 text-sm ring-1 ring-white/[0.08] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
        </form>
      )}
      {items.length === 0 ? (
        <p className="rounded-xl bg-white/[0.04] px-4 py-8 text-center text-sm text-muted-foreground ring-1 ring-white/10">
          {tab === "mine" ? "You haven't sent anything yet." : tab === "bugs" ? "No known bugs are listed." : q ? "Nothing matches that." : "No ideas yet. Be the first."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 rounded-2xl bg-card/70 p-3 ring-1 ring-white/[0.08]">
              {item.visibility === "public" ? <VoteButton votes={item.votes} voted={item.iVoted} busy={busy === item.id} disabled={!canWrite} onClick={() => void toggle(item)} /> : <span className="w-12 shrink-0 self-stretch rounded-xl bg-white/[0.03] text-center text-[10px] leading-[3rem] text-muted-foreground">private</span>}
              <Link href={`${base}/${item.id}`} className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <KindBadge kind={item.kind} />
                  <StatusBadge status={item.status} />
                  <span className="font-medium break-words">{item.title}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.body}</p>
                <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <MessageSquare className="size-3" /> {item.comments}
                  {item.mine && <span className="ml-2">· yours</span>}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <FeedbackDialog serverId={serverId} open={sending} onOpenChange={setSending} />
    </div>
  );
}
