import { createHash, randomBytes } from "node:crypto";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { normalizeSimulatorEndpointUrl } from "@tenkacloud/portal-contracts";
import { z } from "zod";
import type { ProbeFn, ProbeResult } from "../lib/http-probe-client";
import { type StackUnit, unitOf } from "./cloud-runtime-contract";
import { HostError, type Job } from "./model";
import type { ParticipantSessionCredentials } from "./participant-aws-contract";

/**
 * Owner-bound Battle capabilities of a Simulator started with `--battle-runtime-config`.
 *
 * The Simulator's EC2 host name is a reserved `.simulator.invalid` label, so the host never
 * fetches participant URLs. A registered URL is instead matched to the deployment's slot and
 * probed through the Simulator's operator-only capability endpoints, which reach the guest
 * service over the private VM network. The deadline uses this machine's wall clock, the same
 * clock the Simulator reads for its configured (protocol 1) domain.
 */
export interface SimulatorBattle {
  readonly clockDomain: string;
  /** A probe for this job's two Battle slots, or undefined when the job is not probeable. */
  probe(job: Job): ProbeFn | undefined;
  /** Stop new probe admissions before the stack is deleted. */
  seal(job: Job): Promise<void>;
  /** A one-use participant terminal code, signed with the participant's viewer credentials. */
  terminal(
    input: {
      readonly credentials: ParticipantSessionCredentials;
      readonly instanceId: string;
      readonly region: string;
    },
    assertCurrent: () => void,
  ): Promise<{ readonly code: string; readonly terminalUrl: string; readonly expiresAt: string }>;
}

export interface BattleOwner {
  readonly eventId: string;
  readonly teamId: string;
  readonly jobId: string;
  readonly unitHash: string;
  readonly deployedAt: number;
  readonly stackId: string;
  readonly instanceId: string;
}

/** The fixed services of `hello-world-battle`, as the Simulator receipt names them. */
const SLOTS = [
  { slot: "frontend", port: 80, path: "/" },
  { slot: "api", port: 8080, path: "/healthz" },
] as const;
const PROBE_WINDOW_MS = 8_000;
const SETTLE_WAIT_MS = 12_000;

const availabilitySchema = z.object({
  configured: z.boolean(),
  protocolVersion: z.number().int(),
  clockDomain: z.string().min(1).max(128),
});
const receiptSchema = z.object({
  version: z.literal(1),
  handle: z.string().min(1),
  clockDomain: z.string().min(1),
  binding: z.object({ endpoints: z.record(z.string(), z.string()) }),
  slots: z.record(
    z.string(),
    z.object({
      wireBinding: z.unknown(),
      service: z.object({ name: z.string().min(1), path: z.string(), port: z.number().int() }),
    }),
  ),
});
const snapshotSchema = z.object({
  resultReady: z.boolean().optional(),
  settled: z.boolean().optional(),
  result: z
    .object({
      error: z.string().nullable().optional(),
      observation: z
        .object({
          status: z.number().int().optional(),
          path: z.string().optional(),
          startedAtMs: z.number().optional(),
          receivedAtMs: z.number().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
const terminalSchema = z.object({
  Code: z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
  ExpiresAt: z.iso.datetime({ offset: true }),
});

/** Exactly the Simulator's `battleKey`: length-prefixed fields hashed with SHA-256. */
export function battleKey(owner: BattleOwner): string {
  const hash = createHash("sha256");
  for (const value of [
    owner.eventId,
    owner.teamId,
    owner.jobId,
    owner.unitHash,
    String(owner.deployedAt),
    owner.stackId,
    owner.instanceId,
  ])
    hash.update(`${Buffer.byteLength(value)}:${value}`);
  return hash.digest("hex");
}

/** The immutable deployment identity the Simulator binds a receipt to on first resolve. */
export function battleOwner(job: Job): BattleOwner | undefined {
  if (job.status !== "COMPLETE" || !job.unit || !job.deployedAt) return undefined;
  let unit: StackUnit;
  try {
    unit = unitOf(job);
  } catch {
    return undefined;
  }
  const instanceId = unit.outputs?.InstanceId;
  if (!unit.stackId || !instanceId) return undefined;
  return {
    eventId: job.eventId,
    teamId: job.teamId,
    jobId: job.jobId,
    unitHash: createHash("sha256").update(job.unit).digest("hex"),
    deployedAt: job.deployedAt,
    stackId: unit.stackId,
    instanceId,
  };
}

/** The receipt slot a registered URL names: only the deployment's own host, port and path. */
export function battleSlotFor(url: string, hostHint: string): (typeof SLOTS)[number] | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search) return;
  if (parsed.hostname !== hostHint.toLowerCase()) return undefined;
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  return SLOTS.find((slot) => slot.port === port && slot.path === parsed.pathname);
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("Simulator returned no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Error("Simulator response exceeded its size limit.");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
  }
}

type Receipt = z.infer<typeof receiptSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

/** The receipt's own slot must be the problem's service, or the Simulator is not this guest. */
function receiptSlot(receipt: Receipt, slot: (typeof SLOTS)[number]) {
  const mapping = receipt.slots[slot.slot];
  const base = receipt.binding.endpoints[slot.slot];
  if (!mapping || !base || mapping.service.port !== slot.port || mapping.service.path !== slot.path)
    throw new Error("Simulator Battle receipt does not match the problem's slots.");
  return { mapping, base };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Undefined when the Simulator has no configured Battle runtime (including Simulators that predate
 * the capability): Battle problems then stay unavailable, exactly as before.
 */
export async function connectSimulatorBattle(
  endpoint: string,
  operatorToken: string,
  guard: () => void,
  httpFetch: Fetch = fetch,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SimulatorBattle | undefined> {
  const origin = normalizeSimulatorEndpointUrl(endpoint);
  const operator = async (path: string, body: unknown): Promise<Response> => {
    guard();
    return httpFetch(new URL(path, origin).href, {
      method: "POST",
      headers: { "X-Simulator-Token": operatorToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  };
  const response = await operator("/_simulator/v1/battle-capabilities/availability", {
    version: 1,
  });
  // 404: a Simulator build without the Battle runtime routes. Any other failure is an error.
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Simulator Battle availability check failed (HTTP ${response.status}).`);
  }
  const availability = availabilitySchema.parse(await boundedJson(response, 4096));
  // Protocol 2 requires the owned-clock exchange this host does not implement.
  if (!availability.configured || availability.protocolVersion !== 1) return undefined;

  const receipts = new Map<string, Receipt>();
  const resolve = async (owner: BattleOwner, key: string) => {
    const cached = receipts.get(key);
    if (cached) return cached;
    const response = await operator("/_simulator/v1/battle-capabilities/resolve", {
      version: 1,
      owner,
      key,
    });
    if (!response.ok) {
      await response.body?.cancel();
      // An unready or unregistered guest is a Simulator state, not a participant failure.
      throw new Error(`Simulator Battle receipt unavailable (HTTP ${response.status}).`);
    }
    const receipt = receiptSchema.parse(await boundedJson(response, 64 * 1024));
    if (receipt.clockDomain !== availability.clockDomain)
      throw new Error("Simulator Battle receipt names another clock domain.");
    receipts.set(key, receipt);
    return receipt;
  };
  const command = async (url: string, body: unknown) => {
    const response = await operator(new URL(url, origin).pathname, body);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Simulator Battle probe command failed (HTTP ${response.status}).`);
    }
    return snapshotSchema.parse(await boundedJson(response, 64 * 1024));
  };

  /** Reads until the probe has settled; an unsettled probe is a Simulator error, not a failure. */
  const settle = async (first: Snapshot, read: () => Promise<Snapshot>) => {
    let snapshot = first;
    const waitUntil = now() + SETTLE_WAIT_MS;
    while (!(snapshot.resultReady && snapshot.settled)) {
      if (now() >= waitUntil) throw new Error("Simulator Battle probe did not settle.");
      await sleep(250);
      snapshot = await read();
    }
    return snapshot;
  };

  return {
    clockDomain: availability.clockDomain,
    probe(job) {
      const owner = battleOwner(job);
      const hint = owner ? unitOf(job).outputs?.Ec2HostHint : undefined;
      if (!owner || !hint) return undefined;
      const key = battleKey(owner);
      return async (url, options = {}): Promise<ProbeResult> => {
        const started = now();
        const slot = battleSlotFor(url, hint);
        // Any other URL is not this deployment's service: a failed probe, as an unreachable one.
        if (!slot) return { ok: false, status: undefined, responseTimeMs: 0 };
        const receipt = await resolve(owner, key);
        const { mapping, base } = receiptSlot(receipt, slot);
        const common = {
          version: 1,
          binding: mapping.wireBinding,
          service: mapping.service.name,
          key: randomBytes(16).toString("hex"),
        };
        const snapshot = await settle(
          await command(`${base}/start`, {
            ...common,
            command: "start",
            deadline: { domain: receipt.clockDomain, epochMs: now() + PROBE_WINDOW_MS },
          }),
          () => command(`${base}/read`, { ...common, command: "read" }),
        );
        const observation = snapshot.result?.observation ?? undefined;
        const status = observation?.status;
        const expected = options.expectStatus ?? [200];
        return {
          ok: status !== undefined && expected.includes(status) && observation?.path === slot.path,
          status,
          responseTimeMs: now() - started,
        };
      };
    },
    async seal(job) {
      const owner = battleOwner(job);
      if (!owner) return;
      const key = battleKey(owner);
      receipts.delete(key);
      const response = await operator("/_simulator/v1/battle-capabilities/seal", {
        version: 1,
        owner,
        key,
      });
      await response.body?.cancel();
      // 409: the guest never became ready or was already released; deletion still proceeds.
      if (!response.ok && response.status !== 409)
        throw new Error(`Simulator Battle seal failed (HTTP ${response.status}).`);
    },
    async terminal({ credentials, instanceId, region }, assertCurrent) {
      assertCurrent();
      guard();
      if (
        !/^i-[a-f0-9]{8,32}$/u.test(instanceId) ||
        !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d{1,2}$/u.test(region) ||
        credentials.expiration.getTime() <= now()
      )
        throw new HostError(409, "This guest terminal target is not ready.", "not_ready");
      try {
        const url = new URL("/_simulator/v1/terminal-handoffs", origin);
        const body = JSON.stringify({ Target: instanceId, Region: region });
        const signed = await new SignatureV4({
          credentials,
          region,
          service: "sts",
          sha256: Sha256,
        }).sign({
          method: "POST",
          protocol: url.protocol,
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          headers: { host: url.host, "content-type": "application/json" },
          body,
        });
        assertCurrent();
        guard();
        const response = await httpFetch(url.href, {
          method: "POST",
          headers: signed.headers,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Simulator terminal handoff request failed.");
        }
        const handoff = terminalSchema.parse(await boundedJson(response, 4096));
        const expiry = Date.parse(handoff.ExpiresAt);
        if (expiry <= now() || expiry > now() + 120_000)
          throw new Error("Simulator returned an invalid terminal handoff lifetime.");
        assertCurrent();
        return {
          code: handoff.Code,
          terminalUrl: new URL("/_simulator/terminal", origin).href,
          expiresAt: new Date(expiry).toISOString(),
        };
      } catch (error) {
        if (error instanceof HostError) throw error;
        throw new HostError(
          502,
          "The guest terminal code could not be issued. Retry while the environment is running.",
          "simulator_terminal_failed",
        );
      }
    },
  };
}
