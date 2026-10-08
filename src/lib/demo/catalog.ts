/**
 * What the public demo server holds. Its movies and shows carry real, TMDB-matchable names (so posters,
 * descriptions and ratings come from TMDB as on any server), but every file is placeholder footage cut from a
 * few openly licensed short films. This module is the single source of truth for that: which clips exist, how
 * they are credited, and which file plays which clip. The seeding script (scripts/seed-demo-media.ts) builds the
 * media from it, and the credits page lists it. Pure data and planning, so it can be tested.
 *
 * Licences below are the ones the Blender Foundation publishes for these films; check each film's own page
 * (sourceUrl) before publishing a demo.
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
    credit: "© Blender Foundation | peach.blender.org",
    sourceUrl: "https://peach.blender.org/",
    license: "Creative Commons Attribution 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    filePattern: "big.?buck.?bunny|bbb",
    durationSeconds: 596,
  },
  {
    id: "sintel",
    title: "Sintel",
    credit: "© Blender Foundation | durian.blender.org",
    sourceUrl: "https://durian.blender.org/",
    license: "Creative Commons Attribution 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    filePattern: "sintel",
    durationSeconds: 888,
  },
  {
    id: "tos",
    title: "Tears of Steel",
    credit: "(CC) Blender Foundation | mango.blender.org",
    sourceUrl: "https://mango.blender.org/",
    license: "Creative Commons Attribution 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    filePattern: "tears.?of.?steel|tos",
    durationSeconds: 734,
  },
  {
    id: "ed",
    title: "Elephants Dream",
    credit: "© Blender Foundation / Netherlands Media Art Institute | orange.blender.org",
    sourceUrl: "https://orange.blender.org/",
    license: "Creative Commons Attribution 2.5",
    licenseUrl: "https://creativecommons.org/licenses/by/2.5/",
    filePattern: "elephants.?dream",
    durationSeconds: 653,
  },
];

export const CLIP_SECONDS = 90;
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

/**
 * Lays out every demo file in the Plex-style names Roam scans, assigning each a clip: the sources in turn, each
 * source cut into non-overlapping 90-second pieces, so no two files show the same footage.
 */
export function planDemoMedia(sources: DemoSource[] = DEMO_SOURCES): PlannedFile[] {
  const cursor = new Map<string, number>(sources.map((s) => [s.id, CLIP_START_MARGIN]));
  let turn = 0;
  const nextClip = () => {
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

/** The credits for the footage, with the files that play each clip. */
export function demoCredits(plan: PlannedFile[] = planDemoMedia(), sources: DemoSource[] = DEMO_SOURCES) {
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
