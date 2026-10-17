/**
 * Finds the opening titles and closing credits of the episodes you already have by comparing their sound: the first minutes of every episode of a
 * season are listened to (ffmpeg reads just that stretch of each file from your storage), and the stretch they keep sharing is the intro; the same
 * with the end for the credits. The times are kept in Roam and used for the Skip intro and Next episode buttons only where neither a time marked by
 * hand nor SkipDB's has one. Nothing is changed in your storage and no audio is kept: only the times.
 *
 *   npx tsx --env-file=.env.local scripts/detect-intros.ts --dry-run          (the seasons it would do)
 *   npx tsx --env-file=.env.local scripts/detect-intros.ts --show "Psych" --season 2
 *   npx tsx --env-file=.env.local scripts/detect-intros.ts --limit 3
 *
 * Options: --show NAME (part of a title)  --season N  --limit N (seasons; default 5)  --kinds intro,outro (default both)
 *          --force (do seasons again)  --references N (episodes each is compared with; default 6)  --concurrency N (files read at once; default 3)
 * Each episode reads about the first eight and the last seven minutes of its file, so a season of 25 episodes downloads on the order of a few GB.
 * A season needs at least 3 episodes. Safe to re-run: seasons already done are skipped.
 */
import { db } from "@/lib/db/client";
import { ensureFfmpeg } from "@/lib/remux/tier1";
import { createStorageForServer } from "@/lib/storage/server-storage";
import { decodeAudio } from "@/lib/intro/extract";
import { startRangeProxy } from "@/lib/intro/proxy";
import { seasonsToDetect, saveDetected } from "@/lib/intro/queue";
import { detectSeasonMarks, type Listen } from "@/lib/intro/season";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

async function main() {
  const limit = Math.max(1, Number(arg("--limit") ?? 5));
  const seasonArg = arg("--season");
  const kinds = (arg("--kinds") ?? "intro,outro").split(",").filter((k): k is "intro" | "outro" => k === "intro" || k === "outro");
  if (kinds.length === 0) throw new Error("--kinds must be intro, outro, or intro,outro");
  const all = await seasonsToDetect(db, { show: arg("--show"), season: seasonArg === undefined ? undefined : Number(seasonArg), force: flag("--force") });
  const todo = all.filter((s) => s.episodes.length >= 3).slice(0, limit);
  console.log(`${all.length} seasons to do (${all.filter((s) => s.episodes.length < 3).length} too small to compare); doing ${todo.length}${flag("--dry-run") ? " (dry run)" : ""}.`);
  if (flag("--dry-run")) {
    for (const s of todo) console.log(`  ${s.showName} S${s.season}: ${s.episodes.length} episodes`);
    process.exit(0);
  }
  const ffmpeg = await ensureFfmpeg();

  for (const s of todo) {
    console.log(`\n${s.showName} S${s.season} (${s.episodes.length} episodes)`);
    const provider = createStorageForServer(s.serverId);
    const byId = new Map(s.episodes.map((e) => [e.id, e]));
    // ffmpeg is pointed at a small server on this computer that fetches the file from storage (the bundled ffmpeg crashes on https addresses).
    const proxy = await startRangeProxy(async (id) => (await provider.getStreamingUrl(byId.get(id)!.fileId)).url);
    let heard = 0;
    const listen: Listen = async (id, start, seconds) => {
      try {
        const pcm = await decodeAudio(ffmpeg, proxy.urlFor(id), start, seconds);
        if (pcm) heard++;
        return pcm;
      } catch (e) {
        console.log(`  ! could not listen to an episode: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    };
    const result = await detectSeasonMarks(s.episodes.map((e) => ({ id: e.id, durationSeconds: e.durationSeconds })), listen, { kinds, concurrency: Number(arg("--concurrency") ?? 3), references: Number(arg("--references") ?? 6) });
    await proxy.close();
    // Nothing could be heard at all (a storage problem, not a season without an opening): keep nothing, so the season is tried again.
    if (!result || heard === 0) {
      console.log("  Could not listen to any episode; nothing was saved.");
      continue;
    }
    let withIntro = 0;
    let withOutro = 0;
    for (const e of s.episodes) {
      const marks = result.get(e.id) ?? [];
      await saveDetected(db, e.id, marks);
      const intro = marks.find((m) => m.kind === "intro");
      const outro = marks.find((m) => m.kind === "outro");
      if (intro) withIntro++;
      if (outro) withOutro++;
      console.log(`  E${e.number}: ${[intro ? `intro ${mmss(intro.startSeconds)}-${mmss(intro.endSeconds)}` : null, outro ? `credits ${mmss(outro.startSeconds)}` : null].filter(Boolean).join(", ") || "nothing found"}`);
    }
    console.log(`  ${withIntro} of ${s.episodes.length} with an intro, ${withOutro} with credits (${heard} stretches heard)`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
