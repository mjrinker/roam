import Link from "next/link";

/** Shown on every page of a public demo server: the videos, famous-artist albums and some eBooks are stand-ins, not the works they are filed under. */
export function DemoBanner({ serverId }: { serverId: string }) {
  return (
    <div role="note" className="border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-center text-xs leading-snug text-amber-100/90 sm:text-sm">
      <strong className="font-semibold">Demo server.</strong> Titles, posters and descriptions come from TMDB and MusicBrainz, but the videos, the albums by famous
      artists and some eBooks are <strong className="font-semibold">placeholder files</strong> (public-domain or openly licensed footage, audio and text), not the
      works named.{" "}
      <Link href={`/s/${serverId}/credits`} className="underline underline-offset-2 hover:text-amber-50">
        Credits
      </Link>
    </div>
  );
}
