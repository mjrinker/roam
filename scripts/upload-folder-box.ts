/**
 * Uploads a local folder of finished files into a movie's own folder in a library's Box folder, through Roam's stored Box connection
 * (the way make-versions-box.ts does): makes the folder if it isn't there, skips files already in it, and retries a failed upload.
 * It does not register anything in Roam's database; the library's next scan (or Resync) picks the files up.
 *
 *   npx tsx --env-file=.env.local scripts/upload-folder-box.ts --library Movies --dir ~/staging/david/final/"David (2025)" --dry-run
 *
 * Options: --library <name>   the library (by name) whose Box folder gets the movie's folder
 *          --library-id <id>  or by id, when several libraries share a name
 *          --dir <folder>     the local folder; its name is the Box folder's name unless --folder-name is given
 *          --folder-name <n>  e.g. "David (2025) {tmdb-1167307}"
 *          --dry-run          say what would be uploaded, change nothing
 *
 * A file already in Box under the same name and size is left alone; one with a different size is replaced (a new version of the same file).
 */
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { ensureFreshAccessToken, withBoxClient } from "@/lib/storage/box-token-storage";
import { uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const dryRun = args.includes("--dry-run");
const libraryName = flag("--library");
const libraryId = flag("--library-id");
const dir = flag("--dir");
const folderName = flag("--folder-name") ?? (dir ? basename(dir) : "");
const GIB = 1024 ** 3;

function tokenProvider(serverId: string): TokenProvider {
  return (force) =>
    withBoxClient(serverId, async (client) => {
      if (!force) await ensureFreshAccessToken(client, serverId);
      const token = force ? await client.auth.refreshToken() : await client.auth.retrieveToken();
      if (!token.accessToken) throw new Error("Box returned no access token");
      return token.accessToken;
    });
}

(async () => {
  if (!libraryName || !dir) throw new Error("usage: upload-folder-box.ts --library <name> --dir <folder> [--folder-name <n>] [--dry-run]");
  const libs = (await db.select().from(libraries)).filter((l) => (libraryId ? l.id === libraryId : l.name.toLowerCase() === libraryName.toLowerCase()));
  if (libs.length !== 1) throw new Error(`expected one library named "${libraryName}", found ${libs.length}: ${libs.map((l) => l.id).join(", ")}`);
  const lib = libs[0];
  const provider = createBoxProviderForServer(lib.serverId);
  const top = await provider.listFolder(lib.boxFolderId);
  console.log(`library "${lib.name}" (${lib.kind}), ${top.filter((e) => e.kind === "folder").length} folders; e.g. ${top.filter((e) => e.kind === "folder").slice(0, 5).map((e) => e.name).join(" | ")}`);
  let folder = top.find((e) => e.kind === "folder" && e.name === folderName);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mp4")).sort();
  const sizes = new Map<string, number>();
  for (const f of files) sizes.set(f, (await stat(join(dir, f))).size);
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  console.log(`${files.length} files, ${(total / GIB).toFixed(1)} GiB, into "${folderName}" (${folder ? "exists" : "to be made"})`);
  const tooBig = files.filter((f) => sizes.get(f)! >= 2 * GIB);
  if (tooBig.length) throw new Error(`these are 2 GiB or more, which Box refuses: ${tooBig.join(", ")}`);
  if (dryRun) {
    for (const f of files) console.log(`  ${f}  ${(sizes.get(f)! / GIB).toFixed(2)} GiB`);
    return;
  }
  if (!folder) {
    const made = await withBoxClient(lib.serverId, (client) => client.folders.createFolder({ name: folderName, parent: { id: lib.boxFolderId } }));
    folder = { id: made.id, name: folderName, kind: "folder" };
    console.log(`made folder "${folderName}" (${made.id})`);
  }
  const have = new Map((await provider.listFolder(folder.id)).filter((e) => e.kind === "file").map((e) => [e.name, { id: e.id, size: e.sizeBytes ?? -1 }]));
  const getToken = tokenProvider(lib.serverId);
  let done = 0;
  for (const f of files) {
    done++;
    const there = have.get(f);
    if (there?.size === sizes.get(f)) {
      console.log(`[${done}/${files.length}] ${f}: already there`);
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        console.log(`[${done}/${files.length}] uploading ${f} (${(sizes.get(f)! / GIB).toFixed(2)} GiB)`);
        // A file already there with another size is replaced by a new version of it (same Box file, so anything keyed on it keeps working).
        if (there) console.log(`   replacing the copy in Box (${there.size} bytes)`);
        const r = await uploadFile({ getToken, folderId: folder.id, name: f, filePath: join(dir, f), replaceFileId: there?.id });
        if ("conflictId" in r) console.warn(`   ${f} is in Box already with other contents; left alone`);
        break;
      } catch (e) {
        if (attempt >= 6) throw e;
        const wait = Math.min(30 * attempt, 120);
        console.warn(`   attempt ${attempt} failed (${(e as Error).message.split("\n")[0]}); retrying in ${wait}s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
  }
  console.log("all uploaded");
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
