import { z } from "zod";
import type { directWebTransport } from "./direct-web-transport";
import { battleOwnerKey } from "./simulator-battle-binding";
import {
  authenticateBattleProbeDescriptor,
  type BattleProbeDescriptor,
  dispatchClaimedBattleProbeStart,
  prepareBattleProbeDescriptor,
  resumeBattleProbeReadOnly,
} from "./simulator-battle-probe";
import type { BattleProbeRecord, SimulatorBattleProbeStore } from "./simulator-battle-probe-store";
import type { BattleRegistrationGate } from "./simulator-battle-registration";
import type { OwnedSimulatorClock } from "./simulator-clock-bootstrap";
import type { SimulatorSettings } from "./simulator-hosting";

export interface BattleProbeJournalContext {
  readonly settings: SimulatorSettings;
  readonly clock: OwnedSimulatorClock;
  readonly store: SimulatorBattleProbeStore;
  readonly signal: AbortSignal;
  /** Trusted synchronous authorization/registration recheck. Revision must change
   * on every relevant gate/registration change. Caller owns event serialization.
   * No transaction is held across provider awaits. */
  readonly current: () => BattleRegistrationGate;
}
interface Dependencies {
  transport?: typeof directWebTransport;
  /** Monotonic elapsed time for provider transport validity. */
  now?: () => number;
  /** Unix wall time for scoring minutes, independent of provider monotonic time. */
  wallNow?: () => number;
}

/** Optional owned-runtime orchestration only. No catalog or scoring qualification. */
export class SimulatorBattleProbeJournal {
  constructor(
    private readonly context: BattleProbeJournalContext,
    private readonly dependencies: Dependencies = {},
  ) {}
  async prepare(slot: "frontend" | "api", budgetMs: number): Promise<BattleProbeRecord> {
    const before = this.gate();
    const descriptor = await prepareBattleProbeDescriptor(
      this.context.settings,
      this.context.clock,
      before.owner,
      slot,
      budgetMs,
      this.dependencies,
    );
    this.assertGate(before, descriptor);
    return this.context.store.prepare(descriptor, { authorizationRevision: before.revision });
  }
  /** Pin both slot intents to one trusted wall-clock minute, without dispatch. */
  async prepareMinute(minute: number, budgetMs: number) {
    this.assertMinute(minute);
    const before = this.gate();
    const prepare = (slot: "frontend" | "api") =>
      prepareBattleProbeDescriptor(
        this.context.settings,
        this.context.clock,
        before.owner,
        slot,
        budgetMs,
        this.dependencies,
      );
    const [frontend, api] = await Promise.all([prepare("frontend"), prepare("api")]);
    this.assertGate(before, frontend);
    this.assertGate(before, api);
    this.assertMinute(minute);
    return this.context.store.prepareMinute([frontend, api], {
      authorizationRevision: before.revision,
      minute,
    });
  }
  async start(id: string): Promise<BattleProbeRecord> {
    const record = this.context.store.get(id);
    if (record.state !== "prepared")
      throw new Error("Battle start already claimed; read recovery only.");
    this.assertMinute(record.minute);
    const before = this.gate(record.descriptor);
    if (before.revision !== record.authorizationRevision)
      throw new Error("Battle probe authorization revision changed; retained without rebasing.");
    await authenticateBattleProbeDescriptor(
      this.context.settings,
      this.context.clock,
      record.descriptor,
      this.dependencies,
    );
    this.assertGate(before, record.descriptor);
    this.assertMinute(record.minute);
    const claimed = this.context.store.claimStart(id, record.revision);
    try {
      this.assertGate(before, claimed.descriptor);
      const result = await dispatchClaimedBattleProbeStart(
        this.context.settings,
        this.context.clock,
        claimed.descriptor,
        this.dependencies,
      );
      this.assertGate(before, claimed.descriptor);
      return this.context.store.saveSnapshot(id, claimed.revision, result.snapshot);
    } catch (error) {
      this.retainUnknown(claimed);
      throw error;
    }
  }
  async recover(id: string): Promise<BattleProbeRecord> {
    let record = this.context.store.get(id);
    if (record.state === "expired-unstarted")
      throw new Error("Expired unstarted intent is terminal.");
    const before = this.gate(record.descriptor);
    if (before.revision !== record.authorizationRevision)
      throw new Error("Battle probe authorization revision changed; retained without rebasing.");
    if (record.state === "settled") return record;
    try {
      const operation = await resumeBattleProbeReadOnly(
        this.context.settings,
        this.context.clock,
        record.descriptor,
        record.snapshot,
        this.dependencies,
      );
      this.assertGate(before, record.descriptor);
      if (record.state === "prepared") record = this.context.store.claimStart(id, record.revision);
      this.assertGate(before, record.descriptor);
      const result = await operation.read();
      this.assertGate(before, record.descriptor);
      return this.context.store.saveSnapshot(id, record.revision, result.snapshot);
    } catch (error) {
      this.retainUnknown(record);
      throw error;
    }
  }
  private assertMinute(minute: number | undefined): void {
    if (minute === undefined) return; // Legacy non-scoring correlation intents.
    if (
      !Number.isSafeInteger(minute) ||
      minute < 0 ||
      minute !== Math.floor((this.dependencies.wallNow ?? Date.now)() / 60_000)
    )
      throw new Error("Battle probe minute is no longer current; retain for read recovery.");
  }
  private retainUnknown(record: BattleProbeRecord): void {
    try {
      this.context.store.recordUnknown(
        record.descriptor.key,
        record.revision,
        "Probe result is unconfirmed; same-key read recovery required.",
      );
    } catch {
      // Original durable intent remains active even if the failure cannot be saved.
      // Do not hide the original exception or claim successful persistence.
    }
  }
  private gate(descriptor?: BattleProbeDescriptor) {
    this.context.signal.throwIfAborted();
    const current = this.context.current();
    const revision = z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(current.revision);
    const { target } = current;
    const owner = structuredClone(target.owner);
    const ownerKey = battleOwnerKey(owner);
    if (
      target.kind !== "battle-deployment-correlation-only" ||
      target.problemId !== "hello-world-battle" ||
      target.ownerKey !== ownerKey ||
      target.generation !== `${owner.jobId}:${owner.deployedAt}:${owner.unitHash}`
    )
      throw new Error("Invalid current Battle journal target.");
    if (
      descriptor &&
      (descriptor.deadline.domain !== this.context.clock.domain ||
        descriptor.generation !== target.generation ||
        battleOwnerKey(descriptor.owner) !== ownerKey)
    )
      throw new Error("Stale or foreign Battle probe intent; retained for recovery.");
    this.context.signal.throwIfAborted();
    return {
      revision,
      generation: target.generation,
      ownerKey,
      owner,
      domain: this.context.clock.domain,
    };
  }
  private assertGate(
    before: ReturnType<SimulatorBattleProbeJournal["gate"]>,
    descriptor: BattleProbeDescriptor,
  ): void {
    const after = this.gate(descriptor);
    if (
      before.revision !== after.revision ||
      before.generation !== after.generation ||
      before.ownerKey !== after.ownerKey ||
      before.domain !== after.domain
    )
      throw new Error("Battle probe authorization changed during provider request.");
  }
}
