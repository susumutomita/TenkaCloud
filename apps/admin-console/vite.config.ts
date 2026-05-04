import react from "@vitejs/plugin-react-swc";
import { createLogger, defineConfig } from "vite";

// Vite 7 is transitioning from esbuild to rolldown/oxc. @vitejs/plugin-react-swc
// still references the old `optimizeDeps.esbuildOptions` name, which Vite
// flags as deprecated on every run. The plugin itself is correct for our use;
// this silences the upstream noise until the plugin catches up.
const logger = createLogger();
const originalWarn = logger.warn;
logger.warn = (msg, opts) => {
  if (msg.includes('"vite:react-swc"') && msg.includes("optimizeDeps.esbuildOptions")) return;
  originalWarn(msg, opts);
};

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
  server: { port: 5173 },
  build: {
    // Cloudscape は ~1MB 級の design system なので独立 vendor chunk に分離。
    // 初回だけ重いが、以降はブラウザキャッシュが効く。
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
