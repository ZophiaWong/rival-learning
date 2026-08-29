import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/persistence/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.RIVAL_DATABASE_PATH ?? ".data/rival-learning.db",
  },
});
