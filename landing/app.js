(() => {
  // 現在表示中の言語。 applyLang が唯一の書き手で、 DOM の外 (= フォームの
  // 状態メッセージなど) から辞書を引くときに使う。
  var activeLang = "ja";

  var SEO_METADATA = {
    ja: {
      title: "TenkaCloud | AWSクラウド実戦演習・競技プラットフォーム",
      description:
        "TenkaCloudは、本物のAWS環境でBattleとChallengeを開催できるOSSのクラウド実戦演習・競技プラットフォームです。チーム別環境、毎分採点、ランキング、問題カタログ、運営画面を提供します。",
      socialDescription:
        "本物のAWSでBattleとChallengeを開催。チーム別環境、毎分採点、ランキング、再利用できる問題カタログを備えたApache 2.0のOSSです。",
      canonical: "https://tenkacloud.com/?lang=ja",
      locale: "ja_JP",
      alternateLocale: "en_US",
      imageAlt: "TenkaCloud — AWSクラウド実戦演習・競技プラットフォーム",
      softwareDescription:
        "本物のAWS環境でBattleとChallengeを開催できる、Apache 2.0のクラウド実戦演習・競技プラットフォーム。",
    },
    en: {
      title: "TenkaCloud | Open-source AWS cloud competition platform",
      description:
        "TenkaCloud is an open-source platform for hands-on AWS cloud drills and competitions. Run isolated team environments, automated scoring, live leaderboards, and reusable Battle and Challenge catalogs.",
      socialDescription:
        "Run hands-on AWS Battles and self-paced Challenges with isolated team environments, automated scoring, live leaderboards, and reusable problem catalogs.",
      canonical: "https://tenkacloud.com/index.en.html",
      locale: "en_US",
      alternateLocale: "ja_JP",
      imageAlt: "TenkaCloud — Open-source AWS cloud competition platform",
      softwareDescription:
        "An Apache 2.0 platform for running hands-on AWS cloud drills as real-time Battles and self-paced Challenges.",
    },
  };

  function setMetaContent(name, content) {
    var meta = document.querySelector(`meta[name="${name}"]`);
    if (meta) meta.setAttribute("content", content);
  }

  function setPropertyContent(property, content) {
    var meta = document.querySelector(`meta[property="${property}"]`);
    if (meta) meta.setAttribute("content", content);
  }

  function setLinkHref(rel, href) {
    var link = document.querySelector(`link[rel="${rel}"]`);
    if (link) link.setAttribute("href", href);
  }

  function buildStructuredData(lang, metadata) {
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": "https://tenkacloud.com/#organization",
          name: "BULL LLC",
          alternateName: "合同会社BULL",
          url: "https://tenkacloud.com/",
          logo: {
            "@type": "ImageObject",
            url: "https://tenkacloud.com/assets/apple-touch-icon.png",
          },
          sameAs: ["https://github.com/susumutomita/TenkaCloud"],
        },
        {
          "@type": "WebSite",
          "@id": "https://tenkacloud.com/#website",
          name: "TenkaCloud",
          url: "https://tenkacloud.com/",
          inLanguage: ["ja", "en"],
          publisher: {
            "@id": "https://tenkacloud.com/#organization",
          },
        },
        {
          "@type": "SoftwareApplication",
          "@id": "https://tenkacloud.com/#software",
          name: "TenkaCloud",
          url: metadata.canonical,
          description: metadata.softwareDescription,
          applicationCategory: "EducationalApplication",
          applicationSubCategory: "Cloud training and competition platform",
          operatingSystem: "Web",
          isAccessibleForFree: true,
          license: "https://www.apache.org/licenses/LICENSE-2.0",
          codeRepository: "https://github.com/susumutomita/TenkaCloud",
          inLanguage: lang,
          publisher: {
            "@id": "https://tenkacloud.com/#organization",
          },
        },
        {
          "@type": "WebPage",
          "@id": `${metadata.canonical}#webpage`,
          url: metadata.canonical,
          name: metadata.title,
          description: metadata.description,
          inLanguage: lang,
          isPartOf: {
            "@id": "https://tenkacloud.com/#website",
          },
          about: {
            "@id": "https://tenkacloud.com/#software",
          },
        },
      ],
    };
  }

  function applySeoMetadata(lang) {
    var metadata = SEO_METADATA[lang];
    document.title = metadata.title;
    setMetaContent("description", metadata.description);
    setLinkHref("canonical", metadata.canonical);
    setPropertyContent("og:title", metadata.title);
    setPropertyContent("og:description", metadata.socialDescription);
    setPropertyContent("og:url", metadata.canonical);
    setPropertyContent("og:locale", metadata.locale);
    setPropertyContent("og:locale:alternate", metadata.alternateLocale);
    setPropertyContent("og:image:alt", metadata.imageAlt);
    setMetaContent("twitter:title", metadata.title);
    setMetaContent("twitter:description", metadata.socialDescription);
    setMetaContent("twitter:image:alt", metadata.imageAlt);
    var structuredData = document.getElementById("seo-structured-data");
    if (structuredData) {
      structuredData.textContent = JSON.stringify(buildStructuredData(lang, metadata));
    }
  }

  var I18N = {
    ja: {
      "nav.product": "プロダクト",
      "nav.problems": "問題",
      "nav.extend": "問題を作る",
      "nav.docs": "ドキュメント",
      "nav.offerings": "商用プラン",
      "nav.pricing": "料金",
      "nav.contact": "お問い合わせ",
      "nav.github": "GitHub",

      "hero.h1a": "クラウドエンジニアの、",
      "hero.h1b": "天下一武道会。",
      "hero.sub":
        "本物の AWS で競う、OSS の競技プラットフォーム。 「ローカルでは動く」アプリを本番品質へ ── <strong>認証・公開範囲・監査・可用性</strong>の仕上がりを毎分自動採点し、 順位がリアルタイムに動く。 主催者はイベント・採点・再利用できる問題カタログを 1 画面で運営。",
      "hero.quest_meta": "最初の 1 問 · 登録不要 · 約 3 分",
      "hero.quest_badge": "チュートリアル",
      "hero.quest_diff": "難易度: 入門",
      "hero.quest_title": "TenkaCloud とは? を、触って知る。",
      "hero.quest_desc":
        "説明を読むのではなく、1 問解く。プロダクトの仕組みもモードの違いも問題の中で分かり、クリアすると次の問題 <code>deploy-tenkacloud-lite</code> が開く。",
      "hero.quest_cta": "この問題で始める",
      "hero.cta_video": "▶ 30 秒でわかる",
      "hero.host_prefix": "主催者の方へ:",
      "hero.cta_host": "自分のイベントを開く",
      "hero.cta_quote": "Hosted Event の見積もり",
      "hero.trust": "合同会社 BULL 運営 · Apache 2.0",
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
      "app.chart_you": "(ゲスト あなた) 2360 pt",
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
      "extend.agent_title": "AI エージェントで始める",
      "extend.agent_lead":
        'Claude Code や Codex に下のプロンプトを貼り付けると、エージェントが TenkaCloud の説明から「遊ぶ / 立てる」の案内までやってくれます。中身は LLM 向けブリーフィング <a href="/llms-full.txt" target="_blank" rel="noopener noreferrer">llms-full.txt</a> です。',
      "extend.agent_copy": "プロンプトをコピー",
      "extend.agent_video": "▶ YouTube で見る",
      "extend.agent_video_href": "https://www.youtube.com/watch?v=nLsSJ3npdfw",
      "extend.agent_video_embed_src": "https://www.youtube.com/embed/nLsSJ3npdfw",
      "extend.agent_video_title": "AI エージェントで TenkaCloud を Mac にワンショット起動",
      "extend.agent_tutorial": "チュートリアルで確認する →",

      "book.eyebrow": "本で読む",
      "book.h2": "作り方を、一冊にまとめてあります。",
      "book.lead": "ローカル Challenge、AWS Challenge、AWS Battle を簡単な順に一から作り、 複数チームで遊べる競技として動かすまでを扱う本です。 TenkaCloud を題材にしていますが、 読むのに AWS アカウントも TenkaCloud の導入も要りません。 日本語版と英語版があります。",
      "book.jaTitle": "自分で作るクラウド競技",
      "book.jaLang": "日本語版",
      "book.enLang": "英語版",

      "offerings.eyebrow": "商用プラン",
      "offerings.h2": "プロダクト化された 3 つの提供形態。",
      "offerings.lead":
        "OSS プラットフォーム本体は Apache 2.0 で 無料 のまま。 構築 / 当日運営 / 年間プログラム を任せたい組織向けに、 形 (スコープ / 成果物 / 除外 / 提供モデル) を明文化した 3 つのプロダクト化された提供形態 を用意しています。",
      "offerings.a.role": "Hosted Event",
      "offerings.a.h": "単発イベントを、 丸ごと運営代行。",
      "offerings.a.p":
        "1 日のクラウド演習を、 公開 OSS 問題カタログから選定して 弊社が end-to-end で運営。 設計 / お客様 AWS への deploy / 事前 dry-run / 当日の live 進行 / 事後レポート。 <strong>1 回 fixed price</strong>。",
      "offerings.b.role": "Annual Arena",
      "offerings.b.h": "年間プログラム。",
      "offerings.b.p":
        "1 組織で <strong>年 4 回</strong> の運営代行イベントを年間契約で。 公開問題カタログから 入門 → 中級 → 上級 の learning path を設計。 ※ オリジナル問題の制作は本パックには含みません。",
      "offerings.d.role": "CCoE Enablement (add-on)",
      "offerings.d.h": "アドバイザリ、 別契約。",
      "offerings.d.p":
        "CCoE 運用モデル / 研修ロードマップ / カタログロードマップ / 内部展開戦略 の月次リテイナー。 上記 2 つの productized 提供には <strong>絶対に bundle しません</strong>。 両方ご希望なら 2 つの契約に分けます。",

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
      "ent.enterprise":
        "企業内での研修・演習・評価・独自教材の提供などで利用を検討される場合は、ぜひ一度お声がけください。TenkaCloud はオープンソースとして公開していますが、実際の現場で求められる題材、運用方法、閉じた環境での利用要件を伺いながら、プロダクトと教材の両方を改善していきたいと考えています。",
      "ent.cta1": "お問い合わせ",
      "ent.cta2": "GitHub を見る",
      "contact.cta": "お問い合わせフォーム",
      "form.name": "お名前",
      "form.organization": "会社・組織名",
      "form.email": "メールアドレス",
      "form.topic": "お問い合わせ種別",
      "form.topic.placeholder": "選択してください",
      "form.topic.plan": "プラン・見積もりの相談",
      "form.topic.training": "企業内の研修・演習での利用",
      "form.topic.custom": "カスタム問題の追加開発",
      "form.topic.other": "その他",
      "form.message": "お問い合わせ内容",
      "form.submit": "送信する",
      "form.sending": "送信しています…",
      "form.required": "必須項目を入力してください。",
      "form.invalidEmail": "メールアドレスの形式で入力してください。",
      "form.hasErrors": "入力に不備があります。 各項目の説明を確認してください。",
      "form.sent":
        "送信しました。 2 営業日以内に返信します。 返信が届かない場合はお手数ですが Google フォームからもう一度お送りください。",
      "form.failed":
        "送信できませんでした。 ネットワークを確認するか、 Google フォームからお送りください。",
      "contact.fineprint":
        'フォームの回答は Google フォーム (= Google が管理) に保存され、 お問い合わせ対応と見積もり提示のみに利用します (= <a href="./privacy.html">プライバシーポリシー</a>)。',

      "footer.tag": "AWS を題材にしたクラウド実戦演習を開催するための OSS ツール。 Apache 2.0。",
      "footer.disclaimer":
        "TenkaCloud は独立した OSS プロジェクトであり、 Amazon Web Services, Inc. またはその関連会社による提供・後援・承認を受けたものではありません。 AWS および関連する名称は Amazon.com, Inc. またはその関連会社の商標です。",
      "footer.p0": "概要",
      "footer.p1": "問題カタログ",
      "footer.r0": "ドキュメント",
      "footer.r2": "Changelog",
      // 書籍は日英で別の販売先にある。href も翻訳対象にして、閲覧言語に合うほうへ送る。
      // 現行仕様の正本はリポジトリ内のドキュメントで、書籍は設計判断と構築過程を読む資料。
      "footer.r3": "書籍『自分で作るクラウド競技』",
      "footer.r3Href": "https://zenn.dev/bull/books/cloud-competition",
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
      "nav.offerings": "Commercial",
      "nav.pricing": "Pricing",
      "nav.contact": "Contact",
      "nav.github": "GitHub",

      "hero.h1a": "The cloud engineer's ",
      "hero.h1b": "Tenka-Ichi.",
      "hero.sub":
        'An OSS competition platform on real AWS. Take an app that "only works locally" and make it production-grade — <strong>auth, exposure, audit, and availability</strong> are auto-scored every minute, and the leaderboard moves in real time. Organizers run events, scoring, and a reusable problem catalog from one console.',
      "hero.quest_meta": "First quest · No signup · ~3 min",
      "hero.quest_badge": "Tutorial",
      "hero.quest_diff": "Difficulty: Intro",
      "hero.quest_title": "Learn what TenkaCloud is — by playing it.",
      "hero.quest_desc":
        "Don't read the pitch — solve one quest. You'll learn the product and its modes inside the problem; clearing it unlocks <code>deploy-tenkacloud-lite</code>.",
      "hero.quest_cta": "Start with this quest",
      "hero.cta_video": "▶ Watch the 30-second tour",
      "hero.host_prefix": "Hosting an event?",
      "hero.cta_host": "Host your own event",
      "hero.cta_quote": "Get a Hosted Event quote",
      "hero.trust": "Operated by BULL LLC · Apache 2.0",
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
      "app.chart_you": "(Guest you) 2360 pt",
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
      "extend.agent_title": "Start with an AI agent",
      "extend.agent_lead":
        'Paste the prompt below into Claude Code or Codex and the agent will explain TenkaCloud and guide you through playing or hosting. It reads the LLM briefing <a href="/llms-full.txt" target="_blank" rel="noopener noreferrer">llms-full.txt</a>.',
      "extend.agent_copy": "Copy prompt",
      "extend.agent_video": "▶ Watch on YouTube",
      "extend.agent_video_href": "https://www.youtube.com/watch?v=GDu9FhWrQns",
      "extend.agent_video_embed_src": "https://www.youtube.com/embed/GDu9FhWrQns",
      "extend.agent_video_title": "Launch TenkaCloud on a Mac with one AI prompt",
      "extend.agent_tutorial": "Check it in the tutorial →",

      "book.eyebrow": "Read the book",
      "book.h2": "The whole method, in one book.",
      "book.lead": "Build a local Challenge, an AWS Challenge, and an AWS Battle in increasing order of difficulty, then run them as a competition several teams can play. It is written around TenkaCloud, but reading it needs neither an AWS account nor a TenkaCloud install. Available in English and Japanese.",
      "book.jaTitle": "自分で作るクラウド競技",
      "book.jaLang": "Japanese",
      "book.enLang": "English",

      "offerings.eyebrow": "Commercial offerings",
      "offerings.h2": "Three productized offerings — formally documented.",
      "offerings.lead":
        "The OSS platform stays free under Apache 2.0. For organizations that want setup, live operations, or a program run for them, we offer three productized packages. Each has a fixed shape — scope, deliverables, exclusions, delivery model.",
      "offerings.a.role": "Hosted Event",
      "offerings.a.h": "One operated drill, end to end.",
      "offerings.a.p":
        "A 1-day cloud drill on the public OSS catalog, run by us. Event design, deploy into your AWS account, dry run, live facilitation, post-event report. <strong>Per-event fixed price</strong>.",
      "offerings.b.role": "Annual Arena",
      "offerings.b.h": "A 12-month program.",
      "offerings.b.p":
        "An annual contract of <strong>4 operated events</strong> per year for one org: learning paths curated from the public problem catalog (beginner → advanced). Original problem development is not included in this package.",
      "offerings.d.role": "CCoE Enablement (add-on)",
      "offerings.d.h": "Advisory, sold separately.",
      "offerings.d.p":
        "A monthly retainer for operating-model / training-roadmap work. <strong>Never bundled</strong> into the two offerings above, so events stay productized. If you want both, that is two line items.",

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
      "ent.enterprise":
        "If you are considering TenkaCloud for enterprise or internal training use, please feel free to contact us. TenkaCloud is open source, but we would love to learn more about real-world training needs, custom exercise requirements, and how organizations want to run hands-on operations/security drills.",
      "ent.cta1": "Get in touch",
      "ent.cta2": "View on GitHub",
      "contact.cta": "Open the contact form",
      "form.name": "Name",
      "form.organization": "Company or team",
      "form.email": "Email",
      "form.topic": "What is this about",
      "form.topic.placeholder": "Please choose",
      "form.topic.plan": "Plans and quotes",
      "form.topic.training": "Internal training and drills",
      "form.topic.custom": "Custom problem development",
      "form.topic.other": "Something else",
      "form.message": "Your message",
      "form.submit": "Send",
      "form.sending": "Sending…",
      "form.required": "Please fill in the required fields.",
      "form.invalidEmail": "Please enter a valid email address.",
      "form.hasErrors": "Some entries need attention. Check the message under each field.",
      "form.sent":
        "Thanks — we'll reply within two business days. If you don't hear back, please resend through the Google Form.",
      "form.failed":
        "We couldn't send that. Check your connection, or use the Google Form instead.",
      "contact.fineprint":
        'Responses are stored in a Google Form (managed by Google) and used only for replying and quoting (see <a href="./privacy.en.html">Privacy Policy</a>).',

      "footer.tag":
        "An open-source tool for hosting hands-on cloud drills on real AWS. Apache 2.0.",
      "footer.disclaimer":
        "TenkaCloud is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates.",
      "footer.p0": "Overview",
      "footer.p1": "Problems",
      "footer.r0": "Docs",
      "footer.r2": "Changelog",
      "footer.r3": "Book: Build Your Own Cloud Competition",
      "footer.r3Href": "https://leanpub.com/build-your-own-cloud-competition",
      "footer.legal": "© 2026 BULL LLC (合同会社BULL) · TenkaCloud · Apache License 2.0",
      "footer.privacy": "Privacy Policy",
      "footer.terms": "Terms of Service",
      "footer.tokushoho": "Business identification (Japan TokushoHo)",
    },
  };

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

  function applyLang(lang) {
    activeLang = lang;
    document.documentElement.lang = lang;
    applySeoMetadata(lang);
    var dict = I18N[lang];
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      var key = el.getAttribute("data-i18n");
      if (dict[key] == null) return;
      // i18n 文字列は本 HTML 内に静的にハードコードされているので、 author-trusted。
      // インライン `<a>` や `<code>` を含む lead で innerHTML を使う必要があるため、
      // 全 i18n key で innerHTML 経由で render する (= textContent と違って HTML が escape されない)。
      el.innerHTML = dict[key];
    });
    document.querySelectorAll("[data-i18n-href]").forEach((el) => {
      var key = el.getAttribute("data-i18n-href");
      if (dict[key] == null) return;
      el.setAttribute("href", dict[key]);
    });
    document.querySelectorAll("[data-i18n-src]").forEach((el) => {
      var key = el.getAttribute("data-i18n-src");
      if (dict[key] == null) return;
      el.setAttribute("src", dict[key]);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      var key = el.getAttribute("data-i18n-title");
      if (dict[key] == null) return;
      el.setAttribute("title", dict[key]);
    });
    document.querySelectorAll(".nav-right .lang").forEach((btn) => {
      var isActive = btn.getAttribute("data-lang") === lang;
      btn.classList.toggle("on", isActive);
      if (isActive) {
        btn.setAttribute("aria-current", "page");
      } else {
        btn.removeAttribute("aria-current");
      }
    });
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
        "./docs/index.en.html": "./docs/",
      },
      en: {
        "./privacy.html": "./privacy.en.html",
        "./terms.html": "./terms.en.html",
        "./legal.html": "./legal.en.html",
        "./docs/": "./docs/index.en.html",
      },
    };
    var hrefMap = LEGAL_HREF_MAP[lang] || {};
    document
      .querySelectorAll(
        'footer a[href$="privacy.html"], footer a[href$="terms.html"], footer a[href$="legal.html"], footer a[href$="privacy.en.html"], footer a[href$="terms.en.html"], footer a[href$="legal.en.html"], a[href="./docs/"], a[href="./docs/index.en.html"]',
      )
      .forEach((a) => {
        var src = a.getAttribute("href");
        if (hrefMap[src]) a.setAttribute("href", hrefMap[src]);
      });
  }

  /**
   * Resolve the initial language with this priority:
   *   1. `?lang=ja|en` URL query (= shareable links)
   *   2. static page language (= index.en.html is crawlable without JavaScript)
   *   3. localStorage `tenkacloud.lang` (= sticky user choice)
   *   4. navigator.language starts with `ja` (= visitor's browser preference)
   *   5. default `en` (= 英語を 1st citizen に置く OSS / 海外への露出を想定)
   */
  function detectInitialLang() {
    var params = new URLSearchParams(window.location.search || "");
    var fromQuery = params.get("lang");
    if (fromQuery === "ja" || fromQuery === "en") return fromQuery;
    var staticLang = document.documentElement.getAttribute("data-static-lang");
    if (staticLang === "ja" || staticLang === "en") return staticLang;
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
    if (document.documentElement.getAttribute("data-static-lang") === lang) return;
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
      persistLang(lang);
    });
  });

  // #2711 follow-up: 「AI エージェントで始める」 の貼り付けプロンプトをコピーする。
  // ボタン文言は i18n のまま、 成功表示は CSS (.copied::after) に寄せる。
  document.querySelectorAll("[data-copy-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      var target = document.getElementById(btn.getAttribute("data-copy-target"));
      if (!target || !navigator.clipboard) return;
      navigator.clipboard.writeText(target.textContent.trim()).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1600);
      });
    });
  });

  /**
   * #contact のインラインフォームを Google フォームに接続する。
   *
   * 送信先の `entry.<数字>` は Google が採番するため手書きできない。
   * form/sync.gs が同期のたびに逆引きして landing/contact-form-config.json を
   * 再生成し、 ここが実行時にそれを読む。 だからフォームを編集しても LP は
   * 追従する。
   *
   * 設定が無い / 壊れている / DOM の項目とズレているときはインラインフォームを
   * 出さず、 従来の Google フォームリンクをそのまま残す。 送信は no-cors POST で
   * 応答を読めない (= 失敗を検知できない) ので、 壊れたフォームを見せるくらいなら
   * ホストされたフォームへ送ってもらうほうが安全。
   */
  function initContactForm() {
    var form = document.querySelector("[data-contact-form]");
    if (!form || !window.TenkaContactForm) return;

    var statusEl = form.querySelector("[data-contact-form-status]");
    var submitButton = form.querySelector("[data-contact-form-submit]");
    var inputs = Array.prototype.slice.call(form.querySelectorAll("[data-form-field]"));
    var sending = false;
    // いま不備が出ている項目の key。 まとめ表示 (statusEl) を引っ込めてよいかの
    // 判断に使う。
    var problemKeys = [];
    var statusKey = "";

    function fieldKey(input) {
      return input.getAttribute("data-form-field");
    }

    function errorEl(input) {
      return document.getElementById(input.getAttribute("aria-describedby"));
    }

    function text(key) {
      return I18N[activeLang][key] || "";
    }

    function setStatus(key, tone) {
      statusKey = key;
      statusEl.textContent = key ? text(key) : "";
      statusEl.setAttribute("data-tone", tone);
    }

    function readValues() {
      var values = {};
      inputs.forEach((input) => {
        values[fieldKey(input)] = input.value;
      });
      return values;
    }

    function clearProblem(input) {
      input.removeAttribute("aria-invalid");
      var target = errorEl(input);
      if (target) target.textContent = "";
      problemKeys = problemKeys.filter((key) => key !== fieldKey(input));
    }

    /**
     * 不備がすべて解消したら、 まとめ表示も引っ込める。 残したままだと 「直したのに
     * エラーが出続ける」 状態になり、 aria-live を読む利用者には現状が分からない。
     * 送信失敗 (form.failed) は入力の不備ではないので消さない。
     */
    function syncErrorBanner() {
      if (statusKey !== "form.hasErrors" || problemKeys.length > 0) return;
      setStatus("", "");
    }

    /**
     * 不備を項目ごとに表示する。 まとめて 1 行出すだけだと、 どの欄が悪いのかが
     * 支援技術にも視覚にも伝わらない (WCAG 2.1 SC 3.3.1)。 色だけに頼らないよう
     * 文言も併記する (SC 1.4.1)。
     */
    function markProblems(problems) {
      inputs.forEach(clearProblem);
      problems.forEach((problem) => {
        var input = inputs.filter((candidate) => fieldKey(candidate) === problem.key)[0];
        if (!input) return;
        input.setAttribute("aria-invalid", "true");
        var target = errorEl(input);
        if (target) {
          target.textContent = text(
            problem.reason === "email" ? "form.invalidEmail" : "form.required",
          );
        }
      });
      problemKeys = problems.map((problem) => problem.key);
      if (problems.length === 0) return;
      // 最初の不備へフォーカスを移す。 送信ボタンに留まると、 支援技術の
      // 利用者はどこを直せばよいか辿り直すことになる。
      var first = inputs.filter((candidate) => fieldKey(candidate) === problems[0].key)[0];
      if (first) first.focus();
    }

    function handleSubmit(config, event) {
      event.preventDefault();
      if (sending) return;
      var values = readValues();
      var problems = window.TenkaContactForm.validate(config, values);
      markProblems(problems);
      if (problems.length > 0) {
        // まとめ表示は項目ごとの文言と別にする。 同じ文言を 2 箇所へ出すと、
        // 1 項目だけ直したときにどちらを指しているのか判別できない。
        setStatus("form.hasErrors", "error");
        return;
      }
      sending = true;
      submitButton.disabled = true;
      setStatus("form.sending", "pending");
      window.TenkaContactForm.submit(config, values, {
        fetch: window.fetch.bind(window),
      })
        .then(() => {
          form.reset();
          inputs.forEach(clearProblem);
          // no-cors なので Google 側が受け付けたかは確認できない。 文面も
          // 「届かなければホストされたフォームで再送を」 と正直に書いてある。
          setStatus("form.sent", "ok");
        })
        .catch((error) => {
          console.error("[contact-form] submission failed:", error);
          setStatus("form.failed", "error");
        })
        .then(() => {
          sending = false;
          submitButton.disabled = false;
        });
    }

    /**
     * 同期された設定と DOM が食い違っていないかを確かめる。
     *
     * 項目の顔ぶれだけでなく、 入力欄の種類 (kind) と選択肢まで突き合わせる。
     * ここを見ないと、 sync.gs で選択肢を 1 つ改名しただけで LP が古い文字列を
     * 送り続け、 no-cors のせいで誰も気づけない。
     */
    function assertMatchesConfig(config) {
      var domKeys = inputs.map(fieldKey).sort().join(",");
      var configKeys = Object.keys(config.fields).sort().join(",");
      if (domKeys !== configKeys) {
        throw new Error(
          "contact form fields drifted from the synced config: DOM=[" +
            domKeys +
            "] config=[" +
            configKeys +
            "]",
        );
      }
      inputs.forEach((input) => {
        assertField(input, config.fields[fieldKey(input)]);
      });
    }

    var EXPECTED_TAG = { choice: "select", paragraph: "textarea", text: "input" };

    /** 1 項目について、 入力欄の種類と選択肢が設定と一致するかを見る。 */
    function assertField(input, field) {
      var tag = input.tagName.toLowerCase();
      if (tag !== EXPECTED_TAG[field.kind]) {
        throw new Error(
          `contact form control drifted for ${fieldKey(input)}: DOM=${tag} config=${field.kind}`,
        );
      }
      // 必須の食い違いも落とす。 フォーム側だけ必須になると、 LP は空のまま
      // 送れてしまい Google に弾かれる。 no-cors なので誰も気づけない。
      var domRequired = input.hasAttribute("required");
      if (domRequired !== field.required) {
        throw new Error(
          `contact form required flag drifted for ${fieldKey(input)}: DOM=${domRequired} config=${field.required}`,
        );
      }
      if (field.kind !== "choice") return;
      var options = Array.prototype.slice
        .call(input.options)
        .map((option) => option.value)
        .filter((value) => value !== "");
      if (options.join("\u0000") === field.choices.join("\u0000")) return;
      throw new Error(
        `contact form choices drifted for ${fieldKey(input)}: DOM=[${options.join(", ")}] config=[${field.choices.join(", ")}]`,
      );
    }

    function activate(config) {
      assertMatchesConfig(config);
      inputs.forEach((input) => {
        var correct = () => {
          clearProblem(input);
          syncErrorBanner();
        };
        input.addEventListener("input", correct);
        input.addEventListener("change", correct);
      });
      form.addEventListener("submit", (event) => handleSubmit(config, event));
      form.hidden = false;
      form.classList.add("contact-form-ready");
    }

    fetch("./contact-form-config.json", { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`contact-form-config.json: HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((raw) => activate(window.TenkaContactForm.parseConfig(raw)))
      .catch((error) => {
        console.error("[contact-form] falling back to the hosted Google Form:", error);
      });
  }

  var initialLang = detectInitialLang();
  applyLang(initialLang);
  reflectLangInUrl(initialLang);
  initContactForm();

  // Contact posts straight to a Google Form (see landing/contact-form.js and
  // form/sync.gs). No backend, no mailto -- responses live in Google, so the
  // static landing still holds no PII of its own.
})();
