(() => {
  var SEO_METADATA = {
    ja: {
      title: "TenkaCloud | セキュリティ研修・クラウド実践演習プラットフォーム",
      description:
        "TenkaCloudは、問題選択・開催・採点・結果確認を支える実践演習プラットフォーム。社内研修やチーム演習に、クラウドの課題を自分で解く体験を。",
      socialDescription:
        "問題を選び、演習を開き、採点と結果を確かめる。TenkaCloudで実践的な社内研修・チーム演習を。ブラウザ体験版を公開中。",
      canonical: "https://tenkacloud.com/?lang=ja",
      locale: "ja_JP",
      alternateLocale: "en_US",
      imageAlt: "TenkaCloud — AWSクラウド実戦演習・競技プラットフォーム",
      softwareDescription:
        "ローカルとAWSクラウドで問題と得点を共有する、Apache 2.0の競技プラットフォーム。",
    },
    en: {
      title: "TenkaCloud | Hands-on cloud training and competitions",
      description:
        "TenkaCloud is a hands-on cloud exercise platform for problem selection, hosting, scoring and result review. Explore exercises for onboarding and team training.",
      socialDescription:
        "Select problems, host exercises and review scoring and results. Explore TenkaCloud for hands-on workplace training and team exercises.",
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
      "game.cta": "無料で遊ぶ",
      "game.p":
        "危険な操作を見抜くサバイバル「APIの番人。」。研修用の実践演習とは別に、ブラウザで気軽に遊べます。",
      "game.h2": "気分転換に、Cloud Master。",
      "game.eyebrow": "無料ミニゲーム",
      "future.plan":
        "現在のTenkaCloudは、クラウドの実践演習を開催するプラットフォームです。メール判断などのソーシャルエンジニアリング教材は、まだ提供していません。",
      "future.p":
        "急かされた依頼や、怪しいメール。立ち止まり、別の経路で確認し、安全な対応を選ぶ。こうした場面を扱う教材も構想しています。",
      "future.h2": "人の判断も、練習できる題材へ。",
      "future.eyebrow": "今後の教材の構想",
      "hero.caption": "TenkaCloud 参加者画面 · ブラウザ体験版（サンプルデータ）",
      "hero.platformAlt": "TenkaCloud参加者ポータルの問題一覧。ブラウザ体験版のサンプルデータ。",
      "hero.platformSrc": "./assets/tenkacloud-platform-ja.png",
      "hero.gameHref": "./cloud-master/?lang=ja",
      "hero.walkthrough": "チーム演習の体験版",
      "hero.consult": "社内演習の開催を相談する",
      "hero.h1b": "実践できる演習へ。",
      "hero.sub":
        "TenkaCloudは、問題選択から開催・採点・結果確認までを支える実践演習プラットフォーム。参加者は環境を操作し、チームで課題に挑みます。",
      "hero.vibe":
        "<strong>まずは、同じ PC で。</strong> ローカル開催は SQLite を使い、AWS アカウントは不要です。Docker 問題には Docker Engine と Compose が必要です。",
      "hero.quest_meta": "TenkaCloud ブラウザ体験版 · 登録不要",
      "hero.quest_badge": "ブラウザ体験版",
      "hero.quest_diff": "インストール不要",
      "hero.quest_title": "演習の流れを、試してみる。",
      "hero.quest_desc":
        "問題を開き、接続先を確かめ、回答を提出。ヒントと採点まで、参加者の操作をブラウザで体験できます。",
      "hero.quest_cta": "TenkaCloud を体験する",
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
      "aud.h2": "実践と振り返りを、いつもの研修に。",
      "aud.lead":
        "人材育成・セキュリティ・開発部門の方へ。スライドや動画での理解に、環境を操作して課題を解く演習と、チームでの振り返りを重ねます。",
      "aud.a.role": "新任開発者の基礎研修",
      "aud.a.h": "知識を、操作で確かめる。",
      "aud.a.p":
        "問題を読み、用意された環境で調査・操作し、回答やチェックポイントを提出。ヒントを使いながら、自分の手で課題を解きます。",
      "aud.a.more": "参加者の流れを体験",
      "aud.b.role": "チームの実践演習",
      "aud.b.h": "協力も、対戦も。",
      "aud.b.p":
        "課題を解くChallengeと、共有状態で競うBattle。チーム得点や履歴を見ながら、取り組み方や判断の根拠を話し合えます。",
      "aud.b.more": "演習の開催方法",
      "aud.b.moreHref": "./docs/manual/organizer/",
      "aud.c.role": "研修を企画・運営する部門",
      "aud.c.h": "準備から、結果確認まで。",
      "aud.c.p":
        "主催者が問題とチームを選び、演習を開催。採点・得点履歴を確認し、社内の題材に合わせた問題も追加できます。",
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
      "ent.h2": "どんな演習を、開催したいですか。",
      "ent.p": "対象者・題材・開催規模を伺い、使える問題と開催方法、運営支援を一緒に考えます。",
      "ent.enterprise":
        "新任開発者の研修、部門横断の実践演習、定期的な社内勉強会など。まずはTenkaCloudの体験版で参加者の流れを試し、開催したい演習をお聞かせください。",
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
      "game.cta": "Play for free",
      "game.p":
        "Play API Watch, a browser survival game about spotting risky operations, as a light diversion alongside the hands-on exercise platform.",
      "game.h2": "Take a break with Cloud Master.",
      "game.eyebrow": "Free mini-game",
      "future.plan":
        "TenkaCloud currently hosts hands-on cloud exercises. Social engineering exercises, including email judgment, are not yet available.",
      "future.p":
        "An urgent request or a suspicious email. Pause, verify through another channel and choose a safe response. We are exploring exercises around these situations too.",
      "future.h2": "Practice the human side of security.",
      "future.eyebrow": "Future learning topics",
      "hero.caption": "TenkaCloud participant portal · Browser walkthrough with sample data",
      "hero.platformAlt":
        "Problems in the TenkaCloud participant portal. Browser walkthrough with sample data.",
      "hero.platformSrc": "./assets/tenkacloud-platform-en.png",
      "hero.gameHref": "./cloud-master/?lang=en",
      "hero.walkthrough": "Try the team exercise walkthrough",
      "hero.consult": "Discuss hosting an internal exercise",
      "hero.h1b": "Put it into practice.",
      "hero.sub":
        "TenkaCloud is a hands-on exercise platform for selecting problems, hosting events, scoring and reviewing results. Participants work in problem environments and tackle challenges as a team.",
      "hero.vibe":
        "<strong>Start on one PC.</strong> Local hosting uses SQLite and needs no AWS account. Docker exercises require Docker Engine and Compose.",
      "hero.quest_meta": "TenkaCloud browser walkthrough · No signup",
      "hero.quest_badge": "Browser walkthrough",
      "hero.quest_diff": "No installation",
      "hero.quest_title": "Try the exercise flow.",
      "hero.quest_desc":
        "Open a problem, explore its endpoint and submit an answer. Try the participant workflow, including hints and scoring, in your browser.",
      "hero.quest_cta": "Try TenkaCloud",
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
      "aud.h2": "Hands-on learning, from setup to review.",
      "aud.lead":
        "For learning, security and engineering teams. Complement slides and videos with hands-on problem solving and team reflection.",
      "aud.a.role": "Developer onboarding",
      "aud.a.h": "Put knowledge to work.",
      "aud.a.p":
        "Read the problem, investigate and work in its environment, then submit answers or checkpoints. Use hints while working through the challenge yourself.",
      "aud.a.more": "Try the participant workflow",
      "aud.b.role": "Team exercises",
      "aud.b.h": "Collaborate or compete.",
      "aud.b.p":
        "Solve challenges in Challenge, or compete over shared state in Battle. Use team scores and history to discuss your approach and the evidence behind decisions.",
      "aud.b.more": "How to host an exercise",
      "aud.b.moreHref": "./docs/manual/organizer/index.en.html",
      "aud.c.role": "Training organizers",
      "aud.c.h": "From setup to results.",
      "aud.c.p":
        "Select problems and teams, then host an exercise. Review scoring and score history, and author additional problems for your own training topics.",
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
      "ent.h2": "What exercise would you like to host?",
      "ent.p":
        "Tell us your audience, topics and event size. We can explore suitable problems, hosting options and event support together.",
      "ent.enterprise":
        "Developer onboarding, cross-team exercises or recurring internal workshops: try the TenkaCloud walkthrough, then tell us what you would like to run.",
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
