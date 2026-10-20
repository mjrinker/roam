import type { Metadata } from "next";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { FeedbackBoard, type BoardTab } from "@/components/feedback/feedback-board";
import { listBoard, listMine } from "@/lib/feedback/service";

export const metadata: Metadata = { title: "Feedback" };

/** The feedback board: ideas to vote on, bugs the team has listed, and what this account has sent. */
export default async function FeedbackPage({ params, searchParams }: PageProps<"/s/[serverId]/feedback">) {
  const { serverId } = await params;
  const query = await searchParams;
  const { profile, viewer } = await requireServerMember(serverId);
  const who = { accountId: profile.id, operator: profile.isPlatformAdmin };
  const tab: BoardTab = query.tab === "bugs" ? "bugs" : query.tab === "mine" ? "mine" : "ideas";
  const q = typeof query.q === "string" ? query.q.slice(0, 60) : "";
  const items = tab === "mine" ? await listMine(db, who) : await listBoard(db, who, { kind: tab === "bugs" ? "bug" : "feature", q });
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
      <FeedbackBoard key={`${tab}:${q}`} serverId={serverId} tab={tab} items={items} canWrite={viewer.role !== "limited" && !profile.isGuest} q={q} />
    </div>
  );
}
