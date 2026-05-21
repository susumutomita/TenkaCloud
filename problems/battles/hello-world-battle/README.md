# Hello World Battle (Sample)

> English version: [README.en.md](./README.en.md)

Battle uptime scoring の **最小 sample** 問題。 EC2 1 台に nginx (frontend) と Python http.server (api) を起動し、 1 分ごとの health probe で両方が 200 を返す間スコアが +100 加算される。

| 項目         | 値                                       |
| ------------ | ---------------------------------------- |
| カテゴリ     | Battle (リアルタイム対戦)                |
| 難易度       | 1 / 5 (入門)                             |
| 想定時間     | 30 分                                    |
| status       | `ready`                                  |
| 採点方式     | `uptime` (`pointsPerSuccess`: 100)       |

## 何をする問題か

新人 SRE のあなたは、 deploy 直後の 2 つの endpoint (`FrontendUrl` / `ApiUrl`) が落ちないように守りながら、 攻撃側の妨害で stop されたサービスを SSM Session Manager で復旧する。 1 分ごとに probe が走り、 両方が 200 を返すサイクルだけ +100 pt が加算される。

- **攻撃側**: 同じ EC2 / Security Group を弄って frontend や API を止める (例: `systemctl stop nginx`)
- **防御側**: SSM Session Manager で SSH 不要に入り、 サービスを再起動する

全操作は 1 EC2 内で完結するため cross-tenant 影響なし。

## デプロイされるもの

```
┌─────── EC2 t3.micro (Amazon Linux 2023, Public IP) ───────┐
│  nginx          :80   → /  (FrontendUrl)                  │
│  python3 http.server :8080 → /healthz (ApiUrl)            │
└────────────────────────────────────────────────────────────┘
       ▲
       │ 1 分ごとに Health Check Lambda が probe
       │ 両方 200 → +100 pt / cycle
```

- 専用 VPC (`10.99.0.0/16`) + 公開 subnet + IGW
- SSM Session Manager 用 InstanceRole (`AmazonSSMManagedInstanceCore`)
- `ParticipantViewerRole` (競技者が AWS Console を読み取り専用で AssumeRole する用)

## 採点

| 状態                                            | 1 cycle (1 分) |
| ----------------------------------------------- | -------------- |
| `FrontendUrl /` と `ApiUrl /healthz` が両方 200 | +100 pt        |
| いずれかが 200 以外 / timeout                   | 0 pt           |

詳細は [`metadata.json`](./metadata.json) の `scoring` フィールド参照。

## コスト

- EC2 t3.micro: AWS Free Tier 750 時間/月 (12 ヶ月) 内
- VPC / IGW / SG: 無料
- 1 セッション (~30 分) は Free Tier 範囲ならゼロ円

## 学習目的

- TenkaCloud の Battle uptime scoring engine が実 endpoint で動くことを確認する
- EC2 + nginx + Python の最小 web stack で health probe を受ける流れを体験する
- SSM Session Manager で SSH 不要に接続し、 サービスを start / stop する操作を覚える

## 関連ファイル

- [`metadata.json`](./metadata.json) — 問題メタデータ (UI / scoring engine 正本)
- [`template.yaml`](./template.yaml) — CFn ペライチ (competitor account に deploy する本体)
