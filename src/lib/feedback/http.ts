import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentViewer } from "@/lib/auth/viewer";
import type { Who } from "@/lib/feedback/service";

export const noStore = { "Cache-Control": "private, no-store" };
export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: noStore });
export const isId = (v: string) => z.string().uuid().safeParse(v).success;

export interface Actor {
  who: Who;
  /** A limited profile (a child's) can read the board but not send, vote or comment. */
  canWrite: boolean;
}

/** The signed-in person asking, or null. A platform admin is the operator. */
export async function feedbackActor(): Promise<Actor | null> {
  const resolved = await getCurrentViewer();
  if (!resolved) return null;
  return { who: { accountId: resolved.account.id, operator: resolved.account.isPlatformAdmin }, canWrite: !!resolved.viewer && resolved.viewer.role !== "limited" && !resolved.account.isGuest };
}

export const signedOut = () => NextResponse.json({ error: "Sign in first." }, { status: 401, headers: noStore });
export const forbidden = (error = "This profile can't do that.") => NextResponse.json({ error }, { status: 403, headers: noStore });
