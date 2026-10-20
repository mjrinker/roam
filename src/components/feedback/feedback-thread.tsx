"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { call, KindBadge, StatusBadge, VoteButton } from "@/components/feedback/feedback-bits";
import { FEEDBACK_STATUSES, MAX_COMMENT, STATUS_LABEL, type FeedbackStatus } from "@/lib/feedback/rules";
import type { CommentView, FeedbackView } from "@/lib/feedback/service";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** One item: what was said, who wants it, the conversation, and (for the platform admin) the controls and the details. */
export function FeedbackThread({ backHref, backLabel, item: initial, comments: initialComments, canWrite, operator }: { backHref: string; backLabel: string; item: FeedbackView; comments: CommentView[]; canWrite: boolean; operator: boolean }) {
  const router = useRouter();
  const [item, setItem] = useState(initial);
  const [comments, setComments] = useState(initialComments);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const op = item.operator;

  async function vote() {
    setBusy("vote");
    const r = await call(item.iVoted ? "DELETE" : "PUT", `/api/feedback/${item.id}/vote`);
    setBusy(null);
    if (!r.ok) return toast.error(typeof r.data.error === "string" ? r.data.error : "Couldn't vote.");
    setItem({ ...item, votes: r.data.votes as number, iVoted: !item.iVoted });
  }
  async function post() {
    setBusy("comment");
    const r = await call("POST", `/api/feedback/${item.id}/comments`, { body: text });
    setBusy(null);
    if (!r.ok) return toast.error(typeof r.data.error === "string" ? r.data.error : "That didn't send.");
    setComments([...comments, r.data as CommentView]);
    setText("");
  }
  async function change(patch: Record<string, unknown>, label: string) {
    setBusy(label);
    const r = await call("PATCH", `/api/feedback/${item.id}`, patch);
    setBusy(null);
    if (!r.ok) return toast.error(typeof r.data.error === "string" ? r.data.error : "That didn't work.");
    setItem({ ...item, ...(patch.status ? { status: r.data.status as FeedbackStatus } : {}), ...(patch.visibility ? { visibility: patch.visibility as FeedbackView["visibility"] } : {}) });
    router.refresh();
  }
  async function remove() {
    if (!window.confirm("Delete this report, with its votes and comments?")) return;
    const r = await call("DELETE", `/api/feedback/${item.id}`);
    if (!r.ok) return toast.error("Couldn't delete it.");
    router.push(backHref);
  }
  async function removeComment(id: string) {
    const r = await call("DELETE", `/api/feedback/${item.id}/comments/${id}`);
    if (r.ok) setComments((all) => all.filter((c) => c.id !== id));
  }
  async function resync() {
    setBusy("github");
    const r = await call("POST", `/api/feedback/${item.id}/github`);
    setBusy(null);
    if (!r.ok) return toast.error(typeof r.data.error === "string" ? r.data.error : "GitHub didn't answer.");
    toast.success("GitHub is up to date.");
    router.refresh();
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <Link href={backHref} className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {backLabel}
      </Link>
      <div className="flex items-start gap-3">
        {item.visibility === "public" && <VoteButton votes={item.votes} voted={item.iVoted} busy={busy === "vote"} disabled={!canWrite} onClick={() => void vote()} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <KindBadge kind={item.kind} />
            <StatusBadge status={item.status} />
            {item.visibility === "private" && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-muted-foreground">Private</span>}
          </div>
          <h1 className="mt-1.5 text-xl font-semibold break-words sm:text-2xl">{item.title}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {when(item.createdAt)}
            {item.mine ? " · you sent this" : ""}
            {item.duplicateOf ? " · a duplicate of another report" : ""}
          </p>
        </div>
      </div>
      <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{item.body}</p>

      {operator && op && (
        <section aria-label="Platform admin" className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/10">
          <h2 className="text-sm font-semibold">For the platform admin</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              Status
              <select value={item.status} onChange={(e) => void change({ status: e.target.value }, "status")} disabled={busy === "status"} className="h-8 rounded-md border border-input bg-transparent px-2 text-sm">
                {FEEDBACK_STATUSES.map((s) => (
                  <option key={s} value={s} className="bg-popover">
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="secondary" disabled={busy === "visibility"} onClick={() => void change({ visibility: item.visibility === "public" ? "private" : "public" }, "visibility")}>
              {item.visibility === "public" ? "Make private" : "Publish on the board"}
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void remove()}>
              Delete
            </Button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <dt>From</dt>
            <dd className="break-all">{op.authorEmail ?? "an account that is gone"}</dd>
            {op.serverId && (
              <>
                <dt>Server</dt>
                <dd className="break-all">{op.serverId}</dd>
              </>
            )}
            {op.diagnostics &&
              Object.entries(op.diagnostics).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd className="break-all">{String(v)}</dd>
                </div>
              ))}
            <dt>GitHub</dt>
            <dd>
              {op.githubIssueUrl ? (
                <a href={op.githubIssueUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  Issue #{op.githubIssueNumber}
                </a>
              ) : (
                "no issue"
              )}
              {op.githubError && <span className="ml-2 text-destructive">{op.githubError}</span>}{" "}
              <button type="button" onClick={() => void resync()} disabled={busy === "github"} className="ml-2 underline hover:text-foreground">
                {busy === "github" ? "…" : op.githubIssueUrl ? "Sync" : "File now"}
              </button>
            </dd>
          </dl>
        </section>
      )}

      <section aria-label="Comments" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{comments.length === 0 ? "No comments yet" : `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}</h2>
        <ul className="flex flex-col gap-2">
          {comments.map((c) => (
            <li key={c.id} className={c.official ? "rounded-xl bg-primary/10 p-3 ring-1 ring-primary/30" : "rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10"}>
              <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className={c.official ? "font-medium text-primary" : ""}>{c.official ? "Roam team" : c.mine ? "You" : "Someone"}</span> · {when(c.createdAt)}
                {operator && (
                  <button type="button" onClick={() => void removeComment(c.id)} className="ml-auto hover:text-destructive">
                    Remove
                  </button>
                )}
              </p>
              <p className="text-sm whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ul>
        {canWrite && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void post();
            }}
            className="flex flex-col gap-2"
          >
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_COMMENT} rows={3} placeholder={operator ? "Reply as Roam team" : "Add a comment"} aria-label="Comment" className="rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            <Button type="submit" size="sm" className="w-fit" disabled={busy === "comment" || text.trim() === ""}>
              {busy === "comment" && <Loader2 className="size-4 animate-spin" />} {operator ? "Reply" : "Comment"}
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
