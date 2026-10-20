import { NextResponse } from "next/server";
import { githubConfig, repoIsPublic } from "@/lib/feedback/github";
import { feedbackActor, noStore, signedOut } from "@/lib/feedback/http";

/** What the "send feedback" form must tell people: whether their report is also filed on GitHub, and whether that is public. */
export async function GET() {
  if (!(await feedbackActor())) return signedOut();
  const cfg = githubConfig();
  return NextResponse.json({ github: cfg ? { enabled: true, public: await repoIsPublic(cfg) } : { enabled: false, public: false } }, { headers: noStore });
}
