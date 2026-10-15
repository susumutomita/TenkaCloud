import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ComposeCli,
  composeArgsForCli,
  generateSecretEnv,
  isComposeUnitRunning,
  resolveComposeCli,
} from "./container/compose-cli";
import { assertComposePolicy } from "./container/compose-policy";
import type { LocalComposeUnit, StartedContainer } from "./container/container-runner";
import { LoopbackRelays, relayCompose } from "./container/loopback-relay";
import { remapContainerProblem } from "./container/port-remap";
import type { RelayBinding } from "./container/relay-target";
import { revealContainerHint, submitFlag } from "./container/scoring";
import { createContainerState } from "./container/session";
import { sessionScore } from "./container/state";
import {
  parseLocalPlaySnapshot,
  restoreLocalPlayState,
  snapshotLocalPlayState,
} from "./container/state-store";
import {
  spawnDeclaredTerminal,
  type TerminalHandlers,
  type TerminalProcess,
} from "./container/terminal-shell";
import { verifySubmission } from "./container/verify-client";
import { teamView } from "./container/views";
import { requestWorkbench, type WorkbenchAction } from "./container/workbench-client";
import { boundedCompose } from "./container-budget";
import {
  type DockerDefinition as Definition,
  dockerDefinitionOf as definitionOf,
  loadDockerCatalog,
} from "./docker-catalog";
import {
  allocateNetworkSubnets,
  applyNetworkSubnets,
  DockerNetworkInventoryError,
  type NetworkSubnets,
  occupiedDockerSubnets,
} from "./docker-networks";
import { LinuxNetworkGuard, type LocalNetworkGuard } from "./linux-network-guard";
import {
  assertNoNetworkOverlap,
  isolatedCompose,
  type LocalNetworkPlan,
  localNetworkPlan,
  requiredNetworkValue,
  retainedPublicPlan,
  sharedNetworkPlan,
} from "./local-network";
import {
  type Context,
  definitionKind,
  type EngineResult,
  HostError,
  type Job,
  object,
  type Problem,
  type RuntimeEngine,
} from "./model";
import { relayTarget } from "./network-audit";
import { assertPublicServiceSeparation, type NetworkPublicationView } from "./network-publication";
import { prepareRuntimeDirectory, removeRuntimeFiles } from "./runtime-directory";
import { type RuntimePorts, remapRuntimeComposePorts } from "./runtime-ports";
import { VpnPolicyRevoked } from "./vpn/native-ingress";

type ComposeAction = "up" | "down" | "stop" | "restart";

/** `teardown: "down"` records a confirmed Compose down whose owned guard and files still need removal. */
type RetainedUnit = LocalComposeUnit & { readonly teardown?: "down" };

const REMOVED_UNIT =
  "Competition workloads were removed, but guard cleanup could not be confirmed; retry its removal.";

/** Recognizes "no daemon" across Docker CLI generations, Docker Desktop and Compose v1. */
const DAEMON_UNAVAILABLE =
  /cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|daemon is not running|error during connect/iu;

export const DAEMON_UNAVAILABLE_MESSAGE =
  "Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry the deployment from the host console.";

/** A Compose failure caused by an unreachable daemon, never by the problem itself. */
export class DockerDaemonUnavailableError extends Error {
  constructor() {
    super(DAEMON_UNAVAILABLE_MESSAGE);
    this.name = "DockerDaemonUnavailableError";
  }
}

function composeCommandArgs(
  cli: ComposeCli,
  unit: LocalComposeUnit,
  action: ComposeAction,
): string[] {
  if (action === "up" || action === "down")
    return composeArgsForCli(
      cli,
      unit.composePath,
      unit.composeProjectName,
      action,
      unit.projectDirectory,
    );
  // `stop` keeps containers and volumes; `restart` starts stopped or running ones in place.
  const args = [
    "-f",
    unit.composePath,
    "-p",
    unit.composeProjectName,
    ...(unit.projectDirectory ? ["--project-directory", unit.projectDirectory] : []),
    action,
  ];
  return cli.command === "docker-compose" ? args : ["compose", ...args];
}

async function compose(
  unit: LocalComposeUnit,
  action: ComposeAction,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const cli = resolveComposeCli();
  const args = composeCommandArgs(cli, unit, action);
  await new Promise<void>((accept, reject) => {
    const child = spawn(cli.command, args, {
      env:
        unit.isolationVersion === 1
          ? { ...environment, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "" }
          : environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    child.stderr.on("data", (chunk) => {
      tail = (tail + String(chunk)).slice(-16_384);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      // Do not send build logs or interpolated environment values to a competitor.
      if (code === 0) accept();
      else if (DAEMON_UNAVAILABLE.test(tail)) reject(new DockerDaemonUnavailableError());
      else if (/all predefined address pools have been fully subnetted/iu.test(tail))
        reject(
          new Error(
            "Docker has no free network address pool. Stopping an environment preserves its network and unfinished work. Configure a non-overlapping --docker-network-pool for new environments, or explicitly retire completed environments. No unrelated networks or retained team data were removed.",
          ),
        );
      else
        reject(
          new Error(
            `Docker Compose ${action} failed (exit ${String(code)}). Inspect project ${unit.composeProjectName} on the host.`,
          ),
        );
    });
  });
}

async function ready(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return;
    } catch {
      await new Promise((accept) => setTimeout(accept, 250));
    }
  }
  throw new Error("The problem's verifier did not become reachable within one minute.");
}

export class DockerHostingEngine implements RuntimeEngine {
  readonly supportsOnDemand = true;
  containerCost(definition: string) {
    return boundedCompose((JSON.parse(definition) as Definition).composeText).cost;
  }
  private problems: Problem[] | undefined;
  private readonly relays = new Map<string, LoopbackRelays>();
  private readonly relayClosures = new Map<string, Promise<void>>();
  private readonly running = new Map<string, StartedContainer>();
  private readonly networkReservations = new Map<string, readonly string[]>();
  private networkState?: Parameters<NonNullable<RuntimeEngine["bindNetworkState"]>>[0];
  private publicMutation: Promise<void> = Promise.resolve();
  private readonly publicationBarriers = new Map<string, Promise<void>>();
  private readonly publicViews = new Map<
    string,
    { unit: string; value: Promise<NetworkPublicationView["shared"]> }
  >();
  private readonly guardProofs = new Map<
    string,
    { unit: LocalComposeUnit; verifiedAt: number; attemptedAt: number }
  >();
  private readonly guardAudits = new Map<string, Promise<void>>();
  private readonly guardRevocations = new Set<Promise<void>>();
  private readonly pendingHalts = new Map<string, Promise<never>>();
  private readonly unconfirmedHalts = new Map<string, { job: Job; unit: LocalComposeUnit }>();
  private readonly policyEpochs = new Map<string, number>();
  private applyingPublicationEvent?: string;
  private policyEpoch(eventId: string): number {
    return this.policyEpochs.get(eventId) ?? 0;
  }
  private vpnGatewayPort?: (job: Job) => number;
  private vpnSealFailure?: unknown;
  private vpnIngress?: import("./vpn/native-backend").VpnIngress;
  bindVpnIngress(
    ingress: import("./vpn/native-backend").VpnIngress,
    gatewayPort?: (job: Job) => number,
  ): void {
    if (!this.competitionNetwork || this.vpnIngress)
      throw new Error("VPN requires one isolated controller.");
    ingress.seal();
    this.networkGuard.preflight();
    this.vpnIngress = ingress;
    this.vpnGatewayPort = gatewayPort;
  }
  private vpnSnapshot(
    overrides?: ReadonlyMap<string, LocalNetworkPlan>,
    proofTime?: number,
  ): import("./vpn/forward-policy").VpnRuntimeAdmission[] {
    const runtimes: import("./vpn/forward-policy").VpnRuntimeAdmission[] = [];
    for (const job of this.networkState?.jobs() ?? []) {
      const started = this.running.get(job.jobId);
      const proof = this.guardProofs.get(job.jobId);
      if (
        !started ||
        !proof ||
        proof.unit !== started.unit ||
        this.applyingPublicationEvent === job.eventId
      )
        continue;
      const plan = overrides?.get(job.jobId) ?? this.guardPlan(job, started.unit);
      if (!plan) throw new Error("VPN cannot admit an unguarded runtime.");
      runtimes.push({
        jobId: job.jobId,
        eventId: job.eventId,
        teamId: job.teamId,
        plan,
        unitGeneration: plan.generation,
        verifiedAt: proofTime ?? proof.verifiedAt,
        ...(this.vpnGatewayPort ? { gatewayPort: this.vpnGatewayPort(job) } : {}),
      });
    }
    return runtimes;
  }
  private async reconcileVpn(attempt = 0): Promise<void> {
    if (!this.vpnIngress) return;
    const runtimes = this.vpnSnapshot();
    try {
      await this.vpnIngress.reconcile(runtimes);
    } catch (error) {
      if (!(error instanceof VpnPolicyRevoked) || attempt >= 2) throw error;
      await this.reconcileVpn(attempt + 1);
    }
  }
  bindNetworkState(state: NonNullable<DockerHostingEngine["networkState"]>): void {
    this.networkState = state;
  }
  private isolationRequired(job: Job): boolean {
    assertNetworkRequirement(job);
    return this.competitionNetwork || job.networkIsolationVersion === 1;
  }
  networkRequirement(definition: string): 1 | undefined {
    return this.competitionNetwork && definitionKind(definition) === "compose" ? 1 : undefined;
  }
  networkSupported(job: Job): boolean {
    return Boolean(this.running.get(job.jobId)?.unit.isolationVersion === 1);
  }
  constructor(
    private readonly repositoryRoot: string,
    private readonly dataDirectory: string,
    private readonly networkPool?: string,
    private readonly competitionNetwork = false,
    private readonly networkGuard: LocalNetworkGuard = new LinuxNetworkGuard(),
    private readonly runCompose: typeof compose = compose,
    private readonly guardNow: () => number = Date.now,
    private readonly catalogLoader: typeof loadDockerCatalog = loadDockerCatalog,
  ) {}
  catalog(): readonly Problem[] {
    this.problems ??= this.catalogLoader(this.repositoryRoot);
    return this.problems;
  }
  hostPorts(definition: string, offset: number, runtimePorts?: RuntimePorts): readonly number[] {
    const { composeText } = JSON.parse(definition) as Definition;
    return [...remapRuntimeComposePorts(composeText, offset, runtimePorts).portMap.values()];
  }
  private plan(
    job: Job,
    verifySources = true,
    newSubnets?: NetworkSubnets,
    claimNewDirectory = false,
  ): {
    started: StartedContainer;
    composeText: string;
    directory: string;
    relayBindings: readonly RelayBinding[];
  } {
    const { problem: original, composeText: source } = definitionOf(job, verifySources);
    const problem = { ...original, composeProjectName: `tch-${job.jobId.toLowerCase()}` };
    assertComposePolicy(source, {
      problemDir: problem.problemDir,
      composePath: problem.composePath,
    });
    assertPublicServiceSeparation(original, source);
    const remapped = remapRuntimeComposePorts(source, job.offset, job.runtimePorts);
    let plannedCompose = job.runtimePorts ? boundedCompose(remapped.text).text : remapped.text;
    const networkSubnets =
      newSubnets ??
      (job.unit ? (JSON.parse(job.unit) as LocalComposeUnit).networkSubnets : undefined);
    const recorded = job.unit ? (JSON.parse(job.unit) as LocalComposeUnit) : undefined;
    assertNetworkRequirement(job);
    const isolated = recorded?.isolationVersion === 1 || (!recorded && this.isolationRequired(job));
    const networkPlan = isolated
      ? this.networkPlan(job, problem.composeProjectName, networkSubnets)
      : undefined;
    if (networkPlan) plannedCompose = isolatedCompose(plannedCompose, networkPlan);
    else if (networkSubnets) plannedCompose = applyNetworkSubnets(plannedCompose, networkSubnets);
    const transport = relayCompose(plannedCompose);
    plannedCompose = transport.text;
    const directory = prepareRuntimeDirectory(this.dataDirectory, job.jobId, claimNewDirectory);
    const composePath = join(directory, `${problem.composeProjectName}.compose.yml`);
    const unit: LocalComposeUnit = {
      problemId: job.problemId,
      offset: job.offset,
      composePath,
      composeProjectName: problem.composeProjectName,
      secretEnv: problem.secretEnv,
      projectDirectory: dirname(problem.composePath),
      remappedComposePath: composePath,
      ...(networkSubnets ? { networkSubnets } : {}),
      ...(networkPlan ? { isolationVersion: 1, isolationGeneration: networkPlan.generation } : {}),
      ...(recorded?.publishedServiceIds
        ? { publishedServiceIds: this.publicServiceIds(job, recorded) }
        : {}),
      ...(recorded?.publicNetworkRoutes
        ? { publicNetworkRoutes: requiredNetworkValue(this.guardPlan(job, recorded)).publicRoutes }
        : {}),
    };
    return {
      started: { unit, problem: remapContainerProblem(problem, remapped.portMap) },
      relayBindings: transport.bindings,
      composeText: plannedCompose,
      directory,
    };
  }
  private assertAllocationRequirements(job: Job): void {
    if (this.isolationRequired(job)) job.networkIsolationVersion = 1;
    if (this.isolationRequired(job) && (!this.networkPool || !job.runtimePorts))
      throw new Error(
        "Competition networking requires an explicit non-overlapping --docker-network-pool and durable runtime ports.",
      );
  }
  private allocateNetworks(job: Job): NetworkSubnets | undefined {
    this.assertAllocationRequirements(job);
    if (!this.networkPool || !job.runtimePorts) return undefined;
    try {
      return allocateNetworkSubnets(definitionOf(job, true).composeText, this.networkPool, [
        ...occupiedDockerSubnets(),
        ...(this.isolationRequired(job)
          ? this.networkGuard.occupiedRoutes().filter((cidr) => !cidr.includes(":"))
          : []),
        ...[...this.networkReservations.values()].flat(),
      ]);
    } catch (cause) {
      if (cause instanceof DockerNetworkInventoryError && cause.daemonUnavailable)
        throw new DockerDaemonUnavailableError();
      throw cause;
    }
  }
  async start(job: Job, retain: (unit: string | null) => void): Promise<void> {
    await this.awaitGuardHalt(job);
    this.revokeRunning(job.jobId);
    this.assertAllocationRequirements(job);
    // Readiness of the CLI is checked on deploy, never on host startup.
    resolveComposeCli();
    if (job.unit) throw new Error("A retained environment must be resumed, never recreated.");
    if (this.isolationRequired(job)) this.networkGuard.preflight();
    const networkSubnets = this.allocateNetworks(job);
    const plan = this.plan(job, true, networkSubnets, true);
    const unit = plan.started.unit;
    const guarded = this.guardPlan(job, unit);
    try {
      if (guarded) assertNoNetworkOverlap(guarded, this.networkGuard.occupiedRoutes());
    } catch (error) {
      removeRuntimeFiles(this.dataDirectory, job.jobId, unit.composePath);
      throw error;
    }
    if (networkSubnets) this.networkReservations.set(job.jobId, Object.values(networkSubnets));
    writeFileSync(unit.composePath, plan.composeText, { mode: 0o600 });
    retain(JSON.stringify(unit));
    try {
      const generated = generateSecretEnv(plan.directory, job.problemId, unit.secretEnv);
      if (guarded) this.networkGuard.install(guarded);
      await this.runCompose(unit, "up", { ...process.env, ...generated });
      if (guarded) this.networkGuard.verifyNetworks(guarded);
      await this.openRelays(job, plan.started.unit, plan.relayBindings);
      await ready(plan.started.problem.verifyUrl);
      await this.readySurfaces(plan.started);
      if (guarded) this.networkGuard.verifyNetworks(guarded);
      await this.admitRunning(job, plan.started);
      if (guarded && this.networkState) {
        await this.reconcilePublications(job.eventId);
        retain(JSON.stringify(requiredNetworkValue(this.running.get(job.jobId)).unit));
      }
    } catch (error) {
      // Down interpolates names only; cleanup must not depend on the secret that may have failed.
      const environment = {
        ...process.env,
        ...Object.fromEntries(unit.secretEnv.map((name) => [name, "tenkacloud-host-cleanup"])),
      };
      return this.cleanupFailedStart(job, { unit, guarded, environment, retain }, error);
    }
  }
  private async cleanupFailedStart(
    job: Job,
    owned: {
      unit: LocalComposeUnit;
      guarded: LocalNetworkPlan | undefined;
      environment: NodeJS.ProcessEnv;
      retain: (unit: string | null) => void;
    },
    error: unknown,
  ): Promise<never> {
    this.revokeRunning(job.jobId);
    const failures: unknown[] = [error];
    if (owned.guarded) {
      try {
        await this.quarantinePlan(owned.guarded);
      } catch (quarantineError) {
        failures.push(quarantineError);
      }
    }
    try {
      await this.runCompose(owned.unit, "down", owned.environment);
      if (owned.guarded) this.networkGuard.remove(owned.guarded);
      removeRuntimeFiles(this.dataDirectory, job.jobId, owned.unit.composePath);
      owned.retain(null);
      this.networkReservations.delete(job.jobId);
    } catch (cleanup) {
      throw startupCleanupFailure(
        error,
        failures.length > 1
          ? new AggregateError(
              [...failures.slice(1), cleanup],
              "Quarantine or teardown could not be confirmed.",
            )
          : cleanup,
      );
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Startup failed; cleanup completed after a quarantine error.",
      );
    throw error;
  }

  async recover(job: Job): Promise<void> {
    await this.awaitGuardHalt(job);
    this.revokeRunning(job.jobId);
    const recorded = this.recordedUnit(job);
    this.revokeRunning(job.jobId);
    if (recorded.teardown) throw new Error(REMOVED_UNIT);
    try {
      const plan = this.plan(job);
      const unit = this.validatedUnit(job, plan.started.unit);
      if (unit.networkSubnets)
        this.networkReservations.set(job.jobId, Object.values(unit.networkSubnets));
      if (readFileSync(unit.composePath, "utf8") !== plan.composeText)
        throw new Error("Recorded runtime composition changed; refusing to adopt it.");
      await this.assertGuardedAdmission(job, unit);
      if (!isComposeUnitRunning(unit))
        throw new Error(
          "The recorded problem environment is not running. Retry deployment from the host console.",
        );
      await this.openRelays(job, plan.started.unit, plan.relayBindings);
      await ready(plan.started.problem.verifyUrl);
      await this.readySurfaces(plan.started);
      const guarded = this.guardPlan(job, unit);
      if (guarded) this.networkGuard.verifyNetworks(guarded);
      await this.admitRunning(job, plan.started);
    } catch (error) {
      if (recorded.isolationVersion === 1) return this.haltGuardedUnit(job, recorded, error);
      throw error;
    }
  }
  private validatedUnit(job: Job, expected: LocalComposeUnit): LocalComposeUnit {
    if (!job.unit) throw new Error("Missing durable runtime ownership.");
    const unit = JSON.parse(job.unit) as LocalComposeUnit;
    for (const key of [
      "problemId",
      "offset",
      "composePath",
      "composeProjectName",
      "projectDirectory",
      "remappedComposePath",
      "isolationVersion",
      "isolationGeneration",
    ] as const) {
      if (unit[key] !== expected[key])
        throw new Error("Runtime ownership does not match this team/problem.");
    }
    if (JSON.stringify(unit.secretEnv) !== JSON.stringify(expected.secretEnv))
      throw new Error("Runtime secret declaration changed.");
    return unit;
  }
  async stop(job: Job): Promise<void> {
    await this.awaitGuardHalt(job);
    this.revokeRunning(job.jobId);
    const recorded = this.recordedUnit(job);
    this.revokeRunning(job.jobId);
    let down = recorded.teardown === "down";
    try {
      // Cleanup must remain possible after a catalog update. The private persisted
      // compose text is the original creation plan, not the new checkout's file.
      const plan = this.plan(job, false, undefined, true);
      const unit = this.validatedUnit(job, plan.started.unit);
      // A confirmed down follows a completed withdrawal; its bridges are gone, so a
      // second withdrawal could only fail against absent networks.
      if (!down) {
        if (unit.isolationVersion === 1) await this.withdrawRuntimePublications(job);
        // Reconstruct only a missing file from the private pinned plan. A different
        // existing file is a conflict, never something we execute or overwrite.
        if (!existsSync(unit.composePath))
          writeFileSync(unit.composePath, plan.composeText, { flag: "wx", mode: 0o600 });
        if (readFileSync(unit.composePath, "utf8") !== plan.composeText)
          throw new Error("Recorded runtime composition changed; refusing unsafe cleanup.");
        // Compose down still interpolates variables, but does not need the original
        // secret. Cleanup must work even if a deployment's private seed file is lost.
        const cleanupEnvironment = Object.fromEntries(
          unit.secretEnv.map((name) => [name, "tenkacloud-host-cleanup"]),
        );
        await this.runCompose(unit, "down", { ...process.env, ...cleanupEnvironment });
        down = true;
      }
      const guarded = this.guardPlan(job, unit);
      if (guarded) this.networkGuard.remove(guarded);
      this.revokeRunning(job.jobId);
      this.networkReservations.delete(job.jobId);
      removeRuntimeFiles(this.dataDirectory, job.jobId, unit.composePath);
    } catch (error) {
      if (recorded.isolationVersion !== 1) throw error;
      // No workload remains to halt, and a stopped reset would need the removed bridges.
      if (down) return this.retainRemovedUnit(job, error);
      return this.haltGuardedUnit(job, recorded, error);
    }
  }
  private retainRemovedUnit(job: Job, error: unknown): never {
    const unit: RetainedUnit = {
      ...(JSON.parse(requiredNetworkValue(job.unit)) as LocalComposeUnit),
      teardown: "down",
    };
    job.unit = JSON.stringify(unit);
    job.status = "FAILED";
    job.error = REMOVED_UNIT;
    const failures = [error];
    this.retainGuardFailure(job, unit, failures);
    throw new AggregateError(failures, REMOVED_UNIT);
  }
  /** Validated, unchanged private plan of an owned environment. */
  private async ownedUnit(
    job: Job,
    verifySources: boolean,
  ): Promise<{ unit: LocalComposeUnit; directory: string }> {
    const recorded = this.recordedUnit(job);
    if (recorded.teardown) throw new Error(REMOVED_UNIT);
    try {
      const plan = this.plan(job, verifySources);
      const unit = this.validatedUnit(job, plan.started.unit);
      if (
        !existsSync(unit.composePath) ||
        readFileSync(unit.composePath, "utf8") !== plan.composeText
      )
        throw new Error(
          "Recorded runtime composition changed or is missing; refusing to operate it.",
        );
      return { unit, directory: plan.directory };
    } catch (error) {
      if (recorded.isolationVersion === 1) return this.haltGuardedUnit(job, recorded, error);
      throw error;
    }
  }
  private recordedUnit(job: Job): RetainedUnit {
    const unit: RetainedUnit =
      this.running.get(job.jobId)?.unit ??
      (JSON.parse(requiredNetworkValue(job.unit)) as RetainedUnit);
    if (unit.composeProjectName !== `tch-${job.jobId.toLowerCase()}`)
      throw new Error("Retained runtime project does not match the job.");
    return unit;
  }
  async pause(job: Job): Promise<void> {
    await this.awaitGuardHalt(job);
    this.revokeRunning(job.jobId);
    const { unit } = await this.ownedUnit(job, false);
    if (unit.isolationVersion === 1) await this.withdrawRuntimePublications(job);
    // `compose stop` never recreates containers; interpolation needs names, not the secrets.
    const placeholders = Object.fromEntries(
      unit.secretEnv.map((name) => [name, "tenkacloud-host-stop"]),
    );
    this.revokeRunning(job.jobId);
    await this.runCompose(unit, "stop", { ...process.env, ...placeholders });
  }
  async resume(job: Job): Promise<void> {
    await this.awaitGuardHalt(job);
    this.revokeRunning(job.jobId);
    const { unit, directory } = await this.ownedUnit(job, true);
    const plan = this.plan(job);
    await this.assertGuardedAdmission(job, unit);
    const generated = generateSecretEnv(directory, job.problemId, unit.secretEnv);
    try {
      await this.runCompose(unit, "restart", { ...process.env, ...generated });
      const guarded = this.guardPlan(job, unit);
      if (guarded) this.networkGuard.verifyNetworks(guarded);
      await this.openRelays(job, plan.started.unit, plan.relayBindings);
      await ready(plan.started.problem.verifyUrl);
      await this.readySurfaces(plan.started);
      await this.admitRunning(job, plan.started);
      if (guarded && this.networkState) {
        await this.reconcilePublications(job.eventId);
        job.unit = JSON.stringify(requiredNetworkValue(this.running.get(job.jobId)).unit);
      }
    } catch (error) {
      this.revokeRunning(job.jobId);
      if (unit.isolationVersion === 1) await this.haltGuardedUnit(job, unit, error);
      throw error;
    }
  }
  private networkPlan(
    job: Job,
    project: string,
    subnets: NetworkSubnets | undefined,
  ): LocalNetworkPlan {
    if (!subnets) throw new Error("An isolated runtime must retain its exact network allocation.");
    return localNetworkPlan(project, subnets, {
      composeText: definitionOf(job, false).composeText,
      definition: job.definition,
      eventId: job.eventId,
    });
  }
  private guardPlan(job: Job, unit: LocalComposeUnit): LocalNetworkPlan | undefined {
    const plan = this.ownedPlan(job, unit);
    return plan && retainedPublicPlan(plan, unit.publicNetworkRoutes);
  }
  /** Owned bridges without retained DMZ routes: enough to quarantine, stop and reset. */
  private ownedPlan(job: Job, unit: LocalComposeUnit): LocalNetworkPlan | undefined {
    if (unit.isolationVersion === undefined) return undefined;
    if (unit.isolationVersion !== 1) throw new Error("Unsupported local competition network plan.");
    const plan = this.networkPlan(job, unit.composeProjectName, unit.networkSubnets);
    if (plan.generation !== unit.isolationGeneration)
      throw new Error("Competition network generation changed.");
    return plan;
  }
  private publicServiceIds(job: Job, unit: LocalComposeUnit): readonly string[] {
    const ids = unit.publishedServiceIds ?? [];
    const declared = definitionOf(job, false).problem.publicServices ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > 8 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !declared.some((service) => service.id === id))
    )
      throw new Error("Retained public service IDs are not declared by this pinned catalog.");
    return ids;
  }
  private publicationJob(context: Context, problemId: string): Job {
    const job = context.jobs.find(
      (entry) => entry.problemId === problemId && entry.status === "COMPLETE",
    );
    if (!job?.unit || !this.running.has(job.jobId) || JSON.parse(job.unit).isolationVersion !== 1)
      throw new HostError(
        409,
        "DMZ publication requires a running, isolated local environment.",
        "not_running",
      );
    this.assertRunningGuard(job);
    return job;
  }
  async networkView(context: Context, problemId: string): Promise<NetworkPublicationView> {
    const own = this.publicationJob(context, problemId);
    const started = this.running.get(own.jobId);
    const epoch = this.policyEpoch(own.eventId);
    const ownUnit = JSON.parse(requiredNetworkValue(own.unit)) as LocalComposeUnit;
    const published = this.publicServiceIds(own, ownUnit);
    const shared = await this.sharedPublicServices(context);
    if (epoch !== this.policyEpoch(own.eventId) || this.running.get(own.jobId) !== started)
      throw new HostError(409, "Competition network generation changed.");
    this.assertRunningGuard(own);
    return {
      supported: true,
      declared: (definitionOf(own, false).problem.publicServices ?? []).map((service) => ({
        id: service.id,
        purpose: service.purpose,
        published: published.includes(service.id),
      })),
      shared,
    };
  }
  async publishedWebTarget(
    context: Context,
    ownProblemId: string,
    target: { teamId: string; problemId: string; serviceId: string },
  ): Promise<{ job: Job; address: string; port: number }> {
    const epoch = this.policyEpoch(context.event.eventId);
    const requester = this.publicationJob(context, ownProblemId);
    const requesterRuntime = this.running.get(requester.jobId);
    const before = this.networkState
      ?.jobs()
      .find(
        (entry) =>
          entry.eventId === context.event.eventId &&
          entry.teamId === target.teamId &&
          entry.problemId === target.problemId &&
          entry.status === "COMPLETE",
      );
    const publisherRuntime = before && this.running.get(before.jobId);
    const publisherIdentity =
      before && JSON.stringify([before.jobId, before.unit, before.definition, before.deployedAt]);
    const view = await this.networkView(context, ownProblemId);
    const publication = view.shared.find(
      (entry) =>
        entry.teamId === target.teamId &&
        entry.problemId === target.problemId &&
        entry.serviceId === target.serviceId,
    );
    const job = this.networkState
      ?.jobs()
      .find(
        (entry) =>
          entry.eventId === context.event.eventId &&
          entry.teamId === target.teamId &&
          entry.problemId === target.problemId &&
          entry.status === "COMPLETE",
      );
    if (!publication || !job?.unit || !publication.addresses.length)
      throw new HostError(404, "The requested service is not currently published.");
    if (
      epoch !== this.policyEpoch(context.event.eventId) ||
      requesterRuntime !== this.running.get(requester.jobId) ||
      publisherRuntime !== this.running.get(job.jobId) ||
      publisherIdentity !== JSON.stringify([job.jobId, job.unit, job.definition, job.deployedAt])
    )
      throw new HostError(409, "Published Web generation changed.");
    this.assertRunningGuard(job);
    if (
      !definitionOf(job, false).problem.publicServices?.some(
        (service) => service.id === target.serviceId && service.applicationProtocol === "http",
      )
    )
      throw new HostError(404, "This publication is not an HTTP service.");
    const unit = JSON.parse(job.unit) as LocalComposeUnit;
    if (!this.publicServiceIds(job, unit).includes(target.serviceId))
      throw new HostError(404, "The requested service is not currently published.");
    return {
      job: { ...job },
      address: requiredNetworkValue(publication.addresses[0]),
      port: publication.port,
    };
  }
  private async sharedPublicServices(context: Context): Promise<NetworkPublicationView["shared"]> {
    if (this.applyingPublicationEvent === context.event.eventId)
      throw new HostError(409, "Competition network policy is changing.");
    const epoch = this.policyEpoch(context.event.eventId);
    const shared: NetworkPublicationView["shared"][number][] = [];
    for (const job of this.networkState?.jobs() ?? []) {
      if (job.eventId !== context.event.eventId || job.status !== "COMPLETE" || !job.unit) continue;
      const unit = JSON.parse(job.unit) as LocalComposeUnit;
      const started = this.running.get(job.jobId);
      if (!started) continue;
      shared.push(...(await this.observedPublicViews(job, unit, started, epoch)));
    }
    return shared;
  }
  private async observedPublicViews(
    job: Job,
    unit: LocalComposeUnit,
    started: StartedContainer,
    epoch: number,
  ): Promise<NetworkPublicationView["shared"]> {
    try {
      const plan = this.guardPlan(job, unit);
      if (!plan) return [];
      this.assertRunningGuard(job);
      const fingerprint = requiredNetworkValue(job.unit);
      let cached = this.publicViews.get(job.jobId);
      if (!cached || cached.unit !== fingerprint) {
        cached = {
          unit: fingerprint,
          value: this.verifyPlan(plan).then(() => this.publicServiceViews(job, unit, plan)),
        };
        this.publicViews.set(job.jobId, cached);
      }
      const views = await cached.value;
      this.assertRunningGuard(job);
      if (epoch !== this.policyEpoch(job.eventId) || this.running.get(job.jobId) !== started)
        throw new HostError(409, "Competition network policy is changing.");
      return views;
    } catch (error) {
      if (epoch !== this.policyEpoch(job.eventId) || this.running.get(job.jobId) !== started)
        throw error;
      return this.haltGuardedUnit(job, unit, error);
    }
  }
  private async publicServiceViews(
    job: Job,
    unit: LocalComposeUnit,
    plan: LocalNetworkPlan,
  ): Promise<NetworkPublicationView["shared"]> {
    const shared: NetworkPublicationView["shared"][number][] = [];
    for (const service of definitionOf(job, false).problem.publicServices ?? []) {
      if (!this.publicServiceIds(job, unit).includes(service.id)) continue;
      const endpoints = await this.publicEndpoints(plan, service.service, service.port);
      const addresses = endpoints.flatMap((endpoint) => endpoint.addresses);
      if (addresses.length)
        shared.push({
          teamId: job.teamId,
          problemId: job.problemId,
          serviceId: service.id,
          purpose: service.purpose,
          addresses,
          port: service.port,
          protocol: "tcp",
          ...(service.applicationProtocol === "http" ? { http: true } : {}),
        });
    }
    return shared;
  }
  private publicEndpoints(plan: LocalNetworkPlan, service: string, port: number) {
    return this.networkGuard.endpointsAsync
      ? this.networkGuard.endpointsAsync(plan, service, port)
      : Promise.resolve(this.networkGuard.endpoints(plan, service, port));
  }
  async publishNetworkService(
    context: Context,
    problemId: string,
    serviceId: string,
    published: boolean,
  ): Promise<void> {
    const job = this.publicationJob(context, problemId);
    await this.awaitGuardHalt(job);
    const service = (definitionOf(job, false).problem.publicServices ?? []).find(
      (entry) => entry.id === serviceId,
    );
    if (!service) throw new HostError(400, "Select a declared public service ID.");
    const unit = JSON.parse(requiredNetworkValue(job.unit)) as LocalComposeUnit;
    if (published) await this.assertPublishable(job, service);
    const ids = new Set(this.publicServiceIds(job, unit));
    if (published) ids.add(serviceId);
    else ids.delete(serviceId);
    const changed = {
      ...job,
      unit: JSON.stringify({
        ...unit,
        publishedServiceIds: [...ids].sort((a, b) => a.localeCompare(b)),
      }),
    };
    await this.reconcilePublications(job.eventId, new Map([[job.jobId, changed]]));
  }
  /**
   * A participant's own unpublishable service is a refused request, not guard drift. The halt is
   * kept only when the retained guard itself no longer verifies under an unchanged policy; the
   * request context may predate another team's publication, so the retained unit is audited.
   */
  private async assertPublishable(
    job: Job,
    service: { service: string; port: number },
  ): Promise<void> {
    const epoch = this.policyEpoch(job.eventId);
    const started = this.running.get(job.jobId);
    const retained = this.networkState?.jobs().find((entry) => entry.jobId === job.jobId) ?? job;
    const unit = JSON.parse(requiredNetworkValue(retained.unit)) as LocalComposeUnit;
    const plan = requiredNetworkValue(this.guardPlan(retained, unit));
    const changing = () =>
      epoch !== this.policyEpoch(job.eventId) || this.running.get(job.jobId) !== started;
    let failure: unknown;
    try {
      if ((await this.publicEndpoints(plan, service.service, service.port)).length) return;
    } catch (error) {
      failure = error;
    }
    try {
      if (!changing()) await this.verifyPlan(plan);
    } catch (error) {
      if (!changing()) return this.haltGuardedUnit(retained, unit, error);
      failure = error;
    }
    if (changing()) throw new HostError(409, "Competition network policy is changing.");
    const refused = new HostError(
      409,
      "The selected public service has no single running instance; publication is refused.",
    );
    refused.cause = failure;
    throw refused;
  }
  private async withdrawRuntimePublications(job: Job): Promise<void> {
    const unit = JSON.parse(requiredNetworkValue(job.unit)) as LocalComposeUnit;
    if (!this.networkState) {
      if (unit.publishedServiceIds?.length || unit.publicNetworkRoutes?.length)
        throw new Error(
          "DMZ cleanup requires the existing host ledger; ownership and reservations were retained.",
        );
      return;
    }
    await this.reconcilePublications(job.eventId, new Map(), new Set([job.jobId]));
    job.unit =
      this.networkState.jobs().find((entry) => entry.jobId === job.jobId)?.unit ?? job.unit;
  }
  private reconcilePublications(
    eventId: string,
    changes = new Map<string, Job>(),
    disabled = new Set<string>(),
  ): Promise<void> {
    const task = this.publicMutation.then(() => this.applyPublications(eventId, changes, disabled));
    const barrier = task
      .catch(() => undefined)
      .finally(() => {
        if (this.publicationBarriers.get(eventId) === barrier)
          this.publicationBarriers.delete(eventId);
      });
    this.publicMutation = barrier;
    this.publicationBarriers.set(eventId, barrier);
    return task;
  }
  private async applyPublications(
    eventId: string,
    changes: ReadonlyMap<string, Job>,
    disabled: ReadonlySet<string>,
  ): Promise<void> {
    if (!this.networkState)
      throw new Error("DMZ publication requires the existing private host ledger.");
    for (const candidate of this.networkState.jobs())
      if (candidate.eventId === eventId) await this.awaitGuardHalt(candidate);
    const snapshots = this.networkState
      .jobs()
      .filter(
        (job) =>
          job.eventId === eventId &&
          job.unit &&
          JSON.parse(job.unit).isolationVersion === 1 &&
          (job.status === "COMPLETE" ||
            job.status === "STOPPED" ||
            this.running.has(job.jobId) ||
            disabled.has(job.jobId)),
      )
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
    const previous = new Map(
      snapshots.map((job) => [
        job.jobId,
        requiredNetworkValue(this.guardPlan(job, JSON.parse(requiredNetworkValue(job.unit)))),
      ]),
    );
    const active = snapshots.filter(
      (job) =>
        !disabled.has(job.jobId) && (job.status === "COMPLETE" || this.running.has(job.jobId)),
    );
    const participants = active.map((job) => requiredNetworkValue(previous.get(job.jobId)));
    const publishers: Parameters<typeof sharedNetworkPlan>[1][number][] = [];
    for (const snapshot of active) {
      const job = changes.get(snapshot.jobId) ?? snapshot;
      const unit = JSON.parse(requiredNetworkValue(job.unit)) as LocalComposeUnit;
      const plan = requiredNetworkValue(previous.get(job.jobId));
      await this.verifyObservedJob(snapshot, JSON.parse(requiredNetworkValue(snapshot.unit)), plan);
      try {
        const endpoints = await this.jobPublicEndpoints(job, unit, plan);
        publishers.push({ plan, endpoints });
      } catch (error) {
        return this.haltGuardedUnit(
          snapshot,
          JSON.parse(requiredNetworkValue(snapshot.unit)),
          error,
        );
      }
    }
    // Validate every bounded plan before the first rule, route or durable-unit mutation.
    const planned = snapshots.map((snapshot) => {
      const job = changes.get(snapshot.jobId) ?? snapshot;
      const plan = sharedNetworkPlan(
        requiredNetworkValue(previous.get(job.jobId)),
        publishers,
        participants,
      );
      const unit = JSON.stringify({
        ...JSON.parse(requiredNetworkValue(snapshot.unit)),
        ...(changes.has(job.jobId)
          ? {
              publishedServiceIds: this.publicServiceIds(
                job,
                JSON.parse(requiredNetworkValue(job.unit)),
              ),
            }
          : {}),
        publicNetworkRoutes: plan.publicRoutes,
      });
      return { jobId: job.jobId, unit, plan };
    });
    // A halt can begin while this request waits or observes; a revoked runtime keeps its ledger.
    for (const [jobId, changed] of changes)
      this.assertPublicationChange(
        snapshots.find((job) => job.jobId === jobId),
        changed,
      );
    this.vpnIngress?.validate(
      this.vpnSnapshot(new Map(planned.map(({ jobId, plan }) => [jobId, plan])), this.guardNow()),
      this.guardNow(),
    );
    // Peers must not reach endpoints under the outgoing policy; reconcileVpn reopens with the new one.
    this.vpnIngress?.seal();
    this.policyEpochs.set(eventId, this.policyEpoch(eventId) + 1);
    this.applyingPublicationEvent = eventId;
    try {
      for (const { jobId, plan } of planned) {
        await this.applyPublicationPlan(plan, requiredNetworkValue(previous.get(jobId)));
      }
      this.networkState.retain(planned.map(({ jobId, unit }) => ({ jobId, unit })));
      for (const { jobId, unit } of planned) {
        const started = this.running.get(jobId);
        if (started)
          await this.admitRunning(
            requiredNetworkValue(snapshots.find((job) => job.jobId === jobId)),
            {
              ...started,
              unit: JSON.parse(unit),
            },
          );
      }
    } catch (error) {
      await this.stopFailedPublications(snapshots, previous, error);
    } finally {
      this.applyingPublicationEvent = undefined;
    }
    await this.reconcileVpn();
  }

  private async jobPublicEndpoints(job: Job, unit: LocalComposeUnit, plan: LocalNetworkPlan) {
    const endpoints = [];
    for (const service of definitionOf(job, false).problem.publicServices ?? [])
      if (this.publicServiceIds(job, unit).includes(service.id))
        endpoints.push(...(await this.publicEndpoints(plan, service.service, service.port)));
    return endpoints;
  }
  private async applyPublicationPlan(
    plan: LocalNetworkPlan,
    previous: LocalNetworkPlan,
  ): Promise<void> {
    if (this.networkGuard.publishAsync) return this.networkGuard.publishAsync(plan, previous);
    this.networkGuard.update(plan, previous);
    this.networkGuard.routePublications(plan);
    this.networkGuard.verifyNetworks(plan);
  }

  private assertPublicationChange(snapshot: Job | undefined, changed: Job): void {
    if (snapshot?.status !== "COMPLETE" || !this.running.has(snapshot.jobId))
      throw new HostError(
        409,
        "DMZ publication requires a running, isolated local environment.",
        "not_running",
      );
    if (
      changed.definition !== snapshot.definition ||
      changed.deployedAt !== snapshot.deployedAt ||
      changed.eventId !== snapshot.eventId ||
      changed.teamId !== snapshot.teamId
    )
      throw new HostError(409, "DMZ environment changed before publication.");
  }
  private stopFailedPublications(
    snapshots: readonly Job[],
    previous: ReadonlyMap<string, LocalNetworkPlan>,
    error: unknown,
  ): Promise<never> {
    const existing = snapshots.flatMap((job) => {
      this.revokeRunning(job.jobId);
      const pending = this.pendingHalts.get(job.jobId);
      return pending ? [pending.catch(() => undefined)] : [];
    });
    const task = Promise.all(existing)
      .then(() => this.performFailedPublications(snapshots, previous, error))
      .finally(() => {
        for (const job of snapshots)
          if (this.pendingHalts.get(job.jobId) === task) this.pendingHalts.delete(job.jobId);
      });
    for (const job of snapshots) this.pendingHalts.set(job.jobId, task);
    return task;
  }
  private async performFailedPublications(
    snapshots: readonly Job[],
    previous: ReadonlyMap<string, LocalNetworkPlan>,
    error: unknown,
  ): Promise<never> {
    const failures: unknown[] = [error];
    for (const snapshot of snapshots) {
      this.revokeRunning(snapshot.jobId);
      this.unconfirmedHalts.set(snapshot.jobId, {
        job: snapshot,
        unit: JSON.parse(requiredNetworkValue(snapshot.unit)),
      });
    }
    // Protect every affected bridge before a ledger write or daemon shutdown can fail.
    await Promise.all(
      snapshots.map(async (snapshot) => {
        try {
          await this.quarantinePlan(requiredNetworkValue(previous.get(snapshot.jobId)));
        } catch (quarantineError) {
          failures.push(quarantineError);
        }
      }),
    );
    await Promise.all(
      snapshots.map(async (snapshot) => {
        try {
          await this.performGuardHalt(
            snapshot,
            JSON.parse(requiredNetworkValue(snapshot.unit)),
            error,
          );
        } catch (failure) {
          failures.push(failure);
        }
      }),
    );
    throw new AggregateError(
      failures,
      "DMZ publication failed. Quarantine and shutdown were attempted; ownership was retained for verified recovery.",
    );
  }
  private async assertGuardedAdmission(job: Job, unit: LocalComposeUnit): Promise<void> {
    try {
      const guarded = this.guardPlan(job, unit);
      if (!guarded && this.isolationRequired(job))
        throw new Error(
          "An existing unguarded environment cannot be adopted as isolated. Stop and retire it before a new isolated deployment.",
        );
      if (guarded) {
        this.networkGuard.install(guarded);
        this.networkGuard.verifyNetworks(guarded);
      }
    } catch (error) {
      return this.haltGuardedUnit(job, unit, error);
    }
  }
  private async awaitGuardHalt(job: Job): Promise<void> {
    let waited = false;
    let retried = false;
    for (;;) {
      const pending = this.pendingHalts.get(job.jobId);
      if (pending) {
        waited = true;
        await pending.catch(() => undefined);
        continue; // A publication batch may have replaced the halt we just awaited.
      }
      const unconfirmed = this.unconfirmedHalts.get(job.jobId);
      if (!unconfirmed) break;
      if (retried)
        throw new HostError(409, "Competition shutdown is unconfirmed; admission remains revoked.");
      retried = true;
      waited = true;
      await this.haltGuardedUnit(
        unconfirmed.job,
        unconfirmed.unit,
        new Error("Retrying shutdown before a runtime operation."),
      ).catch(() => undefined);
    }
    if (waited) {
      const retained = this.networkState?.jobs().find((candidate) => candidate.jobId === job.jobId);
      if (retained) Object.assign(job, retained);
    }
  }
  private haltGuardedUnit(job: Job, unit: LocalComposeUnit, error: unknown): Promise<never> {
    const pending = this.pendingHalts.get(job.jobId);
    if (pending) return pending;
    this.revokeRunning(job.jobId);
    this.unconfirmedHalts.set(job.jobId, { job, unit });
    const task = this.performGuardHalt(job, unit, error).finally(() => {
      if (this.pendingHalts.get(job.jobId) === task) this.pendingHalts.delete(job.jobId);
    });
    this.pendingHalts.set(job.jobId, task);
    return task;
  }
  private async performGuardHalt(job: Job, unit: LocalComposeUnit, error: unknown): Promise<never> {
    this.revokeRunning(job.jobId);
    const failures: unknown[] = [error, ...(this.vpnSealFailure ? [this.vpnSealFailure] : [])];
    job.status = "FAILED";
    job.error =
      "Competition verification failed; quarantine and shutdown are pending confirmation.";
    let guarded: LocalNetworkPlan | undefined;
    let quarantine: Promise<void> | undefined;
    try {
      guarded = this.ownedPlan(job, unit);
      if (guarded) quarantine = this.quarantinePlan(guarded);
    } catch (failure) {
      failures.push(failure);
    }
    this.retainGuardFailure(job, unit, failures);
    try {
      await quarantine;
    } catch (failure) {
      failures.push(failure);
    }
    const placeholders = Object.fromEntries(
      unit.secretEnv.map((name) => [name, "tenkacloud-guard-stop"]),
    );
    try {
      if (guarded) await this.networkGuard.stopOwned(guarded);
      else if (unit.isolationVersion === 1)
        throw new Error("Retained isolated shutdown scope could not be validated.");
      else await this.runCompose(unit, "stop", { ...process.env, ...placeholders });
      if (guarded) {
        await this.resetStoppedPlan(guarded);
        unit = { ...unit, publicNetworkRoutes: [] };
      }
      job.unit = JSON.stringify(unit);
      job.status = "STOPPED";
      job.error = "Competition guard failed; runtime was stopped and requires verified recovery.";
      this.unconfirmedHalts.delete(job.jobId);
    } catch (stopError) {
      failures.push(stopError);
      job.status = "FAILED";
      job.error =
        "Competition guard failed; quarantine or workload shutdown could not be confirmed.";
    }
    this.retainGuardFailure(job, unit, failures);
    throw new AggregateError(failures, job.error);
  }
  private retainGuardFailure(job: Job, unit: LocalComposeUnit, failures: unknown[]): void {
    try {
      this.networkState?.retain([
        {
          jobId: job.jobId,
          unit: JSON.stringify(unit),
          status: job.status as "STOPPED" | "FAILED",
          error: job.error,
        },
      ]);
    } catch (failure) {
      failures.push(failure);
    }
  }
  private revokeRunning(jobId: string): void {
    try {
      this.vpnIngress?.seal();
    } catch (error) {
      this.vpnSealFailure = error;
    }
    const relay = this.relays.get(jobId);
    this.relays.delete(jobId);
    if (relay) {
      const closing = relay.close().finally(() => {
        if (this.relayClosures.get(jobId) === closing) this.relayClosures.delete(jobId);
      });
      this.relayClosures.set(jobId, closing);
    }
    this.publicViews.delete(jobId);
    this.running.delete(jobId);
    this.guardProofs.delete(jobId);
  }
  async closeTransports(): Promise<void> {
    try {
      this.vpnIngress?.seal();
    } catch (error) {
      this.vpnSealFailure = error;
    }
    for (const jobId of this.relays.keys()) this.revokeRunning(jobId);
    await Promise.all(this.relayClosures.values());
    if (this.vpnSealFailure) throw this.vpnSealFailure;
  }
  private relayUnit(job: Job, candidate: LocalComposeUnit): LocalComposeUnit {
    return this.running.get(job.jobId)?.unit ?? candidate;
  }
  private async openRelays(
    job: Job,
    unit: LocalComposeUnit,
    bindings: readonly RelayBinding[],
  ): Promise<void> {
    await this.relayClosures.get(job.jobId);
    if (!bindings.length) return;
    const relay = new LoopbackRelays(
      bindings,
      async (binding, expected) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await this.publicationBarriers.get(job.eventId);
          if (this.relays.get(job.jobId) !== relay)
            throw new Error("Internal transport admission revoked.");
          const epoch = this.policyEpoch(job.eventId);
          const currentUnit = this.relayUnit(job, unit);
          try {
            const target = await relayTarget(
              { project: unit.composeProjectName, binding, plan: this.guardPlan(job, currentUnit) },
              expected,
            );
            if (epoch === this.policyEpoch(job.eventId)) return target;
          } catch (error) {
            if (epoch === this.policyEpoch(job.eventId)) throw error;
          }
        }
        throw new Error("Internal transport policy did not stabilize.");
      },
      () => {
        if (this.relays.get(job.jobId) !== relay) return false;
        if (!this.running.has(job.jobId)) return true; // Owned candidate, before readiness admission.
        try {
          this.assertRunningGuard(job);
          return true;
        } catch {
          return false;
        }
      },
      (error) => {
        if (this.relays.get(job.jobId) !== relay) return;
        if (unit.isolationVersion === 1)
          this.trackGuardRevocation(
            this.haltGuardedUnit(job, this.running.get(job.jobId)?.unit ?? unit, error),
          );
        else {
          this.revokeRunning(job.jobId);
          job.status = "FAILED";
          job.error =
            error instanceof Error ? error.message : "Internal transport ownership failed.";
          this.networkState?.retain([
            { jobId: job.jobId, unit: JSON.stringify(unit), status: "FAILED", error: job.error },
          ]);
        }
      },
    );
    this.relays.set(job.jobId, relay);
    try {
      await relay.listen();
    } catch (error) {
      this.revokeRunning(job.jobId);
      throw error;
    }
  }
  private async admitRunning(job: Job, started: StartedContainer): Promise<void> {
    this.vpnIngress?.seal();
    this.publicViews.delete(job.jobId);
    this.running.set(job.jobId, started);
    if (started.unit.isolationVersion === 1)
      this.guardProofs.set(job.jobId, {
        unit: started.unit,
        verifiedAt: this.guardNow(),
        attemptedAt: this.guardNow(),
      });
    if (this.vpnIngress && this.applyingPublicationEvent !== job.eventId) {
      await this.reconcileVpn();
      if (this.running.get(job.jobId) !== started)
        throw new HostError(409, "Runtime admission changed during VPN preparation.");
    }
  }
  private quarantinePlan(plan: LocalNetworkPlan): Promise<void> {
    return this.networkGuard.quarantineAsync
      ? this.networkGuard.quarantineAsync(plan)
      : Promise.resolve().then(() => this.networkGuard.quarantine(plan));
  }
  private resetStoppedPlan(plan: LocalNetworkPlan): Promise<void> {
    return this.networkGuard.resetStoppedAsync
      ? this.networkGuard.resetStoppedAsync(plan)
      : Promise.resolve().then(() => this.networkGuard.resetStopped(plan));
  }
  private verifyPlan(plan: LocalNetworkPlan): Promise<void> {
    return this.networkGuard.audit
      ? this.networkGuard.audit(plan)
      : Promise.resolve().then(() => this.networkGuard.verifyNetworks(plan));
  }
  private async verifyObservedJob(
    job: Job,
    unit: LocalComposeUnit,
    plan: LocalNetworkPlan,
  ): Promise<void> {
    try {
      await this.verifyPlan(plan);
    } catch (error) {
      return this.haltGuardedUnit(job, unit, error);
    }
  }
  private scheduleGuardAudit(job: Job, started: StartedContainer): void {
    if (this.guardAudits.has(job.jobId) || this.applyingPublicationEvent === job.eventId) return;
    const proof = this.guardProofs.get(job.jobId);
    if (proof) proof.attemptedAt = this.guardNow();
    const epoch = this.policyEpoch(job.eventId);
    const task = Promise.resolve()
      .then(() => this.verifyPlan(requiredNetworkValue(this.guardPlan(job, started.unit))))
      .then(() => {
        if (epoch === this.policyEpoch(job.eventId) && this.running.get(job.jobId) === started)
          this.guardProofs.set(job.jobId, {
            unit: started.unit,
            verifiedAt: this.guardNow(),
            attemptedAt: this.guardNow(),
          });
      })
      .catch(async (error) => {
        if (epoch === this.policyEpoch(job.eventId) && this.running.get(job.jobId) === started) {
          try {
            await this.haltGuardedUnit(job, started.unit, error);
          } catch {
            /* Durable revocation and its reason were retained. */
          }
        }
      })
      .finally(() => this.guardAudits.delete(job.jobId));
    this.guardAudits.set(job.jobId, task);
  }
  private trackGuardRevocation(work: Promise<never>): void {
    const task = work.catch(() => undefined).finally(() => this.guardRevocations.delete(task));
    this.guardRevocations.add(task);
  }
  async drainNetworkChecks(): Promise<void> {
    while (this.guardAudits.size || this.guardRevocations.size || this.pendingHalts.size)
      await Promise.all([
        ...this.guardAudits.values(),
        ...this.guardRevocations,
        ...[...this.pendingHalts.values()].map((pending) => pending.catch(() => undefined)),
      ]);
  }
  async auditNetworks(): Promise<void> {
    for (const { job, unit } of this.unconfirmedHalts.values())
      if (!this.pendingHalts.has(job.jobId))
        this.trackGuardRevocation(
          this.haltGuardedUnit(job, unit, new Error("Retrying unconfirmed competition shutdown.")),
        );
    for (const job of this.networkState?.jobs() ?? []) {
      try {
        this.assertRunningGuard(job);
      } catch {
        /* Revocation is retained and drained. */
      }
    }
    await this.reconcileVpn();
  }
  private assertRunningGuard(job: Job): void {
    const started = this.running.get(job.jobId);
    if (started?.unit.isolationVersion !== 1) return;
    const proof = this.guardProofs.get(job.jobId);
    if (!proof || this.guardNow() - proof.attemptedAt >= 10_000)
      this.scheduleGuardAudit(job, started);
    if (!proof || proof.unit !== started.unit || this.guardNow() - proof.verifiedAt > 60_000) {
      this.revokeRunning(job.jobId);
      this.trackGuardRevocation(
        this.haltGuardedUnit(
          job,
          started.unit,
          new Error("Competition network verification expired."),
        ),
      );
      throw new HostError(
        409,
        "Competition network verification expired; runtime access was revoked.",
      );
    }
    if (this.applyingPublicationEvent === job.eventId)
      throw new HostError(
        409,
        "Competition network policy is changing; reconnect after publication.",
      );
  }
  private surfaceFrom(started: StartedContainer): string {
    const url = Object.values(started.problem.challengeEndpoints)[0];
    if (!url) throw new Error("This problem has no participant HTTP surface.");
    return new URL(url).origin;
  }
  private async readySurfaces(started: StartedContainer): Promise<void> {
    for (const url of new Set(Object.values(started.problem.challengeEndpoints))) await ready(url);
  }
  surfaces(job: Job): Readonly<Record<string, string>> {
    this.assertRunningGuard(job);
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    return started.problem.challengeEndpoints;
  }
  gatewayPolicy(job: Job): { applicationRoutes: boolean; deniedPaths: readonly string[] } {
    this.assertRunningGuard(job);
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    const verify = new URL(started.problem.verifyUrl);
    return {
      applicationRoutes: true,
      deniedPaths: verify.origin === this.surfaceFrom(started) ? [verify.pathname] : [],
    };
  }
  terminalSupported(job: Job): boolean {
    try {
      this.assertRunningGuard(job);
    } catch {
      return false;
    }
    return Boolean(this.running.get(job.jobId)?.problem.terminal);
  }
  async openTerminal(
    job: Job,
    handlers: TerminalHandlers,
    assertCurrent: () => void,
  ): Promise<TerminalProcess> {
    this.assertRunningGuard(job);
    const { unit } = await this.ownedUnit(job, true);
    const terminal = this.running.get(job.jobId)?.problem.terminal;
    if (!terminal) throw new HostError(409, "This problem has no running participant terminal.");
    return spawnDeclaredTerminal(unit, terminal.service, handlers, assertCurrent);
  }
  async workbench(job: Job, action: WorkbenchAction, body?: unknown): Promise<unknown> {
    this.assertRunningGuard(job);
    await this.ownedUnit(job, true);
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    return requestWorkbench(started.problem.verifyUrl, action, body);
  }
  surface(job: Job): string {
    this.assertRunningGuard(job);
    const started = this.running.get(job.jobId);
    if (!started) throw new HostError(409, "Problem environment has not been recovered.");
    return this.surfaceFrom(started);
  }
  private async state(context: Context, targetProblemId?: string) {
    const admitted = new Set<string>();
    for (const job of context.jobs) {
      try {
        this.assertRunningGuard(job);
        admitted.add(job.jobId);
      } catch (error) {
        // Keep the full progress snapshot while withholding only the revoked runtime.
        if (job.problemId === targetProblemId || !(error instanceof HostError)) throw error;
      }
    }
    const problems = context.event.problems.map(
      (problem) => (JSON.parse(problem.definition) as Definition).problem,
    );
    const state = createContainerState(problems, {
      teamName: context.team.displayName,
      verify: (url, submission, verifyContext, options) =>
        verifySubmission(
          url,
          submission,
          { ...verifyContext, teamId: context.team.teamId },
          {
            ...options,
            fetchImpl: (input, init) =>
              fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
          },
        ),
      startContainer: async (problem) => {
        const job = context.jobs.find(
          (candidate) =>
            candidate.problemId === problem.problemId && candidate.status === "COMPLETE",
        );
        const started = job && this.running.get(job.jobId);
        if (!started) throw new Error("Host-owned problem runtime is unavailable.");
        return started;
      },
    });
    if (context.team.snapshot)
      restoreLocalPlayState(state, parseLocalPlaySnapshot(context.team.snapshot));
    for (const job of context.jobs) {
      if (admitted.has(job.jobId) && job.status === "COMPLETE" && this.running.has(job.jobId))
        await state.lifecycle.ensureRunning(job.problemId);
    }
    return state;
  }
  async view(context: Context): Promise<Record<string, unknown>> {
    const state = await this.state(context);
    return object(teamView(state, context.now).body);
  }
  private result(
    state: Awaited<ReturnType<DockerHostingEngine["state"]>>,
    response: {
      status: number;
      body: unknown;
    },
    context: Context,
  ): EngineResult {
    const snapshot = snapshotLocalPlayState(state);
    const jobs = new Map(context.jobs.map((job) => [job.problemId, job.jobId]));
    const completedProblems = [...state.runtimes.values()].filter((runtime) =>
      runtime.problem.scoring.kind === "verify"
        ? runtime.solved.has(runtime.problem.problemId)
        : runtime.problem.scoring.checks.every((check) => runtime.solved.has(check.id)),
    ).length;
    return {
      status: response.status,
      body: object(response.body),
      snapshot: JSON.stringify(snapshot),
      score: sessionScore(state),
      completedProblems,
      scoreEvents: state.scoreEvents.map((event) => ({
        ...event,
        jobId: jobs.get(event.problemId) ?? event.jobId,
      })),
    };
  }
  async submit(context: Context, body: Record<string, unknown>): Promise<EngineResult> {
    const state = await this.state(
      context,
      typeof body.problemId === "string" ? body.problemId : undefined,
    );
    const response = await submitFlag(
      {
        method: "POST",
        path: "/portal/me/submit-flag",
        query: {},
        body,
      },
      state,
      new Date(context.now).toISOString(),
    );
    return this.result(state, response, context);
  }
  async evaluate(job: Job, submission: string): Promise<boolean> {
    this.assertRunningGuard(job);
    const started = this.running.get(job.jobId);
    if (started?.problem.scoring.kind !== "verify")
      throw new HostError(409, "This environment has no running single-flag verifier.");
    await this.ownedUnit(job, true);
    const verdict = await verifySubmission(
      started.problem.verifyUrl,
      submission,
      { teamId: job.teamId, problemId: job.problemId },
      { fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
    );
    return verdict.correct;
  }
  async hint(context: Context, problemId: string, hintId: string): Promise<EngineResult> {
    const state = await this.state(context, problemId);
    const response = revealContainerHint(
      problemId,
      hintId,
      state,
      new Date(context.now).toISOString(),
    );
    return this.result(state, response, context);
  }
}

/**
 * Startup failed and removing its partial environment failed too. The first failure is the
 * cause the organizer has to fix; ownership stays recorded, and the next deployment retry
 * removes the partial environment before starting again.
 */
function startupCleanupFailure(startup: unknown, cleanup: unknown): Error {
  if (startup instanceof DockerDaemonUnavailableError) return new DockerDaemonUnavailableError();
  const reason = startup instanceof Error ? startup.message : String(startup);
  const cleanupReason = cleanup instanceof Error ? cleanup.message : String(cleanup);
  return new Error(
    `${reason} Removing the partial environment also failed (${cleanupReason}); ownership is retained and retrying the deployment removes it first.`,
    { cause: startup },
  );
}

function assertNetworkRequirement(job: Job): void {
  if (job.networkIsolationVersion !== undefined && job.networkIsolationVersion !== 1)
    throw new Error("Unsupported retained network isolation requirement.");
}
