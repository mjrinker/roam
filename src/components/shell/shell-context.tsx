"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface ShellContextValue {
  /** Whether the mobile navigation drawer is open. Desktop always shows the sidebar inline. */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/**
 * Shared drawer state, provided above both the top bar (which holds the
 * hamburger) and the sidebar (which is the drawer) — they're siblings in
 * the tree, with no direct way to talk to each other otherwise.
 */
export function ShellProvider({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const value = useMemo(() => ({ drawerOpen, setDrawerOpen }), [drawerOpen]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within a ShellProvider");
  return ctx;
}
