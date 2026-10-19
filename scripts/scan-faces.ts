/**
 * Finds the faces in photo libraries, on this computer, and saves a box, a small picture and a fingerprint for each. Nothing leaves your
 * machine except the pictures it already downloads from your own storage. Then it re-reads who the faces might be, from the people already
 * named. Pictures already searched are skipped, so run it again after new uploads.
 *
 * One-time setup (the two models, about 39 MB):
 *   mkdir -p ~/.cache/roam-faces && cd ~/.cache/roam-faces
 *   curl -LO https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
 *   curl -LO https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
 *
 *   npx tsx --env-file=.env.local scripts/scan-faces.ts [--library <libraryId>] [--limit <pictures>] [--rescan]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, mediaFiles, photoFaces, titles } from "@/lib/db/schema";
import { DETECTOR_FILE, DETECTOR_URL, FaceEngine, MODEL_DIR, RECOGNIZER_FILE, RECOGNIZER_URL } from "@/lib/faces/engine";
import { toBytes } from "@/lib/faces/geometry";
import { refreshSuggestions } from "@/lib/faces/service";
import { createStorageForServer } from "@/lib/storage/server-storage";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const CONCURRENCY = 3;
const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;

(async () => {
  for (const [file, url] of [[DETECTOR_FILE, DETECTOR_URL], [RECOGNIZER_FILE, RECOGNIZER_URL]]) {
    if (!existsSync(join(MODEL_DIR, file))) {
      console.error(`Missing ${join(MODEL_DIR, file)}.\nDownload it with:\n  mkdir -p ${MODEL_DIR} && curl -L -o ${join(MODEL_DIR, file)} ${url}`);
      process.exit(1);
    }
  }
  const engine = await FaceEngine.create();
  const only = flag("--library");
  const limit = flag("--limit") ? Number(flag("--limit")) : Infinity;
  const libs = await db.select({ id: libraries.id, serverId: libraries.serverId, name: libraries.name }).from(libraries).where(and(eq(libraries.kind, "photos"), ...(only ? [eq(libraries.id, only)] : [])));
  let total = 0;
  for (const lib of libs) {
    const provider = createStorageForServer(lib.serverId);
    const rows = await db
      .select({ id: titles.id, fileId: mediaFiles.boxFileId, size: mediaFiles.sizeBytes, container: mediaFiles.container })
      .from(titles)
      .innerJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
      .where(and(eq(titles.libraryId, lib.id), eq(titles.kind, "photo"), ...(args.includes("--rescan") ? [] : [isNull(titles.facesScannedAt)])))
      .orderBy(desc(titles.takenAt), asc(titles.id))
      .limit(Number.isFinite(limit) ? Math.max(0, limit - total) : 1_000_000);
    let done = 0;
    let faces = 0;
    let skipped = 0;
    const one = async (r: (typeof rows)[number]) => {
      try {
        let bytes: Buffer | null = null;
        const preview = await provider.fetchPreview?.(r.fileId, { budgetMs: 25_000 }).catch(() => null);
        if (preview) bytes = Buffer.from(preview.bytes);
        else if (["jpg", "jpeg", "png", "webp"].includes((r.container ?? "").toLowerCase()) && (r.size ?? 0) <= MAX_ORIGINAL_BYTES) {
          const { url } = await provider.getStreamingUrl(r.fileId);
          const res = await fetch(url);
          if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
        }
        if (!bytes) {
          skipped++;
          return;
        }
        const found = await engine.analyze(bytes);
        await db.transaction(async (tx) => {
          await tx.delete(photoFaces).where(eq(photoFaces.titleId, r.id));
          if (found.length > 0) {
            await tx.insert(photoFaces).values(found.map((f) => ({ titleId: r.id, x: f.x, y: f.y, w: f.w, h: f.h, score: f.score, embedding: toBytes(f.embedding), thumb: f.thumb })));
          }
          await tx.update(titles).set({ facesScannedAt: new Date() }).where(eq(titles.id, r.id));
        });
        faces += found.length;
      } catch (err) {
        skipped++;
        console.error(`  ${r.fileId}: ${(err as Error).message}`);
      }
    };
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(one));
      done = Math.min(rows.length, i + CONCURRENCY);
      if (done % 60 < CONCURRENCY) console.log(`  ${lib.name}: ${done}/${rows.length} pictures, ${faces} faces`);
    }
    total += rows.length;
    console.log(`${lib.name}: ${rows.length - skipped} searched, ${faces} faces found, ${skipped} skipped.`);
    const suggested = await refreshSuggestions(db, lib.serverId);
    console.log(`  ${suggested} faces now have a suggested name.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
