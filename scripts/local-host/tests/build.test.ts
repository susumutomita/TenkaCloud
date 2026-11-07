import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContentDigest } from "../../../packages/problem-sdk/src/content-digest";
import { readCatalogSelection } from "../../problem-pack/catalog-read";
import { buildHosting, runBuildCommand } from "../build";
import { parseHostBuildOptions } from "../build-main";

const SYNTHETIC_BUILD =
  "console.log('synthetic build report'); console.error('synthetic build warning');";

test("summary output captures a successful build report instead of streaming it", async () => {
  const result = await runBuildCommand(["-e", SYNTHETIC_BUILD], tmpdir(), "summary");
  expect(result.code).toBe(0);
  expect(result.report).toContain("synthetic build report");
  expect(result.report).toContain("synthetic build warning");
});

test("summary output keeps the failed build report and exit code", async () => {
  const result = await runBuildCommand(
    ["-e", `${SYNTHETIC_BUILD} process.exit(3);`],
    tmpdir(),
    "summary",
  );
  expect(result.code).toBe(3);
  expect(result.report).toContain("synthetic build warning");
});

const buildFixtures: string[] = [];

function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "host-build-opt-in-"));
  buildFixtures.push(root);
  const source = join(root, "catalog");
  mkdirSync(join(source, "challenges/example"), { recursive: true });
  writeFileSync(
    join(source, "challenges/example/metadata.json"),
    '{"id":"example","name":"Example"}',
  );
  const digest = computeContentDigest(source, true);
  mkdirSync(join(root, ".tenkacloud/catalog-store/snapshots"), { recursive: true });
  renameSync(source, join(root, ".tenkacloud/catalog-store/snapshots", digest));
  writeFileSync(
    join(root, ".tenkacloud/catalog-store/selected.json"),
    JSON.stringify({
      schemaVersion: 1,
      sources: [{ path: source, commit: "a".repeat(40), digest, problemsRoot: "." }],
    }),
  );
  mkdirSync(join(root, ".tenkacloud/host-build"), { recursive: true });
  writeFileSync(
    join(root, ".tenkacloud/host-build/provenance.json"),
    "previous acceptance evidence",
  );
  for (const app of ["application-admin-console", "participant-portal"]) {
    const directory = join(root, "apps", app);
    mkdirSync(directory, { recursive: true });
    // Real subprocess pipeline with a tiny app-owned build command; no Vite/network required.
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: { vite: `${JSON.stringify(process.execPath)} emit.ts` },
      }),
    );
    writeFileSync(
      join(directory, "emit.ts"),
      `
      import { mkdirSync, writeFileSync } from "node:fs";
      const directory = "../../.tenkacloud/host-build/${app}";
      mkdirSync(directory, { recursive: true });
      writeFileSync(directory + "/host.html", "<html>built by fixture</html>");
    `,
    );
    symlinkSync("/nonexistent-host-build-source-fixture", join(directory, "src"));
  }
  return root;
}

afterEach(() => {
  for (const root of buildFixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([undefined, false])(
  "ordinary build skips strict source requirements and invalidates provenance (%s)",
  async (acceptanceProvenance) => {
    const root = buildFixture();
    if (acceptanceProvenance === undefined) await buildHosting(root, "summary");
    else await buildHosting(root, "summary", { acceptanceProvenance });
    expect(
      readFileSync(
        join(root, ".tenkacloud/host-build/application-admin-console/host.html"),
        "utf8",
      ),
    ).toContain("built by fixture");
    expect(readFileSync(join(root, ".tenkacloud/host-build/catalog-selection.json"), "utf8")).toBe(
      readCatalogSelection(root),
    );
    expect(existsSync(join(root, ".tenkacloud/host-build/provenance.json"))).toBe(false);
  },
);

test("acceptance build explicitly enables strict source checks and fails closed", async () => {
  const root = buildFixture();
  await expect(buildHosting(root, "summary", { acceptanceProvenance: true })).rejects.toThrow(
    "symlink",
  );
  expect(existsSync(join(root, ".tenkacloud/host-build/provenance.json"))).toBe(false);
  expect(existsSync(join(root, ".tenkacloud/host-build/application-admin-console/host.html"))).toBe(
    false,
  );
});

test("even a failed ordinary build invalidates earlier acceptance provenance", async () => {
  const root = buildFixture();
  rmSync(join(root, ".tenkacloud/catalog-store/selected.json"));
  await expect(buildHosting(root, "summary")).rejects.toThrow("No downloaded problem catalog");
  expect(existsSync(join(root, ".tenkacloud/host-build/provenance.json"))).toBe(false);
});

test("build CLI enables acceptance provenance only with its explicit option", () => {
  expect(parseHostBuildOptions([])).toEqual({ acceptanceProvenance: false });
  expect(parseHostBuildOptions(["--acceptance-provenance"])).toEqual({
    acceptanceProvenance: true,
  });
  expect(() => parseHostBuildOptions(["--unknown"])).toThrow("Usage:");
  expect(() => parseHostBuildOptions(["--acceptance-provenance", "--unknown"])).toThrow("Usage:");
});
