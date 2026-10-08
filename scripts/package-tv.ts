/**
 * Writes the TV app packages for Samsung (Tizen) and LG (webOS) into dist/tv. Each is a tiny "hosted" app that opens <your site>/tv.
 *
 *   npx tsx scripts/package-tv.ts --url https://your-roam.example [--version 1.0.0]
 *
 * The Tizen package still has to be SIGNED with your own Samsung certificate and the webOS one packed with ares-package; see tv/README.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeZip } from "@/lib/ebooks/zip-writer";
import { siteOrigin, tizenConfig, webosAppInfo, webosIndexHtml } from "@/tv/packaging";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** The Roam wordmark centred on the app's dark background, as a PNG of the given size. */
async function icon(size: number, width = size, height = size): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  const logo = await sharp(await readFile("public/roam-logo.svg"), { density: 300 }).resize({ width: Math.round(width * 0.72), fit: "inside" }).png().toBuffer();
  return new Uint8Array(await sharp({ create: { width, height, channels: 4, background: "#0b0b10" } }).composite([{ input: logo, gravity: "center" }]).png().toBuffer());
}

async function main() {
  const origin = siteOrigin(arg("--url"));
  if (!origin) throw new Error("Pass --url https://your-roam-site (https, no path).");
  const version = arg("--version") ?? "1.0.0";
  const out = path.join("dist", "tv");
  const tizen = path.join(out, "tizen");
  const webos = path.join(out, "webos");
  await mkdir(tizen, { recursive: true });
  await mkdir(webos, { recursive: true });

  const config = tizenConfig(origin, version);
  const tizenIcon = await icon(117);
  await writeFile(path.join(tizen, "config.xml"), config);
  await writeFile(path.join(tizen, "icon.png"), tizenIcon);
  // An unsigned package for reference; the TV only installs one signed with your certificate (tizen package -t wgt -s <profile>).
  await writeFile(path.join(tizen, "roam-unsigned.wgt"), writeZip([{ name: "config.xml", data: config }, { name: "icon.png", data: tizenIcon, store: true }]));

  await writeFile(path.join(webos, "appinfo.json"), webosAppInfo(version));
  await writeFile(path.join(webos, "index.html"), webosIndexHtml(origin));
  await writeFile(path.join(webos, "icon.png"), await icon(80));
  await writeFile(path.join(webos, "largeIcon.png"), await icon(130));

  console.log(`Wrote dist/tv/tizen and dist/tv/webos for ${origin} (version ${version}). Next steps: tv/README.md`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
