"use client";

// Catches errors thrown by pages under the (app) group (library, title,
// show, watch, admin) — e.g. a DB, Box, or TMDB call failing. Note: an
// error.tsx does NOT catch errors thrown by the layout.tsx at its own
// segment level (only in page.tsx and nested segments below it), so a
// failure in (app)/layout.tsx itself would need a boundary one level up.

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {error.message || "An unexpected error occurred."}
      </p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
