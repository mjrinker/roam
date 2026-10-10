"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Dices, Film, Headphones, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAudioActions } from "@/components/audio/audio-player-provider";
import { Artwork as Image } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import type { ChooseItem, ChooseLibrary } from "@/lib/choose/pick";
import { ROUNDS_BEFORE_ASKING, formatChooseRuntime, otherSide } from "@/lib/choose/session";
import { cn } from "@/lib/utils";

type Phase = "loading" | "pick" | "confirm" | "tired" | "done" | "error";

async function fetchItems(serverId: string, libraryIds: string[], exclude: string[], count: 1 | 2): Promise<ChooseItem[]> {
  const res = await fetch(`/api/servers/${serverId}/choose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ libraryIds, exclude: exclude.slice(-400), count }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : "Couldn't find anything to offer.");
  }
  return ((await res.json()) as { items: ChooseItem[] }).items;
}

function Card({ item, state, onChoose }: { item: ChooseItem; state: "open" | "chosen" | "passed"; onChoose?: () => void }) {
  const square = item.noun === "album" || item.noun === "track" || item.noun === "audiobook";
  const Icon = item.verb === "Watch" ? Film : Headphones;
  const runtime = formatChooseRuntime(item.runtimeSeconds);
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 rounded-2xl p-3 ring-1 transition", state === "chosen" ? "bg-primary/10 ring-primary/60" : "bg-white/[0.04] ring-white/[0.08]", state === "passed" && "opacity-50")}>
      <button
        type="button"
        onClick={onChoose}
        disabled={!onChoose}
        aria-pressed={state === "chosen"}
        aria-label={`Choose ${item.name}`}
        className={cn("group/card relative overflow-hidden rounded-xl bg-muted outline-none ring-1 ring-white/[0.08] focus-visible:ring-2 focus-visible:ring-primary", square ? "aspect-square" : "aspect-[2/3]", onChoose && "cursor-pointer transition hover:ring-white/30")}
      >
        {item.posterUrl ? (
          <Image src={item.posterUrl} alt="" fill sizes="(min-width: 640px) 320px, 80vw" className="object-cover" />
        ) : (
          <span className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-secondary via-muted to-background p-4 text-center">
            <Icon className="size-8 text-muted-foreground/60" />
            <span className="line-clamp-4 text-sm font-medium text-muted-foreground">{item.name}</span>
          </span>
        )}
        {state === "chosen" && (
          <span className="absolute top-3 left-3 flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
            <Check className="size-5" strokeWidth={3} />
          </span>
        )}
      </button>
      <div className="min-w-0">
        <p className="text-lg leading-snug font-semibold">{item.name}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{[item.subtitle, runtime].filter(Boolean).join(" · ")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground/80">From {item.libraryName}</p>
        {item.overview && <p className="mt-2 line-clamp-3 text-sm text-foreground/80">{item.overview}</p>}
        <a href={item.pageHref} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Details
        </a>
      </div>
    </div>
  );
}

/**
 * "Help me choose": two things at a time, pick one; then play it, or keep choosing with the one you picked set against a new one.
 * After a number of rounds it offers to pick for you.
 */
export function ChooseSession({ serverId, libraries }: { serverId: string; libraries: ChooseLibrary[] }) {
  const router = useRouter();
  const audio = useAudioActions();
  const libraryIds = libraries.map((l) => l.id);
  const [phase, setPhase] = useState<Phase>("loading");
  const [pair, setPair] = useState<ChooseItem[]>([]);
  const [chosen, setChosen] = useState<ChooseItem | null>(null);
  const [round, setRound] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Everything shown so far, so nothing comes round again until the libraries have run out.
  const seen = useRef<string[]>([]);
  const started = useRef(false);

  const remember = (items: ChooseItem[]) => {
    for (const i of items) if (!seen.current.includes(i.id)) seen.current.push(i.id);
  };

  const begin = useCallback(async () => {
    setPhase("loading");
    setChosen(null);
    setMessage(null);
    setRound(1);
    seen.current = [];
    try {
      const items = await fetchItems(serverId, libraryIds, [], 2);
      if (items.length === 0) return setPhase("done");
      remember(items);
      setPair(items);
      setPhase(items.length === 1 ? "confirm" : "pick");
      if (items.length === 1) setChosen(items[0]);
    } catch (e) {
      setMessage((e as Error).message);
      setPhase("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- libraryIds is derived from the stable `libraries` prop
  }, [serverId, libraries]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
  }, [begin]);

  /** Sets the picked one against a new item (from the libraries' unseen ones, or anything but these two once everything has been seen). */
  async function advance(keep: ChooseItem) {
    setBusy(true);
    setMessage(null);
    try {
      let [next] = await fetchItems(serverId, libraryIds, seen.current, 1);
      if (!next) {
        // Everything has been shown: start again, apart from the one being kept.
        seen.current = [keep.id];
        [next] = await fetchItems(serverId, libraryIds, seen.current, 1);
      }
      if (!next) {
        setPair([keep]);
        setChosen(keep);
        setPhase("confirm");
        setMessage("That's everything in these libraries, and this is the one you picked.");
      } else {
        remember([next]);
        setPair(otherSide(keep, next));
        setChosen(null);
        setRound((r) => r + 1);
        setPhase("pick");
      }
    } catch (e) {
      setMessage((e as Error).message);
    }
    setBusy(false);
  }

  async function play(item: ChooseItem) {
    setBusy(true);
    try {
      if (item.action.kind === "go") {
        router.push(item.action.href);
        return;
      }
      if (!audio) throw new Error("The audio player isn't ready.");
      const result = item.action.kind === "listen" ? await audio.load(item.action.titleId, { autoplay: true, startAt: undefined }) : await audio.playList(item.action.songIds, 0);
      if (!result.ok) throw new Error(result.error ?? "Couldn't start that.");
      router.push(item.pageHref);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  async function playAnyRandom() {
    setBusy(true);
    try {
      const [any] = await fetchItems(serverId, libraryIds, [], 1);
      if (!any) throw new Error("Nothing here to play.");
      await play(any);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  function keepChoosing() {
    if (!chosen) return;
    // After a run of rounds, ask whether to just choose instead of showing another pair.
    if (round % ROUNDS_BEFORE_ASKING === 0) setPhase("tired");
    else void advance(chosen);
  }

  const verb = chosen?.verb ?? pair[0]?.verb ?? "Watch";
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Dices className="size-6 text-primary" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Help me choose</h1>
          <p className="truncate text-sm text-muted-foreground">From {libraries.map((l) => l.name).join(", ")}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void begin()} disabled={busy} className="ml-auto gap-1.5">
          <RotateCcw className="size-4" /> Start over
        </Button>
      </div>

      {phase === "loading" && (
        <p className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> Finding something…
        </p>
      )}
      {phase === "error" && (
        <div className="flex flex-col items-start gap-3 py-10">
          <p role="alert" className="text-destructive">{message}</p>
          <Button onClick={() => void begin()}>Try again</Button>
        </div>
      )}
      {phase === "done" && (
        <div className="flex flex-col items-start gap-3 py-10">
          <p className="text-lg font-medium">There&apos;s nothing to choose from here yet.</p>
          <p className="text-sm text-muted-foreground">These libraries have nothing ready to watch, listen to or read (or nothing you&apos;re allowed to).</p>
          <Button render={<Link href={`/s/${serverId}/library`} />} variant="secondary"><ArrowLeft className="size-4" /> Back to Home</Button>
        </div>
      )}

      {(phase === "pick" || phase === "confirm" || phase === "tired") && (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {phase === "tired" ? "" : phase === "pick" ? `Round ${round}: which one?` : `Round ${round}`}
          </p>
          <div className={cn("grid gap-4", pair.length > 1 ? "sm:grid-cols-2" : "mx-auto w-full max-w-sm")}>
            {pair.map((item) => (
              <Card
                key={item.id}
                item={item}
                state={chosen ? (chosen.id === item.id ? "chosen" : "passed") : "open"}
                onChoose={phase === "pick" ? () => (setChosen(item), setPhase("confirm")) : undefined}
              />
            ))}
          </div>
        </>
      )}

      {phase === "confirm" && chosen && (
        <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.05] p-4 ring-1 ring-white/10">
          <p className="font-medium">
            {pair.length > 1 ? `You chose “${chosen.name}”.` : `“${chosen.name}”.`} {pair.length > 1 ? `Do you want to ${verb.toLowerCase()} it, or keep choosing?` : ""}
          </p>
          {message && <p className="text-sm text-muted-foreground">{message}</p>}
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void play(chosen)} className="h-11 gap-2 rounded-xl px-6 font-semibold">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} {verb} it
            </Button>
            {pair.length > 1 && (
              <Button variant="secondary" disabled={busy} onClick={keepChoosing} className="h-11 gap-2 rounded-xl px-6">
                Keep choosing
              </Button>
            )}
            {pair.length > 1 && (
              <Button variant="ghost" disabled={busy} onClick={() => (setChosen(null), setPhase("pick"))} className="h-11 rounded-xl px-4">
                Change my pick
              </Button>
            )}
          </div>
        </div>
      )}

      {phase === "tired" && (
        <div role="dialog" aria-label="Choose for you?" className="flex flex-col gap-3 rounded-2xl bg-primary/10 p-5 ring-1 ring-primary/40">
          <p className="flex items-start gap-2 text-lg font-medium">
            <Sparkles className="mt-1 size-5 shrink-0 text-primary" />
            Looks like you&apos;re having a hard time deciding, want me to just choose one for you?
          </p>
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void playAnyRandom()} className="h-11 gap-2 rounded-xl px-6 font-semibold">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Dices className="size-4" />} Choose one for me
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => chosen && void advance(chosen)} className="h-11 rounded-xl px-6">
              Keep going
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Or {verb.toLowerCase()} one of these:</span>
            {pair.map((item) => (
              <Button key={item.id} variant="outline" size="sm" disabled={busy} onClick={() => void play(item)} className="max-w-56 rounded-lg">
                <span className="truncate">{item.name}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
