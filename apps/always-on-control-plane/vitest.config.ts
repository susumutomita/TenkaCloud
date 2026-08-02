import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          // The deployed environments ship an unusable placeholder on purpose,
          // so the suite configures the canonical origin its requests use.
          MCP_CANONICAL_ORIGIN: "https://control.example",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
