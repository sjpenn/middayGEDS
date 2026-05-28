import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  // Must match the runtime drizzle() client (packages/db/src/client.ts), which
  // sets casing: "snake_case". Without this, `drizzle-kit push` creates columns
  // from the literal camelCase JS keys (e.g. baseBalance) while queries look for
  // snake_case (base_balance) -> "column does not exist" at runtime.
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_SESSION_POOLER!,
  },
} satisfies Config;
