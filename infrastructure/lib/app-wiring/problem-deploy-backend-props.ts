import type { AppConfig } from "../app-config/types.js";
import type { ProblemDeployBackendStack } from "../problem-deploy/problem-deploy-backend-stack.js";

/**
 * Issue #2209: SaaS (`wire.ts`) と Lite (`bin/tenkacloud-lite.ts`) が
 * `ProblemDeployBackendStack` へ渡す props のうち、**両モードで同一であるべき共通部分**を
 * 1 ヶ所に集約する factory。
 *
 * 旧実装は同じ 12 フィールド (source bundle + problems.* 9 種 + build limit + env 名) を
 * 2 箇所で lockstep 配線しており、新しい問題メタデータ field を追加した際に片側 (実際には
 * Lite) だけ配線漏れして **Lite モードでだけその field が無音で落ちる** drift が構造的に
 * 起きていた。以後、新 field は本 factory に 1 回追加すれば両モードへ届く。
 *
 * モード固有の差分は意図的にここへ入れない (= 呼び出し側の責務のまま):
 *   - `eventBusArn` — SaaS は ControlPlane の bus、Lite は省略 (local bus 自動作成)
 *   - `participantPortal` — SaaS は config 駆動、Lite は `default-dev-mock` 固定
 *   - `deployQuotaByTier` / `challengePayloadBucketName` — SaaS のみ
 */
export function buildProblemDeployBackendBaseProps(config: AppConfig) {
  return {
    sourceBucketName: config.s3SourceBucket,
    sourceObjectKey: config.sourceZip,
    problemsCatalog: config.problems.catalog as ProblemDeployBackendProps["problemsCatalog"],
    problemsScoring: config.problems.scoring as ProblemDeployBackendProps["problemsScoring"],
    problemsWriteups: (config.problems.writeups ??
      {}) as ProblemDeployBackendProps["problemsWriteups"],
    problemsEndpoints: config.problems.endpoints as ProblemDeployBackendProps["problemsEndpoints"],
    // 実運用の catalog source (LocalCatalogSource) は 9 キーすべてを常に返すため、以下の
    // `?? {}` は stub 注入時 (テスト等) 限定の防御。旧 Lite 側の式をそのまま採用する。
    problemsPhases: (config.problems.phases ?? {}) as ProblemDeployBackendProps["problemsPhases"],
    problemsVisibility: (config.problems.visibility ??
      {}) as ProblemDeployBackendProps["problemsVisibility"],
    // [ADR-023 / #2054] 非 AWS runtime catalog を deploy-handler の guard へ injection
    problemRuntimes: (config.problems.runtimes ?? {}) as Readonly<Record<string, unknown>>,
    // Issue #888: per-problem `disruptions[]` を Lambda env に injection
    problemsDisruptions: (config.problems.disruptions ?? {}) as Readonly<Record<string, unknown>>,
    // Issue #2464: pack-only provenance is pinned onto events by EventApiLambda at create time.
    problemsProvenance: (config.problems.provenance ?? {}) as Readonly<Record<string, unknown>>,
    // #1420 ADR-030 Phase 3: per-problem coordination plugin path を dispatcher へ injection
    problemsCoordination: (config.problems.coordination ?? {}) as Readonly<Record<string, unknown>>,
    // #1420 ADR-030 Phase 3b: synth-bundle 済み coordination plugin (.mjs) を S3 へ配置
    problemsCoordinationBundles: (config.problems.coordinationBundles ?? {}) as Readonly<
      Record<string, string>
    >,
    deployConcurrentBuildLimit: config.deployConcurrentBuildLimit,
    deployAllowedCidrs: config.deployAllowedCidrs,
    // Issue #2232: was permanently unreachable in production (no CDK_PARAM_* wired it true).
    useBulkDistributedMap: config.useBulkDistributedMap,
    // Issue #2291: DeployCreate を Lambda CreateStack 経路にするか。両モードで同一挙動にするため
    // base props に集約 (default false = 在来 CodeBuild、CFn テンプレ byte 互換)。
    deployViaLambda: config.deployViaLambda,
    // Issue #2462: Lite が activation store から解決した pack assets を materialize 用に渡す。
    // 両モードで同一に届くよう base props に集約するが、SaaS (bin/infrastructure.ts) は packAssets を
    // 解決しない (= undefined)。undefined / 空 → BucketDeployment 追加ゼロ = CFn byte 互換。
    packAssets: config.packAssets,
    // Issue #2311: 監査ログ出力の on/off。両モードで同一挙動にするため base props に集約。
    auditLogEnabled: config.auditLogEnabled,
    // Issue #2290: control-plane data backend (dynamodb|turso) の選択。base props に集約する
    // ことで SaaS (wire.ts) と Lite (bin/tenkacloud-lite.ts) の両モードへ同一に届く (= Lite mode
    // での flag 切替配線)。default "dynamodb" は Lambda env を足さず CFn byte 互換。
    controlDataBackend: config.controlDataBackend,
    tursoDatabaseUrl: config.tursoDatabaseUrl,
    tursoAuthTokenParameterName: config.tursoAuthTokenParameterName,
    opsMonitoring: config.opsMonitoring,
    environmentName: config.environment,
  } as const;
}

// The `unknown` parts of ProblemsCatalogBundle map to the (unexported) prop types of
// ProblemDeployBackendStack. They are intentionally widened in the AppConfig surface
// (= app-config has no dependency on the construct's prop types) and re-narrowed here
// at the consumer boundary. The cast is structurally safe because both sides originate
// from the same `discoverProblems*` outputs.
type ProblemDeployBackendProps = ConstructorParameters<typeof ProblemDeployBackendStack>[2];
