/**
 * Telling a screenshot from a photo, so a profile can hide them. Three signs, any of which is enough:
 *  - the file's name (every phone and computer names them alike: "Screenshot_2019-03-14-14-25-30.png", "Screen Shot 2019-03-14 at 2.25.30 PM.png",
 *    "Screenshot (12).png", "Screenshot 2019-03-14 142530.png", "Capture d'écran ...", "Bildschirmfoto ...", "スクリーンショット ...");
 *  - the picture's own note: iPhones write "Screenshot" in the EXIF user comment of the screenshots they make;
 *  - a PNG with no camera date whose size is exactly a phone's, tablet's or laptop's screen (an iPhone's screenshot is a PNG called IMG_1234.PNG, and
 *    nothing in its name says what it is). A camera does not make PNGs, and a screen that size is what a screenshot of it is.
 * Pure: nothing here touches the network or the database.
 */

const NAME_PATTERNS: RegExp[] = [
  /^screen[\s_-]?shots?\b/i,
  /^screenshots?[\s_(-]/i,
  /^screen[\s_-]?capture\b/i,
  /^capture d['’]?[ée]cran\b/i,
  /^bildschirmfoto\b/i,
  /^bildschirmaufnahme\b/i,
  /^captura de pantalla\b/i,
  /^captura de tela\b/i,
  /^schermafbeelding\b/i,
  /^schermata\b/i,
  /^skärmbild\b/i,
  /^skjermbilde\b/i,
  /^スクリーンショット/,
  /^截屏/,
  /^屏幕截图/,
  /^스크린샷/,
  /^снимок экрана\b/i,
];

export function looksLikeScreenshotName(fileName: string): boolean {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  return NAME_PATTERNS.some((p) => p.test(base));
}

/** Pixel sizes (portrait, as width x height) of the screens screenshots are taken on: iPhones, iPads, Android phones, Macs. */
const SCREENS: [number, number][] = [
  // iPhone
  [640, 1136], [750, 1334], [828, 1792], [1080, 1920], [1125, 2436], [1170, 2532], [1179, 2556], [1206, 2622], [1242, 2208], [1242, 2688], [1284, 2778], [1290, 2796], [1320, 2868], [1080, 2340],
  // iPad
  [1536, 2048], [1620, 2160], [1640, 2360], [1668, 2224], [1668, 2388], [2048, 2732], [2064, 2752], [1488, 2266], [1640, 2360],
  // Android phones
  [720, 1280], [720, 1440], [720, 1520], [720, 1560], [1080, 2160], [1080, 2220], [1080, 2280], [1080, 2310], [1080, 2400], [1080, 2408], [1080, 2412], [1080, 2460], [1440, 2560], [1440, 2960], [1440, 3040], [1440, 3088], [1440, 3120], [1440, 3200], [1344, 2992],
  // Computers
  [1280, 800], [1440, 900], [1680, 1050], [1920, 1080], [1920, 1200], [2560, 1440], [2560, 1600], [2880, 1800], [3024, 1964], [3456, 2234], [3840, 2160], [2304, 1440], [2560, 1664],
];
const SCREEN_KEYS = new Set(SCREENS.flatMap(([w, h]) => [`${w}x${h}`, `${h}x${w}`]));

export const isScreenSize = (width: number | null | undefined, height: number | null | undefined): boolean => !!width && !!height && SCREEN_KEYS.has(`${width}x${height}`);

export interface ScreenshotEvidence {
  filename: string;
  container: string | null;
  width: number | null;
  height: number | null;
  /** The picture carries a camera date (EXIF). */
  hasCameraDate: boolean;
  /** The EXIF user comment says "Screenshot" (what iPhones write). */
  commentSaysScreenshot?: boolean;
}

export function detectScreenshot(e: ScreenshotEvidence): boolean {
  if (looksLikeScreenshotName(e.filename) || e.commentSaysScreenshot) return true;
  return (e.container ?? e.filename.split(".").pop() ?? "").toLowerCase() === "png" && !e.hasCameraDate && isScreenSize(e.width, e.height);
}
