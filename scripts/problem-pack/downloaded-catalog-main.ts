import { resolve } from "node:path";
import { selectedCatalogRoots } from "./catalog-read.js";
import {
  downloadConfiguredCatalog,
  downloadLockedCatalog,
  materializeCatalog,
  verifyCatalogLock,
} from "./downloaded-catalog.js";

const [command, config] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../..");
if (command === "download" && config) downloadConfiguredCatalog(root, config);
else if (command === "download-locked" && !config) downloadLockedCatalog(root);
else if (command === "prepare" && !config) materializeCatalog(root);
else if (command === "validate" && !config) selectedCatalogRoots(root);
else if (command === "verify-lock" && !config) verifyCatalogLock(root);
else
  throw new Error(
    "Usage: bun run catalog download <sources.json> | bun run catalog download-locked | bun run catalog prepare | bun run catalog validate | bun run catalog verify-lock",
  );
