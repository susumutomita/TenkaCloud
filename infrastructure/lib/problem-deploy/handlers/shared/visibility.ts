/**
 * ADR-008 Phase 3 (Issue #642): `BATTLE_PROBLEMS_VISIBILITY` env を decode する。
 *
 * 形は `{problemId: "private"}` のみ (= private 問題だけを enumerate、 public は default)。
 * CDK synth 時に `discoverProblemsVisibility` で生成され、 Lambda env として渡る。
 * Lambda cold start で 1 回だけ評価される想定。
 *
 * 未設定 / parse 失敗時は空 map を返す (= 全 problem を public 扱い = local-path 経路で動作)。
 * これは "infra 配線が landed 前は dormant" の動作を担保するための fail-safe。
 */
export function parseProblemsVisibility(raw: string | undefined): Record<string, "private"> {
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
  const visibility: Record<string, "private"> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === "private") visibility[k] = "private";
  }
  return visibility;
}

/**
 * `metadata.visibility === "private"` かつ S3 bucket env が bind されているときだけ
 * presigned URL を発行すべきか判定。 両方揃わなければ false (= 既存 local-path 経路)。
 */
export function shouldGeneratePresignedUrl(args: {
  readonly problemId: string;
  readonly visibility: Readonly<Record<string, "private">>;
  readonly bucketName: string | undefined;
}): boolean {
  if (!args.bucketName) return false;
  return args.visibility[args.problemId] === "private";
}
