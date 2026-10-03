/**
 * `BATTLE_PROBLEMS_CATALOG` env (JSON `{problemId: problemDir}`) を decode する。
 *
 * Issue #1308: 配線は #1158 と同じく esbuild `bundling.define` で build 時 literal 置換
 * される (= Lambda env からは取り除かれている)。 handler は `process.env.BATTLE_PROBLEMS_CATALOG`
 * 読み取りのまま動く (= build 後に literal JSON 文字列が固定)。 vitest は `process.env.X = ...`
 * 注入で fixture を渡すので test 経路でも変わらず動く。
 *
 * Lambda cold start で 1 回だけ評価される想定 (deploy-handler / event-handler の
 * shared resource 構築時)。不正な JSON / shape は drop し warn log を出す
 * (operator が CloudWatch で気づける)。
 */
export function parseProblemsCatalog(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[parseProblemsCatalog] BATTLE_PROBLEMS_CATALOG parse failed (${(err as Error).message}). ` +
        "deploy paths will reject all problemId.",
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const catalog: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") catalog[k] = v;
  }
  return catalog;
}
