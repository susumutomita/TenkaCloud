(() => {
  var I18N = {
    ja: {
      "nav.product": "プロダクト",
      "nav.problems": "問題",
      "nav.extend": "問題を作る",
      "nav.docs": "ドキュメント",
      "nav.pricing": "料金",
      "nav.contact": "お問い合わせ",
      "nav.github": "GitHub",

      "hero.h1a": "社内のクラウド研修を、",
      "hero.h1b": "ハンズオン演習に変える。",
      "hero.sub":
        "Battle (リアルタイム対戦) と Challenge (個別演習) を、 チームごとに 隔離された AWS 環境へ自動 deploy。 採点 / 進捗管理 / AWS Console アクセス は組み込み済み。",
      "hero.cta1": "モックで試す",
      "hero.cta2": "GitHub を見る",
      "app.lang": "◉ 日本語 ▼",
      "app.profile": "♙ ゲスト ▼",
      "app.menu": "メニュー",
      "app.event": "• イベント",
      "app.home": "ホーム",
      "app.scoreboard": "スコアボード",
      "app.score_events": "スコアイベント",
      "app.notifications": "お知らせ",
      "app.problems": "問題一覧",
      "app.tools": "• ツール",
      "app.sso": "SSO 資格情報",
      "app.welcome": "ようこそ、ゲストさん",
      "app.welcome_sub": "TenkaCloud Battle へようこそ",
      "app.team_score": "チーム累計スコア",
      "app.total": "合計",
      "app.rank": "順位",
      "app.problem_count": "問題数",
      "app.completed": "完了済",
      "app.score_trend": "スコア推移",
      "app.score_trend_desc": "同 event 内の全 2 チームを表示",
      "app.select_team": "event / チームを選択　⌄",
      "app.chart_you": "(ゲスト あなた) -2705 pt",
      "app.legend_you": "━ (ゲスト あなた)",
      "app.challenge_title": "問題に挑戦",
      "app.challenge_body": "3問が deploy 済です。問題一覧から挑戦してください。",
      "app.open_problems": "問題一覧を開く",

      "product.title": "問題カタログ",
      "product.breadcrumb": "Workspace · open-arena · Season 01",
      "product.sidebar.0": "問題",
      "product.sidebar.1": "リーダーボード",
      "product.sidebar.2": "イベント",
      "product.sidebar.3": "ドキュメント",

      "modes.eyebrow": "2 つのモード",
      "modes.h2": "対戦か、演習か。両方か。",
      "modes.lead":
        "リアルタイムの Battle と、じっくり解く Challenge。1 つのイベントに混ぜて使える。",
      "modes.battle.kicker": "Battle",
      "modes.battle.p":
        "稼働率で競う、リアルタイム対戦。毎分のヘルスチェックを生き残ったチームが、勝つ。",
      "modes.battle.live": "ROUND 03 · LIVE",
      "modes.challenge.kicker": "Challenge",
      "modes.challenge.p":
        "問題を解き、フラグを提出する。AWS の一つひとつのサービスを、ひとつずつ理解していく。",
      "modes.challenge.input": "Hello from tc-iam-…",
      "preview.score_events.title": "Score events",
      "preview.score_events.desc":
        "自チームのスコア変動履歴 (30 秒ごと自動更新、新しい順 100 件まで)",
      "preview.score_events.chart": "累計 score 推移",
      "preview.score_events.history": "履歴 (100)",
      "preview.score_events.col_time": "発生時刻",
      "preview.score_events.col_problem": "問題",
      "preview.score_events.col_type": "種類",
      "preview.score_events.col_points": "変動",
      "preview.score_events.time_now": "数秒前",
      "preview.score_events.time_minute": "1 分前",
      "preview.quests.title": "問題一覧 (Quests)",
      "preview.quests.desc":
        "自チームに deploy された問題のカタログ。各カードからアクセス先 URL に直接遷移できます。",
      "preview.quests.all": "すべて (3)",
      "preview.quests.unsolved": "未解決 (3)",
      "preview.quests.diff_mid": "難易度: 中級",
      "preview.quests.diff_intro": "難易度: 入門",
      "preview.quests.in_progress": "挑戦中",
      "preview.quests.unsolved_status": "未解答",
      "preview.quests.cleared": "⌄ 解決済み (0)",
      "preview.sso.desc":
        "AWS Console にワンクリックで federate ログイン。 参加者個人の AWS アカウントは不要 — 主催者が用意した環境へ、 ポータルから安全にアクセスできます。",
      "preview.sso.howto": "使い方",
      "preview.sso.body":
        "下のボタンを押すと新しいタブで AWS Console (CloudFormation スタック画面) が自動でログイン状態で開きます。session の TTL は 1 時間です。",
      "preview.sso.button": "AWS Console を開く",

      "aud.eyebrow": "誰のための",
      "aud.h2": "クラウド実戦力を、組織で育てる。",
      "aud.lead":
        "クラウド人材育成 (= CCoE) / Platform / SRE / Security 部門が、 イベント基盤を自前で作らずに ハンズオン AWS 演習 を開催 / 運営できます。 環境払い出し / ログイン / 採点 / 進捗管理 まで、 ひとつの画面で完結。",
      "aud.a.role": "CCoE / クラウド人材育成",
      "aud.a.h": "研修イベントを、 年に複数回。",
      "aud.a.p":
        "新卒オンボーディング / 内製化推進 / 部門横断の AWS 演習を、 同じプラットフォームで 年に複数回 開催できる。 単発ハンズオンから 計画的な 年間プログラム へ。",
      "aud.a.more": "導入のご相談",
      "aud.b.role": "Platform / SRE",
      "aud.b.h": "演習設計を、 1 画面で。",
      "aud.b.p":
        "チームごとに隔離された AWS 環境を自動で配り、 採点 / 進捗 / Console アクセス を集約。 1 週間かかっていた準備が半日に短縮。 facilitator の負荷も下げる。",
      "aud.b.more": "運営ガイド",
      "aud.c.role": "エンジニア / 個人参加",
      "aud.c.h": "実戦で、腕を上げる。",
      "aud.c.p":
        "本物の AWS で問題を解き、 ランクを上げる。 OSS なので、 勉強会 / 学校 / コミュニティが 自前 AWS 環境で無料開催することも可能。",
      "aud.c.more": "問題を作る",

      "onboard.eyebrow": "オンボーディング",
      "onboard.h2": "AWS との接続は、3 ステップ。",
      "onboard.lead":
        "「自分のアカウントに何をされるか」をなくす設計。最小権限の AssumeRole 一本だけで、すべてが動く。",
      "onboard.s1.h": "テンプレートを、1 度だけ。",
      "onboard.s1.p":
        "CloudFormation を自分のアカウントに 1 回デプロイ。それで IAM Role が用意される。",
      "onboard.s2.h": "ExternalId で、固く守る。",
      "onboard.s2.p":
        "TenkaCloud は固有の ExternalId 付きでしか、その Role を引き受けられない。Role ARN だけでは入れない。",
      "onboard.s3.h": "ポータルから、競技へ。",
      "onboard.s3.p":
        "ログインすれば、問題環境が自動で立ち上がる。エンドポイントと点数は、その瞬間から見える。",
      "onboard.s3.line2": "問題が割り当てられました",

      "trust.eyebrow": "セキュリティ",
      "trust.h2": "あなたの AWS は、ずっとあなたのもの。",
      "trust.bullets": [
        [
          "クロスアカウント AssumeRole + ExternalId。",
          "競技者アカウントへの操作は、すべて固有 ExternalId 付き。Role ARN を知っているだけでは、何もできない。",
        ],
        [
          "撤収は、いつでも自分の手で。",
          "ポータルから 1 クリックでスタックごと削除。リソースの取り残しも、想定外の請求もない。",
        ],
        [
          "コードは全部、GitHub にある。",
          "Lambda、Step Functions、IaC。何が動いているか、自分の目で読める。Apache License 2.0。",
        ],
        [
          "アイドル中は、お金がかからない。",
          "Lambda / DynamoDB / API Gateway すべて従量課金。 イベントを開催しない期間は、 実質ゼロで維持できる。",
        ],
      ],

      stats: [
        { n: "≈0", u: "$/h", l: "アイドル時の運用コストはほぼゼロを目指した設計。" },
        { n: "100", u: "%", l: "OSS / Apache 2.0。すべて読める。" },
        { n: "2", u: "files", l: "metadata.json + template.yaml で 1 問追加。" },
        { n: "1", u: "click", l: "競技者は AWS Console に federation ログイン。" },
      ],

      "extend.eyebrow": "問題は、増やせる",
      "extend.h2": "足りない問題は、自分で作ればいい。",
      "extend.lead":
        '問題カタログは <a href="https://github.com/susumutomita/TenkaCloudChallenge" target="_blank" rel="noopener noreferrer">TenkaCloudChallenge</a> リポジトリで完全に開かれていて、 metadata.json + template.yaml の 2 ファイルを書けば 1 問追加できます。 Claude Code 等のコーディングエージェント向けに 問題作成 skill (<code>new-problem</code>) も同梱されているので、 「こういう問題を作りたい」 とアイデアを話すだけで、 初めてでも 1 問が形になります。',
      "extend.cta1": "問題カタログを見る",
      "extend.cta2": "new-problem skill",

      "pricing.eyebrow": "料金",
      "pricing.h2": "単発イベントから、 年間プログラムへ。",
      "pricing.p":
        "プラットフォーム本体は Apache 2.0 の OSS なので、 <strong>自前 AWS アカウントに deploy して開催すれば無料</strong>。 構築や当日運営を任せたい / 継続開催したい方向けに、 規模に合わせた有料プランをご用意しています。",
      "pricing.starter.tier": "Starter",
      "pricing.starter.price": "50万円",
      "pricing.starter.unit": "/ 回",
      "pricing.starter.scope": "お試し (= 1 回 / 2 チームまで)",
      "pricing.starter.note": "初回 / 小規模で運営代行の体験を試したい方向け。",
      "pricing.starter.f1": "1 イベントあたり 2 チームまで",
      "pricing.starter.f2": "deploy / 当日進行サポート",
      "pricing.starter.f3": "公開問題セットから選定",
      "pricing.starter.fineprint": "※ AWS account はお客様側でご用意ください。",
      "pricing.starter.cta": "お見積もりを依頼",
      "pricing.hosted.tier": "Hosted",
      "pricing.hosted.price": "150万円",
      "pricing.hosted.unit": "/ 回",
      "pricing.hosted.scope": "1 回 5 チーム (〜 20 人) まで",
      "pricing.hosted.note": "構築から当日進行まで、 単発イベントを 丸ごと運営代行します。",
      "pricing.hosted.f1": "AWS account 準備 / deploy 支援",
      "pricing.hosted.f2": "当日の進行 + on-call / Red Team 役",
      "pricing.hosted.f3": "事後の振り返りレポート (= 採点履歴 / 攻撃可視化)",
      "pricing.hosted.f4": "問題セットの選定",
      "pricing.hosted.fineprint":
        "※ AWS account はお客様側でご用意ください。 こちらでご用意する場合は別途お見積もり。",
      "pricing.hosted.cta": "お見積もりを依頼",
      "pricing.enterprise.tier": "Annual Arena",
      "pricing.enterprise.price": "600万円",
      "pricing.enterprise.unit": "/ 年",
      "pricing.enterprise.scope": "年間契約 (= 年 4 回のイベント開催を代行)",
      "pricing.enterprise.note":
        "新卒教育 / 内製化推進 / CCoE プログラムなど、 同じプラットフォームで <strong>年 4 回イベントを開催したい</strong> 組織向け。",
      "pricing.enterprise.f1": "複数開催 (= 年 4 回、 部門別 / 期別)",
      "pricing.enterprise.f2":
        "公開問題カタログから 入門 → 中級 → 上級 の learning path 提案 + facilitator 運営手順書テンプレート",
      "pricing.enterprise.f3":
        "事後レポート PDF (= portal の採点履歴 / チーム別進捗 / 攻撃可視化 を整理、 1 イベント 1 部)",
      "pricing.enterprise.fineprint":
        "※ 規模 / 内容に応じて見積もり。 AWS account はお客様側でご用意ください。",
      "pricing.enterprise.cta": "プログラムについて相談",
      "pricing.tail":
        '<strong>カスタム問題の追加開発</strong>は要件定義から実装まで通常の受託開発と同じスコープになるため、 別途お見積もりします。 それ以上の規模 / 特別要件も含めて、 <a href="#contact">お問い合わせ</a> ください。',

      "ent.eyebrow": "どのプランがよいか分からない",
      "ent.h2": "まずは話してみませんか。",
      "ent.p":
        "クラウド人材育成プログラム、 内製化推進、 継続的な AWS 演習 — 規模 / 期間 / 参加者像を聞いた上で、 適切なプランを一緒に決めます。",
      "ent.cta1": "お問い合わせ",
      "ent.cta2": "GitHub を見る",
      "contact.field_name": "お名前 *",
      "contact.field_company": "所属組織",
      "contact.field_email": "メールアドレス *",
      "contact.field_plan": "興味のあるプラン",
      "contact.plan_unknown": "未定 / 相談したい",
      "contact.plan_custom_problem": "独自問題の追加開発",
      "contact.plan_oss": "OSS 自己ホストの相談",
      "contact.plan_other": "その他 / カスタム",
      "contact.field_scale": "想定規模 / 開催時期",
      "contact.field_message": "メッセージ",
      "contact.field_message_placeholder":
        "解決したい課題、 参加者の技術レベル、 過去の研修の振り返り 等、 何でもお書きください。",
      "contact.fineprint":
        '送信先: 合同会社BULL (TenkaCloud 運営)。 ご記入いただいた情報は、 お問い合わせ対応と見積もり提示のみに利用します (= <a href="./privacy.html">プライバシーポリシー</a>)。',
      "contact.submit": "送信する",

      "footer.tag": "AWS を題材にしたクラウド実戦演習を開催するための OSS ツール。 Apache 2.0。",
      "footer.disclaimer":
        "TenkaCloud は独立した OSS プロジェクトであり、 Amazon Web Services, Inc. またはその関連会社による提供・後援・承認を受けたものではありません。 AWS および関連する名称は Amazon.com, Inc. またはその関連会社の商標です。",
      "footer.p0": "概要",
      "footer.p1": "問題カタログ",
      "footer.p2": "参加者ポータル",
      "footer.p3": "運営コンソール",
      "footer.usage": "使い方",
      "footer.u0": "はじめる",
      "footer.u1": "ドキュメント",
      "footer.u2": "運用ガイド",
      "footer.r0": "ドキュメント",
      "footer.r1": "アーキテクチャ",
      "footer.r2": "Changelog",
      "footer.legal": "© 2026 合同会社BULL · TenkaCloud · Apache License 2.0",
      "footer.privacy": "プライバシーポリシー",
      "footer.terms": "利用規約",
      "footer.tokushoho": "特定商取引法に基づく表記",
    },
    en: {
      "nav.product": "Product",
      "nav.problems": "Problems",
      "nav.extend": "Author problems",
      "nav.docs": "Docs",
      "nav.pricing": "Pricing",
      "nav.contact": "Contact",
      "nav.github": "GitHub",

      "hero.h1a": "Run team-based cloud drills on real AWS, ",
      "hero.h1b": "without building the event platform yourself.",
      "hero.sub":
        "Battle (real-time) and Challenge (self-paced) drills, auto-deployed into <strong>isolated AWS environments for each team</strong>. Scoring, progress tracking, and AWS Console access are built in.",
      "hero.cta1": "Play the mock",
      "hero.cta2": "View on GitHub",
      "app.lang": "◉ English ▼",
      "app.profile": "♙ Guest ▼",
      "app.menu": "Menu",
      "app.event": "• Event",
      "app.home": "Home",
      "app.scoreboard": "Scoreboard",
      "app.score_events": "Score events",
      "app.notifications": "Notifications",
      "app.problems": "Problems",
      "app.tools": "• Tools",
      "app.sso": "SSO Credentials",
      "app.welcome": "Welcome, Guest",
      "app.welcome_sub": "Welcome to TenkaCloud Battle",
      "app.team_score": "Team cumulative score",
      "app.total": "Total",
      "app.rank": "Rank",
      "app.problem_count": "Problems",
      "app.completed": "Completed",
      "app.score_trend": "Score trend",
      "app.score_trend_desc": "Showing all 2 teams in this event",
      "app.select_team": "Select event / team　⌄",
      "app.chart_you": "(Guest you) -2705 pt",
      "app.legend_you": "━ (Guest you)",
      "app.challenge_title": "Take on problems",
      "app.challenge_body": "3 problems are deployed. Open the problem list to start.",
      "app.open_problems": "Open problem list",

      "product.title": "Problem catalog",
      "product.breadcrumb": "Workspace · open-arena · Season 01",
      "product.sidebar.0": "Problems",
      "product.sidebar.1": "Leaderboard",
      "product.sidebar.2": "Events",
      "product.sidebar.3": "Docs",

      "modes.eyebrow": "Two modes",
      "modes.h2": "Live battles. Solo challenges. Or both.",
      "modes.lead": "Real-time Battles and patient Challenges, in a single event if you want.",
      "modes.battle.kicker": "Battle",
      "modes.battle.p":
        "Uptime, in real time. A health check probes every team every minute — the last one standing wins.",
      "modes.battle.live": "ROUND 03 · LIVE",
      "modes.challenge.kicker": "Challenge",
      "modes.challenge.p":
        "Solve the problem, submit the flag, earn the points. Learn one AWS service at a time, in depth.",
      "modes.challenge.input": "Hello from tc-iam-…",
      "preview.score_events.title": "Score events",
      "preview.score_events.desc":
        "Your team's score-change history, auto-refreshed every 30 seconds. Up to 100 newest events.",
      "preview.score_events.chart": "Cumulative score trend",
      "preview.score_events.history": "History (100)",
      "preview.score_events.col_time": "Occurred",
      "preview.score_events.col_problem": "Problem",
      "preview.score_events.col_type": "Type",
      "preview.score_events.col_points": "Delta",
      "preview.score_events.time_now": "Seconds ago",
      "preview.score_events.time_minute": "1 min ago",
      "preview.quests.title": "Problem list (Quests)",
      "preview.quests.desc":
        "A catalog of problems deployed to your team. Jump directly to each access URL from its card.",
      "preview.quests.all": "All (3)",
      "preview.quests.unsolved": "Unsolved (3)",
      "preview.quests.diff_mid": "Difficulty: intermediate",
      "preview.quests.diff_intro": "Difficulty: intro",
      "preview.quests.in_progress": "In progress",
      "preview.quests.unsolved_status": "Unanswered",
      "preview.quests.cleared": "⌄ Cleared (0)",
      "preview.sso.desc":
        "One-click federated login to AWS Console. No personal AWS account required — participants access the environment the host has prepared, safely from the portal.",
      "preview.sso.howto": "How to use",
      "preview.sso.body":
        "Press a button below to open AWS Console, already signed in, in a new tab. The session TTL is one hour.",
      "preview.sso.button": "Open AWS Console",

      "aud.eyebrow": "Who it's for",
      "aud.h2": "Build cloud capability across the org.",
      "aud.lead":
        "For Cloud Enablement (CCoE), Platform / SRE, and Security teams that need hands-on AWS training — without rebuilding the event platform. Environment provisioning, login, scoring, and progress tracking — all in one screen.",
      "aud.a.role": "Cloud Enablement / CCoE",
      "aud.a.h": "Run training events multiple times a year.",
      "aud.a.p":
        "New-grad onboarding, internalization programs, cross-team AWS drills — run them multiple times a year on the same platform. Move from one-off workshops to a planned annual program.",
      "aud.a.more": "Talk to us",
      "aud.b.role": "Platform / SRE",
      "aud.b.h": "Design drills from one screen.",
      "aud.b.p":
        "Each team gets an isolated AWS environment, automatically provisioned. Scoring, progress, and Console access are aggregated. A week of setup collapses to an afternoon, freeing up facilitators.",
      "aud.b.more": "Operator guide",
      "aud.c.role": "Engineers / individual learners",
      "aud.c.h": "Sharpen on the real thing.",
      "aud.c.p":
        "Solve problems on live AWS infrastructure and climb the rank. The platform is OSS, so meetups, schools, and communities can also self-host on their own AWS account for free.",
      "aud.c.more": "Author a problem",

      "onboard.eyebrow": "Onboarding",
      "onboard.h2": "Connect AWS in three steps.",
      "onboard.lead":
        'We designed away the "what\'s it going to do in my account?" question. One least-privilege AssumeRole — nothing more, nothing less.',
      "onboard.s1.h": "Deploy the bootstrap, once.",
      "onboard.s1.p":
        "One CloudFormation template, deployed once into your account. An IAM Role is provisioned for us.",
      "onboard.s2.h": "Locked with ExternalId.",
      "onboard.s2.p":
        "TenkaCloud can only AssumeRole with a unique ExternalId. A leaked Role ARN gets you nowhere.",
      "onboard.s3.h": "Compete from the portal.",
      "onboard.s3.p":
        "Log in. Your problem stack deploys itself. Endpoints and scores are live the moment you land.",
      "onboard.s3.line2": "Problem assigned",

      "trust.eyebrow": "Security",
      "trust.h2": "Your AWS account, still yours.",
      "trust.bullets": [
        [
          "Cross-account AssumeRole + ExternalId.",
          "Every call into a player account carries a unique ExternalId. Knowing the Role ARN gets an attacker nothing.",
        ],
        [
          "Tear it down whenever, yourself.",
          "One click in the portal removes the stack. No orphans, no surprise charges.",
        ],
        [
          "The code is on GitHub.",
          "Lambdas, Step Functions, the IaC — read what runs, line by line. Apache License 2.0.",
        ],
        [
          "Near-zero idle cost.",
          "Lambda / DynamoDB / API Gateway are all pay-per-use. Between events, the platform sits at near-zero spend (subject to AWS minimum service charges).",
        ],
      ],

      stats: [
        { n: "≈0", u: "$/h", l: "Designed for near-zero idle cost." },
        { n: "100", u: "%", l: "Open source. Apache 2.0. End to end." },
        { n: "2", u: "files", l: "metadata.json + template.yaml to ship a problem." },
        { n: "1", u: "click", l: "Participants federate into the AWS Console." },
      ],

      "extend.eyebrow": "Catalog grows with you",
      "extend.h2": "Missing a problem? Author your own.",
      "extend.lead":
        'The problem catalog lives in the open <a href="https://github.com/susumutomita/TenkaCloudChallenge" target="_blank" rel="noopener noreferrer">TenkaCloudChallenge</a> repo — write two files (metadata.json + template.yaml) and you have a new problem. A <code>new-problem</code> skill is shipped for Claude Code and other coding agents, so even first-timers can ship a problem just by describing the idea.',
      "extend.cta1": "Browse the catalog",
      "extend.cta2": "new-problem skill",

      "pricing.eyebrow": "Pricing",
      "pricing.h2": "Start small. Move to a yearly program.",
      "pricing.p":
        "The platform itself is Apache 2.0 OSS, so <strong>self-hosting on your own AWS account is free</strong>. Pay only when you want setup, day-of operations, or a multi-event program run for you.",
      "pricing.starter.tier": "Starter",
      "pricing.starter.price": "¥500K",
      "pricing.starter.unit": "/ event",
      "pricing.starter.scope": "Pilot (1 event, up to 2 teams)",
      "pricing.starter.note":
        "For first-time hosts who want to validate the operated experience at a small scale.",
      "pricing.starter.f1": "Up to 2 teams per pilot event",
      "pricing.starter.f2": "Deploy / day-of support",
      "pricing.starter.f3": "Selected from the public problem set",
      "pricing.starter.fineprint": "* You bring your own AWS account.",
      "pricing.starter.cta": "Request a quote",
      "pricing.hosted.tier": "Hosted Event",
      "pricing.hosted.price": "¥1.5M",
      "pricing.hosted.unit": "/ event",
      "pricing.hosted.scope": "Up to 5 teams / ~20 participants per event",
      "pricing.hosted.note":
        "We handle setup, run the day, and tear down — one full event, operated.",
      "pricing.hosted.f1": "AWS account prep / deploy support",
      "pricing.hosted.f2": "Live facilitation + on-call / Red Team role",
      "pricing.hosted.f3": "Post-event report (scoring history, attack timeline)",
      "pricing.hosted.f4": "Problem selection",
      "pricing.hosted.fineprint":
        "* You bring your own AWS account. If we need to provide one, we'll quote separately.",
      "pricing.hosted.cta": "Request a quote",
      "pricing.enterprise.tier": "Annual Arena",
      "pricing.enterprise.price": "¥6M",
      "pricing.enterprise.unit": "/ year",
      "pricing.enterprise.scope": "Annual contract — 4 operated events per year",
      "pricing.enterprise.note":
        "For organizations that want to run <strong>4 events per year</strong> on the same platform — new-grad onboarding, CCoE programs, or platform enablement.",
      "pricing.enterprise.f1": "Up to 4 events per year (by department / cohort)",
      "pricing.enterprise.f2":
        "Beginner → intermediate → advanced learning path proposal from the public problem catalog + facilitator playbook template",
      "pricing.enterprise.f3":
        "Post-event PDF report (= scoring history, team progress, and attack timeline pulled from the portal — one PDF per event)",
      "pricing.enterprise.fineprint":
        "* Quoted by scope and scale. You bring your own AWS account.",
      "pricing.enterprise.cta": "Talk about a program",
      "pricing.tail":
        '<strong>Custom problem authoring</strong> follows the same scope as regular software development (requirements → implementation), so we quote it separately. <a href="#contact">Get in touch</a> for that and for anything beyond these tiers.',

      "ent.eyebrow": "Not sure which plan fits",
      "ent.h2": "Let's talk.",
      "ent.p":
        "Cloud enablement programs, internal onboarding, recurring AWS drills — share your scale, cadence, and audience, and we'll figure out the right setup together.",
      "ent.cta1": "Get in touch",
      "ent.cta2": "View on GitHub",
      "contact.field_name": "Name *",
      "contact.field_company": "Organization",
      "contact.field_email": "Email *",
      "contact.field_plan": "Plan you're interested in",
      "contact.plan_unknown": "Not sure / let's talk",
      "contact.plan_oss": "OSS self-host help",
      "contact.plan_other": "Other / custom",
      "contact.field_scale": "Expected scale / timing",
      "contact.field_message": "Message",
      "contact.field_message_placeholder":
        "Tell us the problem you're trying to solve, your participants' technical level, lessons from past trainings — anything that helps.",
      "contact.fineprint":
        'Sent to: BULL LLC (operator of TenkaCloud). Your input is used only for replying and quoting (see <a href="./privacy.en.html">Privacy Policy</a>).',
      "contact.submit": "Send",

      "footer.tag":
        "An open-source tool for hosting hands-on cloud drills on real AWS. Apache 2.0.",
      "footer.disclaimer":
        "TenkaCloud is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates.",
      "footer.p0": "Overview",
      "footer.p1": "Problems",
      "footer.p2": "Participant portal",
      "footer.p3": "Operator console",
      "footer.usage": "Usage",
      "footer.u0": "Start",
      "footer.u1": "Docs",
      "footer.u2": "Operations guide",
      "footer.r0": "Docs",
      "footer.r1": "Architecture",
      "footer.r2": "Changelog",
      "footer.legal": "© 2026 BULL LLC (合同会社BULL) · TenkaCloud · Apache License 2.0",
      "footer.privacy": "Privacy Policy",
      "footer.terms": "Terms of Service",
      "footer.tokushoho": "Business identification (Japan TokushoHo)",
    },
  };

  var PRODUCT_ROWS = [
    {
      cat: "Battle",
      id: "security-battle-royale",
      name: { ja: "Security Battle Royale", en: "Security Battle Royale" },
      diff: 3,
      pts: "1,200 pts",
    },
    {
      cat: "Challenge",
      id: "iam-escape-room",
      name: { ja: "IAM Escape Room", en: "IAM Escape Room" },
      diff: 4,
      pts: "  800 pts",
    },
    {
      cat: "Challenge",
      id: "cost-optimizer",
      name: { ja: "Cost Optimizer", en: "Cost Optimizer" },
      diff: 2,
      pts: "  400 pts",
    },
    {
      cat: "Battle",
      id: "lambda-cold-war",
      name: { ja: "Lambda Cold War", en: "Lambda Cold War" },
      diff: 4,
      pts: "1,000 pts",
    },
  ];

  function renderProductRows(lang) {
    var productRows = document.getElementById("product-rows");
    if (!productRows) return;
    var html = PRODUCT_ROWS.map((r) => {
      var stars = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= r.diff ? "on" : ""}"></i>`).join("");
      var tagClass = r.cat === "Battle" ? "battle" : "challenge";
      return (
        '<div class="row">' +
        '<div><div class="name">' +
        r.name[lang] +
        '</div><span class="id">' +
        r.id +
        "</span></div>" +
        '<span class="tag ' +
        tagClass +
        '">' +
        r.cat +
        "</span>" +
        '<span class="stars">' +
        stars +
        "</span>" +
        '<span class="pts">' +
        r.pts +
        "</span>" +
        "</div>"
      );
    }).join("");
    productRows.innerHTML = html;
  }

  function renderTrustBullets(lang) {
    var bullets = I18N[lang]["trust.bullets"];
    var html = bullets
      .map((entry) => `<li><span><b>${entry[0]}</b> ${entry[1]}</span></li>`)
      .join("");
    document.getElementById("trust-bullets").innerHTML = html;
  }

  function renderStats(lang) {
    var stats = I18N[lang].stats;
    var html = stats
      .map(
        (s) =>
          '<div class="stat">' +
          '<div class="n">' +
          s.n +
          '<span class="u">' +
          s.u +
          "</span></div>" +
          '<div class="l">' +
          s.l +
          "</div>" +
          "</div>",
      )
      .join("");
    document.getElementById("stats-grid").innerHTML = html;
  }

  var SCORE_BASE = [
    { name: "team-shogun", pts: 8420 },
    { name: "team-honnoji", pts: 7990 },
    { name: "team-sekigahara", pts: 7710 },
    { name: "team-osaka", pts: 6420 },
  ];

  function renderScoreboard(tick) {
    var scoreboardRows = document.getElementById("scoreboard-rows");
    if (!scoreboardRows) return;
    var html = SCORE_BASE.map((r, i) => {
      var pts = r.pts + tick * (4 - i) * 7;
      var leadCls = i === 0 ? " lead" : "";
      return (
        '<div class="row' +
        leadCls +
        '">' +
        '<span class="rank">' +
        (i + 1) +
        "</span>" +
        '<span class="name">' +
        r.name +
        "</span>" +
        '<span class="pts">' +
        pts.toLocaleString() +
        "</span>" +
        "</div>"
      );
    }).join("");
    scoreboardRows.innerHTML = html;
  }

  function applyLang(lang) {
    document.documentElement.lang = lang;
    var dict = I18N[lang];
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      var key = el.getAttribute("data-i18n");
      if (dict[key] == null) return;
      // i18n 文字列は本 HTML 内に静的にハードコードされているので、 author-trusted。
      // インライン `<a>` や `<code>` を含む lead で innerHTML を使う必要があるため、
      // 全 i18n key で innerHTML 経由で render する (= textContent と違って HTML が escape されない)。
      el.innerHTML = dict[key];
    });
    document.querySelectorAll(".nav-right .lang").forEach((btn) => {
      var isActive = btn.getAttribute("data-lang") === lang;
      btn.classList.toggle("on", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    renderProductRows(lang);
    renderTrustBullets(lang);
    renderStats(lang);
    // Legal page link 群を locale に合わせて swap (= en visitor が ./privacy.html (ja)
    // に飛ばないように、 en の場合は ./privacy.en.html / terms.en.html / legal.en.html
    // に href を切り替える)。 ja 戻しは逆方向。
    var LEGAL_HREF_MAP = {
      ja: {
        "./privacy.en.html": "./privacy.html",
        "./terms.en.html": "./terms.html",
        "./legal.en.html": "./legal.html",
      },
      en: {
        "./privacy.html": "./privacy.en.html",
        "./terms.html": "./terms.en.html",
        "./legal.html": "./legal.en.html",
      },
    };
    var hrefMap = LEGAL_HREF_MAP[lang] || {};
    document
      .querySelectorAll(
        'footer a[href$="privacy.html"], footer a[href$="terms.html"], footer a[href$="legal.html"], footer a[href$="privacy.en.html"], footer a[href$="terms.en.html"], footer a[href$="legal.en.html"]',
      )
      .forEach((a) => {
        var src = a.getAttribute("href");
        if (hrefMap[src]) a.setAttribute("href", hrefMap[src]);
      });
  }

  /**
   * Resolve the initial language with this priority:
   *   1. `?lang=ja|en` URL query (= shareable links)
   *   2. localStorage `tenkacloud.lang` (= sticky user choice)
   *   3. navigator.language starts with `ja` (= visitor's browser preference)
   *   4. default `en` (= 英語を 1st citizen に置く OSS / 海外への露出を想定)
   */
  function detectInitialLang() {
    var params = new URLSearchParams(window.location.search || "");
    var fromQuery = params.get("lang");
    if (fromQuery === "ja" || fromQuery === "en") return fromQuery;
    var stored = null;
    try {
      stored = window.localStorage.getItem("tenkacloud.lang");
    } catch (_) {
      /* localStorage blocked (= privacy mode); fall through */
    }
    if (stored === "ja" || stored === "en") return stored;
    var nav = (navigator.language || "en").toLowerCase();
    if (nav.indexOf("ja") === 0) return "ja";
    return "en";
  }

  function persistLang(lang) {
    try {
      window.localStorage.setItem("tenkacloud.lang", lang);
    } catch (_) {
      /* ignore */
    }
  }

  function reflectLangInUrl(lang) {
    var url;
    try {
      url = new URL(window.location.href);
    } catch (_) {
      /* URL API unavailable; language switching still works in-place */
      return;
    }
    url.searchParams.set("lang", lang);
    try {
      window.history.replaceState({}, "", url);
    } catch (_) {
      /* history API may be blocked; ignore */
    }
  }

  document.querySelectorAll(".nav-right .lang").forEach((btn) => {
    btn.addEventListener("click", () => {
      var lang = btn.getAttribute("data-lang");
      applyLang(lang);
      persistLang(lang);
      reflectLangInUrl(lang);
    });
  });

  var initialLang = detectInitialLang();
  applyLang(initialLang);
  reflectLangInUrl(initialLang);

  var tick = 0;
  renderScoreboard(tick);
  setInterval(() => {
    tick += 1;
    renderScoreboard(tick);
  }, 1500);

  // Contact form submission. backend が無いので 入力内容を mailto: URL に組み立てて
  // ユーザーの mail client を開く (= GitHub Pages の static site にできる最小実装)。
  // 将来 backend (= Lambda Function URL) を立てたら fetch に差し替え。
  function readContactInputs(form) {
    var data = new FormData(form);
    var pick = (k) => String(data.get(k) || "").trim();
    return {
      name: pick("name"),
      email: pick("email"),
      company: pick("company"),
      plan: pick("plan"),
      scale: pick("scale"),
      message: pick("message"),
    };
  }

  function buildMailLines(input) {
    return [
      "TenkaCloud お問い合わせ",
      "",
      `お名前: ${input.name}`,
      `所属組織: ${input.company || "(未記入)"}`,
      `メールアドレス: ${input.email}`,
      `興味のあるプラン: ${input.plan || "(未指定)"}`,
      `想定規模 / 開催時期: ${input.scale || "(未記入)"}`,
      "",
      "メッセージ:",
      input.message || "(なし)",
      "",
      "---",
      `送信元: ${window.location.href}`,
    ];
  }

  function buildMailUrls(input) {
    var body = encodeURIComponent(buildMailLines(input).join("\n"));
    var subject = encodeURIComponent(
      `[TenkaCloud] ${input.plan || "お問い合わせ"} — ${input.name}`,
    );
    return {
      primary: `mailto:oyster880+tenkacloud@gmail.com?subject=${subject}&body=${body}`,
      discussionUrl: `https://github.com/susumutomita/TenkaCloud/discussions/new?category=general&body=${body}`,
    };
  }

  function renderContactSuccess(feedback, discussionUrl) {
    feedback.hidden = false;
    feedback.className = "contact-feedback success";
    feedback.innerHTML =
      "メーラーを起動しました。 もし開かない場合は、 こちらの " +
      '<a href="' +
      discussionUrl +
      '" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">' +
      "GitHub Discussions から送信</a> もご利用いただけます。 ご連絡お待ちしています。";
  }

  window.submitContactForm = (event) => {
    event.preventDefault();
    var input = readContactInputs(event.target);
    var feedback = document.getElementById("contact-feedback");
    if (!input.name || !input.email) {
      feedback.hidden = false;
      feedback.className = "contact-feedback error";
      feedback.textContent = "お名前とメールアドレスは必須です。";
      return false;
    }
    var urls = buildMailUrls(input);
    var opened = window.open(urls.primary, "_self");
    renderContactSuccess(feedback, urls.discussionUrl);
    if (!opened) {
      // mailto: opener が拒否された (= popup blocker)。 location.href fallback。
      window.location.href = urls.primary;
    }
    return false;
  };
})();
