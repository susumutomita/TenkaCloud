import react from "@vitejs/plugin-react-swc";
import { createLogger, defineConfig, type Plugin } from "vite";
import { codespacesForwardedOrigin } from "../../scripts/local-play/codespaces-origin";
import { stripProblemWriteupsPlugin } from "./build/strip-problem-writeups";
import { createLocalApiProxyMiddleware } from "./local-play-proxy";

// 他 app と同じく Vite 7 の vite:react-swc deprecation warning を抑制する。
const logger = createLogger();
const originalWarn = logger.warn;
logger.warn = (msg, opts) => {
  if (msg.includes('"vite:react-swc"') && msg.includes("optimizeDeps.esbuildOptions")) return;
  originalWarn(msg, opts);
};

function localApiProxyPlugin(): Plugin {
  return {
    name: "tenkacloud-local-api-proxy",
    configureServer(server) {
      if (!codespacesForwardedOrigin(5175)) return;
      server.middlewares.use(createLocalApiProxyMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [stripProblemWriteupsPlugin(), localApiProxyPlugin(), react()],
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
          cloudscape: ["@cloudscape-design/components", "@cloudscape-design/global-styles"],
          react: ["react", "react-dom", "react-router"],
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
