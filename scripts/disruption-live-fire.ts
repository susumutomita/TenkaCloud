#!/usr/bin/env bun
/**
 * [Issue #1419 / #1666] AWS disruption live-fire — I/O shell.
 *
 * Fires one operator disruption against a real deployed event and captures the evidence #1419/#1666
 * need: an observable fault in the target stack that auto-reverts within its window. Run it on the
 * AWS account that hosts the platform + a team that has the problem deployed.
 *
 *   # 1. Inspect the exact request first — no network call, no AWS needed:
 *   bun run scripts/disruption-live-fire.ts --dry-run \
 *     --api https://<event-api> --event <eventId> --team <teamId> --app-url http://<host>:8080/api/v1/apistatus
 *
 *   # 2. Fire for real (needs an operator JWT) and capture evidence to a file:
 *   DISRUPTION_JWT=<bearer> bun run scripts/disruption-live-fire.ts \
 *     --api https://<event-api> --event <eventId> --team <teamId> \
 *     --app-url http://<host>:8080/api/v1/apistatus --evidence evidence.json
 *
 * Defaults target security-battle-royale / availability-flood (an ssm-run-command flood that
 * saturates the app for ~30s then reverts). The pure request-builder + timeline judge are
 * unit-tested in infrastructure/test/scripts/disruption-live-fire.test.ts.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  assessLiveFire,
  buildFireRequest,
  classifySample,
  evaluateFaultTimeline,
  type FireRequestInput,
  type HealthSample,
} from "./lib/disruption-live-fire";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const HTTP_OK = 200;

interface Args {
  readonly apiBaseUrl: string;
  readonly eventId: string;
  readonly problemId: string;
  readonly disruptionId: string;
  readonly scope: "all" | "team" | "random-n";
  readonly teamId?: string;
  readonly appProbeUrl: string;
  readonly observeSeconds: number;
  readonly pollSeconds: number;
  readonly maxRecoverySeconds: number;
  readonly dryRun: boolean;
  readonly evidencePath?: string;
}

function getFlag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const scope = (getFlag(argv, "scope") ?? "team") as Args["scope"];
  const teamId = getFlag(argv, "team");
  const apiBaseUrl = getFlag(argv, "api");
  const eventId = getFlag(argv, "event");
  const appProbeUrl = getFlag(argv, "app-url");
  if (!apiBaseUrl || !eventId || !appProbeUrl) {
    throw new Error(
      "required: --api <eventApiBaseUrl> --event <eventId> --app-url <targetHealthUrl>",
    );
  }
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
    eventId,
    problemId: getFlag(argv, "problem") ?? "security-battle-royale",
    disruptionId: getFlag(argv, "disruption") ?? "availability-flood",
    scope,
    ...(teamId ? { teamId } : {}),
    appProbeUrl,
    observeSeconds: Number(getFlag(argv, "observe") ?? "180"),
    pollSeconds: Number(getFlag(argv, "poll") ?? "5"),
    maxRecoverySeconds: Number(getFlag(argv, "max-recovery") ?? "150"),
    dryRun: argv.includes("--dry-run"),
    ...(getFlag(argv, "evidence") ? { evidencePath: getFlag(argv, "evidence") } : {}),
  };
}

function toFireInput(args: Args): FireRequestInput {
  return {
    problemId: args.problemId,
    disruptionId: args.disruptionId,
    scope: args.scope,
    ...(args.scope === "team" && args.teamId ? { targetTeamIds: [args.teamId] } : {}),
    requestId: `live-fire-${randomBytes(8).toString("hex")}`,
  };
}

async function probe(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.status;
  } catch {
    return null;
  }
}

async function fireDisruption(args: Args, body: Record<string, unknown>): Promise<void> {
  const jwt = process.env.DISRUPTION_JWT;
  if (!jwt) throw new Error("DISRUPTION_JWT env var (operator bearer token) is required to fire");
  const res = await fetch(`${args.apiBaseUrl}/events/${args.eventId}/disruptions/fire`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (res.status !== HTTP_OK && res.status !== 202) {
    throw new Error(`fire failed: HTTP ${res.status} ${await res.text()}`);
  }
  console.log(
    `▶ Fired (HTTP ${res.status}). Audit row written; executor Lambda will inject cross-account.`,
  );
}

async function observe(args: Args, firedAtMs: number): Promise<HealthSample[]> {
  const samples: HealthSample[] = [];
  const deadline = firedAtMs + args.observeSeconds * 1000;
  while (Date.now() < deadline) {
    const status = await probe(args.appProbeUrl);
    const s = classifySample(Date.now(), status, [HTTP_OK]);
    samples.push(s);
    console.log(
      `  t+${Math.round((s.atMs - firedAtMs) / 1000)}s  status=${status ?? "ERR"}  ${s.healthy ? "healthy" : "FAULTED"}`,
    );
    await new Promise((r) => setTimeout(r, args.pollSeconds * 1000));
  }
  return samples;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const body = buildFireRequest(toFireInput(args));

  if (args.dryRun) {
    console.log("DRY-RUN — the exact request that would be sent (no network call):\n");
    console.log(`POST ${args.apiBaseUrl}/events/${args.eventId}/disruptions/fire`);
    console.log("authorization: Bearer $DISRUPTION_JWT");
    console.log(`content-type: application/json\n\n${JSON.stringify(body, null, 2)}`);
    console.log(
      `\nThen polls ${args.appProbeUrl} every ${args.pollSeconds}s for ${args.observeSeconds}s,`,
    );
    console.log(`expecting: healthy → FAULTED → recovered within ${args.maxRecoverySeconds}s.`);
    return EXIT_OK;
  }

  console.log(`▶ Baseline probe of ${args.appProbeUrl} …`);
  const baseline = classifySample(Date.now(), await probe(args.appProbeUrl), [HTTP_OK]);
  if (!baseline.healthy) {
    console.error(
      `✗ target is not healthy before firing (status=${baseline.status ?? "ERR"}); aborting`,
    );
    return EXIT_FAIL;
  }

  const firedAtMs = Date.now();
  await fireDisruption(args, body);
  const samples = [baseline, ...(await observe(args, firedAtMs))];

  const timeline = evaluateFaultTimeline(samples, firedAtMs);
  const assessment = assessLiveFire(timeline, { maxRecoveryMs: args.maxRecoverySeconds * 1000 });
  const evidence = { firedAtMs, request: body, timeline, assessment, samples };

  if (args.evidencePath) {
    writeFileSync(args.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`▶ Evidence written to ${args.evidencePath}`);
  }
  console.log(
    `\n${assessment.verdict === "pass" ? "✓" : "✗"} ${assessment.verdict.toUpperCase()}: ${assessment.reason}`,
  );
  return assessment.verdict === "pass" ? EXIT_OK : EXIT_FAIL;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`✗ disruption-live-fire failed: ${err instanceof Error ? err.message : err}`);
    process.exit(EXIT_FAIL);
  });
