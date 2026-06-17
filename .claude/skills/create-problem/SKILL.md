---
name: create-problem
description: TenkaCloud の問題ディレクトリ (problems/<category>/<id>/) を ADR-012 thick metadata DSL (6 scoring kinds + endpoints + phases + disruptions + dashboard.slots) で生成する。Battle (リアルタイム対戦) または Challenge (個別演習) の雛形を作る。
allowed-tools: Bash(make validate-problems:*), Bash(bun run scripts/tenkacloud-problem.ts:*), Read, Write, Edit, Glob
---

# create-problem (ADR-012 Phase 6 拡張版)

TenkaCloud に新しい問題を追加する skill。**正本は [`problems/SCHEMA.json`](../../../problems/SCHEMA.json) と [`docs/problems/AUTHORING.html`](../../../docs/problems/AUTHORING.html)**。 外部 contributor 向け quickstart は [`docs/problems/CONTRIBUTING.md`](../../../docs/problems/CONTRIBUTING.md)、 AI agent flow は [`docs/problems/AI-WORKFLOW.md`](../../../docs/problems/AI-WORKFLOW.md)。 1 dir = 1 問題、`metadata.json` + `template.yaml` の 2 file が必須、 portal plugin (= `portal/<Slot>.tsx`) は任意。

## 対話 flow (= ユーザーに順に訊く)

scaffold 生成の前に次を順番に聞き出す (= 答えが揃わないまま CLI を走らせない):

1. **問題タイトル + 1 行 description** — UI に出る name と shortDescription の素材。
2. **学習目標 (= learning goals)** — 「ユーザーが何を理解する?」 を bullet で 2〜3 つ。
3. **想定 difficulty + duration** — difficulty 1〜5、 duration は free string (`60〜90 分` 等)。
4. **scoring kind** — 下の決定木 / Step 0 を見て 6 種から 1 つに絞る。 迷っているうちは scaffold しない。
5. **scaffold + 編集ガイド** — `bun run scripts/tenkacloud-problem.ts create <id> --kind <kind>` で雛形を生成し、 残った `__PLACEHOLDER__` を上の回答で埋める。

決定木 (= scoring kind):

- 1 つの値 (= flag) を提出して終わる → `flag` (Challenge)
- 1 問で複数の独立 flag を個別提出して部分点採点する → `multi-flag` (Challenge)
- endpoint が 1 つ、 常時 200 で加点 → `uptime-flat` (Battle)
- 複数 endpoint、 全部同時 200 で加点 → `uptime-multi` (Battle)
- 時間経過で rule が変わる (= 移行 deadline 等) → `phased-polling` (Battle)
- 攻撃検知数で勝敗が決まる → `attack-detection` (Battle)

## ディレクトリ規約

```
problems/<category>/<id>/
├── metadata.json     # 必須: catalog 表示 + scoring engine + portal plugin 配線の正本
├── template.yaml     # 必須: CFn ペライチ (deploy 本体)
├── README.md         # 任意: 問題作者用 notes (= 競技者には見せない)
├── portal/           # 任意: ADR-012 Phase 5 plugin (= dashboard.slots で宣言した tsx)
│   ├── StatusPanel.tsx
│   └── RegistrationPanel.tsx
├── services/         # 任意: container-based 問題の docker-compose 等
├── api/              # 任意: server-side コード (Flask / Express / Hono 等)
├── frontend/         # 任意: 静的サイト
└── local/            # 任意: 開発資材
```

`<category>` は dir 命名上の分類 (現状 `battles/` と `challenges/`)。 metadata.json 内の `category` field が UI / pipeline の正本で **`Battle` か `Challenge` の 2 値**。

## Step 0 — kind を決める (= ADR-012 Phase 3 の核)

scoring engine は **問題の `metadata.scoring.kind` で 6 種** の評価ロジックを切り替える。 1 問題 1 kind。 最初に「この問題はどう採点するか」 を決める。

| kind                | カテゴリ        | 用途 / 採点ルール                                                                                                                                       |
| ------------------- | ---------------| ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag`              | Challenge      | 1 deploy で 1 回 flag 提出。 `CFn Outputs.flagOutputKey` の値と submitted flag を一致比較して `points` 加算。                                              |
| `multi-flag`        | Challenge      | 1 問題に N 個の独立 flag を持ち、 各 flag を個別提出して部分点を与える。 `flags[].points` の合計が満点。 単一 flag で足りるなら `flag` を使う。              |
| `uptime-flat`       | Battle (旧 `uptime`) | endpoint 群を 1 分毎に probe。 全 ok で `pointsPerSuccess` 加算、 fail で no-op or penalty。                                                              |
| `uptime-multi`      | Battle         | N slot probe。 **全 slot 同時 ok** で `pointsAllOk` 加算、 1 つでも fail で `failurePenalty`。 復旧優先度を持たせるゲーム性。                                |
| `phased-polling`    | Battle         | 時間経過 (`phases[].afterMinutes`) で score rule が変わる。 platform 自己申告 (`/meta`) を読んで EC2 / Lambda / ECS / App Runner 等に分類。 microservice 移行系。 |
| `attack-detection`  | Battle         | CFn Output 内 attack counter の差分で加点 (= `current - prev` × `pointsPerAttack`)。 SOC 想定。                                                            |

迷ったら次の質問: 「1 回提出で終わるか?」 → `flag`。 「1 問で複数の独立 flag を部分点採点するか?」 → `multi-flag`。 「endpoint が常に生きていることをスコアにするか?」 → `uptime-flat` or `uptime-multi`。 「途中で rule が変わるか?」 → `phased-polling`。 「攻撃検知数で勝敗が決まるか?」 → `attack-detection`。

## Step 1 — CLI で雛形生成 (推奨)

```bash
bun run scripts/tenkacloud-problem.ts create <id> --kind <kind> [--category Battle|Challenge]
```

例:

```bash
bun run scripts/tenkacloud-problem.ts create my-new-battle --kind uptime-multi
bun run scripts/tenkacloud-problem.ts create my-flag-challenge --kind flag
```

CLI が `.claude/templates/problems/<kind>/` から雛形 (= `metadata.json` + `template.yaml`) を copy し、 `<id>` で placeholder を置換する。 出力先は `problems/<category>/<id>/`。

CLI を使わず手書きする場合は `.claude/templates/problems/<kind>/` を参照しつつ Step 2 へ。

## Step 2 — 要件ヒアリング

ユーザーから / 文脈から次を集める。 不足はその場で訊く。

1. **category** — `Battle` (リアルタイム対戦) / `Challenge` (個別演習)
2. **id** — kebab-case 英小文字 (3〜32 文字)。 dir 名と一致
3. **name** — UI 表示名 (日本語可、 80 字以内)
4. **difficulty** — 1 (入門) 〜 5 (エキスパート)
5. **estimatedDuration** — 自由文字列 (例: `60〜90 分`)
6. **shortDescription** — カード用 1 行 (200 字以内)
7. **description** — 詳細ページ用の長文 (改行 OK)
8. **tags** — kebab-case
9. **exposedPorts** — deploy 後に競技者へ払い出す port 群
10. **learningGoals** — 想定学習目的の bullet
11. **scoring.kind** — Step 0 で決めた kind
12. **endpoints[]** — Battle なら宣言 (slot 名 + CFn output key)
13. **phases[]** — phased-polling 系で時間経過 rule を入れるなら宣言
14. **disruptions[]** — Phase 4 自動 fire スケジューラを bake するなら宣言
15. **dashboard.slots** — Phase 5 plugin を持たせるなら宣言 (`portal/<Slot>.tsx`)
16. **status** — 通常 `draft`、 review 通ったら `ready`

## Step 3 — `metadata.json` を書く

`problems/SCHEMA.json` に従う。 IDE 補完のため `$schema` を相対 path で先頭に置く。

各 kind の具体例は `.claude/templates/problems/<kind>/metadata.json` を直接参照。 6 kind 分すべて揃えてある。

### endpoints[] (= ADR-012 Phase 2 thick DSL)

Battle で endpoint を持つ問題は宣言する。 1 endpoint しか無くても slot 名を付ける (= 後で多 slot 拡張しやすい)。

```json
"endpoints": [
  {
    "slot": "frontend",
    "default": { "from": "cfn-output", "key": "FrontendUrl" },
    "overridable": true,
    "label": "Frontend (nginx)",
    "description": "競技者が公開する商品ページ。 WAF / CDN を被せて override 可。"
  }
]
```

### phases[] (= phased-polling 系)

時間経過で rule が変わる場合のみ。 each phase は `afterMinutes` で deploy 後の発火 offset を、 `effect` で scoring engine への指示を表す。

```json
"phases": [
  { "name": "degraded", "afterMinutes": 60, "effect": { "switchPlatformToDegraded": ["ec2"] } },
  { "name": "legacy",   "afterMinutes": 90, "effect": { "scorePathOverride": "/score?legacy=true" } }
]
```

### disruptions[] (= ADR-012 Phase 4 self-triggered Scheduler)

`template.yaml` 側に EventBridge Scheduler + Disruption Lambda を bake した場合、 portal 予告のために metadata 側でも宣言する。 `eventDetailType` は Phase 2 (= 別 ADR-013) future-facing。

```json
"disruptions": [
  {
    "id": "ec2-latency-injection",
    "name": "EC2 ネットワーク遅延注入",
    "eventDetailType": "DegradedDisruptionFired",
    "defaultAfterMinutes": 60,
    "operatorEditable": ["afterMinutes"],
    "parameters": { "delayMs": 200, "device": "eth0" },
    "description": "deploy 後 60 分で EC2 eth0 に tc qdisc 遅延 200ms を注入する。"
  }
]
```

### dashboard.slots (= ADR-012 Phase 5 plugin)

problem 固有 portal UI を持たせるなら宣言。 portal が `import.meta.glob` で discover し、 `React.lazy` で chunk 分割込みで render する。 値は問題 dir からの相対 path で `portal/<SlotName>.tsx`。 plugin の export 型は `@tenkacloud/portal-plugin-sdk` 参照。

```json
"dashboard": {
  "slots": {
    "StatusPanel": "portal/StatusPanel.tsx",
    "RegistrationPanel": "portal/RegistrationPanel.tsx"
  }
}
```

## Step 4 — `template.yaml` を書く

CFn ペライチ。 deploy pipeline がこの 1 file を競技者 account の CFn にアップロードする。

### 必須 Parameters

| Parameter         | 必須 | 用途                                                       |
| ----------------- | ---- | ---------------------------------------------------------- |
| `NamePrefix`      | ○    | `tc-{problemSlug}-{teamSlug}` 形式の共通リソース prefix    |
| `AllowedCidr`     | -    | 公開 port を許可する CIDR (default `0.0.0.0/0`)             |
| 問題固有          | -    | `DbPassword` / `DegradedAfterMinutes` 等、 自由に追加可    |

### 命名規約 (= 衝突回避)

同一 (Account, Region) に複数 team の stack が共存する。 **全リソース名 / タグ / Group 名は `${NamePrefix}` を冠する**。

### 必須 Outputs

UI / pipeline の hookup のため最低限:

- 競技者向け endpoint URL (`FrontendUrl` / `ApiUrl` / `BaseUrl` 等) — metadata `endpoints[].default.key` と一致させる
- 運営側 debug 識別子 (`InstanceId` 等)
- `NamePrefix` (= deploy 引数の echo)

scoring.kind 別の追加 Output:

- `flag`: `metadata.scoring.flagOutputKey` で指した key (= 正解 flag 値)
- `attack-detection`: `metadata.scoring.statsOutputKey` で指した key (= counter 値、 数値文字列)

## Step 5 — `portal/<Slot>.tsx` (任意、 ADR-012 Phase 5)

`dashboard.slots` で宣言した場合のみ。 plugin は **plain HTML + inline style** で書く (= Cloudscape は portal 本体側にあり、 plugin bundle には乗らない)。

```tsx
// problems/battles/<id>/portal/StatusPanel.tsx
import type { PortalSlotProps } from "@tenkacloud/portal-plugin-sdk";

export default function StatusPanel({ endpoints, phases, disruptions }: PortalSlotProps) {
  return (
    <section style={{ padding: "16px" }}>
      <h3>Custom Status Panel</h3>
      <ul>{endpoints.map((e) => <li key={e.slot}>{e.label}: {e.effectiveUrl}</li>)}</ul>
    </section>
  );
}
```

`PortalSlotProps` 型 + 予約 slot 名は `@tenkacloud/portal-plugin-sdk` 参照。

## Step 6 — 検証

```bash
make validate-problems  # = bun run scripts/validate-problems.ts (JSON Schema 適合)
bun run scripts/tenkacloud-problem.ts validate <id>  # = metadata + template.yaml の整合 (kind 別)
```

実 deploy の動作確認は競技者 account で:

```bash
aws cloudformation deploy \
  --template-file problems/<category>/<id>/template.yaml \
  --stack-name tc-<id>-test \
  --parameter-overrides NamePrefix=tc-<id>-test \
  --capabilities CAPABILITY_NAMED_IAM
```

## チェックリスト

- [ ] `metadata.json` の `id` が dir 名と完全一致
- [ ] `category` が `Battle` / `Challenge` (大文字始まり)
- [ ] `scoring.kind` が 6 種のいずれか
- [ ] `cfnTemplate` で参照する `template.yaml` が同 dir にある
- [ ] template.yaml の Parameters に `NamePrefix` を含む
- [ ] 全リソース名 / タグに `${NamePrefix}` が冠されている
- [ ] Outputs に competitor 向け URL + `NamePrefix` echo + scoring 用 key (= flag / counter) がある
- [ ] `endpoints[].default.key` が template.yaml の Outputs に存在する
- [ ] `make validate-problems` が通る
- [ ] `bun run scripts/tenkacloud-problem.ts validate <id>` が通る
- [ ] `status` は `draft` (= ready は別 PR で review 後)

## 参考

- 雛形 templates: [`.claude/templates/problems/<kind>/`](../../templates/problems/) — 6 kind 分の skeleton
- 外部 contributor quickstart: [`docs/problems/CONTRIBUTING.md`](../../../docs/problems/CONTRIBUTING.md) — 30 分 quickstart + decision tree + lifecycle + validation error 表
- 30 分 onboarding (= field reference): [`docs/problems/AUTHORING.html`](../../../docs/problems/AUTHORING.html)
- 既存 5 問題の design 振り返り: [`docs/problems/EXAMPLES.md`](../../../docs/problems/EXAMPLES.md)
- AI agent flow (= Claude Code / Codex CLI): [`docs/problems/AI-WORKFLOW.md`](../../../docs/problems/AI-WORKFLOW.md)
- App-to-Quest 参照仕様: [`references/app-to-quest/codewiki-adapter.md`](./references/app-to-quest/codewiki-adapter.md)
- スキーマ正本: [`problems/SCHEMA.json`](../../../problems/SCHEMA.json)
- 実例:
  - flag (Challenge): [`problems/challenges/hello-world/`](../../../problems/challenges/hello-world/)
  - uptime-flat (Battle): [`problems/battles/hello-world-battle/`](../../../problems/battles/hello-world-battle/)
  - uptime-multi (Battle): [`problems/battles/security-battle-royale/`](../../../problems/battles/security-battle-royale/)
  - phased-polling + disruptions + portal plugin: [`problems/battles/microservice-migration-battle/`](../../../problems/battles/microservice-migration-battle/)
- ADR-012: [`docs/architecture/adr-012-problem-plugin-architecture.html`](../../../docs/architecture/adr-012-problem-plugin-architecture.html)
- 競技者 account セットアップ: [`infrastructure/templates/README.md`](../../../infrastructure/templates/README.md)
