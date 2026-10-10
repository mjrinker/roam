import Link from "next/link";
import { z } from "zod";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { choosableLibraries } from "@/lib/choose/libraries";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { ChooseSession } from "@/components/choose/choose-session";
import { Button } from "@/components/ui/button";

const idsSchema = z.array(z.string().uuid()).min(1).max(30);

/** "Help me choose" over the libraries named in `?libs=` (comma separated): two things at a time until one is picked. */
export default async function ChoosePage({ params, searchParams }: PageProps<"/s/[serverId]/choose">) {
  const { serverId } = await params;
  const query = await searchParams;
  const { profile, role } = await requireServerMember(serverId);
  const asked = idsSchema.safeParse(typeof query.libs === "string" ? query.libs.split(",").filter(Boolean) : []);
  // Only libraries this profile can see (and that have something to watch, listen to or read) are used; the rest are quietly left out.
  const libs = asked.success ? await choosableLibraries(db, libraryActor({ profile, role }, serverId), asked.data) : [];
  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Help me choose" }]} className="-mb-2" />
      {libs.length === 0 ? (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-20 text-center">
          <p className="text-lg font-medium">Choose some libraries first</p>
          <p className="text-sm text-muted-foreground">Start from Home, or from a library, to pick what to choose between.</p>
          <Button render={<Link href={`/s/${serverId}/library`} />} className="rounded-xl">
            Go to Home
          </Button>
        </div>
      ) : (
        <ChooseSession serverId={serverId} libraries={libs} />
      )}
    </div>
  );
}
