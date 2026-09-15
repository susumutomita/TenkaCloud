import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import { assertHostingModule, narrowCatalog, publicMetadata } from "../../scripts/local-host/browser-metadata";
import baseConfig from "./vite.config";
// Keep the normal app's React, plugin-version and asset pipelines. Only this
// explicit entry and build output differ; no cloud/practice configuration changes.
export default mergeConfig(
  baseConfig,
  {
    publicDir: false,
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
      }
    ],
    build: {
      outDir: fileURLToPath(new URL("../../.tenkacloud/host-build/application-admin-console", import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: fileURLToPath(new URL("./host.html", import.meta.url)) },
    },
  }
);
