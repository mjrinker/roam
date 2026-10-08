// Writes the TV pages' script to public/tv/tv.js (generated, not committed). Run before `next dev` and `next build`.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildTvScript } from "../src/tv/build";

async function main() {
  const code = await buildTvScript();
  await mkdir(path.join(process.cwd(), "public/tv"), { recursive: true });
  await writeFile(path.join(process.cwd(), "public/tv/tv.js"), code);
  console.log(`public/tv/tv.js written (${code.length} bytes)`);
}
main();
