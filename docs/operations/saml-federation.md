# SAML federation セットアップ (Issue #839 follow-up)

TenkaCloud の **System Admin (Control Plane)** と **Tenant Admin (Tenant Template)** の Cognito UserPool に SAML IdP を連携し、 会社の SSO (Entra ID / Okta / Google Workspace 等) で sign-in 可能にする手順です。

`username/password` 経路と並列で運用するか、 SAML だけに絞るかは `enforceSamlOnly` フラグで切り替えます。

## 1. IdP 側 (= 会社の IdP) で application 登録

各 IdP の手順は以下のとおりです。

- **Microsoft Entra ID**: Enterprise applications → New application → Non-gallery → SAML
- **Okta**: Applications → Create App Integration → SAML 2.0
- **Google Workspace**: Apps → Web and mobile apps → Add custom SAML app

IdP には次の値を設定してください。

- **SP エンティティ ID (Audience)**: `urn:amazon:cognito:sp:<USER_POOL_ID>`
  - System Admin: ControlPlaneStack の `UserPoolId` Output を control に貼る
  - Tenant Admin: `tenkacloud-tenant-template-pooled` の `UserPoolId` を貼る
- **ACS URL (Reply URL)**: `https://<COGNITO_DOMAIN_PREFIX>.auth.<region>.amazoncognito.com/saml2/idpresponse`
  - `<COGNITO_DOMAIN_PREFIX>` は `tenkacloud-<env>-<tenantId>-<accountId>` (= identity-provider.ts の `buildCognitoDomainPrefix`)
- **NameID format**: `EmailAddress`
- **Attribute mapping**:
  - `email` → `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`
  - (任意) `name` / `groups` 等を追加するときは下記「config.json での有効化」で `attributeMapping` に書く

IdP 設定完了後、 **federation metadata URL** を控えてください。 これを Cognito に渡します。

- Entra ID:「App Federation Metadata Url」
- Okta:「Identity Provider metadata」
- Google Workspace:「IDP metadata URL」

## 2. config.json での有効化

`infrastructure/environments/<env>/config.json` に次の section を追加します。

### Tenant Admin (全 tenant 共有の SAML)

```json
{
  "tenantSamlConfig": {
    "metadataUrl": "https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml",
    "providerName": "AcmeSAML",
    "enforceSamlOnly": false,
    "attributeMapping": {
      "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
    }
  }
}
```

### System Admin (= TenkaCloud operator 会社の SSO)

```json
{
  "controlPlaneConfig": {
    "systemAdminEmail": "ops@example.com",
    "samlIdp": {
      "metadataUrl": "https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml",
      "providerName": "AcmeSAML",
      "enforceSamlOnly": false
    }
  }
}
```

### フィールドの意味

| field | 必須 | 説明 |
| --- | --- | --- |
| `metadataUrl` | yes | IdP の federation metadata XML を取得する HTTPS URL。 IdP 側 cert rotation 時も自動追従。 |
| `providerName` | no | Cognito 内で IdP を識別する名前 (Hosted UI button label にもなる)。 default `CompanySAML`。 英数字 + `-_` のみ。 |
| `enforceSamlOnly` | no | `true` なら username/password 経路を閉じる (= Hosted UI に SAML button のみ)。 default `false` (= 並列許可)。 |
| `attributeMapping` | no | SAML AttributeStatement 名 → Cognito attribute 名のマップ。 default は email のみ自動。 |

## 3. deploy

```bash
make deploy ENV=development
```

`infrastructure/lib/tenant-template/identity-provider.ts` と `infrastructure/lib/control-plane-stack.ts` の両方が config を読み込み、 SAML IdP を CFn 上に作ります。

deploy 完了後、 Cognito Hosted UI を開くと「Sign in with `<providerName>`」button が表示されます。

## 4. ロールアウトの推奨手順

既存 user に SAML 強制をかけるとログイン経路が一夜で変わるので、 次の段階で進めることを推奨します。

1. **dev / staging で並列 (`enforceSamlOnly: false`)**: SAML 経路を operator で 1 人テスト
2. **production で並列**: operator 全員が SAML 経由でログインできることを確認 (最低 1 週間)
3. **production で `enforceSamlOnly: true`**: username/password 経路を閉じる

`enforceSamlOnly: true` に flip した後、 旧 username/password の user は Cognito Admin Console から削除する運用にすることで遺漏を防げます。

## 5. トラブルシューティング

### Hosted UI に SAML button が出ない

- `make synth` で UserPoolClient の `SupportedIdentityProviders` を確認: SAML provider 名が入っているか
- Cognito Hosted UI の **App Client > Identity Providers** タブで provider が enable されているか確認 (= deploy 直後は反映に数分かかる場合あり)

### Sign-in 時に「No email」 / 「No NameID」 エラー

- IdP の attribute mapping が `emailaddress` を出力しているか確認 (NameID format=EmailAddress でない IdP は明示的に `email` claim を別の URN で出す必要あり)
- `attributeMapping` の `email` キーを IdP 側の Attribute Name に合わせて override

### 「Untrusted ACS URL」 エラー

- IdP 側の Reply URL が Cognito の `/saml2/idpresponse` を指しているか確認
- domain prefix は env / tenantId / accountId で組まれるので、 deploy 後の **実 URL を IdP 側に貼る** 順番が正しい (= deploy → URL 取得 → IdP 設定)

## 関連

- [`infrastructure/lib/tenant-template/identity-provider.ts`](../../infrastructure/lib/tenant-template/identity-provider.ts) — Tenant Admin SAML 連携の実装
- [`infrastructure/lib/control-plane-stack.ts`](../../infrastructure/lib/control-plane-stack.ts) — System Admin SAML 連携の escape hatch
- [`infrastructure/lib/config/config-interface.ts`](../../infrastructure/lib/config/config-interface.ts) — `SamlIdpConfig` 型定義
- Issue #839 — 本機能の親 issue
