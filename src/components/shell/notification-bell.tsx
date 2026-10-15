"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { disablePush, enablePush, pushEnabled, pushSupported } from "@/lib/ownership/push-client";

interface Item {
  id: string;
  message: string;
  href: string | null;
  createdAt: string;
  read: boolean;
}

const POLL_MS = 60_000;

/** The bell in the top bar: what needs attention (a claim to review, an answer to a claim, a title that's free now), and the switch for notifications on this device. Shown only once there is something in it. */
export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [push, setPush] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/notifications").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { unread: number; items: Item[] };
    setItems(data.items);
    setUnread(data.unread);
  }, []);

  useEffect(() => {
    // Fetched once the page is up and then now and then, and when the tab comes back into view.
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void pushEnabled().then(setPush);
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (items.length === 0) return null;
  const readAll = async () => {
    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
    void load();
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} new` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
      >
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="fixed inset-x-2 top-16 z-50 max-h-[70dvh] overflow-y-auto rounded-xl bg-popover p-3 text-popover-foreground shadow-2xl ring-1 ring-white/10 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-96">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={readAll}>
                Mark all read
              </Button>
            )}
          </div>
          <ul className="flex flex-col gap-1">
            {items.map((n) => (
              <li key={n.id}>
                <Link
                  href={n.href ?? "#"}
                  onClick={async () => {
                    setOpen(false);
                    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.id }) }).catch(() => undefined);
                    void load();
                  }}
                  className={`block rounded-lg px-3 py-2 text-sm hover:bg-white/[0.08] ${n.read ? "text-muted-foreground" : "bg-white/[0.04] font-medium"}`}
                >
                  {n.message}
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</span>
                </Link>
              </li>
            ))}
          </ul>
          {pushSupported() && push !== null && (
            <div className="mt-3 border-t border-white/10 pt-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={async () => {
                  if (push) {
                    await disablePush();
                    setPush(false);
                    return;
                  }
                  const r = await enablePush();
                  setPush(r === "enabled");
                  if (r === "denied") toast.error("Notifications are blocked for this site in your browser's settings.");
                  else if (r === "not-configured") toast.error("This server hasn't set up notifications.");
                  else if (r === "failed") toast.error("Couldn't turn notifications on.");
                }}
              >
                {push ? "Turn off notifications on this device" : "Get notifications on this device"}
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">On an iPhone or iPad this needs Roam added to the Home Screen.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
