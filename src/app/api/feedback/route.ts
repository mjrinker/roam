import { NextResponse } from "next/server";
import { z } from "zod";
import { afterResponse } from "@/lib/after-response";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { githubConfig } from "@/lib/feedback/github";
import { feedbackActor, forbidden, isId, noStore, signedOut } from "@/lib/feedback/http";
import { FEEDBACK_KINDS, FEEDBACK_STATUSES, MAX_REPORTS_PER_DAY } from "@/lib/feedback/rules";
import { listBoard, listMine, submitFeedback, syncGithub } from "@/lib/feedback/service";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * The board and your own reports. `?view=board` (default) lists the public items, most voted first (`kind`, `status`, `q`, `sort=new`);
 * `?view=mine` lists everything this account has sent, private reports too.
 */
export async function GET(request: Request) {
  const actor = await feedbackActor();
  if (!actor) return signedOut();
  const p = new URL(request.url).searchParams;
  const kind = z.enum(FEEDBACK_KINDS).safeParse(p.get("kind"));
  const status = z.enum([...FEEDBACK_STATUSES, "open"]).safeParse(p.get("status"));
  const items =
    p.get("view") === "mine"
      ? await listMine(db, actor.who)
      : await listBoard(db, actor.who, { kind: kind.success ? kind.data : null, status: status.success ? status.data : null, q: p.get("q"), sort: p.get("sort") === "new" ? "new" : "top" });
  return NextResponse.json({ items }, { headers: noStore });
}

const submitSchema = z.object({
  kind: z.string(),
  title: z.string().max(400),
  body: z.string().max(20_000),
  keepPrivate: z.boolean().optional(),
  serverId: z.string().optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});

/** Sends a bug report or feature request. Answers `{ id, visibility }`; a GitHub issue is filed afterwards when the deployment is set up for it. */
export async function POST(request: Request) {
  const actor = await feedbackActor();
  if (!actor) return signedOut();
  if (!actor.canWrite) return forbidden();
  const parsed = submitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That didn't look right." }, { status: 400, headers: noStore });
  if (!(await checkRateLimit(actor.who.accountId, "feedback_report", MAX_REPORTS_PER_DAY, 86_400))) {
    return NextResponse.json({ error: "That's a lot of reports for one day. Try again tomorrow." }, { status: 429, headers: noStore });
  }
  // The server it was sent from, only if this account is really in it.
  const serverId = parsed.data.serverId && isId(parsed.data.serverId) && (await getCurrentServerMember(parsed.data.serverId)) ? parsed.data.serverId : null;
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  const { serverId: _asked, ...rest } = parsed.data;
  void _asked;
  const result = await submitFeedback(db, {
    ...rest,
    authorId: actor.who.accountId,
    serverId,
    diagnostics: parsed.data.diagnostics ? { ...parsed.data.diagnostics, ...(version ? { appVersion: version } : {}) } : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: noStore });
  const cfg = githubConfig();
  if (cfg) afterResponse(() => syncGithub(db, result.value.id, cfg));
  return NextResponse.json(result.value, { status: 201, headers: noStore });
}
