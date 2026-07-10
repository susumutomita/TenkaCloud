import type { FeatureFlagsRepository, TenantFeatureFlagsRecord } from "./types.js";

export class MirroredFeatureFlagsRepository implements FeatureFlagsRepository {
  constructor(
    private readonly canonical: FeatureFlagsRepository,
    private readonly replica: FeatureFlagsRepository,
  ) {}

  async get(tenantId: string): Promise<TenantFeatureFlagsRecord | undefined> {
    return this.canonical.get(tenantId);
  }

  // [#2439] この aggregate に delete は無く、 行は put 全置換でしか変わらない —
  // write-through で replica は収束する(read-repair 不要)。
  async put(record: TenantFeatureFlagsRecord): Promise<void> {
    await this.canonical.put(record);
    await this.replica.put(record);
  }
}
