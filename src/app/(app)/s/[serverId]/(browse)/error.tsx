"use client";

// Catches errors thrown by browse pages while keeping the sidebar/top bar
// (and anything mounted in the server layout above, like a playing
// audiobook) alive. The (app)/error.tsx boundary sits above the server
// layout, so without this a failing page would replace all of it.

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function BrowseError({
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
    <div className="flex flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {error.message || "An unexpected error occurred."}
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
