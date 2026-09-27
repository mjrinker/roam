-- Row Level Security — deny-all, run once against your Supabase project's
-- SQL editor after the Drizzle migrations.
--
-- WHY DENY-ALL (not per-table policies): this app talks to Postgres
-- directly via Drizzle over POSTGRES_URL, connecting as a role that
-- bypasses RLS by design — never through Supabase's client library or
-- PostgREST for data (only for `.auth.*` methods: signInWithOtp,
-- signInWithOAuth, signInWithPassword, signUp, getUser,
-- exchangeCodeForSession, signOut — confirmed by auditing every
-- createSupabaseBrowserClient()/createSupabaseServerClient()/
-- createSupabaseServiceRoleClient() call site). So there is no functional
-- reason for PostgREST to be able to read or write ANY row of ANY app
-- table.
--
-- This matters more than it used to: sign-in is now open to anyone (no
-- invite required), so "authenticated" means literally anyone on the
-- internet who signs up — they get a real Supabase JWT and can hit
-- PostgREST directly with the public anon key, entirely outside this
-- app's own server-scoped guards (see src/lib/auth/guards.ts). A "select
-- where you're a member" style policy would still leak more than
-- intended in places (e.g. a servers policy would expose the encrypted
-- Box token columns to that server's own ordinary members, who have no
-- reason to see them). Enabling RLS with zero policies closes that
-- surface completely: PostgREST returns nothing for any of these tables,
-- for anyone, while this app's own direct Postgres connection is
-- unaffected.
--
-- The app's real authorization boundary remains what it always was:
-- requireProfile() / requireServerMember() / requireServerAdmin() in
-- every route (src/lib/auth/guards.ts) plus explicit ownership checks
-- resolved server-side (e.g. resolveServerIdForOwner in the play/
-- watch-state routes). RLS here is pure defense against a surface the
-- app doesn't even use, not a substitute for those checks.

alter table profiles enable row level security;
alter table viewers enable row level security;
alter table servers enable row level security;
alter table server_members enable row level security;
alter table libraries enable row level security;
alter table titles enable row level security;
alter table seasons enable row level security;
alter table episodes enable row level security;
alter table media_files enable row level security;
alter table watch_state enable row level security;
alter table invites enable row level security;
alter table scan_runs enable row level security;
alter table rate_limit_buckets enable row level security;

-- No policies on any table, intentionally. RLS enabled + zero policies =
-- deny-all for every role except one with BYPASSRLS (which this app's
-- own Postgres connection has).
