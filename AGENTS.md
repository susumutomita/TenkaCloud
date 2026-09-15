# TenkaCloud の作業ルール

本体はこのリポジトリ、問題は `problems/` (TenkaCloudChallenge) が正本です。
構成と担当コードは[開発者マニュアル](./apps/developer-portal/src/app/developers/docs/manual/developer/page.ja.mdx)を、必要な範囲だけ参照してください。

## 進め方

- 依頼・Issue と既存コード・テストから、何ができれば完了かを確認する。履歴で分かることは調べる。
- 新しい処理・テーブル・権限・設定を足す前に、使える既存実装を探す。
- 手順は作業に合わせる。専用計画書、固定の役割分担・人数、TDD の順序は必須ではない。複雑な境界や移行だけ、独立した検証を検討する。
- 1 つの動作に必要な画面・API・基盤の変更をまとめ、利用者が結果を確認できる状態にする。

## 守ること

- テナント分離、Cognito/JWT 認証、必須の `ExternalId`、必要最小限の IAM 権限を保つ。
- `competitor-bootstrap.yaml` の `AdministratorAccess` は競技者アカウントの初期設定だけの例外。他のロールへ広げない。
- EventBridge、テナント作成、`DeployCreateRequested`、`runtime-config.json` の契約を変えるときは、送信側と受信側を同じ PR で確認する。
- Lite/SaaS、DynamoDB/Turso の違いと継続費用を確認する。保存先の切り替えでデータが自動移行されると考えない。
- 破壊的操作、リリース、共有環境の変更、秘密情報へのアクセスは明示的な承認の範囲内で行う。
- テスト・型・lint・coverage・設定を、通すためだけに弱めない。規則自体が原因なら、根拠と回帰確認を伴って直す。
- エラーを空値・mock・黙った代替処理・偽の成功で隠さない。

## 完了の確認

- commit 前に `make before-commit` を通す。
- 変更点、実行した検証、未確認事項を報告する。実 AWS・実機・外部サービスでしかできない確認は merge の必須条件にせず、任意のイベントリハーサルとして記録する。未実施だけで開発 Issue を残さない。
