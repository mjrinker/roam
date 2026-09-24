import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-sm text-muted-foreground">
        That page, title, or episode doesn&apos;t exist (or isn&apos;t in your library).
      </p>
      <Button render={<Link href="/library" />}>Back to library</Button>
    </main>
  );
}
