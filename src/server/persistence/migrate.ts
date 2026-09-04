import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";

export const DATABASE_EPOCH = 3;
export const DATABASE_RESET_CONFIRMATION = "--confirm-reset";

const APPLICATION_TABLES = [
  "preparation_profiles",
  "provider_views",
  "sessions",
  "session_timeline",
  "idempotency_results",
] as const;

export class DatabaseResetRequiredError extends Error {
  readonly code = "database_reset_required";

  constructor(
    readonly databasePath: string,
    readonly actualEpoch: number,
  ) {
    super(
      `Database epoch ${actualEpoch} is incompatible with epoch ${DATABASE_EPOCH}. ` +
        `Run pnpm db:reset -- --confirm-reset to recreate ${databasePath}.`,
    );
    this.name = "DatabaseResetRequiredError";
  }
}

export class DatabaseResetConfirmationError extends Error {
  readonly code = "database_reset_confirmation_required";

  constructor() {
    super(`Database reset requires the exact confirmation token ${DATABASE_RESET_CONFIRMATION}.`);
    this.name = "DatabaseResetConfirmationError";
  }
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(
    sqlite
      .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
      .get(table),
  );
}

function hasApplicationData(sqlite: Database.Database): boolean {
  return APPLICATION_TABLES.some(
    (table) =>
      tableExists(sqlite, table) &&
      Boolean(sqlite.prepare(`select 1 from ${table} limit 1`).get()),
  );
}

function resolvedDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:") {
    throw new Error("The persistent application database cannot use :memory:.");
  }
  const resolved = resolve(databasePath);
  if (parse(resolved).root === resolved) {
    throw new Error("Refusing to use a filesystem root as the application database path.");
  }
  if (existsSync(resolved) && !lstatSync(resolved).isFile()) {
    throw new Error(`Application database path is not a file: ${resolved}`);
  }
  return resolved;
}

export function migrateDatabase(databasePath: string): void {
  const resolvedPath = resolvedDatabasePath(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    const actualEpoch = sqlite.pragma("user_version", { simple: true }) as number;
    if (actualEpoch !== DATABASE_EPOCH && hasApplicationData(sqlite)) {
      throw new DatabaseResetRequiredError(resolvedPath, actualEpoch);
    }
    migrate(drizzle(sqlite), { migrationsFolder: resolve("drizzle") });
    sqlite.pragma(`user_version = ${DATABASE_EPOCH}`);
  } finally {
    sqlite.close();
  }
}

export function resetDatabase(databasePath: string, confirmation: string | undefined): string {
  if (confirmation !== DATABASE_RESET_CONFIRMATION) {
    throw new DatabaseResetConfirmationError();
  }
  const resolvedPath = resolvedDatabasePath(databasePath);
  for (const path of [
    resolvedPath,
    `${resolvedPath}-wal`,
    `${resolvedPath}-shm`,
    `${resolvedPath}-journal`,
  ]) {
    rmSync(path, { force: true });
  }
  migrateDatabase(resolvedPath);
  return resolvedPath;
}
