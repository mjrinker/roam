import Link from "next/link";
import { BrandLogo } from "@/components/shell/brand";
import { Button } from "@/components/ui/button";
import { TmdbAttribution } from "@/components/shell/tmdb-attribution";

const FEATURES: { title: string; text: string }[] = [
  { title: "Your storage, your files", text: "Connect your own Box, Dropbox, OneDrive or Google Drive. Roam reads the folders you choose and never copies, moves or changes your files." },
  { title: "A library for everything", text: "Movies, TV shows, music, audiobooks, ebooks, photos and videos, organised with posters, descriptions, cast and chapters." },
  { title: "Share with your people", text: "Invite family and friends by email. Profiles can have age limits, and each library can be limited to the people you pick." },
  { title: "Watch anywhere", text: "Play in a browser or on a TV, resume where you left off, and download to watch offline on a phone or tablet." },
];

/** What a visitor who isn't signed in sees at the front door: what Roam is for, and how it treats their data, before any sign-in. */
export function LandingPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-14 px-5 py-12 sm:py-20">
      <header className="flex flex-col items-start gap-6">
        <BrandLogo variant="gradient" className="h-12" />
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">A private media server for your family and friends</h1>
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
            Roam turns the movies, shows, music, audiobooks, books and photos you already keep in your own cloud storage into one library you can watch, listen to and read from any device, and share with the people you choose.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button render={<Link href="/sign-in" />} className="h-12 rounded-xl px-7 text-base font-semibold">
            Sign in or create an account
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">Servers are private: you join one by invitation, or start your own.</p>
      </header>

      <section aria-label="What Roam does" className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-2xl bg-white/[0.04] p-5 ring-1 ring-white/[0.08]">
            <h2 className="text-lg font-semibold">{f.title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.text}</p>
          </div>
        ))}
      </section>

      <section aria-label="How Roam uses your data" className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-6 ring-1 ring-white/[0.08]">
        <h2 className="text-xl font-semibold">How Roam uses your Google account and data</h2>
        <p className="text-sm leading-relaxed text-foreground/85">
          You can sign in to Roam with Google; Roam then receives your email address and basic profile, only to identify your account. A server&apos;s owner can also connect their <strong>Google Drive</strong> so Roam can list the folders they choose and stream the media in them to the people
          they invite. That access is <strong>read-only</strong> unless the owner chooses to allow editing for that Drive: then Roam asks Google for permission to change files, and uses it only to replace the date and place stored inside a photo, save a scene file beside a film, and rename a folder to add a title-matching tag. Roam never deletes, moves or shares anything in the Drive, and Google Drive keeps the earlier version of any file Roam changes. Roam does not sell your data or use it for advertising.
        </p>
        <p className="text-sm leading-relaxed text-foreground/85">
          Roam&apos;s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. Read the full details in the{" "}
          <Link href="/privacy" className="text-primary underline underline-offset-2">
            Privacy Policy
          </Link>
          .
        </p>
      </section>

      <footer className="flex flex-col gap-4 border-t border-white/10 pt-6">
        <nav className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <Link href="/privacy" className="hover:text-foreground hover:underline">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-foreground hover:underline">
            Terms of Service
          </Link>
          <Link href="/help" className="hover:text-foreground hover:underline">
            Help
          </Link>
          <Link href="/sign-in" className="hover:text-foreground hover:underline">
            Sign in
          </Link>
        </nav>
        <TmdbAttribution />
      </footer>
    </main>
  );
}
