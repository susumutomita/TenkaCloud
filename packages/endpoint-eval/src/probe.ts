/**
 * Issue #1973: 1 つの宣言的 HTTP チェック (probe) を、 ガード済みの参加者エンドポイントに対して
 * 安全に実行する。 probe は **データ** (= 問題側が宣言) であり engine は問題を知らない。
 *
 * 安全策 (issue「URL受理・SSRF対策」より):
 *   - リダイレクトは追従しない (`redirect: "manual"`)
 *   - 接続/読み取りタイムアウトを短く (AbortController)
 *   - レスポンス本文サイズに上限 (cap を超えたら打ち切って fail)
 *
 * 返す `detail` は採点ロジックを漏らさない安全な要約に限る (= 参加者画面にそのまま出せる)。
 */

export interface ProbeRequest {
  readonly method: string;
  /** `/profiles/{victimId}` のように `{key}` プレースホルダを含められる (run 値で置換)。 */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface ProbeExpectation {
  /** 期待ステータス。 単一または許容集合。 未指定ならステータスは判定しない。 */
  readonly status?: number | readonly number[];
  /** 本文に必ず含むべき文字列。 */
  readonly bodyIncludes?: readonly string[];
  /** 本文に含んではならない文字列 (例: 内部例外 / 秘密値 / デバッグ情報)。 */
  readonly bodyExcludes?: readonly string[];
}

export interface Probe {
  readonly id: string;
  readonly request: ProbeRequest;
  readonly expect: ProbeExpectation;
  /** 参加者に返してよい安全な説明 (何を確認したかの粒度。 期待値そのものは書かない)。 */
  readonly description: string;
}

export interface ProbeContext {
  /** 注入された fetch (テストでは fake、 本番では global fetch)。 */
  readonly fetchFn: typeof fetch;
  /** run ごとの置換値 (`{key}` → value)。 */
  readonly values: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

export interface ProbeOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly description: string;
  /** 安全な要約 (採点ロジック非開示)。 */
  readonly detail: string;
}

/** `{key}` を values で置換する。 未知の key はそのまま残す。 */
export function applyTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? values[key] : whole,
  );
}

/** response.body を上限まで読み、 上限超過なら truncated=true で打ち切る。 */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(Buffer.from(result.value));
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

function statusMatches(status: number, expected: ProbeExpectation["status"]): boolean {
  if (expected === undefined) return true;
  return typeof expected === "number" ? status === expected : expected.includes(status);
}

const pass = (probe: Probe): ProbeOutcome => ({
  id: probe.id,
  passed: true,
  description: probe.description,
  detail: "OK",
});
const failOutcome = (probe: Probe, detail: string): ProbeOutcome => ({
  id: probe.id,
  passed: false,
  description: probe.description,
  detail,
});

/** 1 つの probe を実行して合否を返す。 ネットワーク失敗/タイムアウトは安全に fail に倒す。 */
export async function runProbe(
  baseUrl: URL,
  probe: Probe,
  ctx: ProbeContext,
): Promise<ProbeOutcome> {
  const target = new URL(applyTemplate(probe.request.path, ctx.values), baseUrl);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(probe.request.headers ?? {})) {
    headers[k] = applyTemplate(v, ctx.values);
  }
  const body =
    probe.request.body === undefined ? undefined : applyTemplate(probe.request.body, ctx.values);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  let res: Response;
  try {
    res = await ctx.fetchFn(target, {
      method: probe.request.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    return failOutcome(probe, "エンドポイントに到達できませんでした (タイムアウト/接続エラー)");
  } finally {
    clearTimeout(timer);
  }

  if (!statusMatches(res.status, probe.expect.status)) {
    return failOutcome(probe, `期待しないステータス (${res.status}) が返りました`);
  }

  const { text, truncated } = await readCapped(res, ctx.maxBodyBytes);
  if (truncated) {
    return failOutcome(probe, "レスポンス本文が大きすぎます (上限超過)");
  }
  // 期待文字列も run 値で置換する (= 期待が run ごとに変わる probe を書ける)。
  for (const needle of probe.expect.bodyIncludes ?? []) {
    if (!text.includes(applyTemplate(needle, ctx.values))) {
      return failOutcome(probe, "レスポンス本文が期待と一致しません");
    }
  }
  for (const banned of probe.expect.bodyExcludes ?? []) {
    if (text.includes(applyTemplate(banned, ctx.values))) {
      return failOutcome(probe, "レスポンス本文に出してはいけない情報が含まれています");
    }
  }
  return pass(probe);
}
