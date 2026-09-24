-- Row Level Security — defense in depth, run once against your Supabase
-- project's SQL editor after the Drizzle migrations.
--
-- IMPORTANT — read this before assuming RLS is what's protecting your data:
-- The app server (Next.js Route Handlers / Server Components) talks to
-- Postgres directly via Drizzle over DATABASE_URL, not through Supabase's
-- PostgREST API — so these policies do NOT gate the app's own queries.
-- The app's actual authorization boundary is the `requireProfile()` /
-- `requireAdmin()` / `getCurrentProfile()` checks in every route (see
-- src/lib/auth/guards.ts) plus explicit `WHERE profile_id = ...` filters on
-- user-scoped tables like watch_state. These RLS policies matter only if
-- something ever queries Postgres through Supabase's client-side API (e.g.
-- supabase-js `.from(...)`) with the anon/authenticated key — which nothing
-- in this app does today, but they're cheap insurance if that changes.

alter table profiles enable row level security;
alter table libraries enable row level security;
alter table titles enable row level security;
alter table seasons enable row level security;
alter table episodes enable row level security;
alter table media_files enable row level security;
alter table watch_state enable row level security;
alter table invites enable row level security;
alter table scan_runs enable row level security;

-- profiles: a user can read their own row; nothing else via this path.
create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on profiles
  for insert with check (auth.uid() = id);

-- Library content is readable by any signed-in (invited) user. Writes are
-- done by the app server with the service-role key (scanner, admin routes),
-- which bypasses RLS entirely, so no write policy is defined here.
create policy "libraries_select_authenticated" on libraries
  for select using (auth.role() = 'authenticated');
create policy "titles_select_authenticated" on titles
  for select using (auth.role() = 'authenticated');
create policy "seasons_select_authenticated" on seasons
  for select using (auth.role() = 'authenticated');
create policy "episodes_select_authenticated" on episodes
  for select using (auth.role() = 'authenticated');
create policy "media_files_select_authenticated" on media_files
  for select using (auth.role() = 'authenticated');

-- watch_state: strictly per-profile.
create policy "watch_state_owner_all" on watch_state
  for all using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

-- invites and scan_runs: no policies granted — only reachable via the
-- service-role key from admin-gated server code.
