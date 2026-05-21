/**
 * ADR-008 Phase 3 (Issue #642): private 問題 visibility env のパーサと判定。
 *
 * BATTLE_PROBLEMS_VISIBILITY env (= `{problemId: "private"}` JSON) を decode し、
 * CHALLENGE_PAYLOAD_BUCKET env と組み合わせて S3 presigned URL を発行すべきか判定する。
 * いずれかが空なら従来の local-path 経路で動作 (= dormant default)。
 */

export const PROBLEM_VISIBILITY_PRIVATE = "private" as const;
export type PrivateVisibility = typeof PROBLEM_VISIBILITY_PRIVATE;

export function parseProblemsVisibility(
  raw: string | undefined,
): Record<string, PrivateVisibility> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[parseProblemsVisibility] BATTLE_PROBLEMS_VISIBILITY parse failed (${(err as Error).message}). ` +
        "all problems will be treated as public.",
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const visibility: Record<string, PrivateVisibility> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === PROBLEM_VISIBILITY_PRIVATE) visibility[k] = PROBLEM_VISIBILITY_PRIVATE;
  }
  return visibility;
}

/**
 * ADR-003 Phase 4a (problem catalog split): bucketName が set されていれば、 problemId の
 * visibility に関わらず S3 経路を使う。 旧挙動 (= private 問題だけ S3、 public は source.zip
 * 同梱) は repo split 前の transition 用で、 split 完了後は全問題が ChallengePayloadStack
 * + TenkaCloudChallenge repo の publish workflow で S3 に publish される設計。
 *
 * `visibility` 引数 / `parseProblemsVisibility` 自体は metadata catalog で
 * `private` 表示用に保持 (= operator UI / admin console で「答え非公開」マーカーを出す)。
 * deploy 経路 (= CHALLENGE_PAYLOAD_URL の発行可否) では visibility は参照しない。
 */
export function resolveChallengePayloadBucket(args: {
  readonly problemId: string;
  readonly bucketName: string | undefined;
}): string | undefined {
  if (!args.bucketName) return undefined;
  return args.bucketName;
}
