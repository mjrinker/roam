/** Subtitle files beside a video are found when its folder is scanned, and belong to the movie whichever file or resolution they sit next to. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { mediaFiles, subtitleTracks } from "@/lib/db/schema";
import type { StorageEntry } from "@/lib/storage/provider";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { sidecarsFor, syncSidecarTracks, tracksFor, videoBaseNames } from "./tracks";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const file = (id: string, name: string, sizeBytes = 100): StorageEntry => ({ id, name, kind: "file", sizeBytes });

describe("which subtitle files belong to a video", () => {
  it("takes the video's own name, without a part marker or a resolution version", () => {
    expect(videoBaseNames("David (2025) - 1080p - pt2.mp4")).toEqual(["david (2025) - 1080p - pt2", "david (2025) - 1080p", "david (2025)"]);
    expect(videoBaseNames("Movie.mp4")).toEqual(["movie"]);
  });

  it("lists every language beside a video, naming forced and SDH ones, and ignores other videos' files", () => {
    const children = [file("v1", "Movie (2020).mp4"), file("s1", "Movie (2020).en.srt"), file("s2", "Movie (2020).es.srt"), file("s3", "Movie (2020).fr.forced.srt"), file("s4", "Movie (2020).en.sdh.srt"), file("s5", "Other.en.srt"), file("v2", "Movie (2020)-trailer.mp4")];
    const [found, ...rest] = sidecarsFor(children);
    expect(rest).toEqual([]);
    expect(found.videoFile.id).toBe("v1");
    expect(found.subtitles.map((s) => [s.entry.id, s.language, s.label]).sort()).toEqual([
      ["s1", "eng", "English"],
      ["s2", "spa", "Spanish"],
      ["s3", "fra", "French (forced)"],
      ["s4", "eng", "English (SDH)"],
    ]);
  });
});

describe("recording them", () => {
  it("records the files against the movie, updates on a rescan, and forgets one that was deleted (saved ones stay)", async () => {
    const admin = await makeAccount(db, "sadmin");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "movies");
    const film = await makeTitle(db, lib.id, { kind: "movie", name: "David" }, { files: false });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: film.id, boxFileId: "p1", filename: "David (2025) - 1080p - pt1.mp4", partIndex: 0 });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: film.id, boxFileId: "p2", filename: "David (2025) - 1080p - pt2.mp4", partIndex: 1 });
    await db.insert(subtitleTracks).values({ ownerKind: "title", ownerId: film.id, language: "eng", label: "English (saved)", source: "saved", cues: [[1, 2, "hi"]] });

    const folder = [file("p1", "David (2025) - 1080p - pt1.mp4"), file("p2", "David (2025) - 1080p - pt2.mp4"), file("e", "David (2025).en.srt", 50), file("s", "David (2025).es.srt", 60)];
    await syncSidecarTracks(db, folder);
    expect((await tracksFor(db, "title", film.id)).map((t) => `${t.label}|${t.source}`).sort()).toEqual(["English (saved)|saved", "English|file", "Spanish|file"]);

    await syncSidecarTracks(db, folder); // a rescan changes nothing
    expect((await tracksFor(db, "title", film.id)).length).toBe(3);

    await syncSidecarTracks(db, folder.filter((f) => f.id !== "s")); // the Spanish file was deleted
    expect((await tracksFor(db, "title", film.id)).map((t) => t.label).sort()).toEqual(["English", "English (saved)"]);
    await syncSidecarTracks(db, folder.filter((f) => f.kind === "file" && !f.name.endsWith(".srt")));
    expect((await tracksFor(db, "title", film.id)).map((t) => t.source)).toEqual(["saved"]);
    expect(await db.select().from(subtitleTracks).where(and(eq(subtitleTracks.ownerId, film.id), eq(subtitleTracks.source, "file")))).toEqual([]);
  });
});
