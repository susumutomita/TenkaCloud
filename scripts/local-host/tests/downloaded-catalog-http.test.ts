import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  downloadCatalog,
  downloadConfiguredCatalog,
} from "../../problem-pack/downloaded-catalog.js";
import type { GitArchiveFetcher } from "../../problem-pack/git-source.js";
import { CompetitionEngine } from "../competition-engine.js";
import { forensicFixture, required } from "./forensic-fixture.js";
import { type ForensicProjection, publicIdentityAnswer } from "./forensic-public-evidence.js";

const repository = resolve(import.meta.dirname, "../../..");
const firstCommit = "1".repeat(40);
const secondCommit = "2".repeat(40);
const config = (packs: string[], commit = firstCommit) => ({
  schemaVersion: 1,
  sources: packs.map((pack) => ({ url: `https://example.invalid/${pack}.git`, ref: commit })),
});

test("downloaded A/B/A+B native catalogs, answers and saved event metadata survive selection updates and SQLite restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "downloaded-catalog-http-"));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  const fetcher: GitArchiveFetcher = (request) => {
    const id = request.repositoryUrl.endsWith("pack-a.git") ? "forensic-casebook" : "crypto-battle";
    mkdirSync(join(request.destinationDir, "battles"));
    const directory = join(request.destinationDir, "battles", id);
    cpSync(join(repository, "problems/battles", id), directory, { recursive: true });
    const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
    metadata.name = `${id} edition ${request.commit}`;
    writeFileSync(join(directory, "metadata.json"), JSON.stringify(metadata));
  };
  let fixture: Awaited<ReturnType<typeof forensicFixture>> | undefined;
  try {
    for (const [packs, expected] of [
      [["pack-a"], ["forensic-casebook"]],
      [["pack-b"], ["crypto-battle"]],
      [
        ["pack-a", "pack-b"],
        ["forensic-casebook", "crypto-battle"],
      ],
    ] as const) {
      downloadCatalog(root, config([...packs]), { fetcher });
      expect(
        new CompetitionEngine(root, join(root, "data"), false)
          .catalog()
          .map((problem) => problem.problemId),
      ).toEqual([...expected]);
    }
    downloadCatalog(root, config(["pack-a"]), { fetcher });
    fixture = await forensicFixture(root);
    const event = await fixture.create("Pinned downloaded edition A");
    const team = required(event.teams[0]);
    const readView = () =>
      required(fixture).api<{
        problemCatalog: { id: string; name: string; dashboardSlots?: Record<string, string> }[];
        problems: { score: number }[];
      }>("participant", "/portal/me", { token: team.teamLoginKey });
    const originalView = await readView();
    expect(originalView.status).toBe(200);
    expect(originalView.body.problemCatalog[0]?.name).toContain(firstCommit);
    expect(originalView.body.problemCatalog[0]?.dashboardSlots?.StatusPanel).toMatch(
      /^portal\/[a-f0-9]{64}\/StatusPanel.tsx$/u,
    );
    const projection = await fixture.api<{ projection: ForensicProjection }>(
      "participant",
      "/portal/me/coordination/projection",
      { token: team.teamLoginKey },
    );
    const state = projection.body.projection;
    const identity = required(state.cases.find((entry) => entry.id === "identity"));
    const idp = required(identity.evidence.find((entry) => entry.id === "I-IDP"));
    const cloud = required(identity.evidence.find((entry) => entry.id === "I-CLOUD"));
    const operation = {
      kind: "answer",
      id: "downloaded-answer",
      revision: state.revision,
      generation: state.generation,
      caseId: "identity",
      questionId: "account",
      answer: publicIdentityAnswer(idp.content, cloud.content),
      evidenceIds: ["I-IDP", "I-CLOUD"],
    };
    const answer = await fixture.api<{ projection: ForensicProjection }>(
      "participant",
      "/portal/me/coordination/op",
      { method: "POST", token: team.teamLoginKey, body: { op: operation } },
    );
    expect(answer.status).toBe(200);
    expect(answer.body.projection.score).toBe(20);
    downloadCatalog(root, config(["pack-b"]), { fetcher });
    await fixture.restart();
    const retained = await readView();
    expect(retained.body.problemCatalog).toEqual(originalView.body.problemCatalog);
    expect(retained.body.problems[0]?.score).toBe(20);
    expect(fixture.store.team(team.teamId).score).toBe(20);
    const restored = await fixture.api<{ projection: ForensicProjection }>(
      "participant",
      "/portal/me/coordination/projection",
      { token: team.teamLoginKey },
    );
    expect(restored.body.projection).toEqual(answer.body.projection);
    writeFileSync(
      join(root, "catalog-sources.json"),
      JSON.stringify({
        schemaVersion: 1,
        sources: [{ url: "https://example.invalid/pack-a.git", ref: "main" }],
      }),
    );
    downloadConfiguredCatalog(root, undefined, { fetcher, resolveRef: () => secondCommit });
    await fixture.restart();
    const fresh = await fixture.create("New edition A");
    const freshTeam = required(fresh.teams[0]);
    const freshView = await fixture.api<typeof originalView.body>("participant", "/portal/me", {
      token: freshTeam.teamLoginKey,
    });
    expect(freshView.body.problemCatalog[0]?.name).toContain(secondCommit);
    expect((await readView()).body.problemCatalog).toEqual(originalView.body.problemCatalog);
    expect((await readView()).body.problems[0]?.score).toBe(20);
    expect(fixture.store.team(team.teamId).score).toBe(20);
    expect(freshView.body.problemCatalog[0]?.dashboardSlots).not.toEqual(
      originalView.body.problemCatalog[0]?.dashboardSlots,
    );
  } finally {
    await fixture?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
