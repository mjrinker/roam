"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MAX_BODY, MAX_TITLE } from "@/lib/feedback/rules";
import type { FeedbackView } from "@/lib/feedback/service";
import { call } from "@/components/feedback/feedback-bits";
import { cn } from "@/lib/utils";

/** Sent with a report when the person agrees: the page, the browser and the screen. Never who they are or which server they are on. */
function technicalDetails() {
  return {
    path: location.pathname,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true,
    locale: navigator.language,
    online: navigator.onLine,
  };
}

/** Send a bug report or a feature request. A feature request is shared on the board (unless kept private); a bug goes to the people who run Roam. */
export function FeedbackDialog({ serverId, open, onOpenChange }: { serverId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [kind, setKind] = useState<"bug" | "feature">("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [withDetails, setWithDetails] = useState(true);
  const [keepPrivate, setKeepPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; visibility: "private" | "public" } | null>(null);
  const [github, setGithub] = useState<{ enabled: boolean; public: boolean } | null>(null);
  const [similar, setSimilar] = useState<FeedbackView[]>([]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetch("/api/feedback/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => live && c && setGithub(c.github))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);

  // Has this been asked already? Looked up as the title is typed.
  useEffect(() => {
    if (!open || title.trim().length < 4) {
      const clear = setTimeout(() => setSimilar([]), 0);
      return () => clearTimeout(clear);
    }
    let live = true;
    const timer = setTimeout(() => {
      void fetch(`/api/feedback/similar?kind=${kind}&q=${encodeURIComponent(title)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => live && r && setSimilar(r.items));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, title, kind]);

  function reset() {
    setTitle("");
    setBody("");
    setProblem(null);
    setSent(null);
    setSimilar([]);
  }

  async function send() {
    setBusy(true);
    setProblem(null);
    const r = await call("POST", "/api/feedback", { kind, title, body, keepPrivate: kind === "feature" && keepPrivate, serverId, diagnostics: withDetails ? technicalDetails() : undefined });
    setBusy(false);
    if (!r.ok) return setProblem(typeof r.data.error === "string" ? r.data.error : "That didn't send.");
    setSent(r.data as { id: string; visibility: "private" | "public" });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        {sent ? (
          <>
            <DialogHeader>
              <DialogTitle>Thank you</DialogTitle>
              <DialogDescription>
                {sent.visibility === "public" ? "Your idea is on the board, where others can vote for it." : "Your report went to the people who run Roam. You can see it and any reply under Your reports."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              <Button render={<Link href={`/s/${serverId}/feedback/${sent.id}`} onClick={() => onOpenChange(false)} />}>View it</Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>Send feedback</DialogTitle>
              <DialogDescription>Tell us something is broken, or what you would like Roam to do.</DialogDescription>
            </DialogHeader>
            <div role="radiogroup" aria-label="What is it?" className="grid grid-cols-2 gap-2">
              {(["bug", "feature"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={cn("rounded-xl px-3 py-2 text-sm font-medium ring-1 transition", kind === k ? "bg-primary/20 text-primary ring-primary/40" : "bg-white/[0.04] text-muted-foreground ring-white/10 hover:text-foreground")}>
                  {k === "bug" ? "Something is wrong" : "An idea"}
                </button>
              ))}
            </div>
            <label className="grid gap-1.5 text-sm">
              Title
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_TITLE} placeholder={kind === "bug" ? "The video stops at the next part" : "A sleep timer for audiobooks"} required />
            </label>
            {kind === "feature" && similar.length > 0 && (
              <div className="rounded-xl bg-white/[0.04] p-3 text-sm ring-1 ring-white/10">
                <p className="font-medium">Already asked? A vote helps more than a new request:</p>
                <ul className="mt-1.5 space-y-1">
                  {similar.map((s) => (
                    <li key={s.id}>
                      <Link href={`/s/${serverId}/feedback/${s.id}`} onClick={() => onOpenChange(false)} className="text-primary hover:underline">
                        {s.title}
                      </Link>{" "}
                      <span className="text-xs text-muted-foreground">{s.votes} {s.votes === 1 ? "vote" : "votes"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <label className="grid gap-1.5 text-sm">
              {kind === "bug" ? "What happened, and what did you expect?" : "What would you like, and why?"}
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={MAX_BODY}
                rows={6}
                required
                className="rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={kind === "bug" ? "I pressed play on the second movie and it stopped after about ten seconds…" : "When I fall asleep listening, it keeps playing all night…"}
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={withDetails} onChange={(e) => setWithDetails(e.target.checked)} className="mt-1" />
              <span>
                Include technical details
                <span className="block text-xs text-muted-foreground">The page you are on, your browser and screen size. Never your account, your server or what you watch.</span>
              </span>
            </label>
            {kind === "feature" && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={keepPrivate} onChange={(e) => setKeepPrivate(e.target.checked)} className="mt-1" />
                <span>
                  Keep it private
                  <span className="block text-xs text-muted-foreground">Otherwise it goes on the board, where everyone can read, vote and comment (without your name).</span>
                </span>
              </label>
            )}
            {github?.enabled && (
              <p className="text-xs text-muted-foreground">
                What you write is also filed as an issue on the project&apos;s GitHub{github.public ? ", which is public: don't put anything private in it" : " (a private repository)"}. Your name and account are not sent.
              </p>
            )}
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />} Send
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
