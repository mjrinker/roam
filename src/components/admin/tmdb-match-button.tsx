"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MatchDialog } from "@/components/admin/unmatched-titles";

/** Admin-only: pick a different TMDB match for a movie or show the auto-matcher got wrong. */
export function TmdbMatchButton({
  titleId,
  titleName,
  kind,
}: {
  titleId: string;
  titleName: string;
  kind: "movie" | "show";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        title="Search TMDB and pick a different match"
        className="h-11 gap-2 rounded-xl bg-white/10 px-4 backdrop-blur hover:bg-white/20"
      >
        <Search />
        Re-match
      </Button>
      <MatchDialog
        title={{ id: titleId, name: titleName, kind }}
        open={open}
        onOpenChange={setOpen}
        onMatched={() => startTransition(() => router.refresh())}
      />
    </>
  );
}
