import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { db } from "@/lib/db/client";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { KindBadge, StatusBadge } from "@/components/feedback/feedback-bits";
import { FEEDBACK_KINDS, FEEDBACK_STATUSES, STATUS_LABEL } from "@/lib/feedback/rules";
import { listInbox } from "@/lib/feedback/service";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Feedback inbox", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Every bug report and feature request, newest first, for the platform admin to triage. */
export default async function FeedbackInboxPage({ searchParams }: PageProps<"/platform/feedback">) {
  const account = await requirePlatformAdmin();
  const query = await searchParams;
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);
  const kind = pick(query.kind, FEEDBACK_KINDS);
  const status = pick(query.status, [...FEEDBACK_STATUSES, "open"] as const);
  const visibility = pick(query.visibility, ["public", "private"] as const);
  const q = typeof query.q === "string" ? query.q.slice(0, 60) : "";
  const items = await listInbox(db, { accountId: account.id, operator: true }, { kind, status, visibility, q });
  const href = (over: Record<string, string | null>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ kind, status, visibility, q: q || null, ...over })) if (v) params.set(k, v);
    const s = params.toString();
    return `/platform/feedback${s ? `?${s}` : ""}`;
  };
  const chip = (label: string, active: boolean, to: string) => (
    <Link key={label} href={to} className={cn("rounded-full px-3 py-1 text-xs font-medium ring-1 transition", active ? "bg-primary/20 text-primary ring-primary/40" : "bg-white/[0.04] text-muted-foreground ring-white/10 hover:text-foreground")}>
      {label}
    </Link>
  );
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-8">
      <header className="flex flex-col gap-2">
        <Link href="/platform" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Platform admin
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Feedback inbox</h1>
        <p className="text-sm text-muted-foreground">Bugs and ideas from everyone on this deployment. Bugs are private until you publish them; ideas are public unless their author kept them private.</p>
      </header>
      <div className="flex flex-wrap gap-2">
        {chip("All kinds", !kind, href({ kind: null }))}
        {chip("Bugs", kind === "bug", href({ kind: "bug" }))}
        {chip("Ideas", kind === "feature", href({ kind: "feature" }))}
        <span className="mx-1 w-px bg-white/10" />
        {chip("Any status", !status, href({ status: null }))}
        {chip("Open", status === "open", href({ status: "open" }))}
        {FEEDBACK_STATUSES.map((s) => chip(STATUS_LABEL[s], status === s, href({ status: s })))}
        <span className="mx-1 w-px bg-white/10" />
        {chip("Public", visibility === "public", href({ visibility: visibility === "public" ? null : "public" }))}
        {chip("Private", visibility === "private", href({ visibility: visibility === "private" ? null : "private" }))}
      </div>
      <form action="/platform/feedback" method="get" role="search" className="max-w-sm">
        {kind && <input type="hidden" name="kind" value={kind} />}
        {status && <input type="hidden" name="status" value={status} />}
        {visibility && <input type="hidden" name="visibility" value={visibility} />}
        <input type="search" name="q" defaultValue={q} placeholder="Search" aria-label="Search feedback" className="h-9 w-full rounded-xl bg-white/[0.06] px-3 text-sm ring-1 ring-white/[0.08] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
      </form>
      {items.length === 0 ? (
        <p className="rounded-xl bg-white/[0.04] px-4 py-8 text-center text-sm text-muted-foreground ring-1 ring-white/10">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((i) => (
            <li key={i.id}>
              <Link href={`/platform/feedback/${i.id}`} className="block rounded-2xl bg-card/70 p-3 ring-1 ring-white/[0.08] transition hover:bg-card hover:ring-primary/40">
                <div className="flex flex-wrap items-center gap-2">
                  <KindBadge kind={i.kind} />
                  <StatusBadge status={i.status} />
                  {i.visibility === "private" && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-muted-foreground">Private</span>}
                  <span className="font-medium break-words">{i.title}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{i.body}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                  <span>{new Date(i.createdAt).toLocaleDateString()}</span>
                  <span>{i.votes} {i.votes === 1 ? "vote" : "votes"}</span>
                  <span className="flex items-center gap-1">
                    <MessageSquare className="size-3" /> {i.comments}
                  </span>
                  {i.operator?.githubIssueNumber ? <span>GitHub #{i.operator.githubIssueNumber}</span> : null}
                  {i.operator?.githubError ? <span className="text-destructive">GitHub error</span> : null}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
