import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { DEMO_CLIPS } from "@/lib/demo/credits";

/** Credits for the footage on a public demo server. Not found on any other server. */
export default async function CreditsPage({ params }: PageProps<"/s/[serverId]/credits">) {
  const { serverId } = await params;
  await requireServerMember(serverId);
  const [server] = await db.select({ isDemo: servers.isDemo }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server?.isDemo) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Footage credits" }]} className="-mb-2" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Footage credits</h1>
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
    </div>
  );
}
