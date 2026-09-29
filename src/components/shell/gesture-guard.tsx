"use client";

import { useEffect } from "react";

// iOS Safari ignores `user-scalable=no`, so pinch and double-tap zoom have to
// be blocked at the gesture level.
export function GestureGuard() {
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    let lastTouchEnd = 0;
    const onTouchEnd = (e: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchEnd < 300) e.preventDefault();
      lastTouchEnd = now;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    document.addEventListener("gesturestart", block);
    document.addEventListener("gesturechange", block);
    document.addEventListener("touchend", onTouchEnd, { passive: false });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", block);
      document.removeEventListener("gesturechange", block);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, []);
  return null;
}
