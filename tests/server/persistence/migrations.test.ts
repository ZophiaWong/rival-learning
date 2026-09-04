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

  it("removes legacy Sessions and their dependent facts while preserving Profiles and ProviderViews", () => {
    const directory = mkdtempSync(join(tmpdir(), "rival-learning-step2-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "app.db");
    migrateDatabase(databasePath);

    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    const timestamp = Date.now();
    database
      .prepare(
        `insert into preparation_profiles
          (id, name, resume, project_notes, job_description, target_role, target_level,
           content_hash, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "profile-legacy",
        "Preserved profile",
        "Resume",
        "",
        "JD",
        "Engineer",
        "Senior",
        "hash",
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `insert into provider_views
          (id, profile_id, source_content_hash, redaction_version, content_json,
           confirmed_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "view-legacy",
        "profile-legacy",
        "hash",
        "contact-v1",
        "{}",
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `insert into sessions
          (id, source_profile_id, profile_snapshot_json, provider_view_json, redaction_version,
           status, state_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session-legacy",
        "profile-legacy",
        "{}",
        "{}",
        "contact-v1",
        "draft",
        '{"plan":null}',
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `insert into session_timeline
          (session_id, sequence, event_type, payload_json, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run("session-legacy", 1, "session_created", "{}", timestamp);
    database
      .prepare(
        `insert into idempotency_results
          (session_id, idempotency_key, command_type, command_fingerprint, result_json, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session-legacy",
        "create-legacy",
        "create_session",
        "fingerprint",
        '{"status":"applied"}',
        timestamp,
      );
    const latestMigration = database
      .prepare("select id from __drizzle_migrations order by created_at desc limit 1")
      .get() as { id: number };
    database.prepare("delete from __drizzle_migrations where id = ?").run(latestMigration.id);
    database.close();

    migrateDatabase(databasePath);

    const verified = new Database(databasePath, { readonly: true });
    expect(verified.prepare("select count(*) as count from sessions").get()).toEqual({ count: 0 });
    expect(verified.prepare("select count(*) as count from session_timeline").get()).toEqual({ count: 0 });
    expect(verified.prepare("select count(*) as count from idempotency_results").get()).toEqual({ count: 0 });
    expect(verified.prepare("select count(*) as count from preparation_profiles").get()).toEqual({ count: 1 });
    expect(verified.prepare("select count(*) as count from provider_views").get()).toEqual({ count: 1 });
    verified.close();
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

  it("preserves command results without a Session while rejecting orphan domain rows and duplicate operation tokens", () => {
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

    database
      .prepare(
        `insert into idempotency_results
          (session_id, idempotency_key, command_type, command_fingerprint, result_json, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "not-yet-created-session",
        "create-1",
        "create_session",
        "synthetic-fingerprint",
        '{"status":"rejected"}',
        timestamp,
      );
    expect(
      database
        .prepare("select count(*) as count from idempotency_results where session_id = ?")
        .get("not-yet-created-session"),
    ).toEqual({ count: 1 });

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
