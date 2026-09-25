# Roam

A private, cloud-native media server for sharing movies with family —
modeled on Plex, but with media stored in Box instead of a local NAS, and a
custom player that plays movies split into multiple files (e.g. "Part 1" /
"Part 2") back-to-back as one seamless, continuous video.

See `/home/matt/.claude/plans/i-want-to-uh-generic-hejlsberg.md` (or ask
Claude) for the full design rationale. The short version:

- **Vercel** (Next.js) is a thin control plane — auth, metadata, and minting
  short-lived signed Box download URLs. It never proxies video bytes.
- **Box** stores the actual media. The browser streams directly from Box.
- **Supabase** provides Postgres (via Drizzle) for metadata/auth state, and
  Supabase Auth (magic link, Google, email+password) for sign-in.
- **TMDB** supplies posters, overviews, and genres automatically.

## Prerequisites

- Node.js 20.9+ (Next.js 16 requirement)
- A [Supabase](https://supabase.com) project
- A [Box](https://developer.box.com) Custom App with Client Credentials
  Grant (CCG) enabled
- A [TMDB](https://www.themoviedb.org/settings/api) API Read Access Token
- A [Vercel](https://vercel.com) project, for deployment + Cron

## 1. Install

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local` — see the comments in `.env.example` for where to find
each value.

While you're setting up credentials, you can already sanity-check the parts
of the app that don't need them — the Box folder/filename convention parser
and the from-scratch MP4 duration prober both have a unit test suite:

```bash
npm test
```

## 2. Set up Supabase

1. Create a project. Copy the URL, anon key, and service-role key into
   `.env.local`.
2. Grab the **direct** connection string (Project Settings → Database →
   Connection string → URI, port `5432`) for `POSTGRES_URL` while running
   migrations. Switch to the **pooled** connection (port `6543`, "Transaction"
   mode) for `POSTGRES_URL` in your actual deployment — serverless functions
   need a pooler, not a direct connection.
3. Enable the auth providers you want under Authentication → Providers:
   Email (magic link is on by default; enable "Email + Password" too) and
   Google (needs a Google OAuth client — see Supabase's Google guide).
4. Set the Site URL and Redirect URLs (Authentication → URL Configuration)
   to your app's URL plus `/auth/callback` (e.g.
   `http://localhost:3000/auth/callback` locally,
   `https://your-app.vercel.app/auth/callback` in production).

## 3. Run database migrations

```bash
npm run db:migrate
```

This applies `drizzle/0000_*.sql` (generated from `src/lib/db/schema.ts`).
If you change the schema later, run `npm run db:generate` to create a new
migration, then `npm run db:migrate` again. `npm run db:studio` opens
Drizzle Studio to browse the data.

Then, in the Supabase SQL editor, run **`supabase/rls.sql`** once. Read the
comment at the top of that file first — it explains that RLS here is
defense-in-depth, not the app's primary security boundary (that's the
`requireProfile()`/`requireAdmin()` checks in every route).

## 4. Set up Box

1. In the [Box Developer Console](https://app.box.com/developers/console),
   create a **Custom App** → **Server Authentication (Client Credentials
   Grant)**.
2. Under Configuration, note the **Client ID** and **Client Secret**.
3. Authorize the app for your enterprise (Admin Console → Apps → Custom Apps
   Manager → Authorize the app), and note your **Enterprise ID**.
4. In Box, create your media folder structure (see below) under an account
   the service account can access, and copy each root folder's ID (the
   trailing number in its URL) into `.env.local` /
   the admin UI when creating a library.

### Folder conventions the scanner expects

```
Movies/
  The Matrix (1999)/
    The Matrix (1999).mp4
  The Lord of the Rings The Fellowship of the Ring (2001)/
    part1.mp4
    part2.mp4

TV Shows/
  Some Show (2015)/
    Season 01/
      S01E01 - Pilot.mp4
      S01E02 - Episode Two.mp4
```

Pre-convert everything to browser-friendly **H.264/AAC MP4** before
uploading — there's no server-side transcoding (see the plan for why).

## 5. Set up TMDB

Create an API key at themoviedb.org, then use the **API Read Access Token
(v4 auth)** (not the v3 API key) as `TMDB_READ_ACCESS_TOKEN`.

## 6. Run it

```bash
npm run dev
```

Visit `http://localhost:3000`. There are no users yet — see the next step.

## 7. Create your first admin account

Invites are created through the admin UI, but there's no admin yet to log
in. Bootstrap one directly in Postgres (Supabase SQL editor or
`db:studio`):

```sql
insert into invites (email, role, token, expires_at)
values ('you@example.com', 'admin', 'bootstrap-' || gen_random_uuid(), now() + interval '7 days');
```

Then visit `/invite/<token>` (the value after `bootstrap-` won't matter —
copy the full `token` column value) and sign in. From then on, use
**Admin → Invite family members** for everyone else.

## 8. Add a library and scan

In **Admin**, add a library pointing at your Box root folder (Movies or TV
Shows) and its Box folder ID, then click **Rescan**. This walks the folder,
matches titles against TMDB, and probes each video file's duration (a small
byte-range read of the MP4 `moov` atom — no ffmpeg, no full download).

## Deploying to Vercel

1. Import the repo into Vercel, add all the env vars from `.env.example`
   (use the **pooled** `POSTGRES_URL`).
2. `vercel.json` already defines a Cron job hitting `/api/cron/scan` every 6
   hours — Vercel picks this up automatically on deploy. Make sure
   `CRON_SECRET` is set; the route rejects requests without the matching
   `Authorization: Bearer` header.
3. Update Supabase's Redirect URLs to include your production
   `/auth/callback` URL.

## Project structure

```
src/
  app/
    (app)/            # authenticated shell: library, title, show, watch, admin
    api/               # control-plane routes (play manifest, scan, invites, tmdb match…)
    sign-in/, invite/[token]/, auth/callback/
  components/
    player/            # the seamless dual-video player
    admin/, auth/, library/, nav/, ui/
  lib/
    db/                # Drizzle schema + client
    storage/           # StorageProvider interface + Box implementation
    scan/               # folder-convention parser, MP4 duration probe, scanner
    player/             # shared play-manifest builder + types (used by movies and episodes)
    tmdb/               # TMDB client
    auth/               # profile/role guards, invite handling
    supabase/           # browser/server/service-role Supabase clients
  proxy.ts              # Next.js 16's middleware.ts equivalent — refreshes auth session
```

## Known limitations / next steps

- **Box streaming spike not yet run against a real account.** The play
  manifest mints downscoped, single-file Box download URLs and assumes they
  support HTTP range requests (needed for seeking) with a workable TTL —
  verify this against your actual Box plan before relying on it for long
  movies. If TTLs are too short, the player already re-fetches the manifest
  on a video `error` event and proactively before expiry, but this hasn't
  been exercised against production Box.
- **No open self-signup** — by design; everyone needs an admin-issued
  invite.
- **Box webhooks** (near-real-time re-scan on upload) aren't implemented;
  only manual Rescan + the 6-hourly cron. `box-node-sdk`'s
  `WebhooksManager.validateMessage()` (signature verification) is confirmed
  available in the installed SDK version for when this gets built.
- **Invites are copy/paste links**, not sent by email automatically — the
  admin has to send the link themselves. Supabase Auth's admin API can send
  its own invite emails (`auth.admin.inviteUserByEmail`), which would be a
  cleaner flow, but wiring that in changes the auth handshake in ways worth
  testing against a real Supabase project first rather than building blind.
