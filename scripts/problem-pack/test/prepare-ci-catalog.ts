import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CatalogLockSchema, lockPath } from "../catalog-read";
import { downloadCatalog, materializeCatalog } from "../downloaded-catalog";

const fixtureRoot = join(import.meta.dirname, "fixtures/ci-catalog");

function materialize(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = join(source, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error("CI fixture must not contain links");
    if (entry.isDirectory()) materialize(path, join(destination, entry.name));
    else if (entry.isFile() && entry.name.endsWith(".fixture"))
      writeFileSync(join(destination, entry.name.slice(0, -".fixture".length)), readFileSync(path));
  }
}

function addFixtureReadmes(directory: string): void {
  for (const category of ["challenges", "battles"]) {
    if (!existsSync(join(directory, category))) continue;
    for (const id of readdirSync(join(directory, category)))
      for (const filename of ["README.md", "README.ja.md"])
        writeFileSync(
          join(directory, category, id, filename),
          `# ${id}\n\nPlatform test fixture.\n`,
        );
  }
}

/** Explicit CI/test preparation, never a runtime catalog fallback or upstream sync. */
export function prepareCiCatalog(root: string): void {
  const inputs = join(root, ".tenkacloud/ci-catalog-inputs");
  if (existsSync(lockPath(root))) {
    const selected = CatalogLockSchema.parse(JSON.parse(readFileSync(lockPath(root), "utf8")));
    if (
      [...selected.sources, ...(selected.retained ?? [])].some(
        (source) =>
          !("path" in source) ||
          ![join(inputs, "current"), join(inputs, "retained")].includes(source.path),
      )
    )
      throw new Error("Refusing to replace a non-fixture catalog selection");
  }
  rmSync(inputs, { recursive: true, force: true });
  materialize(join(fixtureRoot, "current"), join(inputs, "current"));
  // The historical alias uses the same engine inputs; record only its differing metadata.
  cpSync(
    join(inputs, "current/battles/crypto-battle"),
    join(inputs, "retained/battles/ac26-crypto-battle"),
    { recursive: true },
  );
  materialize(join(fixtureRoot, "retained"), join(inputs, "retained"));
  for (const edition of ["retained", "current"]) {
    const directory = join(inputs, edition);
    addFixtureReadmes(directory);
    downloadCatalog(root, { schemaVersion: 1, sources: [{ path: directory }] });
  }
  materializeCatalog(root);
}

if (import.meta.main) {
  if (process.env.CI !== "true") throw new Error("Offline fixture preparation is CI-only");
  prepareCiCatalog(resolve(dirname(import.meta.filename), "../../.."));
}
