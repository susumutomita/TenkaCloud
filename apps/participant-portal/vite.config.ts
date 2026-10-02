import react from "@vitejs/plugin-react-swc";
import { createLogger, defineConfig } from "vite";
import { pluginVersionsPlugin } from "./build/plugin-versions";
import { problemCatalogPlugin } from "./build/problem-catalog";
import { stripProblemWriteupsPlugin } from "./build/strip-problem-writeups";

// 他 app と同じく Vite 7 の vite:react-swc deprecation warning を抑制する。
const logger = createLogger();
const originalWarn = logger.warn;
logger.warn = (msg, opts) => {
  if (msg.includes('"vite:react-swc"') && msg.includes("optimizeDeps.esbuildOptions")) return;
  originalWarn(msg, opts);
};

export default defineConfig({
  plugins: [stripProblemWriteupsPlugin(), problemCatalogPlugin(), react(), pluginVersionsPlugin()],
  customLogger: logger,
  // admin-console (5173) / application-admin-console (5174) と並走できるよう別ポート。
  server: {
    port: 5175,
    strictPort: true,
    // Challenge ports are separate origins and must not read runtime-config or portal storage.
    cors: false,
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client", "react-router"],
          cloudscape: ["@cloudscape-design/components", "@cloudscape-design/global-styles"],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    exclude: ["node_modules", "dist"],
    /**
     * Issue #2946: vitest 既定の 5000ms は、 この workspace の interaction test には合って
     * いない。 参加者導線の test は 1 本で 6 段階の user interaction を Cloudscape の木に
     * 対して直列に流す。 実測 (idle, 4 core) で最も重い部類が約 1.1s、 その内訳の約 54% は
     * jsdom の `getComputedStyle` で、 testing-library の role query が要素ごとに呼ぶ分である。
     * jsdom は DOM が変わるたび document 単位の computed-style cache を捨てるので、 React が
     * 再 render するたびに全部が cold になる — test 側でも製品側でも削れない下限コスト。
     *
     * 5000ms は idle 比 4.5 倍しか無く、 vitest が file を並列に流すだけで超えていた。
     * 15000ms は idle 比 約 13 倍で、 「並列実行で遅い」 と 「本当に固まっている」 を
     * 区別できる範囲に置いている。 遅さ自体は timeout ではなく #2946 の render 修正
     * (打鍵コストを checkpoint 数に比例させない) で先に潰してある。
     */
    testTimeout: 15_000,
  },
});
