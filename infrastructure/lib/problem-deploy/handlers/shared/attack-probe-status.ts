import type {
  AttackProbeOutcome,
  AttackProbeResult,
  AttackProbeStatus,
} from "@tenkacloud/portal-contracts";

/**
 * [Issue #2422] uptime-multi の attack-probe 結果を「直近サイクルの snapshot」として Deployments
 * 行 (`attackProbes` 属性) に JSON 文字列で保存し、 participant portal が読み出す共通経路。
 *
 * 設計判断 (endpoints-health.ts と同型): scoring engine が書き、 participant-handler が読む
 * 「1 サイクル分の per-probe 結果」。 raw の score event 履歴 (attack-detected 行) とは別に、
 * 「今このサイクルで何が刺さっているか」 を defender に見せるための最新値スナップショット。
 *
 * 非スポイラー不変条件 (AGENTS.md): snapshot には probe の slot / path
 * (= 正確な endpoint)・脆弱性クラスを **絶対に含めない**。 出せるのは問題側 metadata が
 * 明示した `label` / `symptom` と `outcome` / `penalty` のみ。 wire 型 (`AttackProbeStatus`)
 * を DDB 側と共有し、 shape ドリフトを typecheck で検出する。
 */

const OUTCOMES: ReadonlySet<AttackProbeOutcome> = new Set<AttackProbeOutcome>([
  "landed",
  "blocked",
  "skipped",
]);

/** snapshot 1 件を wire 型に narrow する。 不正 (非 object / outcome 不正 / penalty 非数) は drop。 */
function parseProbeResult(value: unknown): AttackProbeResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as {
    label?: unknown;
    symptom?: unknown;
    outcome?: unknown;
    penalty?: unknown;
  };
  if (typeof p.outcome !== "string" || !OUTCOMES.has(p.outcome as AttackProbeOutcome)) {
    return undefined;
  }
  if (typeof p.penalty !== "number" || !Number.isFinite(p.penalty)) return undefined;
  return {
    outcome: p.outcome as AttackProbeOutcome,
    penalty: p.penalty,
    ...(typeof p.label === "string" && p.label.length > 0 ? { label: p.label } : {}),
    ...(typeof p.symptom === "string" && p.symptom.length > 0 ? { symptom: p.symptom } : {}),
  };
}

/**
 * DDB の `attackProbes` JSON 文字列を `AttackProbeStatus` に展開する。
 * 壊れた JSON / 非 object / probes 空 / 全 entry 不正 のときは undefined を返し、 portal は
 * attack-probe セクションを描画しない (= 旧 deployment 行との後方互換)。
 */
export function parseAttackProbeStatus(raw: string | undefined): AttackProbeStatus | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as { checkedAt?: unknown; probes?: unknown };
  if (!Array.isArray(obj.probes)) return undefined;
  const probes = obj.probes
    .map(parseProbeResult)
    .filter((p): p is AttackProbeResult => p !== undefined);
  if (probes.length === 0) return undefined;
  return {
    probes,
    ...(typeof obj.checkedAt === "string" && obj.checkedAt.length > 0
      ? { checkedAt: obj.checkedAt }
      : {}),
  };
}

/** `AttackProbeStatus` を DDB 保存用の compact JSON 文字列にする (= scoring engine 書き込み側)。 */
export function serializeAttackProbeStatus(status: AttackProbeStatus): string {
  return JSON.stringify(status);
}
