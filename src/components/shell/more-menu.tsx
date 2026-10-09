"use client";

import { Children, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PANEL_WIDTH = 240;
const EDGE = 8;

export interface PanelPlacement {
  top: number;
  left: number;
  /** Set when the panel is taller than the room it has: it scrolls instead of running off the screen. */
  maxHeight?: number;
}

/**
 * Where the panel goes: under the button when it fits there, else above it, else in whichever side has more room with a
 * height limit so it scrolls. Always inside the window sideways (pure, so it can be tested).
 */
export function placePanel(
  button: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  panel: { width: number; height: number } = { width: PANEL_WIDTH, height: 0 }
): PanelPlacement {
  const left = Math.max(EDGE, Math.min(button.left, viewport.width - panel.width - EDGE));
  const below = viewport.height - button.bottom - EDGE * 2;
  const above = button.top - EDGE * 2;
  if (panel.height <= below) return { top: button.bottom + EDGE, left };
  if (panel.height <= above) return { top: button.top - EDGE - panel.height, left };
  return above > below ? { top: EDGE, left, maxHeight: Math.max(above, 0) + EDGE } : { top: button.bottom + EDGE, left, maxHeight: Math.max(below, 0) };
}

/** Clicks inside these belong to a menu or dialog opened from something in the panel, not to "outside". */
const KEEP_OPEN = '[data-slot^="dropdown-menu"], [role="menu"], [role="dialog"], [data-slot^="dialog"]';

/**
 * "More": the actions beyond the first two on a page, behind an ellipsis button. The panel is a floating list that stays mounted while closed, so the buttons in it
 * (and any dialog or menu they open) keep their state; it closes after an action, on Escape and on a click elsewhere. It renders nothing
 * when it has nothing to hold.
 */
export function MoreMenu({ children, label = "More actions", className }: { children: ReactNode; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  // False while the page is built on the server, true in the browser: the panel is drawn into the page body, which only exists there.
  const mounted = useSyncExternalStore(() => () => undefined, () => true, () => false);
  const [pos, setPos] = useState<PanelPlacement>({ top: 0, left: 0 });
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
    const b = button.current;
    const p = panel.current;
    if (!open && b && p) {
      // Measure the panel as it will look (it is kept hidden while closed), then put it where it fits.
      p.hidden = false;
      const height = p.scrollHeight;
      setPos(placePanel(b.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, { width: PANEL_WIDTH, height }));
    }
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
        aria-label={label}
        title={label}
        onClick={toggle}
        className={cn("size-11 rounded-xl bg-white/10 p-0 backdrop-blur hover:bg-white/20", className)}
      >
        <MoreHorizontal className="size-5" />
      </Button>
      {mounted &&
        createPortal(
          <div
            ref={panel}
            hidden={!open}
            role="group"
            aria-label={label}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: PANEL_WIDTH, maxHeight: pos.maxHeight, overflowY: pos.maxHeight ? "auto" : undefined }}
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
