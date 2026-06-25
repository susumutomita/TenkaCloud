/**
 * DDB に保存された JSON 文字列を `Record<string,string>` に戻す。次の 2 形式を許容する:
 *
 *   1. `{key: value}` map 形式
 *   2. `[{OutputKey, OutputValue}, ...]` array — Step Functions の
 *      `cloudformation:describeStacks` task が `States.JsonToString` で書き込む CFn 生形式
 *
 * Frontend (`apps/application-admin-console/src/api/deploy-client.ts`) に同じ関数の
 * sister 実装あり。両者は意味的に同一にする。
 *
 * 壊れた JSON / 非 object / array 内の不正 entry は無視 (best-effort)。
 */
export function parseStackOutputs(json: string | undefined): Record<string, string> {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  return Array.isArray(parsed) ? parseStackOutputArray(parsed) : parseStackOutputMap(parsed);
}

function parseStackOutputArray(parsed: readonly unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const k = (entry as { OutputKey?: unknown }).OutputKey;
    const v = (entry as { OutputValue?: unknown }).OutputValue;
    if (typeof k === "string" && typeof v === "string") out[k] = v;
  }
  return out;
}

function parseStackOutputMap(parsed: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
