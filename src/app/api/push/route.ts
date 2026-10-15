import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { getCurrentProfile } from "@/lib/auth/guards";
import { pushPublicKey, removeSubscription, saveSubscription } from "@/lib/ownership/push";
import { json, readJson } from "@/lib/ownership/http";

const sub = z.object({ endpoint: z.string().url().max(1000).startsWith("https://"), p256dh: z.string().max(200), auth: z.string().max(100) }).strict();

/** The key a browser needs to ask for push notifications (null when this deployment hasn't set push up). */
export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile) return json({ error: "Unauthorized" }, 401);
  return json({ publicKey: pushPublicKey() });
}

export async function PUT(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return json({ error: "Unauthorized" }, 401);
  const data = await readJson(request, sub);
  if (data instanceof NextResponse) return data;
  await saveSubscription(db, profile.id, data);
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) return json({ error: "Unauthorized" }, 401);
  const data = await readJson(request, z.object({ endpoint: z.string().max(1000) }).strict());
  if (data instanceof NextResponse) return data;
  await removeSubscription(db, profile.id, data.endpoint);
  return json({ ok: true });
}
