import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const FIRST = "stackstack-onboarding";
const NEXT = "wp-exposed-backup";
const UNASSIGNED = "stackstack-ship";
const CHECKPOINTS = ["board-open", "log-trail", "board-open-for-posts", "handover"];
const NOW = Date.parse("2026-10-01T00:00:00Z");

test("local HTTP/SQLite and safe catalog project assigned course checkpoints, gates and restart", async () => {
  const data = createTemporaryDirectory(root, "tenka-course-");
  const filename = join(data, "hosting.sqlite");
  let store = new HostStore(new Database(filename));
  let service = new HostingService(
    store,
    new DockerHostingEngine(root, data),
    "course-test-key",
    () => NOW,
  );
  let portal: HttpHost | undefined;
  async function start() {
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: hostBuildDirectory(root, "participant-portal"),
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
      name: "Course tracks",
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
      assert.equal(track.trackId, "stackstack-route");
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
    const firstJob = store.jobs(event.eventId, alpha.teamId).find((job) => job.problemId === FIRST);
    assert.ok(firstJob);
    const firstJobId = firstJob.jobId;

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
    saveCheckpoints(CHECKPOINTS);
    const solved = await projected(alpha.teamLoginKey);
    assert.equal(solved.track.solvedCheckpoints, CHECKPOINTS.length);
    assert.equal(solved.track.solvedProblems, 1);
    assert.equal(solved.track.recommendedNext?.problemId, NEXT);
    assert.deepEqual(solved.view.progression?.lockedProblemIds, []);
    const independent = await projected(beta.teamLoginKey);
    assert.equal(independent.track.solvedCheckpoints, 0);
    assert.equal(independent.track.recommendedNext?.problemId, FIRST);
    assert.deepEqual(independent.view.progression?.lockedProblemIds, [NEXT]);
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
    assert.equal(persisted.track.solvedCheckpoints, CHECKPOINTS.length);
    assert.equal(persisted.track.recommendedNext?.problemId, NEXT);
    assert.deepEqual(persisted.view.progression?.lockedProblemIds, []);
  } finally {
    await stop();
    removeTemporaryDirectory(root, data);
  }
});
