---
name: pitchdeck
description: TenkaCloud のピッチデッキ (単一 HTML、自己完結) を「今のリポジトリの実態」から再生成する。問題カタログ数 / scoring kind / 障害注入の実証状況 / ADR の採択状況を読み取り、誇張せず（ハリボテ禁止）に landing/pitch/index.html を最新化する。登壇・営業・コミュニティ説明の前に `/pitchdeck` で更新する。
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git grep:*), Bash(git log:*), Bash(ls:*)
---

# pitchdeck — 「常に最新のコンテンツ状態」を提示するデッキ生成

TenkaCloud のピッチデッキを **リポジトリの今の実態から** 再生成する skill。出力は
`landing/pitch/index.html`（自己完結の単一 HTML、GitHub Pages で
`https://susumutomita.github.io/TenkaCloud/pitch/` に配信される）。codewiki と同じ発想で、
「聞かれたときに最新の状態を出す」 ために毎回ソースを読み直して数字と実証状況を更新する。

正本（誇張しないための事実ソース）:

- 位置づけ / タグライン: [`README.md`](../../../README.md) 冒頭、[`landing/llms.txt`](../../../landing/llms.txt)
- 問題カタログ: `problems/<category>/<id>/metadata.json`（submodule。実体は
  `/Users/susumu/product/TenkaCloudChallenge` の clone 側にあることが多い）
- 採点エンジン: `infrastructure/lib/problem-deploy/handlers/generic-scoring-handler/kinds/*.ts`
- 障害注入 (赤チーム): `infrastructure/lib/problem-deploy/handlers/disruption-executor-handler/`、
  `disruption-executor-lambda.ts`、ADR-029/031/033/034
- 旗艦シナリオ StackStack: `problems/battles/stackstack/README.ja.md` + `metadata.json`

## 鉄則 — ハリボテを「完成」と書かない

公開ピッチに載せる前に、各主張を必ず実態でラベル付けする。

- `[実証済]` — E2E でテスト済み / 実際に動かして確認した（例: hello-world-battle の
  frontend-down 注入 → 減点 → 自動復帰）。
- `[実装済]` — handler の code path + テストが実在し、proven な機構と同型（例: StackStack の
  組織イベント = SSM 注入 2 + 採点減点 3、いずれも実装済。残るは本番イベントでの通し検証）。
- `[実装中]` — handler の code path が未完のもの（例: inter-team coordination plugin）。
- `[構想]` — ADR で却下/将来扱い（例: provider federation の Azure/GCP runtime）。

**ADR の Status badge を鵜呑みにしない。** badge が `Proposed` のままでも実装は出荷済のことがある
（例: ADR-033 の採点側 disruption 効果は `disruption-effects.ts` + dispatcher 配線 + テストとして
**#1668 で出荷済**だが、HTML の badge は一時 `Proposed` のまま残っていた）。判定は必ず
**handler の code path（関数 + テスト）の実在**で行い、badge は補助情報として扱う。metadata.json に
`effect`/`action` の宣言があっても、対応する code path が無ければ `[実証済]`/`[実装済]` にしない。

## 手順

1. **事実収集**（読み取りのみ）
   - 問題カタログを列挙し、カテゴリ別・kind 別の件数、disruptions を宣言している問題数を数える。
   - 採点 kind を 5 種列挙し、カタログで実使用されている kind を数える。
   - 障害注入の実証状況を確認（fire→EventBridge→executor→SSM SendCommand→auto-revert の
     どこまでが E2E か、failurePenalty の対応 kind）。
   - 関連 ADR の Status を grep（特に ADR-033）。
   - README / llms.txt から最新のタグラインを引く。
2. **数字を差し込んで再生成**
   - 下記「デッキの背骨」を固定の物語として保ち、件数・kind・実証ラベルだけを最新値に置換する。
   - 日本語を主言語にする（BootCamp / 国内コミュニティ想定）。英語併記は任意。
   - スタイルは landing のブランドトークンに合わせる（ink `#07111f` / blue `#0969da` /
     green `#008a55`、font は Inter + Noto Sans JP 系、すべて inline `<style>`・外部依存なし）。
     ネットワークが無くても登壇で崩れないよう web font fetch はしない（system fallback に倒す）。
3. **検証**
   - HTML が単一ファイルで完結し、外部 asset 参照が無いことを確認。
   - 主張ラベル（実証済/実装中/構想）が事実ソースと一致することを確認。
4. **公開はユーザー判断**
   - ファイルを working tree に生成するところまで。commit / push（= 公開）はユーザーに確認する。
     `landing/**` への push は Pages を更新する outward-facing 操作なので勝手に出さない。

## デッキの背骨（固定の物語、数字だけ最新化）

1. **タイトル** — TenkaCloud / 「AI 時代の GameDay を作る競技基盤」/ 旗艦 StackStack / 登壇情報。
2. **課題（Vibe Coding 時代）** — 「AI で作れる。でも認証・セキュリティで“公開”できない」 ラストワンマイル。
3. **TenkaCloud とは** — 本物の AWS でクラウド演習を回す OSS。Battle / Challenge。moat = 問題はプラグイン。
4. **仕組み（90 秒）** — 各チームの隔離 AWS に CFn を deploy（AssumeRole+ExternalId）→ 毎分 probe → leaderboard。Lite は ~10–30 分。
5. **StackStack（旗艦）** — AI→Production ラストワンマイル。5 統制軸表、EC2 100pt→managed 1000pt→全 managed +30,000pt、phases。
6. **赤チーム / 障害注入 — 実態** — hello-world-battle で `[実証済]`。StackStack の組織イベント減点は `[実装中]`（ADR-033）。
7. **今動くもの（正直な棚卸し）** — カタログ件数・kind・disruption・分離・Lite/SaaS を実証ラベル付きで。
8. **BootCamp で検証したいこと** — Vibe Coder がどこで詰まるか / どの体験が刺さるか / StackStack を解いてもらう。
9. **次の一手** — ADR-033 を仕上げて StackStack 完全 demo 化、初見で問題を作れるオーサリング整備、federation。
10. **クローズ** — Apache-2.0 / self-hostable / 問題を一緒に作る CTA + リンク。

## 出力先

- `landing/pitch/index.html` — 単一ファイル。Pages で `/TenkaCloud/pitch/` に出る。
