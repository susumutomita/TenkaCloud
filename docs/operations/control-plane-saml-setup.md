# Control Plane SAML SSO setup (Issue #1335 Phase 1)

System Admin 用 admin-console (`apps/admin-console`) を組織の IdP (Entra ID / Okta 等) による
SAML SSO でサインインできるようにする手順。 **同一メールドメインに複数 IdP が並立するケース**
(親会社 / 子会社、 部門ごとに別 IdP を立てている等) に対応する。

> 本書のドメイン・IdP 名はすべて記入例 (`example.com` / `corp-entra` / `corp-okta`)。 実値に
> 置き換えること。

## 全体像

- TenkaCloud 側は `CONTROL_PLANE_SAML_IDPS` で宣言した IdP 群を、 Control Plane Cognito UserPool に
  SAML provider として attach する。 opt-in で、 未設定なら従来通り Cognito local auth + MFA 強制
  のみ (= ADR-020 / Issue #1035) のまま。
- どのメールを管理者として認可するかは `CONTROL_PLANE_SAML_ADMIN_ALLOWLIST` (provider 束縛 allowlist)
  で明示する。 **ここに無い federated ユーザーはサインイン不可** (空 = 全拒否の fail-safe)。
- サインインの経路は 2 つ。
  - **SP-initiated** (admin-console からサインイン): メール入力後、 ドメインに対応する IdP 候補を
    解決する。 候補 1 件なら自動 redirect、 複数なら IdP 選択、 0 件なら Cognito local。
  - **IdP-initiated** (Entra MyApps / Okta ダッシュボードのタイル): そのまま受け入れる。
- すべてのサインイン成功は `AdminAuditLogTable` (= ADR-020 Phase D) の `SYSTEM#<env>` 区画に
  1 行 `auth.sign_in_succeeded` として記録される (= CloudTrail / EventBridge Lambda 経由、 SOC2 oriented
  audit 要件の最低限)。

## 手順 1: IdP 側で TenkaCloud を SP として登録

IdP に SAML アプリケーションを 1 つ作成し、 以下を設定する。 `<cognito-domain>` と `<user-pool-id>`
はデプロイ時に払い出される (= admin-console の `runtime-config.json` の `cognitoDomain` /
ControlPlaneStack の `cognitoUserPool.userPoolId` で確認できる)。

| 項目 | 値 |
| --- | --- |
| SP エンティティ ID (Audience) | `urn:amazon:cognito:sp:<user-pool-id>` |
| ACS URL (Reply / Assertion Consumer Service) | `https://<cognito-domain>/saml2/idpresponse` |
| NameID format | **persistent** (immutable な subject、 後述) |
| 必須属性マッピング | `email` → `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |

要件は次のとおり。

- **有効な署名証明書** を持つ metadata を発行できること (Cognito は署名を検証する)。
- **NameID は persistent** にする。 Cognito はこれを federated username (`{provider}_{subject}`) の
  subject に使い、 **なりすまし防止と監査の immutable ID** とする。 email は表示・名寄せ用であり、
  識別子ではない。
- IdP-initiated を使う場合は、 IdP 側でタイル (Entra: MyApps、 Okta: ダッシュボード) を有効化する。

登録後、 IdP の **federation metadata URL** (例 `https://login.example/.../federationmetadata.xml`)
を控える。

## 手順 2: TenkaCloud 側で IdP を宣言する

Control Plane デプロイ時の環境変数で設定する (= `infrastructure/environments/<env>/.env`)。

### `CONTROL_PLANE_SAML_IDPS` — attach する IdP 群 (JSON 配列)

```json
[
  { "name": "corp-entra", "metadataUrl": "https://login.example/meta", "emailDomains": ["example.com"] },
  { "name": "corp-okta",  "metadataUrl": "https://okta.example/meta",  "emailDomains": ["example.com"] }
]
```

- `name`: Cognito provider 名。 命名規約 `{scope}-{vendor}` (例 `corp-entra` / `corp-okta`) で同一
  ドメイン衝突を回避する。 3〜32 文字、 英数 + `-` / `_`。 **`_` 区切りで prefix 衝突する名前は避ける**
  (例 `corp` と `corp_evil`)。
- `metadataUrl`: 手順 1 で控えた IdP の metadata URL (https 必須)。
- `emailDomains`: この IdP で認証するメールドメイン (1 件以上)。 同一ドメインに複数 IdP を並べてよい
  (上記は `example.com` に Entra と Okta が並立する例)。

未設定 (または空) なら SAML は無効で、 従来通り Cognito local auth + MFA 強制のみになる。

### `CONTROL_PLANE_SAML_ADMIN_ALLOWLIST` — 管理者として認可するメール (provider 束縛)

```text
corp-entra/alice@example.com,corp-okta/bob@example.com
```

(JSON 配列 `["corp-entra/alice@example.com", ...]` でも可)

- 各エントリは **`provider/email`**。「どの IdP 経由で来た、 どのメールを管理者とみなすか」を
  明示する。
- これにより、 ある IdP に許可したメールを **別の IdP が assertion で詐称してもブロック** できる
  (provider 跨ぎの信頼プール化を防ぐ)。
- **空 = federated サインイン全拒否**。 SAML を有効化したのに allowlist 未設定、 という事故で「誰でも管理者」になるのを防ぐ fail-safe。

> Control Plane の API 認可は token の issuer + audience 検証のみ (scope 無効) なので、 この allowlist が
> 「管理者になれる人」 を絞る唯一のサーバ側ゲートになる。 必ず設定すること。

## 手順 3: デプロイと動作確認

1. 上記 env を設定して Control Plane stack を再デプロイする (= `make deploy-saas`)。 Cognito
   UserPool に SAML provider が attach され、 `admin-console` の `runtime-config.json` に
   `samlIdpDirectory` (ドメイン → provider 名配列) が配信される。
2. **SP-initiated**: 管理画面を開き、 メールを入力する。
   - 候補 1 件: その IdP に自動で飛ぶ。
   - 候補複数 (同一ドメインに Entra + Okta 等): IdP 選択 (「corp-entra」「corp-okta」ボタン) が出る。
   - 候補 0 件: Cognito local auth (= 既存 MFA 経路)。
3. **IdP-initiated**: IdP のタイルから入り、 そのままサインインできること。
4. allowlist に無いメールではサインインが拒否されること (`This federated identity is not authorized
   to access the admin console.`)。
5. 監査ログ画面 (`/audit-log`、 scope=system) で `auth.sign_in_succeeded` 行が増えていること。
   `extra.idp` に解決した provider 名 (`corp-entra` 等) または `COGNITO` (local) が入っている。

## 失効 (アクセス権の取り消し) について

allowlist から削除しただけでは、 **既にサインイン実績のある federated ユーザーは Cognito 上に残る**
(Pre sign-up は初回フェデレーション時のみ発火するため)。 失効させるには次の 2 段階で行う。

1. `CONTROL_PLANE_SAML_ADMIN_ALLOWLIST` から該当 `provider/email` を削除して再デプロイ
   (= 以後の新規 federated サインインは拒否される)。
2. 既存 user は AWS Console / CLI で `cognito-idp admin-delete-user` で deprovision する
   (= Cognito UserPool 内の federated identity を削除すれば再 federation 時に再び Pre sign-up を
   経由する)。

## 監査ログとの連携

本機能で書き込まれる sign-in audit 行は ADR-020 Phase D / Issue #1292 の audit UI (= admin-console
の `/audit-log` page) で読み出せる。 SOC2 oriented 要件 (= Issue #1335) の最低 1 行を担保する位置付け。

- action: `auth.sign_in_succeeded`
- tenantId: `SYSTEM` (Control Plane のサインインなので tenant に紐づかない)
- actor: Cognito `sub` (immutable identity)
- actorUsername: email or federated username
- extra.idp: `COGNITO` / `corp-entra` 等

Phase 6 で CloudTrail Cognito events を追加取り込みすることで、 失敗系 (= `auth.sign_in_denied`)
や IdP callback 失敗を補完する予定 (= Issue #1335 issue body 参照)。

## 関連

- `infrastructure/lib/control-plane/saml-identity-providers.ts` — SAML attach 本体
- `infrastructure/lib/control-plane/saml-admin-allowlist.ts` — provider 束縛 allowlist + Pre sign-up Lambda
- `infrastructure/lib/control-plane/sign-in-audit-lambda.ts` — CloudTrail / EventBridge Lambda (audit emit)
- `apps/admin-console/src/auth/idp-resolution.ts` — HRD 解決 (email → IdP 候補)
- ADR-020 Phase D / Issue #1292 — Admin audit log の data model
