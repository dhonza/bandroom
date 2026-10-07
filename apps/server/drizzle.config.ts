import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "../../packages/server-core/src/db/schema.ts",
  out: "./drizzle",
});
