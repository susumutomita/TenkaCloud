import type { Maturity } from "@/lib/maturity";

// This typed registry feeds the docs sidebar, search, and route validation. Until
// the Fumadocs swap (tracked as a follow-up), it is
// the single source of truth that drives the docs sidebar, the search index, and
// the build-time link checker. Each entry maps a route slug to a real MDX file
// under src/app/developers/docs and carries searchable text.

export interface DocHeading {
  readonly id: string;
  readonly text: string;
}

export interface DocPage {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly maturity: Maturity;
  readonly section: string;
  // Searchable body text (plain prose extracted from the MDX) plus headings.
  readonly headings: readonly DocHeading[];
  readonly body: string;
}

export interface DocSection {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "getting-started",
    href: "/developers/docs/getting-started/",
    title: "Getting started",
    description:
      "Start a local event, join a team and stop without deleting data; cloud deployment remains incomplete.",
    maturity: "preview",
    section: "Start here",
    headings: [
      {
        id: "local-start",
        text: "Start a local competition",
      },
      {
        id: "first-event",
        text: "Create and play an event",
      },
      {
        id: "stop-and-resume",
        text: "Stop and resume without resetting data",
      },
      {
        id: "cloud-status",
        text: "Cloud deployment status",
      },
      {
        id: "books-and-compatibility",
        text: "Books and compatibility",
      },
    ],
    body: 'Getting started This documents the unpublished integration candidate. Local event/team operation is implemented; cloud platform deployment and complete catalog playability are not verified release claims. Start a local competition Use the reviewed checkout, Bun 1.3.11 and its pinned problem submodule on macOS or Linux (including WSL2). Docker Engine with Compose is needed for Docker exercises. Run from the repository root: The default organizer URL is http://127.0.0.1:5174; the participant URL is http://127.0.0.1:5175. Use the URLs printed by the process. Sign in with the organizer key only; no username or password is needed. Each interactive make local start displays a new key once and revokes the previous organizer key and sessions. To rotate it while running, use make local-reset in another interactive terminal with the same data directory. Events, scores, participant keys and problem data are preserved. Noninteractive and public/container starts retain existing keys without printing them to logs. Create and play an event 1. In the organizer console, create an event, its teams and selected problems. 2. Prepare the selected jobs and inspect every result. New Docker jobs are dormant until a participant starts them; AWS exercises keep their deployment flow. 3. Start the event from Schedule and give each team its own invitation or key. 4. Open the participant portal with that key. For Docker, choose Start / resume, read and solve the problem, then check the score. Use Stop (keep data) when finished with that environment. This is one competition system for organizers and participants. There is no separate individual-practice login. Docker catalog/workbench restoration is in progress: catalog visibility is not proof that all 106 problems, terminals or real Docker browser routes have passed. Stop and resume without resetting data In another terminal, from the same checkout: make down stops the managed local process and owned Docker runtimes while preserving the database, scores, keys and Docker data. It does not end the event or remove AWS exercise stacks. The next start restores retained event data; new on-demand Docker jobs remain stopped until participants resume them. Writable layers and volumes survive Stop, but RAM does not. The event clock is not reset. End Event stops scoring; explicit environment teardown removes owned environments. Keep the data directory until cleanup succeeds. Options use LOCAL_ARGS, for example make local LOCAL_ARGS="--no-build". When using a custom --data directory, pass the same directory to make down. Cloud deployment status make deploy and make destroy use the current Lambda/DynamoDB CLI after reviewed IAM setup. The supported cloud problems are hello-world with scoped CLI access and native Cryptography Battle; destroy confirms targets and retains event data. Lambda/DynamoDB hosting is in progress; this is not a verified zero-cost deployment. AWS-service problems are cloud-only. Docker/Compose exercises are local-only and are not listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second refresh interval. The cloud pipeline defaults to the current CLI; review its source settings and deployment role before starting a build. Codespaces forwarded-origin and exercise routing have not been verified for this candidate. Use the local checkout procedure above until that path has its own evidence. Next: organizer manual, participant manual and deployment boundaries. Books and compatibility 自分で作るクラウド競技 and Build Your Own Cloud Competition explain the teaching examples and design. The source of truth for current behaviour is this documentation and its matching checkout. The published book still has legacy setup instructions; docs/book-compatibility.md records the required command, scoring and runtime corrections without changing the external book. はじめに 未公開の統合 candidate の手順です。ローカルの大会・チーム運用は実装されていますが、クラウド基盤の配置や全カタログのプレイ確認が完了した公開版ではありません。 ローカル競技を起動する 確認対象の checkout、Bun 1.3.11、固定した問題 submodule を使います。macOS または Linux（WSL2 を含む）が対象です。Docker 問題には Docker Engine と Compose が必要です。リポジトリのルートで実行します。 既定の開催者 URL は http://127.0.0.1:5174、参加者 URL は http://127.0.0.1:5175 です。実際にはプロセスが表示した URL を使います。主催者キーだけでログインし、ユーザー名・パスワードは使いません。対話ターミナルで make local を起動するたびに新しいキーを一度だけ表示し、以前の主催者キーとログインを失効させます。起動中の再発行は、別の対話ターミナルで同じデータディレクトリを指定して make local-reset を実行します。大会・得点・参加者キー・問題のデータを保持します。非対話起動と public/container 起動では既存のキーを保持し、ログにキーを出力しません。 大会を作成して参加する 1. 開催者コンソールで大会、チーム、出題する問題を選びます。 2. jobs を準備し、チームごとの結果を確認します。新しい Docker jobs は参加者が起動するまで停止状態です。AWS 問題は配置手順を使います。 3. Schedule から大会を開始し、各チームへ専用の参加リンクまたはキーを渡します。 4. 参加者ポータルへそのキーで入ります。Docker は Start / resume で起動し、問題文、操作、得点まで確認します。使い終えた環境は Stop (keep data) で停止します。 開催者と参加者が使う一つの競技システムです。個人練習専用のログインはありません。Docker カタログと workbench の復旧は進行中です。106 問が一覧に出ることと、terminal や実 Docker のブラウザ操作まで全問確認済みであることは別です。 データを消さず停止・再開する 同じ checkout の別端末で実行します。 make down は管理対象のローカルプロセスと所有する Docker 環境を止め、DB、得点、キー、Docker のデータを保持します。大会の終了や AWS 問題 stack の削除は行いません。make local 後も、新しいオンデマンドの Docker jobs は参加者が再開するまで停止したままです。書き込みレイヤーと volume は保持しますが、RAM は保持しません。再起動しても大会の時刻はリセットされません。End Event は採点を止め、環境の teardown は所有する環境を削除します。削除が完了するまでデータディレクトリを消さないでください。 起動オプションは LOCAL_ARGS へ渡します。例は make local LOCAL_ARGS="--no-build" です。--data を指定した場合、make down にも同じディレクトリを指定します。 クラウド配置の状態 make deploy と make destroy は権限設定を確認したうえで、この版の Lambda/DynamoDB CLI を実行します。現在のクラウド問題は限定 CLI を使う hello-world と組み込みの Cryptography Battle です。撤収時に対象を確認し、大会データは保持します。Lambda/DynamoDB によるクラウド開催は検証中で、費用ゼロを保証していません。AWS サービスの問題はクラウド開催専用です。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。cloud pipeline は現行 CLI を既定で使います。build を始める前にソース設定と配置 role を確認してください。 Codespaces の転送 URL と問題接続は、この candidate では未確認です。確認記録ができるまでは上のローカル手順を使ってください。 次は開催者マニュアル、参加者マニュアル、配置の境界です。 書籍と互換性 自分で作るクラウド競技と Build Your Own Cloud Competitionは、 教材と設計の背景を説明します。現行の挙動の正本はこのドキュメントと対応する checkout です。 公開済み書籍には旧版の構築手順が残っています。docs/book-compatibility.md に コマンド、採点、runtime の修正点を記録しています。外部の書籍は変更していません。',
  },
  {
    slug: "manual",
    href: "/developers/docs/manual/",
    title: "Manuals by role",
    description:
      "Choose the developer, competition organizer, participant, or problem-author path.",
    maturity: "preview",
    section: "Role manuals",
    headings: [
      {
        id: "choose-your-role",
        text: "Choose your role",
      },
      {
        id: "how-the-roles-fit-together",
        text: "How the roles fit together",
      },
      {
        id: "if-you-are-unsure",
        text: "If you are unsure",
      },
    ],
    body: "Manuals by role Choose your role - Organizer: prepare teams, environments, invitations, scoring and cleanup - Participant: join your team and solve its assigned problems - Problem author: write content and verify the participant route - Developer: change the implementation and its tests How the roles fit together One local process serves organizer and participant applications, persists event/team state and controls owned exercise environments. Organizer permissions and team authentication are separate. Authors own catalog content; schema acceptance alone does not establish runtime support. If you are unsure Start with getting started. The candidate has no current SaaS/Lite setup path; cloud deploy/destroy remain unimplemented. 役割別マニュアル 役割から選ぶ - 開催者: チーム、環境、参加リンク、採点、撤収を準備する - 参加者: 自分のチームへ参加して問題を解く - 問題作成者: 教材と参加者の操作経路を作る - 開発者: 実装とテストを変更する 役割の関係 一つのローカルプロセスが開催者・参加者の画面を配信し、大会・チームの状態を保存して、所有する問題環境を操作します。開催者の権限と参加チームの認証は別です。問題の内容はカタログが管理します。schema の検証成功だけでは実行対応を証明できません。 迷った場合 はじめにから進めてください。現行 candidate に SaaS/Lite の構築手順はありません。クラウドの deploy/destroy は未実装です。",
  },
  {
    slug: "manual/developer",
    href: "/developers/docs/manual/developer/",
    title: "Developer manual",
    description: "Repository setup, code ownership, checks, and configuration boundaries.",
    maturity: "preview",
    section: "Role manuals",
    headings: [
      {
        id: "prepare-and-run",
        text: "Prepare and run",
      },
      {
        id: "code-ownership",
        text: "Code ownership",
      },
      {
        id: "verify",
        text: "Verify",
      },
    ],
    body: 'Developer manual The current branch is a draft local/cloud integration candidate. Start with the CONTRIBUTING.md and docs/host-retirement.md. Existing SaaS/Lite installations use a pinned old checkout; this branch does not migrate or remove their resources. Prepare and run Bun 1.3.11 is pinned. The host serves the organizer and participant applications and persists competition state in SQLite. Use a private dedicated data directory. Docker problem execution requires Docker; the built-in Battle runs in Bun. AWS-service problems are cloud-only. Lambda/DynamoDB hosting and the full cloud lifecycle remain under verification. Code ownership | Area | Source | | --- | --- | | HTTP host, durable state, authentication and runtime adapters | scripts/local-host/ | | Docker verifier/scoring/Compose helpers | scripts/local-host/container/ | | Shared pure helpers and ExternalId boundary | scripts/lib/ | | Cloud API, durable work and CDK resources | infrastructure/lib/cloud-hosting/, infrastructure/lib/problem-deploy/ | | Organizer application | apps/application-admin-console/ | | Participant application | apps/participant-portal/ | | Pack authoring and immutable local store | scripts/problem-pack/ | | Public contracts and author tools | packages/ | | Catalog content and CloudFormation templates | pinned problems/ submodule | | Competitor account initialization | infrastructure/templates/competitor-bootstrap.yaml | Verify Run bun run test:host, bun run test:authoring, bun run typecheck and make before-commit. Keep existing lint and coverage thresholds. Test the real HTTP/SQLite path for state and authorization changes. Follow the docs/host-build-verification.md for distribution changes. Record browser and optional live AWS/IdP evidence separately; local tests do not prove external account access. make down preserves local event and Docker data. Cloud make deploy / make destroy call the existing CLI with reviewed AWS setup and ownership-checked teardown. The current cloud catalog includes hello-world with scoped CLI access and native Cryptography Battle. Docker/Compose exercises are local-only and are not listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second refresh interval. Use CLOUD_ARGS="--help" to inspect either command without AWS access. 開発者マニュアル 現在のブランチはローカル・クラウド開催を統合検証中の Draft です。 CONTRIBUTING.mdと docs/host-retirement.mdを確認してください。 データの自動移行は行いません。 準備と起動 Bun 1.3.11 を使います。host は開催者・参加者アプリを配信し、競技状態を SQLite に保存します。 専用の非公開データディレクトリを用意してください。 ローカルの Docker 問題には Docker が必要です。AWS サービスの問題はクラウド開催専用です。 Lambda/DynamoDB によるクラウド開催と配置・撤収は検証中です。 組み込みの Battle は Bun で動作します。 担当コード | 領域 | ソース | | --- | --- | | HTTP、永続化、認証、実行アダプター | scripts/local-host/ | | Docker の検証・採点・Compose | scripts/local-host/container/ | | 共通の純粋な処理と ExternalId | scripts/lib/ | | クラウド API、永続化した処理、CDK 基盤 | infrastructure/lib/cloud-hosting/、infrastructure/lib/problem-deploy/ | | 開催者アプリ | apps/application-admin-console/ | | 参加者アプリ | apps/participant-portal/ | | pack 作成・検証・保存 | scripts/problem-pack/ | | 公開 SDK と作者向けツール | packages/ | | 問題コンテンツと CloudFormation | pin した problems/ submodule | | 競技者アカウントの初期設定 | infrastructure/templates/competitor-bootstrap.yaml | 確認 bun run test:host、bun run test:authoring、bun run typecheck と make before-commit を実行します。既存の lint と coverage の基準を維持してください。 永続化や認証の変更は実 HTTP/SQLite 経路で確認します。 配布に関わる変更では docs/host-build-verification.md も確認します。ブラウザ検証と任意の実 AWS・IdP 検証は、ローカルテストと分けて報告します。 make down は大会と Docker のデータを保持します。クラウドの make deploy / make destroy は、権限設定と所有対象を確認する既存 CLI を実行します。現在は限定 CLI を使う hello-world と組み込みの Cryptography Battle に対応します。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。CLOUD_ARGS="--help" で AWS に接続せず説明を確認できます。',
  },
  {
    slug: "manual/organizer",
    href: "/developers/docs/manual/organizer/",
    title: "Competition organizer manual",
    description:
      "Prepare local events, approved AWS exercises, invitations, scoring and ownership-aware cleanup.",
    maturity: "preview",
    section: "Role manuals",
    headings: [
      {
        id: "prepare-local-host",
        text: "Prepare the local host",
      },
      {
        id: "run-the-event",
        text: "Run the event",
      },
      {
        id: "aws-problems",
        text: "Optional AWS problems",
      },
      {
        id: "storage-and-shutdown",
        text: "Storage and shutdown",
      },
    ],
    body: 'Competition organizer manual This documents the unpublished integration candidate. Local event/team operation is implemented; cloud platform deployment and complete catalog playability are not verified release claims. Prepare the local host Follow getting started with make local. Keep one process per private data directory. Sign in with the organizer key only; no username, password or local SAML account is needed. Each interactive make local start displays a new organizer key once. To rotate it while running, use make local-reset in another interactive terminal with the same data directory. Both revoke previous organizer keys and sessions while preserving events, scores, progress, participant keys and problem data. Noninteractive and public/container starts retain existing keys without printing them to logs. Run the event Create teams and select problems, prepare dormant Docker jobs, inspect failures, then start the schedule. Participants start each Docker environment when needed; AWS deployment remains a separate operation. Distribute each team\'s invitation only to that team. Rehearse correct and incorrect submissions, hints, scores, one team\'s failure, restart and teardown. End Event stops scoring; it does not prove resources were removed. All 106 former local problems are intended to become Challenge competitions. The generic catalog/workbench is implemented. Real Docker/browser checks covered SQL access and a PostgreSQL terminal, three checkpoints, team isolation and data-preserving restart. Other problem and terminal variants remain unverified. Use the actual selected problem\'s evidence, not its presence in a picker, to decide event readiness. AWS problems use cloud hosting AWS-service problems are for cloud hosting only. Local hosting rejects the old AWS-region switch. The current cloud Lambda/DynamoDB path implements hello-world deployment/scoring with scoped CLI access and native Cryptography Battle. Docker/Compose exercises are local-only and are not listed in the cloud catalog. First-account setup has explicit offline review and confirmation steps; see the IAM setup guide. Deployment operators can administer TenkaCloud resources across environments in the selected account; environment names are not an IAM security boundary. Live AWS deployment remains unverified. Synchronized Battle bursts still exceed the five-second refresh interval. Do not use a local command as an alternative cloud launcher. Existing AWS resources require their original reviewed cleanup procedure; keep their ownership records. Storage and shutdown The local database is SQLite. Back up the complete private data directory consistently, including key files. make down preserves event data and stopped Docker state; use the same data directory on restart. New on-demand Docker environments stay stopped after make local until a participant resumes them. It does not delete AWS resources or reset the event clock. Never delete state that still owns environments. Cloud Lambda/DynamoDB hosting is in progress; make deploy requires reviewed IAM setup; make destroy confirms targets, drains recorded exercises, and retains data. The cloud catalog includes hello-world with scoped CLI access and native Cryptography Battle. Docker/Compose exercises are local-only and are not listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second refresh interval. A zero-fixed-cost cloud platform has not been established. AWS exercise charges are separate. New Docker events prepare dormant team/problem jobs, up to 512 per event. Participants use Start / resume and Stop (keep data). Stop retains the existing writable layer and volumes, not RAM; there is no automatic eviction or reset. Existing events retain their legacy lifecycle. Defaults allow 3 active environments per team, 12 across the host and a 4096 MiB sum of configured container-memory caps. These are admission limits, not measured usage or machine-size guarantees. New Compose plans preserve authored caps and add 512 MiB memory, 1 CPU and 256 PIDs where missing. Override admission limits with make local LOCAL_ARGS="--max-active-per-team 3 --max-active-environments 12 --container-memory-mib 4096" after reviewing the workload. The 40 gateway slots apply only to active environments. Dense runtime-port assignments survive Stop. A synthetic 20-problem × 5-team plan allocated 100 jobs using 105 runtime ports; this proves allocation and lifecycle behavior, not concurrent Docker performance. See docs/local-play-requirements.md for measurement guidance. 競技開催者マニュアル 未公開の統合 candidate の手順です。ローカルの大会・チーム運用は実装されていますが、クラウド基盤の配置や全カタログのプレイ確認が完了した公開版ではありません。 ローカル host を準備する はじめにに従って make local を実行します。非公開のデータディレクトリにつき一つのプロセスだけを起動し、主催者キーだけでログインします。ユーザー名・パスワード・ローカル SAML は不要です。対話ターミナルで make local を起動するたびに新しい主催者キーを一度だけ表示します。起動中の再発行は、別の対話ターミナルで同じデータディレクトリを指定して make local-reset を実行します。どちらも古い主催者キーとログインを失効させますが、大会・得点・進捗・参加者キー・問題のデータを保持します。非対話起動と public/container 起動では既存のキーを保持し、ログにキーを出力しません。 大会を運営する チームと問題を選び、停止状態の Docker jobs の準備結果を確認して Schedule から開始します。Docker 環境は参加者が必要なときに起動します。AWS の配置は別の操作です。参加リンクは対象チームだけに渡します。正答、誤答、ヒント、得点、一つのチームの障害、再起動、撤収までリハーサルしてください。End Event は採点を止めますが、リソース削除の完了を意味しません。 旧ローカル 106 問はすべて Challenge 形式の競技にする方針です。汎用カタログと workbench は実装済みです。実 Docker とブラウザで SQL へのアクセス、PostgreSQL terminal の 3 checkpoints、チーム分離、データを保持した再起動を確認しました。他の問題と terminal の全種類は未確認です。問題が選択欄に出ることだけで大会に使えると判断しないでください。 AWS 問題はクラウド開催へ AWS サービスを使う問題はクラウド開催専用です。ローカル開催では旧 AWS リージョン指定を拒否します。Lambda / DynamoDB によるクラウド開催は、限定 CLI を使う hello-world の配置・採点と組み込みの Cryptography Battle に対応します。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。初回アカウント設定では、IAM 設定手順に従って生成ポリシーをオフラインで確認し、明示的にセットアップします。配置担当者の権限は同じアカウントの TenkaCloud 環境を横断するため、環境名は IAM の分離境界になりません。実 AWS への配置は未検証です。Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。ローカルのコマンドで代用しないでください。既存の AWS リソースは作成時の確認済み手順で片付ける必要があるため、所有情報を保持します。 データベースと停止 ローカルのデータベースは SQLite です。キーを含む非公開ディレクトリ全体を整合した状態でバックアップします。make down は大会データと停止した Docker の状態を保持します。再開には同じディレクトリを使います。新しいオンデマンドの Docker 環境は make local 後も停止したままで、参加者が再開します。AWS リソースの削除や大会時刻のリセットは行いません。環境を所有している保存領域を先に消さないでください。 Lambda / DynamoDB のクラウド開催を復旧中です。make deploy は権限設定の事前確認が必要です。make destroy は対象を確認して記録済み問題を撤収し、データを保持します。現在は限定 CLI を使う hello-world と組み込みの Cryptography Battle に対応します。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。固定費ゼロのクラウド基盤は確立していません。AWS 問題の費用は別に確認します。 新しい Docker 大会は、停止状態のチーム・問題 jobs を大会ごとに最大 512 件準備します。参加者が Start / resume と Stop (keep data) を使います。停止は既存の書き込みレイヤーと volume を保持しますが、RAM は保持しません。自動退避や初期化は行いません。既存大会は従来の lifecycle を維持します。 デフォルトの同時起動上限はチームごとに 3 環境、host 全体で 12 環境です。さらに、コンテナに設定されたメモリー上限の合計を 4096 MiB までに制限します。これは起動の受付制限であり、実測使用量や必要な機器の保証ではありません。新しい Compose 計画は作問者の上限を保持し、未指定の項目に 512 MiB、1 CPU、256 PIDs を補います。必要な負荷を確認したうえで make local LOCAL_ARGS="--max-active-per-team 3 --max-active-environments 12 --container-memory-mib 4096" から受付制限を指定できます。 40 個の gateway 枠は起動中の環境だけに使います。必要な数だけ割り当てた runtime port は停止後も保持します。20 問 × 5 チームの synthetic テストでは 100 jobs と 105 runtime ports を割り当てました。これは割り当てと lifecycle の確認であり、実 Docker の同時実行性能を示しません。測定項目は docs/local-play-requirements.md を参照してください。 organizer database parameters SQLite Turso 競技開催者 データベース パラメータ',
  },
  {
    slug: "manual/participant",
    href: "/developers/docs/manual/participant/",
    title: "Competition participant manual",
    description: "Join your assigned team, solve problems and understand current runtime limits.",
    maturity: "preview",
    section: "Role manuals",
    headings: [
      {
        id: "your-goal",
        text: "Your goal",
      },
      {
        id: "solve-a-problem-in-five-steps",
        text: "Solve a problem in five steps",
      },
      {
        id: "practice-without-a-cloud-account",
        text: "Try the local event flow",
      },
      {
        id: "words-you-will-see",
        text: "Words you will see",
      },
      {
        id: "when-something-goes-wrong",
        text: "When something goes wrong",
      },
    ],
    body: "Competition participant manual Your goal Use the participant URL and team invitation or key supplied by the organizer. Keep the key private. You do not create a cloud platform or sign in as an organizer to join a prepared event. Solve a problem in five steps 1. Sign in with your team's key. 2. Wait for the organizer to prepare the jobs and start the event. 3. Open an assigned problem and read its situation, first action and goal. For a new Docker event, choose **Start / resume** and wait until it is running. 4. Use its exercise URL, workbench, answer fields or AWS access as directed. Submit the complete flag or answer to the indicated checkpoint. 5. Read the verdict and score. Hints and wrong answers may change the score. Ask the organizer about an unavailable environment rather than repeatedly starting it. Use **Stop (keep data)** to free active capacity. Resuming the same environment retains its writable layer and volumes, but not RAM. The host does not automatically evict or reset it. Defaults allow 3 active environments per team and 12 across the host, subject to the configured memory-cap budget. If a limit is reached, stop an environment you no longer need or contact the organizer. After make down / make local, new Docker jobs remain stopped until you resume them. Existing events keep their legacy lifecycle. Terminal HTTP/WebSocket tests have passed using a synthetic shell (11 tests, 96 assertions). Actual Docker exec and complete Docker/browser playability remain unverified. A listed problem does not guarantee every interaction is ready. Try the local event flow If you are also organizing your own test, follow getting started: make local starts the same event/team system and make down stops it while preserving data. There is no separate individual-practice login or automatic progress reset. Words you will see - Docker: A way to package an application and its dependencies so a matching practice environment can be recreated - Problem environment: the isolated application or cloud resources assigned to your team - Endpoint: the address of a service you open or register - Flag: the complete evidence string the problem asks you to submit - Hint: extra guidance; check its displayed cost before opening it When something goes wrong Give the organizer the problem name, visible error and time, without posting keys, flags or AWS credentials. Ending the event blocks new submissions and access issuance, but already issued AWS sessions may remain valid until they expire. 競技参加者マニュアル あなたのゴール 開催者から受け取った参加者 URL とチームの参加リンクまたはキーを使います。キーは他のチームへ渡さないでください。準備済みの大会へ参加するために、クラウド基盤や開催者アカウントを作る必要はありません。 問題を解く五つの手順 1. 自分のチームキーでサインインします。 2. 開催者が jobs を準備し、大会を始めるまで待ちます。 3. 問題を開き、状況、最初の一手、ゴールを読みます。新しい Docker 大会では **Start / resume** を選び、起動を待ちます。 4. 指示に沿って問題 URL、workbench、解答欄、AWS のアクセスを使い、指定された checkpoint へ答えや完全な flag を提出します。 5. 判定と得点を確認します。ヒントや誤答で点数が変わる場合があります。環境を使えないときは、起動を繰り返す前に開催者へ伝えます。 **Stop (keep data)** で停止すると同時起動枠を空けられます。同じ環境を再開すると書き込みレイヤーと volume は残りますが、RAM は残りません。自動退避や初期化は行いません。デフォルトではチームごとに 3 環境、host 全体で 12 環境まで起動でき、メモリー上限の合計でも制限されます。上限に達したら不要な環境を停止するか、開催者へ相談してください。make down / make local の後も、新しい Docker jobs は参加者が再開するまで停止したままです。既存大会は従来の lifecycle を維持します。 terminal の HTTP/WebSocket は synthetic shell を使う 11 tests・96 assertions が成功しています。実 Docker exec と全問の Docker・ブラウザ操作は未確認です。問題が一覧にあっても、すべての操作が確認済みとは限りません。 自分でローカル大会を試す 自分が開催者も兼ねる場合ははじめにへ進みます。make local で同じ大会・チームのシステムを起動し、make down でデータを保持して停止します。個人練習専用のログインや、自動で進捗を消す動作はありません。 画面の用語 - Docker: アプリと必要なソフトをまとめ、同じ練習環境を再現しやすくする仕組み - 問題環境: 自分のチームへ割り当てられたアプリやクラウドのリソース - endpoint: 開いたり登録したりするサービスのアドレス - flag: 問題が提出を求める証拠の文字列全体 - hint: 追加の手がかり。開く前に表示される点数を確認します 困ったとき 問題名、表示されたエラー、発生時刻を開催者へ伝えます。キー、答え、AWS 認証情報は貼り付けないでください。大会終了後は新しい解答やアクセス発行が止まりますが、発行済み AWS session は期限まで残る場合があります。",
  },
  {
    slug: "manual/problem-author",
    href: "/developers/docs/manual/problem-author/",
    title: "Problem author manual",
    description:
      "Write participant-friendly scenarios, runtime environments, metadata, scoring, and hints.",
    maturity: "preview",
    section: "Role manuals",
    headings: [
      {
        id: "your-goal",
        text: "Your goal",
      },
      {
        id: "create-and-validate-a-pack",
        text: "Create and validate a pack",
      },
      {
        id: "author-the-participant-experience",
        text: "Author the participant experience",
      },
      {
        id: "the-problem-contract",
        text: "The problem contract",
      },
      {
        id: "rehearse-the-real-interaction",
        text: "Rehearse the real interaction",
      },
      {
        id: "publish-safely",
        text: "Publish safely",
      },
    ],
    body: "Problem author manual Use this manual when you create or maintain the content participants solve: the scenario, deployable environment, verifier, scoring metadata, and hints. You do not need to operate a TenkaCloud event or change platform code. Pack init, validation and immutable installation are authoring tools. Installing or activating a pack does not add its problems to this candidate's event catalog. Activation is an offline catalog record, not a current hosting workflow. Your goal A pack is ready to publish when these three outcomes are reproducible: 1. make pack-validate succeeds from a fresh checkout. 2. For a supported local runtime, the author rehearses the complete path from start through flag submission. 3. A participant-role check can explain the goal and first action from the participant-facing statement alone. !Decision flow from authoring a problem pack to publication When local execution is unsupported, record Not run instead of inferring a result. This does not block merge. A real-cloud rehearsal is optional before a specific event. The participant-role check may be performed by the author or reviewer, or recorded as a deterministic browser assertion; it does not require an independent tester. If the statement is unclear, rewrite its situation, goal, first action, and completion condition before changing the environment. Create and validate a pack The first pack tutorial follows one minimal pack from scaffold to validation, immutable Git pin, install, local inspection, and removal. Author the participant experience Every problem should answer these questions before introducing technical detail: 1. What happened in the scenario? 2. What observable result must the participant produce? 3. What is the first safe action? 4. Where will the participant work: a URL, shell, cloud console, or local app? 5. What exact evidence becomes the TC{...} flag? 6. How can the participant reset or stop the environment? Explain a term at first use if a participant needs it to act. Avoid testing whether they memorized words such as cloud, container, Docker, region, or database unless that concept is the learning objective. The problem contract | Part | Responsibility | | --- | --- | | tenkacloud-pack.json | Pack identity, version, license, problem root, runtimes, dependencies | | metadata.json | Problem ID, runtime, template, scoring, endpoints, phases, disruptions | | Runtime entry | Creates the isolated environment the participant actually uses | | Verifier or scoring rule | Decides whether the submitted evidence is correct | | README / statement | Scenario, goal, first action, success condition, cleanup | | Hints | Progressive help without revealing the final answer too early | Use the generated pack manifest and problem metadata references instead of guessing field names. Rehearse the real interaction Validation checks the contract and referenced files, but it does not prove that the problem is understandable or solvable. 1. Start from a clean local or test environment. 2. Follow only the participant-facing statement. 3. Start the deployed or local problem environment. 4. Perform the intended investigation or repair. 5. Submit the exact flag through the Participant Portal. 6. Test one wrong flag, reset, stop, and a second start. 7. Repeat the participant-role path without using implementation, verifier, or answer data. The author, a reviewer, or a deterministic browser harness may record this evidence. Publish when the participant-visible route explains what happened, what must be fixed, where to start, and what proves completion. Independent third-party and real-cloud runs are optional event rehearsals, not merge gates. Local mode is for problems that declare a supported local runtime. It is not a WordPress tutorial or a substitute for the participant onboarding. A WordPress problem, if desired, belongs here as its own local problem with its own learning objective and verifier. Publish safely - Increment the pack version for a new immutable release. - Validate before committing. - Pin installation to the full 40-character Git commit SHA. - Do not put secrets, mutable remote assets, or install-time scripts in a pack. - Keep author-only answers out of participant-visible metadata and endpoints. - Give organizers a separate rehearsal note for required accounts, region, expected start time, teardown, and costs. The security and provenance model defines what a pack may contain. Validator messages are listed in validation errors. If the pack requires a new platform capability rather than problem content, open a platform Issue and switch to the developer manual. The catalog/workbench for all 106 former local problems and 15 declared terminal variants are connected to Challenge competitions. Real Docker/browser rehearsals cover the SQL and PostgreSQL terminal representative paths. This is not a completed walkthrough of every problem or terminal variant; record each unverified participant path as Not run. 問題作成者マニュアル 参加者が解く内容、つまり状況、実際に動く問題環境、verifier、採点metadata、hintを 作成・保守する人のためのマニュアルです。TenkaCloud 大会の運用やplatform codeの 変更は必要ありません。 pack の作成、検証、不変な revision の保存は作問用の機能です。install や activate をしても、この candidate の大会カタログへ問題は追加されません。activate はオフラインのカタログ記録であり、現行の競技実行手順ではありません。 あなたのゴール 公開できる状態とは、次の3点を再現できることです。 1. 新しいcheckoutでmake pack-validateが成功する。 2. 対応するlocal runtimeがある問題は、作成者が起動からflag提出までリハーサルできる。 3. 参加者役の確認で、参加者向け問題文だけからゴールと最初の操作を説明できる。 !問題パックを作成して公開するまでの判定フロー local runtimeが未対応なら、実行結果を推測せずNot runと記録します。これはmergeを 止めません。特定イベント前の実クラウドリハーサルは任意です。参加者役の確認は作成者・ reviewer・deterministicなブラウザassertionのいずれでも記録でき、独立した第三者を 必須にしません。問題文が理解できなければ、環境を作り直す前に 「状況・ゴール・最初の操作・完了条件」を書き直します。 packを作成して検証する 最初のpackチュートリアルでは、最小構成の packを雛形作成、検証、不変Git commitへの固定、install、ローカルでの内容確認、削除まで 通して扱います。 参加者の体験を書く 技術詳細より前に、各問題が次の質問へ答えるようにします。 1. 状況の中で何が起きたか。 2. 参加者が作る、目で確認できる結果は何か。 3. 最初に行う安全な操作は何か。 4. URL、shell、cloud console、local appのどこで操作するか。 5. どの証拠がTC{...}形式のflagになるか。 6. 問題環境をどうリセット・停止するか。 行動に必要な用語は初出時に説明します。cloud、container、Docker、region、database などの概念自体が学習目標でない限り、単語の暗記を採点しません。 問題を構成する契約 | 部分 | 担当 | | --- | --- | | tenkacloud-pack.json | packのID、version、license、problem root、runtime、dependency | | metadata.json | 問題ID、runtime、template、scoring、endpoint、phase、disruption | | runtime entry | 参加者が実際に使う分離された環境を作る | | verifierまたは採点rule | 提出された証拠が正しいか判定する | | README / 問題文 | 状況、ゴール、最初の操作、成功条件、後片付け | | hint | 最終解答を早く見せすぎない段階的な助け | field名を推測せず、生成済みの pack manifestと problem metadataを参照してください。 実際の操作をリハーサルする validationは契約と参照fileを検査しますが、問題が理解でき、解けることまでは証明 しません。 1. 初期状態のlocal環境またはtest環境を使う。 2. 参加者に見える問題文だけを読む。 3. deployされた問題環境またはlocal問題環境を起動する。 4. 意図した調査または修正を行う。 5. 正確なflagをParticipant Portalから提出する。 6. 誤ったflag、リセット、停止、2回目の起動も試す。 7. 実装、verifier、正解dataを使わずに参加者役の流れをもう一度確認する。 この証拠は作成者・reviewer・deterministicなブラウザハーネスのいずれでも記録できます。 参加者向け導線だけから「何が起きているか」「何を直すか」「最初に何を開くか」 「何をもって完了とするか」が分かり、flag提出まで再現できれば公開へ進みます。 独立した第三者と実クラウドでの実行は任意のイベントリハーサルであり、merge gateではありません。 local modeは対応するlocal runtimeを宣言した問題のためのものです。WordPressの チュートリアルでも、参加者オンボーディングの代替でもありません。WordPress問題を 作る場合は、独立した学習目標とverifierを持つlocal問題としてここで扱います。 安全に公開する - 不変releaseごとにpack versionを上げる。 - commit前にvalidateする。 - install時は完全な40文字のGit commit SHAへ固定する。 - secret、変更可能なremote asset、install時に動くscriptをpackへ入れない。 - 作成者だけが知る答えを参加者向けmetadataやendpointへ出さない。 - 必要account、region、想定起動時間、停止方法、費用は開催者向けメモへ分ける。 packに含められるものは securityとprovenance、 validator messageはvalidation error を参照してください。 問題内容ではなく新しいplatform機能が必要なら、platform Issueを作り、 開発者マニュアルへ切り替えます。 旧ローカル 106 問のカタログ・workbench と 15 件の terminal 宣言は Challenge 競技へ接続済みです。実 Docker・ブラウザでは SQL と PostgreSQL terminal の代表経路を確認しています。全問題・全 terminal 種類の完走確認ではないため、参加者の経路を確認していない問題は Not run と記録してください。",
  },
  {
    slug: "concepts/problem-packs",
    href: "/developers/docs/concepts/problem-packs/",
    title: "Problem packs",
    description: "How Battle and Challenge packs are authored and scored.",
    maturity: "preview",
    section: "Concepts",
    headings: [
      {
        id: "what-is-a-problem-pack",
        text: "What is a problem pack",
      },
      {
        id: "battle-versus-challenge",
        text: "Battle versus Challenge",
      },
      {
        id: "scoring-kinds",
        text: "Scoring kinds",
      },
    ],
    body: "Problem packs A pack is a versioned, inspectable unit of competition content. Its manifest declares identity, runtime requirements and problem files. The artifact depends on the runtime; a CloudFormation template is only one possibility. What is a problem pack The current pack CLI can scaffold, validate, inspect and store immutable revisions. Installing or activating a pack does not add it to the current event catalog. Activation records are offline catalog metadata, not a current hosting workflow. Battle versus Challenge Challenge and Battle describe a problem's interaction and scoring model. Runtime placement is a separate concern. All former local Compose problems are intended to run as Challenge competitions; generic catalog/workbench restoration and terminal/browser verification are still in progress. Scoring kinds Schema declarations are not proof of execution. The local catalog uses verify and multi-verify; the reviewed AWS examples use flag and uptime-flat. Other SDK kinds and external-pack runtimes must not be advertised as playable merely because validation accepts them. See runtime status. Continue with first pack or existing packs. 問題パック pack は競技の内容を version ごとに確認・保存する単位です。manifest に識別情報、必要な runtime、問題ファイルを記述します。artifact は runtime によって異なり、CloudFormation template はその一例です。 問題パックとは 現在の CLI は雛形作成、検証、内容確認、不変 revision の保存を行えます。install や activate では現在の大会カタログへ追加されません。activation はオフラインのカタログ記録であり、現行の競技実行手順ではありません。 Battle と Challenge Challenge と Battle は操作と採点の形式であり、実行場所とは別です。旧ローカル Compose 問題はすべて Challenge 競技へ対応させる方針です。汎用カタログ・workbench の復旧と terminal・ブラウザ検証は進行中です。 採点方式 schema の受理だけでは実行対応を証明できません。ローカルカタログは verify / multi-verify、確認対象の AWS 例は flag / uptime-flat を使います。他の SDK の形式や外部 pack の runtime を、検証成功だけでプレイ可能と案内しないでください。実行状況を参照します。 最初の packまたは既存 packへ進んでください。",
  },
  {
    slug: "concepts/architecture",
    href: "/developers/docs/concepts/architecture/",
    title: "Platform architecture",
    description:
      "Current single-process event/team boundaries, local persistence and incomplete cloud integration.",
    maturity: "preview",
    section: "Concepts",
    headings: [
      {
        id: "reading-order",
        text: "Reading order",
      },
      {
        id: "local-play-and-docker",
        text: "Local competition and Docker",
      },
      {
        id: "cloud-components",
        text: "AWS exercises and cloud platform",
      },
      {
        id: "problem-deployment",
        text: "Problem deployment and scoring",
      },
      {
        id: "diagram-sources",
        text: "Editable diagram sources",
      },
      {
        id: "cloud-design",
        text: "Cloud design",
      },
    ],
    body: "Platform architecture Reading order Read the responsibilities and trust boundaries before selecting an execution environment. This draft candidate unifies local and cloud competition workflows without SaaS/SBT tenant provisioning. Local competition and Docker make local serves organizer and participant applications from one Bun process. Organizer roles and event/team keys authorize separate HTTP surfaces. SQLite and private key files retain competition state and runtime ownership. make down stops owned local runtimes while preserving data; explicit teardown is separate. New Docker events prepare up to 512 dormant jobs, then participants Start / resume and Stop (keep data). Defaults are team 3 / host 12 active environments and 4096 MiB summed memory caps. The 40 gateway slots are active-only; runtime ports persist while stopped. Writable layers and volumes survive, not RAM. There is no automatic eviction or reset. Existing events keep their legacy lifecycle. The generic catalog and workbench expose all 106 former local definitions as Challenges and 15 declared terminals. Real Docker/browser verification covers representative SQL, PostgreSQL terminal and Battle flows; full play-throughs of all definitions remain incomplete. Verifiers must remain separate from public challenge surfaces and other teams. AWS exercises and cloud platform AWS-service problems are restricted to cloud hosting. The opt-in cloud flag runner deploys owned CloudFormation stacks through configured competitor roles and mandatory ExternalId parameters in SSM. Participant access uses a scoped hello-world viewer session; Console/CloudShell are unsupported. First-account IAM setup uses standard CDKToolkit, requires review of bootstrap/caller authority and confirmation for first bootstrap, and has not been verified against live AWS. Deployment-role credentials never become participant credentials. The cloud foundation uses Lambda, Cognito and DynamoDB, with durable dispatch and Step Functions work. make deploy and make destroy use the scoped CLI with reviewed IAM setup and ownership-checked teardown. The current cloud catalog includes hello-world with scoped CLI access and native Cryptography Battle backed by DynamoDB. Docker/Compose exercises are local-only and are not listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second refresh interval. Problem deployment and scoring An authenticated organizer requests an event operation. Ownership is saved before external creation. Status, errors and recovery remain durable. Participant requests recheck team, event, problem and time; verified scores, progression and retry receipts commit together before success is returned. A failed verifier or uncertain cloud operation is not a success. Editable diagram sources The repository's docs/architecture/README.md identifies the restored AWS-icon system-architecture.drawio and its generator. The drawing preserves the AWS icons and layout conventions while documenting the current local and cloud boundaries. A diagram is not evidence of an AWS event rehearsal. Cloud design The current cloud foundation selectively reuses single-installation Lambda/DynamoDB and Step Functions mechanisms. Logical event/team responsibilities are retained without speculative SaaS abstractions. アーキテクチャ 読む順番 配置先を選ぶ前に責務と信頼境界を確認します。この Draft はローカル・クラウドの競技操作を統合検証しています。SaaS/SBT のテナント構築基盤は含みません。 ローカル競技と Docker make local は一つの Bun プロセスで開催者・参加者の画面を配信します。開催者 role と大会・チームのキーは異なる HTTP 面を認証します。SQLite と非公開キーに大会状態と環境の所有情報を保持します。make down は所有するローカル環境を止め、データを残します。明示的な teardown は別です。 新しい Docker 大会は最大 512 件の停止中 jobs を準備し、参加者が Start / resume と Stop (keep data) を使います。デフォルトはチーム 3、host 全体 12 環境、メモリー上限の合計 4096 MiB です。40 個の gateway 枠は起動中だけに使い、runtime port は停止後も保持します。書き込みレイヤーと volume は保持しますが、RAM は保持しません。自動退避や初期化は行わず、既存大会は従来の lifecycle を維持します。汎用カタログと workbench は旧ローカル 106 定義を Challenge として表示し、15 件の terminal 宣言に対応します。実 Docker・ブラウザでは SQL、PostgreSQL terminal、Battle の代表経路を確認しています。全問題の通し検証は未完了です。verifier は公開画面や他チームから分離しなければなりません。 AWS 問題とクラウド基盤 AWS サービスの問題はクラウド開催専用です。明示設定した cloud flag runner は、競技者 role と SSM に保存した必須の ExternalId を使い、所有情報付きの CloudFormation stack を配置します。参加者には hello-world だけに限定した viewer の資格情報を発行します。Console / CloudShell は未対応です。初回 IAM 設定は標準 CDKToolkit と呼び出し元の権限の確認、初回 bootstrap の承認が必要で、実 AWS では未検証です。配置 role の認証情報を参加者へ渡してはいけません。 クラウド基盤は Lambda、Cognito、DynamoDB を使い、配置受付と Step Functions の処理を永続化します。make deploy と make destroy は、権限設定と所有対象を確認する既存 CLI を実行します。現在のクラウド問題は限定 CLI を使う hello-world と、DynamoDB に状態を保存する組み込みの Cryptography Battle です。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。 問題の配置と採点 認証済み開催者が大会の操作を要求し、外部作成前に所有情報を保存します。状態、エラー、復旧情報を保持します。参加者の要求ではチーム、大会、問題、時刻を検証し、得点、進捗、再試行受付票を一緒に確定してから成功を返します。verifier の失敗や不明なクラウド操作を成功にしません。 編集可能な図のソース リポジトリの docs/architecture/README.md に、復元した AWS アイコン付き system-architecture.drawio と生成元を記載しています。AWS アイコンと描画スタイルを保ち、現在のローカルとクラウドの境界を説明しています。図は実 AWS での大会リハーサルの証拠ではありません。 クラウドの設計 現クラウド基盤は単独開催向けの Lambda/DynamoDB と Step Functions の必要部分を再利用します。大会・チームの責務を保ち、将来の SaaS のためだけの抽象化は追加しません。 アーキテクチャ プレーン",
  },
  {
    slug: "operate/deploy-paths",
    href: "/developers/docs/operate/deploy-paths/",
    title: "Launch and deployment boundaries",
    description:
      "Separate local hosting, reviewed standard CDK deployment and exercise deployment.",
    maturity: "preview",
    section: "Operate",
    headings: [
      {
        id: "local-platform",
        text: "Local platform",
      },
      {
        id: "cloud-platform",
        text: "Cloud platform: integration in progress",
      },
      {
        id: "exercise-deployment",
        text: "Exercise deployment is separate",
      },
    ],
    body: "Launch and deployment boundaries This documents the draft integration candidate. Local event/team operation is implemented; cloud platform deployment and complete catalog playability are not verified release claims. Local platform make local runs the unified Bun server and two browser applications with persistent SQLite. make down stops owned local runtimes and preserves event data. The removed host target is not a second launch mode. See getting started for bootstrap, event creation and participant login. Cloud platform: integration in progress make deploy and make destroy execute the current Lambda/DynamoDB setup and coordinated teardown CLI. They reuse the standard CDKToolkit; only a missing toolkit triggers reviewed official cdk bootstrap inside make deploy. The default bootstrap CloudFormation execution role uses AdministratorAccess, so review bootstrap trust, caller permissions and application IAM changes. Existing toolkits are not rewritten; earlier custom TenkaCloud toolkits remain untouched. The current cloud catalog supports hello-world with scoped CLI access and native Cryptography Battle. Docker/Compose exercises are local-only and are not listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second refresh interval. Destroy shows the account, region and owned targets, waits for recorded exercises to be removed, then removes hosting while retaining data. Retained resources can continue to incur charges. The preserved infrastructure/templates/cloud-pipeline.yaml defaults to the current CLI and explicitly approved unattended bootstrap/deployment. Review its broad CodeBuild caller role and source refs before creating or starting it. A container build is not deployment evidence or a zero-cost promise. Exercise deployment is separate Local events use owned Docker Compose projects or native Battle execution. AWS-service problems are cloud-only and require reviewed competitor account/region/role configuration with ExternalId. Docker/Compose exercises are local-only and are not listed in the cloud catalog. Native Cryptography Battle runs on both hosting options. Exercise resources can incur charges; stopping a local process does not remove resources created by an older AWS-enabled revision. 起動と配置の境界 未公開の統合 candidate の手順です。ローカルの大会・チーム運用は実装されていますが、クラウド基盤の配置や全カタログのプレイ確認が完了した公開版ではありません。 ローカル基盤 make local は Bun のサーバーと二つの画面を起動し、SQLite へ状態を保存します。make down は所有するローカル環境を止め、大会データを保持します。旧 host target は別モードとして残しません。はじめにで初期管理者、大会作成、参加者ログインを確認してください。 クラウド基盤の対応範囲と検証状況 make deploy と make destroy は、この版の Lambda/DynamoDB 配置と協調撤収 CLI を実行します。標準の CDKToolkit を再利用し、存在しない場合だけ make deploy 内で承認後に公式 cdk bootstrap を実行します。標準の CloudFormation 実行 role はデフォルトで AdministratorAccess を持つため、bootstrap の信頼設定、呼び出し元の権限、アプリケーションの IAM 変更を確認してください。既存 Toolkit は変更せず、以前の独自 TenkaCloud Toolkit も削除・移行しません。現在のクラウド問題は限定 CLI を使う hello-world と組み込みの Cryptography Battle です。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。撤収ではアカウント、リージョン、所有対象を表示し、記録済み問題の撤収後に基盤を削除します。データは保持し、保持リソースには料金が発生する場合があります。infrastructure/templates/cloud-pipeline.yaml のデフォルトは現行 CLI と明示的に承認する無人 bootstrap・配置です。launcher の作成・build 開始前に広い権限を持つ CodeBuild role とソース ref を確認してください。詳細設定の旧版ソースでは元の完全な処理を維持します。コンテナの build 成功は、配置済みや費用ゼロの証明ではありません。 問題環境の配置は別の操作 ローカル大会では所有情報付きの Docker Compose project と組み込み Battle を使います。AWS サービスの問題はクラウド開催専用で、確認した競技者アカウント、region、role、必須の ExternalId を使います。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。組み込みの Cryptography Battle は両方の開催方法に対応します。問題リソースには費用が発生する場合があります。ローカル停止では、以前の AWS 対応版が作成した stack を削除しません。 SaaS tenant の rollout は旧版の契約です。改名した cloud pipeline は固定したソースに対する元の CodePipeline/CodeBuild 配置・撤収を維持します。既存環境の操作には、その環境を作成した正確な旧版を使ってください。",
  },
  {
    slug: "operate/run-an-event",
    href: "/developers/docs/operate/run-an-event/",
    title: "Run an event end to end",
    description:
      "Prepare, rehearse, start, score and clean up an event with explicit verification limits.",
    maturity: "preview",
    section: "Operate",
    headings: [
      {
        id: "prepare",
        text: "Prepare and rehearse",
      },
      {
        id: "connect-a-competitor-account",
        text: "Connect an optional competitor account",
      },
      {
        id: "deploy-a-problem",
        text: "Deploy, start and score",
      },
      {
        id: "finish",
        text: "Finish safely",
      },
    ],
    body: 'Run an event end to end Prepare and rehearse Use the organizer manual and make local. Choose the actual problem set and team count. Record the source/catalog revisions, supported hardware, runtime evidence, responsible organizer, schedule, communication route and cleanup owner. Catalog coverage is in progress; do not call every Docker or terminal problem tested. Connect an optional competitor account For AWS exercises, agree on accounts, region, resources and cleanup. Use infrastructure/templates/competitor-bootstrap.yaml, the displayed operator account, exact role name and persisted ExternalId. Verify each competitor account before selecting it for a team. Never distribute deployment-role credentials to participants. Deploy, start and score 1. Create an event with its teams and problems. 2. Prepare and inspect each team\'s dormant Docker jobs; retry failed ownership-aware operations. Deploy AWS exercises separately. 3. Start the schedule and distribute the correct team invitations. 4. Rehearse participant Start / resume and Stop (keep data), capacity rejection, correct/wrong answers, hints, leaderboard, team separation and a failed environment. 5. For AWS Battle, register both endpoints, observe scoring, test a selected-team disruption and verify revert plus actual service health. Finish safely End Event to stop scoring. Remove owned environments using the organizer teardown actions and verify completion. Retain results and back up the full data directory. For an ordinary local pause use make down; restart with make local and the same directory. Stop is not AWS cleanup. Cloud platform make deploy and make destroy are currently unimplemented. See the repository\'s docs/operations/event-runbook.md for the operating checklist. New Docker events prepare dormant team/problem jobs, up to 512 per event. Participants use **Start / resume** and **Stop (keep data)**. Stop retains the existing writable layer and volumes, not RAM; there is no automatic eviction or reset. Existing events retain their legacy lifecycle. Defaults allow 3 active environments per team, 12 across the host and a 4096 MiB sum of configured container-memory caps. These are admission limits, not measured usage or machine-size guarantees. New Compose plans preserve authored caps and add 512 MiB memory, 1 CPU and 256 PIDs where missing. Override admission limits with make local LOCAL_ARGS="--max-active-per-team 3 --max-active-environments 12 --container-memory-mib 4096" after reviewing the workload. The 40 gateway slots apply only to active environments. Dense runtime-port assignments survive Stop. A synthetic 20-problem × 5-team plan allocated 100 jobs using 105 runtime ports; this proves allocation and lifecycle behavior, not concurrent Docker performance. See docs/local-play-requirements.md for measurement guidance. 大会を最後まで運営する 準備とリハーサル 開催者マニュアルと make local を使います。実際の問題とチーム数を選び、ソース・カタログの revision、必要な機器、確認結果、運営担当、時間、連絡経路、撤収担当を記録します。カタログ対応は進行中です。Docker や terminal の全問確認済みとは扱わないでください。 任意の競技者アカウントを接続する AWS 問題にはアカウント、region、リソース、削除の合意が必要です。infrastructure/templates/competitor-bootstrap.yaml と、表示された運営アカウント、正確な role 名、保存された ExternalId を使います。各アカウントを検証してからチームへ割り当てます。参加者へ配置 role の認証情報を配布しないでください。 配置・開始・採点 1. 大会、チーム、問題を作成します。 2. 停止状態の Docker jobs の準備結果をチームごとに確認し、失敗した操作だけを所有情報に基づいて再試行します。AWS 問題は別途配置します。 3. Schedule から開始し、正しいチームの参加リンクを配ります。 4. 参加者の Start / resume、Stop (keep data)、容量超過時の拒否、正答、誤答、ヒント、順位、チーム分離、環境障害を確認します。 5. AWS Battle は両方の URL、採点、対象チームへの障害、revert と実際の復旧まで確認します。 安全に終了する End Event で採点を止め、コンソールの teardown で所有する環境を削除し、完了を確認します。結果を保持し、ディレクトリ全体をバックアップします。通常のローカル停止は make down、再開は同じディレクトリで make local です。停止は AWS の削除ではありません。クラウド基盤の make deploy と make destroy は現在未実装です。 運用チェックリストはリポジトリの docs/operations/event-runbook.md を参照してください。 新しい Docker 大会は、停止状態のチーム・問題 jobs を大会ごとに最大 512 件準備します。参加者が **Start / resume** と **Stop (keep data)** を使います。停止は既存の書き込みレイヤーと volume を保持しますが、RAM は保持しません。自動退避や初期化は行いません。既存大会は従来の lifecycle を維持します。 デフォルトの同時起動上限はチームごとに 3 環境、host 全体で 12 環境です。さらに、コンテナに設定されたメモリー上限の合計を 4096 MiB までに制限します。これは起動の受付制限であり、実測使用量や必要な機器の保証ではありません。新しい Compose 計画は作問者の上限を保持し、未指定の項目に 512 MiB、1 CPU、256 PIDs を補います。必要な負荷を確認したうえで make local LOCAL_ARGS="--max-active-per-team 3 --max-active-environments 12 --container-memory-mib 4096" から受付制限を指定できます。 40 個の gateway 枠は起動中の環境だけに使います。必要な数だけ割り当てた runtime port は停止後も保持します。20 問 × 5 チームの synthetic テストでは 100 jobs と 105 runtime ports を割り当てました。これは割り当てと lifecycle の確認であり、実 Docker の同時実行性能を示しません。測定項目は docs/local-play-requirements.md を参照してください。',
  },
  {
    slug: "operate/use-existing-pack",
    href: "/developers/docs/operate/use-existing-pack/",
    title: "Use an existing pack",
    description: "Inspect and install an immutable pack; event activation is not implemented.",
    maturity: "preview",
    section: "Operate",
    headings: [
      {
        id: "prerequisites",
        text: "Prerequisites",
      },
      {
        id: "install-the-pinned-git-revision",
        text: "Install the pinned Git revision",
      },
      {
        id: "verify-the-installed-revision",
        text: "Verify the stored revision",
      },
      {
        id: "create-the-event",
        text: "Event integration is unavailable",
      },
    ],
    body: "Use an existing pack Pack init, validation and immutable installation are authoring tools. Installing or activating a pack does not add its problems to this candidate's event catalog. Activation is an offline catalog record, not a current hosting workflow. Prerequisites Obtain a trusted local pack directory or HTTPS Git URL plus an immutable full 40-hex commit SHA. Review the declared runtime, files and provenance before installation. Install the pinned Git revision Run from the repository root. The default store is .tenkacloud/pack-store. Git install uses the network; local-directory validation and installation do not deploy anything. Verify the stored revision Check the source, resolved commit and digest. Installation is not authorization to run arbitrary code, expose endpoints or create cloud resources. Event integration is unavailable Installed packs do not appear in the current event picker through activation. This is an implementation gap, not merely pending live batch verification. Use a supported core-catalog problem for an event and record the pack route as Not run. See first pack tutorial. 既存パックを使う pack の作成、検証、不変な revision の保存は作問用の機能です。install や activate をしても、この candidate の大会カタログへ問題は追加されません。activate はオフラインのカタログ記録であり、現行の競技実行手順ではありません。 前提条件 信頼する pack のローカルディレクトリ、または HTTPS Git URL と完全な 40 桁 commit SHA を用意します。runtime、ファイル、provenance を確認してください。 固定した revision を保存する リポジトリのルートで実行します。既定の保存先は .tenkacloud/pack-store です。Git install はネットワークを使います。ローカルディレクトリの検証や保存はリソースを配置しません。 保存結果を確認する 取得元、解決済み commit、digest を確認します。install 成功は、任意コードの実行、endpoint の公開、クラウド作成の承認ではありません。 大会への接続は未対応 activate しても現在の大会選択欄へ pack の問題は追加されません。実装上の不足であり、実環境テストだけが未実施という状態ではありません。大会には対応する core catalog の問題を使い、pack の経路は Not run と記録します。最初の packも参照してください。",
  },
  {
    slug: "reference/onboarding-analytics",
    href: "/developers/docs/reference/onboarding-analytics/",
    title: "Onboarding A/B analytics",
    description: "GA4 event schema, A/B assignment, drop-off funnel setup, and privacy boundary.",
    maturity: "preview",
    section: "Reference",
    headings: [
      {
        id: "assignment",
        text: "Assignment",
      },
      {
        id: "events",
        text: "Events",
      },
      {
        id: "configure-ga4",
        text: "Configure GA4",
      },
      {
        id: "build-the-drop-off-funnel",
        text: "Build the drop-off funnel",
      },
      {
        id: "privacy-boundary",
        text: "Privacy boundary",
      },
    ],
    body: "Onboarding A/B analytics reference for the public browser demo. Defines the list and one-step variants, persistent 50/50 assignment, forced preview URLs, GA4 event names and parameters, custom dimensions, closed funnel steps, drop-off analysis, elapsed time, hint and wrong-submission guardrails, and the privacy boundary that excludes answers, flags, team keys, hint text, and production participant portals. オンボーディングA/BテストのGA4計測仕様、割り当て、離脱ファネル、プライバシー境界。",
  },
  {
    slug: "reference/pack-manifest",
    href: "/developers/docs/reference/pack-manifest/",
    title: "Pack manifest reference",
    description: "Every tenkacloud-pack.json field, generated from the manifest schema.",
    maturity: "stable",
    section: "Reference",
    headings: [
      {
        id: "fields",
        text: "Fields",
      },
      {
        id: "example",
        text: "Example",
      },
    ],
    body: "Pack manifest reference. The tenkacloud-pack.json fields generated from the PackManifestSchema: schemaVersion, id, version, core, title, description, license, problemsRoot, requiredRuntimes, dependencies. The manifest is inert with no scripts or hooks.",
  },
  {
    slug: "reference/problem-metadata",
    href: "/developers/docs/reference/problem-metadata/",
    title: "Problem metadata reference",
    description: "Every metadata.json field, derived from the SDK validator.",
    maturity: "stable",
    section: "Reference",
    headings: [
      {
        id: "fields",
        text: "Fields",
      },
      {
        id: "runtime-declaration",
        text: "Runtime declaration",
      },
      {
        id: "example",
        text: "Example",
      },
    ],
    body: "Problem metadata reference. The metadata.json fields derived from the ProblemMetadata contract and validateProblemMetadata: id, runtime, cfnTemplate, scoring, endpoints, phases, disruptions. Runtime is a single descriptor or a composite of 2 to 8 targets.",
  },
  {
    slug: "reference/runtime-matrix",
    href: "/developers/docs/reference/runtime-matrix/",
    title: "Runtime execution status",
    description:
      "Separate catalog entries, adapters, fixture evidence and actual participant playability.",
    maturity: "preview",
    section: "Reference",
    headings: [
      {
        id: "matrix",
        text: "Current candidate",
      },
      {
        id: "support-classes",
        text: "Read the evidence precisely",
      },
    ],
    body: "Runtime execution status Current candidate | Runtime | Current boundary | | --- | --- | | Local Docker Compose | New events prepare up to 512 dormant jobs; participant Start / resume and Stop (keep data). Defaults: team 3, host 12 active environments, 4096 MiB summed memory caps. 106 catalog entries are not 106 verified playable exercises | | Terminal inside a Docker problem | 15 declared problems; synthetic-shell HTTP/WebSocket tests pass (11 tests, 96 assertions), actual Docker exec and full browser verification unverified | | In-process Cryptography Battle | Adapter and local tests retained; no Docker or AWS required | | AWS CloudFormation | Reviewed hello-world and hello-world-battle adapters; live AWS is a separately authorized rehearsal | | Cloud platform with Turso | In progress; make deploy and make destroy are unimplemented | | External packs, Azure, GCP, Sakura and other scoring kinds | Schema/authoring declarations do not establish current event execution | Read the evidence precisely Recognized metadata, a loaded catalog row, a wired adapter, fixture tests, a real Docker/browser route and live cloud verification are separate facts. None implies the next. See deployment boundaries and record Not run when a route has not been exercised. runtime の実行状況 現行 candidate | Runtime | 現在の境界 | | --- | --- | | ローカル Docker Compose | 新しい大会は最大 512 件の停止中 jobs を準備。参加者が起動・再開・停止する。デフォルトはチーム 3、host 全体 12 環境、メモリー上限の合計 4096 MiB。106 問の表示は全問のプレイ確認ではない | | Docker 問題内の terminal | 15 問が宣言。synthetic shell の HTTP/WebSocket 11 tests・96 assertions は成功。実 Docker exec と全経路のブラウザ検証は未確認 | | プロセス内 Cryptography Battle | adapter とローカルテストを継続。Docker・AWS は不要 | | AWS CloudFormation | hello-world と hello-world-battle の確認対象 adapter。実 AWS は別途承認したリハーサル | | Turso を使うクラウド基盤 | 対応中。make deploy と make destroy は未実装 | | 外部 pack、Azure、GCP、Sakura、その他の採点方式 | schema・作問用の宣言だけでは大会での実行対応になりません | 確認結果を区別する metadata の受理、一覧への表示、adapter 接続、fixture テスト、実 Docker・ブラウザ、実クラウドの確認はそれぞれ別です。配置の境界を確認し、通していない経路は Not run と記録してください。",
  },
  {
    slug: "reference/cli",
    href: "/developers/docs/reference/cli/",
    title: "CLI reference",
    description: "Current local lifecycle commands and retained pack-authoring CLI contracts.",
    maturity: "preview",
    section: "Reference",
    headings: [
      {
        id: "commands",
        text: "Commands",
      },
      {
        id: "exit-codes",
        text: "Exit codes",
      },
      {
        id: "example",
        text: "Example",
      },
    ],
    body: "CLI reference The tenkacloud pack CLI is the offline pack tool. Local-directory commands do not call cloud services; Git installation contacts its HTTPS source. The command table below is normative reference parsed from the CLI's own usage strings, so the documented command names and options always match the code. Current launch commands are make local and state-preserving make down. make deploy requires reviewed AWS setup. make destroy confirms targets, drains owned exercises, and retains data. The current cloud slice supports hello-world with scoped CLI access and native Cryptography Battle. Docker/Compose exercises are local-only and are not listed in the cloud catalog. Synchronized Battle bursts still exceed the five-second refresh interval. Pack activate/deactivate manage offline catalog records and do not add problems to the current event catalog. Commands Exit codes The exit-code contract is shared by every subcommand: - 0 — success (valid pack / scaffolded / installed / listed / inspected / removed) - 1 — refusal (validation failure / digest or compose conflict / not installed / pinned removal) - 2 — tool failure (missing dir / missing manifest / bad usage / unsafe init target / unsupported runtime / missing flag value) There is deliberately no update command: a new version is a separate install. Example The example below is illustrative, not normative. Related: validation error reference. CLI リファレンス bun run pack は作問用 CLI です。ローカルディレクトリの操作はクラウドを使いません。 Git install は指定した HTTPS repository へ接続します。以下のコマンド表は CLI 自身の usage 文字列から解析された規範的リファレンスであり、ドキュメントに 記載されたコマンド名とオプションは常にコードと一致します。 現在の起動は make local、データを保持する停止は make down です。make deploy は権限設定の事前確認が必要です。make destroy は対象を確認して問題環境を撤収し、データを保持します。クラウドは限定 CLI を使う hello-world と組み込みの Cryptography Battle に対応します。Docker / Compose 問題はローカル開催専用で、クラウドのカタログには表示しません。Battle の一斉アクセス時の処理時間は、5 秒の更新間隔を超えています。pack activate/deactivate はオフラインのカタログ記録であり、現在の大会カタログへ問題を追加しません。 コマンド 終了コード 終了コードの契約は、すべてのサブコマンドで共有されます。 - 0 — 成功（有効なパック / スキャフォールド完了 / インストール完了 / 一覧表示完了 / 検査完了 / 削除完了） - 1 — 拒否（検証失敗 / ダイジェストまたは compose の競合 / 未インストール / ピン留めされたパックの削除） - 2 — ツール障害（ディレクトリの欠落 / マニフェストの欠落 / 誤った使い方 / 安全でない init 対象 / 未サポートのランタイム / フラグ値の欠落） update コマンドは意図的に存在しません。新しいバージョンは別個の install として扱います。 例 以下の例は説明用であり、規範的なものではありません。 関連: 検証エラーリファレンス。",
  },
  {
    slug: "reference/validation-errors",
    href: "/developers/docs/reference/validation-errors/",
    title: "Validation error reference",
    description: "Every validator diagnostic code with a user-facing explanation.",
    maturity: "stable",
    section: "Reference",
    headings: [
      {
        id: "codes",
        text: "Codes",
      },
      {
        id: "reading-a-diagnostic",
        text: "Reading a diagnostic",
      },
    ],
    body: "Validation error reference. Every namespaced ValidationDiagnosticCode from the SDK with a user-facing explanation: PACK_DIR_MISSING, PACK_MANIFEST_MISSING, PACK_MANIFEST_UNREADABLE, PACK_MANIFEST_INVALID, PACK_PROBLEMS_ROOT_MISSING, PACK_PROBLEMS_ROOT_TRAVERSAL, PACK_DUPLICATE_PROBLEM_ID, PACK_ARTIFACT_TRAVERSAL, PACK_ARTIFACT_MISSING, PROBLEM_METADATA_INVALID, RUNTIME_MISMATCH.",
  },
  {
    slug: "reference/security-provenance",
    href: "/developers/docs/reference/security-provenance/",
    title: "Security and provenance model",
    description: "Inert manifests, content digests, and pinned Git provenance.",
    maturity: "preview",
    section: "Reference",
    headings: [
      {
        id: "guarantees",
        text: "Guarantees",
      },
      {
        id: "how-provenance-is-recorded",
        text: "How provenance is recorded",
      },
      {
        id: "what-a-pack-cannot-do",
        text: "What a pack cannot do",
      },
    ],
    body: "Security and provenance model Pack init, validation and immutable installation are authoring tools. Installing or activating a pack does not add its problems to this candidate's event catalog. Activation is an offline catalog record, not a current hosting workflow. A problem pack must be reproducible and tamper-evident. The facts below are normative reference derived from the pack manifest's inert-by-design schema and the immutable snapshot / lock model in the pack installer. Guarantees How provenance is recorded Every installed revision is recorded in the lock with its content digest and source kind. A git-sourced pack additionally records the HTTPS repository URL (with credentials stripped), the resolved immutable 40-hex commit, and the subdir. The content digest is source-kind-agnostic, so the same bytes always produce the same digest regardless of how they were fetched. What a pack cannot do A v1 manifest cannot declare scripts, lifecycle hooks, remote URLs, or credentials. Install performs no runtime code execution. The Git fetch is shallow, hooks-disabled, and resolves only the pinned commit — it never follows a floating branch or tag. Related: pack manifest reference. セキュリティと来歴モデル pack の作成、検証、不変な revision の保存は作問用の機能です。install や activate をしても、この candidate の大会カタログへ問題は追加されません。activate はオフラインのカタログ記録であり、現行の競技実行手順ではありません。 問題パックは、再現可能で、改ざんを検出できるものでなければなりません。以下の事実は、 パックマニフェストの設計上不活性（inert-by-design）なスキーマと、パックインストーラーの 不変スナップショット / ロックモデルから導出された規範的リファレンスです。 保証 来歴の記録方法 インストールされたすべてのリビジョンは、コンテンツダイジェストとソース種別とともに ロックに記録されます。git をソースとするパックはさらに、HTTPS リポジトリ URL （認証情報は除去済み）、解決済みの不変な 40 桁 16 進コミット、およびサブディレクトリを 記録します。コンテンツダイジェストはソース種別に依存しないため、取得方法にかかわらず、 同じバイト列からは常に同じダイジェストが生成されます。 パックにできないこと v1 マニフェストでは、スクリプト、ライフサイクルフック、リモート URL、認証情報を 宣言できません。インストール時にランタイムのコード実行は一切行われません。Git の フェッチは shallow かつフック無効で行われ、ピン留めされたコミットのみを解決します。 浮動するブランチやタグを追跡することはありません。 関連: パックマニフェストリファレンス。",
  },
  {
    slug: "tutorials/first-pack",
    href: "/developers/docs/tutorials/first-pack/",
    title: "First pack tutorial",
    description:
      "Create, validate and store a pack without claiming a working event-deployment path.",
    maturity: "preview",
    section: "Tutorials",
    headings: [
      {
        id: "prerequisites",
        text: "Prerequisites",
      },
      {
        id: "scaffold",
        text: "Scaffold a pack",
      },
      {
        id: "validate",
        text: "Validate the contract",
      },
      {
        id: "install",
        text: "Install and inspect locally",
      },
      {
        id: "runtime-boundary",
        text: "Runtime boundary",
      },
      {
        id: "common-failures",
        text: "Common failures and diagnostic codes",
      },
      {
        id: "teardown",
        text: "Remove a stored revision",
      },
    ],
    body: "First pack tutorial Pack init, validation and immutable installation are authoring tools. Installing or activating a pack does not add its problems to this candidate's event catalog. Activation is an offline catalog record, not a current hosting workflow. Just want to run an existing pack? → Use an existing pack. Prerequisites Run from the TenkaCloud repository root with Bun 1.3.11 and installed dependencies. Local-directory operations need no cloud credentials. Installing from Git contacts the given HTTPS repository. Scaffold a pack This writes a manifest, one starter problem, an artifact placeholder and README. The placeholder is not a completed runnable exercise. Validate the contract Validation checks metadata, runtime declarations and files. It does not deploy, score or prove participant playability. Complete the problem and its own tests before making those claims. Install and inspect locally For a Git install use an HTTPS URL and full immutable 40-hex commit SHA. Keep source provenance and content digest. Do not use a moving branch as the revision. Runtime boundary There is no complete pack activate → event → deployment path in this candidate. Use its supported pinned core catalog to rehearse an event. The built-in local catalog uses its own validated runtime adapters. Common failures and diagnostic codes PACK_DIR_MISSING, MANIFEST_INVALID, duplicate IDs and missing artifacts need corrections in the pack, not a cloud deployment. See validation errors. Remove a stored revision Removal may refuse a retained activation/reference; inspect it first. Removing a pack is not exercise or cloud teardown. はじめての問題パック pack の作成、検証、不変な revision の保存は作問用の機能です。install や activate をしても、この candidate の大会カタログへ問題は追加されません。activate はオフラインのカタログ記録であり、現行の競技実行手順ではありません。 既存 pack を扱う場合は既存パックを使うへ進みます。 前提条件 Bun 1.3.11 と依存関係を準備し、TenkaCloud のルートで実行します。ローカルディレクトリの操作にはクラウド認証情報は不要です。Git からの install は指定した HTTPS repository へ接続します。 雛形を作る manifest、問題一つ、artifact の仮ファイル、README を作成します。仮ファイルのままでは完成した競技ではありません。 契約を検証する metadata、runtime 宣言、ファイルを検証します。配置、採点、参加者のプレイ確認は行いません。問題を実装し、その問題のテストを実行してください。 ローカルへ保存して確認する Git install は HTTPS URL と完全な 40 桁 commit SHA を使います。source provenance と content digest を保持し、変更される branch を revision にしないでください。 実行経路との境界 現行 candidate では pack activate から大会作成、配置まで一連の経路は完成していません。大会の確認には固定された core catalog の対応問題を使います。組み込みのローカルカタログは、検証済みの runtime adapter を使います。 よくある検証失敗 PACK_DIR_MISSING、MANIFEST_INVALID、ID 重複、artifact 欠落は pack 内を修正します。クラウド配置では解決しません。検証エラーを参照してください。 保存した revision を除く activation や参照が残っている場合は拒否されます。先に内容を確認してください。pack の削除は、問題環境やクラウド基盤の撤収ではありません。",
  },
];

export const DOC_SECTIONS: readonly DocSection[] = buildSections(DOC_PAGES);

function buildSections(pages: readonly DocPage[]): readonly DocSection[] {
  const order: string[] = ["Role manuals", "Start here"];
  const grouped = new Map<string, DocPage[]>();
  for (const page of pages) {
    if (!grouped.has(page.section)) {
      grouped.set(page.section, []);
      if (!order.includes(page.section)) order.push(page.section);
    }
    grouped.get(page.section)?.push(page);
  }
  return order.map((title) => ({
    title,
    pages: grouped.get(title) ?? [],
  }));
}

export function findDocBySlug(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}
