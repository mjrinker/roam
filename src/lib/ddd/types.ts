/** What is kept from Does the Dog Die for one title: only what Roam uses (see service.ts). */

/** How many people said a topic does (yes) or does not (no) happen in the title. */
export interface DddStat {
  topicId: number;
  topicName: string;
  yes: number;
  no: number;
  comments: number;
}

/** One report with a moment in the title: where the thing starts and where it is safe to carry on (seconds from the start of the film or episode). */
export interface DddMoment {
  topicId: number;
  topicName: string;
  /** For a TV show: the season and episode the moment is in. -1 for a movie. */
  season: number;
  episode: number;
  startSeconds: number;
  safeSeconds: number;
}

export interface DddTitleData {
  /** Their name for the title, and whether it is a movie or a show. */
  name: string;
  kind: "movie" | "tv";
  /** The yes/no totals per topic; null until a page that shows them has asked (a play only needs the moments). */
  stats: DddStat[] | null;
  moments: DddMoment[];
}

/** Their list of topics (id and name), kept for naming the moments. */
export interface DddReference {
  topics: { id: number; name: string }[];
}
