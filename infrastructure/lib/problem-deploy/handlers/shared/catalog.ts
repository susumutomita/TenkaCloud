/**
 * `BATTLE_PROBLEMS_CATALOG` env (JSON `{problemId: problemDir}`) を decode する。
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
