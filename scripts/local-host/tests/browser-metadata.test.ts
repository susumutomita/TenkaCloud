import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { metadataToDetail } from "../../../apps/application-admin-console/src/data/problem-mapping";
import { metadataToEntry } from "../../../packages/portal-contracts/src/problem-catalog";
import {
  assertHostingModule,
  hostBrowserProblemPaths,
  narrowCatalog,
  publicMetadata,
} from "../browser-metadata";
import { reviewedCoordinationPaths } from "../coordination-catalog";
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
  expect(hostBrowserProblemPaths()).toHaveLength(108 + reviewedCoordinationPaths.length);
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
    expect(value.scoring).toEqual({ kind: raw.scoring.kind });
    expect(metadataToDetail(value).scoringKind).toBe(raw.scoring.kind);
    expect(value.i18n.en.name).toBe(raw.i18n.en.name);
    for (const hidden of [
      "instructions",
      "description",
      "writeup",
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
    `import.meta.glob("../../../../problems/{${reviewedCoordinationPaths.join(",")}}/portal/*.tsx");`,
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

test("reviewed Pi Siege exposes its public Portal without importing grader or development code", () => {
  const path = join(root, "problems/battles/pi-siege/metadata.json");
  const projected = publicMetadata(readFileSync(path, "utf8"), path);
  if (!projected) throw new Error("Missing Pi Siege metadata.");
  const value = JSON.parse(projected);
  expect(value.category).toBe("Battle");
  expect(value.runtime).toEqual({ provider: "local", engine: "bun" });
  expect(value.i18n.en.name).toBe("Pi Siege");
  for (const file of ["StatusPanel.tsx", "content.ts", "content.en.ts", "localize.ts", "style.css"])
    expect(() =>
      assertHostingModule(`/repo/problems/battles/pi-siege/portal/${file}`),
    ).not.toThrow();
  for (const file of [
    "game/reducer.ts",
    "game/math.ts",
    "coordination/pi-siege.ts",
    "dev/server.ts",
    "docs/answers.ts",
    "portal/private.ts",
  ])
    expect(() => assertHostingModule(`/repo/problems/battles/pi-siege/${file}`)).toThrow(
      "Unreviewed problem content",
    );
  const unknown = publicMetadata(
    JSON.stringify({
      id: "unreviewed-battle",
      category: "Battle",
      runtime: { provider: "local", engine: "bun" },
      dashboard: { private: "not-reviewed" },
      interTeamCoordination: { plugin: "private.ts" },
    }),
    "/repo/problems/battles/unreviewed-battle/metadata.json",
  );
  expect(unknown).not.toContain("not-reviewed");
  expect(unknown).not.toContain("private.ts");
  expect(() =>
    assertHostingModule("/repo/problems/battles/unreviewed-battle/portal/StatusPanel.tsx"),
  ).toThrow("Unreviewed problem content");
});

test("reviewed Session Defense exposes only its component and styles", () => {
  const path = join(root, "problems/battles/session-defense/metadata.json");
  const projected = publicMetadata(readFileSync(path, "utf8"), path);
  if (!projected) throw new Error("Missing Session Defense metadata.");
  expect(JSON.parse(projected).runtime).toEqual({ provider: "local", engine: "bun" });
  for (const file of ["portal/StatusPanel.tsx", "portal/style.css"])
    expect(() =>
      assertHostingModule(`/repo/problems/battles/session-defense/${file}`),
    ).not.toThrow();
  for (const file of [
    "game/reducer.ts",
    "game/types.ts",
    "coordination/session-defense.ts",
    "dev/app.tsx",
    "docs/SECURITY.md",
    "portal/extra.ts",
  ])
    expect(() => assertHostingModule(`/repo/problems/battles/session-defense/${file}`)).toThrow(
      "Unreviewed problem content",
    );
});

test("course metadata survives both browser projections without exposing author-only fields", () => {
  const path = join(root, "problems/challenges/ac26-w5-lwe-rlwe/metadata.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.track.answer = "private-track-answer";
  raw.courseAlignment.solution = "private-course-answer";
  raw.courseAlignment.sources[0].answer = "private-source-answer";
  const projected = publicMetadata(JSON.stringify(raw), path);
  if (!projected) throw new Error("Missing course projection.");
  const entry = metadataToEntry(JSON.parse(projected));
  expect(entry.track).toEqual({
    id: raw.track.id,
    order: raw.track.order,
    chapter: raw.track.chapter,
  });
  expect(entry.courseAlignment?.courseId).toBe(raw.courseAlignment.courseId);
  expect(entry.courseAlignment?.week).toBe(raw.courseAlignment.week);
  expect(entry.courseAlignment?.sources[0]).toEqual({
    repository: raw.courseAlignment.sources[0].repository,
    ref: raw.courseAlignment.sources[0].ref,
    path: raw.courseAlignment.sources[0].path,
    kind: raw.courseAlignment.sources[0].kind,
  });
  expect(projected).not.toContain("private-");
  expect(entry.learningGoals).toEqual([]);
  raw.courseAlignment.spoilerPolicy = "embargoed";
  const embargoed = publicMetadata(JSON.stringify(raw), path);
  if (!embargoed) throw new Error("Missing embargo projection.");
  expect(JSON.parse(embargoed).courseAlignment).toBeUndefined();
  expect(JSON.parse(embargoed).track).toEqual(entry.track);
});

test("the scoring facet keeps only its kind and never author scoring values", () => {
  const path = "/repo/problems/challenges/example/metadata.json";
  const project = (scoring?: unknown) => {
    const value = publicMetadata(JSON.stringify({ scoring }), path);
    if (!value) throw new Error("Missing public projection");
    return JSON.parse(value);
  };
  expect(
    project({
      kind: "verify",
      points: 999,
      answer: "private-scoring-answer",
      config: { token: "private-scoring-config" },
    }).scoring,
  ).toEqual({ kind: "verify" });
  for (const scoring of [
    undefined,
    null,
    "private-scoring-answer",
    { kind: { answer: "private-scoring-answer" } },
  ])
    expect(project(scoring).scoring).toBeUndefined();
});
