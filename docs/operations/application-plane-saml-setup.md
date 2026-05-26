# Application Plane SAML SSO setup (Issue #1340 Phase 2)

Tenant Admin 用 application-admin-console (`apps/application-admin-console`) を、 テナント運営者
組織の IdP (Entra ID / Okta 等) による SAML SSO でサインインできるようにする手順。 **Phase 1**
(Control Plane / Issue #1335) と同じ multi-IdP / provider 束縛 allowlist の仕組みを、
**per-tenant** な Application Plane UserPool に適用する。

> 本書のドメイン・IdP 名はすべて記入例 (`example.com` / `corp-entra` / `corp-okta`)。 実値に
> 置き換えること。

## 全体像

- 各テナントの Application Plane Cognito UserPool に、 環境変数 `TENANT_SAML_IDPS` で宣言した
  IdP 群を SAML provider として attach する。 opt-in で、 未設定なら従来通り Cognito local auth
  と MFA 強制のみ (= Issue #1035 と同じ)。
- どのメールを TenantAdmin として認可するかは `TENANT_SAML_ADMIN_ALLOWLIST` (provider 束縛
  allowlist) で明示する。 **ここに無い federated ユーザーはサインイン不可** (空 = 全拒否の
  fail-safe)。
- サインイン経路は Phase 1 と同じく **SP-initiated** (application-admin-console の Login 画面で
  email 入力 → IdP 解決) と **IdP-initiated** (Entra MyApps / Okta タイル経由) の 2 通り。
- サインイン成功 / 拒否はテナント別の `AdminAuditLogTable` partition (`TENANT#<tenantId>`) に
  `auth.sign_in_succeeded` / `auth.sign_in_denied` として記録される (= CloudTrail / EventBridge
  Lambda 経由)。 Tenant Admin (= `/audit-log` page、 自テナント scope only) で確認できる。

## Pooled 共有 UserPool では SAML を有効化しない (ADR-018)

TenkaCloud の pooled tier (BASIC / STANDARD / PREMIUM) はテナント間で 1 つの Cognito UserPool を
共有するため、 そこに SAML provider を attach すると **他テナントの sign-in にも副作用を及ぼす**
(= 1 IdP の障害がすべてのテナントに伝播する、 allowlist が他テナントを巻き込む等)。

このため Phase 2 は次の 2 経路でだけ SAML attach を許容する。

| 経路 | UserPool | SAML attach |
| --- | --- | --- |
| pooled tier (BASIC / STANDARD / PREMIUM) | 全 pooled tenant 共有 | **しない** (ADR-018) |
| silo tier (PLATINUM) | per-tenant 専用 | する |
| Lite mode (`make deploy`) | 単一 tenant = 1 UserPool | する |

CDK 側は `TenantTemplateStack` が `isPooledDeploy=true` のとき env を受け取っても ignore する
ため、「pooled stack を間違って enterprise IdP に繋いでしまう」構成事故は発生しない (= 物理
的に attach されない)。 PLATINUM へのアップグレード時に SAML を有効化する想定。

## L2 (TenantAdmin) と L3 (競技参加者) の分離

TenkaCloud の Application Plane には 2 種類の Cognito UserPool / 認証経路がある。

| 層 | コンソール | UserPool | この Phase の対象 |
| --- | --- | --- | --- |
| **L2 (TenantAdmin)** | application-admin-console | per-tenant UserPool (本書) | **Yes** |
| **L3 (競技参加者)** | participant-portal | 短命の per-team login key (UserPool 不使用) | **No** |

L3 は per-team login key (= 短命な credential、 個人情報を抱えない設計) で運用される。 これは
「運営者が participant 個人情報の管理義務を抱えない」ための明確な意思決定で、 enterprise IdP
連携の対象外。 SAML SSO は L2 (= 運営者) にだけ適用する。

## 手順 1: IdP 側で TenkaCloud Tenant を SP として登録

IdP に SAML アプリケーションを 1 つ作成し、 以下を設定する。 `<tenant-cognito-domain>` と
`<tenant-user-pool-id>` はデプロイ時に払い出される (= application-admin-console の
`runtime-config.json` の `cognitoDomain` / `TenantTemplateStack` の CFn output
`TenantUserpoolId` で確認できる)。

| 項目 | 値 |
| --- | --- |
| SP エンティティ ID (Audience) | `urn:amazon:cognito:sp:<tenant-user-pool-id>` |
| ACS URL (Reply / Assertion Consumer Service) | `https://<tenant-cognito-domain>/saml2/idpresponse` |
| NameID format | **persistent** (immutable subject) |
| 必須属性マッピング | `email` → `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |

要件は Phase 1 と同じ。

- 有効な署名証明書を持つ metadata を発行できること。
- NameID は **persistent** (`{provider}_{subject}` の subject に使う immutable ID)。
- IdP-initiated を使う場合は IdP 側でタイルを有効化する。

登録後、 IdP の **federation metadata URL** を控える。

## 手順 2: TenkaCloud 側で IdP を宣言する

silo tier テナント (PLATINUM) または Lite mode のデプロイ時に、 環境変数で設定する
(= `infrastructure/environments/<env>/.env`)。

### `TENANT_SAML_IDPS` — attach する IdP 群 (JSON 配列)

```json
[
  { "name": "corp-entra", "metadataUrl": "https://login.example/meta", "emailDomains": ["example.com"] },
  { "name": "corp-okta",  "metadataUrl": "https://okta.example/meta",  "emailDomains": ["example.com"] }
]
```

- `name`: Cognito provider 名 (Phase 1 と同じ命名規約)。
- `metadataUrl`: 手順 1 で控えた IdP の metadata URL (https 必須)。
- `emailDomains`: この IdP で認証するメールドメイン (1 件以上)。 同一ドメイン複数 IdP 可。

未設定 (または空) なら SAML 無効。 pooled tier では値を渡しても **ignore** される (ADR-018)。

### `TENANT_SAML_ADMIN_ALLOWLIST` — TenantAdmin として認可するメール (provider 束縛)

```text
corp-entra/alice@example.com,corp-okta/bob@example.com
```

(JSON 配列形式でも可)

- 各エントリは `provider/email`。「どの IdP 経由で来た、 どのメールを TenantAdmin とみなすか」を
  明示する。
- **空 = federated サインイン全拒否** (fail-safe)。 SAML を有効化したのに allowlist 未設定、 という
  事故で「テナント外の federated user が全員 TenantAdmin」になる構成事故を防ぐ。

> tenant API の JWT authorizer は token issuer + audience を検証し、 さらに handler 側で
> `cognito:groups ⊇ {TenantAdmin}` を再検査する (= Phase 1 の 2 段防御と同じ)。 allowlist は
> 「federated user に Cognito アカウントを払い出す権利」 を絞る位置付けで、 後段の role gate と
> 合わせて全 admin 操作を保護する。

## 手順 3: デプロイと動作確認

1. 上記 env を設定して silo tier テナント (`scripts/provision-tenant.sh`) または Lite mode
   (`make deploy`) を再デプロイする。 Cognito UserPool に SAML provider が attach され、
   per-tenant `runtime-config.json` に `samlIdpDirectory` (ドメイン → provider 名配列) が
   配信される。
2. **SP-initiated**: application-admin-console を開き、 メールを入力する。
   - 候補 1 件: その IdP に自動で飛ぶ。
   - 候補複数 (同一ドメインに Entra + Okta 等): IdP 選択画面が出る。
   - 候補 0 件: Cognito local auth (= 既存 MFA 経路)。
3. **IdP-initiated**: IdP のタイルから入り、 そのままサインインできること。
4. allowlist に無いメールではサインインが拒否されること
   (`This federated identity is not authorized to access the admin console.`)。
5. Tenant Admin の `/audit-log` (= 自テナント scope only) で `auth.sign_in_succeeded` 行が
   増えていること。 `extra.idp` に解決した provider 名または `COGNITO` (local) が入る。

## 失効 (アクセス権の取り消し)

Phase 1 と同様、 2 段階の手順。

1. `TENANT_SAML_ADMIN_ALLOWLIST` から該当 `provider/email` を削除して再デプロイ
   (= 以後の新規 federated サインインは拒否される)。
2. 既存 user は `aws cognito-idp admin-delete-user` で per-tenant UserPool から削除する
   (= 再 federation 時に Pre sign-up を再経由するため、 新 allowlist が効く)。

## テナント isolation の保証

- **frontend**: tenant A の application-admin-console は自分の CloudFront に置かれた
  `/runtime-config.json` しか読まない。 そこには tenant A の `samlIdpDirectory` だけが
  焼かれており、 tenant B の directory は **物理的に見えない**。
- **CDK**: tenant A の `TENANT_SAML_IDPS` は tenant A の `provision-tenant.sh` 実行時のみ
  attach される (CodeBuild env に envFromConfig で渡る)。 同一 env で複数 tenant に供給する
  運用は禁止 (= tenant pipeline で env を tenant 別に注入する)。
- **audit**: tenant A の sign-in events は `TENANT#<tenantA>` partition にのみ書かれる
  (= `AUDIT_TENANT_ID` env で per-tenant Lambda を分離)。 tenant Admin の `/audit-log` は
  JWT 由来 `custom:tenantId` で query を絞るため、 tenant B の行は読めない。

## 監査ログとの連携

per-tenant sign-in audit 行は ADR-020 Phase D / Issue #1292 の audit UI で読める。 Phase 1 の
`SYSTEM#<env>` partition と並列で、 `TENANT#<tenantId>` partition に同形式の行が増える。

- action: `auth.sign_in_succeeded` / `auth.sign_in_denied`
- tenantId: 当該テナント ID (= ULID / Lite mode は `local`)
- actor: Cognito `sub`
- actorUsername: email / federated username
- extra.idp: 解決した provider 名 (= `corp-entra` 等) または `COGNITO`

## 関連

- `infrastructure/lib/tenant-template/saml-identity-providers.ts` — SAML attach 本体 (Phase 1 の wrapper)
- `infrastructure/lib/tenant-template/saml-admin-allowlist.ts` — provider 束縛 allowlist
- `infrastructure/lib/control-plane/sign-in-audit-lambda.ts` — CloudTrail / EventBridge Lambda
  (Phase 2 で per-tenant 配線、 `AUDIT_TENANT_ID` env で partition を切り替え)
- `apps/application-admin-console/src/auth/idp-resolution.ts` — HRD 解決
- `docs/operations/control-plane-saml-setup.md` — Phase 1 (Control Plane 側) 設定手順
- `docs/architecture/adr-018-pooled-userpool-saml-isolation.html` — pooled UserPool に SAML を
  attach しない設計判断
