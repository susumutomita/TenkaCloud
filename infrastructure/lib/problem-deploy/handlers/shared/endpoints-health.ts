/**
 * uptime 採点で endpoint ごとに記録するヘルス情報。`since` は ok=false が連続している
 * 開始時刻 (= 攻撃検知時刻 / Battle 防御側の復旧優先度判断のフィールド)。
 *
 * Frontend (`apps/participant-portal/src/api/portal-client.ts`) に同 shape の
 * `EndpointHealth` インターフェースあり、両者は意味的に同一にする (apps 横断の shared
 * package が無いための duplication)。
 */
export interface EndpointHealth {
  ok: boolean;
  checkedAt: string;
  /** ok=false のとき現状態が始まった時刻。ok=true なら省略。 */
  since?: string;
}

/**
 * DDB の `endpointsHealth` JSON 文字列を `Record<outputKey, EndpointHealth>` に展開。
 * 壊れた JSON / 非 object / 不正 entry は drop し、UI / handler を best-effort で
 * 落とさない。`{}` を返すので caller 側で `Object.keys().length > 0 ? ... : undefined`
 * の coercion を選択できる。
 */
export function parseEndpointsHealth(raw: string | undefined): Record<string, EndpointHealth> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, EndpointHealth> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as { ok?: unknown; checkedAt?: unknown; since?: unknown };
    if (typeof e.ok !== "boolean" || typeof e.checkedAt !== "string") continue;
    out[k] = {
      ok: e.ok,
      checkedAt: e.checkedAt,
      since: typeof e.since === "string" ? e.since : undefined,
    };
  }
  return out;
}

/**
 * `since` の遷移ルール:
 *   - ok=true               → undefined
 *   - ok=false (新規)       → now
 *   - ok=false (継続中)     → 前回の since を保持
 */
export function computeSince(
  ok: boolean,
  prev: EndpointHealth | undefined,
  now: string,
): string | undefined {
  if (ok) return undefined;
  if (prev && !prev.ok && prev.since) return prev.since;
  return now;
}
