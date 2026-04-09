# WAF + CloudFront + S3 セキュア配信

## 概要

WAF による IP 制限・レート制限、CloudFront OAC による S3 アクセス制御を組み合わせたセキュアなコンテンツ配信基盤の構築型問題です。

## 対象サービス

- AWS WAF
- Amazon CloudFront
- Amazon S3

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| S3 バケット設定 | 暗号化、パブリックブロック、OAC 限定 | 20 点 |
| CloudFront + OAC | OAC、HTTPS リダイレクト | 20 点 |
| WAF WebACL 構成 | デフォルト Block、マネージドルール | 25 点 |
| IP 制限ルール | IPSet、Allow ルール | 20 点 |
| レート制限ルール | RateBasedStatement | 15 点 |

## アーキテクチャ概要

```
Client --> [WAF] --> [CloudFront] --> [OAC] --> [S3 Bucket]
              |
         IP 制限 + レート制限
```

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetBucketEncryption` / `GetPublicAccessBlock` で S3 のセキュリティ設定を確認
2. `GetBucketPolicy` で CloudFront OAC のみが許可されているか
3. `GetDistribution` で OAC が設定され、ViewerProtocolPolicy が redirect-to-https か
4. `GetWebACL` でデフォルト Block、IP 制限・レート制限・マネージドルールが設定されているか
5. `GetIPSet` で許可 IP レンジが正しく設定されているか

## 設計のポイント

- **デフォルト Block**: WAF はホワイトリスト方式（デフォルト Block + Allow ルール）が推奨
- **OAC vs OAI**: Origin Access Control（OAC）は OAI の後継で、SSE-KMS やマルチリージョンに対応
- **レート制限**: RateBasedStatement は 5 分間のウィンドウで評価される
- **マネージドルール**: AWS 提供のルールセットで SQL インジェクションや XSS を防御

## 参考ドキュメント

- [AWS WAF ドキュメント](https://docs.aws.amazon.com/waf/latest/developerguide/)
- [CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [WAF レートベースルール](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html)
