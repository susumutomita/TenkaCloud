import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hostBuildSourceFingerprint,
  verifyHostBuildArtifacts,
  verifyHostBuildProvenance,
  writeHostBuildProvenance,
} from "../host-build-provenance";

const roots: string[] = [];
const APPS = ["application-admin-console", "participant-portal"];
const CATALOG = `.tenkacloud/catalog-store/snapshots/${"a".repeat(64)}`;
const MANIFEST = ".tenkacloud/host-build/provenance.json";
const ENTRY = ".tenkacloud/host-build/application-admin-console/host.html";
const SOURCE = "apps/application-admin-console/src/main.tsx";

function put(root: string, file: string, contents = "fixture"): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), contents);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "host-provenance-"));
  roots.push(root);
  for (const file of [
    "package.json",
    "bun.lock",
    "scripts/local-host/build.ts",
    "scripts/local-host/host-build-provenance.ts",
    "scripts/local-host/browser-metadata.ts",
    "scripts/local-host/browser-public-metadata.ts",
    "scripts/local-host/coordination-catalog.ts",
    "scripts/problem-pack/catalog-read.ts",
    "scripts/problem-pack/source-permissions.ts",
    "scripts/problem-pack/downloaded-catalog.ts",
    "apps/application-admin-console/catalog-projection.ts",
    "apps/participant-portal/build/problem-catalog.ts",
  ])
    put(root, file);
  for (const app of APPS) {
    for (const file of [
      "package.json",
      "host.html",
      "vite.config.ts",
      "vite.host.config.ts",
      "tsconfig.json",
      "src/main.tsx",
    ])
      put(root, `apps/${app}/${file}`);
    put(root, `.tenkacloud/host-build/${app}/host.html`, '<script src="/assets/main.js"></script>');
    put(root, `.tenkacloud/host-build/${app}/assets/main.js`, "console.log('fixture')");
  }
  for (const name of [
    "auth-client",
    "format",
    "portal-contracts",
    "portal-plugin-sdk",
    "problem-cost",
    "problem-runtime",
    "problem-sdk",
    "web-kit",
    "coordination-plugin-sdk",
  ]) {
    for (const file of ["package.json", "tsconfig.json", "src/index.ts"])
      put(root, `packages/${name}/${file}`);
  }
  put(
    root,
    ".tenkacloud/catalog-store/selected.json",
    JSON.stringify({
      schemaVersion: 1,
      sources: [
        {
          path: "/explicit/catalog",
          digest: "a".repeat(64),
          commit: "b".repeat(40),
          problemsRoot: ".",
        },
      ],
    }),
  );
  put(root, `${CATALOG}/challenges/hello-world/metadata.json`, "{}");
  put(root, `${CATALOG}/battles/crypto-battle/portal/StatusPanel.tsx`);
  put(root, `${CATALOG}/battles/crypto-battle/game/src/types.ts`);
  put(root, "problems/challenges/hello-world/metadata.json", "{}");
  return root;
}

function record(root: string): void {
  writeHostBuildProvenance(root, hostBuildSourceFingerprint(root));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("fresh host provenance is deterministic, timestamp independent and portable", () => {
  const root = fixture();
  record(root);
  const before = verifyHostBuildProvenance(root);
  utimesSync(join(root, SOURCE), new Date(0), new Date(0));
  record(root);
  expect(verifyHostBuildProvenance(root)).toEqual(before);
  const copy = fixture();
  cpSync(root, copy, { recursive: true });
  expect(verifyHostBuildProvenance(copy)).toEqual(before);
});

test.each([
  SOURCE,
  "apps/participant-portal/src/main.tsx",
  "apps/application-admin-console/vite.host.config.ts",
  "apps/participant-portal/build/problem-catalog.ts",
  "packages/web-kit/src/index.ts",
  "packages/portal-contracts/package.json",
  "bun.lock",
  "scripts/local-host/browser-metadata.ts",
  `${CATALOG}/challenges/hello-world/metadata.json`,
  `${CATALOG}/battles/crypto-battle/portal/StatusPanel.tsx`,
  `${CATALOG}/battles/crypto-battle/game/src/types.ts`,
  "problems/challenges/hello-world/metadata.json",
])("changed build input rejects stale interfaces: %s", (file) => {
  const root = fixture();
  record(root);
  put(root, file, "changed source");
  expect(() => verifyHostBuildProvenance(root)).toThrow("stale");
});

test("new and deleted app source files also invalidate provenance", () => {
  const root = fixture();
  record(root);
  put(root, "apps/participant-portal/src/new-component.tsx");
  expect(() => verifyHostBuildProvenance(root)).toThrow("stale");
  record(root);
  rmSync(join(root, "apps/participant-portal/src/new-component.tsx"));
  expect(() => verifyHostBuildProvenance(root)).toThrow("stale");
});

test("unrelated files, generated dist, environment and secret directories are not source inputs", () => {
  const root = fixture();
  record(root);
  for (const file of [
    "unrelated.json",
    ".env",
    ".aws/credentials",
    "secrets/token.json",
    "apps/application-admin-console/.env.local",
    "apps/application-admin-console/dist/main.js",
    "apps/application-admin-console/src/.env",
    "apps/application-admin-console/src/secrets/token.json",
    "apps/application-admin-console/src/secret.json",
    "apps/application-admin-console/src/credentials-local.json",
    "apps/application-admin-console/src/id_rsa.json",
    "apps/application-admin-console/src/private.pem",
  ])
    put(root, file, "never include me");
  expect(() => verifyHostBuildProvenance(root)).not.toThrow();
});

test("ordinary dist builds do not stand in for host builds", () => {
  const root = fixture();
  record(root);
  for (const app of APPS) {
    cpSync(join(root, `.tenkacloud/host-build/${app}`), join(root, `apps/${app}/dist`), {
      recursive: true,
    });
    rmSync(join(root, `.tenkacloud/host-build/${app}`), { recursive: true });
  }
  expect(() => verifyHostBuildProvenance(root)).toThrow("missing");
});

test.each([ENTRY, ".tenkacloud/host-build/participant-portal/assets/main.js"])(
  "corrupted served artifact is rejected: %s",
  (file) => {
    const root = fixture();
    record(root);
    put(root, file, "corrupted");
    expect(() => verifyHostBuildArtifacts(root)).toThrow("artifacts differ");
  },
);

test("added and removed served assets are rejected", () => {
  const root = fixture();
  record(root);
  put(root, ".tenkacloud/host-build/participant-portal/assets/extra.js");
  expect(() => verifyHostBuildArtifacts(root)).toThrow("artifacts differ");
  record(root);
  rmSync(join(root, ".tenkacloud/host-build/participant-portal/assets/main.js"));
  expect(() => verifyHostBuildArtifacts(root)).toThrow("artifacts differ");
});

test("private runtime artifact verification does not need app sources", () => {
  const root = fixture();
  record(root);
  rmSync(join(root, "apps"), { recursive: true });
  expect(() => verifyHostBuildArtifacts(root)).not.toThrow();
  expect(() => verifyHostBuildProvenance(root)).toThrow("missing");
});

test("a source edit during the build cannot receive fresh provenance", () => {
  const root = fixture();
  const fingerprint = hostBuildSourceFingerprint(root);
  put(root, SOURCE, "edited while Vite was running");
  expect(() => writeHostBuildProvenance(root, fingerprint)).toThrow("changed during the build");
  expect(() => verifyHostBuildArtifacts(root)).toThrow("provenance is missing");
});

test.each([
  SOURCE,
  "apps/application-admin-console/src",
  "bun.lock",
  CATALOG,
  ENTRY,
  ".tenkacloud/host-build/participant-portal/assets",
  MANIFEST,
])("symlinked source, parent, artifact or manifest is rejected: %s", (file) => {
  const root = fixture();
  record(root);
  const target = `${join(root, file)}-original`;
  cpSync(join(root, file), target, { recursive: true });
  rmSync(join(root, file), { recursive: true });
  symlinkSync(target, join(root, file));
  expect(() => verifyHostBuildProvenance(root)).toThrow(/symlink/u);
});

test("dangling included symlinks cannot disappear from the fingerprint", () => {
  const root = fixture();
  record(root);
  symlinkSync("/nonexistent-provenance-test", join(root, "apps/participant-portal/src/new.ts"));
  expect(() => verifyHostBuildProvenance(root)).toThrow(/symlink/u);
});

test("corrupt or missing provenance fails closed without trusting supplied artifact paths", () => {
  const root = fixture();
  record(root);
  const valid = readFileSync(join(root, MANIFEST), "utf8");
  const manifest = JSON.parse(valid);
  manifest.artifacts[0].path = "../../.env";
  put(root, MANIFEST, JSON.stringify(manifest));
  expect(() => verifyHostBuildArtifacts(root)).toThrow("artifacts differ");
  put(root, MANIFEST, "not json");
  expect(() => verifyHostBuildArtifacts(root)).toThrow();
  rmSync(join(root, MANIFEST));
  expect(() => verifyHostBuildArtifacts(root)).toThrow("provenance is missing");
});
