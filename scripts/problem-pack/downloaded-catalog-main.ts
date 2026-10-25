import { resolve } from "node:path";
import { logCatalogImport } from "./catalog-import-log.js";
import { selectedCatalogRoots } from "./catalog-read.js";
import { downloadConfiguredCatalog, materializeCatalog } from "./downloaded-catalog.js";

const [command, config] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../..");
if (command === "download" && config)
  logCatalogImport(() => downloadConfiguredCatalog(root, config));
else if (command === "prepare" && !config) materializeCatalog(root);
else if (command === "validate" && !config) selectedCatalogRoots(root);
else
  throw new Error(
    "Usage: bun run catalog download <sources.json> | bun run catalog prepare | bun run catalog validate",
  );
