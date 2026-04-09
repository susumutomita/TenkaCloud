# CloudFront CDN の最適構成

## 概要

CloudFront ディストリビューションを構築し、キャッシュ・圧縮・プロトコルを最適化する構築型問題です。

## 対象サービス

- Amazon CloudFront
- Amazon S3

## パフォーマンス最適化要件

| 要件 | 内容 | 配点 |
|------|------|------|
| キャッシュポリシー | デフォルト TTL 86400 秒、最大 TTL 604800 秒 | 30 点 |
| 圧縮有効化 | gzip + Brotli 圧縮 | 25 点 |
| HTTPS 強制 | redirect-to-https | 25 点 |
| HTTP/2 有効化 | HTTP/2 プロトコル | 20 点 |

## 採点方法

Scoring Service が参加者の AWS アカウントに対して AWS SDK で以下を検証します。

1. `GetCachePolicy` でデフォルト TTL が 86400 秒、最大 TTL が 604800 秒か
2. `GetCachePolicy` で EnableAcceptEncodingGzip と EnableAcceptEncodingBrotli が true か
3. `GetDistribution` の DefaultCacheBehavior で ViewerProtocolPolicy が redirect-to-https か
4. `GetDistribution` で HttpVersion が http2 以上か

## 参考ドキュメント

- [CloudFront キャッシュの最適化](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ConfiguringCaching.html)
- [CloudFront 圧縮サポート](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html)
- [CloudFront セキュリティ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https.html)
