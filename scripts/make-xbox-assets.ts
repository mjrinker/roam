/** Draws the Xbox app's pictures (its tile, logo and splash) from the Roam wordmark: npx tsx scripts/make-xbox-assets.ts */
import { readFile, writeFile } from "node:fs/promises";

async function main() {
  const sharp = (await import("sharp")).default;
  const svg = await readFile("public/roam-logo.svg");
  const make = async (name: string, width: number, height: number, logoFraction = 0.6) => {
    const logo = await sharp(svg, { density: 300 }).resize({ width: Math.round(width * logoFraction), height: Math.round(height * 0.6), fit: "inside" }).png().toBuffer();
    const png = await sharp({ create: { width, height, channels: 4, background: "#0b0b10" } }).composite([{ input: logo, gravity: "center" }]).png().toBuffer();
    await writeFile(`xbox/Roam.Xbox/Assets/${name}.png`, png);
  };
  await make("StoreLogo", 50, 50, 0.8);
  await make("Square44x44Logo", 44, 44, 0.8);
  await make("Square71x71Logo", 71, 71, 0.8);
  await make("Square150x150Logo", 150, 150, 0.8);
  await make("Square310x310Logo", 310, 310, 0.8);
  await make("Wide310x150Logo", 310, 150, 0.5);
  await make("SplashScreen", 620, 300, 0.5);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
