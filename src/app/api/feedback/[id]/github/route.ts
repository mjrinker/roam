import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { githubConfig } from "@/lib/feedback/github";
import { feedbackActor, isId, noStore, notFound } from "@/lib/feedback/http";
import { syncGithub } from "@/lib/feedback/service";

/** Platform admin: file the item's GitHub issue now (it failed before), or bring the issue in line with the item's status. */
export async function POST(_request: Request, ctx: RouteContext<"/api/feedback/[id]/github">) {
  const actor = await feedbackActor();
  if (!actor?.who.operator) return notFound();
  const { id } = await ctx.params;
  const cfg = githubConfig();
  if (!isId(id)) return notFound();
  if (!cfg) return NextResponse.json({ error: "GitHub isn't set up on this deployment (GITHUB_FEEDBACK_TOKEN and GITHUB_FEEDBACK_REPO)." }, { status: 409, headers: noStore });
  const result = await syncGithub(db, id, cfg);
  return result.ok ? NextResponse.json({ ok: true }, { headers: noStore }) : NextResponse.json({ error: result.error ?? "GitHub said no." }, { status: 502, headers: noStore });
}
