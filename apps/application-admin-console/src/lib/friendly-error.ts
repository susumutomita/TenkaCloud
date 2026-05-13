import { ApiError } from "../api/client";

/**
 * Issue #665: backend が返す `{ error: <code>, ... }` JSON を 人間可読に変換する helper。
 *
 * 旧来 `${err.status}: API ${status}: { "error": "assume_role_failed", ... }` のような
 * 二重 prefix + raw JSON が UI に出ていた。本 module は ApiError のメッセージから
 * error code を取り出し、 専用 mapping から日本語 message + 原因候補を返す。
 *
 * 既知の code が無い場合は、 raw JSON を読みやすい形に整形した generic fallback を返す。
 */

export interface FriendlyError {
  readonly title: string;
  readonly hint?: string;
  readonly possibleCauses?: readonly string[];
}

interface BackendErrorEnvelope {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly underlyingErrorName?: unknown;
  readonly detail?: unknown;
}

const ASSUME_ROLE_FAILED: FriendlyError = {
  title: "AssumeRole に失敗しました (AccessDenied)",
  hint: "TenkaCloud 側から競技者 account への STS AssumeRole が AWS に拒否されました",
  possibleCauses: [
    "ExternalId 値が異なる (rotate 後の伝達漏れの可能性)",
    "Role 名が異なる (= 競技者が default 以外を選んだ)",
    "competitor-bootstrap.yaml が deploy 未完了 / 削除済",
    "Trust policy の Principal が TenkaCloud account ID と一致しない",
  ],
};

const KNOWN_ERRORS: Readonly<Record<string, FriendlyError>> = {
  assume_role_failed: ASSUME_ROLE_FAILED,
  role_not_found: {
    title: "競技者アカウントの IAM Role が見つかりません",
    hint: "指定した Role 名が、 競技者の AWS account に存在しません",
    possibleCauses: [
      "competitor-bootstrap.yaml が deploy されていない",
      "Role 名の入力が間違っている (= default `TenkaCloud-CompetitorDeploy-Role` か確認)",
      "競技者が手動で Role を削除した",
    ],
  },
  external_id_mismatch: {
    title: "ExternalId の照合に失敗しました",
    hint: "TenkaCloud が送信した ExternalId と、 競技者 Role の Trust policy が一致しません",
    possibleCauses: [
      "Rotate ExternalId 後、 競技者が新しい値で stack を update していない",
      "管理者画面に表示された ExternalId を競技者にコピー漏れ",
    ],
  },
  invalid_account_id: {
    title: "AWS Account ID の形式が不正です",
    hint: "12 桁の数値である必要があります",
  },
  duplicate_account: {
    title: "この AWS Account ID は既に登録済です",
    hint: "重複する Competitor Account は登録できません",
  },
  not_found: {
    title: "対象が見つかりません",
    hint: "他の operator が削除した可能性があります。 一覧を再読み込みしてください",
  },
};

/**
 * `{ "error": "assume_role_failed", "underlyingErrorName": "AccessDenied" }` のような
 * backend response の raw body から error code を抽出する。
 *
 * ApiError.message は `"API 422: <raw body>"` 形式なので、 まず raw body を切り出してから
 * JSON.parse を試みる。parse 失敗時は undefined を返し caller 側で fallback する。
 */
function extractBackendEnvelope(rawMessage: string): BackendErrorEnvelope | null {
  let body = rawMessage;
  while (true) {
    const m = body.match(/^API \d+:\s*(.*)$/s);
    if (!m) break;
    body = m[1];
  }
  if (!body.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as BackendErrorEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

function extractErrorCode(envelope: BackendErrorEnvelope): string | null {
  const code = envelope.error;
  return typeof code === "string" ? code : null;
}

/**
 * `ApiError` や Error / unknown を `FriendlyError` に変換する。
 *
 * - 既知の backend error code は専用 mapping を返す
 * - 未知の code でも、 raw JSON は drop して title だけ表示
 * - HTTP status code は title に併記 (= 422 / 500 / 等を operator が判別可能に)
 */
export function toFriendlyError(err: unknown): FriendlyError {
  if (err instanceof ApiError) {
    const envelope = extractBackendEnvelope(err.message);
    if (envelope) {
      const code = extractErrorCode(envelope);
      if (code && KNOWN_ERRORS[code]) {
        return KNOWN_ERRORS[code];
      }
      // title に code (or message) を併記、 hint には message が code と異なる時のみ詰める
      // (= title と hint で同じ文字列を表示しないため)。
      const msg = typeof envelope.message === "string" ? envelope.message : undefined;
      const codeOrMsg = code ?? msg;
      return {
        title: codeOrMsg ? `エラー (${err.status}) — ${codeOrMsg}` : `エラー (${err.status})`,
        hint: code && msg ? msg : undefined,
      };
    }
    return {
      title: `エラー (${err.status})`,
      hint: err.message.replace(/^API \d+:\s*/, "").trim() || undefined,
    };
  }
  if (err instanceof Error) {
    return { title: err.message };
  }
  return { title: String(err) };
}
