import { DEFAULT_SIMULATOR_IMAGE } from "../local-play/simulator-launch-state";
import { type ReleaseManifest, readReleaseManifest } from "./manifest";

/**
 * Drift gate for the BOM values that ship inside the product rather than beside it (#3024).
 *
 * The release manifest is the single authoring point for what a release IS. Most consumers
 * already derive from it — the report is generated, the launcher literals are stamped, the
 * attestation is built from the resolved identity. A BOM value hand-copied into product
 * code has none of those guarantees: it can be bumped in one place and left stale in the
 * other, and the release would still publish, claiming a Simulator digest that the CLI it
 * ships does not actually launch.
 *
 * This gate closes that gap without adding a codegen step to typed runtime code: the copy
 * stays where the runtime needs it, but it cannot disagree with the manifest and still merge.
 * The manifest is authoritative — when these disagree, the product code is what moves.
 */

export interface BomConsumer {
  /** Where the value lives, as a developer would go find it. */
  readonly consumer: string;
  /** Why this value is part of the release BOM at all. */
  readonly reason: string;
  /** The value the product code currently ships. */
  readonly actual: string;
  /** The value the manifest declares for this release. */
  readonly expected: (manifest: ReleaseManifest) => string;
}

export const BOM_CONSUMERS: readonly BomConsumer[] = [
  {
    consumer: "scripts/local-play/simulator-launch-state.ts DEFAULT_SIMULATOR_IMAGE",
    reason:
      "local play launches this image, so it is the Simulator a user of this release actually runs",
    actual: DEFAULT_SIMULATOR_IMAGE,
    expected: (manifest) => manifest.artifacts.simulatorImage,
  },
];

export interface BomConsumerDrift {
  readonly consumer: string;
  readonly reason: string;
  readonly expected: string;
  readonly actual: string;
}

export function findBomConsumerDrift(
  manifest: ReleaseManifest,
  consumers: readonly BomConsumer[] = BOM_CONSUMERS,
): readonly BomConsumerDrift[] {
  return consumers
    .map((consumer) => ({
      consumer: consumer.consumer,
      reason: consumer.reason,
      expected: consumer.expected(manifest),
      actual: consumer.actual,
    }))
    .filter((drift) => drift.expected !== drift.actual);
}

export function formatBomConsumerDrift(drift: readonly BomConsumerDrift[]): string {
  return drift
    .map(
      (entry) =>
        `${entry.consumer}\n  ships:   ${entry.actual}\n  manifest: ${entry.expected}\n  ` +
        `why it matters: ${entry.reason}`,
    )
    .join("\n\n");
}

function main(): void {
  const drift = findBomConsumerDrift(readReleaseManifest());
  if (drift.length > 0) {
    console.error(
      "Product code ships BOM values that disagree with release/tenkacloud-release.json. " +
        "The manifest is authoritative; update the code to match it.\n\n" +
        formatBomConsumerDrift(drift),
    );
    process.exit(1);
  }
  console.log(`All ${BOM_CONSUMERS.length} in-product BOM values match tenkacloud-release.json.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
