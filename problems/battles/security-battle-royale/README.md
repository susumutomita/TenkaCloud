# Security Battle Royale

> English version: [README.en.md](./README.en.md)

意図的に脆弱性を仕込んだ EC サイト風 Web アプリ「Unicorn.Rentals」を、 攻撃側と防御側に分かれて競う Battle。 SQL injection / RCE / SSRF / IMDS 露出が同居した状態でデプロイされ、 防御側はサービスを止めずに塞ぐ、 攻撃側は他チームの公開エンドポイントを巡回して得点リソースを奪う。

| 項目         | 値                                          |
| ------------ | ------------------------------------------- |
| カテゴリ     | Battle (リアルタイム対戦)                   |
| 難易度       | 3 / 5                                       |
| 想定時間     | 60〜90 分                                   |
| status       | `draft`                                     |
| 採点方式     | `uptime-multi` (`pointsAllOk`: 100)         |

## 何をする問題か

- **攻撃側**: 他チームの `FrontendUrl` / `ApiUrl` を巡回し、 仕込まれた SQLi / RCE / SSRF / IMDS 露出を突いて得点を奪う。
- **防御側**: 自チームのアプリを **動かしたまま** 脆弱性を順次塞ぐ。 アプリを止めれば確かに守れるが、 uptime probe が落ちて加点も止まる。

このトレードオフ (= 可用性を保ちつつ守る) が問題の核。

## デプロイされるもの

```
┌── EC2 1 台 (Amazon Linux 2023, t3.small) docker-compose ──┐
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │  nginx   │  │  Flask   │  │  mysql   │                  │
│  │  :80     │  │  :8080   │  │  :3306   │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
│       │              │              │                      │
│  FrontendUrl     ApiUrl         (private)                  │
└────────────────────────────────────────────────────────────┘
```

- 専用 VPC + 公開 subnet + IGW
- 公開ポート: 80 (frontend) / 8080 (api)、 `AllowedCidr` で絞れる
- `DbPassword` は CFn parameter (NoEcho)、 deploy chain が `__RANDOM_PASSWORD__` で生成

## 採点

1 分ごとに 2 endpoint を probe し、 両方 200 で +100 pt。

| 状態                                                    | 1 cycle |
| ------------------------------------------------------- | ------- |
| `FrontendUrl /` と `ApiUrl /healthz` が両方 200          | +100 pt |
| いずれかが 200 以外 / timeout                           | 0 pt    |

詳細は [`metadata.json`](./metadata.json) の `scoring` フィールド参照。

## ローカル開発

```bash
cd problems/battles/security-battle-royale/local
docker compose up --build
# frontend: http://localhost:80
# api:      http://localhost:8080/healthz
```

`local/docker-compose.yaml` + `local/mysql-init.sql` で本番と同じ 3 コンテナ構成を再現できる。 `api/api.py` と `frontend/index.html` が脆弱性を含む本体。

## 含まれる脆弱性 (= 仕込みネタバレ注意)

- **SQL injection** — `api.py` の検索クエリで raw 文字列連結
- **RCE** — debug endpoint に `eval` / shell-out 系
- **SSRF** — 任意 URL の取得を試せる helper endpoint
- **IMDS exposure** — IMDSv1 enabled、 SSRF と組み合わせて IAM Role の credential が抜ける

> ADR-008 (= 問題実装の private repo 化、 issue #574) が ship するまで、 仕掛けは事前に読まれる可能性がある。

## 学習目的

- 意図的な SQL injection / RCE / SSRF を発見・修正する一連の手順を体験する
- EC2 IMDS / IAM Role の露出経路と、 それを塞ぐベストプラクティスを理解する
- 競技中に同居する攻撃者と防御者のトレードオフ (可用性を保ちつつ守る) を体験する

## 関連ファイル

- [`metadata.json`](./metadata.json) — 問題メタデータ
- [`template.yaml`](./template.yaml) — CFn ペライチ (competitor account に deploy する本体)
- [`api/api.py`](./api/api.py) — Flask API (脆弱性本体)
- [`frontend/index.html`](./frontend/index.html) — nginx が serve する静的ページ
- [`local/docker-compose.yaml`](./local/docker-compose.yaml) — ローカル再現用
