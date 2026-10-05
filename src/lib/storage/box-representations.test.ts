import { describe, expect, it } from "vitest";
import { isBoxHost, isJpeg, planRepresentation, readCapped } from "./box-representations";

describe("isBoxHost", () => {
  it("accepts Box's own hosts over https", () => {
    for (const u of ["https://api.box.com/2.0/files/1", "https://dl.boxcloud.com/x?y=1", "https://public.boxcloud.com/a", "https://box.com/x", "https://BOXCLOUD.COM/x"]) expect(isBoxHost(u), u).toBe(true);
  });
  it("refuses look-alikes, other schemes, userinfo tricks and junk", () => {
    for (const u of ["http://api.box.com/x", "https://box.com.evil.com/x", "https://evilbox.com/x", "https://notboxcloud.com/x", "https://box.com@evil.com/x", "https://user:pw@api.box.com/x", "ftp://api.box.com/x", "//api.box.com/x", "javascript:alert(1)", "", "not a url", "https://127.0.0.1/x", "https://api.box.com.attacker.net/"]) {
      expect(isBoxHost(u), u).toBe(false);
    }
  });
});

describe("planRepresentation", () => {
  const ready = { status: { state: "success" }, content: { urlTemplate: "https://dl.boxcloud.com/api/2.0/internal_files/1/versions/2/representations/jpg_2048x2048/content/{+asset_path}" }, info: { url: "https://api.box.com/2.0/internal_files/1/versions/2/representations/jpg_2048x2048" } };

  it("fetches a ready representation, with the asset path emptied", () => {
    expect(planRepresentation(ready)).toEqual({ action: "fetch", url: "https://dl.boxcloud.com/api/2.0/internal_files/1/versions/2/representations/jpg_2048x2048/content/" });
  });
  it("triggers generation through the info URL when the state is none, and waits while pending", () => {
    expect(planRepresentation({ ...ready, status: { state: "none" } })).toEqual({ action: "trigger", url: ready.info.url });
    expect(planRepresentation({ ...ready, status: { state: "pending" } })).toEqual({ action: "wait" });
  });
  it("gives up on a missing entry, an error state, an unknown state, or a URL that isn't Box's (never sending credentials there)", () => {
    expect(planRepresentation(undefined)).toEqual({ action: "none" });
    expect(planRepresentation({ ...ready, status: { state: "error" } })).toEqual({ action: "none" });
    expect(planRepresentation({ ...ready, status: undefined })).toEqual({ action: "none" });
    expect(planRepresentation({ ...ready, content: { urlTemplate: "https://evil.example/{+asset_path}" } })).toEqual({ action: "none" });
    expect(planRepresentation({ ...ready, content: { urlTemplate: "http://dl.boxcloud.com/{+asset_path}" } })).toEqual({ action: "none" });
    expect(planRepresentation({ ...ready, content: {} })).toEqual({ action: "none" });
    expect(planRepresentation({ ...ready, status: { state: "none" }, info: { url: "https://evil.example/info" } })).toEqual({ action: "none" });
    expect(planRepresentation({ ...ready, status: { state: "none" }, info: {} })).toEqual({ action: "none" });
  });
});

describe("isJpeg / readCapped", () => {
  it("recognises JPEG bytes only", () => {
    expect(isJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    for (const b of [[], [0xff, 0xd8], [0x89, 0x50, 0x4e, 0x47], [0x47, 0x49, 0x46, 0x38]]) expect(isJpeg(Uint8Array.from(b))).toBe(false);
  });
  async function* chunks(...sizes: number[]) {
    for (const n of sizes) yield new Uint8Array(n).fill(7);
  }
  it("joins chunks within the cap, and gives up the moment the cap is crossed", async () => {
    expect((await readCapped(chunks(3, 4, 5), 12))?.length).toBe(12);
    expect(await readCapped(chunks(3, 4, 6), 12)).toBeNull();
    expect((await readCapped(chunks(), 12))?.length).toBe(0);
  });
  it("stops reading once over the cap instead of draining the rest", async () => {
    let produced = 0;
    async function* endless() {
      for (;;) {
        produced++;
        yield new Uint8Array(1000);
      }
    }
    expect(await readCapped(endless(), 5000)).toBeNull();
    expect(produced).toBeLessThan(10);
  });
});
