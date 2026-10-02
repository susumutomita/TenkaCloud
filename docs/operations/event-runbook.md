# イベント運用 Runbook

リリース前の統合 candidate 用です。`make local` で同じ大会・チームのシステムを起動し、
`make down` でデータを保持して停止します。SaaS/Lite の基盤構築手順ではありません。
`make deploy` は権限設定を確認して現行 CLI を実行します。`make destroy` は所有対象を確認して基盤とデフォルトの所有データを削除します。外部 Turso の行は残し、`make destroy-all` で明示的にリセットします。問題環境は大会の Teardown または `--drain-events` で撤収します。現行クラウドは hello-world の限定 CLI アクセスと組み込みの Cryptography Battle に対応します。Docker / Compose 問題はローカル開催専用で、クラウドの候補には表示しません。DynamoDB Local での Battle 一斉更新は 100 人で 5.910 秒となり、5 秒の更新間隔を超えています。AWS の測定値ではありません。
Lambda / DynamoDB によるクラウド開催を復旧中です。AWS サービスの問題はクラウド開催専用です。

## 開催前

- ソースと問題カタログの revision、担当者、開催時間、連絡経路、撤収担当を記録する
- [起動手順](../local-hosting.md)で初期 Admin を作り、運営担当には Operator、参照担当には Viewer を用意する
- private なデータディレクトリと整合したバックアップを用意し、1 つのプロセスだけが所有する
- 実際の問題・チーム数で環境を配置し、正答、誤答、ヒント、得点、再起動、撤収を確認する
- Docker カタログの表示件数だけを全問のプレイ確認として扱わない。terminal と実 Docker・ブラウザの未確認経路を記録する
- 実 AWS で任意のリハーサルを行う場合は、対象アカウント、region、資源、費用、権限変更と削除を事前に承認する。未実施だけを開発完了の阻害とは扱わない
- 競技者アカウントに `infrastructure/templates/competitor-bootstrap.yaml` を使い、表示された運営アカウント、role 名、ExternalId を合わせて接続を検証する
- Organizations の一括配布と個別設定は[導入手順](../competitor-account-onboarding.md)を使う。別アカウント、または同一アカウントの別 region をチームへ割り当てる。IAM role は global のため bootstrap を複数 region に重複配置しない
- 参加者用 role と配置 role を分離し、初期設定の AdministratorAccess を参加者へ配らない
- 大会・チームの参加キーを安全に配布する。任意の[自己登録](participant-self-registration.md)は準備済みチームの割り当てであり、環境の自動作成ではない

## 開催中

1. ローカルでは各チームの停止状態の Docker jobs を確認してから Schedule で開始する。クラウドでは現行 catalog の hello-world または組み込み Cryptography Battle を使う
2. 参加者のログイン、Start / resume と Stop (keep data)、最初の解答・得点を確認する
3. 障害は承認した対象だけへ実行し、SSM の結果と実際のサービス状態を分けて確認する
4. 失敗時はエラー、対象、時刻を記録し、所有情報を保持したまま対象の操作を再試行する
5. キーや認証情報をログ、画面共有、報告へ貼らない

## Docker の同時起動と保持

新しい大会は停止状態の jobs を最大 512 件準備し、参加者が必要な問題を起動します。
既存大会は従来の lifecycle を維持します。デフォルトはチームごとに 3 環境、host 全体で 12 環境、
コンテナに設定されたメモリー上限の合計 4096 MiB です。40 個の gateway 枠は起動中の環境だけに使います。
制限に達した場合は利用者が不要な環境を停止します。自動退避や初期化は行いません。

新しい Compose 計画は作問者の上限を保持し、未指定なら 512 MiB、1 CPU、256 PIDs を補います。
受付制限の変更は `LOCAL_ARGS` の `--max-active-per-team`、`--max-active-environments`、
`--container-memory-mib` を使います。詳細は[容量の前提](../local-play-requirements.md)を参照してください。
100 jobs・105 runtime ports の synthetic テストは割り当てと lifecycle の確認であり、実 Docker の性能測定ではありません。
PostgreSQL terminal は実 Docker とブラウザで接続・3 checkpoints の採点・チーム分離・停止再開後の 7 行の保持を確認済みです。
全 106 問と terminal 全 15 種の確認を意味しません。

## 採点と障害の切り分け

- 全体停止: プロセス、DB、開催時刻、lock、期限、実行中の操作を確認する
- 1 つのチームだけ停止: その問題環境、verifier、endpoint 登録、準備完了を確認する
- AWS 接続失敗: operator の権限、登録 role、必須 ExternalId、対象 stack の状態を確認する
- Battle: 両 endpoint 正常で一周期 +100、いずれか失敗で -100。URL 未登録・初期準備前は得点しない
- revert command 完了だけで復旧と判断しない。元の環境を対象に実際の健康状態を確認する

## 終了・停止・撤収は別

End Event は採点を止めます。発行済み AWS セッションの即時失効やリソース削除は保証しません。
環境を撤収するときは、コンソールから所有する環境を teardown し、Docker / CloudFormation
の削除結果を確認します。不明・失敗を成功扱いせず、所有記録を保持して対応します。

通常の停止は `make down` です。DB、得点、キー、Docker のデータを保持します。
再開は同じディレクトリで `make local` を使います。新しい Docker jobs は参加者が再開するまで停止したままです。
書き込みレイヤーと volume は保持しますが、RAM は保持しません。大会の時計はリセットしません。
AWS の問題 stack はローカル停止では削除されません。環境を所有している DB やキーを先に消さないでください。
