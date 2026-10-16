import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
import { dockerProblemPaths } from "./problem-tree";

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

test("hosting exposes every selectable Docker verify exercise as public Challenge metadata", () => {
  const dockerOnDisk = dockerProblemPaths(root);
  expect(dockerOnDisk.length).toBeGreaterThan(0);
  expect([...localProblems].sort((a, b) => a.localeCompare(b))).toEqual(dockerOnDisk);
  expect(hostBrowserProblemPaths()).toEqual(
    [
      ...dockerOnDisk,
      "challenges/hello-world",
      "battles/hello-world-battle",
      ...reviewedCoordinationPaths.filter((path) =>
        existsSync(join(root, "problems", path, "metadata.json")),
      ),
    ].sort((a, b) => a.localeCompare(b)),
  );
  for (const path of localProblems) {
    const source = readFileSync(join(root, "problems", path, "metadata.json"), "utf8");
    const raw = JSON.parse(source);
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
});

test("a Docker Compose verify exercise authored under battles is projected as a Challenge", () => {
  const path = "/repo/problems/battles/legacy-docker/metadata.json";
  const projected = publicMetadata(
    JSON.stringify({
      id: "legacy-docker",
      category: "Battle",
      runtime: { provider: "docker", engine: "compose" },
      scoring: { kind: "verify" },
    }),
    path,
  );
  if (!projected) throw new Error("Missing legacy Docker projection.");
  expect(JSON.parse(projected).category).toBe("Challenge");
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
  expect(plugins).toContain(`/{${reviewedCoordinationPaths.join(",")}}/portal/*.tsx`);
  expect(plugins).toContain("/.tenkacloud/catalog-store/snapshots/");
  expect(plugins).not.toContain("problems/*/*/");
  expect(() =>
    narrowCatalog(
      'import.meta.glob("../../../../problems/*/*/metadata.json"); import.meta.glob("../../../../problems/*/*/answers.json");',
      "/repo/apps/participant-portal/src/data/problems.ts",
    ),
  ).toThrow("unreviewed catalog discovery");
});

test("empty, single and multiple selected entries generate usable bounded catalog globs", () => {
  const code = 'import.meta.glob("../../../../problems/*/*/metadata.json", { eager: true });';
  const id = "/repo/apps/participant-portal/src/data/problems.ts";
  const empty = narrowCatalog(code, id, []);
  expect(empty).toContain("/__local_host_empty__/metadata.json");
  expect(empty).not.toContain("/{}");
  const single = narrowCatalog(code, id, ["battles/forensic-casebook"]);
  expect(single).toContain("/battles/forensic-casebook/metadata.json");
  expect(single).not.toContain("{battles/forensic-casebook}");
  const multiple = narrowCatalog(code, id, ["battles/forensic-casebook", "challenges/sqli-demo"]);
  expect(multiple).toContain("/{battles/forensic-casebook,challenges/sqli-demo}/metadata.json");
  for (const output of [empty, single, multiple]) expect(output).not.toContain("problems/*/*/");
});

test("native crypto remains a Battle and server-only game code stays excluded", () => {
  const path = join(root, "problems/battles/crypto-battle/metadata.json");
  const projected = publicMetadata(readFileSync(path, "utf8"), path);
  if (!projected) throw new Error("Missing native crypto metadata.");
  expect(JSON.parse(projected).category).toBe("Battle");
  expect(JSON.parse(projected).runtime).toEqual({ provider: "local", engine: "bun" });
  expect(() =>
    assertHostingModule("/repo/problems/battles/crypto-battle/game/src/secret.ts"),
  ).toThrow("Server-only game code");
  expect(() =>
    assertHostingModule("/repo/problems/battles/crypto-battle/portal/StatusPanel.tsx"),
  ).not.toThrow();
});

test("retained editions of reviewed two-seat Battles keep their narrow browser allow-list", () => {
  for (const [id, allowed] of [
    ["pi-siege", ["StatusPanel.tsx", "content.ts", "content.en.ts", "localize.ts", "style.css"]],
    ["session-defense", ["StatusPanel.tsx", "style.css"]],
    ["tenant-boundary-duel", ["StatusPanel.tsx", "style.css"]],
  ] as const) {
    for (const file of allowed)
      expect(() =>
        assertHostingModule(`/repo/problems/battles/${id}/portal/${file}`),
      ).not.toThrow();
    for (const file of [
      "game/reducer.ts",
      `coordination/${id}.ts`,
      "dev/server.ts",
      "portal/private.ts",
    ])
      expect(() => assertHostingModule(`/repo/problems/battles/${id}/${file}`)).toThrow(
        "Unreviewed problem content",
      );
  }
});

test("an unreviewed Battle exposes neither private metadata nor portal modules", () => {
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

test("course metadata survives both browser projections without exposing author-only fields", () => {
  const path = join(root, "problems/challenges/sqli-demo/metadata.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.courseAlignment = {
    courseId: "example-course",
    edition: "2026",
    week: 5,
    role: "practice",
    spoilerPolicy: "public",
    sources: [
      {
        repository: "example/course",
        ref: "main",
        path: "week5/README.md",
        kind: "lecture",
      },
    ],
  };
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

test("forensic browser allowlist exposes evidence UI, never server answers or fixture generation", () => {
  const path = join(root, "problems/battles/forensic-casebook/metadata.json");
  const projected = publicMetadata(readFileSync(path, "utf8"), path);
  if (!projected) throw new Error("Missing forensic metadata.");
  expect(JSON.parse(projected).runtime).toEqual({ provider: "local", engine: "bun" });
  expect(JSON.parse(projected).dashboard).toEqual({
    slots: { StatusPanel: "portal/StatusPanel.tsx" },
  });
  for (const file of ["portal/StatusPanel.tsx", "portal/styles.ts"])
    expect(() =>
      assertHostingModule(`/repo/problems/battles/forensic-casebook/${file}`),
    ).not.toThrow();
  for (const file of [
    "game/index.ts",
    "game/cases.ts",
    "coordination/plugin.ts",
    "dev/server.ts",
    "tests/game.test.ts",
    "README.md",
    "portal/private.ts",
  ])
    expect(() => assertHostingModule(`/repo/problems/battles/forensic-casebook/${file}`)).toThrow(
      "Unreviewed problem content",
    );
});

test("local browser credits agree with admin and participant projections without exposing answers", () => {
  const raw = {
    id: "sample",
    name: "問題",
    authors: [
      { name: "作者", profileUrl: "https://example.com/", email: "SECRET_EMAIL" },
      { name: "共同作者" },
    ],
    description: "SECRET_ANSWER",
    writeup: "SECRET_WRITEUP",
    scoring: { kind: "verify", flag: "SECRET_FLAG" },
  };
  const projected = publicMetadata(
    JSON.stringify(raw),
    "/repo/problems/challenges/sample/metadata.json",
  );
  if (!projected) throw new Error("Missing projection");
  const publicValue = JSON.parse(projected);
  expect(publicValue.authors).toEqual([
    { name: "作者", profileUrl: "https://example.com/" },
    { name: "共同作者" },
  ]);
  expect(metadataToEntry(publicValue).authors).toEqual(publicValue.authors);
  expect(metadataToDetail(publicValue).authors).toEqual(publicValue.authors);
  expect(projected).not.toContain("SECRET");
});

test("native public JSON excludes private coordination configuration and extra dashboard fields", () => {
  const path = join(root, "problems/battles/crypto-battle/metadata.json");
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  metadata.interTeamCoordination = {
    ...metadata.interTeamCoordination,
    publicHint: false,
    description: "private-coordination-text",
    plugin: "private-plugin-name",
    stateBudget: { baseBytes: 12345 },
  };
  metadata.dashboard = { ...metadata.dashboard, privateField: "private-dashboard-value" };
  const projected = publicMetadata(JSON.stringify(metadata), path);
  expect(projected).not.toContain("private-coordination-text");
  expect(projected).not.toContain("private-plugin-name");
  expect(projected).not.toContain("private-dashboard-value");
});
