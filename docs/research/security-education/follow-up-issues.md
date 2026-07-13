# TenkaCloud 取り込み Issue draft

この draft は、Issue #2603 で得た知見を TenkaCloud の正本へ取り込む
独立した作業単位です。このディレクトリの文書で完了する範囲だけを扱い、
未実装の product 機能や追加調査を backlog として増やさない。

## Title

`docs(education): define an evidence-based security curriculum`

## Body

### Summary

実際のセキュリティ演習体験と公式カリキュラムの比較から、TenkaCloud の
教育設計に使う共通記録、学習目標、前提関係、演習 pattern、評価境界、
初学者支援、ECU・OTA・cloud 統合コース原案を文書化する。

調査事実と実プレーを分離し、認証情報、個人情報、教材本文、完全な解答を
保存しない。#2600 の仮想車両 MVP へ反映できる checkpoint、metadata、
教育 graph、受入条件まで具体化する。

### Acceptance criteria

- [ ] 公式情報を確認した調査候補が 10 件以上ある。
- [ ] 優先して受講する対象が 3 件以上あり、選定理由と次の検証がある。
- [ ] 調査メタデータと Issue #2603 の見出しを含む共通記録がある。
- [ ] 認証と課金を使わない公開教材を 1 件以上実際にプレーした記録がある。
- [ ] 実プレーの範囲、操作証拠、未確認範囲、著作物の境界が明示されている。
- [ ] 学習目標、skill map、prerequisite graph、exercise pattern がある。
- [ ] 自動採点、人手評価、複合評価の境界がある。
- [ ] 良い設計、採用しない設計、初学者の詰まりと対策がある。
- [ ] ECU・OTA・cloud 統合コースの module、演習、評価、目安時間がある。
- [ ] #2600 MVP の初期状態、checkpoint、教育 graph、受入条件がある。
- [ ] 情報源の確認日と公式 URL があり、教材本文や完全な解答を転載していない。

### Files

- `docs/research/security-education/README.md`
- `docs/research/security-education/record-template.md`
- `docs/research/security-education/played/google-gruyere.md`
- `docs/research/security-education/follow-up-issues.md`

### Related issues

- Research source: #2603
- MVP application: #2600

### Regression analysis

文書だけを追加する。runtime、API、IAM、CloudFormation、既存 problem metadata
の挙動は変更しない。既存の problem authoring 契約に沿うよう、#2600 案では
`multi-verify`、progressive Hint、教育 graph の既存 schema を参照する。

### Physical impact

CloudFormation: NO-OP。AWS resource、local runtime、package dependency を
追加しない。

### Test plan

- `make harness`
- `make before-commit`
- Markdown link、見出し、表、Mermaid の review
- 候補数、優先数、Issue #2603 完了条件との対応を review

## 発番後の PR body 更新

root agent がこの draft を GitHub Issue として登録した後、PR body に
`Closes #2603` と新しい Issue の `Closes #<number>` を記載する。
このファイルへ発番結果を追記する必要はない。
