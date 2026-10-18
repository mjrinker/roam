/**
 * Downloads chosen OpenSubtitles files to a folder as `<name>.<lang>.srt`, waiting out the account's daily download limit
 * (it resets at midnight UTC) instead of failing.
 *
 *   npx tsx --env-file=.env.local scripts/fetch-subs.ts --out ~/staging/david/subs --name "David (2025)" eng=11854320 spa=12673494
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenSubtitles, openSubtitlesConfig, OpenSubtitlesError } from "@/lib/subtitles/opensubtitles";

const args = process.argv.slice(2);
const flag = (n: string) => args[args.indexOf(n) + 1];
const out = flag("--out");
const name = flag("--name");
const picks = args.filter((a) => /^[a-z]{3}=\d+$/.test(a)).map((a) => a.split("=") as [string, string]);

(async () => {
  const config = openSubtitlesConfig();
  if (!config || !out || !name || picks.length === 0) throw new Error("usage: fetch-subs.ts --out <dir> --name <name> eng=<fileId> ...");
  const os = new OpenSubtitles(config);
  await mkdir(out, { recursive: true });
  for (const [lang, id] of picks) {
    const dest = join(out, `${name}.${lang}.srt`);
    while (!existsSync(dest)) {
      try {
        const d = await os.download(Number(id));
        await writeFile(dest, d.bytes);
        console.log(`${lang}: ${d.bytes.length} bytes, ${d.remaining} downloads left today`);
      } catch (e) {
        if (!(e instanceof OpenSubtitlesError) || (e.kind !== "quota" && e.kind !== "rate")) throw e;
        console.log(`[${new Date().toISOString()}] ${e.kind}: waiting 10 minutes`);
        await new Promise((r) => setTimeout(r, 10 * 60_000));
      }
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
