import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { FeedbackThread } from "@/components/feedback/feedback-thread";
import { isId } from "@/lib/feedback/http";
import { getItem } from "@/lib/feedback/service";

export const metadata: Metadata = { title: "Feedback" };

/** One feedback item with its conversation (public items, or your own; the platform admin's controls show for the platform admin). */
export default async function FeedbackItemPage({ params }: PageProps<"/s/[serverId]/feedback/[id]">) {
  const { serverId, id } = await params;
  const { profile, viewer } = await requireServerMember(serverId);
  const found = isId(id) ? await getItem(db, { accountId: profile.id, operator: profile.isPlatformAdmin }, id) : null;
  if (!found) notFound();
  return (
    <div className="px-4 py-8 sm:px-8">
      <FeedbackThread backHref={`/s/${serverId}/feedback`} backLabel="Feedback" item={found.item} comments={found.comments} canWrite={viewer.role !== "limited" && !profile.isGuest} operator={profile.isPlatformAdmin} />
    </div>
  );
}
