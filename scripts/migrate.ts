import { parseServerConfig } from "../src/server/config/server-config";
import { migrateDatabase } from "../src/server/persistence/migrate";

const config = parseServerConfig(process.env);
migrateDatabase(config.databasePath);

console.log(`Database migrated at ${config.databasePath}`);
