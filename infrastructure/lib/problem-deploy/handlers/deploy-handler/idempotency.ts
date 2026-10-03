import { createHash } from "node:crypto";
import { StatusCodes } from "http-status-codes";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyPort,
} from "../../control-data/idempotency-repository.js";

/**
 * Issue #3002: `POST /problems/{problemId}/deploy` の `Idempotency-Key` 処理。
 *
 * route から storage の詳細を切り離すための薄い層。 判断はここに閉じ込め、 route 側は
 * 「replay を返す」「実処理へ進む」の 2 択だけを見る。
 *
 * ## 契約 (Stripe 準拠)
 *
 * - ヘッダが無ければ**従来どおり**。 既存クライアントを壊さない。
 * - 同じキーの再送には 1 回目のレスポンスをそのまま返す (成功・失敗を問わない)。
 * - 同じキーで違う本文を送られたら 422。 別のリクエストを同じキーで通すと、
 *   1 回目の結果が 2 回目の答えとして返ってしまうため。
 * - 1 回目がまだ処理中なら 409。 待たせるのではなく「もう一度どうぞ」と返す。
 */

/** 本文のハッシュ。 同じキーに違う内容が来たことを検出するためだけに使う。 */
export function hashRequest(problemId: string, body: unknown): string {
  return createHash("sha256").update(JSON.stringify({ problemId, body })).digest("hex");
}

export type IdempotencyDecision =
  /** ヘッダ無し、または 1 番乗り。 実処理へ進む。 `key` があれば完了時に記録する。 */
  | { readonly kind: "proceed"; readonly key?: string }
  /** そのまま返すべきレスポンス (replay / エラー)。 */
  | { readonly kind: "respond"; readonly status: number; readonly body: unknown };

/** ヘッダの形だけを見る検証。 storage を触る前に弾く。 */
export function validateKey(key: string): string | undefined {
  if (key.length === 0) return "idempotency_key_empty";
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) return "idempotency_key_too_long";
  return undefined;
}

export async function beginIdempotent(args: {
  readonly repository: IdempotencyPort;
  readonly tenantId: string;
  readonly key: string | undefined;
  readonly requestHash: string;
  readonly nowSeconds: number;
}): Promise<IdempotencyDecision> {
  const { repository, tenantId, key, requestHash, nowSeconds } = args;
  if (key === undefined) return { kind: "proceed" };

  const invalid = validateKey(key);
  if (invalid) {
    return { kind: "respond", status: StatusCodes.BAD_REQUEST, body: { error: invalid } };
  }

  const outcome = await repository.reserve({
    tenantId,
    key,
    requestHash,
    expiresAt: nowSeconds + IDEMPOTENCY_TTL_SECONDS,
  });
  if (outcome.kind === "reserved") return { kind: "proceed", key };

  const existing = outcome.existing;
  if (existing.requestHash !== requestHash) {
    // 同じキーで違う内容。 replay すると 1 回目の結果が 2 回目の答えとして返るので、
    // 黙って返さずエラーにする。
    return {
      kind: "respond",
      status: StatusCodes.UNPROCESSABLE_ENTITY,
      body: { error: "idempotency_key_reused" },
    };
  }
  if (existing.responseStatus === undefined) {
    // 1 回目がまだ走っている。 ここで待つと Lambda の実行時間を二重に使うので、
    // 「処理中」を明示して再送を促す。
    return {
      kind: "respond",
      status: StatusCodes.CONFLICT,
      body: { error: "idempotency_request_in_progress" },
    };
  }
  return {
    kind: "respond",
    status: existing.responseStatus,
    body: parseStoredBody(existing.responseBody),
  };
}

/** 実処理の結果を記録する。 記録に失敗しても本来のレスポンスは返す (下記参照)。 */
export async function finishIdempotent(args: {
  readonly repository: IdempotencyPort;
  readonly tenantId: string;
  readonly key: string | undefined;
  readonly status: number;
  readonly body: unknown;
}): Promise<void> {
  const { repository, tenantId, key, status, body } = args;
  if (key === undefined) return;
  try {
    await repository.complete(tenantId, key, status, JSON.stringify(body));
  } catch (err) {
    // ここで throw すると、 **deploy は成功しているのにクライアントへエラーを返す**ことに
    // なり、 相手はもう一度送る。 それは記録漏れよりはるかに悪い。 記録できなかった場合、
    // 次の再送は「処理中」(409) として扱われ、 TTL 後に通常のリクエストへ戻る。
    console.error("[deploy] idempotency record failed", {
      tenantId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseStoredBody(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // 保存済みの本文が壊れている場合。 でっち上げた成功を返すより、 壊れていることを言う。
    return { error: "idempotency_replay_unavailable" };
  }
}
