import { describe, expect, it } from "vitest";
import { viewerItem, type ViewerSource } from "./viewer-item";

const base: ViewerSource = {
  id: "p1", kind: "photo", name: "Beach", takenAt: "2024-03-30T10:00:00.000Z", width: 4000, height: 3000, posterUrl: "/api/photos/p1/thumb?v=1",
  runtimeSeconds: null, favorite: true, filename: "IMG_0001.JPG", sizeBytes: 3_453_641, container: "jpg", folderPath: "Trip/Day 1",
};

describe("viewerItem", () => {
  it("builds the urls, the thumbnail and the details rows for a picture", () => {
    const v = viewerItem(base);
    expect(v).toMatchObject({ id: "p1", kind: "photo", thumbUrl: "/api/photos/p1/thumb?v=1", previewUrl: "/api/photos/p1/preview", originalUrl: "/api/photos/p1/original", favorite: true, zoomOriginal: true });
    expect(v.details).toEqual([["Taken", "March 30, 2024 at 10:00 AM"], ["Size", "4000 × 3000"], ["File", "IMG_0001.JPG"], ["File size", "3.3 MB"], ["Album", "Trip/Day 1"]]);
  });
  it("shows a video's length and never offers the original for zooming", () => {
    const v = viewerItem({ ...base, kind: "movie", runtimeSeconds: 125, container: "mov" });
    expect(v.details.find(([l]) => l === "Length")).toBeDefined();
    expect(v.zoomOriginal).toBe(false);
  });
  it("only offers the full-size file for formats a browser shows, never HEIC", () => {
    for (const [c, ok] of [["jpg", true], ["JPEG", true], ["png", true], ["webp", true], ["heic", false], ["gif", false], [null, false]] as const) {
      expect(viewerItem({ ...base, container: c }).zoomOriginal, String(c)).toBe(ok);
    }
  });
  it("leaves out what it doesn't know", () => {
    const v = viewerItem({ ...base, takenAt: null, width: null, height: null, filename: null, sizeBytes: null, folderPath: "" });
    expect(v.details).toEqual([]);
    expect(viewerItem({ ...base, takenAt: "garbage" }).details.find(([l]) => l === "Taken")).toBeUndefined();
  });
});
