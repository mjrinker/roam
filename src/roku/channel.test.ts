/** The Roku channel (roku/) compiles with no errors: BrightScript can't be run here, so this is the guard against typos and reserved words. */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { ProgramBuilder } from "brighterscript";

describe("the Roku channel", () => {
  it("compiles with no errors or warnings", async () => {
    const builder = new ProgramBuilder();
    await builder.run({ project: "roku/bsconfig.json", createPackage: false, copyToStaging: false, logLevel: "error" });
    const diagnostics = builder.getDiagnostics().map((d) => `${d.file?.srcPath?.split("/roku/")[1] ?? "?"}:${(d.range?.start.line ?? 0) + 1} ${d.message}`);
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it("has every script and component the XML files name", () => {
    const xml = readdirSync("roku/components").filter((f) => f.endsWith(".xml"));
    expect(xml.length).toBeGreaterThan(8);
    for (const f of xml) {
      const text = readFileSync(`roku/components/${f}`, "utf8");
      for (const m of text.matchAll(/uri="pkg:\/([^"]+)"/g)) expect(() => readFileSync(`roku/${m[1]}`), `${f} names ${m[1]}`).not.toThrow();
    }
  });

  it("names the screens the scene opens, and each answers to the scene's calls", () => {
    const scene = readFileSync("roku/components/RoamScene.brs", "utf8");
    for (const name of [...scene.matchAll(/(?:show|resetTo)\("(\w+)"/g)].map((m) => m[1])) {
      const xml = readFileSync(`roku/components/${name}.xml`, "utf8");
      expect(xml, name).toContain('name="activate"');
      expect(xml, name).toContain('id="params"');
      expect(xml, name).toContain('id="route"');
    }
  });

  it("never sends a request without going through the one task that adds the token", () => {
    for (const f of readdirSync("roku/components").filter((n) => n.endsWith(".brs"))) {
      if (f === "ApiTask.brs") continue;
      expect(readFileSync(`roku/components/${f}`, "utf8"), f).not.toContain("roUrlTransfer");
    }
  });
});
