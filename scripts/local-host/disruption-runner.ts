import type { DisruptionAdapter, DisruptionExecution, DisruptionTarget } from "./disruption-model";
import type { DisruptionStore } from "./disruption-store";

export class DisruptionRunner {
  private work?: Promise<void>;
  constructor(
    private readonly store: DisruptionStore,
    private readonly adapter: () => DisruptionAdapter | undefined,
    private readonly now: () => number,
    private readonly assertTarget: (
      target: DisruptionTarget,
      requestId: string,
      injecting: boolean,
    ) => void,
    private readonly onSaved?: (row: DisruptionExecution) => void,
  ) {}
  recover(): void {
    for (const row of this.store.active()) {
      if (row.status === "queued" && row.dueAt <= this.now())
        this.save({
          ...row,
          status: "skipped",
          reason: "The injection became overdue while the host was stopped.",
        });
      if (row.status === "injecting")
        this.save({
          ...row,
          status: "inject_unknown",
          reason:
            "The host stopped before the submission result was saved. The injection may still execute.",
        });
      if (row.status === "reverting")
        this.save({
          ...row,
          status: "recovery_required",
          reason: "The host stopped before the revert result was saved.",
        });
    }
  }
  tick(): Promise<void> {
    if (this.work) return this.work;
    const running = this.run().finally(() => {
      this.work = undefined;
    });
    this.work = running;
    return running;
  }
  async drain(): Promise<void> {
    await this.work;
  }
  private save(row: DisruptionExecution): void {
    const updated = { ...row, updatedAt: this.now() };
    this.store.putExecution(updated);
    // Audit is optional after the durable runtime result has been saved.
    try {
      this.onSaved?.(updated);
    } catch {
      // An audit observation cannot reverse a completed external command.
    }
  }
  private async run(): Promise<void> {
    const rows = this.store
      .active()
      .sort(
        (a, b) =>
          Number(a.status === "queued") - Number(b.status === "queued") || a.dueAt - b.dueAt,
      );
    for (const row of rows) await this.step(row);
  }
  private recoverInterrupted(row: DisruptionExecution): boolean {
    if (row.status === "injecting") {
      this.save({
        ...row,
        status: "inject_unknown",
        reason: "Submission was interrupted; the command may still execute.",
      });
      return true;
    }
    if (row.status === "reverting") {
      this.save({
        ...row,
        status: "recovery_required",
        reason: "Revert submission was interrupted.",
      });
      return true;
    }
    return false;
  }
  private async step(row: DisruptionExecution): Promise<void> {
    if (this.recoverInterrupted(row)) return;
    if (row.status === "queued") {
      await this.inject(row);
      return;
    }
    const adapter = this.adapter();
    if (!adapter) return;
    try {
      this.assertTarget(row.target, row.requestId, false);
    } catch {
      if ("inject" in row)
        this.save({
          ...row,
          status: "recovery_required",
          reason:
            "The original deployment generation is unavailable. Recovery must use its retained resources, never a replacement stack.",
        });
      return;
    }
    if (row.status === "inject_pending" || row.status === "inject_unknown") {
      await this.observeInject(row, adapter);
      return;
    }
    if (row.status === "revert_due" && row.revertAt <= this.now()) {
      await this.revert(row, adapter);
      return;
    }
    if (row.status === "revert_pending" || row.status === "recovery_required") {
      if (!row.revert) {
        await this.observeInject(
          {
            ...row,
            status: "inject_unknown",
            reason: "The inject command must finish before recovery can be claimed.",
          },
          adapter,
        );
      } else await this.observeRevert(row, adapter);
    }
  }
  private async inject(row: Extract<DisruptionExecution, { status: "queued" }>): Promise<void> {
    if (row.dueAt > this.now()) return;
    if (this.now() - row.dueAt > 30_000) {
      this.save({
        ...row,
        status: "skipped",
        reason: "The injection missed its due time. Catch-up injection is disabled.",
      });
      return;
    }
    try {
      this.assertTarget(row.target, row.requestId, true);
    } catch {
      this.save({
        ...row,
        status: "skipped",
        reason: "The request was cancelled, play ended, or its deployment changed.",
      });
      return;
    }
    const conflict = this.store
      .active()
      .some(
        (other) =>
          other.id !== row.id &&
          other.status !== "queued" &&
          other.target.resources.some((resource) => row.target.resources.includes(resource)),
      );
    if (conflict) {
      this.save({
        ...row,
        status: "skipped",
        reason: "A prior disruption still owns this resource until recovery completes.",
      });
      return;
    }
    const adapter = this.adapter();
    if (!adapter) {
      this.save({ ...row, status: "failed", reason: "The host has no AWS disruption adapter." });
      return;
    }
    const injecting = {
      ...row,
      status: "injecting" as const,
      inject: { key: `tc-disrupt-${row.id}-i`, sentAt: this.now() },
      revertAt: this.now() + row.target.afterSeconds * 1000,
    };
    this.save(injecting);
    const result = await adapter.submit({
      target: row.target,
      dispatch: row.target.inject,
      operationKey: injecting.inject.key,
      assertCurrent: () => this.assertTarget(row.target, row.requestId, true),
    });
    if (result.kind === "rejected") this.save({ ...row, status: "failed", reason: result.reason });
    else if (result.kind === "unknown")
      this.save({ ...injecting, status: "inject_unknown", reason: result.reason });
    else
      this.save({
        ...injecting,
        status: "inject_pending",
        inject: { ...injecting.inject, operationId: result.operationId },
      });
  }
  private async observeInject(
    row: Extract<DisruptionExecution, { status: "inject_pending" | "inject_unknown" }>,
    adapter: DisruptionAdapter,
  ): Promise<void> {
    let inject = row.inject;
    if (!inject.operationId) {
      const discovered = await adapter.discover({
        target: row.target,
        dispatch: row.target.inject,
        operationKey: inject.key,
        sentAt: inject.sentAt,
      });
      if (discovered.kind === "unknown") {
        this.save({ ...row, status: "inject_unknown", reason: discovered.reason });
        return;
      }
      inject = { ...inject, operationId: discovered.operationId };
      this.save({ ...row, status: "inject_pending", inject });
    }
    if (!inject.operationId) return;
    const observed = await adapter.observe({ target: row.target, operationId: inject.operationId });
    if (observed.kind === "completed" || observed.kind === "failed")
      this.save({
        ...row,
        status: "revert_due",
        inject,
        injectOutcome: observed.kind,
        revertAt: observed.kind === "failed" ? this.now() : row.revertAt,
      });
    else if (observed.kind === "unknown")
      this.save({ ...row, status: "inject_unknown", inject, reason: observed.reason });
  }
  private async revert(
    row: Extract<DisruptionExecution, { status: "revert_due" }>,
    adapter: DisruptionAdapter,
  ): Promise<void> {
    const reverting = {
      ...row,
      status: "reverting" as const,
      revert: { key: `tc-disrupt-${row.id}-r`, sentAt: this.now() },
    };
    this.save(reverting);
    const result = await adapter.submit({
      target: row.target,
      dispatch: row.target.revert,
      operationKey: reverting.revert.key,
      assertCurrent: () => this.assertTarget(row.target, row.requestId, false),
    });
    if (result.kind !== "accepted")
      this.save({ ...reverting, status: "recovery_required", reason: result.reason });
    else
      this.save({
        ...reverting,
        status: "revert_pending",
        revert: { ...reverting.revert, operationId: result.operationId },
      });
  }
  private async observeRevert(
    row: Extract<DisruptionExecution, { status: "revert_pending" | "recovery_required" }>,
    adapter: DisruptionAdapter,
  ): Promise<void> {
    let revert = row.revert;
    if (!revert) return;
    if (!revert.operationId) {
      const discovered = await adapter.discover({
        target: row.target,
        dispatch: row.target.revert,
        operationKey: revert.key,
        sentAt: revert.sentAt,
      });
      if (discovered.kind === "unknown") {
        this.save({ ...row, status: "recovery_required", reason: discovered.reason });
        return;
      }
      revert = { ...revert, operationId: discovered.operationId };
      this.save({ ...row, status: "revert_pending", revert });
    }
    if (!revert.operationId) return;
    const observed = await adapter.observe({ target: row.target, operationId: revert.operationId });
    if (observed.kind === "completed")
      this.save({ ...row, status: "revert_command_completed", revert });
    else if (observed.kind !== "pending")
      this.save({ ...row, status: "recovery_required", revert, reason: observed.reason });
  }
}
