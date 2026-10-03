import react from "@vitejs/plugin-react-swc";
import { createLogger, defineConfig } from "vite";
import { catalogProjection } from "./catalog-projection";

// admin-console と同じく Vite 7 の "vite:react-swc" 由来 deprecation warning を抑制する。
// プラグイン側が新 API に追従したら不要。
const logger = createLogger();
const originalWarn = logger.warn;
logger.warn = (msg, opts) => {
  if (msg.includes('"vite:react-swc"') && msg.includes("optimizeDeps.esbuildOptions")) return;
  originalWarn(msg, opts);
};

export default defineConfig({
  plugins: [react(), catalogProjection()],
  customLogger: logger,
  // admin-console (5173) と並走できるよう別ポート。
  server: { port: 5174 },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          // Claim React's renderer before Cloudscape claims shared transitive dependencies.
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
  },
});
