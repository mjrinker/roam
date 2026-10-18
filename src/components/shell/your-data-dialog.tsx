"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ImportAnswer {
  source: string;
  watched: number;
  ratings: number;
  labels: number;
  watchlist: number;
  notFound: { total: number; sample: string[] };
}

/** Take this profile's watch history, ratings, labels and watch list away as a file, or bring a file in (from Roam, Letterboxd, or a plain CSV). */
export function YourDataDialog({ serverId, open, onOpenChange }: { serverId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ImportAnswer | null>(null);
  const [trakt, setTrakt] = useState<{ configured: boolean; linked: boolean; username: string | null } | null>(null);
  const [code, setCode] = useState<{ deviceCode: string; userCode: string; verificationUrl: string; interval: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadTrakt = useCallback(() => {
    void fetch("/api/trakt")
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => setTrakt(t))
      .catch(() => setTrakt(null));
  }, []);
  useEffect(() => {
    if (open) loadTrakt();
    return () => clearTimeout(timer.current);
  }, [open, loadTrakt]);

  async function connectTrakt() {
    setProblem(null);
    const res = await fetch("/api/trakt/connect", { method: "POST" }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return setProblem(typeof body?.error === "string" ? body.error : "Couldn't start connecting to Trakt.");
    setCode(body);
    const poll = async (wait: number) => {
      timer.current = setTimeout(async () => {
        const r = await fetch("/api/trakt/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceCode: body.deviceCode }) }).catch(() => null);
        const b = await r?.json().catch(() => ({}));
        if (b?.status === "pending") return void poll(wait);
        setCode(null);
        if (b?.status === "linked") loadTrakt();
        else setProblem(typeof b?.error === "string" ? b.error : "The code ran out. Try connecting again.");
      }, wait * 1000);
    };
    void poll(Math.max(3, body.interval ?? 5));
  }

  async function importTrakt() {
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    const res = await fetch(`/api/trakt/import?serverId=${serverId}`, { method: "POST" }).catch(() => null);
    setBusy(false);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return setProblem(typeof body?.error === "string" ? body.error : "That didn't work.");
    setAnswer(body as ImportAnswer);
  }

  async function disconnectTrakt() {
    await fetch("/api/trakt", { method: "DELETE" }).catch(() => null);
    loadTrakt();
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    const res = await fetch(`/api/import?serverId=${serverId}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: await file.text() }).catch(() => null);
    setBusy(false);
    if (!res) return setProblem("Couldn't reach the server.");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setProblem(typeof body.error === "string" ? body.error : "That didn't work.");
    setAnswer(body as ImportAnswer);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your data</DialogTitle>
          <DialogDescription>For this profile on this server: what you have watched, your ratings, labels and watch list.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm">
          <div className="grid gap-1.5">
            <Button render={<a href={`/api/export?serverId=${serverId}`} download />} variant="secondary" className="justify-start gap-2">
              <Download className="size-4" /> Export to a file
            </Button>
            <p className="text-xs text-muted-foreground">Keep it as a backup, or load it into another profile or server.</p>
          </div>
          <div className="grid gap-1.5">
            <label className="flex cursor-pointer items-center gap-2 rounded-md bg-secondary px-3 py-2 text-secondary-foreground hover:bg-secondary/80">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Import from a file
              <input type="file" accept=".json,.csv,text/csv,application/json" className="sr-only" aria-label="File to import" disabled={busy} onChange={(e) => void choose(e.target.files?.[0])} />
            </label>
            <p className="text-xs text-muted-foreground">A Roam export, or Letterboxd&apos;s <em>watched.csv</em> or <em>ratings.csv</em>, or a CSV with the columns type, title, year, season, episode, rating and watched. It adds to what is there and never removes anything.</p>
          </div>
          {trakt?.configured && (
            <div className="grid gap-1.5 border-t border-white/10 pt-3">
              <p className="font-medium">Trakt</p>
              {trakt.linked ? (
                <>
                  <p className="text-xs text-muted-foreground">Connected{trakt.username ? ` as ${trakt.username}` : ""}. What you finish and rate here is sent to Trakt.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void importTrakt()}>
                      Import from Trakt
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void disconnectTrakt()}>
                      Disconnect
                    </Button>
                  </div>
                </>
              ) : code ? (
                <p className="text-xs text-muted-foreground" role="status">
                  Go to <a className="underline" href={code.verificationUrl} target="_blank" rel="noreferrer">{code.verificationUrl}</a> and enter <strong className="text-foreground tracking-widest">{code.userCode}</strong>. This page connects by itself once you approve.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">Send what you finish and rate to Trakt, and bring your Trakt history here.</p>
                  <Button variant="secondary" size="sm" className="w-fit" onClick={() => void connectTrakt()}>
                    Connect Trakt
                  </Button>
                </>
              )}
            </div>
          )}
          {problem && (
            <p role="alert" className="text-destructive">
              {problem}
            </p>
          )}
          {answer && (
            <div role="status" className="rounded-lg bg-white/[0.04] p-3">
              <p className="font-medium">Brought in from {answer.source}</p>
              <p className="text-muted-foreground">
                {answer.watched} watched · {answer.ratings} ratings · {answer.labels} labels · {answer.watchlist} on the watch list
              </p>
              {answer.notFound.total > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {answer.notFound.total} not on this server: {answer.notFound.sample.slice(0, 8).join(", ")}
                  {answer.notFound.total > 8 ? "…" : ""}
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
