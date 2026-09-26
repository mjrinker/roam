import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-24 text-center">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-white/[0.06] ring-1 ring-white/10">
        <Clapperboard className="size-7 text-primary" />
      </span>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Nothing to see here</h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          That page, title, or episode doesn&apos;t exist — or it isn&apos;t in a server you
          belong to.
        </p>
      </div>
      <Button render={<Link href="/" />} className="h-11 rounded-xl px-6">
        Take me home
      </Button>
    </main>
  );
}
