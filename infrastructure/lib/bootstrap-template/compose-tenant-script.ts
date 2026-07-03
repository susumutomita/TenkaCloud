import * as fs from "node:fs";

/**
 * [#2217] The tenant provision/deprovision ScriptJob scripts share an identical
 * source-bundle fetch preamble (resolve account/region, read the injected bucket
 * name, download + unzip `source.zip`). It cannot be `source`d at runtime because
 * that fetch is what downloads the bundle that would contain the shared file
 * (chicken-and-egg). So the shared snippet (`scripts/lib/fetch-source-bundle.sh`)
 * is INLINED at synth time, replacing a marker line in each script, keeping the
 * fetch logic in one place.
 */

/** The exact marker line each tenant script carries where the fetch snippet goes. */
export const FETCH_SOURCE_BUNDLE_MARKER = "# @@INJECT:fetch-source-bundle@@";

/** Path to the shared fetch snippet, relative to the CDK app cwd (`infrastructure/`). */
const FETCH_SNIPPET_PATH = "../scripts/lib/fetch-source-bundle.sh";

/**
 * Read a tenant ScriptJob script and inline the shared fetch snippet at its marker.
 * Throws (fail-loud, no silent no-op) if the marker is absent — a missing marker
 * would otherwise ship a script that never downloads the source bundle.
 */
export function composeTenantScript(
  scriptPath: string,
  readFile: (path: string) => string = (p) => fs.readFileSync(p, "utf8"),
): string {
  const raw = readFile(scriptPath);
  if (!raw.includes(FETCH_SOURCE_BUNDLE_MARKER)) {
    throw new Error(
      `composeTenantScript: marker "${FETCH_SOURCE_BUNDLE_MARKER}" not found in ${scriptPath}`,
    );
  }
  const snippet = readFile(FETCH_SNIPPET_PATH).trimEnd();
  return raw.replace(FETCH_SOURCE_BUNDLE_MARKER, snippet);
}
