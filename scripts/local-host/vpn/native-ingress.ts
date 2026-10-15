import { stageVpnIngress } from "../network-audit";
import { type VpnRuntimeAdmission, vpnForwardPolicy } from "./forward-policy";
import { NativeVpnBackend, type VpnIngress } from "./native-backend";
import type { VpnPeerProof } from "./peer-admission";
import type { VpnPeerPlan } from "./peer-plan";
export class VpnPolicyRevoked extends Error {}

/** One active preparation plus one latest desired snapshot; only main may seal/unseal. */
export class NativeVpnIngress implements VpnIngress {
  private readonly backend: Pick<NativeVpnBackend, "seal" | "suspend" | "commit" | "authorize">;
  private epoch = 0;
  private desired?: { epoch: number; runtimes: readonly VpnRuntimeAdmission[] };
  private pending?: Promise<void>;
  constructor(
    readonly plan: VpnPeerPlan,
    private readonly stage: (
      plan: VpnPeerPlan,
      runtimes: readonly VpnRuntimeAdmission[],
    ) => Promise<VpnPeerProof> = stageVpnIngress,
    backend?: Pick<NativeVpnBackend, "seal" | "suspend" | "commit" | "authorize">,
  ) {
    this.backend = backend ?? new NativeVpnBackend(plan);
  }
  seal(): void {
    this.epoch++;
    this.desired = undefined;
    this.backend.suspend();
  }
  validate(runtimes: readonly VpnRuntimeAdmission[], now: number): void {
    vpnForwardPolicy(this.plan, runtimes, now);
  }
  reconcile(runtimes: readonly VpnRuntimeAdmission[]): Promise<void> {
    this.seal();
    this.desired = { epoch: this.epoch, runtimes: structuredClone(runtimes) };
    if (!this.pending)
      this.pending = this.prepareLatest().finally(() => {
        this.pending = undefined;
      });
    return this.settleLatest();
  }
  private async settleLatest(): Promise<void> {
    do {
      if (!this.pending && this.desired)
        this.pending = this.prepareLatest().finally(() => {
          this.pending = undefined;
        });
      await this.pending;
    } while (this.desired || this.pending);
  }
  private async prepareLatest(): Promise<void> {
    while (this.desired) {
      const request = this.desired;
      this.desired = undefined;
      let proof: VpnPeerProof;
      try {
        proof = await this.stage(this.plan, request.runtimes);
      } catch (error) {
        if (request.epoch !== this.epoch && this.desired) continue;
        this.failClosed(error);
      }
      if (request.epoch !== this.epoch) {
        if (this.desired) continue;
        throw new VpnPolicyRevoked("VPN policy was revoked during preparation.");
      }
      try {
        this.backend.commit(proof);
      } catch (error) {
        this.failClosed(error);
      }
    }
  }
  private failClosed(error: unknown): never {
    try {
      this.backend.seal();
    } catch (sealError) {
      throw new AggregateError([error, sealError], "VPN preparation and emergency seal failed.");
    }
    throw error;
  }
  authorize(socketAddress: string, authenticated: { eventId: string; teamId: string }): void {
    this.backend.authorize(socketAddress, authenticated);
  }
}
