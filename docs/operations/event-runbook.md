# イベント運用 Runbook

リリース前の統合 candidate 用です。`make local` で同じ大会・チームのシステムを起動し、
`make down` でデータを保持して停止します。SaaS/SBT のテナント構築は行いません。
`make deploy` は権限設定を確認して現行 CLI を実行します。`make destroy` は所有対象を確認して基盤とデフォルトの所有データを削除します。外部 Turso の行は残し、`make destroy-all` で明示的にリセットします。基盤の削除前に大会の Teardown で問題環境を撤収します。`--drain-events` は旧 cloud-v1 専用で、この版は拒否します。クラウドは旧 Lite の汎用 CloudFormation 配置、flag / multi-flag・定期採点、参加者 Console / CLI と組み込み coordination を再利用します。Docker / Compose 問題はローカル開催専用で、クラウドの候補には表示しません。両 DB とも 99 チーム、SQL coordination は 4 MiB 上限です。実 AWS・hosted Turso の大会性能は未検証です。
クラウドは Lambda と選択した Turso / DynamoDB を使います。AWS サービスの問題はクラウド開催専用です。

catalog pin のない旧 Lite 環境は、resource / schema の検査後、bootstrap・source upload・配置の前に、進行中の大会がないことを初回だけ明示確認します。開催中の大会は完了まで配置済みの版で継続してください。大会が残っていないことを運用者が確認してから対話で承認し、非対話の更新には `CLOUD_ARGS="--confirm-no-active-events"` を使います。通常の `--yes` ではこの確認を省略できません。legacy catalog key だけでは安全な更新を証明できず、過去のデータも自動移行しません。新規環境と復旧済み環境は通常の `make deploy` で自動配置します。

## 開催前

- 問題ソースの取得は `make submodule-latest`、検証は `make validate-problems` を使う。稼働環境への反映は別で、ローカルは[再ビルド・再起動](../local-hosting.md#update-the-problem-catalog)、クラウドは[既存環境の更新](../../infrastructure/README.md#update-the-problem-catalog)を行う。開催中の問題差し替えは避け、再開予定の大会には元の問題ソースと実行 revision を保持する
- ソースと問題カタログの revision、担当者、開催時間、連絡経路、撤収担当を記録する
- ローカルは[起動手順](../local-hosting.md)の主催者キーでログインする。クラウドは Cognito の開催者を準備し、役割を確認する
- private なデータディレクトリと整合したバックアップを用意し、1 つのプロセスだけが所有する
- 実際の問題・チーム数で環境を配置し、正答、誤答、ヒント、得点、再起動、撤収を確認する
- Docker カタログの表示件数だけを全問のプレイ確認として扱わない。terminal と実 Docker・ブラウザの未確認経路を記録する
- 実 AWS で任意のリハーサルを行う場合は、対象アカウント、region、資源、費用、権限変更と削除を事前に承認する。未実施だけを開発完了の阻害とは扱わない
- 競技者アカウントに `infrastructure/templates/competitor-bootstrap.yaml` を使い、表示された運営アカウント、role 名、ExternalId を合わせて接続を検証する
- Organizations の一括配布と個別設定は[導入手順](../competitor-account-onboarding.md)を使う。別の競技者アカウント、または同一の競技者アカウントの別 region をチームへ割り当てる。自分で行う自己検証では、イベント作成・キー発行前にリスクを確認すると開催用アカウントも選択できる。同意はイベント単位で保存し、参加者 STS も確認する。問題用・参加者用ロールが基盤の設定やデータへ到達し得るため、第三者が参加する本格開催には別アカウントを推奨する。同一競技者アカウントの別 region は機能として対応するが、完全な IAM 分離の証明ではなく、catalog の IAM 監査には未解決事項がある。IAM role は global のため bootstrap を複数 region に重複配置しない
- 参加者用 role と配置 role を分離し、初期設定の AdministratorAccess を参加者へ配らない
- 大会・チームの参加キーを安全に配布する。任意の[自己登録](participant-self-registration.md)は準備済みチームの割り当てであり、環境の自動作成ではない

## 開催中

1. ローカルでは各チームの停止状態の Docker jobs を確認してから Schedule で開始する。クラウドでは選択した AWS 問題または組み込み Battle をリハーサルする。現行 catalog の 9 template は TemplateBody の 51,200 bytes 上限を超えるため、この配置経路では未対応
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
