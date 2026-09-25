import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import {
  assertHostingModule,
  narrowCatalog,
  publicMetadata,
} from "../../scripts/local-host/browser-metadata";
import baseConfig from "./vite.config";
// Keep the normal app's React, plugin-version and asset pipelines. Only this
// explicit entry, its build output and the local-host build constant differ: the entry is the
// normal console (`src/main.tsx`), which reads the host's same-origin API in this build only.
export default mergeConfig(baseConfig, {
  publicDir: false,
  // A private build constant, not a VITE_* variable: an exported environment variable cannot
  // switch a cloud build into local-host mode (src/local-host-build.ts).
  define: { __TENKACLOUD_LOCAL_HOST_BUILD__: "true" },
  plugins: [
    {
      name: "local-host-catalog-boundary",
      enforce: "pre",
      generateBundle() {
        for (const id of this.getModuleIds()) assertHostingModule(id);
      },
      transform(code: string, id: string) {
        return narrowCatalog(code, id) ?? publicMetadata(code, id);
      },
    },
  ],
  build: {
    outDir: fileURLToPath(
      new URL("../../.tenkacloud/host-build/application-admin-console", import.meta.url),
    ),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: fileURLToPath(new URL("./host.html", import.meta.url)) },
  },
});
