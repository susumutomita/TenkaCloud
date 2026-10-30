// Original learning copy. Official links are separate from the inert fictional email targets.
const source = {
  gmail: "https://support.google.com/mail/answer/8253",
  auth: "https://support.google.com/mail/answer/180707",
  ftc: "https://consumer.ftc.gov/articles/how-recognize-avoid-phishing-scams",
  dmarc: "https://datatracker.ietf.org/doc/html/rfc9989",
  trust: "https://www.rfc-editor.org/rfc/rfc8601",
  idn: "https://www.unicode.org/reports/tr39/",
};
const sourceNames = {
  gmail: "Gmail",
  auth: "Gmail",
  ftc: "FTC",
  dmarc: "RFC 9989",
  trust: "RFC 8601",
  idn: "Unicode UTS #39",
};
export const REVIEW = {
  ja: {
    title: "次にメールを開いたら。",
    intro: "名前より実アドレス。ボタン名より行き先。迷ったら、いつものアプリから確認。",
    labels: ["見る場所", "確かめること", "迷ったら"],
    reference: "公式資料（別タブ）",
    items: [
      {
        id: "sender",
        title: "差出人と返信先",
        brief: "表示名だけで相手を決めない。",
        source: ["gmail"],
        where: "差出人名の横の詳細を開き、From の実アドレスと Reply-To（返信先）を見る。",
        check:
          "既知の窓口とドメインを照合。同じ名前や実アドレスの表示でも偽装・乗っ取りはあり得ます。Reply-To が違う理由も確認します。",
        action:
          "そのメールへ返信せず、保存済みの連絡先から問い合わせる。違いだけで詐欺とは断定しません。",
      },
      {
        id: "destination",
        title: "ボタンの本当の行き先",
        brief: "ドメイン全体を照合する。",
        source: ["gmail"],
        where:
          "このゲームではリンクを押して行き先を表示。実メールでは PC のホバーやアプリのリンク確認機能を使い、移動せず URL を確認します。操作は環境で異なります。",
        check:
          "文字のボタン名ではなくホスト名を見る。account.minamo.example と minamo.example.notice.example は別の行き先です。https や鍵の表示は正規の相手・無害な内容の保証ではありません。",
        action:
          "知っている公式ドメインと照合できなければ開かず、ブックマークや普段のアプリへ。URL の末尾の違いだけでも判断しません。",
      },
      {
        id: "idn",
        title: "よく似た別の文字",
        brief: "見た目が同じでも、同じドメインとは限らない。",
        source: ["idn"],
        where: "リンク先の詳細で Unicode 表示と ASCII/Punycode を見比べる。",
        check:
          "minаmo.example の а はキリル文字 U+0430。既知の minamo.example の a（U+0061）とは別で、ASCII では xn--minmo-6ve.example。国際化ドメイン自体は危険ではありません。",
        action:
          "見分けられなければ既知の入口を使う。Punycode の暗記は不要で、実際のアプリの表示も一律ではありません。",
      },
      {
        id: "request",
        title: "急がせる依頼と添付",
        brief: "何をさせようとしているかを見る。",
        source: ["ftc"],
        where: "本文の要求、支払い先、添付の種類と、本来予定していた案内を比べる。",
        check:
          "送金・認証コードやパスワードの返信・保護設定を外す要求に注意。急ぎの期限や文法の誤りだけでは偽物とは決められず、自然な文章も安全保証になりません。添付の拡張子や形式も確認します。",
        action:
          "予定のないファイルや操作は止めて確認。実行形式が常に悪性とは断定しません。送金先の変更は既知の電話番号など別経路で照合し、認証コードは他人に渡しません。",
      },
      {
        id: "authentication",
        title: "SPF・DKIM・DMARC",
        brief: "認証の pass は、安全の合格印ではない。",
        source: ["auth", "dmarc", "trust"],
        where:
          "詳細や「元のメッセージ」で、信頼する受信側の Authentication-Results と From、Return-Path、署名ドメイン header.d を見る。",
        check:
          "SPF は配送元が envelope-from ドメインで許可されるか、DKIM は署名対象部分を検証。DMARC は pass の SPF または DKIM のドメインと From を、設定に応じて完全一致または同じ組織ドメインで照合します。Reply-To は整合の対象ではありません。",
        action:
          "pass でも善意・内容の無害は証明できません。転送などで SPF が fail になる場合もあり、失敗だけで詐欺とは決めません。メール内に同名ヘッダーがあるだけでは信頼せず、判断を保留して既知の窓口へ。",
      },
      {
        id: "independent",
        title: "分からない時の安全な一手",
        brief: "メールの外から、同じ用件を確かめる。",
        source: ["ftc"],
        where: "以前から使う公式アプリ、保存済みブックマーク、既知の連絡先を自分で開く。",
        check:
          "同じ請求・通知・依頼があるか確認。届いたメールに書かれた連絡先だけで照合を終えない。",
        action:
          "不一致や未確認なら、返信・支払い・添付実行を保留して報告。既に情報を渡した場合は、公式の復旧窓口や勤務先の担当へ早めに相談します。",
      },
    ],
  },
  en: {
    title: "When you open your next email.",
    intro:
      "Check the address, not just the name. Check the destination, not just the button. If unsure, open your usual app.",
    labels: ["Where to look", "What to check", "If unsure"],
    reference: "Official reference (new tab)",
    items: [
      {
        id: "sender",
        title: "Sender and reply address",
        brief: "A familiar name is not identity proof.",
        source: ["gmail"],
        where: "Open sender details: inspect the From address and Reply-To.",
        check:
          "Compare with an established contact. Names and displayed addresses can be spoofed; accounts can be compromised. Check why a reply address differs.",
        action:
          "Use a saved contact instead of replying. A difference alone does not establish fraud.",
      },
      {
        id: "destination",
        title: "The actual link destination",
        brief: "Compare the complete hostname.",
        source: ["gmail"],
        where:
          "Here, tap the label to inspect without navigating. In real mail, use hover or the app's link-inspection feature; controls vary.",
        check:
          "account.minamo.example differs from minamo.example.notice.example. Read the hostname, not the button label. HTTPS or a padlock does not prove a legitimate sender or harmless content.",
        action:
          "If you cannot match an established official domain, use your bookmark or usual app. A different URL path alone is not a risk.",
      },
      {
        id: "idn",
        title: "Look-alike characters",
        brief: "Similar appearance can hide a different domain.",
        source: ["idn"],
        where: "Compare Unicode and ASCII/Punycode in destination details.",
        check:
          "The а in minаmo.example is Cyrillic U+0430, unlike Latin a (U+0061) in minamo.example. Its ASCII form is xn--minmo-6ve.example. Internationalized domains are not inherently dangerous.",
        action:
          "Use an established route when unsure. You need not memorize Punycode; actual app display varies.",
      },
      {
        id: "request",
        title: "Urgency, requests and attachments",
        brief: "Notice what the message wants you to do.",
        source: ["ftc"],
        where:
          "Compare the requested action, payment destination and attachment type with the expected notice.",
        check:
          "Look for money transfers, requests to reply with passwords or codes, or removal of protection. Urgency or poor grammar alone does not prove fraud; fluent text is no safety guarantee.",
        action:
          "Pause unexpected downloads or actions. Executables are not universally malicious. Verify changed payment details through a known independent contact; never give codes to another person.",
      },
      {
        id: "authentication",
        title: "SPF, DKIM and DMARC",
        brief: "Passing authentication is not a safety certificate.",
        source: ["auth", "dmarc", "trust"],
        where:
          "In details or Show original, inspect trusted receiver Authentication-Results, From, Return-Path and signing domain header.d.",
        check:
          "SPF checks permitted sending sources for the envelope-from domain; DKIM verifies the signed message portions. DMARC requires a passing SPF or DKIM domain aligned with From: an exact match in strict mode, or the same organizational domain in relaxed mode. Reply-To is not part of that alignment.",
        action:
          "Pass does not prove good intent or harmless content. Forwarding can cause SPF failure; failure alone does not prove fraud. An identically named header is not inherently trusted. Check through a known contact.",
      },
      {
        id: "independent",
        title: "A safe next step",
        brief: "Check the same request outside the email.",
        source: ["ftc"],
        where: "Open your established app, saved bookmark or known contact yourself.",
        check:
          "Look for the same bill, notification or request. Do not rely only on contact details supplied in the incoming email.",
        action:
          "If unconfirmed, hold the reply, payment or file and report it. If you already shared information, contact the official recovery service or your workplace's security team promptly.",
      },
    ],
  },
};
const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
export function createReview(lang, openItems, level = 5) {
  const t = REVIEW[lang],
    section = node("section", undefined, "mail-review");
  section.id = "mail-review";
  const heading = node("h2", t.title);
  heading.id = "mail-review-title";
  section.setAttribute("aria-labelledby", heading.id);
  section.append(heading, node("p", t.intro, "review-intro"));
  const minimumLevel = {
    sender: 2,
    destination: 3,
    idn: 5,
    request: 1,
    authentication: 4,
    independent: 1,
  };
  for (const item of t.items.filter((entry) => level >= minimumLevel[entry.id])) {
    const details = node("details", undefined, "review-topic");
    details.id = `review-${item.id}`;
    details.open = openItems.has(item.id);
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      if (details.open) openItems.add(item.id);
      else openItems.delete(item.id);
    });
    const summary = node("summary");
    summary.append(node("strong", item.title), node("span", item.brief));
    const body = node("dl");
    for (const [index, key] of ["where", "check", "action"].entries()) {
      body.append(node("dt", t.labels[index]), node("dd", item[key]));
    }
    const sources = node("p", undefined, "review-sources");
    for (const key of item.source) {
      const link = node("a", `${t.reference} · ${sourceNames[key]}`);
      link.href = source[key] + (key === "gmail" || key === "auth" ? `?hl=${lang}` : "");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      sources.append(link);
    }
    details.append(summary, body, sources);
    section.append(details);
  }
  return section;
}
