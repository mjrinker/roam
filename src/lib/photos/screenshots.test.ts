import { describe, expect, it } from "vitest";
import { detectScreenshot, isScreenSize, looksLikeScreenshotName } from "./screenshots";

describe("a screenshot's name", () => {
  it("is recognised in the forms phones and computers write, in several languages", () => {
    for (const n of [
      "Screenshot_2019-03-14-14-25-30.png",
      "Screenshot 2019-03-14 at 14.25.30.png",
      "Screen Shot 2019-03-14 at 2.25.30 PM.png",
      "Screenshot (12).png",
      "screenshot.PNG",
      "Screenshot_20190314-142530_Chrome.jpg",
      "Screen Capture.png",
      "Capture d’écran 2019-03-14 à 14.25.30.png",
      "Bildschirmfoto 2019-03-14 um 14.25.30.png",
      "Captura de pantalla 2019-03-14.png",
      "スクリーンショット 2019-03-14.png",
    ]) expect(looksLikeScreenshotName(n), n).toBe(true);
  });
  it("is not claimed by names that merely resemble", () => {
    for (const n of ["IMG_1234.jpg", "Screenplay notes.jpg", "My screenshots trip.jpg", "Beach.png", "screens.jpg", "Photo of a screen.jpg"]) expect(looksLikeScreenshotName(n), n).toBe(false);
  });
});

describe("a screen's size", () => {
  it("matches phones, tablets and laptops in either turn, and not a camera's", () => {
    expect(isScreenSize(1170, 2532)).toBe(true);
    expect(isScreenSize(2532, 1170)).toBe(true);
    expect(isScreenSize(1179, 2556)).toBe(true);
    expect(isScreenSize(2880, 1800)).toBe(true);
    expect(isScreenSize(4032, 3024)).toBe(false);
    expect(isScreenSize(null, 1000)).toBe(false);
  });
});

describe("detecting a screenshot", () => {
  const base = { filename: "IMG_1234.PNG", container: "png", width: 1170, height: 2532, hasCameraDate: false };
  it("a PNG with no camera date and a screen's size is one (an iPhone's IMG_1234.PNG)", () => {
    expect(detectScreenshot(base)).toBe(true);
  });
  it("a name or the iPhone's note is enough, whatever the type and size", () => {
    expect(detectScreenshot({ ...base, filename: "Screenshot_1.jpg", container: "jpg", width: 4000, height: 3000, hasCameraDate: true })).toBe(true);
    expect(detectScreenshot({ ...base, filename: "IMG_9.HEIC", container: "heic", width: 1170, height: 2532, hasCameraDate: true, commentSaysScreenshot: true })).toBe(true);
  });
  it("photos are left alone: a camera JPEG, a PNG with a camera date, a PNG of another size", () => {
    expect(detectScreenshot({ filename: "IMG_1234.JPG", container: "jpg", width: 3024, height: 4032, hasCameraDate: true })).toBe(false);
    expect(detectScreenshot({ ...base, hasCameraDate: true })).toBe(false);
    expect(detectScreenshot({ ...base, width: 1000, height: 700 })).toBe(false);
    expect(detectScreenshot({ ...base, container: "jpg", filename: "IMG_1.JPG" })).toBe(false);
    expect(detectScreenshot({ ...base, width: null, height: null })).toBe(false);
  });
});
