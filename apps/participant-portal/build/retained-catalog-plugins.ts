import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { retainedCatalogRoots } from "../../../scripts/problem-pack/catalog-read.js";
import { reviewedCoordinationPaths } from "../../../scripts/local-host/coordination-catalog.js";

/** Ordinary Cloud builds also carry exact older native UI editions for pinned event views. */
export function retainedCatalogPlugins(): Plugin {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  let hosted = false;
  return {
    name: "tenkacloud-retained-catalog-plugins",
    enforce: "pre",
    configResolved(config) {
      hosted = config.plugins.some((plugin) => plugin.name === "local-host-catalog-boundary");
    },
    transform(code, id) {
      if (hosted) return null;
      if (!id.replaceAll("\\", "/").endsWith("/src/plugins/loader.ts")) return null;
      const original =
        /import\.meta\.glob(<[^;]*?>)?\(\s*"([^"]*problems\/\*\/\*\/portal\/\*\.tsx)"\s*,?\s*\)/u;
      if (!original.test(code))
        throw new Error("Portal plugin glob changed; review retained catalog compilation");
      const paths = retainedCatalogRoots(repositoryRoot).map(
        (root) =>
          `${relative(dirname(id), resolve(root)).replaceAll("\\", "/")}/{${reviewedCoordinationPaths.join(",")}}/portal/*.tsx`,
      );
      return code.replace(
        original,
        (_match, type: string | undefined, path: string) =>
          `import.meta.glob${type ?? ""}(${JSON.stringify([path, ...paths])}, {exhaustive:true})`,
      );
    },
  };
}
