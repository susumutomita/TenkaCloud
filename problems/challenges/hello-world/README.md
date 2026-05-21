# Hello World (Sample)

> English version: [README.en.md](./README.en.md)

Challenge / flag-submission の **最小 sample** 問題。 SSM Parameter Store の値を読み取って Participant Portal に貼り付けると +100 pt。 deploy → flag 提出 → 加点経路を end-to-end で確認する用途。

| 項目         | 値                                                            |
| ------------ | ------------------------------------------------------------- |
| カテゴリ     | Challenge (個別演習)                                          |
| 難易度       | 1 / 5 (入門)                                                  |
| 想定時間     | 1 分                                                          |
| status       | `ready`                                                       |
| 採点方式     | `flag` (`points`: 100, `wrongAnswerPenalty`: 5)               |

## ストーリー

天下クラウド株式会社へようこそ。 あなたは今日が入社初日。 前任 SRE の加藤さんが先週突然退職し、 production には謎の SSM Parameter が 1 つ残されている。

佐々木 CTO 曰く、「動作確認のために残したやつ、 たぶん」。 詳細は不明。 Slack の DM 履歴を遡っても何も出てこない。 Notion の引継ぎ書には「SSM の hello 見といて」とだけ書いてある。

あなたのミッション: AWS Console または CLI で SSM Parameter Store にアクセスし、 `/{NamePrefix}/hello` の値を読んで Participant Portal の入力欄に貼り付ける。 一致すれば +100 pt。

世界観の正本は [`docs/lore/world.html`](../../../docs/lore/world.html) を参照。

## デプロイされるもの

- `AWS::SSM::Parameter` (`/{NamePrefix}/hello`、 Standard tier、 値は `Hello from {NamePrefix}`)
- `ParticipantViewerRole` — 競技者が AWS Console で読み取り専用 AssumeRole するための IAM Role
  - `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` を **自分の prefix だけ** に scope
  - `cloudformation:DescribeStacks` etc. を **自分の stack だけ** に scope
  - 他テナントの parameter / stack を覗けない (ADR-021)

EC2 / VPC / 公開エンドポイントは作らない。 SSM Standard tier は料金ゼロ。

## 解き方

```bash
# CLI で読む場合
aws ssm get-parameter --name /{NamePrefix}/hello --query Parameter.Value --output text
# → "Hello from {NamePrefix}"
```

または AWS Console の Parameter Store 詳細ページ ([`ParameterConsoleUrl` の Output](./template.yaml)) を Participant Portal から click-through すると直接 deep link で開ける。

> Console の Parameter Store **一覧** ページは `ssm:DescribeParameters` が必要で、 cross-tenant leak を防ぐため `ParticipantViewerRole` には付与していない (ADR-021)。 一覧から探す解き方は意図的に塞いであるので、 Portal の deep link を使う。

値を Participant Portal の Flag 提出欄に貼り付けて submit → 一致すれば +100 pt。 間違えると -5 pt のペナルティ。

## ヒント (利用すると減点)

| hint   | 内容                                                                                  | 減点  |
| ------ | ------------------------------------------------------------------------------------- | ----- |
| hint-1 | AWS Console (SSM Parameter Store) または `aws ssm get-parameter --name /{NamePrefix}/hello` で値を読み出してください | -10   |
| hint-2 | 値は `Hello from tc-...` の形式で、 Stack 名 prefix を含みます (= NamePrefix の値そのもの) | -20   |

## 採点

| 状態                            | 得点  |
| ------------------------------- | ----- |
| 正答 (= 値が一致)               | +100  |
| 誤答                            | -5    |

## 学習目的

- AWS Console / CLI で SSM Parameter Store の値を読み出す経路を体験する
- TenkaCloud の deploy → flag 提出 → 加点経路が end-to-end で動くことを確認する

## 関連ファイル

- [`metadata.json`](./metadata.json) — 問題メタデータ
- [`template.yaml`](./template.yaml) — CFn ペライチ (SSM Parameter + 限定 IAM Role のみ)
