/**
 * What the public demo server holds. Its movies and shows carry real, TMDB-matchable names (so posters,
 * descriptions and ratings come from TMDB as on any server), but every file is placeholder footage cut from a
 * two openly licensed short films (Big Buck Bunny and Sintel, Creative Commons Attribution 3.0, confirmed on the films' own pages). This module is the single source of truth for that: which clips exist, how
 * they are credited, and which file plays which clip. The seeding script (scripts/seed-demo-media.ts) builds the
 * media from it, and the credits page lists it. Pure data and planning, so it can be tested.
 *
 * Tears of Steel and Elephants Dream are deliberately NOT used: Tears of Steel's soundtrack is published under a
 * NoDerivs licence, which cutting and re-encoding could conflict with, and Elephants Dream's full film isn't on the mirror
 * used to fetch the sources.
 */
export interface DemoSource {
  id: string;
  /** What the clip is cut from. */
  title: string;
  /** The credit the licence asks for. */
  credit: string;
  /** The film's own page (where the licence and downloads are published). */
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  /** Matches the downloaded file's name (case-insensitive). */
  filePattern: string;
  /** Length of the whole film, so clips are never cut past its end. */
  durationSeconds: number;
}

export const DEMO_SOURCES: DemoSource[] = [
  {
    id: "bbb",
    title: "Big Buck Bunny",
    credit: "© copyright 2008, Blender Foundation / www.bigbuckbunny.org",
    sourceUrl: "https://peach.blender.org/",
    license: "Creative Commons Attribution 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    filePattern: "big.?buck.?bunny|(^|[^a-z])bbb([^a-z]|$)",
    durationSeconds: 634,
  },
  {
    id: "sintel",
    title: "Sintel",
    credit: "© copyright Blender Foundation | durian.blender.org",
    sourceUrl: "https://durian.blender.org/",
    license: "Creative Commons Attribution 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    filePattern: "sintel",
    durationSeconds: 888,
  },
];

export const CLIP_SECONDS = 45;
/** Leave the opening and the closing credits of each film alone. */
const CLIP_START_MARGIN = 20;

export const DEMO_MOVIES: { name: string; year: number }[] = [
  { name: "The Matrix", year: 1999 },
  { name: "Inception", year: 2010 },
  { name: "The Godfather", year: 1972 },
  { name: "Pulp Fiction", year: 1994 },
  { name: "Jurassic Park", year: 1993 },
  { name: "Spirited Away", year: 2001 },
  { name: "The Dark Knight", year: 2008 },
  { name: "Back to the Future", year: 1985 },
  { name: "Toy Story", year: 1995 },
  { name: "Alien", year: 1979 },
  { name: "Forrest Gump", year: 1994 },
  { name: "The Lion King", year: 1994 },
];

export const DEMO_SHOWS: { name: string; year: number; episodes: { number: number; title: string }[] }[] = [
  {
    name: "Breaking Bad",
    year: 2008,
    episodes: [
      { number: 1, title: "Pilot" },
      { number: 2, title: "Cat's in the Bag" },
      { number: 3, title: "And the Bag's in the River" },
    ],
  },
  {
    name: "Friends",
    year: 1994,
    episodes: [
      { number: 1, title: "The One Where Monica Gets a Roommate" },
      { number: 2, title: "The One with the Sonogram at the End" },
      { number: 3, title: "The One with the Thumb" },
    ],
  },
];

export interface PlannedFile {
  /** Folders from the demo's root in Box, e.g. ["Movies", "The Matrix (1999)"]. */
  folders: string[];
  fileName: string;
  /** What it appears as on the server, for the credits ("The Matrix (1999)", "Breaking Bad S01E01"). */
  label: string;
  sourceId: string;
  startSeconds: number;
  durationSeconds: number;
}

/** A name safe to use as a Box file or folder name. */
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();

/** Hands out non-overlapping clips from the sources in turn, so no two files show the same footage. */
function clipAllocator(sources: DemoSource[]) {
  const cursor = new Map<string, number>(sources.map((s) => [s.id, CLIP_START_MARGIN]));
  let turn = 0;
  return () => {
    for (let tries = 0; tries < sources.length; tries++) {
      const source = sources[turn++ % sources.length];
      const start = cursor.get(source.id)!;
      if (start + CLIP_SECONDS <= source.durationSeconds - CLIP_START_MARGIN) {
        cursor.set(source.id, start + CLIP_SECONDS + 10);
        return { sourceId: source.id, startSeconds: start, durationSeconds: CLIP_SECONDS };
      }
    }
    throw new Error("The demo sources don't hold enough footage for every file.");
  };
}

function moviesAndShows(nextClip: ReturnType<typeof clipAllocator>): PlannedFile[] {
  const files: PlannedFile[] = [];
  for (const m of DEMO_MOVIES) {
    const base = safeName(`${m.name} (${m.year})`);
    files.push({ folders: ["Movies", base], fileName: `${base}.mp4`, label: base, ...nextClip() });
  }
  for (const show of DEMO_SHOWS) {
    const base = safeName(`${show.name} (${show.year})`);
    for (const ep of show.episodes) {
      const code = `S01E${String(ep.number).padStart(2, "0")}`;
      files.push({ folders: ["TV Shows", base, "Season 01"], fileName: `${code} - ${safeName(ep.title)}.mp4`, label: `${base} ${code}`, ...nextClip() });
    }
  }
  return files;
}

/** How many extra clips the generic video library and the photo library get (after the movies and shows have theirs). */
export const HOME_VIDEO_CLIPS = 4;
export const PHOTO_VIDEO_CLIPS = 2;

const clipTime = (seconds: number) => `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;

/**
 * Lays out every demo movie and episode in the Plex-style names Roam scans, assigning each a clip: the sources in
 * turn, each cut into non-overlapping 45-second pieces, so no two files show the same footage.
 */
export function planDemoMedia(sources: DemoSource[] = DEMO_SOURCES): PlannedFile[] {
  return moviesAndShows(clipAllocator(sources));
}

/**
 * The clips for the generic "Home Videos" library and for the photo library's videos, taken from the footage that is
 * left after the movies and shows. Generic libraries show file names as they are, so these are named honestly: for
 * what they are and where they are from, never as something else.
 */
export function planExtraVideos(sources: DemoSource[] = DEMO_SOURCES): { homeVideos: PlannedFile[]; photoVideos: PlannedFile[] } {
  const next = clipAllocator(sources);
  moviesAndShows(next); // skip past what the movies and shows use
  const make = (count: number, folderFor: (title: string) => string[]): PlannedFile[] =>
    Array.from({ length: count }, () => {
      const clip = next();
      const source = sources.find((s) => s.id === clip.sourceId)!;
      const name = safeName(`${source.title} - ${clipTime(clip.startSeconds)}`);
      return { folders: folderFor(source.title), fileName: `${name}.mp4`, label: name, ...clip };
    });
  return {
    homeVideos: make(HOME_VIDEO_CLIPS, (title) => [safeName(title)]),
    photoVideos: make(PHOTO_VIDEO_CLIPS, () => []),
  };
}

/** The credits for the footage, with the files that play each clip. */
export function demoCredits(plan: PlannedFile[] = [...planDemoMedia(), ...Object.values(planExtraVideos()).flat()], sources: DemoSource[] = DEMO_SOURCES) {
  return sources
    .map((s) => ({
      title: s.title,
      credit: s.credit,
      sourceUrl: s.sourceUrl,
      license: s.license,
      licenseUrl: s.licenseUrl,
      usedFor: plan.filter((f) => f.sourceId === s.id).map((f) => f.label),
    }))
    .filter((c) => c.usedFor.length > 0);
}
