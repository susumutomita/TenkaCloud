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
      "Role 名の入力が間違っている (= モーダルが提案する `TenkaCloud-{tenantId}-deploy-Role` 形式と一致するか確認)",
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
  // Issue #705: SSO Credentials の 4 分岐
  role_arn_missing: {
    title: "ConsoleViewerRole が設定されていません",
    hint: "Lambda 環境変数 CONSOLE_VIEWER_ROLE_ARN が未設定です (= 通常は CDK deploy で自動注入)",
    possibleCauses: [
      "ProblemDeployBackendStack の participantPortal flag が false で deploy された",
      "Lambda env が手動で削除された (= CFn drift)",
    ],
  },
  federation_endpoint_failed: {
    title: "AWS Federation endpoint がエラーを返しました",
    hint: "signin.aws.amazon.com の getSigninToken が non-200 status を返しました",
    possibleCauses: [
      "AWS 側 federation service の一時的な障害",
      "Session JSON のサイズ超過 (= 通常起こらない)",
    ],
  },
  federation_token_malformed: {
    title: "AWS Federation token の response 形式が不正です",
    hint: "AWS 側 spec 変更の可能性 (= AWS support 確認推奨)",
  },
  // Issue #948: route 単位 granular role gate で返す
  forbidden_role: {
    title: "この操作にはより高い tenant role が必要です",
    hint: "あなたの role では実行できません。 TenantAdmin に依頼してください",
    possibleCauses: [
      "TenantViewer / TenantOperator として招待されている (= destructive 操作は TenantAdmin のみ)",
      "招待後に role が変更されたが、 token が古いまま (= 再ログインで token を更新)",
    ],
  },
  // Issue #17: 自分自身の role 変更を禁止 (= lock-out 防止)
  cannot_change_own_role: {
    title: "自分自身の role は変更できません",
    hint: "lock-out 防止のため、 自分の role 変更は別の TenantAdmin に依頼してください",
  },
  // Issue #925 Phase 1: 自分自身の削除を禁止
  cannot_delete_self: {
    title: "自分自身は削除できません",
    hint: "lock-out 防止のため、 自分自身は削除できません。 別の管理者に依頼してください",
  },
  // Issue #950: admin audit 監査ログ table 未配線
  audit_log_unconfigured: {
    title: "監査ログ Table が未配線です",
    hint: "AdminInsight stack に AdminAuditLog Table が deploy されていません",
    possibleCauses: [
      "Phase 2 deploy が未完了 (= make deploy 実行が必要)",
      "古い stack 世代から upgrade していない (= deploy chain の更新で解消)",
    ],
  },
  // Issue #949: ControlPlane UserPool 未配線
  control_plane_user_pool_unconfigured: {
    title: "ControlPlane UserPool が未配線です",
    hint: "AdminInsight stack に ControlPlane の UserPool ID が渡されていません",
    possibleCauses: [
      "Phase 2 deploy が未完了 (= make deploy 実行が必要)",
      "古い stack 世代から upgrade していない",
    ],
  },
  // 既存 + 新規 ともに duplicate
  duplicate_user: {
    title: "同 email の user が既に存在します",
    hint: "別の email address を指定するか、 既存 user の role を変更してください",
  },
  // tenant_mismatch (server は 404 not_found に隠蔽するが log で識別)
  missing_tenant_claim: {
    title: "tenant 識別子が JWT にありません",
    hint: "再ログインして token を更新してください (= tenant 招待 email を経由)",
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
    // body は "{" 始まりに限定済 (上の guard) なので parse 成功時は必ず object。
    // 非 object 分岐は到達不能な防御 guard。
    /* v8 ignore next */
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as BackendErrorEnvelope;
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
function fromBackendEnvelope(status: number, envelope: BackendErrorEnvelope): FriendlyError {
  const code = extractErrorCode(envelope);
  if (code && KNOWN_ERRORS[code]) return KNOWN_ERRORS[code];
  const msg = typeof envelope.message === "string" ? envelope.message : undefined;
  const codeOrMsg = code ?? msg;
  return {
    title: codeOrMsg ? `エラー (${status}) — ${codeOrMsg}` : `エラー (${status})`,
    hint: code && msg ? msg : undefined,
  };
}

function fromApiError(err: ApiError): FriendlyError {
  const envelope = extractBackendEnvelope(err.message);
  if (envelope) return fromBackendEnvelope(err.status, envelope);
  return {
    title: `エラー (${err.status})`,
    hint: err.message.replace(/^API \d+:\s*/, "").trim() || undefined,
  };
}

export function toFriendlyError(err: unknown): FriendlyError {
  if (err instanceof ApiError) return fromApiError(err);
  if (err instanceof Error) return { title: err.message };
  return { title: String(err) };
}
