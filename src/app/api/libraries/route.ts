import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { isFileTreeLibraryKind } from "@/lib/libraries/profile";
import { isVideoRating, ratingToAges } from "@/lib/libraries/video-rating";

const bodySchema = z.object({
  serverId: z.string().uuid(),
  name: z.string().min(1),
  kind: z.enum(["movies", "shows", "audiobooks", "video", "audio", "photos", "music", "ebooks"]),
  boxFolderId: z.string().min(1),
  // Only for file-tree libraries (video, audio, photos), where it is required: the minimum age that may see it, or null = unrated.
  rating: z.number().int().nullable().optional(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { rating, ...fields } = parsed.data;
  const isTree = isFileTreeLibraryKind(fields.kind);
  if (isTree) {
    if (rating === undefined || !isVideoRating(rating)) {
      return NextResponse.json({ error: "Choose a rating for this library." }, { status: 400 });
    }
  } else if (rating !== undefined) {
    return NextResponse.json({ error: "Only video, audio and photo libraries have a library rating." }, { status: 400 });
  }

  const admin = await getCurrentServerAdmin(parsed.data.serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [library] = await db.insert(libraries).values({ ...fields, access: "restricted", ratingAges: isTree ? ratingToAges(rating ?? null) : null }).returning();
  return NextResponse.json({ library });
}
