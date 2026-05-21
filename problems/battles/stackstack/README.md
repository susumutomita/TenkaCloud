# StackStack — AI → Production ラストワンマイル

> English version: [README.en.md](./README.en.md)

生成 AI で誰でもアプリを作れる時代の **AI → Production ラストワンマイル** を競技化する Battle。 コードを書く速さでも CTF でもなく、 Platform Team として「速く・安全に・統制下で」社内公開する能力を競う。

| 項目         | 値                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------- |
| カテゴリ     | Battle (リアルタイム対戦)                                                                           |
| 難易度       | 4 / 5                                                                                               |
| 想定時間     | 90〜120 分                                                                                          |
| status       | `draft`                                                                                             |
| 採点方式     | `phased-polling` (EC2 = 100pt / managed = 1,000pt / 全 slot managed bonus = +5,000pt one-time)      |

## 何をする問題か

参加者は企業の Platform Team として、 社内 100 人の AI Builder が量産する脆弱なアプリを 5 つの統制軸 (Security / Network / Rate / Audit / UX availability) で本番品質に持ち上げる。 単純な速度競争ではなく、 5 軸の総合バランス + ランダム組織イベント (CEO 5000 人デモ要求 / Legal の PII 指摘 / .env 流出 / AI が秘密鍵を commit 等) への対応で勝敗が決まる。

## 5 つの統制軸 (= 5 endpoint slot)

| slot      | 統制軸                                  | 初期状態                              | hardened 状態                                  |
| --------- | --------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| `auth`    | Authentication / Authorization          | EC2 上の naive Basic auth (`ec2`)     | Cognito / SSO 統合 (Lambda+API GW / App Runner / ECS) |
| `network` | Network controls (S3 / WAF / IAM)       | Public S3 + wildcard IAM (`ec2`)      | Origin Access Control + scoped IAM (managed)   |
| `rate`    | Rate limit / DoS protection             | 無制限の Flask (`ec2`)                | API GW throttle / Lambda concurrency (managed) |
| `audit`   | Logging / Compliance                    | 標準出力のみ (`ec2`)                  | CloudTrail + Athena + WORM bucket (managed)    |
| `ux`      | User-facing availability                | EC2 1 台 (`ec2`)                      | Multi-AZ + ALB + Auto Scaling (managed)        |

各 slot は `/meta` で hosting platform を自己申告する。 deploy 直後は全 slot が `"ec2"` を返し低スコア (100 pt/cycle/slot)。 Lambda+API GW / ECS Fargate / App Runner に切り出して endpoint を override 登録すると `/meta` が `"lambda" | "ecs" | "apprunner"` を返し、 加点が 1,000 pt/cycle/slot にジャンプする。

## 時間進行 (phases)

| 時刻       | phase                | 内容                                                                                                  |
| ---------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| 0 分       | start                | 全 slot が EC2 上に naive deploy (~500 pt/min ベース)                                                 |
| 30 分      | production-ramp      | `ux` slot が EC2 のままだと degradedPoints (10 pt) に劣化 (= CEO 5000 人デモに間に合わなかった状態)   |
| 60 分      | compliance-audit     | `audit` slot が EC2 のままだと degradedPoints (= Legal 監査に間に合わなかった状態)                    |
| 90 分      | incident-response    | 全 slot で `/score?legacy=true` に切替。 AI Builder が混入させた legacy path を取り除いて再 deploy が必要 |

## ランダム組織イベント (disruptions)

operator が任意タイミングで fire できる。

| id                    | name                              | 影響                                              |
| --------------------- | --------------------------------- | ------------------------------------------------- |
| `ceo-5000-users`      | CEO が明日 5000 人デモを要求      | `ux` slot が EC2 上にある間 -500 pt/cycle         |
| `mfa-mandate`         | Security Team が MFA 必須化       | `auth` slot が ec2 のまま 10 分超 → 失格扱い      |
| `legal-pii-found`     | Legal が PII 検出                 | `audit` slot が ec2 のまま -500 pt/cycle          |
| `env-credential-leak` | .env 流出                         | `auth` slot を 5 分間 503 (= failurePenalty 連発) |
| `ai-committed-secret` | Claude が秘密鍵を Git commit      | `network` + `audit` の 2 slot を 3 分間 503        |

## 全 4 platform 移行ボーナス

全 5 slot が `lambda` / `ecs` / `apprunner` のいずれかにホスティング済みなら **+5,000 pt one-time bonus** (`"production-ready"` 認定)。 ec2 が 1 つでも残っていれば bonus は付かない。

## Phase 1 / Phase 2 スコープ

### Phase 1 (= 本 problem の現状)

- ✅ 個別チームの「naive AI アプリを 5 軸でハードニングする」mechanics は phased-polling kind の既存 engine で動く
- ✅ ランダム組織イベント catalog は `disruptions[]` で宣言済み (operator fire)
- ✅ 5 軸 subscore display は `dashboard.slots/StatusPanel.tsx`

### Phase 2 (= platform 拡張が必要)

以下は今日の platform にプリミティブが無く、 別 ADR / 別 PR で扱う。

- **inter-team coordination plugin** (ADR-022): 問題ごとに他チーム interaction の primitive が違う (microservice-migration の service router / security-battle-royale の同盟 / その他)。 platform にこの coordination 機構を 1 つ hardcode せず、 問題が宣言した primitive を platform が dispatch する plugin 契約を ADR-022 で定義する。 StackStack の inter-team primitive は ADR-022 ship 後に declare する。
- **AI Agent 利用 / Platform 利用ステータス**: 競技者 portal から trigger する操作系。 portal plugin SDK の拡張が必要。

### やらないこと (= 明示却下)

- **tenant 横断 shared resource registry** (SSO Proxy 2 slot 先着 / Security Review 待ち行列 / Claude API quota): security 設計の難度が現 platform の整備状況と釣り合わないため Phase 2 計画から外す。

Phase 1 だけでも StackStack の中核 (5 軸 + ランダムイベント + 時間進行) は体験できる。

## 学習目的

- AI で量産されたアプリを 5 つの統制軸 (auth / network / rate / audit / ux) で本番化する判断と順序付けを体験する
- managed services (Lambda / ECS / App Runner) への移行が hardening をどう自動で底上げするかを理解する
- ランダム組織イベント (CEO 要求 / Legal 監査 / .env 流出) の発火下で優先度を再評価する Platform Team の意思決定を訓練する
- Phase 2 (inter-team coordination plugin = ADR-022) と Phase 1 (個別チームの hardening) の境界を見極め、 platform 拡張要求を ADR として言語化する

## 関連ファイル

- [`metadata.json`](./metadata.json) — 問題メタデータ (5 slot / scoring / phases / disruptions 正本)
- [`template.yaml`](./template.yaml) — CFn ペライチ
- [`portal/StatusPanel.tsx`](./portal/StatusPanel.tsx) — 5 軸 subscore + phase + disruption を表示する dashboard plugin
