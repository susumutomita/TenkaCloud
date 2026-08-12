/**
 * The launcher default pair last shipped in infrastructure/templates/lite-pipeline.yaml.
 *
 * Under manifest schema v2 the checked-in manifest no longer pins a platform commit
 * (the platform identity of a release is its tag commit, derived at publish time), so
 * the launcher defaults can no longer be cross-checked against the manifest. Until
 * #3024 PR 2 generates these bindings from the resolved release identity, this module
 * is the single test-side anchor for the five hand-maintained literals in the launcher
 * template: RepoRef / ProblemsRepoRef defaults, the UsesCandidateReleasePair condition,
 * the buildspec classification echo, and the ReleaseManifestVersion output.
 *
 * Updating the launcher template means updating this baseline in the same commit —
 * that is the point: the pair must change deliberately, never as a side effect.
 */
export const LAUNCHER_RELEASE_BASELINE = {
  manifestVersion: "1.2.0-candidate.20260810",
  platformCommit: "421cd1bd9ede67ccf765878f1cbf27d7c5660762",
  catalogCommit: "2e98928e985be637b60453fda5d1005bcc1a0f5c",
} as const;
