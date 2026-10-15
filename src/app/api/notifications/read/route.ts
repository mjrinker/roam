import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { getCurrentProfile } from "@/lib/auth/guards";
import { markRead } from "@/lib/ownership/notify";
import { json, readJson, uuid } from "@/lib/ownership/http";

const body = z.object({ id: uuid.optional() }).strict();

/** Marks one notification (or all of them) as read. */
export async function POST(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return json({ error: "Unauthorized" }, 401);
  const data = await readJson(request, body);
  if (data instanceof NextResponse) return data;
  await markRead(db, profile.id, data.id);
  return json({ ok: true });
}
