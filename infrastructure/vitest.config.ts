import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
    exclude: ["node_modules", "dist", "cdk.out", "cdk.out.test"],
  },
});
