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
  smallint,
  date,
  foreignKey,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { ExtraCategory } from "@/lib/extras/categories";

// ── Enums ────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["admin", "viewer"]);
// Binary column (artwork bytes); postgres-js returns a Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const libraryKindEnum = pgEnum("library_kind", ["movies", "shows", "audiobooks", "video", "audio", "photos", "music", "ebooks"]);
// Who may see a library: everyone on the server, or only server admins and the accounts listed in library_members.
export const libraryAccessEnum = pgEnum("library_access", ["everyone", "restricted"]);
export const titleKindEnum = pgEnum("title_kind", ["movie", "show", "audiobook", "photo", "ebook"]);
export type LibraryAccess = (typeof libraryAccessEnum.enumValues)[number];
export type LibraryKind = (typeof libraryKindEnum.enumValues)[number];
export type TitleKind = (typeof titleKindEnum.enumValues)[number];
export const ownerKindEnum = pgEnum("owner_kind", ["title", "episode", "extra"]);
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
  // An anonymous visitor (the public demo's one-click guest): no real email, can only watch, and is deleted
  // after a stretch of inactivity (see lib/auth/guests).
  isGuest: boolean("is_guest").notNull().default(false),
  // Who may switch on a server's open join link and mark it a public demo. Off for everyone; granted by hand
  // (scripts/grant-open-links.ts), because an open link lets strangers (and anonymous guests) into a server.
  canManageOpenLinks: boolean("can_manage_open_links").notNull().default(false),
  // May open the platform admin page (/platform): numbers and health for every server. Granted by hand (scripts/grant-platform-admin.ts).
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  // When a guest last loaded a page (touched at most hourly); what "inactive" is measured against.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
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
    // What this profile skips while watching: per category, the weakest strength it skips ("violence": "high"). Empty = nothing.
    contentFilter: jsonb("content_filter").$type<import("@/lib/content-filter/categories").ContentFilterPrefs>().notNull().default({}),
    // Which parts this profile skips without being asked ("intro": true): the Skip intro button pressed for it. Empty = none.
    // Show a film series (or other collection) as one tile in the Movies and TV Shows lists instead of one tile per title.
    groupCollections: boolean("group_collections").notNull().default(false),
    // Data saver: video plays at about 480p unless another quality is picked, artwork is fetched at lower quality, and the next song is not loaded ahead of time.
    dataSaver: boolean("data_saver").notNull().default(false),
    // Photo libraries: leave screenshots out of the timeline, albums and search for this profile.
    hideScreenshots: boolean("hide_screenshots").notNull().default(false),
    // The languages this profile wants: the audio track and the subtitles picked automatically when a video has them (ISO 639-2, "eng"). Null = no preference.
    // Screen time: the most this profile may watch in a day (minutes), and quiet hours it may not watch in (minutes after midnight; the window
    // may run past midnight), on the clock of time_zone (an IANA name the editor sent from the device). All null = no limits.
    screenTimeMinutes: integer("screen_time_minutes"),
    quietFrom: integer("quiet_from"),
    quietTo: integer("quiet_to"),
    timeZone: text("time_zone"),
    audioLanguage: text("audio_language"),
    subtitleLanguage: text("subtitle_language"),
    autoSkip: jsonb("auto_skip").$type<Partial<Record<"intro" | "recap" | "outro" | "preview", boolean>>>().notNull().default({}),
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
  // An open invitation: anyone with /join/<token> can join as a viewer, as often as they like, until the admin
  // turns it off or replaces it. NULL = no open link.
  joinToken: text("join_token").unique(),
  // A public demo server: shows a notice, caps plays per day, and hides new joiners from each other.
  isDemo: boolean("is_demo").notNull().default(false),
  // How much this server may use Does the Dog Die (through the deployment's own API key; see lib/ddd): "disabled" (never asks),
  // "limited" (asks when someone is about to play a title) or "full" (also asks when a title's page opens).
  dddAccess: text("ddd_access").$type<"disabled" | "limited" | "full">().notNull().default("disabled"),
  // Who owns which copy (lib/ownership). Off: nothing changes. On: titles can be claimed, an owner can withdraw their copy, and (with the
  // limit on) no more people can play a title at once than there are copies shared.
  ownershipEnabled: boolean("ownership_enabled").notNull().default(false),
  // How a member's claim to own a title is settled: at once, or by the server's admin.
  claimMode: text("claim_mode").$type<"instant" | "review">().notNull().default("review"),
  limitConcurrent: boolean("limit_concurrent").notNull().default(false),
  // Which kinds of library the concurrent limit covers (the rest play without one).
  limitKinds: jsonb("limit_kinds").$type<string[]>().notNull().default(["movies", "shows"]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── storage_connections ──────────────────────────────────────────────────
// A login to a place files are kept (Box, Dropbox, OneDrive, Google Drive, an S3 bucket ...). A server can have any number, of any
// mix of providers, including several for the same one. The Box connection a server had before there could be more has this
// table's id = the server's id, so everything written before that (every stored Box id) keeps meaning that connection.
// servers.box_* are the old home of that connection and are no longer read.

export const STORAGE_PROVIDERS = ["box", "dropbox", "onedrive", "gdrive", "s3"] as const;
export type StorageProviderKind = (typeof STORAGE_PROVIDERS)[number];

export const storageConnections = pgTable(
  "storage_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    provider: text("provider").$type<StorageProviderKind>().notNull(),
    // What an admin calls it ("Family Dropbox").
    label: text("label").notNull(),
    // Who it is signed in as, as the provider says (an email address, a username); shown beside the label.
    accountName: text("account_name"),
    // OAuth providers: the tokens, encrypted (lib/crypto).
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    // Providers that sign in with keys instead (S3): the secret part, encrypted JSON.
    secretsEncrypted: text("secrets_encrypted"),
    // The not-secret settings (an S3 endpoint, region and bucket).
    config: jsonb("config").$type<Record<string, unknown>>(),
    authStatus: boxAuthStatusEnum("auth_status").notNull().default("disconnected"),
    // Editing files (a photo's date and place, scene files, renaming for a TMDB match). Box is always allowed; for the others the admin
    // opts in (writeEnabled) AND the sign-in has to have been given the provider's write permission (writeGranted), so both must be true.
    writeEnabled: boolean("write_enabled").notNull().default(false),
    writeGranted: boolean("write_granted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("storage_connections_server_idx").on(t.serverId)]
);

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
    // Music libraries: look albums up on MusicBrainz (sends the artist and album folder names there). An admin can turn it off.
    musicLookup: boolean("music_lookup").notNull().default(true),
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

// ── library_sources ──────────────────────────────────────────────────────
// The folders a library is made of. A library's first folder is libraries.box_folder_id (the name is from when Box was the only
// storage); any more, on any connection, are rows here, and a scan treats the folders as one: what is found in each is merged into
// the same library. root_id is a stored storage id (lib/storage/ids), so it says which connection it is on.

export const librarySources = pgTable(
  "library_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    rootId: text("root_id").notNull().unique(),
    // The folder's name when it was added, for showing; the scan doesn't use it.
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("library_sources_library_idx").on(t.libraryId)]
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
    nameSource: text("name_source").$type<"filename" | "embedded" | "online">(),
    tagsAttemptedAt: timestamp("tags_attempted_at", { withTimezone: true }),
    // Photo libraries. takenAt is a WALL-CLOCK time stored as if it were UTC (an EXIF time has no zone, so
    // it is never converted: a photo taken at 23:50 stays in that day whatever the viewer's zone); it is
    // set for every item at scan time (Box's file date, else the scan time, whole seconds) and upgraded
    // to the EXIF date when one is read (takenAtSource 'exif'; a rescan never replaces an EXIF date).
    takenAt: timestamp("taken_at", { withTimezone: true }),
    takenAtSource: text("taken_at_source").$type<"box" | "exif" | "scan" | "name" | "manual">(),
    width: integer("width"),
    height: integer("height"),
    // Photo libraries, where it was taken: read from the picture's GPS, or set by an admin (placeSource 'manual', which a scan never replaces).
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    placeName: text("place_name"),
    placeSource: text("place_source").$type<"exif" | "manual">(),
    // Photo libraries: a screenshot (by its name, the iPhone's note in its EXIF, or a PNG with no camera date at a screen's exact size: see
    // lib/photos/screenshots), so a profile can hide them. Only ever turned on by a scan, never off.
    isScreenshot: boolean("is_screenshot").notNull().default(false),
    // Photo libraries, finding faces (lib/faces): when this picture was last searched.
    facesScannedAt: timestamp("faces_scanned_at", { withTimezone: true }),
    // Reading the image's own metadata (EXIF, dimensions); separate from the MP4/ID3 tag counters above
    // so a photo is never fed to a video tag parser.
    metaAttemptedAt: timestamp("meta_attempted_at", { withTimezone: true }),
    metaAttempts: integer("meta_attempts").notNull().default(0),
    // Photo libraries, finding duplicates (lib/photos/dedupe): a 64-bit fingerprint of how the picture looks (16 hex digits), when it was last
    // tried (a failed try leaves the hash empty), and, for a copy an admin chose to hide, the photo that is kept instead. Hiding changes nothing
    // in the storage; a hidden copy is only left out of the timeline and other listings, and can be restored.
    photoHash: text("photo_hash"),
    photoHashAt: timestamp("photo_hash_at", { withTimezone: true }),
    duplicateOf: uuid("duplicate_of").references((): AnyPgColumn => titles.id, { onDelete: "set null" }),
    // Music libraries: which album a track is on, and where on it. Set by the scan from the folder layout
    // (Artist / Album / track) and the file name; null for every other kind of title.
    albumId: uuid("album_id").references((): AnyPgColumn => musicAlbums.id, { onDelete: "set null" }),
    trackNumber: integer("track_number"),
    discNumber: integer("disc_number"),
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
    // When this title's cast was last asked of TMDB (null = not yet); the cast itself is in title_cast.
    castAttemptedAt: timestamp("cast_attempted_at", { withTimezone: true }),
    // The film series TMDB says a movie belongs to ("Alien Collection"), from its details; null when it is not in one. Collections are built
    // from these (lib/collections). collectionAttemptedAt is when it was last looked for (null = not yet).
    collectionTmdbId: integer("collection_tmdb_id"),
    collectionName: text("collection_name"),
    collectionPosterUrl: text("collection_poster_url"),
    collectionAttemptedAt: timestamp("collection_attempted_at", { withTimezone: true }),

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
    // The photo timeline: newest first within a library.
    index("titles_library_taken_idx").on(t.libraryId, t.takenAt.desc(), t.id.desc()),
    // An album's tracks, in order.
    index("titles_album_idx").on(t.albumId, t.discNumber, t.trackNumber),
  ]
);

// ── music_artists / music_albums ─────────────────────────────────────────
// The Artist > Album grouping of a music library, derived from its folder layout (see lib/music). Tracks are
// ordinary titles that point at their album. Names are matched by name_key (lowercase, single spaces) so
// "Abbey Road" and "abbey  road" are one album. Rows are created and removed by the scan, never by hand.
export const musicArtists = pgTable(
  "music_artists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    sortKey: text("sort_key").notNull(),
    // MusicBrainz id, once an album of theirs was matched.
    mbid: text("mbid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("music_artists_library_name_idx").on(t.libraryId, t.nameKey)]
).enableRLS();

export const musicAlbums = pgTable(
  "music_albums",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => musicArtists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    // The earliest year any of its tracks' tags give (or, once matched, the release's); null when none does.
    year: integer("year"),
    // Matching against MusicBrainz: 'pending' until tried, then 'matched' (name, year, track titles and cover came from the
    // release; mbid says which) or 'unmatched' (no clear match after a few tries; the folder names stand).
    mbid: text("mbid"),
    matchStatus: text("match_status").$type<"pending" | "matched" | "unmatched">().notNull().default("pending"),
    matchAttempts: integer("match_attempts").notNull().default(0),
    matchAttemptedAt: timestamp("match_attempted_at", { withTimezone: true }),
    // How many tracks the album had when it was matched; a different count later means files were added or removed, so it is matched again.
    matchedTrackCount: integer("matched_track_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("music_albums_artist_name_idx").on(t.artistId, t.nameKey),
    index("music_albums_library_idx").on(t.libraryId),
  ]
).enableRLS();

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
    source: text("source").notNull().$type<"embedded" | "box" | "online">(),
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
    // Which resolution version of the owner this file belongs to: the label in its name ("1080p", "4k"; see
    // lib/scan/conventions splitVersionLabel), lower case, or '' for a file with none. A movie or episode's rows with the same
    // version_label are the ordered parts of ONE playback; the other versions are alternatives, never appended.
    versionLabel: text("version_label").notNull().default(""),

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
    // Where `chapters` came from: read from the video itself, or from a chapter file beside it ("Movie.chapters.xml"; this wins, and
    // a re-probe leaves it alone). chapters_read_at is set once a video's own chapters have been looked for (found or not), so the
    // backfill reads each already-probed video once.
    chaptersSource: text("chapters_source").$type<"embedded" | "file">(),
    chaptersReadAt: timestamp("chapters_read_at", { withTimezone: true }),
    // Scenes to skip or silence, from a Movie Content Filter file beside the video ("Movie.mcf", see lib/content-filter), timed from the
    // start of this file. Null when there is no such file.
    contentCues: jsonb("content_cues").$type<import("@/lib/content-filter/categories").FilterCue[]>(),
    // Scenes marked by hand in Roam (lib/content-filter/marks), for storage Roam can't write a file to; times from the start of this file.
    // Where it can (Box), the marks go into the .mcf file instead and come back through content_cues.
    markedCues: jsonb("marked_cues").$type<import("@/lib/content-filter/categories").FilterCue[]>(),
    // Words muted because the subtitles say them (lib/content-filter/profanity), built from a subtitle file beside the video or one fetched
    // from OpenSubtitles for this exact file. Kept apart from content_cues so a rescan of the folder never wipes it. Times from this file's start.
    languageCues: jsonb("language_cues").$type<import("@/lib/content-filter/categories").FilterCue[]>(),
    // "srt": a subtitle file beside the video. "opensubtitles": one made for this exact file. "opensubtitles-guess": the best one found for the
    // film, whose timing may be off (a different cut of it).
    // "tried-exact" / "tried-loose": looked for a subtitle and found none usable (so a run does not keep trying); only the strict try is
    // repeated by a loose run.
    languageSource: text("language_source").$type<"srt" | "opensubtitles" | "opensubtitles-guess" | "tried-exact" | "tried-loose">(),
    languageBuiltAt: timestamp("language_built_at", { withTimezone: true }),
    // Intro, recap, credits and preview times marked by hand in Roam (they win over SkipDB's for the same kind); times from this file's start.
    skipMarks: jsonb("skip_marks").$type<{ kind: "intro" | "recap" | "outro" | "preview"; startSeconds: number; endSeconds: number }[]>(),
    // Intro and credits times found by comparing the sound of a season's episodes (scripts/detect-intros.ts); used only where neither a hand mark nor SkipDB has one.
    detectedSkipMarks: jsonb("detected_skip_marks").$type<{ kind: "intro" | "recap" | "outro" | "preview"; startSeconds: number; endSeconds: number }[]>(),
    skipDetectedAt: timestamp("skip_detected_at", { withTimezone: true }),

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
      t.versionLabel,
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

// ── title_cast ───────────────────────────────────────────────────────────
// The billed cast of a movie or show, from TMDB. A person is identified by their TMDB person id, so the same actor links across titles;
// there is no separate people table (the name and photo are copied onto each row).

export const titleCast = pgTable(
  "title_cast",
  {
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull(),
    name: text("name").notNull(),
    character: text("character"),
    photoUrl: text("photo_url"),
    // Billing order: 0 is the top-billed.
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.titleId, t.personId] }), index("title_cast_person_idx").on(t.personId)]
);

// ── title_crew ───────────────────────────────────────────────────────────
// The key crew of a movie or show from TMDB (directors, writers, producers, composer ...), one row per person per job. As with the cast,
// a person is their TMDB person id, so the same director links across titles.

export const titleCrew = pgTable(
  "title_crew",
  {
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull(),
    name: text("name").notNull(),
    job: text("job").notNull(),
    photoUrl: text("photo_url"),
    // Order within the title: by how key the job is, then TMDB's own order.
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.titleId, t.personId, t.job] }), index("title_crew_person_idx").on(t.personId)]
);

// ── tmdb_entries, tmdb_cast, tmdb_crew ───────────────────────────────────
// What TMDB said about a movie, show or season, shared by every server (the first to need it fetches it; the rest read it). TMDB's terms
// ask that what is kept from it is refreshed within six months, so each entry says when it was fetched: a daily job refreshes the oldest,
// and anything that couldn't be refreshed in time is cleared. `kind` is "movie", "tv" or "tv-season" (season = the season number; 0 for
// the others). The cast and crew are rows of their own, keyed by the same (kind, tmdb_id), so a person's page can find their work.

export const tmdbEntries = pgTable(
  "tmdb_entries",
  {
    kind: text("kind").$type<"movie" | "tv" | "tv-season">().notNull(),
    tmdbId: integer("tmdb_id").notNull(),
    season: integer("season").notNull().default(0),
    // Only the parts Roam uses, trimmed on the way in; emptied if the entry could not be refreshed in time.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when TMDB says it no longer has it (a 404), so a refresh stops asking every day.
    missingAt: timestamp("missing_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.tmdbId, t.season] }), index("tmdb_entries_fetched_idx").on(t.fetchedAt)]
);

export const tmdbCast = pgTable(
  "tmdb_cast",
  {
    kind: text("kind").$type<"movie" | "tv">().notNull(),
    tmdbId: integer("tmdb_id").notNull(),
    personId: integer("person_id").notNull(),
    name: text("name").notNull(),
    character: text("character"),
    photoUrl: text("photo_url"),
    // Billing order: 0 is the top-billed.
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.tmdbId, t.personId] }), index("tmdb_cast_person_idx").on(t.personId)]
);

export const tmdbCrew = pgTable(
  "tmdb_crew",
  {
    kind: text("kind").$type<"movie" | "tv">().notNull(),
    tmdbId: integer("tmdb_id").notNull(),
    personId: integer("person_id").notNull(),
    name: text("name").notNull(),
    job: text("job").notNull(),
    photoUrl: text("photo_url"),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.tmdbId, t.personId, t.job] }), index("tmdb_crew_person_idx").on(t.personId)]
);

// ── provider_accounts ────────────────────────────────────────────────────
// A ledger of every outside account (a Dropbox, Google or Microsoft account) ever linked to Roam, kept even after the connection is
// removed. Some services cap how many accounts an unapproved app may link (Dropbox 50, Google 100 for an unverified app), and the
// count that matters is accounts linked, not connections: the same account on two servers is one. `revoked_at` is set when Roam
// unlinked the account at the provider (so it no longer counts there).

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    provider: text("provider").$type<StorageProviderKind>().notNull(),
    // The provider's own id for the account when it gives one, else the email, lower case.
    accountKey: text("account_key").notNull(),
    // What to show (an email address).
    label: text("label").notNull(),
    firstConnectedAt: timestamp("first_connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.provider, t.accountKey] })]
);

// ── platform_jobs ────────────────────────────────────────────────────────
// When each scheduled job last ran and what it did, for the platform admin page.

export const platformJobs = pgTable("platform_jobs", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull().defaultNow(),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
});

// ── ddd_items ────────────────────────────────────────────────────────────
// What Does the Dog Die said about one title, kept only to avoid asking again (their API Terms allow caching for performance and require
// a refresh at least every 30 days; see lib/ddd). One row per title, shared by every server on the deployment's key. Rows older than
// 30 days are deleted by the daily job and never used.

export const dddItems = pgTable("ddd_items", {
  // "imdb:tt0050798" or "tmdb:movie:22660" / "tmdb:tv:1396": how the title was looked up.
  key: text("key").primaryKey(),
  // Their id for the title; null when they have no such title (missing = true).
  dddItemId: integer("ddd_item_id"),
  missing: boolean("missing").notNull().default(false),
  data: jsonb("data").$type<import("@/lib/ddd/types").DddTitleData | import("@/lib/ddd/types").DddReference>(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── ownership ────────────────────────────────────────────────────────────
// One row per household (account) that holds a copy of a movie, book or album, or of one season of a show (`season_id`). `shared` is whether that copy is available to the whole server: an owner
// can withdraw it (and share it again), all or nothing. See lib/ownership.

export const titleOwners = pgTable(
  "title_owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    // For a show, the season that is owned; null for everything else (a show's seasons are owned one by one).
    seasonId: uuid("season_id").references(() => seasons.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    shared: boolean("shared").notNull().default(true),
    // "assigned": the server's admin made them the owner. "claimed": they claimed it and it was accepted.
    via: text("via").$type<"assigned" | "claimed">().notNull(),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("title_owners_whole_idx").on(t.titleId, t.accountId).where(sql`${t.seasonId} is null`),
    uniqueIndex("title_owners_season_idx").on(t.seasonId, t.accountId).where(sql`${t.seasonId} is not null`),
    index("title_owners_account_idx").on(t.accountId),
    index("title_owners_title_idx").on(t.titleId),
  ]
);

// ── ratings ──────────────────────────────────────────────────────────────
// A profile's own rating of a title (movie, show, book, song), an episode or a music album, in half stars: 1 to 10, so 7 is three and a half stars.
// Only that profile sees it. No row = not rated.
export const ratings = pgTable(
  "ratings",
  {
    viewerId: uuid("viewer_id").notNull().references(() => viewers.id, { onDelete: "cascade" }),
    ownerKind: text("owner_kind").$type<"title" | "episode" | "album">().notNull(),
    ownerId: uuid("owner_id").notNull(),
    halfStars: smallint("half_stars").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.viewerId, t.ownerKind, t.ownerId] }), index("ratings_owner_idx").on(t.ownerKind, t.ownerId)]
).enableRLS();

// ── artist_about / album_about ───────────────────────────────────────────
// What Wikipedia says about an artist or album (found through MusicBrainz) and which artists listeners of the artist also play (ListenBrainz),
// looked up the first time someone opens the page and kept. `found` is false when there was nothing (asked again after a week; a find is
// refreshed after a month). `similar` is the artists most like this one: [{ mbid, name, score }].
export const artistAbout = pgTable("artist_about", {
  artistId: uuid("artist_id").primaryKey().references(() => musicArtists.id, { onDelete: "cascade" }),
  found: boolean("found").notNull().default(false),
  summary: text("summary"),
  sourceTitle: text("source_title"),
  sourceUrl: text("source_url"),
  similar: jsonb("similar").$type<{ mbid: string; name: string; score: number }[]>().notNull().default([]),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const albumAbout = pgTable("album_about", {
  albumId: uuid("album_id").primaryKey().references(() => musicAlbums.id, { onDelete: "cascade" }),
  found: boolean("found").notNull().default(false),
  summary: text("summary"),
  sourceTitle: text("source_title"),
  sourceUrl: text("source_url"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── wishlist_items / wishlist_votes ──────────────────────────────────────
// The server's shared wishlist: things members would like the household that buys media to get next (a movie, show, audiobook, book, album...).
// Everyone on the server sees it. `status`: wanted, claimed (someone says they will buy it) or got. `title_key` and `year_key` (0 for no year)
// stop the same thing being listed twice; wanting something already listed is a vote instead.
export const wishlistItems = pgTable(
  "wishlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"movie" | "show" | "audiobook" | "book" | "album" | "other">().notNull(),
    title: text("title").notNull(),
    titleKey: text("title_key").notNull(),
    year: integer("year"),
    yearKey: integer("year_key").notNull().default(0),
    creator: text("creator"),
    tmdbId: integer("tmdb_id"),
    posterUrl: text("poster_url"),
    overview: text("overview"),
    note: text("note"),
    requestedBy: uuid("requested_by").references(() => profiles.id, { onDelete: "set null" }),
    status: text("status").$type<"wanted" | "claimed" | "got">().notNull().default("wanted"),
    claimedBy: uuid("claimed_by").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wishlist_items_unique_idx").on(t.serverId, t.kind, t.titleKey, t.yearKey), index("wishlist_items_server_idx").on(t.serverId, t.status)]
).enableRLS();

export const wishlistVotes = pgTable(
  "wishlist_votes",
  {
    wishId: uuid("wish_id").notNull().references(() => wishlistItems.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wishId, t.accountId] })]
).enableRLS();

// ── watch_activity ───────────────────────────────────────────────────────
// How long each household (an account, never a single profile) spent on each movie, show (its episodes together) or audiobook on each day, for
// the server admin's statistics. Built up from the progress players save while playing; nothing says which profile of the household it was.
export const watchActivity = pgTable(
  "watch_activity",
  {
    serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    seconds: integer("seconds").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.accountId, t.day, t.titleId] }), index("watch_activity_server_day_idx").on(t.serverId, t.day)]
).enableRLS();

// ── labels / label_items ─────────────────────────────────────────────────
// A profile's own tags for movies, shows and books ("Date night", "Christmas"): private to the profile, used to filter lists and smart playlists.
// Two of a profile's labels can't be spelled alike (name_key is the lower-cased name).
export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viewerId: uuid("viewer_id").notNull().references(() => viewers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("labels_viewer_name_idx").on(t.viewerId, t.nameKey)]
).enableRLS();

export const labelItems = pgTable(
  "label_items",
  {
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.labelId, t.titleId] }), index("label_items_title_idx").on(t.titleId)]
).enableRLS();

// ── watch_rooms ──────────────────────────────────────────────────────────
// Watching together: a shared play/pause/position that the members' players follow, for one movie or episode on one server. `position_seconds`
// was true at `state_at`; while playing, the true position moves on from there at `rate`. `members` is who has looked in lately.
export const watchRooms = pgTable(
  "watch_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    ownerKind: ownerKindEnum("owner_kind").notNull(),
    ownerId: uuid("owner_id").notNull(),
    createdBy: uuid("created_by").notNull().references(() => viewers.id, { onDelete: "cascade" }),
    playing: boolean("playing").notNull().default(false),
    positionSeconds: real("position_seconds").notNull().default(0),
    rate: real("rate").notNull().default(1),
    // Counts changes to the shared state, so a player can tell a new change from the one it already has.
    seq: integer("seq").notNull().default(0),
    stateAt: timestamp("state_at", { withTimezone: true }).notNull().defaultNow(),
    members: jsonb("members").$type<Record<string, { name: string; seenAt: string }>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("watch_rooms_server_idx").on(t.serverId)]
).enableRLS();

// ── trakt_links ──────────────────────────────────────────────────────────
// A profile's connection to its Trakt account (trakt.tv), to send what it finishes and rates there and to bring its Trakt history in. The tokens
// are encrypted. Only exists once the server has TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET.
export const traktLinks = pgTable("trakt_links", {
  viewerId: uuid("viewer_id").primaryKey().references(() => viewers.id, { onDelete: "cascade" }),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  username: text("username"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// ── screen_time ──────────────────────────────────────────────────────────
// How long a profile has watched on each day (the day on the clock of the profile's time_zone), for its daily limit.
export const screenTime = pgTable(
  "screen_time",
  {
    viewerId: uuid("viewer_id").notNull().references(() => viewers.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    seconds: integer("seconds").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.viewerId, t.day] })]
).enableRLS();

// ── subtitle_tracks ──────────────────────────────────────────────────────
// Subtitles kept with a movie or episode for everyone who can play it: a file beside the video in storage ("Movie.es.srt": only where it is,
// read when played) or ones the admin saved from OpenSubtitles or a file (the cues are kept, on the whole title's clock).
export const subtitleTracks = pgTable(
  "subtitle_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerKind: ownerKindEnum("owner_kind").notNull(),
    ownerId: uuid("owner_id").notNull(),
    // ISO 639-2 ("spa"); null when the file doesn't say.
    language: text("language"),
    label: text("label").notNull(),
    // "file" (beside the video) or "saved" (cues kept here).
    source: text("source").notNull(),
    storageFileId: text("storage_file_id"),
    sizeBytes: integer("size_bytes"),
    cues: jsonb("cues").$type<[number, number, string][]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subtitle_tracks_owner_idx").on(t.ownerKind, t.ownerId), uniqueIndex("subtitle_tracks_file_idx").on(t.ownerKind, t.ownerId, t.storageFileId)]
).enableRLS();

// ── watchlist_items ──────────────────────────────────────────────────────
// Movies, shows and audiobooks a profile means to get to. Private to the profile; a title drops off once the profile has finished it.
export const watchlistItems = pgTable(
  "watchlist_items",
  {
    viewerId: uuid("viewer_id").notNull().references(() => viewers.id, { onDelete: "cascade" }),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.viewerId, t.titleId] }), index("watchlist_items_title_idx").on(t.titleId)]
).enableRLS();

// ── track_lyrics ─────────────────────────────────────────────────────────
// What LRCLIB (a free, open lyrics service) has for a song, looked up the first time someone asks and kept, including "nothing found" (asked
// again after a month). `synced` is the LRC text with a time on every line; `plain` is the words alone.
export const trackLyrics = pgTable("track_lyrics", {
  titleId: uuid("title_id").primaryKey().references(() => titles.id, { onDelete: "cascade" }),
  synced: text("synced"),
  plain: text("plain"),
  instrumental: boolean("instrumental").notNull().default(false),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  // Lyrics from a ".lrc" or ".txt" file beside the song (Plex's naming) say so, with the file they came from; those are never replaced by a look-up.
  source: text("source").$type<"lrclib" | "file">().notNull().default("lrclib"),
  fileId: text("file_id"),
  fileModifiedAt: timestamp("file_modified_at", { withTimezone: true }),
}).enableRLS();

// ── collections ──────────────────────────────────────────────────────────
// A group of titles in one library shown as one tile: a film series (kind "tmdb": made from the titles' TMDB collection, so it fills and
// empties by itself) or one an admin made by hand (kind "manual"). A collection is only listed to someone who can see at least one of its
// titles (two for a series), and only those titles are shown to them.
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    libraryId: uuid("library_id").notNull().references(() => libraries.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<"tmdb" | "manual">().notNull(),
    tmdbCollectionId: integer("tmdb_collection_id"),
    posterUrl: text("poster_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("collections_tmdb_idx").on(t.libraryId, t.tmdbCollectionId), index("collections_library_idx").on(t.libraryId)]
).enableRLS();

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    // Order inside a hand-made collection (a series is ordered by year).
    position: integer("position").notNull().default(0),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.titleId] }), index("collection_items_title_idx").on(t.titleId)]
).enableRLS();

export type ClaimStatus = "pending" | "evidence_requested" | "evidence_submitted" | "approved" | "rejected";

export const ownershipClaims = pgTable(
  "ownership_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    seasonId: uuid("season_id").references(() => seasons.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    status: text("status").$type<ClaimStatus>().notNull().default("pending"),
    // What the admin said when asking for evidence or turning a claim down.
    adminNote: text("admin_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    // A household has at most one open claim on a title.
    uniqueIndex("ownership_claims_open_idx").on(sql`coalesce(${t.seasonId}, ${t.titleId})`, t.accountId).where(sql`${t.status} in ('pending','evidence_requested','evidence_submitted')`),
    index("ownership_claims_title_idx").on(t.titleId),
  ]
);

// Pictures sent as evidence, kept only until the claim is decided.
export const ownershipEvidence = pgTable("ownership_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  claimId: uuid("claim_id").notNull().references(() => ownershipClaims.id, { onDelete: "cascade" }),
  contentType: text("content_type").notNull(),
  dataBase64: text("data_base64").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Who is playing what right now, for the limit on playing a title at once. A row is a player (one device), kept alive by its heartbeat.
export const playbackSessions = pgTable(
  "playback_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    // What is limited: the movie, the book, the album, or the season of a show being watched.
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    seasonId: uuid("season_id").references(() => seasons.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    viewerId: uuid("viewer_id").notNull().references(() => viewers.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // Set while paused: a paused player keeps its place for a while, then lets go.
    pausedAt: timestamp("paused_at", { withTimezone: true }),
  },
  // A viewer plays one thing at a time, and the same thing on two of their devices counts once.
  (t) => [index("playback_sessions_title_idx").on(t.titleId), uniqueIndex("playback_sessions_viewer_idx").on(t.viewerId)]
);

// "Tell me when a copy is free."
export const availabilityWatches = pgTable(
  "availability_watches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    seasonId: uuid("season_id").references(() => seasons.id, { onDelete: "cascade" }),
    viewerId: uuid("viewer_id").notNull().references(() => viewers.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("availability_watches_unit_viewer_idx").on(sql`coalesce(${t.seasonId}, ${t.titleId})`, t.viewerId)]
);

export type NotificationKind = "claim_waiting" | "claim_approved" | "claim_rejected" | "evidence_requested" | "available";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NotificationKind>().notNull(),
    titleId: uuid("title_id").references(() => titles.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    // Where it leads (a path in the app).
    href: text("href"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_account_idx").on(t.accountId, t.createdAt)]
);

// Browsers that agreed to push notifications (web push).
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint)]
);

// ── title_extras ─────────────────────────────────────────────────────────
// A movie's trailers, behind-the-scenes videos and other extras, found in its folder by Plex's naming (a "-trailer" style suffix on a
// file, or a "Trailers" style subfolder). Each one's video is a media_files row with owner_kind='extra' and owner_id = this row's id,
// so probing and playing work as for any video. Extras never record watch progress.

export const titleExtras = pgTable(
  "title_extras",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    category: text("category").$type<ExtraCategory>().notNull(),
    // Shown name: the file's name without its type suffix and extension.
    name: text("name").notNull(),
    // The video's Box file id: what ties a rescan's file to this row.
    boxFileId: text("box_file_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("title_extras_title_file_idx").on(t.titleId, t.boxFileId), index("title_extras_title_idx").on(t.titleId)]
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
    // A smart playlist fills itself from these rules (see lib/playlists/smart), for the owner; null for an ordinary playlist.
    smartRules: jsonb("smart_rules").$type<Record<string, unknown>>(),
    smartRefreshedAt: timestamp("smart_refreshed_at", { withTimezone: true }),
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

/**
 * A profile's favorite photos and videos (per VIEWER, not account: each profile on a shared account keeps
 * its own). Rows disappear with the viewer or the title. Reads always go through the library access and
 * age filters, so a favorite that later becomes hidden simply stops showing.
 */
export const photoFavorites = pgTable(
  "photo_favorites",
  {
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => viewers.id, { onDelete: "cascade" }),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.viewerId, t.titleId] }),
    // The primary key leads with the viewer; this serves the cascade when a title is deleted.
    index("photo_favorites_title_idx").on(t.titleId),
  ]
).enableRLS();

// ── tv_pairings ──────────────────────────────────────────────────────────
// Signing a TV in without a keyboard: the TV asks for a short code and shows it; the person approves the code on a phone or
// computer where they are already signed in; the TV, which holds a secret only it knows (kept here as a hash), then receives
// a normal session for that account. A row is single-use and short-lived. The IP is kept only as a keyed hash, to bound how
// many codes one address can request.
export const tvPairings = pgTable(
  "tv_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userCode: text("user_code").notNull(),
    deviceHash: text("device_hash").notNull(),
    status: text("status").$type<"pending" | "approved" | "consumed">().notNull().default("pending"),
    accountId: uuid("account_id").references(() => profiles.id, { onDelete: "cascade" }),
    deviceLabel: text("device_label").notNull().default("TV"),
    // A rough place the request came from ("Denver, US"), shown to whoever approves the code so a code relayed from far away stands out.
    locationHint: text("location_hint"),
    ipHash: text("ip_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tv_pairings_user_code_idx").on(t.userCode),
    uniqueIndex("tv_pairings_device_hash_idx").on(t.deviceHash),
    index("tv_pairings_ip_idx").on(t.ipHash, t.createdAt),
    index("tv_pairings_account_idx").on(t.accountId),
  ]
).enableRLS();

// ── device_tokens ────────────────────────────────────────────────────────
// A signed-in app or device (a TV, a phone app, Kodi...): it holds a long random token, of which only a hash is kept. It signs in as
// the account that approved its pairing code, and as one profile of it at a time (`viewer_id`, with that profile's PIN version at the time,
// so changing a PIN signs the profile out). Revoking sets `revoked_at`. See lib/auth/device-token.
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    viewerId: uuid("viewer_id").references(() => viewers.id, { onDelete: "set null" }),
    pinVersion: integer("pin_version").notNull().default(0),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull().default("Device"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // The Firebase Cloud Messaging registration of the app on this device, once it has allowed notifications (null: it hasn't, or the app has none).
    pushToken: text("push_token"),
  },
  (t) => [uniqueIndex("device_tokens_hash_idx").on(t.tokenHash), index("device_tokens_account_idx").on(t.accountId)]
).enableRLS();

// ── viewer_library_speeds ────────────────────────────────────────────────
// The speed (0.25 to 3) a profile's playback starts at in one library; no row = normal speed. Only that profile sees it. A speed picked
// while playing is not saved by itself: it lasts until the player closes, unless the profile chooses to make it their default.
export const viewerLibrarySpeeds = pgTable(
  "viewer_library_speeds",
  {
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => viewers.id, { onDelete: "cascade" }),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    speed: real("speed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.viewerId, t.libraryId] })]
).enableRLS();

// ── photo_people / photo_faces ───────────────────────────────────────────
// Faces in photos. A person is a name a server's admin gave (people belong to the SERVER, not a profile). A face is a box on one picture with a
// numeric fingerprint (a 128-number vector, normalised, stored as 512 bytes) made on the admin's computer by scripts/scan-faces.ts. A face is
// tagged when person_id is set by a person; the machine only ever SUGGESTS (suggested_person_id), until someone confirms it.
export const photoPeople = pgTable(
  "photo_people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("photo_people_server_name_idx").on(t.serverId, sql`lower(${t.name})`)]
).enableRLS();

export const photoFaces = pgTable(
  "photo_faces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id").notNull().references(() => titles.id, { onDelete: "cascade" }),
    // The box on the picture as shown (turned upright), as fractions of its width and height from the top left.
    x: real("x").notNull(),
    y: real("y").notNull(),
    w: real("w").notNull(),
    h: real("h").notNull(),
    score: real("score").notNull(),
    embedding: bytea("embedding").notNull(),
    // A small square JPEG of the face, for lists of people and the viewer's panel.
    thumb: bytea("thumb").notNull(),
    personId: uuid("person_id").references(() => photoPeople.id, { onDelete: "set null" }),
    suggestedPersonId: uuid("suggested_person_id").references(() => photoPeople.id, { onDelete: "set null" }),
    suggestedScore: real("suggested_score"),
    // Marked "not a face" (or not wanted) by an admin: never offered again.
    ignored: boolean("ignored").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("photo_faces_title_idx").on(t.titleId), index("photo_faces_person_idx").on(t.personId), index("photo_faces_suggested_idx").on(t.suggestedPersonId)]
).enableRLS();

// ── feedback_items / feedback_votes / feedback_comments ──────────────────
// Bug reports and feature requests from the people who use this deployment, and the board where requests can be voted on. A report is private to
// its author and the platform admin until the admin (or, for a feature request, the author's choice at the start) makes it public. `diagnostics`
// (the page, browser and app version the author chose to send) is only ever shown to the platform admin. A GitHub issue may be kept in step
// (`github_*`); nothing identifying the author is ever sent there.
export const feedbackItems = pgTable(
  "feedback_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<"bug" | "feature">().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").$type<"new" | "planned" | "in_progress" | "done" | "declined" | "duplicate">().notNull().default("new"),
    visibility: text("visibility").$type<"private" | "public">().notNull().default("private"),
    authorId: uuid("author_id").references(() => profiles.id, { onDelete: "set null" }),
    // The server the author was in, for the admin's context.
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
    diagnostics: jsonb("diagnostics").$type<Record<string, string | number | boolean | null>>(),
    // For a duplicate: the report it is the same as.
    duplicateOf: uuid("duplicate_of").references((): AnyPgColumn => feedbackItems.id, { onDelete: "set null" }),
    githubIssueNumber: integer("github_issue_number"),
    githubIssueUrl: text("github_issue_url"),
    githubError: text("github_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feedback_items_visibility_idx").on(t.visibility, t.kind, t.createdAt), index("feedback_items_author_idx").on(t.authorId)]
).enableRLS();

export const feedbackVotes = pgTable(
  "feedback_votes",
  {
    itemId: uuid("item_id").notNull().references(() => feedbackItems.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.accountId] })]
).enableRLS();

export const feedbackComments = pgTable(
  "feedback_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id").notNull().references(() => feedbackItems.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => profiles.id, { onDelete: "set null" }),
    // A reply from the platform admin, shown as "Roam team" rather than by name.
    official: boolean("official").notNull().default(false),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feedback_comments_item_idx").on(t.itemId, t.createdAt)]
).enableRLS();
