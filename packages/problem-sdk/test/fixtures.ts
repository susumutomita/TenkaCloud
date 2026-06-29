/**
 * Shared, single-source metadata + manifest fixtures (#2106).
 *
 * Both the SDK tests and the platform-agreement test consume these so there is
 * exactly one definition of "valid" / "invalid" — divergence between the SDK and
 * the platform validator surfaces as a test failure rather than silent drift.
 */

/** A valid problem `metadata.json` (default aws/cloudformation runtime + flag scoring). */
export const VALID_METADATA = {
  id: "hello-world",
  title: "Hello World",
  category: "challenge",
  scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
} as const;

/** A valid problem using a composite runtime. */
export const VALID_COMPOSITE_METADATA = {
  id: "multi-cloud",
  title: "Multi Cloud",
  runtime: {
    kind: "composite",
    targets: [
      { id: "frontend", provider: "aws", engine: "cloudformation", entry: "frontend.yaml" },
      { id: "backend", provider: "azure", engine: "bicep", entry: "backend.bicep" },
    ],
  },
} as const;

/** Invalid: missing the required `id`. */
export const INVALID_METADATA_NO_ID = {
  title: "No Id",
  scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
} as const;

/** Invalid: a `scoring` section that matches no built-in kind. */
export const INVALID_METADATA_BAD_SCORING = {
  id: "bad-scoring",
  scoring: { kind: "not-a-real-kind", points: 10 },
} as const;

/** Invalid: a malformed runtime (provider/engine/entry not all strings). */
export const INVALID_METADATA_BAD_RUNTIME = {
  id: "bad-runtime",
  runtime: { provider: 123, engine: "cloudformation", entry: "template.yaml" },
} as const;

/** Invalid: a runtime naming an unknown (unsupported) provider/engine capability. */
export const INVALID_METADATA_UNKNOWN_CAPABILITY = {
  id: "unknown-capability",
  runtime: { provider: "nintendo", engine: "switch", entry: "template.yaml" },
} as const;

/** A valid pack manifest. */
export const VALID_MANIFEST = {
  schemaVersion: 1,
  id: "com.example.starter",
  version: "1.0.0",
  core: "^1.0.0",
  title: "Starter Pack",
  description: "A starter problem pack.",
  license: "Apache-2.0",
  problemsRoot: "problems",
  requiredRuntimes: [{ provider: "aws", engine: "cloudformation" }],
} as const;

/** Invalid manifest: bad id, bad version, unknown field, traversal path. */
export const INVALID_MANIFEST = {
  schemaVersion: 1,
  id: "Not_Reverse_DNS",
  version: "not-semver",
  core: "^1.0.0",
  title: "Bad",
  description: "Bad",
  license: "Apache-2.0",
  problemsRoot: "../escape",
  requiredRuntimes: [],
  unexpectedField: true,
} as const;
