import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { DEMO_CLIPS } from "@/lib/demo/credits";
import { groupedCredits } from "@/lib/demo/extras-credits";

/** Credits for the footage, photos, music, audiobooks and books on a public demo server. Not found on any other server. */
export default async function CreditsPage({ params }: PageProps<"/s/[serverId]/credits">) {
  const { serverId } = await params;
  await requireServerMember(serverId);
  const [server] = await db.select({ isDemo: servers.isDemo }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server?.isDemo) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Credits" }]} className="-mb-2" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Credits</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This is a demonstration of Roam. The movies and shows here are filed under familiar names, with posters and descriptions from TMDB, but
          what plays is placeholder footage: public-domain or openly licensed clips, credited below. None of it is the film or show named.
        </p>
      </div>
      {DEMO_CLIPS.length === 0 ? (
        <p className="text-sm text-muted-foreground">The footage list will appear here.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {DEMO_CLIPS.map((clip) => (
            <li key={clip.sourceUrl} className="rounded-xl bg-white/[0.04] p-4 ring-1 ring-white/[0.08]">
              <p className="font-medium">{clip.title}</p>
              <p className="text-sm text-muted-foreground">{clip.credit}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {clip.licenseUrl ? (
                  <a href={clip.licenseUrl} rel="noreferrer noopener" target="_blank" className="underline underline-offset-2">
                    {clip.license}
                  </a>
                ) : (
                  clip.license
                )}
                {" · "}
                <a href={clip.sourceUrl} rel="noreferrer noopener" target="_blank" className="underline underline-offset-2">
                  Source
                </a>
              </p>
              {clip.usedFor.length > 0 && <p className="mt-1 text-xs text-muted-foreground/80">Plays as: {clip.usedFor.join(", ")}</p>}
            </li>
          ))}
        </ul>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Photos, music, audiobooks and books</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Public-domain or CC0 photographs from Wikimedia Commons, Musopen&apos;s CC0 recordings of Chopin, LibriVox&apos;s public-domain audiobook readings
          and Project Gutenberg&apos;s public-domain books are shown as what they are. The albums by famous artists and the Tolkien books are stand-ins: their
          names, track lists and years are the real ones (album details and covers come from MusicBrainz and the Cover Art Archive), but the songs are 40-second clips of
          the CC0 Chopin recordings and the books hold public-domain text by William Morris, with a plain cover drawn for the demo. Those books are still in
          copyright, so none of their text is included.
        </p>
        {groupedCredits().map((group) => (
          <details key={group.library} className="rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08]">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              {group.library} <span className="text-muted-foreground">({group.items.length})</span>
            </summary>
            <ul className="divide-y divide-white/[0.06] px-4 pb-2">
              {group.items.map((c) => (
                <li key={c.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
                  <span className="min-w-0 break-words">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.author} · {c.licence} ·{" "}
                    <a href={c.source} rel="noreferrer noopener" target="_blank" className="underline underline-offset-2">
                      Source
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>
    </div>
  );
}
