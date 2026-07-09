import react from "@vitejs/plugin-react-swc";
import type { Plugin, ViteDevServer } from "vite";
import { createLogger, defineConfig } from "vite";
import { stripProblemWriteupsPlugin } from "./build/strip-problem-writeups";
import { createLocalChallengeProxyMiddleware } from "./local-play-proxy";

// 他 app と同じく Vite 7 の vite:react-swc deprecation warning を抑制する。
const logger = createLogger();
const originalWarn = logger.warn;
logger.warn = (msg, opts) => {
  if (msg.includes('"vite:react-swc"') && msg.includes("optimizeDeps.esbuildOptions")) return;
  originalWarn(msg, opts);
};

const LOCAL_API_PROXY_PREFIX = "/__tenkacloud-local-api";

function localChallengeProxyPlugin(): Plugin {
  return {
    name: "tenkacloud-local-challenge-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(createLocalChallengeProxyMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [localChallengeProxyPlugin(), stripProblemWriteupsPlugin(), react()],
  customLogger: logger,
  // admin-console (5173) / application-admin-console (5174) と並走できるよう別ポート。
  server: {
    port: 5175,
    proxy: {
      [LOCAL_API_PROXY_PREFIX]: {
        target: "http://127.0.0.1:3199",
        changeOrigin: false,
        rewrite: (path) => path.replace(new RegExp(`^${LOCAL_API_PROXY_PREFIX}`), ""),
      },
    },
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
  },
});
