import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { LibrarySidebar } from "@/components/library/library-sidebar";

export default async function LibraryLayout({
  children,
  params,
}: LayoutProps<"/s/[serverId]/library">) {
  const { serverId } = await params;
  await requireServerMember(serverId);

  const serverLibraries = await db
    .select({ id: libraries.id, name: libraries.name, kind: libraries.kind })
    .from(libraries)
    .where(eq(libraries.serverId, serverId))
    .orderBy(asc(libraries.name));

  return (
    <div className="flex">
      <LibrarySidebar serverId={serverId} libraries={serverLibraries} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
