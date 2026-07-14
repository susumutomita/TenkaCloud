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
  },
});
