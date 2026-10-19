"use client";

import { useEffect, useRef, useState } from "react";

interface Reading {
  at: string;
  lines: string[];
}

const box = (r: DOMRect) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;

/**
 * A diagnostic for a phone where touches don't land on the controls they appear on (an installed web app in landscape): it outlines every
 * control where the page has drawn it, marks each touch where the page was told it landed, and prints the screen, viewport and scroll numbers
 * that explain an offset. Switched on and off by pressing and holding the picture for a moment; it changes nothing else.
 */
export function TouchProbe({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<string[]>([]);
  const [touches, setTouches] = useState<Reading[]>([]);
  const [outlines, setOutlines] = useState<{ key: string; style: React.CSSProperties }[]>([]);
  const [dots, setDots] = useState<{ key: number; x: number; y: number }[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    const measure = () => {
      const vv = window.visualViewport;
      const root = document.querySelector("[data-player-root]");
      setView([
        `inner ${window.innerWidth}x${window.innerHeight}  screen ${screen.width}x${screen.height}  dpr ${window.devicePixelRatio}`,
        vv ? `visual ${Math.round(vv.width)}x${Math.round(vv.height)} offset ${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)} page ${Math.round(vv.pageLeft)},${Math.round(vv.pageTop)} scale ${vv.scale}` : "no visualViewport",
        `scroll ${Math.round(window.scrollX)},${Math.round(window.scrollY)}  standalone ${String((navigator as { standalone?: boolean }).standalone)}  orient ${screen.orientation?.type ?? "?"}`,
        root ? `player ${box(root.getBoundingClientRect())}` : "player root not found",
      ]);
      const found = Array.from(document.querySelectorAll<HTMLElement>("[data-controls] button, [data-controls] [role=slider], [data-top] a, [data-top] button"));
      setOutlines(
        found.map((el, i) => {
          const r = el.getBoundingClientRect();
          return { key: `${i}`, style: { left: r.left, top: r.top, width: r.width, height: r.height } };
        })
      );
    };
    measure();
    const timer = window.setInterval(measure, 400);
    const onDown = (e: PointerEvent) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const named = target ? `${target.tagName.toLowerCase()}${target.getAttribute("aria-label") ? `[${target.getAttribute("aria-label")}]` : target.getAttribute("role") ? `[role=${target.getAttribute("role")}]` : ""}` : "nothing";
      const key = ++counter.current;
      setDots((d) => [...d.slice(-5), { key, x: e.clientX, y: e.clientY }]);
      setTouches((t) => [
        { at: new Date().toLocaleTimeString(), lines: [`${e.pointerType} client ${Math.round(e.clientX)},${Math.round(e.clientY)} screen ${Math.round(e.screenX)},${Math.round(e.screenY)} page ${Math.round(e.pageX)},${Math.round(e.pageY)}`, `page sees: ${named}  (event target: ${(e.target as HTMLElement)?.tagName?.toLowerCase()})`] },
        ...t.slice(0, 3),
      ]);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]" aria-hidden>
      {outlines.map((o) => (
        <div key={o.key} className="absolute border border-cyan-400/90" style={o.style} />
      ))}
      {dots.map((d) => (
        <div key={d.key} className="absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-red-500 bg-red-500/40" style={{ left: d.x, top: d.y }} />
      ))}
      <div className="absolute left-1/2 top-2 w-[min(94vw,46rem)] -translate-x-1/2 rounded-lg bg-black/85 p-2 font-mono text-[10px] leading-snug text-lime-300">
        <p className="mb-1 font-semibold text-white">Touch test — cyan boxes are where the controls are drawn, red dots are where touches landed. Hold the picture to close.</p>
        {view.map((l) => (
          <p key={l}>{l}</p>
        ))}
        {touches.map((t, i) => (
          <div key={`${t.at}${i}`} className="mt-1 border-t border-white/20 pt-1">
            <p className="text-white/70">{t.at}</p>
            {t.lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        ))}
        <button type="button" onClick={onClose} className="pointer-events-auto mt-1 rounded bg-white/20 px-2 py-0.5 text-white">
          Close
        </button>
      </div>
    </div>
  );
}
