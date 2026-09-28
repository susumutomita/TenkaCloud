import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGatewayPorts } from "../gateway-ports";
import { assertPortsFree, type HostProcessHandle, spawnHostProcess } from "./host-process";
import { adminLogin, apiCall, createEvent, expectOk, waitForReady } from "./http-client";
import { onInterrupt } from "./interrupt";
import { ProcessSampler, sqliteBytesTotal } from "./process-metrics";
import { WindowRecorder } from "./recorder";
import type { HttpRunResult, HttpStepRecord } from "./types";

const PROBLEM_ID = "ac26-crypto-battle";
const ADMIN_SESSION_REFRESH_MS = 10 * 60 * 1000;
const P95_THRESHOLD_MS = 2_000;
const ERROR_RATE_THRESHOLD = 0.01;
/** Bun's default cap on simultaneous `fetch()` calls in one process (bun.com/docs/runtime/networking/fetch). */
const BUN_DEFAULT_MAX_HTTP_REQUESTS = 256;

export interface HttpRunOptions {
  readonly repositoryRoot: string;
  readonly teams: number;
  readonly tabCounts: readonly number[];
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly adminPort: number;
  readonly participantPort: number;
  readonly gatewayPorts: string;
  readonly log: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((accept) => setTimeout(accept, ms));
}

/** Fixed-interval timer with a random phase offset. Unlike the portal it skips a tick while the previous request is in flight (`onDrop`). */
function scheduleTick(
  intervalMs: number,
  tick: () => Promise<void>,
  onDrop: () => void,
): () => void {
  let inFlight = false;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const fire = (): void => {
    if (stopped) return;
    if (inFlight) {
      onDrop();
      return;
    }
    inFlight = true;
    // `tick` itself never rejects today, but the organizer tab's token refresh can throw
    // (re-login failed, host already stopped); an unhandled rejection here would kill the process.
    void tick()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  const startTimeout = setTimeout(
    () => {
      if (stopped) return;
      fire();
      interval = setInterval(fire, intervalMs);
    },
    // eslint-disable-next-line sonarjs/pseudo-random -- spreads simulated tabs' polling phase; not security-sensitive.
    Math.random() * intervalMs,
  );
  return () => {
    stopped = true;
    clearTimeout(startTimeout);
    if (interval) clearInterval(interval);
  };
}

function runTick(
  origin: string,
  path: string,
  token: string,
  recorder: WindowRecorder,
  isProjection: boolean,
): Promise<void> {
  const start = performance.now();
  return apiCall(origin, path, "GET", token)
    .then((result) => {
      recorder.recordSuccess(performance.now() - start, result.status, isProjection);
    })
    .catch(() => {
      recorder.recordNetworkError();
    });
}

/** One participant tab's measured mix (see AGENTS-facing task notes): projection every 5s,
 * team view and leaderboard every 30s, notifications every 60s. */
function startParticipantTab(origin: string, token: string, recorder: WindowRecorder): () => void {
  const endpoints: readonly { path: string; intervalMs: number; isProjection: boolean }[] = [
    { path: "/portal/me/coordination/projection", intervalMs: 5_000, isProjection: true },
    { path: "/portal/me", intervalMs: 30_000, isProjection: false },
    { path: "/portal/leaderboard", intervalMs: 30_000, isProjection: false },
    { path: "/portal/me/notifications", intervalMs: 60_000, isProjection: false },
  ];
  const stops = endpoints.map((endpoint) =>
    scheduleTick(
      endpoint.intervalMs,
      () => runTick(origin, endpoint.path, token, recorder, endpoint.isProjection),
      () => recorder.recordDropped(),
    ),
  );
  return () => {
    for (const stop of stops) stop();
  };
}

function startOrganizerTab(
  origin: string,
  tokenProvider: () => Promise<string>,
  eventId: string,
  recorder: WindowRecorder,
): () => void {
  return scheduleTick(
    30_000,
    async () => {
      const token = await tokenProvider();
      await runTick(origin, `/events/${eventId}`, token, recorder, false);
    },
    () => recorder.recordDropped(),
  );
}

function warnIfAboveFetchCap(tabCounts: readonly number[], log: (message: string) => void): void {
  const cap = Number(process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? BUN_DEFAULT_MAX_HTTP_REQUESTS);
  if (Math.max(...tabCounts) <= cap) return;
  log(
    `warning: this ramp exceeds Bun's cap of ${String(cap)} ` +
      "simultaneous fetch() calls per process. Above that cap, this load generator queues " +
      "requests client-side, which can inflate latency independent of the server. Re-run with " +
      "BUN_CONFIG_MAX_HTTP_REQUESTS=<higher, up to 65535> set in the environment to rule this out.",
  );
}

export async function runHttpMode(options: HttpRunOptions): Promise<HttpRunResult> {
  warnIfAboveFetchCap(options.tabCounts, options.log);
  const gatewayRange = parseGatewayPorts(options.gatewayPorts);
  await assertPortsFree(options.adminPort, options.participantPort, gatewayRange);
  const dataDirectory = mkdtempSync(join(tmpdir(), "tenka-bench-http-"));
  let host: HostProcessHandle | undefined;
  const stopTabs: (() => void)[] = [];
  const releaseInterrupt = onInterrupt(() => {
    if (host) process.kill(host.pid, "SIGKILL");
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  try {
    host = await spawnHostProcess({
      repositoryRoot: options.repositoryRoot,
      dataDirectory,
      adminPort: options.adminPort,
      participantPort: options.participantPort,
      gatewayPorts: gatewayRange,
      readyTimeoutMs: 30_000,
    });
    const running = host;
    options.log(
      `http mode: host up at ${running.info.adminOrigin} / ${running.info.participantOrigin}`,
    );
    let adminToken = await adminLogin(running.info.adminOrigin, running.info.hostKey);
    let adminIssuedAt = Date.now();
    const ensureAdminToken = async (): Promise<string> => {
      if (Date.now() - adminIssuedAt > ADMIN_SESSION_REFRESH_MS) {
        adminToken = await adminLogin(running.info.adminOrigin, running.info.hostKey);
        adminIssuedAt = Date.now();
      }
      return adminToken;
    };
    const created = await createEvent(
      running.info.adminOrigin,
      adminToken,
      options.teams,
      PROBLEM_ID,
    );
    await expectOk(
      apiCall(
        running.info.adminOrigin,
        `/events/${created.eventId}/deploy`,
        "POST",
        adminToken,
        {},
      ),
      "deploy",
    );
    await waitForReady(running.info.adminOrigin, adminToken, created.eventId, 30_000);
    await expectOk(
      apiCall(
        running.info.adminOrigin,
        `/events/${created.eventId}/schedule`,
        "PATCH",
        adminToken,
        {
          startNow: true,
        },
      ),
      "schedule",
    );
    for (const team of created.teams)
      await expectOk(
        apiCall(
          running.info.participantOrigin,
          "/portal/me/coordination/op",
          "POST",
          team.teamLoginKey,
          {
            op: { kind: "ready" },
          },
        ),
        `ready:${team.teamId}`,
      );

    const recorder = new WindowRecorder();
    stopTabs.push(
      startOrganizerTab(running.info.adminOrigin, ensureAdminToken, created.eventId, recorder),
    );
    let activeTabCount = 0;
    const steps: HttpStepRecord[] = [];
    let stoppedEarly: HttpRunResult["stoppedEarly"] = null;
    for (const targetTabs of options.tabCounts) {
      while (activeTabCount < targetTabs) {
        const team = created.teams[activeTabCount % created.teams.length];
        if (!team) break;
        stopTabs.push(
          startParticipantTab(running.info.participantOrigin, team.teamLoginKey, recorder),
        );
        activeTabCount += 1;
      }
      options.log(`http mode: ramped to ${String(activeTabCount)} tabs, warming up`);
      await sleep(options.warmupSeconds * 1000);
      const bytesBefore = sqliteBytesTotal(running.databasePath);
      const sampler = new ProcessSampler(running.pid, 2_000);
      sampler.start();
      recorder.beginWindow();
      await sleep(options.durationSeconds * 1000);
      const usage = sampler.stop();
      const bytesAfter = sqliteBytesTotal(running.databasePath);
      const step = recorder.endWindow(
        activeTabCount,
        options.durationSeconds,
        usage.cpuPercent,
        usage.rssBytes,
        Math.max(0, bytesAfter - bytesBefore),
      );
      steps.push(step);
      options.log(
        `http mode: ${String(activeTabCount)} tabs -> p95=${step.overall.p95.toFixed(0)}ms ` +
          `errorRate=${(step.errorRate * 100).toFixed(2)}%`,
      );
      if (step.overall.p95 > P95_THRESHOLD_MS || step.errorRate > ERROR_RATE_THRESHOLD) {
        stoppedEarly = {
          atTabs: activeTabCount,
          reason:
            step.overall.p95 > P95_THRESHOLD_MS
              ? `p95 ${step.overall.p95.toFixed(0)}ms exceeded ${String(P95_THRESHOLD_MS)}ms`
              : `error rate ${(step.errorRate * 100).toFixed(2)}% exceeded ${String(ERROR_RATE_THRESHOLD * 100)}%`,
        };
        break;
      }
    }
    return { teams: options.teams, steps, stoppedEarly };
  } finally {
    for (const stop of stopTabs) stop();
    await host?.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
    releaseInterrupt();
  }
}
