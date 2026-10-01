import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHostingModule,
  hostBrowserProblemPaths,
  narrowCatalog,
  publicMetadata,
} from "../browser-metadata";
import { loadDockerCatalog } from "../docker-catalog";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const localProblems = hostBrowserProblemPaths().filter((path) => {
  const metadata = JSON.parse(readFileSync(join(root, "problems", path, "metadata.json"), "utf8"));
  return metadata.runtime?.provider === "docker";
});

test("frontend Docker identities exactly match the host's executable catalog", () => {
  expect(new Set(localProblems.map((path) => path.split("/").at(-1)))).toEqual(
    new Set(loadDockerCatalog(root).map((problem) => problem.problemId)),
  );
});

test("hosting exposes all 106 Docker verify exercises as public Challenge metadata", () => {
  expect(localProblems).toHaveLength(106);
  expect(hostBrowserProblemPaths()).toHaveLength(109);
  let legacyBattles = 0;
  for (const path of localProblems) {
    const source = readFileSync(join(root, "problems", path, "metadata.json"), "utf8");
    const raw = JSON.parse(source);
    if (raw.category === "Battle") legacyBattles += 1;
    const projected = publicMetadata(source, join(root, "problems", path, "metadata.json"));
    if (!projected) throw new Error(`No public metadata for ${path}`);
    const value = JSON.parse(projected);
    expect(value.id).toBe(raw.id);
    expect(value.category).toBe("Challenge");
    expect(value.runtime).toEqual({ provider: "docker", engine: "compose" });
    expect(value.i18n.en.name).toBe(raw.i18n.en.name);
    for (const hidden of [
      "instructions",
      "description",
      "writeup",
      "scoring",
      "endpoints",
      "dashboard",
      "exposedPorts",
      "interTeamCoordination",
    ])
      expect(value[hidden]).toBeUndefined();
    for (const hidden of ["instructions", "description", "writeup", "hints", "scoring"])
      expect(value.i18n.en[hidden]).toBeUndefined();
    expect(() => assertHostingModule(join(root, "problems", path, "metadata.json"))).not.toThrow();
    expect(() => assertHostingModule(join(root, "problems", path, "diagram.svg"))).not.toThrow();
    for (const hidden of [
      "local/docker-compose.yml",
      "local/server.py",
      "portal/StatusPanel.tsx",
      "template.yaml",
      "README.md",
      "writeup.md",
    ])
      expect(() => assertHostingModule(join(root, "problems", path, hidden))).toThrow();
  }
  expect(legacyBattles).toBe(4);
});

test("metadata expansion does not expand executable portal plugins or templates", () => {
  const catalog = narrowCatalog(
    'import.meta.glob("../../../../problems/*/*/metadata.json"); import.meta.glob("../../../../problems/*/*/diagram.svg"); import.meta.glob("../../../../problems/*/*/*.yaml");',
    "/repo/apps/participant-portal/src/data/problems.ts",
  );
  for (const path of hostBrowserProblemPaths()) expect(catalog).toContain(path);
  expect(catalog).not.toContain("problems/*/*/");
  expect(catalog).toContain("__local_host_empty__/*.yaml");
  const plugins = narrowCatalog(
    'import.meta.glob("../../../../problems/*/*/portal/*.tsx");',
    "/repo/apps/participant-portal/src/plugins/loader.ts",
  );
  expect(plugins).toBe(
    'import.meta.glob("../../../../problems/battles/ac26-crypto-battle/portal/*.tsx");',
  );
  expect(() =>
    narrowCatalog(
      'import.meta.glob("../../../../problems/*/*/metadata.json"); import.meta.glob("../../../../problems/*/*/answers.json");',
      "/repo/apps/participant-portal/src/data/problems.ts",
    ),
  ).toThrow("unreviewed catalog discovery");
});

test("native crypto remains a Battle and server-only game code stays excluded", () => {
  const path = join(root, "problems/battles/ac26-crypto-battle/metadata.json");
  const projected = publicMetadata(readFileSync(path, "utf8"), path);
  if (!projected) throw new Error("Missing native crypto metadata.");
  expect(JSON.parse(projected).category).toBe("Battle");
  expect(JSON.parse(projected).runtime).toEqual({ provider: "local", engine: "bun" });
  expect(() =>
    assertHostingModule("/repo/problems/battles/ac26-crypto-battle/game/src/secret.ts"),
  ).toThrow("Server-only game code");
  expect(() =>
    assertHostingModule("/repo/problems/battles/ac26-crypto-battle/portal/StatusPanel.tsx"),
  ).not.toThrow();
});
