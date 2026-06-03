#!/usr/bin/env bun
/**
 * [Issue #1666] Local attack-verification harness — I/O shell.
 *
 * Brings up a problem's `local/docker-compose.yaml` stack (the same containers as production,
 * per the problem README), fires every `scoring.attackProbes` declaration at the live app, and
 * asserts each one lands on the known-vulnerable baseline (response status ∈ `vulnerableStatus`).
 *
 * This makes the red-team attacks **continuously provable without a cloud account**: instead of a
 * one-off manual `docker compose up` + `curl`, one command stands the stack up, fires the exact
 * payloads the production scorer would fire (shared `joinUrl` + POST `application/json` semantics),
 * and fails loudly if any declared attack stops landing (metadata ↔ app drift = a hollow red-team).
 *
 *   bun run scripts/verify-attacks-local.ts                                  # security-battle-royale
 *   bun run scripts/verify-attacks-local.ts battles/security-battle-royale   # explicit problem dir
 *
 * Needs Docker. NOT wired into CI/before-commit (heavy + pulls images); it is an on-demand verifier.
 * The pure assertion logic is unit-tested in infrastructure/test/scripts/verify-attacks-local.test.ts.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateProbeOutcome,
  type ProbeOutcome,
  readAttackProbes,
  resolveLocalAttackProbes,
  summarizeVerification,
} from "./lib/verify-attacks-local";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_PROBLEM_DIR = "battles/security-battle-royale";

// Non-privileged, conflict-avoiding host ports for the local stack.
const API_PORT = process.env.VERIFY_API_PORT ?? "18080";
const FRONTEND_PORT = process.env.VERIFY_FRONTEND_PORT ?? "18081";
const DB_EXPOSE_PORT = process.env.VERIFY_DB_PORT ?? "13306";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const READINESS_TIMEOUT_MS = Number(process.env.VERIFY_READINESS_TIMEOUT_MS ?? "180000");
const READINESS_INTERVAL_MS = 3000;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const HTTP_OK = 200;

/** SKIP, not failure: a problem with no local stack / no attackProbes simply isn't locally verifiable. */
function skip(message: string): never {
  console.log(`SKIP: ${message}`);
  process.exit(EXIT_OK);
}

function composeEnv(problemRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PROBLEM_ROOT: problemRoot,
    API_PORT,
    FRONTEND_PORT,
    DB_EXPOSE_PORT,
    DB_PASSWORD: process.env.VERIFY_DB_PASSWORD ?? randomBytes(18).toString("base64url"),
    REGION,
  };
}

function dockerCompose(
  composeFile: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): number {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? EXIT_FAIL;
}

async function waitForReady(apiBaseUrl: string, deadlineMs: number): Promise<boolean> {
  const statusUrl = `${apiBaseUrl}/api/v1/apistatus`;
  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(4000) });
      if (res.status === HTTP_OK) return true;
    } catch {
      // container not listening yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, READINESS_INTERVAL_MS));
  }
  return false;
}

async function fireProbe(
  probe: ReturnType<typeof resolveLocalAttackProbes>[number],
): Promise<number> {
  const init: RequestInit = { method: probe.method, signal: AbortSignal.timeout(8000) };
  if (probe.method === "POST" && probe.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = probe.body;
  }
  const res = await fetch(probe.url, init);
  return res.status;
}

function reportOutcomes(outcomes: readonly ProbeOutcome[]): void {
  for (const o of outcomes) {
    const verdict = o.fired ? "✓ FIRED (vulnerable baseline)" : "✗ DID NOT FIRE";
    console.log(
      `  ${verdict}  ${o.name}  → ${o.actual} (expected one of [${o.expected.join(", ")}])`,
    );
  }
}

async function main(): Promise<number> {
  const problemDir = process.argv[2] ?? DEFAULT_PROBLEM_DIR;
  const problemRoot = join(REPO_ROOT, "problems", problemDir);
  const composeFile = join(problemRoot, "local", "docker-compose.yaml");
  const metadataPath = join(problemRoot, "metadata.json");

  if (!existsSync(composeFile)) {
    skip(
      `${problemDir} has no local/docker-compose.yaml — attack verification needs a cloud deploy`,
    );
  }
  if (!existsSync(metadataPath)) skip(`${problemDir} has no metadata.json`);

  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const probes = readAttackProbes(metadata);
  if (probes.length === 0) skip(`${problemDir} declares no scoring.attackProbes`);

  const apiBaseUrl = `http://localhost:${API_PORT}`;
  const resolved = resolveLocalAttackProbes(probes, {
    api: apiBaseUrl,
    frontend: `http://localhost:${FRONTEND_PORT}`,
  });

  const env = composeEnv(problemRoot);
  console.log(`▶ Bringing up local stack for ${problemDir} (api on ${apiBaseUrl}) …`);
  if (dockerCompose(composeFile, ["up", "-d"], env) !== EXIT_OK) {
    console.error("✗ docker compose up failed");
    return EXIT_FAIL;
  }

  try {
    console.log(
      `▶ Waiting for the app to become healthy (timeout ${READINESS_TIMEOUT_MS / 1000}s) …`,
    );
    if (!(await waitForReady(apiBaseUrl, Date.now() + READINESS_TIMEOUT_MS))) {
      console.error("✗ app never returned 200 on /api/v1/apistatus — cannot verify attacks");
      return EXIT_FAIL;
    }

    console.log(`▶ Firing ${resolved.length} declared attack-probe(s) at the live baseline app:`);
    const outcomes: ProbeOutcome[] = [];
    for (const probe of resolved) {
      const status = await fireProbe(probe);
      outcomes.push(evaluateProbeOutcome(probe, status));
    }
    reportOutcomes(outcomes);

    const summary = summarizeVerification(outcomes);
    if (summary.allFired) {
      console.log(
        `\n✓ All ${summary.total} declared attack(s) landed on the vulnerable baseline — red-team is real.`,
      );
      return EXIT_OK;
    }
    console.error(
      `\n✗ Only ${summary.firedCount}/${summary.total} attack(s) fired. A declared attack no longer ` +
        "lands — the metadata and the app have drifted (hollow red-team). Fix the probe path/payload or the app.",
    );
    return EXIT_FAIL;
  } finally {
    console.log("▶ Tearing down local stack …");
    dockerCompose(composeFile, ["down", "-v"], env);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`✗ verify-attacks-local failed: ${err instanceof Error ? err.message : err}`);
    process.exit(EXIT_FAIL);
  });
