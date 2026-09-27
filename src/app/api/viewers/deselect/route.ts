import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { VIEWER_COOKIE } from "@/lib/viewers/cookie";

/** Forget who was watching on this device (used on sign-out and "Switch profile"). */
export async function POST() {
  (await cookies()).delete(VIEWER_COOKIE);
  return NextResponse.json({ ok: true });
}
