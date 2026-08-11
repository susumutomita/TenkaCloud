/**
 * Issue #1340 Phase 2: per-tenant SP-initiated SAML SSO の Home Realm Discovery (HRD) 解決ロジック。
 *
 * Phase 1 (admin-console) で実装した HRD pure-function を application-admin-console (= L2 /
 * Tenant Admin Console) にも移植する。 同一 email ドメインに複数 IdP が並立しうるため、
 * domain → 単一 IdP の自動振り分けは破綻する。 本モジュールは email から **IdP 候補集合** を
 * 引き、 候補数で挙動を分ける純粋関数を提供する:
 *   - 0 件: Cognito local auth (or 拒否) にフォールバック
 *   - 1 件: その IdP へ自動 redirect
 *   - 複数: IdP 選択画面を出す (「Entra でログイン / Okta でログイン」)
 *
 * 解決した provider は Cognito の `/oauth2/authorize?identity_provider=<provider>` に渡し、
 * managed login の email-domain lookup を bypass して特定 IdP に飛ばす (AWS 公式の方式)。
 *
 * directory (domain → provider[]) の供給元 (= per-tenant runtime-config.json) は本モジュールの
 * 関心外 — 注入された directory に対する決定だけを行う。 tenant A の Login 画面は自分の
 * CloudFront に置かれた runtime-config.json しか読まないため、 tenant B の directory を覗くことは
 * できない。これは tenant ごとに IdP directory を物理的に分離する境界と整合する。
 *
 * Phase 1 (admin-console) の同名 module と挙動は完全に同一。 両 SPA で実装を共有しない理由は
 * cross-SPA 依存 (= packages/auth-client) を増やさず、 monorepo の app boundary を明確に
 * 保つため。 機能 drift を避けるため両側を等しくテストする。
 */

/** email ドメイン → 接続済み SAML provider 名の配列。 */
export type IdpDirectory = Record<string, readonly string[]>;

export type IdpResolution =
  | { readonly kind: "local" }
  | { readonly kind: "redirect"; readonly provider: string }
  | { readonly kind: "select"; readonly providers: readonly string[] };

/**
 * directory 全体に含まれる distinct な provider 名一覧。 Login の出し分けに使う:
 *   - 0 件 = SSO 未設定 → email を聞かず直接 local サインイン (= 既存挙動互換)
 *   - 1 件 = 単一 IdP → その IdP へ直接リダイレクト (振り分け不要)
 *   - 複数 = email で振り分け (HRD) が初めて必要
 */
export function distinctProviders(directory: IdpDirectory): string[] {
  const set = new Set<string>();
  for (const list of Object.values(directory)) {
    for (const p of list) {
      const t = p.trim();
      if (t) set.add(t);
    }
  }
  return [...set];
}

/**
 * email から小文字化したドメイン部を取り出す。 `@` を含まない / ドメインが空なら undefined。
 */
export function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 ? domain : undefined;
}

/**
 * email と IdP directory から HRD の決定を返す。
 * directory のキーは小文字ドメイン前提 (email 側も小文字化して照合)。
 */
export function resolveIdp(email: string, directory: IdpDirectory): IdpResolution {
  const domain = emailDomain(email);
  if (!domain) return { kind: "local" };

  const raw = directory[domain] ?? [];
  // 空文字・重複を除いた候補集合
  const providers = Array.from(new Set(raw.map((p) => p.trim()).filter((p) => p.length > 0)));

  if (providers.length === 0) return { kind: "local" };
  if (providers.length === 1) return { kind: "redirect", provider: providers[0] as string };
  return { kind: "select", providers };
}
