import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { requireProfile } from "@/lib/auth/guards";
import { SeamlessPlayer } from "@/components/player/seamless-player";

export default async function WatchPage({ params }: PageProps<"/watch/[id]">) {
  const { id } = await params;
  await requireProfile();

  const [title] = await db.select().from(titles).where(eq(titles.id, id)).limit(1);
  if (!title) notFound();

  return (
    <div className="flex flex-col">
      <SeamlessPlayer titleId={title.id} title={title.name} />
    </div>
  );
}
