/**
 * Microservice Migration Battle (Phase 2 / #606) のスコア計算ロジック (pure functions)。
 *
 * - probe 結果 + 経過時間 → 1 tick あたり加減算ポイントを算出
 * - polling Lambda が用いる時間ベース「フェーズ判定」(= EC2 劣化 / legacy switch)
 *
 * pure / IO 無しに保ち、`scoring.test.ts` で単体テストできるようにする。
 */

/**
 * /meta が自己申告する platform。`ec2` だけが「未移行」とみなす。
 * 未知 (= /meta レスポンスに platform 属性が無い / 想定外の値) も移行未完了扱いとする
 * (= 競技者が誤って `unknown` を返した場合に最低スコアにならないよう、EC2 と同扱い)。
 */
export type Platform = "ec2" | "lambda" | "ecs" | "apprunner" | "unknown";

export interface ProbeResult {
  readonly ok: boolean;
  /** HTTP status code (timeout 時は 0)。 */
  readonly status: number;
  /** /score の応答時間 (ms)。timeout 時は 0。 */
  readonly responseTimeMs: number;
  /** /meta から取得した platform。失敗時は undefined。 */
  readonly platform: Platform | undefined;
  /** 失敗理由 ("timeout" / "network" / "non-2xx" / undefined)。 */
  readonly reason?: "timeout" | "network" | "non-2xx";
}

export interface MicroserviceMigrationPhase {
  /** deploy 時刻から `degradationMinutes` 経過したか (= EC2 score が +100 → +10 に落ちる)。 */
  readonly degraded: boolean;
  /** deploy 時刻から `legacySwitchMinutes` 経過したか (= polling が `/score?legacy=true` を叩く)。 */
  readonly legacy: boolean;
}

const LATENCY_PENALTY_MS = 1_500;
const LATENCY_PENALTY_POINTS = -10;

const POINTS = {
  failure: -100,
  ec2Pre: 100,
  ec2Post: 10,
  migrated: 1_000,
} as const;

/**
 * deploy createdAt + 現在時刻から degraded / legacy フラグを判定する。
 *
 * createdAt が未定義 (= 旧 deployment / 取得失敗) なら pre-degradation 扱い
 * (= 採点境界の安全側、deploy 直後と同等)。
 */
export function computePhase(
  createdAt: string | undefined,
  nowIso: string,
  degradationMinutes: number,
  legacySwitchMinutes: number,
): MicroserviceMigrationPhase {
  if (!createdAt) return { degraded: false, legacy: false };
  const createdMs = Date.parse(createdAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(createdMs) || Number.isNaN(nowMs)) {
    return { degraded: false, legacy: false };
  }
  const elapsedMin = (nowMs - createdMs) / 60_000;
  return {
    degraded: elapsedMin >= degradationMinutes,
    legacy: elapsedMin >= legacySwitchMinutes,
  };
}

export function resolveScorePath(legacy: boolean): "/score" | "/score?legacy=true" {
  return legacy ? "/score?legacy=true" : "/score";
}

/**
 * 1 probe の結果から 1 tick あたりの加減算ポイントを返す。
 *
 * - 失敗 (timeout / network / non-2xx): -100 で確定 (= 応答時間 penalty も適用しない)
 * - 成功時: platform 別の base score
 *   - ec2 (劣化前 phase): +100
 *   - ec2 (劣化後 phase): +10
 *   - lambda / ecs / apprunner: +1000
 *   - unknown / undefined: ec2 と同じ扱い (= 移行未完了視点)
 * - 応答時間 > 1500ms ペナルティ: 上記 base から -10
 */
export function scoreFromProbe(probe: ProbeResult, phase: MicroserviceMigrationPhase): number {
  if (!probe.ok) return POINTS.failure;

  const base = resolveBaseScore(probe.platform, phase);
  const penalty = probe.responseTimeMs > LATENCY_PENALTY_MS ? LATENCY_PENALTY_POINTS : 0;
  return base + penalty;
}

function resolveBaseScore(
  platform: Platform | undefined,
  phase: MicroserviceMigrationPhase,
): number {
  if (platform === "lambda" || platform === "ecs" || platform === "apprunner") {
    return POINTS.migrated;
  }
  // ec2 / unknown / undefined は EC2 と同じ扱い (= 移行未完了)。
  return phase.degraded ? POINTS.ec2Post : POINTS.ec2Pre;
}

/**
 * 3 slot 全てが non-ec2 platform なら "全分離達成" — Phase 2 の +5000 lump-sum bonus 対象。
 *
 * `unknown` は EC2 と同じく「未移行」扱い (= bonus 対象外、安全側)。
 */
export function isFullyMigrated(platforms: ReadonlyArray<Platform | undefined>): boolean {
  if (platforms.length < 3) return false;
  return platforms.every((p) => p === "lambda" || p === "ecs" || p === "apprunner");
}

export const MICROSERVICE_MIGRATION_FULL_BONUS_POINTS = 5_000;
export const MICROSERVICE_MIGRATION_PROBLEM_ID = "microservice-migration-battle";
export const MICROSERVICE_MIGRATION_SLOTS = ["users", "orders", "catalog"] as const;
export type MicroserviceMigrationSlot = (typeof MICROSERVICE_MIGRATION_SLOTS)[number];
