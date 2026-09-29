"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useShell } from "@/components/shell/shell-context";

const THRESHOLD = 56;
const MAX_PULL = 110;

// True when the touch started inside something that scrolls on its own and
// isn't at its top — pulling there is a scroll, not a refresh.
function insideScrolledContainer(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight && el.scrollTop > 0) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** Touch-only pull-down-to-refresh; re-fetches the current route's server data. */
export function PullToRefresh() {
  const router = useRouter();
  const { drawerOpen } = useShell();
  const [pull, setPull] = useState(0);
  const [pending, startTransition] = useTransition();
  const [holding, setHolding] = useState(false);
  const busy = pending || holding;
  const busyRef = useRef(busy);
  const drawerRef = useRef(drawerOpen);

  useEffect(() => {
    busyRef.current = busy;
    drawerRef.current = drawerOpen;
  });

  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;

    let startY = 0;
    let startX = 0;
    let tracking = false;
    let current = 0;

    const reset = () => {
      tracking = false;
      current = 0;
      setPull(0);
    };

    const onStart = (e: TouchEvent) => {
      tracking = false;
      if (
        e.touches.length !== 1 ||
        window.scrollY > 0 ||
        busyRef.current ||
        drawerRef.current ||
        (e.target instanceof Element && e.target.closest("[data-no-pull]")) ||
        document.querySelector('[role="dialog"]') ||
        insideScrolledContainer(e.target)
      ) {
        return;
      }
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      tracking = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) {
        if (current > 0) reset();
        else if (dy <= 0) tracking = false;
        return;
      }
      // Rubber-band: pulling gets harder the further it goes.
      current = Math.min(MAX_PULL, dy * 0.5);
      setPull(current);
    };

    const onEnd = () => {
      if (!tracking) return;
      const triggered = current >= THRESHOLD;
      reset();
      if (!triggered) return;
      setHolding(true);
      window.setTimeout(() => setHolding(false), 700);
      startTransition(() => router.refresh());
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, [router]);

  const visible = busy || pull > 0;
  const offset = busy ? 56 : pull;
  const ready = pull >= THRESHOLD;

  return (
    <div
      aria-hidden={!visible}
      className="pointer-events-none fixed top-16 left-1/2 z-40 -ml-5 flex size-10 items-center justify-center rounded-full bg-popover text-primary shadow-lg ring-1 ring-white/10 md:hidden"
      style={{
        transform: `translateY(${offset - 48}px)`,
        opacity: visible ? Math.min(1, busy ? 1 : pull / 40) : 0,
        transition: pull > 0 ? "none" : "transform 200ms ease, opacity 200ms ease",
      }}
    >
      {busy ? (
        <Loader2 className="size-5 animate-spin" />
      ) : (
        <ArrowDown
          className="size-5 transition-transform"
          style={{ transform: ready ? "rotate(180deg)" : undefined }}
        />
      )}
    </div>
  );
}
