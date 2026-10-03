/**
 * Issue #642: private 問題 visibility env のパーサと判定。
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
 * private 問題 + bucket 両方揃ったとき bucket 名を返す。 dormant なら undefined。
 * 呼び出し側で truthy check 1 つで分岐できる + 型が narrow される。
 */
export function resolveChallengePayloadBucket(args: {
  readonly problemId: string;
  readonly visibility: Readonly<Record<string, PrivateVisibility>> | undefined;
  readonly bucketName: string | undefined;
}): string | undefined {
  if (!args.bucketName) return undefined;
  if (args.visibility?.[args.problemId] !== PROBLEM_VISIBILITY_PRIVATE) return undefined;
  return args.bucketName;
}
