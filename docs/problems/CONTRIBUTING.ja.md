# TenkaCloud 問題 contribution ガイド — 30 分 quickstart

> 対象: TenkaCloud に新規問題を 1 PR で送りたい外部 contributor。
> ファイル形式の正本: [`problems/SCHEMA.json`](../../problems/SCHEMA.json) + [`AUTHORING.html`](./AUTHORING.html)。
> Catalog 規約の正本: catalog submodule の [`problems/AGENT.md`](https://github.com/susumutomita/TenkaCloudChallenge/blob/main/AGENT.md)。

このドキュメントは「maintainer の頭の中を使うべきではない言葉なので修正してください人が、 reviewed + merged まで辿りつく最短経路」を書く。 `AUTHORING.html` (= 30 分 onboarding) と catalog submodule の `AGENT.md` (= invariant 一覧) の補助。 **何をするか** をこのファイルで掴み、 **各 field の意味** はそれらを読む。

English mirror: [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 問題は submodule に住む (= この repo ではない)

Platform repository (`TenkaCloud`) と catalog repository (`TenkaCloudChallenge`) は物理的に切り離されている。

```
TenkaCloud/                           ← platform (CDK + 3 SPAs + scoring engine)
└── problems/                         ← git submodule
    └── (実体は github.com/susumutomita/TenkaCloudChallenge)
```

問題 PR は **`susumutomita/TenkaCloudChallenge`** に出す。 `TenkaCloud` には catalog 変更を ship する時の submodule pointer bump PR だけが入る (= maintainer 側で別 PR を切る)。

ローカル作業の手順は次のとおりです。

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
# problems/ の working tree が TenkaCloudChallenge の checkout になる
```

`--recurse-submodules` 抜きで clone した場合は次を実行します。

```bash
git submodule update --init --recursive problems
```

## 30 分 quickstart (= scaffold → edit → validate → PR)

### 1. 採点 kind を選ぶ (= 最重要)

TenkaCloud の 1 問題は 6 種の built-in scoring kind のいずれか 1 つで採点する。 platform 側の generic scoring Lambda がこの値で dispatch する。 問題固有の scoring code は [ADR-012](../architecture/adr-012-problem-plugin-architecture.html) で禁止。

決定木は次のとおりです。

```text
競技者が値 (= "flag") を提出して終わるか?
├── Yes
│   │
│   flag は 1 個か、 独立した複数 flag を個別採点 (= 部分点) するか?
│   ├── 1 個 → kind = "flag"          (Challenge / SSM Parameter を読む、 S3 object を見つける等)
│   └── N 個の独立 flag → kind = "multi-flag"
│       (Challenge / 1 問に複数 sub-challenge。 flags[].points の合計が満点)
└── No
    │
    競技者が何かを稼働させ続ける必要があるか?
    ├── Yes
    │   │
    │   稼働させる endpoint は 1 つだけか?
    │   ├── Yes → kind = "uptime-flat"    (Battle / nginx 1 つ、 API 1 つ)
    │   └── No、 複数 endpoint をまとめて → kind = "uptime-multi"
    │       (Battle / frontend + api + worker。 「全部同時 ok」 を採点軸にする)
    │
    └── No
        │
        時間経過で rule が変わるか? (= 移行 deadline、 負荷急増等)
        ├── Yes → kind = "phased-polling"
        │   (Battle / phases[].afterMinutes で採点切替。 マイクロサービス移行レースが典型)
        │
        └── 攻撃検知 / 防御が採点軸か?
            └── Yes → kind = "attack-detection"
                (Battle / WAF / SOC。 検出 1 件あたり +N)
```

どれにも当てはまらない → **まだ TenkaCloud の問題ではない可能性**。 先に issue で議論する。

### 2. ディレクトリ scaffold

```bash
bun run scripts/tenkacloud-problem.ts create my-problem --kind flag
# または対話的に:
bun run scripts/tenkacloud-problem.ts create
```

CLI が `.claude/templates/problems/<kind>/` から `problems/<category>/my-problem/{metadata.json,template.yaml}` を生成する。 `<category>` は kind から決まる (flag → `challenges/`、 それ以外 → `battles/`)。 `--category Battle|Challenge` で上書き可。

Alternative: Claude Code 上で `/create-problem` を起動すると同じ flow を AI 経由で進められる。

### 3. Scaffold を編集

Scaffold 内には `__PROBLEM_NAME__`、 `__TAG__`、 `__LEARNING_GOAL_1__`、 `__HINT_1__` 等の placeholder が残る。 **`__` を全部 grep して書き換える** こと。 JSON Schema は placeholder を string として通すが、 catalog UI と scoring engine は誤動作する。

最低限の編集箇所は次のとおりです。

- `name`、 `shortDescription`、 `description` — 読み手が zero context な前提で書く。 Battle は架空の incident 一段落で導入するのが定型。
- `tags` — kebab-case で 1 つ以上。
- `learningGoals` — 1 bullet 以上。
- `i18n.en.*` — `name` / `shortDescription` / `description` / `learningGoals` の英訳 mirror が必須。 サポート locale は `ja` + `en` のみ。
- `template.yaml` — placeholder resource を実 CFn に置換。 全リソース名 / タグ / Group 名に `${NamePrefix}` を冠する (= 同一 AWS account に複数 team の stack が並ぶ前提)。

### 4. ローカル検証

```bash
# JSON Schema 検証 (= 全 catalog)
make validate-problems

# 1 問題に対する cross-check (Outputs ↔ metadata 配線、 portal slot file 存在)
bun run scripts/tenkacloud-problem.ts validate my-problem

# Optional: scoring engine の dry-run (= CFn deploy 抜き)
bun run scripts/tenkacloud-problem.ts dry-run my-problem --submitted "expected-flag-value"

# metadata + template summary を眺める
bun run scripts/tenkacloud-problem.ts inspect my-problem
```

`make validate-problems` / `validate` でエラーが出たら [Validation エラーの読み方](#validation-エラーの読み方) を参照。

### 5. Sandbox AWS account に 1 回 deploy する (= "tested" 状態)

Platform は少なくとも 1 回の end-to-end deploy + scoring を確認した問題のみを `ready` にする。 個人 sandbox の AWS account を使う。

```bash
aws cloudformation deploy \
  --template-file problems/<category>/my-problem/template.yaml \
  --stack-name tc-my-problem-test \
  --parameter-overrides NamePrefix=tc-my-problem-test \
  --capabilities CAPABILITY_NAMED_IAM
```

そのあと scoring path を手で動かす (= flag 提出する / endpoint を叩く / disruption の発火を待つ etc。 問題により)。 加点が観測できたらライフサイクル上の "tested" に到達。

Teardown:

```bash
aws cloudformation delete-stack --stack-name tc-my-problem-test
```

### 6. PR を出す (= submodule repo に対して)

次のように `problems/` working tree 内で操作します。

```bash
cd problems
git checkout -b feat/my-problem
git add battles/my-problem   # または challenges/my-problem
git commit -m "feat: add my-problem"
git push origin feat/my-problem
gh pr create --repo susumutomita/TenkaCloudChallenge \
  --title "feat: add my-problem" \
  --body "..."
```

PR body のチェックリストは次のとおりです。

- どの category、 kind、 difficulty なのか。
- Test plan: 走らせた `validate` / `dry-run`、 sandbox-deploy した AWS account の概要 (= account ID は書かない)。
- 問題の status が `draft` (= ほとんどの初回 PR) / `tested` / `ready` のどれか (= 下記 lifecycle 参照)。
- 競技者に発生する AWS コスト (= 目標: Free Tier 内 0 円)。

`TenkaCloud` 側への submodule pointer bump PR は **contributor の責任ではない** — maintainer 側で別 PR を切る。

## Lifecycle: draft → tested → ready → official → deprecated

`metadata.json` の `status` は JSON Schema enum で `draft` / `ready` / `deprecated` の 3 値のみ。 5 段階 lifecycle はこの 3 値 + 2 つの慣習 (= PR body / catalog `CATALOG.md` / commit 履歴で追う) で表現する。

| Stage          | `status` field      | 意味                                                                          | Catalog 公開? |
| -------------- | ------------------- | ----------------------------------------------------------------------------- | ------------- |
| **draft**      | `"status": "draft"` | 作者の進行中。 Scaffold は通る、 schema 通る、 **end-to-end deploy 未確認**。 | No (= filter) |
| **tested**     | `"status": "draft"` | 作者が sandbox account に 1 回以上 deploy + scoring 確認済。 PR body に "tested in AWS sandbox" を明記。 | No            |
| **ready**      | `"status": "ready"` | Maintainer review 通過。 公開 catalog エントリ。 誰でも event で使える。     | Yes           |
| **official**   | `"status": "ready"` | 実 event で 1 回以上使用済 (= JAWS-UG / CCoE training 等)。 `official-yyyy-mm` tag + `README.md` に event link を追加。 | Yes           |
| **deprecated** | `"status": "deprecated"` | 置き換え / メンテナンス停止。 catalog は default で非表示。 履歴用に dir は残す。 | No            |

`draft` → `ready` への昇格は別 PR で出す (= before/after が review しやすい)。 その PR body に test event / sandbox 結果を書く。

## Validation エラーの読み方

CLI validator (`scripts/tenkacloud-problem.ts validate`) と `make validate-problems` のエラーを fix にマップする一覧。

| エラー (= 部分一致)                                                       | 原因                                                                              | Fix                                                                                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `scoring.kind="..." is not a recognized kind`                            | `scoring.kind` の typo                                                            | 値を `flag` / `multi-flag` / `uptime-flat` / `uptime-multi` / `phased-polling` / `attack-detection` のどれかに修正する。   |
| `scoring.flagOutputKey="X" not found in template.yaml Outputs`           | `metadata.scoring.flagOutputKey` の値が CFn `Output` key に存在しない              | `template.yaml` に `Outputs.X:` を追加するか、 metadata 側の key を template の実際の Output key に揃える。               |
| `scoring.statsOutputKey="X" not found in template.yaml Outputs`          | `attack-detection` で同上                                                          | `Outputs.X:` を追加。 `Value` は攻撃検知数 (= 整数 string)。                                                              |
| `endpoints[slot=N].default.key="X" not found in template.yaml Outputs`   | `endpoints[].default.key` が存在しない Output を指す                              | `Outputs.X:` を追加 (= typically 公開 endpoint URL)。                                                                     |
| `dashboard.slots["X"]="path" file not found at ...`                      | `dashboard.slots` が存在しない portal plugin file を参照                          | `path` で示された場所に `.tsx` を作るか、 slot 宣言を消す。                                                              |
| `metadata.id="X" does not match dir name "Y"`                            | `metadata.id` と dir 名がズレた                                                    | どちらかを揃える (= 完全一致が必須)。                                                                                    |
| `runtime block must declare provider / engine / entry`                   | `runtime` が不完全 (= `entry` だけ等)                                              | 3 key 全部書くか、 `runtime` block を削除する (= validator は legacy `cfnTemplate` から自動推論する)。                  |
| `runtime.entry="A" and cfnTemplate="B" must match`                       | `runtime` と `cfnTemplate` の両方を書いて値が違う                                 | ADR-023 互換期間中は `runtime.entry === cfnTemplate` を強制。                                                            |
| `Runtime <provider>/<engine> is recognized but not executable`           | 将来予約された runtime (= `azure/arm`、 `kubernetes/helm` 等)                     | `aws/cloudformation` に変更する。 他は schema は通すが deploy worker が reject する。                                  |
| `cfnTemplate file "..." not found`                                       | filename mismatch                                                                  | `cfnTemplate` (= または `runtime.entry`) が指す file が問題 dir に存在するか確認。                                       |
| `metadata.json parse error: ...`                                         | 不正な JSON (= trailing comma、 unquoted key 等)                                  | JSON formatter を通す。 placeholder は quoted のままで OK。                                                              |

`make validate-problems` が `instancePath` (= JSON pointer 形式 `/scoring/points` 等) 付きのエラーを出した時は、 `metadata.json` を開いてその path を辿って fix する。 各 field の意味は [`problems/SCHEMA.json`](../../problems/SCHEMA.json) の `description` 参照。

### `template.yaml` のよくある罠

JSON Schema は catch しないが、 CFn deploy 時に死ぬ / AWS 請求が爆発するパターンを以下に挙げます。

- **リソース名に `${NamePrefix}` が無い** — 2 team 目の deploy が衝突する。 必ず `!Sub "${NamePrefix}-..."` で囲む。
- **`!Sub` の `}` 抜け** — `!Sub "tc-${NamePrefix-bucket"` (= 閉じ無し) で CFn parse error。 CFn の行番号メッセージを見て `}` 抜けを探す。
- **disruption Lambda が idempotent でない** — EventBridge Scheduler は再発火する。 `tc qdisc add ... || true` で EEXIST を握る。
- **PAY_PER_REQUEST DynamoDB** — 禁止。 `BillingMode: PROVISIONED` + 1 RCU / 1 WCU で書く。 platform 側 table は CDK Aspect が強制するが、 問題 template は self-discipline。
- **`Resource: "*"` IAM** — CloudShell の例外 list 以外は禁止。 catalog の `AGENT.md` に例外コメント marker が定義されている (= 動かさないこと)。

## AI-assisted authoring (= optional、 上乗せ)

Claude Code には `/create-problem` skill が同梱されており、 同じ scaffold + edit flow を AI in the loop で走らせる。 必須ではない (= 全 step は手で再現可能)。 推奨 prompt は [`AI-WORKFLOW.md`](./AI-WORKFLOW.md) 参照。

## PR を出す前の checklist

- [ ] `metadata.id` と dir 名が完全一致。
- [ ] `category` は `"Battle"` または `"Challenge"` (= 大文字始まり)。
- [ ] `status` は `"draft"` (= 初回 submission)。
- [ ] `scoring.kind` は 6 種のいずれか。
- [ ] `metadata.json` 内の `__PLACEHOLDER__` を全部置換済。
- [ ] `metadata.json` が参照する endpoint / scoring key が `template.yaml` `Outputs:` に存在する。
- [ ] `template.yaml` の全リソース名に `${NamePrefix}` が冠されている。
- [ ] `make validate-problems` 通過。
- [ ] `bun run scripts/tenkacloud-problem.ts validate <id>` 通過。
- [ ] Sandbox AWS account に 1 回 deploy + scoring 確認 (= PR body に明記)。
- [ ] `i18n.en.*` mirror が埋まっている (= `name` / `shortDescription` / `description` / `learningGoals`)。
- [ ] PR body に Summary、 Test plan、 Regression analysis、 Physical impact を書いた。

## See also

- [`AUTHORING.html`](./AUTHORING.html) — 30 分 onboarding (= 全 field 一覧)。
- [`AI-WORKFLOW.md`](./AI-WORKFLOW.md) — Claude Code / Codex CLI を使った問題作成 flow。
- [`EXAMPLES.md`](./EXAMPLES.md) — 既存 5 問題の design 振り返り。
- [`problems/AGENT.md`](https://github.com/susumutomita/TenkaCloudChallenge/blob/main/AGENT.md) — catalog repo invariant (= `bun run validate` で強制)。
- [ADR-012](../architecture/adr-012-problem-plugin-architecture.html) — plugin architecture (= これが土台)。
- [ADR-023](../architecture/adr-023-provider-specific-problem-runtime.html) — `runtime` field と将来の multi-provider 対応。
