# ACM 証明書 + HTTPS 強制設定

## 概要

ACM 証明書を発行し、ALB で HTTPS を強制する構築型問題です。

## 対象サービス

- AWS Certificate Manager (ACM)
- Elastic Load Balancing (ALB)

## 要件

| 要件 | 内容 | 配点 |
|------|------|------|
| ACM 証明書 | DNS 検証でリクエスト | 25 点 |
| HTTPS リスナー | 443 + 証明書 | 25 点 |
| HTTP リダイレクト | 80 → 443 リダイレクト | 25 点 |
| TLS ポリシー | TLS 1.2 以上強制 | 25 点 |

## 採点方法

Scoring Service が AWS SDK で以下を検証します。

1. `DescribeCertificate` で証明書の検証方法を確認
2. `DescribeListeners` で HTTPS リスナーを確認
3. HTTP リスナーのリダイレクト設定を確認
4. HTTPS リスナーの SslPolicy を確認

## 参考ドキュメント

- [ACM 証明書のリクエスト](https://docs.aws.amazon.com/acm/latest/userguide/gs-acm-request-public.html)
- [ALB HTTPS リスナー](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html)
