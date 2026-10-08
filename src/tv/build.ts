/** Compiles the TV pages' script for Chromium 56 (Samsung 2018), the oldest web engine the TV interface supports. */
import { build } from "esbuild";
import path from "node:path";

export const TV_ENGINE_TARGET = "chrome56";

export async function buildTvScript(root = process.cwd()): Promise<string> {
  const result = await build({
    entryPoints: [path.join(root, "src/tv/client/tv.ts")],
    bundle: true,
    minify: true,
    target: [TV_ENGINE_TARGET],
    format: "iife",
    write: false,
    legalComments: "none",
    alias: { "@": path.join(root, "src") },
  });
  return result.outputFiles[0].text;
}
