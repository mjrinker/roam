import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { requirePlatformAdmin } from "@/lib/platform/guard";
import { FeedbackThread } from "@/components/feedback/feedback-thread";
import { isId } from "@/lib/feedback/http";
import { getItem } from "@/lib/feedback/service";

export const metadata: Metadata = { title: "Feedback", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** One report with the platform admin's controls: status, visibility, the sender and technical details, GitHub, and a reply. */
export default async function FeedbackInboxItemPage({ params }: PageProps<"/platform/feedback/[id]">) {
  const account = await requirePlatformAdmin();
  const { id } = await params;
  const found = isId(id) ? await getItem(db, { accountId: account.id, operator: true }, id) : null;
  if (!found) notFound();
  return (
    <main className="flex-1 px-4 py-8 sm:px-8">
      <FeedbackThread backHref="/platform/feedback" backLabel="Feedback inbox" item={found.item} comments={found.comments} canWrite operator />
    </main>
  );
}
