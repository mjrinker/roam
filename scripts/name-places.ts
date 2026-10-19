/**
 * Gives pictures that have a GPS position but no place name a name like "Lake Tahoe, California", so the library search can find them by place.
 * Each position is looked up on OpenStreetMap's Nominatim service, one request a second as its usage policy asks, and positions within about
 * 100 metres share one lookup. This SENDS THOSE COORDINATES to OpenStreetMap. A name set by hand is never replaced.
 *
 *   npx tsx --env-file=.env.local scripts/name-places.ts [--library <libraryId>] [--dry-run]
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { placeNameFrom } from "@/lib/photos/place-name";

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dry = args.includes("--dry-run");
  const library = flag("--library");
  const rows = await db
    .select({ id: titles.id, lat: titles.latitude, lon: titles.longitude })
    .from(titles)
    .where(and(eq(titles.kind, "photo"), isNotNull(titles.latitude), isNotNull(titles.longitude), isNull(titles.placeName), eq(titles.placeSource, "exif"), ...(library ? [eq(titles.libraryId, library)] : [])));
  const cells = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.lat!.toFixed(3)},${r.lon!.toFixed(3)}`;
    cells.set(key, [...(cells.get(key) ?? []), r]);
  }
  console.log(`${rows.length} pictures with a position and no name, ${cells.size} distinct places to look up.`);
  let named = 0;
  let done = 0;
  for (const [key, group] of cells) {
    const [lat, lon] = key.split(",");
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=en&lat=${lat}&lon=${lon}`, {
      headers: { "User-Agent": "Roam/1.0 (self-hosted media server)", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (res?.ok) {
      const name = placeNameFrom(await res.json().catch(() => null));
      if (name) {
        named += group.length;
        console.log(`  ${key} -> ${name} (${group.length})`);
        if (!dry) for (const r of group) await db.update(titles).set({ placeName: name }).where(and(eq(titles.id, r.id), isNull(titles.placeName), eq(titles.placeSource, "exif")));
      }
    } else if (res?.status === 429) {
      console.error("OpenStreetMap asked us to slow down; stopping. Run again later to carry on.");
      break;
    }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${cells.size} places looked up`);
    await sleep(1100);
  }
  console.log(`${named} pictures named${dry ? " (dry run, nothing saved)" : ""}.`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
