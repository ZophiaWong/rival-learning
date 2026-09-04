import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function migrateDatabase(databasePath: string): void {
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });

  const sqlite = new Database(databasePath);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    migrate(drizzle(sqlite), { migrationsFolder: resolve("drizzle") });
    sqlite.transaction(() => {
      const legacySessionPredicate =
        "json_valid(state_json) = 0 OR json_extract(state_json, '$.stateVersion') IS NULL";
      sqlite
        .prepare(
          `delete from idempotency_results where session_id in
           (select id from sessions where ${legacySessionPredicate})`,
        )
        .run();
      sqlite
        .prepare(
          `delete from session_timeline where session_id in
           (select id from sessions where ${legacySessionPredicate})`,
        )
        .run();
      sqlite.prepare(`delete from sessions where ${legacySessionPredicate}`).run();
    })();
  } finally {
    sqlite.close();
  }
}
