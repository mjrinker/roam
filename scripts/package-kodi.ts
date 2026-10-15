/**
 * Writes the Kodi add-on into dist/kodi/plugin.video.roam-<version>.zip, ready to install in Kodi ("Install from zip file").
 *
 *   npx tsx scripts/package-kodi.ts --url https://your-roam.example [--version 1.0.0]
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeZip } from "@/lib/ebooks/zip-writer";
import { ADDON_ID, addonXmlFor, settingsXmlFor, siteOrigin } from "@/kodi/packaging";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir)) {
    const p = path.join(dir, e);
    if (e === "__pycache__") continue;
    if ((await stat(p)).isDirectory()) out.push(...(await files(p)));
    else if (!e.endsWith(".pyc")) out.push(p);
  }
  return out;
}

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
  const root = path.join("kodi", ADDON_ID);
  const entries: { name: string; data: string | Uint8Array; store?: boolean }[] = [];
  for (const file of await files(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const name = `${ADDON_ID}/${rel}`;
    if (rel === "addon.xml") entries.push({ name, data: addonXmlFor(await readFile(file, "utf8"), version) });
    else if (rel === "resources/settings.xml") entries.push({ name, data: settingsXmlFor(await readFile(file, "utf8"), origin) });
    else entries.push({ name, data: await readFile(file) });
  }
  entries.push({ name: `${ADDON_ID}/resources/icon.png`, data: await picture(256, 256, "png"), store: true });
  entries.push({ name: `${ADDON_ID}/resources/fanart.jpg`, data: await picture(1920, 1080, "jpg"), store: true });
  const out = path.join("dist", "kodi");
  await mkdir(out, { recursive: true });
  const file = path.join(out, `${ADDON_ID}-${version}.zip`);
  await writeFile(file, writeZip(entries));
  console.log(`Wrote ${file} for ${origin}. Next steps: kodi/README.md`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
