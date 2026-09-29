"use client";

import { ArrowLeft } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

// Where "back" lands when there's no in-app history to pop, e.g. a PWA cold
// launch straight onto a title page.
function fallbackFor(pathname: string, serverId: string): string {
  const home = `/s/${serverId}/library`;
  if (pathname === home) return "/servers";
  return home;
}

export function BackButton({ serverId }: { serverId: string }) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <button
      type="button"
      aria-label="Go back"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push(fallbackFor(pathname, serverId));
      }}
      className="-ml-1 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
    >
      <ArrowLeft className="size-5" />
    </button>
  );
}
