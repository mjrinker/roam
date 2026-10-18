"use client";

import { useEffect, useRef, useState } from "react";
import { decide, type LocalState, type SharedState } from "@/lib/watch-together/sync";

export const POLL_MS = 1500;

interface Room {
  state: { playing: boolean; position: number; rate: number; seq: number; at: number; now: number };
  watching: string[];
}

interface Args {
  roomId: string | null;
  /** The player as it is now. */
  getLocal: () => LocalState | null;
  /** Do what the others did; false when the browser wouldn't (it won't start sound without a press). */
  apply: (playing: boolean, position: number) => Promise<boolean>;
  onEnded: (why: "gone" | "full") => void;
}

/** Keeps this player in step with a watch-together room: looks in every moment, tells the others what the viewer does, and does what they do. */
export function useWatchTogether({ roomId, getLocal, apply, onEnded }: Args) {
  const [watching, setWatching] = useState<string[]>([]);
  const argsRef = useRef({ getLocal, apply, onEnded });
  useEffect(() => {
    argsRef.current = { getLocal, apply, onEnded };
  });

  useEffect(() => {
    if (!roomId) return;
    let stopped = false;
    let previous: LocalState | null = null;
    let lastAt = Date.now();
    let seenSeq = 0;
    const post = async (set?: { playing: boolean; position: number }): Promise<Room | "gone" | "full" | null> => {
      const res = await fetch(`/api/watch-together/${roomId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(set ? { set } : {}) }).catch(() => null);
      if (!res) return null;
      if (res.status === 410) return "gone";
      if (res.status === 409) return "full";
      return res.ok ? ((await res.json()) as Room) : null;
    };
    const shared = (r: Room): SharedState => r.state;

    const tick = async () => {
      if (stopped) return;
      const room = await post();
      if (stopped) return;
      if (room === "gone" || room === "full") return void argsRef.current.onEnded(room);
      if (!room) return; // a hiccup: look again next time
      setWatching(room.watching);
      const local = argsRef.current.getLocal();
      if (!local) return;
      const now = Date.now();
      const d = decide({ previous, elapsedMs: now - lastAt, local, shared: shared(room), seenSeq });
      lastAt = now;
      if (d.kind === "push") {
        const pushed = await post({ playing: d.playing, position: d.position });
        if (pushed && pushed !== "gone" && pushed !== "full") seenSeq = pushed.state.seq;
        previous = local;
      } else if (d.kind === "follow") {
        seenSeq = d.seq;
        const done = await argsRef.current.apply(d.playing, d.position);
        previous = done ? { playing: d.playing, time: d.position } : argsRef.current.getLocal();
      } else previous = local;
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [roomId]);

  return { watching: roomId ? watching : [] };
}
