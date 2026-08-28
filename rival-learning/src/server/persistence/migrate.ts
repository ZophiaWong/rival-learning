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
  } finally {
    sqlite.close();
  }
}
