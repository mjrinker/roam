"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface LibrarySidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const LibrarySidebarContext = createContext<LibrarySidebarContextValue | null>(null);

/**
 * Shared open/closed state for the mobile library-sidebar drawer, provided
 * above both the top nav (which holds the toggle button) and the nested
 * library layout (which holds the actual drawer) — they're siblings deep
 * in the tree otherwise, with no direct way to talk to each other.
 */
export function LibrarySidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <LibrarySidebarContext.Provider value={value}>{children}</LibrarySidebarContext.Provider>
  );
}

export function useLibrarySidebar(): LibrarySidebarContextValue {
  const ctx = useContext(LibrarySidebarContext);
  if (!ctx) {
    throw new Error("useLibrarySidebar must be used within a LibrarySidebarProvider");
  }
  return ctx;
}
