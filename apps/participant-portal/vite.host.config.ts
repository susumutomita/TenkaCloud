import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import {
  assertHostingModule,
  narrowCatalog,
  publicMetadata,
} from "../../scripts/local-host/browser-metadata";
import baseConfig from "./vite.config";

// The host boundary must strip pre-start content before either catalog projection.
const hostCatalogBoundary: Plugin = {
  name: "local-host-catalog-boundary",
  enforce: "pre",
  generateBundle() {
    for (const id of this.getModuleIds()) assertHostingModule(id);
  },
  transform(code: string, id: string) {
    return narrowCatalog(code, id) ?? publicMetadata(code, id);
  },
};

// Keep the normal app's React, plugin-version and asset pipelines. Only this
// explicit entry and build output differ; no cloud/practice configuration changes.
export default mergeConfig(
  { ...baseConfig, plugins: [hostCatalogBoundary, ...(baseConfig.plugins ?? [])] },
  {
    publicDir: false,
    build: {
      outDir: fileURLToPath(
        new URL("../../.tenkacloud/host-build/participant-portal", import.meta.url),
      ),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: fileURLToPath(new URL("./host.html", import.meta.url)) },
    },
  },
);
