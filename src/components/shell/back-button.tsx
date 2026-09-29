"use client";

import { ArrowLeft } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

export function BackButton({ serverId }: { serverId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const home = `/s/${serverId}/library`;

  if (pathname === home) return null;

  return (
    <button
      type="button"
      aria-label="Go back"
      onClick={() => {
        if (window.history.length > 1) router.back();
        // No in-app history to pop, e.g. a PWA cold launch straight onto a title page.
        else router.push(home);
      }}
      className="-ml-1 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
    >
      <ArrowLeft className="size-5" />
    </button>
  );
}
