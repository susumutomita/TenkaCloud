(() => {
  var SEO_METADATA = {
    ja: {
      title: "TenkaCloud | ゲームで学ぶセキュリティ研修・クラウド演習",
      description:
        "セキュリティの判断をゲームで学ぶTenkaCloud。クラウド操作の判断ゲームとチーム演習を、企業の研修や勉強会に。現在使えるデモと開催方法を紹介します。",
      socialDescription:
        "危険なクラウド操作を見抜くゲームとチーム演習。企業の研修に、判断と振り返りの体験を。今すぐデモを試せます。",
      canonical: "https://tenkacloud.com/?lang=ja",
      locale: "ja_JP",
      alternateLocale: "en_US",
      imageAlt: "TenkaCloud — AWSクラウド実戦演習・競技プラットフォーム",
      softwareDescription:
        "ローカルとAWSクラウドで問題と得点を共有する、Apache 2.0の競技プラットフォーム。",
    },
    en: {
      title: "TenkaCloud | Security training through games and cloud exercises",
      description:
        "Practice security decisions with TenkaCloud. Explore the available cloud decision game and team exercises for workplace training, onboarding and workshops.",
      socialDescription:
        "Spot risky cloud operations and practice as a team. Add decisions and reflection to workplace training. Try the available demos.",
      canonical: "https://tenkacloud.com/index.en.html",
      locale: "en_US",
      alternateLocale: "ja_JP",
      imageAlt: "TenkaCloud — Open-source AWS cloud competition platform",
      softwareDescription: "An Apache 2.0 competition platform for local and AWS cloud hosting.",
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
      "nav.presentations": "発表資料",
      "nav.offerings": "商用プラン",
      "nav.pricing": "料金",
      "nav.contact": "お問い合わせ",
      "nav.github": "GitHub",

      "hero.h1a": "セキュリティ研修を、",
      "game.cta": "Cloud Master で遊ぶ",
      "game.p":
        "クラウド操作の引数と状況から異変を見抜く「APIの番人。」。正常な操作は通し、危険な操作をタップ。3ライフと見逃し解説で学べます。",
      "game.h2": "目指せクラウドマスター。",
      "game.eyebrow": "現在遊べるゲーム",
      "future.plan":
        "一般社員向けの、怪しいメールを見分ける教材などを構想しています。現在利用できるのは、クラウド操作の判断ゲームとチーム演習です。",
      "future.p":
        "急かされた依頼。権威を感じる差出人。見慣れた画面。人を責めるのではなく、立ち止まり、確認し、安全な行動を選ぶ練習へ。",
      "future.h2": "守るのは、設定だけではない。",
      "future.eyebrow": "これから広げたい領域",
      "hero.caption": "Cloud Master · 実際のプレー画面",
      "hero.gameAlt": "Cloud Master の実際のプレー画面。操作の状況を読み、危険なものを選ぶ。",
      "hero.gameSrc": "./assets/cloud-master-ja.png",
      "hero.gameHref": "./cloud-master/?lang=ja",
      "hero.walkthrough": "チーム演習の体験版",
      "hero.consult": "研修での利用を相談する",
      "hero.h1b": "判断して学ぶゲームへ。",
      "hero.sub":
        "AIとともに作る人にも、使う人にも。危険に気づき、判断し、理由を確かめる。繰り返し試す体験を、いつもの研修に。",
      "hero.vibe":
        "<strong>まずは、同じ PC で。</strong> ローカル開催は SQLite を使い、AWS アカウントは不要です。Docker 問題には Docker Engine と Compose が必要です。",
      "hero.quest_meta": "今すぐ遊べる · 登録不要",
      "hero.quest_badge": "ブラウザ体験版",
      "hero.quest_diff": "インストール不要",
      "hero.quest_title": "Cloud Master を試す",
      "hero.quest_desc":
        "危険なクラウド操作をタップ。見逃した理由まで振り返る、短時間のサバイバル。",
      "hero.quest_cta": "ゲームをはじめる",
      "hero.startHref": "/docs/getting-started/#local-start",
      "hero.cta_demo": "自分の PC で起動する",
      "hero.cta_video": "▶ 30 秒でわかる",
      "hero.host_prefix": "主催者の方へ:",
      "hero.cta_host": "開催ガイド",
      "hero.hostHref": "./docs/manual/organizer/",
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

      "modes.eyebrow": "2 つの競技形式",
      "modes.h2": "対戦か、演習か。両方か。",
      "modes.lead":
        "共有状態で競う Battle と、問題を解く Challenge。下は画面サンプルです。現行の対応問題は運営ガイドで確認してください。",
      "modes.battle.kicker": "Battle",
      "modes.battle.p":
        "Cryptography Battle はチーム共通の試合状態を使い、行動に応じて得点します。AWS 問題の採点方式と接続条件は運営ガイドで確認してください。",
      "modes.battle.live": "ROUND 03 · LIVE",
      "modes.challenge.kicker": "Challenge",
      "modes.challenge.p":
        "問題を解き、指定された回答やチェックポイントを提出します。ローカルの Compose 問題もチーム競技に使えます。",
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
        "下は AWS Console 接続の画面サンプルです。現行版で利用できる Console / CLI は、問題ごとの access 定義と開催条件で決まります。",
      "preview.sso.howto": "使い方",
      "preview.sso.body":
        "資格情報の期限は参加者画面に表示します。AWS 開催の設定と問題ごとの接続条件は運営ガイドで確認してください。実 AWS での大会性能は未検証です。",
      "preview.sso.button": "表示例: AWS Console",

      "aud.eyebrow": "企業での使い方",
      "aud.h2": "読む研修に、判断する練習を。",
      "aud.lead":
        "人材育成・セキュリティ・開発部門の方へ。スライドや動画での理解に、実践と振り返りを重ね、知識の定着を目指します。",
      "aud.a.role": "新任開発者の基礎研修",
      "aud.a.h": "危険に、気づく。",
      "aud.a.p":
        "Cloud Masterで、クラウド操作の状況を読み、危険なものを見抜く。誤答の理由を確かめて、次の判断につなげます。",
      "aud.a.more": "ゲームを試す",
      "aud.b.role": "チームの勉強会・演習",
      "aud.b.h": "根拠を、話し合う。",
      "aud.b.p":
        "チームで問題を解き、得点を共有。なぜその操作を選んだか、ログのどこを手掛かりにしたかを、勉強会で話し合えます。",
      "aud.b.more": "演習の開催方法",
      "aud.b.moreHref": "./docs/manual/organizer/",
      "aud.c.role": "定期研修の実践補完",
      "aud.c.h": "自分たちの題材で、試す。",
      "aud.c.p":
        "社内で学んだ内容を、演習問題として出題する。既存の問題を使うほか、自社の研修に合わせた問題を作れます。",
      "aud.c.more": "問題の作り方",
      "aud.c.moreHref": "./docs/manual/problem-author/",

      "onboard.eyebrow": "オンボーディング",
      "onboard.h2": "ローカル競技を、順番に試す。",
      "onboard.lead":
        "まず同じ PC で起動と得点を確認します。AWS 開催は、対応範囲・費用・権限を運営ガイドで確認してから別途設定します。",
      "onboard.s1.h": "取得して、起動する。",
      "onboard.s1.p":
        "起動ガイドに沿って clone → make install → make local。問題は URL/ref またはローカル path から取得します。初回は build を省略しません。",
      "onboard.s2.h": "大会とチームを用意する。",
      "onboard.s2.p":
        "同じ PC の 127.0.0.1:5174 で、表示された主催者キーを使います。大会・チーム・対応問題を選び、開始します。主催者キーは参加者へ渡しません。",
      "onboard.s3.h": "参加して、得点を確認する。",
      "onboard.s3.p":
        "同じ PC の 127.0.0.1:5175 へチームキーで参加します。まず Crypto Battle などの native 問題を試し、操作と得点を確認します。別端末の Tailscale 接続と Docker の利用条件は起動ガイドで確認してください。",
      "onboard.s3.line2": "問題が割り当てられました",

      "trust.eyebrow": "セキュリティ",
      "trust.h2": "あなたの AWS は、ずっとあなたのもの。",
      "trust.bullets": [
        [
          "クロスアカウント AssumeRole + ExternalId。",
          "登録した Role と ExternalId を検証し、競技者アカウントへの操作を行います。",
        ],
        [
          "所有を確認して撤収。",
          "撤収結果を確認してください。大会データ、保持ストレージ、競技者側 bootstrap などは残るため、AWS の請求確認も必要です。",
        ],
        [
          "コードは全部、GitHub にある。",
          "Lambda、Step Functions、IaC。何が動くかを確認できます。Apache License 2.0。",
        ],
        [
          "利用量と保持資源を確認。",
          "常駐サーバーを必要としない構成ですが、API・DB の利用や保持ストレージの料金がゼロになる保証はありません。",
        ],
      ],

      stats: [
        {
          n: "0",
          u: "円",
          l: "OSS ライセンス料。クラウド利用料は別です。",
        },
        {
          n: "100",
          u: "%",
          l: "OSS / Apache 2.0。すべて読める。",
        },
        {
          n: "2",
          u: "files",
          l: "AWS 問題の基本定義: metadata.json + template.yaml。",
        },
        {
          n: "2",
          u: "ways",
          l: "ローカル開催 / クラウド開催。",
        },
      ],

      "extend.eyebrow": "問題は、増やせる",
      "extend.h2": "足りない問題は、自分で作ればいい。",
      "extend.lead":
        '問題は <a href="https://github.com/susumutomita/TenkaCloudChallenge" target="_blank" rel="noopener noreferrer">TenkaCloudChallenge</a> などの URL と ref を選んで取得し、大会は不変 snapshot を使います。独自問題の定義・実行環境・採点方法は作問ガイドで検証してください。Problem Pack の対応範囲も同ガイドで確認できます。',
      "extend.cta1": "問題カタログを見る",
      "extend.cta2": "new-problem skill",
      "extend.cta3": "問題作成ガイド",
      "extend.cta3Href": "./docs/manual/problem-author/",
      "extend.agent_title": "AI エージェントで始める",
      "extend.agent_lead":
        'Claude Code や Codex に下のプロンプトを貼り付けると、エージェントが TenkaCloud の説明から「遊ぶ / 立てる」の案内までやってくれます。中身は LLM 向けブリーフィング <a href="/llms-full.txt" target="_blank" rel="noopener noreferrer">llms-full.txt</a> です。',
      "extend.agent_copy": "プロンプトをコピー",
      "extend.agent_video": "▶ YouTube で見る",
      "extend.agent_video_href": "https://www.youtube.com/watch?v=nLsSJ3npdfw",
      "extend.agent_video_embed_src": "https://www.youtube.com/embed/nLsSJ3npdfw",
      "extend.agent_video_title": "ローカル起動の紹介動画（現行手順は体験版・ガイド参照）",
      "extend.agent_tutorial": "ブラウザ体験版で進める →",

      "book.eyebrow": "本で読む",
      "book.h2": "作り方を、一冊にまとめてあります。",
      "book.lead":
        "ローカル Challenge、AWS Challenge、AWS Battle を簡単な順に一から作り、 複数チームで遊べる競技として動かすまでを扱う本です。 TenkaCloud を題材にしていますが、 読むのに AWS アカウントも TenkaCloud の導入も要りません。 日本語版と英語版があります。",
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
        "プラットフォーム本体の <strong>OSS ライセンス料は無料</strong>です。AWS の利用と保持ストレージには別途料金が発生する場合があります。構築や当日運営を任せたい方向けのサービス料金は以下のとおりです。",
      "pricing.starter.tier": "Starter",
      "pricing.starter.price": "50万円",
      "pricing.starter.unit": "/ 回",
      "pricing.starter.scope": "お試し (= 1 回 / 2 チームまで)",
      "pricing.starter.note": "初回 / 小規模で運営代行の体験を試したい方向け。",
      "pricing.starter.f1": "1 イベントあたり 2 チームまで",
      "pricing.starter.f2": "deploy / 当日進行サポート",
      "pricing.starter.f3": "公開問題セットから選定",
      "pricing.starter.fineprint": "※ AWS account はお客様側でご用意ください。",
      "pricing.starter.cta": "GitHub で公開相談",
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
      "pricing.hosted.cta": "GitHub で公開相談",
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
      "pricing.enterprise.cta": "GitHub で公開相談",
      "pricing.tail":
        '<strong>カスタム問題の追加開発</strong>は要件定義から実装まで通常の受託開発と同じスコープになるため、 別途お見積もりします。 それ以上の規模 / 特別要件も含めて、 <a href="#contact">お問い合わせ</a> ください。',

      "ent.eyebrow": "研修を企画する方へ",
      "ent.h2": "どんな判断を、練習したいですか。",
      "ent.p": "対象者と研修の場面を伺い、使えるゲームやチーム演習、開催方法を一緒に考えます。",
      "ent.enterprise":
        "新任開発者の研修、定期学習の実践補完、チームの勉強会など。まずは今あるデモを試して、扱いたい題材をお聞かせください。",
      "ent.cta1": "お問い合わせ",
      "ent.cta2": "GitHub を見る",
      "contact.discussions": "GitHub Discussions (公開)",

      "footer.tag": "AWS を題材にしたクラウド実戦演習を開催するための OSS ツール。 Apache 2.0。",
      "footer.disclaimer":
        "TenkaCloud は独立した OSS プロジェクトであり、 Amazon Web Services, Inc. またはその関連会社による提供・後援・承認を受けたものではありません。 AWS および関連する名称は Amazon.com, Inc. またはその関連会社の商標です。",
      "footer.p0": "概要",
      "footer.p1": "問題カタログ",
      "footer.presentations": "発表資料・構成図",
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
      "nav.presentations": "Presentations",
      "nav.offerings": "Commercial",
      "nav.pricing": "Pricing",
      "nav.contact": "Contact",
      "nav.github": "GitHub",

      "hero.h1a": "Security training.",
      "game.cta": "Play Cloud Master",
      "game.p":
        "In API Watch, spot unusual operations from their arguments and context. Let normal actions pass and flag risky ones. Learn with three lives and explanations of missed threats.",
      "game.h2": "Become a Cloud Master.",
      "game.eyebrow": "Available to play today",
      "future.plan":
        "We are exploring suspicious-email exercises for a broader employee audience. The cloud decision game and team exercises are available today.",
      "future.p":
        "An urgent request. An authoritative sender. A familiar screen. Practice pausing, checking and choosing a safe response, without blaming the person.",
      "future.h2": "Security goes beyond settings.",
      "future.eyebrow": "A direction for future learning",
      "hero.caption": "Cloud Master · Actual gameplay",
      "hero.gameAlt":
        "Actual Cloud Master gameplay. Read the operation context and flag risky actions.",
      "hero.gameSrc": "./assets/cloud-master-en.png",
      "hero.gameHref": "./cloud-master/?lang=en",
      "hero.walkthrough": "Try the team exercise walkthrough",
      "hero.consult": "Discuss training for your team",
      "hero.h1b": "Learn by making the call.",
      "hero.sub":
        "For people who build with AI and people who use software. Spot risks, make a decision and understand why. Bring repeated practice into your training.",
      "hero.vibe":
        "<strong>Start on one PC.</strong> Local hosting uses SQLite and needs no AWS account. Docker exercises require Docker Engine and Compose.",
      "hero.quest_meta": "Play now · No signup",
      "hero.quest_badge": "Browser walkthrough",
      "hero.quest_diff": "No installation",
      "hero.quest_title": "Try Cloud Master",
      "hero.quest_desc":
        "Flag risky cloud operations in a short survival game. Review what you missed and why.",
      "hero.quest_cta": "Play the game",
      "hero.startHref": "/docs/getting-started/index.en.html#local-start",
      "hero.cta_demo": "Start on your computer",
      "hero.cta_video": "▶ Watch the 30-second tour",
      "hero.host_prefix": "Hosting an event?",
      "hero.cta_host": "Hosting guide",
      "hero.hostHref": "./docs/manual/organizer/index.en.html",
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

      "modes.eyebrow": "Two competition formats",
      "modes.h2": "Live battles. Solo challenges. Or both.",
      "modes.lead":
        "Battles share a live match; Challenges score problem-solving. The screens below are illustrative samples. Check the organizer guide for currently supported problems.",
      "modes.battle.kicker": "Battle",
      "modes.battle.p":
        "Cryptography Battle keeps shared match state and scores player actions. Check the organizer guide for AWS problem scoring and access conditions.",
      "modes.battle.live": "ROUND 03 · LIVE",
      "modes.challenge.kicker": "Challenge",
      "modes.challenge.p":
        "Solve a problem and submit its specified answer or checkpoints. Local Compose exercises can also be used in team competitions.",
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
        "The AWS Console screen below is an illustrative sample. Available Console / CLI access in the current version depends on each problem’s access definition and hosting conditions.",
      "preview.sso.howto": "How to use",
      "preview.sso.body":
        "Credential expiry is shown in the participant portal. Check the organizer guide for AWS setup and per-problem access conditions. Live AWS event performance remains unverified.",
      "preview.sso.button": "Example: AWS Console",

      "aud.eyebrow": "For your organization",
      "aud.h2": "Add decision practice to training.",
      "aud.lead":
        "For learning, security and engineering teams. Complement slides and videos with practice and reflection, with the aim of making knowledge stick.",
      "aud.a.role": "Developer onboarding",
      "aud.a.h": "Notice the risk.",
      "aud.a.p":
        "Read the context of cloud operations in Cloud Master and spot risky actions. Review the reason behind a mistake before trying again.",
      "aud.a.more": "Try the game",
      "aud.b.role": "Team workshops and exercises",
      "aud.b.h": "Discuss the evidence.",
      "aud.b.p":
        "Solve problems as a team and share scores. Use your workshop to discuss why you chose an action and which log entries informed your decision.",
      "aud.b.more": "How to host an exercise",
      "aud.b.moreHref": "./docs/manual/organizer/index.en.html",
      "aud.c.role": "Practice alongside regular training",
      "aud.c.h": "Use your own topics.",
      "aud.c.p":
        "Turn what your team has studied into exercise problems. Use existing problems or author ones that fit your training.",
      "aud.c.more": "How to author problems",
      "aud.c.moreHref": "./docs/manual/problem-author/index.en.html",

      "onboard.eyebrow": "Onboarding",
      "onboard.h2": "Try a local competition, step by step.",
      "onboard.lead":
        "First check startup and scoring on one PC. For AWS hosting, review supported capabilities, costs and permissions in the organizer guide before configuring it separately.",
      "onboard.s1.h": "Clone and start the host.",
      "onboard.s1.p":
        "Follow the startup guide: clone, make install, then make local. Problems are acquired from selected URL/ref or local path sources. Keep the build enabled on the first start.",
      "onboard.s2.h": "Create an event and a team.",
      "onboard.s2.p":
        "Open 127.0.0.1:5174 on the host and sign in with the displayed organizer key. Create the event and team, select supported problems and start. Keep the organizer key private.",
      "onboard.s3.h": "Join and check the score.",
      "onboard.s3.p":
        "Join 127.0.0.1:5175 on the same PC with the team key. Try a native problem such as Crypto Battle and check actions and scores. See the startup guide for remote Tailscale access and Docker requirements.",
      "onboard.s3.line2": "Problem assigned",

      "trust.eyebrow": "Security",
      "trust.h2": "Your AWS account, still yours.",
      "trust.bullets": [
        [
          "Cross-account AssumeRole + ExternalId.",
          "Operations use a registered role and verified ExternalId in the competitor account.",
        ],
        [
          "Verify ownership and cleanup.",
          "Check teardown results. Event data, retained storage and competitor bootstrap resources remain; review AWS billing as well.",
        ],
        [
          "The code is on GitHub.",
          "Inspect the Lambda functions, Step Functions and infrastructure code. Apache License 2.0.",
        ],
        [
          "Review usage and retained resources.",
          "The platform needs no always-running server, but API/database usage and retained storage are not guaranteed to cost zero.",
        ],
      ],

      stats: [
        {
          n: "0",
          u: "$",
          l: "OSS license fee. Cloud usage is billed separately.",
        },
        {
          n: "100",
          u: "%",
          l: "Open source. Apache 2.0. End to end.",
        },
        {
          n: "2",
          u: "files",
          l: "Basic AWS problem definition: metadata.json + template.yaml.",
        },
        {
          n: "2",
          u: "ways",
          l: "Local hosting / cloud hosting.",
        },
      ],

      "extend.eyebrow": "Catalog grows with you",
      "extend.h2": "Missing a problem? Author your own.",
      "extend.lead":
        'Select a repository URL and ref, such as <a href="https://github.com/susumutomita/TenkaCloudChallenge" target="_blank" rel="noopener noreferrer">TenkaCloudChallenge</a>, to download problems; events retain immutable snapshots. Use the authoring guide to verify custom definitions, runtimes and scoring, and check its Problem Pack support boundaries.',
      "extend.cta1": "Browse the catalog",
      "extend.cta2": "new-problem skill",
      "extend.cta3": "Problem author guide",
      "extend.cta3Href": "./docs/manual/problem-author/index.en.html",
      "extend.agent_title": "Start with an AI agent",
      "extend.agent_lead":
        'Paste the prompt below into Claude Code or Codex and the agent will explain TenkaCloud and guide you through playing or hosting. It reads the LLM briefing <a href="/llms-full.txt" target="_blank" rel="noopener noreferrer">llms-full.txt</a>.',
      "extend.agent_copy": "Copy prompt",
      "extend.agent_video": "▶ Watch on YouTube",
      "extend.agent_video_href": "https://www.youtube.com/watch?v=GDu9FhWrQns",
      "extend.agent_video_embed_src": "https://www.youtube.com/embed/GDu9FhWrQns",
      "extend.agent_video_title":
        "Local startup introduction; use the walkthrough and guide for current steps",
      "extend.agent_tutorial": "Continue in the browser walkthrough →",

      "book.eyebrow": "Read the book",
      "book.h2": "The whole method, in one book.",
      "book.lead":
        "Build a local Challenge, an AWS Challenge, and an AWS Battle in increasing order of difficulty, then run them as a competition several teams can play. It is written around TenkaCloud, but reading it needs neither an AWS account nor a TenkaCloud install. Available in English and Japanese.",
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
        "The platform’s <strong>OSS license is free</strong>. AWS usage and retained storage can incur separate charges. Service fees for setup and event operations are listed below.",
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
      "pricing.starter.cta": "Discuss publicly on GitHub",
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
      "pricing.hosted.cta": "Discuss publicly on GitHub",
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
      "pricing.enterprise.cta": "Discuss publicly on GitHub",
      "pricing.tail":
        '<strong>Custom problem authoring</strong> follows the same scope as regular software development (requirements → implementation), so we quote it separately. <a href="#contact">Get in touch</a> for that and for anything beyond these tiers.',

      "ent.eyebrow": "Planning training?",
      "ent.h2": "What decisions should your team practice?",
      "ent.p":
        "Tell us who is learning and where the training fits. We can explore the available game, team exercises and hosting options together.",
      "ent.enterprise":
        "Developer onboarding, practice alongside regular learning, or a team workshop: try the current demos and tell us which topics matter to your team.",
      "ent.cta1": "Get in touch",
      "ent.cta2": "View on GitHub",
      "contact.discussions": "GitHub Discussions (public)",

      "footer.tag":
        "An open-source tool for hosting hands-on cloud drills on real AWS. Apache 2.0.",
      "footer.disclaimer":
        "TenkaCloud is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates.",
      "footer.p0": "Overview",
      "footer.p1": "Problems",
      "footer.presentations": "Presentations and diagrams",
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
    document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      var key = el.getAttribute("data-i18n-alt");
      if (dict[key] == null) return;
      el.setAttribute("alt", dict[key]);
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

  var initialLang = detectInitialLang();
  applyLang(initialLang);
  reflectLangInUrl(initialLang);
})();
