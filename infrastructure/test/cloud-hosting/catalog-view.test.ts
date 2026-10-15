import type { ParticipantProblemView, ParticipantTeamView } from "@tenkacloud/portal-contracts";
import { expect, test } from "vitest";
import { createControlDataRuntime } from "../../lib/problem-deploy/control-data/runtime-repositories.js";
import {
  releaseCatalogInstructions,
  savedProblemCatalog,
} from "../../lib/problem-deploy/handlers/participant-handler/catalog-view.js";
import { decorateTeamView } from "../../lib/problem-deploy/handlers/participant-handler/challenge-access.js";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";
import { parseExecutionCatalog } from "../../lib/problem-deploy/handlers/shared/execution-catalog.js";

const digest = "a".repeat(64);
function problemView(): ParticipantProblemView {
  return {
    problemId: "example",
    jobId: "job",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "0", entries: [] },
    i18n: { en: { name: "Preserved name" } },
  };
}

test("the real team-view decorator releases pinned instructions only after the repository's gate opens", async () => {
  const saved = catalog();
  saved.instructions = {
    example: { instructions: "Authorized pinned task", englishInstructions: "Authorized EN" },
  };
  let startsAt = "2999-01-01T00:00:00Z";
  const shared = {
    runtime: createControlDataRuntime({
      env: {},
      ssm: {
        send: async () => {
          throw new Error("No SSM in this test");
        },
      },
      createClient: () => {
        throw new Error("No SQL in this test");
      },
    }),
    ddb: { send: async () => ({ Item: { tenantId: "tenant", status: "READY", startsAt } }) },
    eventsTableName: "events",
    tableName: "deployments",
    coordinationProblemIds: [],
    executionCatalog: { ...saved, catalogKey: `catalogs/${digest}.json` },
  } as unknown as ParticipantSharedResources;
  const view = {
    team: { eventId: "event", teamId: "team", teamName: "Team", teamNameSetByCompetitor: true },
    problems: [problemView()],
  } satisfies ParticipantTeamView;
  const items = [
    { tenantId: "tenant", teamId: "team", eventId: "event", status: "COMPLETE" as const },
  ];
  const before = await decorateTeamView(shared, items, view);
  expect(before.eventGate?.kind).toBe("scoring_not_started");
  expect(before.problems[0]?.instructions).toBeUndefined();
  startsAt = "2020-01-01T00:00:00Z";
  const after = await decorateTeamView(shared, items, view);
  expect(after.eventGate?.kind).toBe("ok");
  expect(after.problems[0]?.instructions).toBe("Authorized pinned task");
  expect(after.problems[0]?.i18n?.en?.instructions).toBe("Authorized EN");
  expect(view.problems[0]?.instructions).toBeUndefined();
});

test("pinned instructions require an authenticated started event and an unlocked problem", () => {
  const saved = catalog();
  saved.instructions = { example: { instructions: "Pinned JA", englishInstructions: "Pinned EN" } };
  const problem = problemView();
  const problems = [problem];
  const now = Date.parse("2026-10-14T12:00:00Z");
  const gate = {
    scoringLocked: false,
    startsAt: "2026-10-14T11:00:00Z",
    status: "READY",
    endsAt: undefined,
    scoreboardFreezeMinutes: undefined,
    progressionGate: undefined,
  };
  for (const value of [
    undefined,
    { ...gate, startsAt: undefined },
    { ...gate, startsAt: "invalid" },
    { ...gate, startsAt: "2026-10-14T13:00:00Z" },
    { ...gate, startsAt: undefined, status: "ENDED" },
  ]) {
    expect(releaseCatalogInstructions(problems, saved, value, [], now)).toBe(problems);
  }
  expect(releaseCatalogInstructions(problems, undefined, gate, [], now)).toBe(problems);
  expect(releaseCatalogInstructions(problems, catalog(), gate, [], now)).toBe(problems);
  expect(releaseCatalogInstructions(problems, saved, gate, ["example"], now)[0]).toBe(problems[0]);
  expect(
    releaseCatalogInstructions([{ ...problem, problemId: "unknown" }], saved, gate, [], now)[0]
      ?.instructions,
  ).toBeUndefined();
  for (const status of ["READY", "ENDED", "ARCHIVED"]) {
    expect(
      releaseCatalogInstructions(problems, saved, { ...gate, status }, [], now)[0],
    ).toMatchObject({
      instructions: "Pinned JA",
      i18n: { en: { name: "Preserved name", instructions: "Pinned EN" } },
    });
  }
  saved.instructions.example = { englishInstructions: "English only" };
  const english = releaseCatalogInstructions(
    [{ ...problem, i18n: undefined }],
    saved,
    gate,
    [],
    now,
  )[0];
  expect(english?.instructions).toBeUndefined();
  expect(english?.i18n?.en?.instructions).toBe("English only");
  saved.instructions.example = { instructions: "Japanese only" };
  expect(releaseCatalogInstructions(problems, saved, gate, [], now)[0]?.i18n).toEqual(
    problems[0]?.i18n,
  );
  expect(problems[0]?.instructions).toBeUndefined();
});
function catalog(metadata?: Record<string, unknown>) {
  return parseExecutionCatalog(
    JSON.stringify({
      version: 1,
      catalog: { example: "pack-problems/selected/version/challenges/example" },
      sources: {
        example: { "metadata.json": { key: `sources/${digest}`, digest } },
      },
      ...(metadata ? { publicMetadata: { example: metadata } } : {}),
      scoring: {},
      hints: {},
      skills: {},
      endpoints: {},
      phases: {},
      visibility: {},
      runtimes: {},
      disruptions: {},
      writeups: {},
      provenance: { example: { contentDigest: digest } },
      coordination: {},
      plugins: {},
      sourceArchive: { bucket: "source", key: "source.zip", versionId: "pinned" },
    }),
  );
}
test("participant metadata comes from the event's saved source and excludes instructions and answers", async () => {
  const metadata = {
    id: "example",
    name: "Original edition",
    category: "Challenge",
    status: "ready",
    difficulty: 1,
    tags: [],
    learningGoals: [],
    estimatedDuration: "5m",
    shortDescription: "Saved description",
    instructions: "SECRET-INSTRUCTIONS",
    writeup: "SECRET-ANSWER",
    hints: [{ content: "SECRET-HINT" }],
  };
  const projection = await savedProblemCatalog(catalog(metadata), ["example"]);
  expect(projection[0]?.name).toBe("Original edition");
  expect(JSON.stringify(projection)).not.toContain("SECRET-");
  expect(await savedProblemCatalog(catalog(), ["example"])).toEqual([]);
  await expect(
    savedProblemCatalog(catalog({ ...metadata, id: "different" }), ["example"]),
  ).rejects.toThrow("identity mismatch");
});

test("saved catalog refuses malformed directory identities and handles absent team problem IDs", async () => {
  const saved = catalog({ id: "example", name: "Saved", category: "Challenge" });
  expect(await savedProblemCatalog(saved, [undefined])).toEqual([]);
  expect(await savedProblemCatalog(saved, ["missing"])).toEqual([]);
  expect(await savedProblemCatalog(saved, [])).toEqual([]);
  saved.catalog.example = "unknown/example";
  await expect(savedProblemCatalog(saved, ["example"])).rejects.toThrow("public metadata identity");
  delete saved.catalog.example;
  await expect(savedProblemCatalog(saved, ["example"])).rejects.toThrow("public metadata identity");
});

test("saved native dashboard edition remains pinned without exposing private coordination data", async () => {
  const saved = catalog();
  saved.catalog = {
    "forensic-casebook": "pack-problems/selected/version/battles/forensic-casebook",
  };
  saved.publicMetadata = {
    "forensic-casebook": {
      id: "forensic-casebook",
      name: "Old edition",
      category: "Battle",
      dashboard: { slots: { status: `portal/${digest}/StatusPanel.tsx` }, private: "SECRET" },
      interTeamCoordination: { publicHint: false, description: "SECRET", plugin: "SECRET" },
    },
  };
  const entries = await savedProblemCatalog(saved, ["forensic-casebook"]);
  expect(entries[0]?.dashboardSlots?.status).toBe(`portal/${digest}/StatusPanel.tsx`);
  expect(JSON.stringify(entries)).not.toContain("SECRET");
});

test("catalogs pinned before the crypto battle rename keep their native identity", () => {
  const pinned = (problemId: string, problemDir: string) =>
    JSON.stringify({
      version: 1,
      nativeProblems: [
        {
          kind: "coordination",
          problemId,
          problemDir,
          artifactDigest: digest,
          pluginKey: `plugins/${digest}.mjs`,
          stateBudget: { bytesPerTeam: 1, baseBytes: 0 },
          name: "Saved battle",
          description: "",
          instructions: "",
        },
      ],
      catalog: { [problemId]: problemDir },
      sources: {},
      scoring: {},
      hints: {},
      endpoints: {},
      phases: {},
      visibility: {},
      runtimes: {},
      disruptions: {},
      writeups: {},
      provenance: {},
      coordination: {},
      plugins: { [problemId]: { key: `plugins/${digest}.mjs`, digest } },
      sourceArchive: { bucket: "source", key: "source.zip", versionId: "pinned" },
    });
  for (const id of ["crypto-battle", "ac26-crypto-battle"])
    expect(
      parseExecutionCatalog(pinned(id, `problems/battles/${id}`)).nativeProblems?.[0]?.problemId,
    ).toBe(id);
  expect(() =>
    parseExecutionCatalog(pinned("crypto-battle", "problems/battles/ac26-crypto-battle")),
  ).toThrow("Native problem directory must match its identity.");
});
