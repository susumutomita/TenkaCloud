/** Competition UI boundaries over real local HTTP/SQLite, catalog and Docker projections.
 * Checkpoints are seeded saved state; no Docker container or verifier is executed. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  buildCourseTracks,
  toProblemProgress,
} from "../../../apps/participant-portal/src/data/course-track";
import type { ParticipantTeamView } from "../../../packages/portal-contracts/src/index";
import { metadataToEntry } from "../../../packages/portal-contracts/src/problem-catalog";
import { apiRequest, type CreatedEvent } from "../bench/state-setup";
import { publicMetadata } from "../browser-metadata";
import { hostBuildDirectory } from "../build";
import type { LocalPlaySnapshot } from "../container/state-store";
import { DockerHostingEngine } from "../docker-engine";
import { type HttpHost, startHttpHost } from "../http";
import { HostingService } from "../service";
import { HostStore } from "../store";
import { createTemporaryDirectory, removeTemporaryDirectory } from "../temporary-directory";
import { bootstrapOrganizer } from "./organizer-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const FIRST = "db-a1-table-primary-key";
const NEXT = "db-a2-index-tradeoff";
const UNASSIGNED = "db-a3-query-plan";
const CHECKPOINTS = [
  "members-table-has-primary-key",
  "members-rows-loaded",
  "duplicate-insert-rejected",
];
const NOW = Date.parse("2026-10-01T00:00:00Z");

export async function verifyCourseTracks(runBrowser = false): Promise<void> {
  const data = createTemporaryDirectory(root, "tenka-course-browser-");
  const filename = join(data, "hosting.sqlite");
  let store = new HostStore(new Database(filename));
  let service = new HostingService(
    store,
    new DockerHostingEngine(root, data),
    "course-test-key",
    () => NOW,
  );
  let portal: HttpHost | undefined;
  let browser: Browser | undefined;
  const errors: string[] = [];
  async function start() {
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot:
        process.env.HOST_E2E_PARTICIPANT_BUILD ?? hostBuildDirectory(root, "participant-portal"),
      service,
    });
  }
  async function stop() {
    await portal?.close();
    portal = undefined;
    await service.drain();
    service.flush();
    store.close();
  }
  try {
    const token = await bootstrapOrganizer(service, "course-test-key");
    async function admin(method: string, path: string, body: unknown = {}) {
      const result = await service.admin(apiRequest({ method, path, token, body }));
      assert.ok(result.status < 300, `${path}: ${JSON.stringify(result)}`);
      return result;
    }
    const created = await admin("POST", "/events", {
      name: "Course browser rehearsal",
      teams: [{ internalSlug: "alpha" }, { internalSlug: "beta" }],
      problems: [{ problemId: NEXT }, { problemId: FIRST }],
    });
    const event = created.body as CreatedEvent;
    const [alpha, beta] = event.teams;
    assert.ok(alpha && beta);
    const alphaTeamId = alpha.teamId;
    await admin("POST", `/events/${event.eventId}/deploy`);
    await service.drain();
    await admin("PATCH", `/events/${event.eventId}/schedule`, { startNow: true });
    await admin("PUT", "/feature-flags", { key: "challengePrerequisiteGate", enabled: true });
    await admin("PUT", `/events/${event.eventId}/progression-gate`, {
      gateProblemId: FIRST,
      unlockTargetIds: [NEXT],
      defaultPolicy: "required",
      completionBonus: 0,
    });
    assert.ok(
      store.jobs(event.eventId).every((job) => job.status === "STOPPED" && job.unit === null),
    );
    await start();
    assert.ok(portal);
    const runtime = await (await fetch(`${portal.origin}/runtime-config.json`)).json();
    assert.equal(runtime.mode, "local-host");
    assert.equal(runtime.role, "participant");
    assert.equal(runtime.apiBaseUrl, `${portal.origin}/api`);
    assert.equal(runtime.hasAws, false);
    const catalog = [FIRST, NEXT, UNASSIGNED].map((id) => {
      const path = join(root, "problems/challenges", id, "metadata.json");
      const publicJson = publicMetadata(readFileSync(path, "utf8"), path);
      assert.ok(publicJson);
      return metadataToEntry(JSON.parse(publicJson));
    });
    async function projected(key: string) {
      assert.ok(portal);
      const response = await fetch(`${portal.origin}/api/portal/me`, {
        headers: { authorization: `Bearer ${key}` },
      });
      assert.equal(response.status, 200);
      const view = (await response.json()) as ParticipantTeamView;
      const assignedIds = new Set(view.problems.map((problem) => problem.problemId));
      const tracks = buildCourseTracks(
        catalog.filter((entry) => assignedIds.has(entry.id)),
        toProblemProgress(view.problems),
      );
      assert.equal(tracks.length, 1);
      const track = tracks[0];
      assert.ok(track);
      assert.equal(track.trackId, "database-track");
      assert.deepEqual(
        track.chapters.flatMap((chapter) => chapter.problems.map((problem) => problem.problemId)),
        [FIRST, NEXT],
      );
      return { view, track };
    }
    const initial = await projected(alpha.teamLoginKey);
    assert.equal(initial.track.solvedCheckpoints, 0);
    assert.equal(initial.track.recommendedNext?.problemId, FIRST);
    assert.deepEqual(initial.view.progression?.lockedProblemIds, [NEXT]);
    if (runBrowser)
      browser = await chromium.launch({ executablePath: process.env.HOST_E2E_CHROMIUM });
    async function login(key: string): Promise<Page> {
      assert.ok(browser && portal);
      const page = await browser.newPage({ locale: "en-US" });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.clock.setFixedTime(new Date(NOW));
      await page.goto(`${portal.origin}/login#invite=${encodeURIComponent(key)}`);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      await page.locator('a[href="/problems"]').waitFor();
      assert.equal(await page.locator('a[href="/course-tracks"]').count(), 0);
      // A shared/bookmarked learning URL cannot enter the course UI in a competition.
      await page.goto(`${portal.origin}/course-tracks`);
      await page.waitForURL((url) => url.pathname === "/");
      await page.locator('a[href="/problems"]').click();
      await page.getByRole("heading", { name: "Problems (Quests)", exact: true }).waitFor();
      await page.locator('a[href^="/problems/"]').first().waitFor();
      assert.equal(await page.locator('a[href="/course-tracks"]').count(), 0);
      assert.equal(await page.locator('[data-testid^="course-problem-"]').count(), 0);
      return page;
    }
    const player = browser ? await login(alpha.teamLoginKey) : undefined;
    const firstJob = store.jobs(event.eventId, alpha.teamId).find((job) => job.problemId === FIRST);
    assert.ok(firstJob);
    const firstJobId = firstJob.jobId;
    const href = `/problems/${firstJob.jobId}`;
    if (player) {
      const assignedLinks = await player
        .locator('a[href^="/problems/"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
      assert.deepEqual(
        assignedLinks.toSorted((a, b) => a.localeCompare(b)),
        initial.view.problems
          .map((problem) => `/problems/${problem.jobId}`)
          .toSorted((a, b) => a.localeCompare(b)),
      );
      await player.getByText("Locked", { exact: true }).waitFor();
      await player.locator(`a[href="${href}"]`).click();
      await player.waitForURL((url) => url.pathname === href);
      await player.goBack();
      await player.locator(`a[href="${href}"]`).waitFor();
      await player.goForward();
      await player.waitForURL((url) => url.pathname === href);
      await player.goBack();
      await player.locator(`a[href="${href}"]`).waitFor();
      assert.equal(await player.locator('a[href="/course-tracks"]').count(), 0);
    }

    // Seed the existing serialized score/checkpoint contract, then use the normal
    // engine -> HTTP -> team view -> course projection to read it back. Learning data
    // stays available without making a competition's navigation a learning portal.
    function saveCheckpoints(solved: readonly string[]) {
      const team = store.team(alphaTeamId);
      const complete = solved.length === CHECKPOINTS.length;
      const snapshot: LocalPlaySnapshot = {
        version: 1,
        teamName: team.displayName,
        runtimes: {
          [FIRST]: { solved, revealedHints: [], wrongCounts: [], score: complete ? 100 : 0 },
        },
        simulatedRuntimes: {},
        scoreEvents: complete
          ? [
              {
                jobId: firstJobId,
                problemId: FIRST,
                source: "flag",
                points: 100,
                result: "ok",
                occurredAt: new Date(NOW).toISOString(),
              },
            ]
          : [],
      };
      team.snapshot = JSON.stringify(snapshot);
      team.score = complete ? 100 : 0;
      team.completedProblems = complete ? 1 : 0;
      team.scoreEvents = [...snapshot.scoreEvents];
      store.transaction(() => {
        store.putTeam(team);
        service.progression.captureTeam(team);
      });
    }
    saveCheckpoints(CHECKPOINTS.slice(0, 1));
    assert.equal((await projected(alpha.teamLoginKey)).track.solvedCheckpoints, 1);
    if (player) {
      await player.reload();
      await player.locator(`a[href="${href}"]`).waitFor();
      await player.getByText("In progress (1/3)", { exact: true }).waitFor();
      await player.getByText("Locked", { exact: true }).waitFor();
    }
    saveCheckpoints(CHECKPOINTS);
    const solved = await projected(alpha.teamLoginKey);
    assert.equal(solved.track.solvedCheckpoints, 3);
    assert.equal(solved.track.solvedProblems, 1);
    assert.equal(solved.track.recommendedNext?.problemId, NEXT);
    assert.deepEqual(solved.view.progression?.lockedProblemIds, []);
    const independent = await projected(beta.teamLoginKey);
    assert.equal(independent.track.solvedCheckpoints, 0);
    assert.equal(independent.track.recommendedNext?.problemId, FIRST);
    assert.deepEqual(independent.view.progression?.lockedProblemIds, [NEXT]);
    if (player) {
      await player.reload();
      await player.getByText("Cleared (1)", { exact: true }).waitFor();
      assert.equal(await player.getByText("Locked", { exact: true }).count(), 0);
      const other = await login(beta.teamLoginKey);
      await other.getByText("Cleared (0)", { exact: true }).waitFor();
      await other.getByText("Locked", { exact: true }).waitFor();
    }
    await stop();
    store = new HostStore(new Database(filename));
    service = new HostingService(
      store,
      new DockerHostingEngine(root, data),
      "course-test-key",
      () => NOW,
    );
    await service.recover();
    await start();
    const persisted = await projected(alpha.teamLoginKey);
    assert.equal(persisted.track.solvedCheckpoints, 3);
    assert.equal(persisted.track.recommendedNext?.problemId, NEXT);
    assert.deepEqual(persisted.view.progression?.lockedProblemIds, []);
    if (browser) {
      const restored = await login(alpha.teamLoginKey);
      await restored.getByText("Cleared (1)", { exact: true }).waitFor();
      assert.equal(await restored.getByText("Locked", { exact: true }).count(), 0);
      const artifacts = join(root, ".tenkacloud/host-e2e");
      mkdirSync(artifacts, { recursive: true });
      await restored.screenshot({
        path: join(artifacts, "competition-course-boundary.png"),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    if (runBrowser)
      console.log(
        "PASS local competition/course boundary: no course navigation or route, assigned problem links/back/forward, safe built metadata, checkpoint/gate projection, team isolation and SQLite restart. Saved checkpoints were seeded; Docker verifiers were not run.",
      );
  } finally {
    await browser?.close();
    await stop();
    removeTemporaryDirectory(root, data);
  }
}

if (import.meta.main)
  void verifyCourseTracks(true).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
