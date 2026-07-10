import type { SamlConfigRecord, SamlConfigRepository } from "./types.js";

/**
 * [Issue #2442 / Phase C2] DynamoDB-primary/SQL-replica equivalent for the
 * SamlConfig sub-aggregate (mirrors {@link MirroredFeatureFlagsRepository}'s
 * write-through, no-delete-repair shape — `putSamlConfig` is a full replace so
 * write-through alone keeps the replica converged; `deleteSamlConfig` is
 * idempotent on both backends).
 */
export class MirroredSamlConfigRepository implements SamlConfigRepository {
  constructor(
    private readonly canonical: SamlConfigRepository,
    private readonly replica: SamlConfigRepository,
  ) {}

  getSamlConfig(tenantId: string): Promise<SamlConfigRecord | undefined> {
    return this.canonical.getSamlConfig(tenantId);
  }

  async putSamlConfig(record: SamlConfigRecord): Promise<SamlConfigRecord> {
    const written = await this.canonical.putSamlConfig(record);
    await this.replica.putSamlConfig(record);
    return written;
  }

  async deleteSamlConfig(tenantId: string): Promise<void> {
    await this.canonical.deleteSamlConfig(tenantId);
    await this.replica.deleteSamlConfig(tenantId);
  }
}
