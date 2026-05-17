# セキュリティポリシー

TenkaCloud のセキュリティを真剣に受け止めています。脆弱性を見つけた場合は、責任を持って開示してください。

## サポート対象バージョン

`main` ブランチの最新コミットのみセキュリティ修正の対象です。タグ付きリリースを運用していないため、フォーク・古い snapshot は各自で最新へ追従してください。

| バージョン | サポート       |
| ---------- | -------------- |
| `main`     | ✅ サポート対象 |
| その他     | ❌ サポート対象外 |

## 脆弱性の報告

**公開 issue で脆弱性を報告しないでください。** 攻撃者に手の内を渡すことになります。

代わりに、次のいずれかで報告してください。

1. **GitHub Security Advisories (推奨)**: [https://github.com/susumutomita/TenkaCloud/security/advisories/new](https://github.com/susumutomita/TenkaCloud/security/advisories/new) からプライベートに報告できます。
2. **メール**: [oyster880@gmail.com](mailto:oyster880@gmail.com) 宛に件名 `[SECURITY] TenkaCloud` で送ってください。

報告に含めてほしい情報:

- 脆弱性の種類 (例: 認証バイパス、IAM 権限昇格、SSRF、テナント越境)
- 影響を受けるコンポーネント (Control Plane / Application Plane / 問題 deploy backend / Participant Portal など)
- 再現手順 (Proof of Concept があれば最良)
- 想定される影響 (情報漏洩、テナント越境、競技者アカウントへの権限昇格、課金影響など)
- 修正案 (任意)

## 対応プロセス

| ステップ              | 目安時間     |
| --------------------- | ------------ |
| 受領確認              | 3 営業日以内 |
| 初期トリアージ        | 7 営業日以内 |
| 修正版リリース        | 重大度による |
| 公開 Advisory 発行    | 修正後速やかに |

重大度の判定は [CVSS 3.1](https://www.first.org/cvss/calculator/3.1) に準じます。Critical / High は優先的に対応します。

## 開示方針

- 修正がリリースされるまで脆弱性の詳細は公開しないでください (= responsible disclosure)。
- 報告から 90 日経過しても修正がリリースされない場合、報告者は公開する権利を保持します。
- 修正リリース時に Security Advisory を発行し、報告者を希望に応じてクレジットします。

## TenkaCloud 固有の注意点

このプロジェクトは複数の AWS アカウントを跨ぐマルチテナント SaaS です。次の領域は特に慎重に扱ってください。

- **AssumeRole + ExternalId**: 競技者アカウントへの cross-account access。`CDK_PARAM_DEPLOY_EXTERNAL_ID` を省略する経路を見つけたら最優先で報告してください。
- **Cognito JWT 検証**: Application Plane / Participant Portal の API は JWT 検証で tenant 分離を担保します。検証バイパスは critical です。
- **CFn テンプレート (`problems/<id>/template.yaml`)**: 競技者アカウントに deploy されるため、テンプレート経由で platform 側に権限が戻る経路 (= confused deputy) があれば critical です。
- **IAM 最小権限**: `infrastructure/templates/competitor-bootstrap.yaml` の Role が必要以上の権限を持っていれば報告してください。
- **Supply Chain**: `package.json` の `trustedDependencies` 追加、`scripts/audit-baseline.json` の不審な変更も対象です ([CLAUDE.md](./CLAUDE.md) の Supply Chain Security 節参照)。

## 対象外

次は脆弱性ではなく、設計上の選択です。報告は不要です。

- DynamoDB の PROVISIONED 1 RCU / 1 WCU による throughput throttling — Free Tier 内に収めるための意図的な制約です ([CLAUDE.md](./CLAUDE.md) の `DynamoDbLowCapacity` Aspect 参照)。
- 公開 endpoint (= 一般公開を意図したヘルスチェック等) の DoS。
- 自己アカウント内の問題テンプレートに含まれるサンプル脆弱性 (= 競技用に意図的に組み込まれた弱点)。

## 関連ドキュメント

- [CLAUDE.md](./CLAUDE.md) — セキュリティ要件 (Zod / 認証バイパス禁止 / `innerHTML` 禁止 / ExternalId 必須 / Supply Chain Security)
- [AGENTS.md](./AGENTS.md) — エージェント運用ルール (シークレットコミット禁止 / `trustedDependencies` 独断追加禁止)
- [docs/architecture/harness.md](./docs/architecture/harness.md) — アーキテクチャ invariant (認証はインフラ層で注入、テナント分離はインフラ層で実現)
