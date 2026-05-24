import { defineConfig } from "vitest/config";

// auth-client は browser-only (sessionStorage / window.location / crypto.subtle 依存) なので
// jsdom 環境で動かす。 globals は使わず import { describe, expect, it } 明示派 (= packages/
// trust-bridge と同 style)。
export default defineConfig({
  test: {
    environment: "jsdom",
    exclude: ["node_modules", "dist"],
  },
});
