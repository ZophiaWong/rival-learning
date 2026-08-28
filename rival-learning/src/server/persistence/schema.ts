import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const preparationProfiles = sqliteTable("preparation_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  resume: text("resume").notNull().default(""),
  projectNotes: text("project_notes").notNull().default(""),
  jobDescription: text("job_description").notNull().default(""),
  targetRole: text("target_role").notNull(),
  targetLevel: text("target_level").notNull(),
  repoPath: text("repo_path"),
  contentHash: text("content_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const providerViews = sqliteTable(
  "provider_views",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => preparationProfiles.id, { onDelete: "cascade" }),
    sourceContentHash: text("source_content_hash").notNull(),
    redactionVersion: text("redaction_version").notNull(),
    contentJson: text("content_json").notNull(),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("provider_views_profile_content_version_unique").on(
      table.profileId,
      table.sourceContentHash,
      table.redactionVersion,
    ),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    sourceProfileId: text("source_profile_id").references(() => preparationProfiles.id, {
      onDelete: "set null",
    }),
    profileSnapshotJson: text("profile_snapshot_json").notNull(),
    providerViewJson: text("provider_view_json").notNull(),
    redactionVersion: text("redaction_version").notNull(),
    status: text("status").notNull(),
    stateJson: text("state_json").notNull(),
    version: integer("version").notNull().default(0),
    operationToken: text("operation_token"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("sessions_operation_token_unique").on(table.operationToken)],
);

export const sessionTimeline = sqliteTable(
  "session_timeline",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("session_timeline_session_sequence_unique").on(
      table.sessionId,
      table.sequence,
    ),
  ],
);

export const idempotencyResults = sqliteTable(
  "idempotency_results",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.idempotencyKey] })],
);
