import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BrandLogo } from "@/components/shell/brand";

export const metadata: Metadata = { title: "Help" };

/** The articles, in the order they are listed. Add a page under /help and a line here. */
const HELP_ARTICLES: { href: string; title: string; about: string }[] = [
  { href: "/help/naming", title: "Naming and organizing your files", about: "How to name movies, shows, music, subtitles, extras and posters so Roam finds them (the same way Plex does)." },
  { href: "/help/tv", title: "Watch Roam on your TV", about: "Open Roam in the web browser on a Samsung, LG or Fire TV, step by step." },
];

/** The list of help articles. Public (no sign-in), written for a phone screen. */
export default function HelpPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10 sm:py-14">
      <Link href="/" aria-label="Roam home" className="self-start">
        <BrandLogo variant="gradient" className="h-10" />
      </Link>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Help</h1>
        <p className="mt-2 text-muted-foreground">Guides for getting the most out of Roam.</p>
      </header>
      <ul className="flex flex-col gap-3">
        {HELP_ARTICLES.map((a) => (
          <li key={a.href}>
            <Link href={a.href} className="group flex items-center gap-4 rounded-2xl bg-card/70 p-4 ring-1 ring-white/[0.08] transition hover:bg-card hover:ring-primary/40">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{a.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{a.about}</p>
              </div>
              <ArrowRight className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
            </Link>
          </li>
        ))}
      </ul>
      <footer className="border-t border-white/10 pt-6 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-foreground hover:underline">
          Back to Roam
        </Link>
      </footer>
    </main>
  );
}
