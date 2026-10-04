export interface ProblemWriteup {
  readonly ja: string;
  readonly en: string;
}

export interface PackAsset {
  /** Reverse-DNS pack id from the pack manifest (e.g. `com.example.cloud-pack`). */
  readonly packId: string;
  /** Immutable pack revision version from the manifest (e.g. `1.0.0`). */
  readonly version: string;
  /** Absolute path to the pack snapshot's problems root (the `BucketDeployment` source). */
  readonly problemsRootAbs: string;
}

export interface ProblemsCatalogBundle {
  readonly catalog: unknown;
  readonly scoring: unknown;
  /** Issue #2191: `{problemId: {ja,en}}` post-solve explanations, backend-only. */
  readonly writeups?: unknown;
  readonly endpoints: unknown;
  readonly phases: unknown;
  readonly visibility: unknown;
  /** [#2054] 非 aws/cloudformation runtime を宣言した問題のみ (`{problemId: {provider,engine,entry}}`)。 */
  readonly runtimes: unknown;
  /** Issue #888: per-problem `disruptions[]` 宣言。 未宣言の問題はキー無し。 */
  readonly disruptions: unknown;
  /** #1420: per-problem `interTeamCoordination.plugin` (`{ [problemId]: { plugin } }`)。 未宣言はキー無し。 */
  readonly coordination: unknown;
  /** #1420: `{ [problemId]: bundledMjs }` (synth-bundle 済み coordination plugin)。 */
  readonly coordinationBundles: unknown;
  /**
   * [Problem Packs / Issue #2464] `problemId → EffectiveCatalogProvenance` for pack-sourced
   * problems only. Core problems are intentionally absent (`{}` on the core-only path).
   */
  readonly provenance?: unknown;
}
