import { S3Client } from "@aws-sdk/client-s3";
import {
  type CoordinationArtifactStore,
  UnconfiguredCoordinationArtifactStore,
} from "../../control-data/coordination-artifact-store.js";
import { S3CoordinationArtifactStore } from "../../control-data/s3-coordination-artifact-store.js";

/**
 * [Issue #3152] One place every Lambda resolves the artifact store from.
 *
 * Four handlers need it and they need it for two different reasons — the
 * dispatcher writes and reads bodies, while the event and deploy handlers only
 * ever delete a scope's worth on teardown. Both go through this factory so
 * "which bucket" and "what happens when there isn't one" have a single answer.
 * A handler that resolved its own could disagree with the others about whether
 * artifacts exist at all, and the disagreement would show up as a torn-down
 * match that kept its objects.
 *
 * The client is created only when a bucket is actually configured.
 */

/**
 * The artifact store for this call.
 *
 * With no `COORDINATION_ARTIFACT_BUCKET` this returns the unconfigured store,
 * whose writes throw and whose deletions are no-ops. That asymmetry is
 * deliberate: refusing to store a body the platform cannot keep is the honest
 * answer, while failing a teardown because a bucket was never configured would
 * block the teardown to protect nothing.
 *
 * Constructed per call rather than cached at module scope. Every caller here is
 * a teardown path — event teardown, a run reset, the last-deployment cleanup —
 * which happens once per operator gesture, not once per participant request.
 * (The dispatcher, which IS on the request path, builds its store once at
 * module scope in its own entrypoint.) A module-level cache would save nothing
 * measurable and would make the environment unreadable to a test that wanted to
 * vary it.
 */
export function resolveCoordinationArtifactStore(
  env: { readonly COORDINATION_ARTIFACT_BUCKET?: string } = process.env,
): CoordinationArtifactStore {
  const bucket = env.COORDINATION_ARTIFACT_BUCKET ?? "";
  return bucket
    ? new S3CoordinationArtifactStore({ s3: new S3Client({}), bucket })
    : new UnconfiguredCoordinationArtifactStore();
}
