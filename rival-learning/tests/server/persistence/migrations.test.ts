import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase } from "@/server/persistence/migrate";

describe("database migration interface", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates the foundation schema and can be applied repeatedly", () => {
    const directory = mkdtempSync(join(tmpdir(), "rival-learning-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "app.db");

    migrateDatabase(databasePath);
    migrateDatabase(databasePath);

    const database = new Database(databasePath, { readonly: true });
    const tables = database
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name <> '__drizzle_migrations' order by name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    database.close();

    expect(tables).toEqual([
      "idempotency_results",
      "preparation_profiles",
      "provider_views",
      "session_timeline",
      "sessions",
    ]);
  });

  it("keeps committed timeline events immutable", () => {
    const directory = mkdtempSync(join(tmpdir(), "rival-learning-timeline-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "app.db");
    migrateDatabase(databasePath);

    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    const timestamp = Date.now();
    database
      .prepare(
        `insert into preparation_profiles
          (id, name, resume, project_notes, job_description, target_role, target_level, content_hash, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "profile-1",
        "Backend profile",
        "Resume",
        "",
        "JD",
        "Backend Engineer",
        "Senior",
        "content-hash",
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `insert into sessions
          (id, source_profile_id, profile_snapshot_json, provider_view_json, redaction_version, status, state_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session-1",
        "profile-1",
        "{}",
        "{}",
        "contact-v1",
        "draft",
        "{}",
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `insert into session_timeline
          (session_id, sequence, event_type, payload_json, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run("session-1", 1, "session_created", "{}", timestamp);

    expect(() =>
      database
        .prepare("update session_timeline set payload_json = ? where session_id = ?")
        .run('{"changed":true}', "session-1"),
    ).toThrow(/immutable/i);

    database.close();
  });

  it("rejects orphan rows and duplicate active operation tokens", () => {
    const directory = mkdtempSync(join(tmpdir(), "rival-learning-constraints-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "app.db");
    migrateDatabase(databasePath);

    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    const timestamp = Date.now();

    expect(() =>
      database
        .prepare(
          `insert into provider_views
            (id, profile_id, source_content_hash, redaction_version, content_json, created_at)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run("view-orphan", "missing-profile", "hash", "contact-v1", "{}", timestamp),
    ).toThrow(/foreign key/i);

    expect(() =>
      database
        .prepare(
          `insert into session_timeline
            (session_id, sequence, event_type, payload_json, created_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run("missing-session", 1, "session_created", "{}", timestamp),
    ).toThrow(/foreign key/i);

    const insertSession = database.prepare(
      `insert into sessions
        (id, profile_snapshot_json, provider_view_json, redaction_version, status, state_json,
         operation_token, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSession.run(
      "session-1",
      "{}",
      "{}",
      "contact-v1",
      "planning",
      "{}",
      "operation-1",
      timestamp,
      timestamp,
    );
    expect(() =>
      insertSession.run(
        "session-2",
        "{}",
        "{}",
        "contact-v1",
        "planning",
        "{}",
        "operation-1",
        timestamp,
        timestamp,
      ),
    ).toThrow(/unique/i);

    database.close();
  });
});
