(() => {
  var SEO_METADATA = {
    ja: {
      title: "TenkaCloud | AWSクラウド実戦演習・競技プラットフォーム",
      description:
        "TenkaCloudはローカルとAWSクラウドで開催するOSSの競技基盤です。チーム、問題、得点を共通の画面で管理します。対応する実行環境と検証状況は運営ガイドで確認できます。",
      socialDescription:
        "ローカルとAWSクラウドで開催するApache 2.0のOSS競技基盤。対応する問題、実行環境、費用と検証状況は運営ガイドで確認できます。",
      canonical: "https://tenkacloud.com/?lang=ja",
      locale: "ja_JP",
      alternateLocale: "en_US",
      imageAlt: "TenkaCloud — AWSクラウド実戦演習・競技プラットフォーム",
      softwareDescription:
        "ローカルとAWSクラウドで問題と得点を共有する、Apache 2.0の競技プラットフォーム。",
    },
    en: {
      title: "TenkaCloud | Open-source AWS cloud competition platform",
      description:
        "TenkaCloud is an open-source platform for local and AWS cloud competitions. Manage teams, problems and scores in shared consoles; check the guide for supported runtimes and verification status.",
      socialDescription:
        "Host local and AWS cloud competitions with shared consoles for teams, problems and scores. Check current runtime support, costs and verification status.",
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
      "nav.games": "ゲームで学ぶ",
      "nav.useCases": "活用例",
      "nav.problems": "問題",
      "nav.extend": "問題を作る",
      "nav.docs": "ドキュメント",
      "nav.presentations": "発表資料",
      "nav.offerings": "商用プラン",
      "nav.pricing": "料金",
      "nav.contact": "お問い合わせ",
      "nav.github": "GitHub",

      "motion.pause": "動きを止める",
      "motion.play": "動きを再生",
      "platform.demoBody":
        "サンプル問題で、接続先の確認から回答の提出まで試せます。実AWSへの接続は不要です。",
      "platform.gameBody": "セキュリティの基礎を、ブラウザーで。",
      "platform.localShort": "問題を選んで、チームを招待。",
      "platform.entryNotes": "利用条件とデモの範囲",
      "platform.youtube": "YouTube で見る ↗",
      "platform.filmEyebrow": "1分で見る",
      "platform.filmTitle":
        '<span class="copy-phrase">1分でわかる</span><span class="copy-phrase">TenkaCloud</span>',
      "platform.filmNote": "ローカル環境で収録した操作画面です。動画は音楽と効果音付きです。",
      "platform.learnerLabel": "参加する人",
      "platform.learnerTitle":
        '<span class="copy-phrase">環境を操作して、</span><span class="copy-phrase">構築・運用を練習。</span>',
      "platform.learnerBody": "構築や設定変更を試し、回答と採点結果を見比べて学べます。",
      "platform.learnerLink": "参加方法を見る →",
      "platform.authorLabel": "問題を作り、開催する人",
      "platform.authorTitle":
        '<span class="copy-phrase">オリジナル問題で、</span><span class="copy-phrase">チームを育成。</span>',
      "platform.authorBody": "自社のサービスや社内ルールを、問題文・ヒント・正解に反映。",
      "platform.authorStep1": "題材を決める",
      "platform.authorStep2": "問題を書く",
      "platform.authorStep3": "チームで試す",
      "platform.authorLink": "独自の問題を作る →",
      "platform.pricingHref": "./pricing.html",
      "pricingPage.back": "LP に戻る",
      "pricingPage.backHref": "./?lang=ja",
      "pricingPage.title": "料金と提供範囲",
      "flow.lead":
        "主催者が問題とチームを用意し、参加者は環境を操作して回答。採点結果を確認しながら演習を進められます。",
      "entry.gameTitle":
        '<span class="copy-phrase">セキュリティの基礎を、</span><span class="copy-phrase">ゲームで学ぶ。</span>',
      "platform.filmLead":
        '<span class="copy-phrase">参加者・主催者の画面と、</span><span class="copy-phrase">Simulatorの使い方を紹介します。</span>',
      "pricingPage.lead": "OSS本体は無料。演習の構築や当日運営を任せたい方へ。",
      "pricingPage.compare": "プランを比較する ↓",
      "pricingPage.scope": "支援内容を確認する ↓",
      "platform.customTitle": "オリジナル問題を<br>作れます。",
      "platform.customBody":
        "問題文・ヒント・正解を用意し、チームで挑戦。回答・採点・ランキングを使って、競技形式で実践的に学べます。",
      "platform.customOps": "対応する問題環境のデプロイと撤収も、主催者画面から実行できます。",
      "platform.customExample": "オリジナル問題の活用例",
      "platform.customTopic": "自社のサービスを題材に",
      "platform.customSituationLabel": "インシデント訓練",
      "platform.customSituation": "自社サービスの構成に合わせて、調査や対応を練習。",
      "platform.customGoalLabel": "新メンバーのオンボーディング",
      "platform.customGoal": "サービスの構成や運用手順を、実際に操作して覚える。",
      "platform.customFirstLabel": "企業ポリシーに沿った演習",
      "platform.customFirst": "社内ルールに沿った設定や判断を、問題を解きながら確認。",
      "platform.customGuide": "問題の作り方を見る →",
      "platform.eyebrow": "TenkaCloud / OSS の演習・競技プラットフォーム",
      "platform.h1a":
        '<span class="motion-line">クラウドと</span><span class="motion-line">セキュリティを、</span>',
      "platform.h1b": "実践で学ぶ。",
      "platform.definition":
        "自分たちの問題で、環境を動かして学ぶ OSS 基盤。演習の開催から回答・採点まで、ひとつにつながります。",
      "platform.primary": "1分の紹介動画を見る ↓",
      "platform.primaryNote": "参加・開催・Simulatorを、実際の画面で紹介",
      "platform.choose": "ゲームで基礎を学ぶ・演習を始める ↓",
      "platform.sceneQuests": "問題に挑む",
      "platform.sceneScores": "演習を開く",
      "platform.preview": "ローカル環境で収録した操作画面",
      "platform.questionEyebrow": "たとえば、情報漏えい。",
      "platform.questionLead":
        "情報漏えいも、クラウドの構築・運用も。さまざまな課題を、手を動かして学べます。",
      "platform.whyEyebrow": "なぜ、実践なのか",
      "platform.whyTitle":
        '<span class="copy-phrase">クラウドの設定変更を、</span><span class="copy-phrase">本番の前に練習する。</span>',
      "platform.whyLead":
        "セキュリティは必要。でも何から始めればいい？ 経験者は少なく、頼るには費用もかかる。教科書で学んだことを、安全な演習の中で試し、結果から学び直せる場所が必要です。",
      "platform.chooseStep": "問題に挑む",
      "platform.chooseStepBody":
        "主催者が、受講者と目的に合う問題を選びます。基礎ゲーム、Challenge、Battle で学び方を変えられます。",
      "platform.practiceStep": "手を動かす",
      "platform.practiceStepBody":
        "答えを考えるだけでなく、対応するシミュレーターや実環境を操作。問題ごとの接続条件と費用はガイドで確認できます。",
      "platform.feedbackStep": "結果を確かめる",
      "platform.feedbackStepBody":
        "回答やチェックポイントを提出し、採点・ヒント・得点の変化を振り返ります。もう一度試すことで、理解を確かめます。",
      "flow.title":
        '<span class="copy-phrase">演習を開催し、</span><span class="copy-phrase">回答・得点を管理。</span>',
      "flow.legend": "演習の流れを見る",
      "flow.prepare": "01 問題を用意",
      "flow.practice": "02 環境で挑戦",
      "flow.score": "03 回答・採点",
      "flow.prepareTitle": "オリジナル問題で、<br>演習を開く。",
      "flow.prepareBody":
        "既存の問題を選ぶ。チームの課題に合わせて作る。問題とチームを選び、演習を開きます。",
      "flow.prepareMeta": "主催者 / 演習を作成",
      "flow.practiceTitle": "クラウドの操作を、<br>自分のPCで。",
      "flow.practiceBody":
        "TenkaCloud Simulatorなら、対応するAPIやコンソールを実AWSへ接続せずに操作できます。作る、試す、結果を確かめる。失敗しても、もう一度。",
      "flow.practiceMeta": "Simulator単体 / ローカル環境",
      "flow.practiceLink": "Simulatorを見る →",
      "flow.scoreTitle": "答えて、確かめる。<br>次の挑戦へ。",
      "flow.scoreBody":
        "回答を提出すると採点結果が返り、得点に反映。主催者も結果を確認し、研修や競技を進められます。",
      "flow.scoreMeta": "参加者・主催者 / 回答と結果",
      "flow.scope":
        "画面はローカル収録の操作例です。Simulatorの映像は単体環境での操作で、参加者の操作権限は問題により異なります。対応APIは一部に限られ、環境・採点方式・費用も問題ごとに異なります。",
      "flow.scopeLink": "Simulatorの対応範囲と起動方法",
      "flow.conditions": "対応範囲・利用条件",
      "entry.legend": "試したいことを選ぶ",
      "entry.demo": "回答と採点",
      "entry.game": "基礎を学ぶ",
      "entry.host": "演習を開く",
      "platform.tryEyebrow": "最初の一歩",
      "platform.tryTitle":
        '<span class="copy-phrase">ゲームで基礎を学ぶ。</span><span class="copy-phrase">チームで演習する。</span>',
      "platform.demoStatus": "登録不要 / 参加画面のサンプル",
      "platform.demoTitle":
        '<span class="copy-phrase"><span class="copy-word">回答・</span><span class="copy-word">ヒント・</span><span class="copy-word">採点を、</span></span><span class="copy-phrase"><span class="copy-word">6ステップで</span><span class="copy-word">体験。</span></span>',
      "platform.demoLink": "サンプル問題に進む →",
      "platform.gameStatus": "ブラウザー / AWS・登録不要",
      "platform.localStatus": "自分のPC / AWS不要",
      "platform.localTitle":
        '<span class="copy-phrase">チームの演習を、</span><span class="copy-phrase">自分のPCで開く。</span>',
      "platform.localBody":
        "ローカル開催は AWS アカウント不要。Docker 問題の条件やクラウド開催は起動ガイドで確認できます。",
      "platform.feeNote":
        "OSS 本体のライセンス料は無料です。AWS などの環境利用料は別で、運営代行は任意の有料サービスです。",
      "platform.exampleEyebrow": "情報漏えいの一例",
      "platform.exampleTitle":
        '<span class="copy-phrase">他人のデータが見える。</span><span class="copy-phrase">認可バグを試す。</span>',
      "platform.exampleLead":
        "ユーザーIDを変えて別人の架空データを表示し、所有者チェックで遮断する仕組みを試します。",
      "platform.caseSummary": "情報漏えいの仕組みを画面で見る",
      "platform.backToTry": "デモ・ゲーム・開催方法を見る ↑",
      "platform.hostEyebrow": "参加者と主催者",
      "platform.hostTitle":
        '<span class="copy-phrase">構築・運用を学ぶ。</span><span class="copy-phrase">自社で演習を開く。</span>',
      "platform.hostLead":
        "参加者は問題に集中。主催者は、イベント・チーム・問題・得点・進捗をひとつの基盤で管理します。公開問題を選ぶことも、独自教材を組み込むこともできます。ローカルと AWS の対応範囲・検証状況は、問題ごとのガイドで確認できます。",
      "platform.featuresSummary": "運営機能・競技形式・活用例を詳しく見る",
      "platform.resourcesSummary": "教材を作る・AI で始める・本で読む",
      "platform.supportEyebrow": "始め方と費用",
      "platform.supportTitle": "費用とサポート。",
      "platform.supportLead": "OSS 本体は無料。利用するクラウドの料金と、運営代行の料金は別です。",
      "platform.pricingLink": "料金と提供範囲を見る ↗",
      "platform.commercialSummary": "運営代行の提供範囲・料金・問い合わせ",
      "platform.finalTitle":
        '<span class="copy-phrase">本番で試せないことを、</span><span class="copy-phrase">演習で学ぼう。</span>',
      "platform.finalBody":
        "Simulatorや実環境で、クラウドの構築・設定・トラブル対応を練習。自社のサービスに合わせた演習も作れます。",
      "platform.finalLink": "ゲームで基礎から始める →",
      "hero.h1a": "ニュースで聞く情報漏えい、",
      "hero.h1b": "どうやって起こるの？",
      "hero.tagline": "3分で体験する、セキュリティインシデント。",
      "incident.skip": "本文へ移動",
      "incident.enter": "漏えいの仕組みを見てみる ↓",
      "incident.title": "たった1つの ID が、境界を越える。",
      "incident.notice": "説明用のローカル演出 · 全データ架空 · 採点付き演習ではありません",
      "incident.boundary": "サーバー側の境界",
      "incident.signed": "ログイン中: ユーザー 1042",
      "incident.fiction": "架空の顧客データ",
      "incident.ownResult": "自分の情報が見える。これは正常。",
      "incident.leakResult": "他人の情報まで見えた。認可の欠落。",
      "incident.fixedResult": "他人の情報は返さない。境界ができた。",
      "incident.own": "自分",
      "incident.other": "他人",
      "incident.fix": "所有者チェックを入れる →",
      "incident.reset": "最初から",
      "incident.step1Title": "ログインできた。<br>それだけで安全？",
      "incident.step1":
        "自分のページを開くと、サーバーは ID 1042 の情報を返します。ログインの確認は「誰なのか」。でも「誰の情報を読んでよいか」は、別の確認です。",
      "incident.next": "ID を1つ変えてみる ↓",
      "incident.step2Title": "ID を変えただけで、<br>他人の情報が見えた。",
      "incident.step2":
        "1042 → 1043。所有者を確認しないサーバーは、別人の架空の個人情報まで返してしまいます。URL を隠すだけでは、この漏えいは止まりません。",
      "incident.impact": "漏えいしているのは、別の人の個人情報です。",
      "incident.step3Title": "止めるのは漏えい。<br>サービスは止めない。",
      "incident.step3":
        "サーバー側で、ログインしたユーザーとデータの所有者を照合。自分の情報は 200、他人の情報は 403。全員を遮断するだけでは正解ではありません。左右の ID を切り替えて、両方を確かめてください。",
      "incident.outroTitle": "「知っている」を、<br>「止められる」へ。",
      "incident.outro":
        "セキュリティは必要。でも、何から始めればいい？ 経験者は少なく、頼むには費用もかかる。教科書だけでは埋まらない実践との距離を、安全で低コストなシミュレーターや実環境での体験で縮めます。",
      "incident.development":
        "この画面は仕組みを説明するためのデモです。架空のデータを使い、採点は行いません。",
      "incident.demo": "現在公開中の操作デモを見る ↗",
      "incident.demoNote": "問題を開き、回答する流れを試せます。上の説明画面とは別のデモです。",
      "hero.preview": "開発中の体験 · 3分は目標時間",
      "hero.sub": "漏えいの仕組みを知り、手を動かして止めてみよう。",
      "hero.vibe":
        "<strong>最初の1問を準備中です。</strong> 他人の架空の顧客情報が見えてしまう。設定を直し、他人は読めず本人は使えることを確かめる演習です。所要時間は未検証で、まだプレーできません。",
      "hero.quest_meta": "現在公開中 · ブラウザ操作デモ · 登録不要",
      "hero.quest_badge": "ブラウザ体験版",
      "hero.quest_diff": "インストール不要",
      "hero.quest_title": "演習の流れを、試してみる。",
      "hero.quest_desc":
        "問題を開いて接続先を確認し、回答を提出する操作デモです。実環境への攻撃・修復を行うものではありません。",
      "hero.quest_cta": "現在の操作デモを見る",
      "hero.startHref": "/docs/getting-started/#local-start",
      "hero.cta_demo": "起動ガイドへ →",
      "hero.cta_video": "▶ 1分で見る",
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
      "aud.eyebrow": "誰のための",
      "aud.h2": "クラウド実戦力を、組織で育てる。",
      "aud.lead":
        "クラウド人材育成 (= CCoE) / Platform / SRE / Security 部門が、 イベント基盤を自前で作らずに ハンズオン AWS 演習 を開催 / 運営できます。 環境払い出し / ログイン / 採点 / 進捗管理 まで、 ひとつの画面で完結。",
      "aud.a.role": "CCoE / クラウド人材育成",
      "aud.a.h": "研修イベントを、 年に複数回。",
      "aud.a.p":
        "新卒オンボーディング / 内製化推進 / 部門横断の AWS 演習を、 同じプラットフォームで 年に複数回 開催できる。 単発ハンズオンから 計画的な 年間プログラム へ。",
      "aud.a.more": "お問い合わせフォーム（要Googleログイン）",
      "aud.b.role": "Platform / SRE",
      "aud.b.h": "演習設計を、 1 画面で。",
      "aud.b.p":
        "イベント、チーム、問題、得点を共通の画面で管理します。ローカルと AWS 開催では実行環境が異なります。問題ごとの接続条件と検証状況は運営ガイドで確認できます。",
      "aud.b.more": "運営ガイド",
      "aud.b.moreHref": "./docs/manual/organizer/",
      "aud.c.role": "エンジニア / 個人参加",
      "aud.c.h": "実戦で、腕を上げる。",
      "aud.c.p":
        "問題を解いて学ぶ OSS の競技基盤です。勉強会・学校・コミュニティでローカル開催でき、AWS 問題はクラウド開催で扱います。OSS ライセンスは無料ですが、クラウド資源の利用料は別です。",
      "aud.c.more": "問題を作る",
      "aud.c.moreHref": "./docs/manual/problem-author/",

      "uc.eyebrow": "企業での活用",
      "uc.h2": "セキュリティ研修を、ゲームにする。",
      "uc.loop": "遊ぶ → 気づく → また挑む",
      "uc.lead":
        "得点や結果を振り返り、次の演習で試す。ゲームとして何度も挑みたくなる体験で、知識の定着につなげることを目指します。",
      "uc.a.role": "全社員 / 非エンジニア",
      "uc.a.h": "だまされる場面を、体験で学ぶ。",
      "uc.a.p":
        "フィッシングやソーシャルエンジニアリングなど、自社で起きそうな場面を問題にして、チームで解きながら気づきを共有します。参加者はブラウザで参加でき、TenkaCloud のインストールは不要です。",
      "uc.b.role": "新任エンジニア",
      "uc.b.h": "簡単な問題から、実践へ。",
      "uc.b.p":
        "問題文とヒントを読み、答えを提出する短いChallengeから。調査や環境操作を伴う課題まで、主催者が受講者に合わせて問題を選べます。",
      "uc.c.role": "SRE / SOC",
      "uc.c.h": "障害・インシデント対応を、訓練する。",
      "uc.c.p":
        "障害対応や攻防の Battle 問題で、チームで状況を判断して手を動かす訓練ができます。スコアの推移から、どこで詰まったかを振り返れます。",
      "uc.d.role": "社内イベント",
      "uc.d.h": "部門横断の CTF を、社内で。",
      "uc.d.p":
        "大会・チーム・問題・得点を主催者画面で管理し、参加者にはチームごとのキーや招待リンクを渡します。スコアボードで順位を全員で共有します。",
      "uc.d.more": "運営ガイド",
      "uc.d.moreHref": "./docs/manual/organizer/",
      "uc.e.role": "社内ネットワーク",
      "uc.e.h": "PC 1 台から、社内で開催。",
      "uc.e.p":
        "ローカル開催は SQLite で動き、AWS アカウントは不要です。LAN や Tailscale 越しに別の端末から参加できます。接続条件と Docker 問題の利用条件は起動ガイドで確認してください。",
      "uc.e.more": "起動ガイド",
      "uc.e.moreHref": "/docs/getting-started/#local-start",
      "mailGame.roles":
        "競技への参加は主催者の招待から。ローカル／クラウドは主催者が選ぶ開催方式です。",
      "mailGame.join": "競技に参加する →",
      "mailGame.joinHref": "./docs/manual/participant/",
      "mailGame.host": "競技を開催する →",
      "mailGame.hostHref": "./docs/manual/organizer/",
      "mailGame.h": "ゲームで遊ぶ",
      "mailGame.p":
        "まず遊んで、気づいたらもう一度。ブラウザーで試せる基礎ゲームを集めました。AWS・登録不要です。",
      "mailGame.cta": "ゲーム一覧へ →",
      "mailGame.href": "./portal-demo/?demo=1&goto=%2Fproblems%3Flang%3Dja",
      "uc.f.role": "定着の確認",
      "uc.f.h": "繰り返して、定着を確かめる。",
      "uc.f.p":
        "同じ問題や類題を時期を空けて再び出題し、チームの得点や解答状況を前回と比べます。一回の受講で終わらせず、身についたかを確かめられます。",

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
      "extend.idea":
        "<strong>教材のアイデア例：</strong>怪しいメールや急かされた依頼を見て、確認方法や安全な対応を選ぶ。",
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
      "pricing.starter.cta": "お問い合わせフォーム（要Googleログイン）",
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
      "pricing.hosted.cta": "お問い合わせフォーム（要Googleログイン）",
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
      "pricing.enterprise.cta": "お問い合わせフォーム（要Googleログイン）",
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
      "contact.form": "お問い合わせフォーム（要Googleログイン）",

      "footer.tag": "クラウドとセキュリティを実践で学ぶ、OSS の演習・競技基盤。 Apache 2.0。",
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
      "nav.games": "Learn through games",
      "nav.useCases": "Use cases",
      "nav.problems": "Problems",
      "nav.extend": "Author problems",
      "nav.docs": "Docs",
      "nav.presentations": "Presentations",
      "nav.offerings": "Commercial",
      "nav.pricing": "Pricing",
      "nav.contact": "Contact",
      "nav.github": "GitHub",

      "motion.pause": "Pause motion",
      "motion.play": "Play motion",
      "platform.demoBody":
        "Follow a sample problem from opening its endpoint to submitting an answer. No connection to real AWS is needed.",
      "platform.gameBody": "Security basics, in your browser.",
      "platform.localShort": "Choose problems. Invite your team.",
      "platform.entryNotes": "Requirements and walkthrough scope",
      "platform.youtube": "Watch on YouTube ↗",
      "platform.filmEyebrow": "Watch in one minute",
      "platform.filmTitle":
        '<span class="copy-phrase">TenkaCloud</span><span class="copy-phrase">in one minute</span>',
      "platform.filmNote":
        "Recorded in a local environment. The video has Japanese titles, music and sound effects.",
      "platform.learnerLabel": "For participants",
      "platform.learnerTitle":
        '<span class="copy-phrase">Work in an environment.</span><span class="copy-phrase">Practice building and operating it.</span>',
      "platform.learnerBody":
        "Try building and changing configurations, then learn from your answers and grading results.",
      "platform.learnerLink": "How to take part →",
      "platform.authorLabel": "For authors and organizers",
      "platform.authorTitle":
        '<span class="copy-phrase">Train your team.</span><span class="copy-phrase">With problems you create.</span>',
      "platform.authorBody":
        "Build your service architecture and internal rules into the brief, hints and answers.",
      "platform.authorStep1": "Choose a topic",
      "platform.authorStep2": "Write the problem",
      "platform.authorStep3": "Try it with your team",
      "platform.authorLink": "Create your own problems →",
      "platform.pricingHref": "./pricing.en.html",
      "pricingPage.back": "Back to TenkaCloud",
      "pricingPage.backHref": "./index.en.html",
      "pricingPage.title": "Pricing and service scope",
      "flow.lead":
        "Hosts prepare problems and teams. Participants work in an exercise environment and submit answers, then check the grading results.",
      "entry.gameTitle":
        '<span class="copy-phrase">Learn security basics.</span><span class="copy-phrase">Through games.</span>',
      "platform.filmLead":
        "See how participants join, how hosts run exercises, and where Simulator fits.",
      "pricingPage.lead":
        "The open-source platform is free. These services help you set up and run exercises.",
      "pricingPage.compare": "Compare plans ↓",
      "pricingPage.scope": "Explore service scope ↓",
      "platform.customTitle": "Create your own<br>problems.",
      "platform.customBody":
        "Write the brief, hints and answers, then challenge your team. Answers, grading and rankings turn the exercise into a hands-on competition.",
      "platform.customOps":
        "Hosts can also deploy and tear down supported problem environments from the admin console.",
      "platform.customExample": "Ways to use your own problems",
      "platform.customTopic": "Built around your own services",
      "platform.customSituationLabel": "Incident response training",
      "platform.customSituation":
        "Practice investigation and response using your service’s architecture.",
      "platform.customGoalLabel": "Onboarding new members",
      "platform.customGoal":
        "Learn service architecture and operational procedures by trying them.",
      "platform.customFirstLabel": "Exercises based on company policy",
      "platform.customFirst":
        "Check configurations and decisions against internal rules as you solve problems.",
      "platform.customGuide": "See how to write a problem →",
      "platform.eyebrow": "TenkaCloud / Open-source practice and competition platform",
      "platform.h1a": '<span class="motion-line">Cloud and security,</span>',
      "platform.h1b": "learned by doing.",
      "platform.definition":
        "An open-source platform for hands-on cloud and security learning. Bring your own problems, run an exercise, and see participants’ answers and scores.",
      "platform.primary": "Watch the one-minute introduction ↓",
      "platform.primaryNote": "See participation, hosting and Simulator in the actual interface",
      "platform.choose": "Learn the basics or run an exercise ↓",
      "platform.sceneQuests": "Explore problems",
      "platform.sceneScores": "See results",
      "platform.preview": "Actual screens recorded in a local environment",
      "platform.questionEyebrow": "For example: a data leak.",
      "platform.questionLead":
        "From data leaks to cloud infrastructure and operations: learn by working through real tasks.",
      "platform.whyEyebrow": "Why hands-on practice",
      "platform.whyTitle":
        '<span class="copy-phrase">Practice configuration changes</span><span class="copy-phrase">before production.</span>',
      "platform.whyLead":
        "Security matters. But where do you start? Experienced people are scarce and costly. Put textbook knowledge to work in a safe exercise, see what happens, and learn from the result.",
      "platform.chooseStep": "Choose a problem",
      "platform.chooseStepBody":
        "Organizers choose problems for their learners and goals: basic games, Challenges or Battles.",
      "platform.practiceStep": "Try it hands-on",
      "platform.practiceStepBody":
        "Work with a supported simulator or real environment, as appropriate for the problem. Check its guide for access requirements and costs.",
      "platform.feedbackStep": "Check the result",
      "platform.feedbackStepBody":
        "Submit answers or checkpoints, then review scoring, hints and score changes. Try again to check your understanding.",
      "flow.title":
        '<span class="copy-phrase">Run an exercise.</span><span class="copy-phrase">Track answers and scores.</span>',
      "flow.legend": "Explore the exercise workflow",
      "flow.prepare": "01 Prepare",
      "flow.practice": "02 Practice",
      "flow.score": "03 Submit & score",
      "flow.prepareTitle": "Run an exercise<br>with your own problems.",
      "flow.prepareBody":
        "Choose existing problems or create your own around your team’s needs. Select problems and teams, then start an exercise.",
      "flow.prepareMeta": "HOST / CREATE AN EXERCISE",
      "flow.practiceTitle": "Practice cloud operations.<br>On your own computer.",
      "flow.practiceBody":
        "TenkaCloud Simulator lets you practice supported APIs and console workflows without connecting to real AWS. Create, test, inspect the result, and try again.",
      "flow.practiceMeta": "STANDALONE SIMULATOR / LOCAL ENVIRONMENT",
      "flow.practiceLink": "Explore Simulator →",
      "flow.scoreTitle": "Submit. Check the result.<br>Take the next challenge.",
      "flow.scoreBody":
        "Submit an answer and see the grading result and score. Hosts can follow the results as the training or competition progresses.",
      "flow.scoreMeta": "PARTICIPANT & HOST / ANSWERS AND RESULTS",
      "flow.scope":
        "These are locally recorded examples. The Simulator footage shows standalone operation; participant permissions depend on the problem. Only a documented subset of APIs is implemented. Environment requirements, grading and costs vary by problem.",
      "flow.scopeLink": "Simulator scope and setup",
      "flow.conditions": "Scope and requirements",
      "entry.legend": "Choose what to try",
      "entry.demo": "Answers & scores",
      "entry.game": "Learn basics",
      "entry.host": "Host an exercise",
      "platform.tryEyebrow": "Start here",
      "platform.tryTitle":
        '<span class="copy-phrase">Learn through games.</span><span class="copy-phrase">Run exercises with your team.</span>',
      "platform.demoStatus": "NO SIGNUP / SAMPLE PARTICIPANT WORKFLOW",
      "platform.demoTitle":
        '<span class="copy-phrase">Try answers, hints and grading.</span><span class="copy-phrase">In six steps.</span>',
      "platform.demoLink": "Open the sample problem →",
      "platform.gameStatus": "Browser / no AWS or signup",
      "platform.localStatus": "Your PC / no AWS account",
      "platform.localTitle":
        '<span class="copy-phrase">Host a team exercise.</span><span class="copy-phrase">On your own computer.</span>',
      "platform.localBody":
        "Local hosting needs no AWS account. See the startup guide for Docker problem requirements and cloud hosting.",
      "platform.feeNote":
        "The OSS license is free. Environment costs, including AWS, are separate. Operated events are an optional paid service.",
      "platform.exampleEyebrow": "A data-leak example",
      "platform.exampleTitle":
        '<span class="copy-phrase">Someone else’s data appears.</span><span class="copy-phrase">Explore an authorization bug.</span>',
      "platform.exampleLead":
        "Change a user ID to reveal another fictional user’s data, then see how an ownership check blocks the response.",
      "platform.caseSummary": "Explore how a data leak happens",
      "platform.backToTry": "Choose something available now ↑",
      "platform.hostEyebrow": "PARTICIPANTS AND HOSTS",
      "platform.hostTitle":
        '<span class="copy-phrase">Practice cloud operations.</span><span class="copy-phrase">Run your own training.</span>',
      "platform.hostLead":
        "Participants focus on the problems. Organizers manage events, teams, problems, scores and progress in one platform, using public problems or adding their own materials. Check each problem’s guide for local and AWS support and verification status.",
      "platform.featuresSummary": "Explore hosting features, formats and use cases",
      "platform.resourcesSummary": "Create problems, start with AI, or read the book",
      "platform.supportEyebrow": "Getting started and costs",
      "platform.supportTitle": "Costs and support.",
      "platform.supportLead":
        "The OSS platform is free. Cloud usage and optional event operations are separate costs.",
      "platform.pricingLink": "Pricing and scope ↗",
      "platform.commercialSummary": "Operated-event scope, pricing and contact",
      "platform.finalTitle":
        '<span class="copy-phrase">Practice what you can’t</span><span class="copy-phrase">try in production.</span>',
      "platform.finalBody":
        "Practice cloud setup, configuration and troubleshooting with supported Simulator or real-environment problems. Create exercises around your own services, too.",
      "platform.finalLink": "Start with the learning games →",
      "hero.h1a": "Data breaches make the news. ",
      "hero.h1b": "How do they happen?",
      "hero.tagline": "Experience a security incident in three minutes.",
      "incident.skip": "Skip to content",
      "incident.enter": "See how a leak happens ↓",
      "incident.title": "One changed ID. One broken boundary.",
      "incident.notice": "Local illustration · All data is fictional · Not a scored challenge",
      "incident.boundary": "Server-side boundary",
      "incident.signed": "Signed in: user 1042",
      "incident.fiction": "Fictional customer data",
      "incident.ownResult": "Your information is visible. Expected behavior.",
      "incident.leakResult": "Someone else’s information is visible. Authorization is missing.",
      "incident.fixedResult": "No one else’s data is returned. The boundary holds.",
      "incident.own": "You",
      "incident.other": "Someone else",
      "incident.fix": "Add an ownership check →",
      "incident.reset": "Start over",
      "incident.step1Title": "You’re signed in.<br>Are you safe?",
      "incident.step1":
        "Your page requests data for ID 1042. Authentication checks who you are. Authorization checks whose data you may read. Those are different questions.",
      "incident.next": "Change just one ID ↓",
      "incident.step2Title": "Change the ID.<br>See someone else’s data.",
      "incident.step2":
        "1042 → 1043. Without an ownership check, the server returns another person’s fictional information. Hiding the URL will not stop this leak.",
      "incident.impact": "The exposed personal data belongs to someone else.",
      "incident.step3Title": "Stop the leak.<br>Keep the service running.",
      "incident.step3":
        "On the server, compare the signed-in user with the data owner. Your data: 200. Someone else’s: 403. Blocking everyone is not a correct fix. Switch between the two IDs to verify both.",
      "incident.outroTitle": "From knowing about it<br>to stopping it.",
      "incident.outro":
        "Security matters. But where do you start? Experienced people are scarce and expensive. Bridge the gap between textbooks and practice with hands-on experiences in safe, low-cost simulators or real environments.",
      "incident.development":
        "This is an explanatory demo using fictional data. It has no scoring.",
      "incident.demo": "Open the current walkthrough ↗",
      "incident.demoNote":
        "Try opening a problem and submitting an answer. This is separate from the explanation above.",
      "hero.preview": "Experience in development · Three minutes is a target",
      "hero.sub": "Understand how data leaks, then practice stopping it.",
      "hero.vibe":
        "<strong>The first challenge is in development.</strong> Someone else’s fictional customer data is exposed. Fix the settings, then check that others cannot read it while its owner still can. Completion time is unverified; this challenge is not playable yet.",
      "hero.quest_meta": "Available now · Browser walkthrough · No signup",
      "hero.quest_badge": "Browser walkthrough",
      "hero.quest_diff": "No installation",
      "hero.quest_title": "Try the exercise flow.",
      "hero.quest_desc":
        "This walkthrough shows how to open a problem, check its endpoint and submit an answer. It does not perform attacks or repairs in a real environment.",
      "hero.quest_cta": "Open the current walkthrough",
      "hero.startHref": "/docs/getting-started/index.en.html#local-start",
      "hero.cta_demo": "Open the startup guide →",
      "hero.cta_video": "▶ Watch in one minute",
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
      "aud.eyebrow": "Who it's for",
      "aud.h2": "Build cloud capability across the org.",
      "aud.lead":
        "For Cloud Enablement (CCoE), Platform / SRE, and Security teams that need hands-on AWS training — without rebuilding the event platform. Environment provisioning, login, scoring, and progress tracking — all in one screen.",
      "aud.a.role": "Cloud Enablement / CCoE",
      "aud.a.h": "Run training events multiple times a year.",
      "aud.a.p":
        "New-grad onboarding, internalization programs, cross-team AWS drills — run them multiple times a year on the same platform. Move from one-off workshops to a planned annual program.",
      "aud.a.more": "Contact form (Google sign-in required)",
      "aud.b.role": "Platform / SRE",
      "aud.b.h": "Design drills from one screen.",
      "aud.b.p":
        "Manage events, teams, problems and scores in shared consoles. Local and AWS hosting use different runtimes. Check the organizer guide for each problem’s access conditions and verification status.",
      "aud.b.more": "Operator guide",
      "aud.b.moreHref": "./docs/manual/organizer/index.en.html",
      "aud.c.role": "Engineers / individual learners",
      "aud.c.h": "Sharpen on the real thing.",
      "aud.c.p":
        "An open-source platform for learning through competitions. Communities and schools can host locally; AWS exercises use cloud hosting. The OSS license is free; cloud resources are billed separately.",
      "aud.c.more": "Author a problem",
      "aud.c.moreHref": "./docs/manual/problem-author/index.en.html",

      "uc.eyebrow": "Enterprise use cases",
      "uc.h2": "Turn security training into a game.",
      "uc.loop": "Play → Reflect → Try again",
      "uc.lead":
        "Review scores and outcomes, then try what you learned in another exercise. We aim to help knowledge stick through practice that teams want to repeat.",
      "uc.a.role": "All employees / non-engineers",
      "uc.a.h": "Learn to spot deception by doing.",
      "uc.a.p":
        "Turn phishing, social engineering and other situations your company could face into problems, and share what teams notice as they solve them. Participants join from a browser; they do not install TenkaCloud.",
      "uc.b.role": "New engineers",
      "uc.b.h": "Start simple. Put it into practice.",
      "uc.b.p":
        "Start with a short Challenge: read the problem and hints, then submit an answer. Organizers can choose topics for their learners, including investigation and hands-on environment tasks.",
      "uc.c.role": "SRE / SOC",
      "uc.c.h": "Drill incident response.",
      "uc.c.p":
        "Use outage-response and attack/defense Battle problems to practice judging a situation and acting as a team. The score timeline shows where teams got stuck.",
      "uc.d.role": "Internal events",
      "uc.d.h": "A cross-team CTF, in-house.",
      "uc.d.p":
        "Manage events, teams, problems and scores from the organizer console, and give each team its own key or invitation link. The scoreboard shares rankings with everyone.",
      "uc.d.more": "Operator guide",
      "uc.d.moreHref": "./docs/manual/organizer/index.en.html",
      "uc.e.role": "Internal network",
      "uc.e.h": "Host from a single PC.",
      "uc.e.p":
        "Local hosting runs on SQLite and needs no AWS account. Participants can join from other devices over the LAN or Tailscale. Check the startup guide for connection and Docker problem requirements.",
      "uc.e.more": "Startup guide",
      "uc.e.moreHref": "/docs/getting-started/index.en.html#local-start",
      "mailGame.roles":
        "Join a competition through your organizer's invitation. Local and cloud are hosting choices made by the organizer.",
      "mailGame.join": "Join a competition →",
      "mailGame.joinHref": "./docs/manual/participant/index.en.html",
      "mailGame.host": "Host a competition →",
      "mailGame.hostHref": "./docs/manual/organizer/index.en.html",
      "mailGame.h": "Play a game",
      "mailGame.p":
        "Play, notice something, and try again. Explore browser-based foundation games. No AWS account or registration.",
      "mailGame.cta": "Browse games →",
      "mailGame.href": "./portal-demo/?demo=1&goto=%2Fproblems%3Flang%3Den",
      "uc.f.role": "Checking retention",
      "uc.f.h": "Repeat rounds to check retention.",
      "uc.f.p":
        "Run the same or similar problems again after some time, and compare team scores and solve status with the previous round. Training does not end after one session.",

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
      "extend.idea":
        "<strong>Exercise idea:</strong> Review a suspicious email or an urgent request, then choose how to verify it and respond safely.",
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
      "pricing.starter.cta": "Contact form (Google sign-in required)",
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
      "pricing.hosted.cta": "Contact form (Google sign-in required)",
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
      "pricing.enterprise.cta": "Contact form (Google sign-in required)",
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
      "contact.form": "Contact form (Google sign-in required)",

      "footer.tag":
        "An open-source platform for hands-on cloud and security exercises and competitions. Apache 2.0.",
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
