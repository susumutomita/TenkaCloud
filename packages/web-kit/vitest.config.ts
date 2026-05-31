import { defineConfig } from "vitest/config";

// design-system は React component なので jsdom + testing-library setup を要する
// (SPA 側 vite.config.ts の test ブロックと同形)。
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    exclude: ["node_modules", "dist"],
  },
});
