import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  real,
  doublePrecision,
  pgEnum,
  uniqueIndex,
  index,
  check,
  primaryKey,
  foreignKey,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ── Enums ────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["admin", "viewer"]);
// Binary column (artwork bytes); postgres-js returns a Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const libraryKindEnum = pgEnum("library_kind", ["movies", "shows", "audiobooks", "video", "audio", "photos"]);
// Who may see a library: everyone on the server, or only server admins and the accounts listed in library_members.
export const libraryAccessEnum = pgEnum("library_access", ["everyone", "restricted"]);
export const titleKindEnum = pgEnum("title_kind", ["movie", "show", "audiobook", "photo"]);
export type LibraryAccess = (typeof libraryAccessEnum.enumValues)[number];
export type LibraryKind = (typeof libraryKindEnum.enumValues)[number];
export type TitleKind = (typeof titleKindEnum.enumValues)[number];
export const ownerKindEnum = pgEnum("owner_kind", ["title", "episode"]);
export const metadataStatusEnum = pgEnum("metadata_status", [
  "pending",
  "matched",
  "manual",
  "not_found",
]);
export const probeStatusEnum = pgEnum("probe_status", [
  "pending",
  "ok",
  "failed",
]);
export const scanTriggerEnum = pgEnum("scan_trigger", [
  "manual",
  "cron",
  "webhook",
  "resume",
]);
// A profile's standing within its own account (unrelated to server_members'
// admin/viewer role, which is about a SERVER, not the account's profiles).
// Exactly one profile per account is "owner"; see lib/content/roles.
export const viewerRoleEnum = pgEnum("viewer_role", ["owner", "admin", "limited"]);
export const boxAuthStatusEnum = pgEnum("box_auth_status", [
  "disconnected",
  "connected",
  "needs_reauth",
]);

// ── profiles ─────────────────────────────────────────────────────────────
// One row per authenticated user. `id` matches the Supabase auth.users id.
// No role here — sign-in is open to anyone; role is per-server, on
// server_members.

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── viewers ──────────────────────────────────────────────────────────────
// A person using an account: Netflix-style "profiles" (UI copy says profile;
// the table is `viewers` because `profiles` above is the ACCOUNT). Per-person
// data (watch history, playback speed) and restrictions live here. Each
// account's default viewer reuses the account's own id, which makes the
// original backfill and any later re-creation idempotent.

export const viewers = pgTable(
  "viewers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // owner: created with the account, can manage every profile and its own
    // settings. admin: can manage its own settings only. limited: can only
    // rename itself / change its own avatar. See lib/content/roles.
    role: viewerRoleEnum("role").notNull().default("limited"),
    // Key into the built-in avatar gallery (lib/viewers/avatars).
    avatarKey: text("avatar_key").notNull().default("teal-user"),
    // BCP-47 tag. Its region also picks the rating country.
    locale: text("locale").notNull().default("en-US"),
    // Highest minimum age this viewer may watch; null = no limit.
    maxAge: integer("max_age"),
    allowUnrated: boolean("allow_unrated").notNull().default(false),
    // scrypt hash of a 4-digit PIN; null = no PIN. Changing it bumps
    // pinVersion, which invalidates existing selection cookies.
    pinHash: text("pin_hash"),
    pinVersion: integer("pin_version").notNull().default(0),
    playbackRate: real("playback_rate").notNull().default(1),
    // Whether this profile's name/avatar may be shown to OTHER accounts that
    // are members of the same server (not yet surfaced anywhere in the UI —
    // reserved for a future member list). Owner controls it for any profile
    // on the account; an admin controls it for its own.
    visibleOnServer: boolean("visible_on_server").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("viewers_account_idx").on(t.accountId)]
).enableRLS();

export type Viewer = typeof viewers.$inferSelect;
export type ViewerRole = (typeof viewerRoleEnum.enumValues)[number];

// ── servers ──────────────────────────────────────────────────────────────
// A tenant. Owns exactly one Box OAuth connection (its own end-user's Box
// account, not a shared service account). ownerId is onDelete: "restrict"
// — deleting a profile must never silently orphan a server; there's no
// server-deletion/ownership-transfer flow yet (see plan's fast-follows).

export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => profiles.id, { onDelete: "restrict" }),
  boxAccessTokenEncrypted: text("box_access_token_encrypted"),
  boxRefreshTokenEncrypted: text("box_refresh_token_encrypted"),
  boxTokenExpiresAt: timestamp("box_token_expires_at", { withTimezone: true }),
  boxAuthStatus: boxAuthStatusEnum("box_auth_status")
    .notNull()
    .default("disconnected"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── server_members ───────────────────────────────────────────────────────
// Per-server role. A profile can belong to multiple servers.

export const serverMembers = pgTable(
  "server_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull().default("viewer"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("server_members_server_profile_idx").on(
      t.serverId,
      t.profileId
    ),
    index("server_members_profile_idx").on(t.profileId),
    // A server has exactly one admin: whoever created it. Everyone else is a viewer.
    uniqueIndex("server_members_one_admin_idx").on(t.serverId).where(sql`${t.role} = 'admin'`),
  ]
);

// ── rate_limit_buckets ───────────────────────────────────────────────────
// Fixed-window rate limiting, shared across serverless instances via
// Postgres. windowStart is computed deterministically by the caller
// (floor(now/windowSeconds)*windowSeconds) so concurrent requests in the
// same window collide on one row. See lib/rate-limit.ts.

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("rate_limit_buckets_profile_bucket_window_idx").on(
      t.profileId,
      t.bucket,
      t.windowStart
    ),
  ]
);

// ── libraries ────────────────────────────────────────────────────────────
// A scanned Box root folder (e.g. "Movies", "TV Shows"), owned by a server.

export const libraries = pgTable(
  "libraries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: libraryKindEnum("kind").notNull(),
    boxFolderId: text("box_folder_id").notNull().unique(),
    // Fails closed: a library inserted without saying otherwise is restricted. (The migration
    // backfilled every library that existed before this column as 'everyone'.)
    access: libraryAccessEnum("access").notNull().default("restricted"),
    // Video ("generic") libraries only: the age rating the admin gave the whole library, as
    // {ANY: minimumAge}; null = unrated. Copied onto each of the library's titles (see
    // lib/libraries/video-rating) so lib/content/access keeps working unchanged.
    ratingAges: jsonb("rating_ages").$type<Record<string, number> | null>(),
    // Video libraries: what lets a scan tell a video that left Box from one it simply hasn't reached
    // yet. A full pass starts a new cycle (id + clean=true); each video seen is stamped with the id;
    // anything that goes wrong in the cycle marks it unclean. Only a cycle that finished cleanly may
    // remove videos (see lib/scan/video-prune).
    scanCycleId: uuid("scan_cycle_id"),
    scanCycleClean: boolean("scan_cycle_clean").notNull().default(true),
    // Remove a video's entry (and its watch history and playlist spots) once it has left Box.
    pruneMissing: boolean("prune_missing").notNull().default(true),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    // Updated at the START of every scan attempt, success or failure —
    // distinct from lastScannedAt (which only advances on completion, and
    // is what the admin UI shows). The cron scheduler orders by this one
    // so a library whose scans keep failing doesn't camp at the head of
    // the "oldest scanned" queue forever and starve out healthy libraries.
    lastScanAttemptAt: timestamp("last_scan_attempt_at", {
      withTimezone: true,
    }),
    // Set whenever a scan stops early because it hit its time budget
    // (see scanLibrary), cleared once a scan finishes with nothing left
    // pending. Drives auto-resume: any page load in this server checks
    // for libraries with this set and kicks off a background scan to
    // continue, instead of requiring an admin to notice and click Rescan.
    scanIncomplete: boolean("scan_incomplete").notNull().default(false),
    // Where an interrupted scan's folder loop left off (see lib/scan/cursor).
    // Null with scanIncomplete set means folder sync finished and only
    // probing remains. Advanced with compare-and-set so concurrent scans
    // can't both own it.
    scanCursor: jsonb("scan_cursor").$type<{ folder: string; sub?: string } | null>(),
    // Folder-loop progress for the current scan cycle, so the admin progress
    // bar restarts at 0 on a rescan. Total is set when a full pass begins.
    scanFoldersTotal: integer("scan_folders_total").notNull().default(0),
    scanFoldersDone: integer("scan_folders_done").notNull().default(0),
    // Audible storefront region used when matching audiobooks.
    audibleRegion: text("audible_region").notNull().default("us"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("libraries_server_idx").on(t.serverId),
    // Lets library_members reference (library, server) together, so a grant can't cross servers.
    uniqueIndex("libraries_id_server_idx").on(t.id, t.serverId),
  ]
);

// ── library_members ──────────────────────────────────────────────────────
// Which ACCOUNTS (server members) may see a restricted library. Server admins always can.
// serverId is carried so composite foreign keys tie the grant to a real membership of the
// library's own server: removing the membership or the library removes the grant.
export const libraryMembers = pgTable(
  "library_members",
  {
    libraryId: uuid("library_id").notNull(),
    serverId: uuid("server_id").notNull(),
    accountId: uuid("account_id").notNull(),
    grantedByAccountId: uuid("granted_by_account_id").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.accountId] }),
    foreignKey({ name: "library_members_library_server_fk", columns: [t.libraryId, t.serverId], foreignColumns: [libraries.id, libraries.serverId] }).onDelete("cascade"),
    foreignKey({ name: "library_members_server_account_fk", columns: [t.serverId, t.accountId], foreignColumns: [serverMembers.serverId, serverMembers.profileId] }).onDelete("cascade"),
    index("library_members_account_idx").on(t.accountId),
    index("library_members_granted_by_idx").on(t.grantedByAccountId),
  ]
).enableRLS();

// ── titles ───────────────────────────────────────────────────────────────
// A movie, or a show's top-level record.

export const titles = pgTable(
  "titles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    kind: titleKindEnum("kind").notNull(),
    name: text("name").notNull(),
    year: integer("year"),
    boxFolderId: text("box_folder_id").notNull().unique(),

    // Video ("generic") libraries only; null for everything else. Each video file is one title
    // whose box_folder_id holds 'file:<Box file id>' (a stable unique key), so:
    // - folderPath: the folder the file sits in, relative to the library root ('' = the root),
    //   segments joined by '/'; browsing by folder reads this.
    // - parentFolderId: the Box id of that folder, for anything that needs a real folder
    //   (resync, remux uploads). Refreshed on every directory scan.
    // - nameSource: 'embedded' once the name came from the file's own tags, so a rescan never
    //   overwrites it with the filename.
    // - tagsAttemptedAt: when the file's embedded tags/artwork were last read.
    folderPath: text("folder_path"),
    // Natural-order key for listing a folder: the file name lowercased with every number zero-padded,
    // so "Track 2" sorts before "Track 10" and "01 - Intro" stays where its number says. Null falls back
    // to the lowercased name.
    sortKey: text("sort_key"),
    parentFolderId: text("parent_folder_id"),
    nameSource: text("name_source").$type<"filename" | "embedded">(),
    tagsAttemptedAt: timestamp("tags_attempted_at", { withTimezone: true }),
    // The scan cycle (libraries.scan_cycle_id) in which this video was last seen in Box.
    lastSeenCycle: uuid("last_seen_cycle"),
    // When a scan first found this video gone from Box (null while it is present). Cleanup waits a
    // grace period after this before removing anything: Box's trash is restorable, and a 404 can
    // also mean "this account can no longer see it".
    missingSince: timestamp("missing_since", { withTimezone: true }),
    // Failed tries at reading the file's tags; stops at a small cap so an unreadable file isn't
    // retried on every scan.
    tagAttempts: integer("tag_attempts").notNull().default(0),
    // Box thumbnails are tracked apart: Box may still be generating one (so the next try waits a
    // while) and that must never use up the tag read's tries.
    thumbAttempts: integer("thumb_attempts").notNull().default(0),
    thumbAttemptedAt: timestamp("thumb_attempted_at", { withTimezone: true }),

    tmdbId: integer("tmdb_id"),
    overview: text("overview"),
    posterUrl: text("poster_url"),
    backdropUrl: text("backdrop_url"),
    genres: jsonb("genres").$type<string[]>().default([]),
    metadataStatus: metadataStatusEnum("metadata_status")
      .notNull()
      .default("pending"),

    // Sum of media_files.duration_seconds for a movie's segments.
    runtimeSeconds: integer("runtime_seconds"),

    // Audiobook-only fields. Null for movies and shows.
    authors: jsonb("authors").$type<string[]>(),
    narrators: jsonb("narrators").$type<string[]>(),
    // The author folder the book was found under; kept separately so an
    // Audible match never destroys what the folder layout told us.
    folderAuthor: text("folder_author"),
    seriesName: text("series_name"),
    seriesPosition: text("series_position"),
    asin: text("asin"),
    chapters: jsonb("chapters").$type<{ title: string; startSeconds: number }[]>(),
    chaptersSource: text("chapters_source").$type<"embedded" | "audnexus" | "files">(),
    metadataAttemptedAt: timestamp("metadata_attempted_at", { withTimezone: true }),
    // Certification strings for display (e.g. {US: "PG-13"}), and the same
    // normalized to a minimum age per country (plus a synthetic "ANY" key for
    // content with no per-country board, like an Audible adult flag) — see
    // lib/content/ratings. ratingsAttemptedAt drives the backfill batch, same
    // pattern as metadataAttemptedAt above.
    certifications: jsonb("certifications").$type<Record<string, string>>(),
    ratingAges: jsonb("rating_ages").$type<Record<string, number>>(),
    ratingsAttemptedAt: timestamp("ratings_attempted_at", { withTimezone: true }),

    // External scores (movies/shows only), from OMDb keyed by IMDb id — see
    // lib/omdb. imdbId comes from TMDB's external_ids, fetched alongside the
    // certification data above; the OMDb call itself is a separate backfill
    // pass (lib/content/external-ratings-backfill) since it's a different
    // API/key that can fail or rate-limit independently. Rotten Tomatoes has
    // no free API for its audience score, so only the critics' Tomatometer
    // is stored. metascore is captured because OMDb returns it for free but
    // isn't shown anywhere yet.
    imdbId: text("imdb_id"),
    imdbRating: real("imdb_rating"),
    imdbVotes: integer("imdb_votes"),
    rottenTomatoesScore: integer("rotten_tomatoes_score"),
    metascore: integer("metascore"),
    externalRatingsAttemptedAt: timestamp("external_ratings_attempted_at", { withTimezone: true }),

    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("titles_library_idx").on(t.libraryId),
    index("titles_name_idx").on(t.name),
    // Folder browsing (video libraries): prefix matches on folder_path within a library.
    index("titles_library_folder_idx").on(t.libraryId, t.folderPath.op("text_pattern_ops")),
  ]
);

// ── title_artwork ────────────────────────────────────────────────────────
// Image bytes for a title whose artwork lives in Roam itself (video libraries): a cover embedded
// in the file, or a thumbnail fetched from Box. Kept apart from titles so list queries never
// read image bytes. Served by /api/titles/[id]/artwork behind the usual access checks.
export const titleArtwork = pgTable(
  "title_artwork",
  {
    titleId: uuid("title_id")
      .primaryKey()
      .references(() => titles.id, { onDelete: "cascade" }),
    // The picture itself lives once in artwork_images: every track of an album carries the same cover.
    imageHash: text("image_hash")
      .notNull()
      .references(() => artworkImages.hash),
    source: text("source").notNull().$type<"embedded" | "box">(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("title_artwork_image_idx").on(t.imageHash)]
).enableRLS();

// ── artwork_images ───────────────────────────────────────────────────────
// Image bytes keyed by the SHA-256 of the bytes, so identical pictures are stored once however many
// titles use them. A row with no title_artwork pointing at it is removed when the last one goes.
export const artworkImages = pgTable("artwork_images", {
  hash: text("hash").primaryKey(),
  contentType: text("content_type").notNull(),
  bytes: bytea("bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── seasons ──────────────────────────────────────────────────────────────

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    boxFolderId: text("box_folder_id").notNull().unique(),
  },
  (t) => [uniqueIndex("seasons_title_number_idx").on(t.titleId, t.number)]
);

// ── episodes ─────────────────────────────────────────────────────────────

export const episodes = pgTable(
  "episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    name: text("name"),
    boxFolderId: text("box_folder_id"),

    tmdbId: integer("tmdb_id"),
    overview: text("overview"),
    stillUrl: text("still_url"),
    runtimeSeconds: integer("runtime_seconds"),
  },
  (t) => [uniqueIndex("episodes_season_number_idx").on(t.seasonId, t.number)]
);

// ── media_files ──────────────────────────────────────────────────────────
// The physical, ordered segments backing a movie (owner_kind='title') or an
// episode (owner_kind='episode'). part_index defines playback order; a
// single-file movie has exactly one row with part_index = 0.

export const mediaFiles = pgTable(
  "media_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable as of the audio-fix "versions" feature: a variant row (see
    // variantOfMediaFileId below) is not an ordered playback segment of its
    // own — it stands in for one specific primary row's bytes only — so it
    // has neither. Every existing query filters on these explicitly, so a
    // null-owner row is simply invisible everywhere without further changes.
    ownerKind: ownerKindEnum("owner_kind"),
    ownerId: uuid("owner_id"),
    partIndex: integer("part_index").notNull().default(0),

    // No longer globally unique as of migration 0012 — a multi-episode
    // file's Box id is legitimately owned by more than one episode row now.
    // media_files_owner_file_idx (owner_kind, owner_id, box_file_id) is the
    // real uniqueness guarantee; see the multi-episode rollout plan.
    boxFileId: text("box_file_id").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // duration_ms is authoritative when set (audiobooks: rounding to whole
    // seconds across dozens of parts would drift chapter and resume
    // positions); duration_seconds is always written alongside as its
    // rounded value, and is all that older rows have.
    durationSeconds: integer("duration_seconds"),
    durationMs: integer("duration_ms"),
    // Probe tries so far; parts that keep failing are eventually given up
    // on so one bad file can't block a whole book.
    probeAttempts: integer("probe_attempts").notNull().default(0),
    // Chapters embedded in this file (audiobooks), start times relative to
    // the file. The book's chapter list is assembled from these at scan time.
    chapters: jsonb("chapters").$type<{ title: string; startSeconds: number }[]>(),

    container: text("container"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    width: integer("width"),
    height: integer("height"),
    probeStatus: probeStatusEnum("probe_status").notNull().default("pending"),
    // Whether audioCodec/videoCodec have been successfully read — distinct
    // from them merely being non-null, since "no such track" is itself a
    // successful, terminal read. False forever means either not attempted
    // yet, or a read that failed and hasn't exhausted codecProbeAttempts —
    // see the codec backfill in media-files.ts, entirely separate from
    // probeStatus/probeAttempts so a codec-read hiccup can't regress an
    // already-working duration probe.
    codecProbed: boolean("codec_probed").notNull().default(false),
    codecProbeAttempts: integer("codec_probe_attempts").notNull().default(0),

    // Audio-fix "versions": a variant row is a one-time server-side remux
    // (video passthrough, audio re-encoded to AAC) of another row's file,
    // played instead of it for a browser that can't decode the original's
    // codec (see lib/remux/, lib/player/manifest.ts). It's identified
    // purely by this self-FK — never by ownerKind/ownerId/partIndex, which
    // stay null/default on a variant row — and never carries its own trim
    // state (trims always come from the primary row it stands in for, so
    // they can't go stale independently of it).
    variantOfMediaFileId: uuid("variant_of_media_file_id").references(
      (): AnyPgColumn => mediaFiles.id,
      { onDelete: "cascade" }
    ),
    // Set on a PRIMARY row only, tracking the remux job that produces its
    // variant. 'uploaded' (not 'done') is what the remux job itself sets on
    // success — 'done' is set only once the variant is actually linked (see
    // upsertVariant in media-files.ts), so 'done' always means "actually
    // linked and visible," never "uploaded but silently unlinked."
    remuxStatus: text("remux_status").$type<"pending" | "in_progress" | "uploaded" | "done" | "failed">(),
    remuxAttempts: integer("remux_attempts").notNull().default(0),
    // 1 (Fluid Compute Function) or 2 (Vercel Sandbox) — which mechanism is
    // or was handling this job, set at claim time. Needed to know the right
    // "still running" budget when checking whether an in_progress job died.
    remuxTier: integer("remux_tier"),
    remuxStartedAt: timestamp("remux_started_at", { withTimezone: true }),
    // Random per-job secret, rotated on every (re)queue — guards every
    // remux job write (not just Sandbox's completion callbacks) so a
    // reclaimed/superseded job's late write becomes a no-op instead of
    // silently overwriting a newer attempt's result.
    remuxCallbackToken: text("remux_callback_token"),

    // Estimated in-file playback window for one episode of a multi-episode
    // file (e.g. "S01E05-E06"), computed by the episode-split pass from
    // TMDB per-episode runtimes (snapped to an embedded chapter when one is
    // close). Both null = not yet computed OR deliberately whole-file (an
    // ordinary file, a multi-part file, or the "losing" side of an overlap
    // between a standalone and a combined file — see groupEpisodeFiles).
    // trimSource distinguishes those: null = not computed, 'auto' = computed
    // (including "deliberately whole-file"), 'manual' = pinned by an admin,
    // never touched by the split pass again.
    trimStartSeconds: doublePrecision("trim_start_seconds"),
    trimDurationSeconds: doublePrecision("trim_duration_seconds"),
    trimSource: text("trim_source").$type<"auto" | "manual">(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("media_files_owner_part_idx").on(
      t.ownerKind,
      t.ownerId,
      t.partIndex
    ),
    index("media_files_owner_idx").on(t.ownerKind, t.ownerId),
    // Scoped alternative to the (still-present) global unique on
    // boxFileId — lets a multi-episode file's Box id be owned by more than
    // one episode row. Deploy 1 of the multi-episode rollout adds this
    // index without removing the global constraint yet; a later migration
    // drops it once the new conflict target is live everywhere (see
    // upsertMediaSegments and the plan's two-deploy rollout).
    uniqueIndex("media_files_owner_file_idx").on(
      t.ownerKind,
      t.ownerId,
      t.boxFileId
    ),
    // NULLs don't collide in a Postgres unique index, so this only ever
    // constrains actual variant rows — at most one variant per primary row.
    // `upsertVariant` (media-files.ts) targets this directly.
    uniqueIndex("media_files_variant_of_idx").on(t.variantOfMediaFileId),
  ]
);

// ── watch_state ──────────────────────────────────────────────────────────
// Resume position + continue-watching, always expressed in the GLOBAL
// timeline (sum across ordered media_files), never a per-segment offset.

export const watchState = pgTable(
  "watch_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Who this progress belongs to (a profile, not the account — see viewers).
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => viewers.id, { onDelete: "cascade" }),
    ownerKind: ownerKindEnum("owner_kind").notNull(),
    ownerId: uuid("owner_id").notNull(),
    positionSeconds: integer("position_seconds").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    finished: boolean("finished").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("watch_state_viewer_owner_idx").on(
      t.viewerId,
      t.ownerKind,
      t.ownerId
    ),
  ]
);

// ── invites ──────────────────────────────────────────────────────────────
// Grants a server_members row on acceptance, not a profiles row — accounts
// exist independent of invites now that sign-in is open.

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: userRoleEnum("role").notNull().default("viewer"),
    token: text("token").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("invites_server_idx").on(t.serverId),
    // Invites only ever make viewers (see server_members_one_admin_idx).
    check("invites_viewer_only", sql`${t.role} = 'viewer'`),
  ]
);

// ── scan_runs ────────────────────────────────────────────────────────────

export const scanRuns = pgTable("scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  libraryId: uuid("library_id")
    .notNull()
    .references(() => libraries.id, { onDelete: "cascade" }),
  trigger: scanTriggerEnum("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  filesSeen: integer("files_seen").notNull().default(0),
  titlesAdded: integer("titles_added").notNull().default(0),
  errors: jsonb("errors").$type<string[]>().default([]),
});

// ── playlists ────────────────────────────────────────────────────────────
// A playlist lives on ONE server and is owned by a viewer (profile). Shares
// point at specific viewers; `visibility = 'server'` makes it readable by every
// member of that server. See lib/playlists for the permission rules.

export const playlistVisibilityEnum = pgEnum("playlist_visibility", ["private", "server"]);
export const playlistRoleEnum = pgEnum("playlist_role", ["editor", "sharer", "viewer"]);

export const playlists = pgTable(
  "playlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    // Null once the owner's profile is deleted: the playlist (if it was
    // shared) stays, view-only for everyone.
    ownerViewerId: uuid("owner_viewer_id").references(() => viewers.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    visibility: playlistVisibilityEnum("visibility").notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("playlists_server_idx").on(t.serverId), index("playlists_owner_idx").on(t.ownerViewerId)]
).enableRLS();

export const playlistItems = pgTable(
  "playlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    // Exactly one of these is set. Real foreign keys, so removing a title or
    // episode from Roam removes it from every playlist.
    titleId: uuid("title_id").references(() => titles.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    // Gaps of 1024 between rows so a move rarely needs a renumber; bigint so
    // renumbering and appends can never overflow.
    position: bigint("position", { mode: "number" }).notNull(),
    addedByViewerId: uuid("added_by_viewer_id").references(() => viewers.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("playlist_items_one_target", sql`num_nonnulls(${t.titleId}, ${t.episodeId}) = 1`),
    uniqueIndex("playlist_items_playlist_title_idx").on(t.playlistId, t.titleId).where(sql`${t.titleId} IS NOT NULL`),
    uniqueIndex("playlist_items_playlist_episode_idx")
      .on(t.playlistId, t.episodeId)
      .where(sql`${t.episodeId} IS NOT NULL`),
    index("playlist_items_title_idx").on(t.titleId),
    index("playlist_items_episode_idx").on(t.episodeId),
    index("playlist_items_order_idx").on(t.playlistId, t.position, t.id),
  ]
).enableRLS();

export const playlistMembers = pgTable(
  "playlist_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => viewers.id, { onDelete: "cascade" }),
    role: playlistRoleEnum("role").notNull(),
    grantedByViewerId: uuid("granted_by_viewer_id").references(() => viewers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("playlist_members_playlist_viewer_idx").on(t.playlistId, t.viewerId),
    index("playlist_members_viewer_idx").on(t.viewerId),
  ]
).enableRLS();

// ── relations ────────────────────────────────────────────────────────────

export const serversRelations = relations(servers, ({ one, many }) => ({
  owner: one(profiles, { fields: [servers.ownerId], references: [profiles.id] }),
  members: many(serverMembers),
  libraries: many(libraries),
  invites: many(invites),
}));

export const serverMembersRelations = relations(serverMembers, ({ one }) => ({
  server: one(servers, {
    fields: [serverMembers.serverId],
    references: [servers.id],
  }),
  profile: one(profiles, {
    fields: [serverMembers.profileId],
    references: [profiles.id],
  }),
}));

export const librariesRelations = relations(libraries, ({ one, many }) => ({
  server: one(servers, {
    fields: [libraries.serverId],
    references: [servers.id],
  }),
  titles: many(titles),
  scanRuns: many(scanRuns),
}));

export const titlesRelations = relations(titles, ({ one, many }) => ({
  library: one(libraries, {
    fields: [titles.libraryId],
    references: [libraries.id],
  }),
  seasons: many(seasons),
}));

export const seasonsRelations = relations(seasons, ({ one, many }) => ({
  title: one(titles, { fields: [seasons.titleId], references: [titles.id] }),
  episodes: many(episodes),
}));

export const episodesRelations = relations(episodes, ({ one }) => ({
  season: one(seasons, {
    fields: [episodes.seasonId],
    references: [seasons.id],
  }),
}));

export const profilesRelations = relations(profiles, ({ many }) => ({
  watchState: many(watchState),
  serverMemberships: many(serverMembers),
  ownedServers: many(servers),
}));

export const watchStateRelations = relations(watchState, ({ one }) => ({
  viewer: one(viewers, {
    fields: [watchState.viewerId],
    references: [viewers.id],
  }),
}));

export const viewersRelations = relations(viewers, ({ one, many }) => ({
  account: one(profiles, {
    fields: [viewers.accountId],
    references: [profiles.id],
  }),
  watchState: many(watchState),
}));

export const invitesRelations = relations(invites, ({ one }) => ({
  server: one(servers, {
    fields: [invites.serverId],
    references: [servers.id],
  }),
  invitedByProfile: one(profiles, {
    fields: [invites.invitedBy],
    references: [profiles.id],
  }),
}));

export const scanRunsRelations = relations(scanRuns, ({ one }) => ({
  library: one(libraries, {
    fields: [scanRuns.libraryId],
    references: [libraries.id],
  }),
}));
