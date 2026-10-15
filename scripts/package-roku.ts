/**
 * Writes the Roku channel into dist/roku/roam-roku.zip, ready to install on a Roku in developer mode.
 *
 *   npx tsx scripts/package-roku.ts --url https://your-roam.example [--version 1.0.0]
 *
 * Installing it: see roku/README.md (turn on developer mode on the Roku, open its address in a browser, upload the zip).
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeZip } from "@/lib/ebooks/zip-writer";
import { configBrs, manifestFor, siteOrigin } from "@/roku/packaging";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir)) {
    const p = path.join(dir, e);
    if ((await stat(p)).isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}

/** The Roam wordmark centred on the app's dark background. */
async function picture(width: number, height: number, format: "png" | "jpg"): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  const logo = await sharp(await readFile("public/roam-logo.svg"), { density: 300 }).resize({ width: Math.round(width * 0.6), fit: "inside" }).png().toBuffer();
  const base = sharp({ create: { width, height, channels: 4, background: "#0b0b10" } }).composite([{ input: logo, gravity: "center" }]);
  return new Uint8Array(await (format === "png" ? base.png() : base.flatten({ background: "#0b0b10" }).jpeg({ quality: 90 })).toBuffer());
}

async function main() {
  const origin = siteOrigin(arg("--url"));
  if (!origin) throw new Error("Pass --url https://your-roam-site (https, no path).");
  const version = arg("--version") ?? "1.0.0";
  const root = "roku";
  const entries: { name: string; data: string | Uint8Array; store?: boolean }[] = [];
  for (const file of await files(root)) {
    const name = path.relative(root, file).split(path.sep).join("/");
    if (name === "bsconfig.json" || name === "README.md" || name.startsWith("images/")) continue;
    if (name === "manifest") entries.push({ name, data: manifestFor(await readFile(file, "utf8"), version) });
    else if (name === "source/config.brs") entries.push({ name, data: configBrs(origin) });
    else entries.push({ name, data: await readFile(file) });
  }
  // The channel's pictures: its icon on the home screen (two sizes) and the splash screen.
  entries.push({ name: "images/icon-hd.png", data: await picture(336, 210, "png"), store: true });
  entries.push({ name: "images/icon-sd.png", data: await picture(246, 140, "png"), store: true });
  entries.push({ name: "images/splash-hd.jpg", data: await picture(1280, 720, "jpg"), store: true });
  const out = path.join("dist", "roku");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "roam-roku.zip"), writeZip(entries));
  console.log(`Wrote dist/roku/roam-roku.zip for ${origin} (version ${version}). Next steps: roku/README.md`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
