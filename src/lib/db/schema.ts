import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Enums ────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["admin", "viewer"]);
export const libraryKindEnum = pgEnum("library_kind", ["movies", "shows"]);
export const titleKindEnum = pgEnum("title_kind", ["movie", "show"]);
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("libraries_server_idx").on(t.serverId)]
);

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
  ]
);

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
    ownerKind: ownerKindEnum("owner_kind").notNull(),
    ownerId: uuid("owner_id").notNull(),
    partIndex: integer("part_index").notNull().default(0),

    boxFileId: text("box_file_id").notNull().unique(),
    filename: text("filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    durationSeconds: integer("duration_seconds"),

    container: text("container"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    width: integer("width"),
    height: integer("height"),
    probeStatus: probeStatusEnum("probe_status").notNull().default("pending"),

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
  ]
);

// ── watch_state ──────────────────────────────────────────────────────────
// Resume position + continue-watching, always expressed in the GLOBAL
// timeline (sum across ordered media_files), never a per-segment offset.

export const watchState = pgTable(
  "watch_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
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
    uniqueIndex("watch_state_profile_owner_idx").on(
      t.profileId,
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
  (t) => [index("invites_server_idx").on(t.serverId)]
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
  profile: one(profiles, {
    fields: [watchState.profileId],
    references: [profiles.id],
  }),
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
