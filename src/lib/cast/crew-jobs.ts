/**
 * Which TMDB crew jobs are kept, in the order they are shown. TMDB lists hundreds of crew for a film; these are the ones worth a card.
 * "Writer", "Screenplay", "Story" and "Novel" all mean someone wrote it; a person with several shows them together.
 */
export const KEY_CREW_JOBS = [
  "Director",
  "Creator",
  "Screenplay",
  "Writer",
  "Story",
  "Novel",
  "Author",
  "Producer",
  "Executive Producer",
  "Original Music Composer",
  "Director of Photography",
  "Editor",
] as const;

/** How many people to keep for a job (a film can credit a dozen producers). */
export const CREW_LIMIT_PER_JOB: Record<string, number> = { Producer: 4, "Executive Producer": 4 };
export const CREW_LIMIT_DEFAULT = 6;

export const crewRank = (job: string): number => {
  const i = (KEY_CREW_JOBS as readonly string[]).indexOf(job);
  return i === -1 ? KEY_CREW_JOBS.length : i;
};

/** The label for a job on a card ("Original Music Composer" reads better as "Composer"). */
export const crewJobLabel = (job: string): string => (job === "Original Music Composer" ? "Composer" : job === "Director of Photography" ? "Cinematography" : job);
