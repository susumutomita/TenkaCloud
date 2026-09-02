import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/**
 * [Issue #3152] The bucket holding immutable coordination submissions.
 *
 * ## Why not the plugin bundle bucket
 *
 * The dispatcher already reads one bucket — the one holding the plugin code it
 * dynamically imports — and reusing it would have saved a construct. It would
 * also have given the process that runs problem code write access to the
 * objects that process imports as code. The whole point of the dispatcher's
 * narrow role is that a plugin bug cannot reach further than the plugin; a bug
 * that could overwrite the next plugin would reach every future match. A second
 * bucket is cheap and that is not.
 *
 * ## Retention
 *
 * Artifacts are match evidence: a proof, a leaked share, a transcript. They
 * matter while the match is being played and for the debrief afterwards, and
 * they are pure cost after that. The expiry below matches the coordination
 * state row's own seven-day retention (`coordination-scope.ts`), so a debrief
 * that can still read the state can still read what the state refers to, and
 * neither outlives the other.
 *
 * That expiry is a backstop, not the delete path. Teardown, the operator's run
 * reset, and the last-deployment cleanup (#3149) each remove a scope's objects
 * when the match actually ends.
 *
 * ## Cost
 *
 * Storage is the only standing charge: no requests, no data transfer out of the
 * Region, no replication. At `ac26-crypto-battle`'s measured shape — roughly
 * 1 MB of public ledger per 99-team match — a busy event holds single-digit
 * megabytes for at most a week. Versioning is deliberately OFF: these objects
 * are written once and never updated, so versions would only accumulate copies
 * of deletions.
 */
export class CoordinationArtifactBucket extends Construct {
  public readonly bucket: IBucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Versioning is OFF, and this is the one place in this construct where a
      // lint rule is answered rather than obeyed.
      //
      // The objects here are written once and never updated, so versions could
      // only ever record deletions. Worse, they would record them in a way that
      // breaks a requirement of this feature: deleting a scope has to leave the
      // prefix empty, and under versioning a delete leaves a delete marker with
      // every object still present as a noncurrent version. Turning versioning
      // on would mean the reset that is supposed to erase a match's evidence
      // did not, and the teardown that is supposed to empty a prefix did not
      // either — with a lifecycle rule quietly finishing the job a day later.
      //
      // The sibling `CoordinationPluginBundle` bucket is unversioned for the
      // same reason and carries the same finding in the ESLint ceiling.
      // eslint-disable-next-line sonarjs/aws-s3-bucket-versioning -- see above: versioning would defeat scope deletion
      versioned: false,
      // Match evidence is reproducible only by replaying the match, which is to
      // say it is not reproducible — but it is also worthless once the event is
      // over, and it is already covered by the seven-day expiry below. Keeping
      // the bucket after a stack delete would leave objects nobody can reach
      // through any surviving row.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: "expire-coordination-artifacts",
          enabled: true,
          expiration: Duration.days(COORDINATION_ARTIFACT_RETENTION_DAYS),
          // Uploads interrupted by a Lambda timeout would otherwise be billed
          // indefinitely while being invisible to every listing.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });
  }
}

/**
 * Days an artifact survives after it is written.
 *
 * Deliberately the same seven days as the coordination state row's TTL. If the
 * artifacts expired first, a surviving state row would reference bodies that no
 * longer exist; if the row expired first, the objects would be unreachable
 * bytes. Both are worse than the two ending together.
 */
export const COORDINATION_ARTIFACT_RETENTION_DAYS = 7;
