/**
 * [Issue #2527 Slice 3] Mirror (DynamoDB-canonical + SQL-replica) adapter for the
 * saml-idps aggregate — extracted verbatim from the former all-aggregate
 * `mirrored-repositories.ts`, which now re-exports this class as a barrel.
 * Mirror policy: writes commit to canonical first and reach the replica only on
 * a successful canonical outcome; reads/cursors are canonical-only unless the
 * class documents read-repair; a replica failure throws (fail loud).
 */

import type { IdpScope } from "../../control-plane/handlers/idp-handler/core.js";
import type { SamlIdpRecord, SamlIdpsRepository } from "./types.js";

/**
 * [Issue #2442 / Phase C5] DynamoDB-primary/SQL-replica equivalent for the SamlIdps aggregate
 * (mirrors {@link MirroredProblemEndpointsRepository}'s read-passthrough / write-through-both
 * style — no conditional writes, no Scan, the smallest of the C-series aggregates).
 */
export class MirroredSamlIdpsRepository implements SamlIdpsRepository {
  constructor(
    private readonly canonical: SamlIdpsRepository,
    private readonly replica: SamlIdpsRepository,
  ) {}

  list(scope: IdpScope): Promise<readonly SamlIdpRecord[]> {
    return this.canonical.list(scope);
  }

  get(scope: IdpScope, idpId: string): Promise<SamlIdpRecord | null> {
    return this.canonical.get(scope, idpId);
  }

  async put(scope: IdpScope, config: SamlIdpRecord): Promise<void> {
    await this.canonical.put(scope, config);
    await this.replica.put(scope, config);
  }

  async delete(scope: IdpScope, idpId: string): Promise<void> {
    await this.canonical.delete(scope, idpId);
    await this.replica.delete(scope, idpId);
  }
}
