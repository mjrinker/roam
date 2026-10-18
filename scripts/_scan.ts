import { scanLibrary } from "@/lib/scan/scanner";
(async () => {
  for (let i = 0; i < 60; i++) {
    const r = await scanLibrary("758bfe1f-0068-4810-844f-52247badc074", i === 0 ? "manual" : "resume", 0);
    console.log(i, JSON.stringify({ seen: r.filesSeen, added: r.titlesAdded, errors: r.errors.length, incomplete: r.incomplete }));
    if (!r.incomplete) break;
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
