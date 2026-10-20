import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { feedbackActor, noStore, signedOut } from "@/lib/feedback/http";
import { similarRequests } from "@/lib/feedback/service";

/** Public requests that look like what is being typed (`?q=`, `kind`), so people can vote for one instead of sending another. */
export async function GET(request: Request) {
  const actor = await feedbackActor();
  if (!actor) return signedOut();
  const p = new URL(request.url).searchParams;
  const kind = p.get("kind") === "bug" ? "bug" : p.get("kind") === "feature" ? "feature" : null;
  return NextResponse.json({ items: await similarRequests(db, actor.who, p.get("q") ?? "", kind) }, { headers: noStore });
}
