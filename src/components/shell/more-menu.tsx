"use client";

import { Children, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PANEL_WIDTH = 240;
const EDGE = 8;

/** Where the panel goes: just under the button, kept inside the window (pure, so it can be tested). */
export function placePanel(button: { left: number; bottom: number; right: number }, viewport: { width: number }, panelWidth = PANEL_WIDTH): { top: number; left: number } {
  const left = Math.max(EDGE, Math.min(button.left, viewport.width - panelWidth - EDGE));
  return { top: button.bottom + EDGE, left };
}

/** Clicks inside these belong to a menu or dialog opened from something in the panel, not to "outside". */
const KEEP_OPEN = '[data-slot^="dropdown-menu"], [role="menu"], [role="dialog"], [data-slot^="dialog"]';

/**
 * "More": the actions beyond the first two on a page. The panel is a floating list that stays mounted while closed, so the buttons in it
 * (and any dialog or menu they open) keep their state; it closes after an action, on Escape and on a click elsewhere. It renders nothing
 * when it has nothing to hold.
 */
export function MoreMenu({ children, label = "More", className }: { children: ReactNode; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  // False while the page is built on the server, true in the browser: the panel is drawn into the page body, which only exists there.
  const mounted = useSyncExternalStore(() => () => undefined, () => true, () => false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hasContent = Children.toArray(children).length > 0;

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const t = e.target as Element | null;
      if (!t || button.current?.contains(t) || panel.current?.contains(t) || t.closest?.(KEEP_OPEN)) return;
      close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, close]);

  if (!hasContent) return null;

  function toggle() {
    if (!open && button.current) setPos(placePanel(button.current.getBoundingClientRect(), { width: window.innerWidth }));
    setOpen((o) => !o);
  }

  return (
    <>
      <Button
        ref={button}
        type="button"
        variant="secondary"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        className={cn("h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20", className)}
      >
        <MoreHorizontal className="size-4" />
        {label}
      </Button>
      {mounted &&
        createPortal(
          <div
            ref={panel}
            hidden={!open}
            role="group"
            aria-label={label}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_WIDTH }}
            onClick={(e) => {
              // After an action the panel closes; a button that opens a menu of its own keeps it open so the menu has somewhere to hang.
              const t = e.target as Element;
              if (t.closest("button, a") && !t.closest("[aria-haspopup]")) close();
            }}
            className="z-50 flex flex-col gap-1.5 rounded-xl bg-popover p-2 text-popover-foreground shadow-xl ring-1 ring-foreground/10 [&>*]:w-full [&>*]:justify-start"
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
