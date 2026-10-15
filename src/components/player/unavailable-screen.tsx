"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setWatching, type Unavailable } from "@/lib/ownership/client";
import { enablePush, pushEnabled, pushSupported } from "@/lib/ownership/push-client";

const RETRY_MS = 20_000;

/**
 * Shown instead of the picture when a title can't be played because every copy is withdrawn or being played. While every copy is in use
 * it tries again by itself, so playing starts the moment one is free; it can also ask to be told (a notification) in case the
 * viewer has gone elsewhere.
 */
export function UnavailableScreen({ info, backHref, onRetry }: { info: Unavailable; backHref: string; onRetry: () => void }) {
  const [watching, setWatchingState] = useState(info.watching);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (info.code !== "busy") return;
    const t = setInterval(onRetry, RETRY_MS);
    return () => clearInterval(t);
  }, [info.code, onRetry]);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-black px-6 text-center">
      <p className="max-w-sm text-sm text-white/80" role="status">
        {info.error}
      </p>
      {info.code === "busy" && <p className="max-w-sm text-xs text-white/60">This page keeps checking, and starts as soon as a copy is free.</p>}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {info.code === "busy" && (
          <Button
            type="button"
            variant="secondary"
            className="rounded-xl"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              if (await setWatching(info.unit, !watching)) {
                setWatchingState(!watching);
                // Asking to be told is the moment to offer a notification on this device (the browser asks; saying no changes nothing else).
                if (!watching && pushSupported() && !(await pushEnabled())) void enablePush();
              }
              setBusy(false);
            }}
          >
            {watching ? <BellOff /> : <Bell />} {watching ? "Don't tell me" : "Tell me when it's free"}
          </Button>
        )}
        <Button render={<Link href={backHref} />} variant="secondary" className="rounded-xl">
          <ArrowLeft /> Go back
        </Button>
      </div>
    </div>
  );
}
