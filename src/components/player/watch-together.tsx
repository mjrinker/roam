"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Users } from "lucide-react";
import { cn } from "@/lib/utils";

/** The Watch together button of the player: start a room and share its link, see who is watching, or leave. */
export function WatchTogetherButton({ roomId, watching, ownerKind, ownerId, notice, onStart, onLeave }: { roomId: string | null; watching: string[]; ownerKind: "title" | "episode"; ownerId: string; notice: string | null; onStart: (id: string) => void; onLeave: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const link = roomId && typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}?room=${roomId}` : "";

  async function start() {
    setBusy(true);
    setProblem(null);
    const res = await fetch("/api/watch-together", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerKind, ownerId }) }).catch(() => null);
    setBusy(false);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return setProblem(typeof body?.error === "string" ? body.error : "Couldn't start it.");
    onStart(body.id);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setProblem("Couldn't copy: select the link and copy it.");
    }
  }

  return (
    <div ref={box} className="relative">
      <button type="button" aria-label="Watch together" title="Watch together" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn("flex size-10 items-center justify-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-ring", (open || roomId) && "bg-white/15", roomId && "text-primary")}>
        <Users className="size-5" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-10 mb-2 w-72 rounded-xl bg-black/90 p-3 text-sm text-white shadow-xl ring-1 ring-white/15 backdrop-blur">
          {roomId ? (
            <div className="grid gap-2">
              <p className="font-medium">Watching together</p>
              <p className="text-white/70">{watching.length > 1 ? `With ${watching.join(", ")}` : "Waiting for someone to join."}</p>
              <p className="text-xs text-white/60">Everyone&apos;s play, pause and jumps are shared. Send this link to another member of the server:</p>
              <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} className="h-8 rounded-md border border-white/20 bg-black/40 px-2 text-xs" />
              <div className="flex gap-2">
                <button type="button" onClick={() => void copy()} className="flex h-8 items-center gap-1.5 rounded-md bg-white/20 px-3 hover:bg-white/30">
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy link"}
                </button>
                <button type="button" onClick={() => (setOpen(false), onLeave())} className="h-8 rounded-md px-3 text-white/80 hover:bg-white/15">
                  Leave
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <p className="font-medium">Watch together</p>
              <p className="text-xs text-white/60">Start a room, send the link to another member, and your players stay in step: one presses pause and everyone pauses.</p>
              <button type="button" disabled={busy} onClick={() => void start()} className="h-8 rounded-md bg-white/20 px-3 hover:bg-white/30 disabled:opacity-60">
                {busy ? "Starting…" : "Start a room"}
              </button>
            </div>
          )}
          {(problem || notice) && (
            <p role="alert" className="mt-2 text-xs text-red-300">
              {problem ?? notice}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
