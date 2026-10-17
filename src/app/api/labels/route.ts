import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { badRequest, readJson, requireActor, throttled, uuid } from "@/lib/playlists/http";
import { createLabel, labelsForTitle, listLabels, setTitleLabel } from "@/lib/labels/service";
import { LABEL_TITLE_KINDS } from "@/lib/labels/kinds";

const createBody = z.object({ name: z.string().max(200), titleId: uuid.optional() }).strict();

/** The signed-in profile's labels with how many titles each has; with `?title=<id>`, also whether each is on that title. Labels are private to the profile. */
export async function GET(request: Request) {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const title = new URL(request.url).searchParams.get("title");
  if (title !== null) {
    if (!uuid.safeParse(title).success) return badRequest("Invalid request");
    const auth = await authorizeOwner("title", title, { titleKinds: [...LABEL_TITLE_KINDS] });
    if (!auth.ok || auth.member.viewer.id !== who.actor.viewerId) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ labels: await labelsForTitle(db, who.actor.viewerId, title) });
  }
  return NextResponse.json({ labels: await listLabels(db, who.actor.viewerId) });
}

/** Makes a label (and, with `titleId`, puts that title under it). */
export async function POST(request: Request) {
  const who = await requireActor();
  if ("response" in who) return who.response;
  const limited = await throttled(who.actor.accountId, "labels", 60, 600);
  if (limited) return limited;
  const parsed = createBody.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error);
  if (parsed.data.titleId) {
    const auth = await authorizeOwner("title", parsed.data.titleId, { titleKinds: [...LABEL_TITLE_KINDS] });
    if (!auth.ok || auth.member.viewer.id !== who.actor.viewerId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const made = await createLabel(db, who.actor.viewerId, parsed.data.name);
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: made.status });
  if (parsed.data.titleId) {
    await setTitleLabel(db, who.actor.viewerId, made.value.id, parsed.data.titleId, true);
    made.value.count = 1;
  }
  return NextResponse.json(made.value, { status: 201 });
}
