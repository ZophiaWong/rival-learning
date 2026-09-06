import { parseServerConfig } from "../src/server/config/server-config";
import {
  DATABASE_RESET_CONFIRMATION,
  resetDatabase,
} from "../src/server/persistence/migrate";

const config = parseServerConfig(process.env);
const confirmation = process.argv.slice(2).find(
  (argument) => argument === DATABASE_RESET_CONFIRMATION,
);
const databasePath = resetDatabase(config.databasePath, confirmation);

console.log(`Database reset and migrated at ${databasePath}`);
