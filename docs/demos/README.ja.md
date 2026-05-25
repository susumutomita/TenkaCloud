# TenkaCloud デモスクリプト

> English: [README.md](./README.md)

このフォルダには、 初見の訪問者 / セールス会話 / 技術評価者向けのナレーション付きウォークスルーをまとめています。

聴衆と時間枠に合わせてスクリプトを選んでください。

| スクリプト                                                       | 聴衆                                       | 時間  | ゴール                                                        |
| ---------------------------------------------------------------- | ------------------------------------------ | ----- | ------------------------------------------------------------- |
| [`quickstart-5min.ja.md`](./quickstart-5min.ja.md)               | 初見の訪問者                               | 5 分  | clone → Lite mode deploy → 1 イベントを end-to-end で走らせる |
| [`sales-pitch-15min.ja.md`](./sales-pitch-15min.ja.md)           | セールス / コミュニティ運営 / プリセールス | 15 分 | 同じ流れにトークポイントと料金体系を添える                    |
| [`architecture-tour-30min.ja.md`](./architecture-tour-30min.ja.md) | 技術評価者 / CCoE                          | 30 分 | 4 plane の解説 + ADR 参照 + セキュリティ                      |

全スクリプトで同じデモ問題 (`hello-world` Challenge) を使うので、 1 度練習すれば複数の場面で録画を流用できます。

## どれを使うか

- **JAWS-UG / 勉強会の LT** → 5 分の quickstart。 5 分で live deploy は危険なので、 各ステップに「事前デプロイ済みを見せる」フォールバックを記載済み。
- **顧客とのセールス商談** → 15 分の pitch。 各ステップに「課題 → プロダクト適合」のトークポイントと料金 tier のヒントを付与。
- **CCoE / プラットフォームチームのレビュー** → 30 分の architecture tour。 4 plane / EventBridge 契約 / ADR 参照 / マルチクラウドロードマップまで網羅。

## 表記ルール

- 各ステップに番号を振り、 **想定時間** / **操作** / **何が起きたか** / **失敗時のフォールバック** をセットで記述。
- コマンドは Lite mode (`make deploy`) 前提。 SaaS mode にも触れるが、 デモのデフォルト経路ではない。
- ADR の引用は `ADR-NNN` 形式 (例 : 問題プラグイン構造は `ADR-012`)。 詳細は [`docs/architecture/`](../architecture/) を参照。
- 主張は TenkaCloud が現時点で出荷しているものに限定。「フル SOC2」「production-grade なマルチクラウド」のような断定は避ける。 進行中の項目は [`ROADMAP.md`](../../ROADMAP.md) を参照。

## 事前チェックリスト

トークの前に 1 度だけ走らせてください。

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make before-commit          # sanity check : lint と test を通す
make deploy                  # Lite mode、 約 10 分
```

AWS Console は対象アカウントを別タブに開いておきます。 live deploy が失敗したら、 各スクリプトに記載されたスクリーンショットにフォールバックします。

## 関連リンク

- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10 分のアーキテクチャ overview
- [`CONTRIBUTOR_MAP.md`](../../CONTRIBUTOR_MAP.md) — コントリビューター向けレシピ index
- [`problems/README.md`](../../problems/README.md) — 問題作成 overview
- [`ROADMAP.md`](../../ROADMAP.md) — 出荷済み / 進行中の差分
