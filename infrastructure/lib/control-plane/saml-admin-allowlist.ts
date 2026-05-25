import { Duration } from "aws-cdk-lib";
import { type UserPool, UserPoolOperation } from "aws-cdk-lib/aws-cognito";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/**
 * Issue #1335 Phase 1: System Admin (Control Plane) 側 federated 管理者 allowlist。
 *
 * 背景: SBT ControlPlane の API 認可は JWT issuer + audience 検証のみ (`setAPIGWScopes: false`、
 * see control-plane-stack.ts)。 SAML IdP を attach すると 「その IdP で sign-in できる人 =
 * 全 tenant 横断 SystemAdmin」 となり、 IdP テナント内の無関係な全社員まで管理者権限を得る。
 * これを塞ぐため、 **federated sign-in は明示 allowlist のものだけ許可** し、 それ以外は
 * Pre sign-up Lambda で拒否する (fail-safe: 空配列 = federated sign-in 全拒否)。
 *
 * 重要: 同一ドメインに複数 IdP を attach する設計 (saml-identity-providers.ts 参照)。 allowlist を
 * メールだけで突き合わせると、 別 IdP (例: 部門が立てた Okta) が allowlist 済みメールを
 * assertion で詐称するだけで管理者になれる (= provider 跨ぎの信頼プール化)。 これを防ぐため
 * allowlist は **`provider/email` の対** で持ち、 (1) assertion の email 一致 に加えて (2)
 * federation が **その provider 経由** (Cognito federated username `{provider}_{subject}` の
 * prefix) であることの両方を要求する。
 *
 * 既知の残存リスク (運用で担保):
 *   (a) email を当該 provider が正しく assert することを信頼する標準 SAML 信頼モデル。
 *       provider 自体が侵害された場合は別問題。
 *   (b) Pre sign-up は federated アカウント初回作成時のみ発火するため、 allowlist から削除
 *       しても既存 Cognito user は残る (= revocation flow は AdminDeleteUser、 docs 参照)。
 *   (c) `AdminLinkProviderForUser` で SAML identity を既存 user に link すると Pre sign-up
 *       を経由しない。 Control Plane では SAML identity を手動 link しないこと。
 */

// provider 束縛は federated username `{provider}_{subject}` の prefix 一致で判定するため、
// ある provider 名が別 provider 名の `_` 区切り prefix になっていると誤マッチしうる
// (例: `corp` と `corp_evil`)。 provider 登録は operator (env-driven) なので攻撃者には到達
// 不能だが、 命名は `_` 区切り prefix 衝突を避け `-` 区切りを推奨する。
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;
// ざっくり email 形 (local@domain.tld、 空白・@・/ を含まない)。 厳密 RFC ではないが
// `@` だけ・空 part 等の明らかな誤りを fail-loud で弾く。 突き合わせは完全一致。
const EMAIL_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

/**
 * `CONTROL_PLANE_SAML_ADMIN_ALLOWLIST` env を parse する。
 * - 各エントリは **`provider/email`** 形式 (例 `corp-entra/admin@example.com`)。
 * - JSON 配列 (`["corp-entra/a@example.com"]`) かカンマ区切りのどちらでも可。
 * - provider / email を検証し、 小文字化・trim・重複排除。 形が不正なら fail-loud で throw。
 * - 未設定 / 空なら空配列。 **空配列 = federated sign-in 全拒否** (fail-safe)。
 *
 * 返り値は正規化済みの `provider/email` 文字列 (小文字)。
 */
function tokenizeAllowlistRaw(trimmed: string, envVarName: string): string[] {
  if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return trimmed.split(",");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${envVarName} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${envVarName} JSON must be an array of \`provider/email\` strings`);
  }
  return parsed.map((e) => String(e));
}

function normalizeAllowlistEntry(entry: string, envVarName: string): string | undefined {
  const raw = entry.trim();
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash < 0) {
    throw new Error(`${envVarName} entry must be 'provider/email': ${entry}`);
  }
  const provider = raw.slice(0, slash).trim().toLowerCase();
  const email = raw
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  if (!PROVIDER_RE.test(provider)) {
    throw new Error(`${envVarName} provider name is invalid: ${entry}`);
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error(`${envVarName} email is invalid: ${entry}`);
  }
  return `${provider}/${email}`;
}

export function parseAdminAllowlist(
  raw: string | undefined,
  envVarName = "CONTROL_PLANE_SAML_ADMIN_ALLOWLIST",
): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const entries = tokenizeAllowlistRaw(raw.trim(), envVarName);
  const out: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeAllowlistEntry(entry, envVarName);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

// Pre sign-up Lambda 本体 (inline, 依存なし)。 federated (外部 IdP) 初回 sign-in 時のみ
// 発火し、 allowlist の `provider/email` を強制する: assertion の email が allowlist の
// email と一致し、 かつ Cognito federated username (`{provider}_{subject}`) がその
// allowlist エントリの provider で始まること。 両方満たすときだけ許可、 それ以外は throw で
// account 作成を拒否する。 AdminCreateUser (SBT が systemAdmin を作る経路) や通常 sign-up
// は素通しする。
//
// export しているのはテストが 「実際にデプロイされる文字列」 を sandbox 評価して挙動を
// 検証するため (= ロジックの二重定義による drift を避ける、 ProtoShip と同方針)。
export const PRE_SIGNUP_HANDLER = `"use strict";
var ALLOW = (process.env.ADMIN_ALLOWLIST || "")
  .split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean)
  .map(function (e) { var i = e.indexOf("/"); return { provider: e.slice(0, i), email: e.slice(i + 1) }; });
exports.handler = async function (event) {
  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    var attrs = (event.request && event.request.userAttributes) || {};
    var email = String(attrs.email || "").trim().toLowerCase();
    var userName = String(event.userName || "").toLowerCase();
    var ok = !!email && ALLOW.some(function (a) {
      return a.email === email && userName.indexOf(a.provider + "_") === 0;
    });
    if (!ok) {
      throw new Error("This federated identity is not authorized to access the admin console.");
    }
  }
  return event;
};
`;

/**
 * 管理画面 UserPool に federated 管理者 allowlist の Pre sign-up trigger を attach する。
 * SAML が有効なときだけ呼ぶこと (= 無効時は federation 経路が無いので不要)。
 * `allowlist` が空でも attach する — 空配列 = federated sign-in 全拒否 (= SAML を誤って
 * 有効化したのに allowlist 未設定、 という構成事故で 「誰でも管理者」 になるのを防ぐ)。
 */
export function attachFederatedAdminAllowlist(
  scope: Construct,
  userPool: UserPool,
  allowlist: readonly string[],
): void {
  const guard = new LambdaFunction(scope, "FederatedAdminAllowlistGuard", {
    runtime: Runtime.NODEJS_20_X,
    handler: "index.handler",
    timeout: Duration.seconds(5),
    memorySize: 128,
    code: Code.fromInline(PRE_SIGNUP_HANDLER),
    environment: {
      // `provider/email` のカンマ連結。 秘匿値ではない (管理者メール = 構成情報)。
      ADMIN_ALLOWLIST: allowlist.join(","),
    },
  });
  userPool.addTrigger(UserPoolOperation.PRE_SIGN_UP, guard);
}
