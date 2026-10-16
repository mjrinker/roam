import type { Metadata } from "next";
import { Bullets, Contact, LegalPage, Section } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Roam collects, how it is used, and how to have it removed.",
};

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">
    {children}
  </a>
);

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="October 12, 2026">
      <p>
        Roam is a private media server: a person (the <strong>server admin</strong>) connects their own cloud storage, chooses folders of movies, shows, music, books and photos, and invites family and friends to
        watch and listen. This policy explains what information Roam handles, why, who else receives any of it, and how to have it removed. Roam is operated by Matt Rinker as a personal project.
      </p>

      <Section title="Information we collect">
        <Bullets
          items={[
            <>
              <strong>Account.</strong> Your email address, and a sign-in method: an emailed link, a password, or Google sign-in (from which we receive your email address and basic profile).
            </>,
            <>
              <strong>Profiles and preferences.</strong> The profile names you create, and settings such as playback speed, age limits and which profile is shown on a server.
            </>,
            <>
              <strong>Activity.</strong> Where you stopped in each movie, episode, book or song, what you marked finished, and the playlists you make. This is what lets Roam resume where you left off.
            </>,
            <>
              <strong>What is in a library.</strong> For the folders an admin adds: file and folder names, sizes, durations, formats, and details read from the files themselves or looked up online (names, posters, descriptions, cast, tags, embedded cover art).
              Roam keeps this information, not copies of the media files themselves.
            </>,
            <>
              <strong>Storage sign-ins.</strong> To read an admin&apos;s storage, Roam keeps the access tokens that the storage provider (Box, Dropbox, OneDrive, Google Drive) issued, encrypted, and the connection&apos;s name and account email as shown to the admin. For an S3-style bucket
              it would keep the access keys, encrypted.
            </>,
            <>
              <strong>Technical data.</strong> Our hosting provider records ordinary request logs (such as IP address and browser type) to run and secure the service. Roam sets cookies only to keep you signed in. Preferences and offline downloads are stored in your own browser or device.
            </>,
          ]}
        />
      </Section>

      <Section title="Google user data">
        <p>
          Roam uses two Google features, and only if you choose to: <strong>signing in with Google</strong>, and a server admin&apos;s optional connection to their <strong>Google Drive</strong>. Roam&apos;s use and transfer of information received from Google APIs to any other app will
          adhere to the <A href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</A>, including the Limited Use requirements.
        </p>

        <h3 className="text-base font-semibold text-foreground">What Roam accesses</h3>
        <Bullets
          items={[
            <>
              <strong>Sign in with Google:</strong> your email address, name and profile picture, used only to create and identify your Roam account.
            </>,
            <>
              <strong>Google Drive</strong> (the <code className="rounded bg-white/10 px-1">drive.readonly</code> permission, which is read-only): the names, folder structure, sizes, types and modified dates of files and folders in the Drive; Google&apos;s thumbnails of files; and the contents of media files, read to learn
              their duration, format and tags and to play them back. The admin grants this for their own Drive and can remove it at any time.
            </>,
          ]}
        />

        <h3 className="text-base font-semibold text-foreground">How Roam uses it</h3>
        <Bullets
          items={[
            "Shows the admin their Drive folders so they can pick which ones to share, lists the files in the chosen folders, and streams those files to the people the admin invited, so they can play them. This is the only purpose.",
            "Roam's access is read-only: it never modifies, deletes, uploads, moves or shares anything in the Drive, and it only reads the folders an admin chooses (plus folder names while choosing). It does not scan the rest of the Drive.",
            "It is not used for advertising, is never sold, and is not used to develop, improve or train generalised AI or machine-learning models.",
          ]}
        />

        <h3 className="text-base font-semibold text-foreground">What Roam stores</h3>
        <Bullets
          items={[
            "The Google sign-in tokens, encrypted at rest, so Roam can keep reading the folders the admin chose without asking them to sign in each time.",
            "Library information drawn from the chosen folders: file and folder names, sizes, durations, formats, tags, and artwork (such as embedded album covers). Roam does not keep copies of the media files themselves; files are streamed from Google when played.",
            "If the admin turns on ownership tracking: which accounts own which movies, seasons or books, claims to own one (with any pictures sent as evidence, which only the admin can see and which are deleted when the claim is decided), who is playing what right now, and the notifications and, if you turn them on, the browser push address Roam uses to send them.",
          ]}
        />

        <h3 className="text-base font-semibold text-foreground">Who it is shared with</h3>
        <Bullets
          items={[
            "The people the admin invites to the server can play the media in the libraries they are given access to. No one else can reach it.",
            <>
              Roam&apos;s service providers process it only to run Roam, on Roam&apos;s behalf: Supabase (database and sign-in), Vercel (hosting) and, when set up, Cloudflare (a relay that passes streamed files through without storing them). They do not receive it for their own use.
            </>,
            "It is not sold or given to data brokers, advertisers or any other third party, except where the law requires.",
            "People at Roam do not read Google user data except with your consent, where needed to investigate abuse or a security problem, to comply with the law, or for internal operations needed to run the service, and then only what is needed.",
          ]}
        />

        <h3 className="text-base font-semibold text-foreground">Protecting it, keeping it, and removing it</h3>
        <Bullets
          items={[
            "Tokens are encrypted at rest, all traffic uses HTTPS, and access to every server and library is checked on each request.",
            "Google data is kept only while the connection, library or server exists. An admin can remove the Google Drive connection under Server settings, then Storage, which deletes the stored tokens straight away; deleting a library or server removes the library information Roam kept about it.",
            <>
              You can also remove Roam&apos;s access at any time at <A href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</A>. To have your Roam account and everything linked to it deleted, contact the operator below.
            </>,
          ]}
        />
      </Section>

      <Section title="How we use information">
        <Bullets
          items={[
            "To sign you in and keep your account and server memberships secure.",
            "To list, play and download the media an admin has shared with you, and to remember your place and playlists.",
            "To show posters, descriptions, cast and other details for what is in a library.",
            "To keep the service running, prevent abuse (for example, bots and excessive requests), and fix problems.",
          ]}
        />
        <p>We do not sell personal information and do not show advertising.</p>
      </Section>

      <Section title="Who else receives information">
        <p>Roam uses these services to work. Each receives only what its part needs:</p>
        <Bullets
          items={[
            <>
              <strong>Supabase</strong> (sign-in and the database) and <strong>Vercel</strong> (hosting) process account and library information on our behalf.
            </>,
            <>
              <strong>Cloudflare</strong> provides the bot check on sign-up and, if configured, a relay that streams Google Drive files to players without storing them.
            </>,
            <>
              <strong>Your storage provider</strong> (Box, Dropbox, Microsoft OneDrive, Google Drive) sees Roam reading the folders the admin chose, as it would for any app the admin authorizes.
            </>,
            <>
              <strong>Metadata services</strong>: movie and show names and years go to <A href="https://www.themoviedb.org">TMDB</A>; IMDb ids go to OMDb; audiobook names and authors go to Audible and Audnexus; artist and album folder names go to MusicBrainz when a
              music library has lookups turned on; the search text goes to OpenSubtitles only when someone searches for subtitles; a song&apos;s title, artist, album and length go to LRCLIB (lrclib.net) the first time anyone plays it, to fetch its lyrics; an artist&apos;s or album&apos;s MusicBrainz id (and, for an artist with none yet, its name) goes to MusicBrainz, Wikidata, Wikipedia and ListenBrainz the first time anyone opens its page in a music library that has lookups turned on, for a short description and similar artists (Wikipedia text is shown under CC BY-SA 4.0); the show or movie&apos;s IMDb id, season and episode, and the video&apos;s length go to SkipDB (skipdb.tv) for intro and credits times; and, only on servers where it has been switched on, a movie or show&apos;s IMDb or TMDB id goes to Does the Dog Die for its community content reports. This product uses the TMDB API but is not endorsed or certified by TMDB.
            </>,
          ]}
        />
        <p>
          Other people on a server can see what that server&apos;s admin chooses to share and what you choose to make visible (such as a shared playlist or a profile name). A server admin can see who they invited and who belongs to their server. We may disclose information if the law requires it.
        </p>
      </Section>

      <Section title="How long we keep it, and deleting it">
        <p>
          Information is kept while your account or the server it belongs to exists. Removing a storage connection deletes its stored tokens. Deleting a library removes everything Roam kept about it, and deleting a server removes its libraries, memberships, invitations, playlists and storage sign-ins, as
          well as everyone&apos;s activity on it. Hosting logs are kept for a short period by the hosting provider.
        </p>
        <p>To have your account and its data deleted, or to ask what Roam holds about you, contact the operator below. Files in your own storage are never deleted by Roam.</p>
      </Section>

      <Section title="Security">
        <p>
          Storage tokens are encrypted at rest, traffic uses HTTPS, and access to each server and library is checked on every request. No system is perfectly secure, so please use a strong password or the emailed sign-in link, and tell us if you think your account was accessed by someone else.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Roam is not directed to children under 13 and does not knowingly collect their personal information. Families can make profiles with age limits for children, but the account itself belongs to an adult, who is responsible for those profiles.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>If this policy changes, the date above changes with it, and significant changes will be announced to server admins.</p>
        <Contact />
      </Section>
    </LegalPage>
  );
}
