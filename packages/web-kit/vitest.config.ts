import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vitest/config";

// design-system / i18n は React component なので jsdom + testing-library setup を要する
// (SPA 側 vite.config.ts の test ブロックと同形)。 plugin-react-swc は SPA と同じ SWC 変換で、
// `/* v8 ignore next */` コメントを保持する (esbuild 既定の変換は剥がしてしまう) ため必須。
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    exclude: ["node_modules", "dist"],
  },
});
