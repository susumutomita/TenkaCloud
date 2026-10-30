const text = (ja, en) => ({ ja, en });
const labels = {
  from: text("送信元の表示", "Displayed sender"),
  subject: text("件名", "Subject"),
  date: text("日時", "Date"),
  link: text("実際のリンク先（開きません）", "Actual link target (never opened)"),
  request: text("求めている操作", "Requested action"),
  attachment: text("添付", "Attachment"),
  reply: text("返信先", "Reply address"),
};
const row = (id, before, after, kind, reason, detail) => ({
  id,
  label: labels[id],
  before,
  after,
  kind,
  reason,
  detail,
});
const same = (id, value) =>
  row(
    id,
    value,
    value,
    "same",
    text(
      "ここには相違点がありません。ほかの項目と照合しましょう。",
      "This field has no difference. Compare the other fields.",
    ),
    text(
      "同じ表示だからメール全体が安全とは限りません。送信元表示も偽装されることがあります。",
      "Matching text does not prove the whole message safe. Displayed senders can be spoofed too.",
    ),
  );
const senderRisk = text(
  "確認済みの送信元とは別のドメインです。公式の入口で照合を。",
  "The domain differs from the verified sender. Check through your usual official route.",
);
const senderDetail = text(
  "この場面の公式アプリで確認済みの案内とは送信元が異なります。表示だけで悪意を断定せず、本文の連絡先に頼らずに確認しましょう。",
  "The sender differs from the notice verified in this scene's official app. That is a reason to check independently, not proof of malicious intent by itself.",
);
const linkRisk = text(
  "リンク先が確認済みのサービスとは別のドメインです。",
  "The link goes to a different domain from the verified service.",
);
const linkDetail = text(
  "メールのボタン名が同じでも、行き先は違うことがあります。見た目ではなく実際の行き先を照合し、迷ったら普段のアプリを自分で開きます。",
  "An identical button label can hide a different destination. Compare the actual target; if unsure, open your usual app yourself.",
);
const attachmentRisk = text(
  "確認済みの案内にはない実行形式の添付へ変わっています。",
  "It adds an executable attachment absent from the verified notice.",
);
const attachmentDetail = text(
  "実行形式を何でも悪意と決めつける問題ではありません。この案内で予定されていないプログラムを開かず、公式の経路で目的と配布元を確認する場面です。",
  "Not every executable is malicious. Here, do not open a program that was not part of the verified notice; check its purpose and source through an established route.",
);
const dateBenign = text(
  "日時の違いだけでは危険とは決められません。",
  "A different date or time alone does not establish danger.",
);
const dateDetail = text(
  "再送や通知時刻の違いはあり得ます。期限だけで本物とも偽物とも決めず、行き先や依頼内容を合わせて確認します。",
  "Messages can be resent or sent at different times. A deadline alone does not prove legitimacy or fraud; compare destinations and requests too.",
);
const subjectBenign = text(
  "件名の言い回しの違いだけでは危険とは決められません。",
  "A wording change in the subject alone does not establish danger.",
);
const subjectDetail = text(
  "誤字や自然な文章かどうかだけで判定しません。自然に書かれた危険なメールも、言い回しの違う正規の案内もあります。",
  "Do not judge from spelling or fluent prose alone. Harmful messages can read naturally; legitimate notices can use different wording.",
);

const authoredCases = [
  {
    id: "invoice",
    title: text("請求のお知らせ", "A billing notice"),
    context: text(
      "みなもアプリで、送信元・請求履歴の行き先・返信不要の案内を確認済みです。これを基準に、似たメールと見比べます。",
      "The Minamo app has verified the sender, billing-history destination and no-reply instructions. Compare this reference with a similar message.",
    ),
    rows: [
      row(
        "from",
        text("みなも請求 <billing@minamo.example>", "Minamo Billing <billing@minamo.example>"),
        text(
          "みなも請求 <billing@minamo-notice.example>",
          "Minamo Billing <billing@minamo-notice.example>",
        ),
        "risk",
        senderRisk,
        senderDetail,
      ),
      row(
        "subject",
        text("今月のご利用明細", "This month's statement"),
        text("ご利用明細のお知らせ", "Your statement is ready"),
        "benign",
        subjectBenign,
        subjectDetail,
      ),
      row(
        "date",
        text("10月12日 10:00", "12 Oct, 10:00"),
        text("10月12日 10:15", "12 Oct, 10:15"),
        "benign",
        dateBenign,
        dateDetail,
      ),
      row(
        "link",
        text("https://account.minamo.example/invoices", "https://account.minamo.example/invoices"),
        text("https://minamo-check.example/invoices", "https://minamo-check.example/invoices"),
        "risk",
        linkRisk,
        linkDetail,
      ),
      row(
        "request",
        text(
          "いつものアプリで明細を確認。認証コードの返信は不要。",
          "Check the statement in your usual app. Do not reply with authentication codes.",
        ),
        text(
          "認証コードをこのメールへ返信して、請求を取り消してください。",
          "Reply to this email with your authentication code to cancel the charge.",
        ),
        "risk",
        text(
          "認証コードを返信するよう要求しています。",
          "It asks you to send an authentication code by reply.",
        ),
        text(
          "コードは他人へ教えません。支払いの話に見えても、メールへコードを渡す操作はせず、いつものアプリから同じ依頼を確認します。",
          "Do not give codes to another person. Even in a billing story, do not send a code by email; check the request through your usual app.",
        ),
      ),
      same("attachment", text("なし", "None")),
      same("reply", text("support@minamo.example", "support@minamo.example")),
    ],
  },
  {
    id: "shared-file",
    title: text("共有資料の案内", "A shared document"),
    context: text(
      "こもれびアプリで会議資料の案内を確認済み。share@とupdates@は両方登録済みの送信元です。共有先は会議メンバーだけ、添付はPDFです。",
      "The Komorebi app has verified this notice. Both share@ and updates@ are registered senders. The file is a PDF shared only with meeting members.",
    ),
    rows: [
      row(
        "from",
        text("share@komorebi.example", "share@komorebi.example"),
        text("updates@komorebi.example", "updates@komorebi.example"),
        "benign",
        text(
          "この場面では、どちらも登録済みの送信元です。",
          "Both senders are registered in this scene.",
        ),
        text(
          "公式アプリの確認情報では両方が登録済みです。文字列が違うことだけを危険扱いせず、行き先・依頼・添付も照合します。",
          "The reference information confirms both senders. A text difference alone is not a risk; compare the target, request and attachment too.",
        ),
      ),
      row(
        "subject",
        text("会議資料の共有", "Meeting files shared"),
        text("会議の資料が届きました", "Your meeting documents"),
        "benign",
        subjectBenign,
        subjectDetail,
      ),
      same("date", text("10月13日 09:00", "13 Oct, 09:00")),
      row(
        "link",
        text("https://files.komorebi.example/meeting", "https://files.komorebi.example/meeting"),
        text("https://komorebi-files.example/meeting", "https://komorebi-files.example/meeting"),
        "risk",
        linkRisk,
        linkDetail,
      ),
      row(
        "request",
        text(
          "登録済みの会議メンバーだけに共有。",
          "Share only with the registered meeting members.",
        ),
        text(
          "閲覧できない場合は「リンクを知る全員」に公開してください。",
          "If access fails, make the document available to anyone with the link.",
        ),
        "risk",
        text(
          "確認済みの共有範囲を、誰でも見られる範囲へ広げています。",
          "It expands the verified sharing scope to anyone with the link.",
        ),
        text(
          "閲覧の不具合を口実に公開範囲を広げると、意図しない相手へ内容が届くおそれがあります。共有先を変える前に主催者へ既知の経路で確認します。",
          "Expanding access to fix a viewing problem can expose content to unintended readers. Check with the organizer through an established route before changing sharing.",
        ),
      ),
      row(
        "attachment",
        text("会議資料.pdf", "meeting-notes.pdf"),
        text("会議資料.pdf.exe（実行形式）", "meeting-notes.pdf.exe (executable)"),
        "risk",
        attachmentRisk,
        attachmentDetail,
      ),
      same("reply", text("help@komorebi.example", "help@komorebi.example")),
    ],
  },
  {
    id: "account",
    title: text("アカウントの確認", "An account check"),
    context: text(
      "ほしぞらアプリで案内を確認済み。/settings と /security は同じ公式サイトの登録済み画面です。MFA無効化やツールの導入は求めていません。",
      "The Hoshizora app has verified this notice. Both /settings and /security are registered pages on its official site. It does not ask you to disable MFA or install a tool.",
    ),
    rows: [
      same("from", text("notice@hoshizora.example", "notice@hoshizora.example")),
      same("subject", text("アカウント設定のお知らせ", "Account settings notice")),
      row(
        "date",
        text("10月14日 13:00", "14 Oct, 13:00"),
        text("10月14日 14:00", "14 Oct, 14:00"),
        "benign",
        dateBenign,
        dateDetail,
      ),
      row(
        "link",
        text(
          "https://account.hoshizora.example/settings",
          "https://account.hoshizora.example/settings",
        ),
        text(
          "https://account.hoshizora.example/security",
          "https://account.hoshizora.example/security",
        ),
        "benign",
        text(
          "この場面では、同じ公式サイトの確認済み画面です。",
          "Both are verified pages on the same official site in this scene.",
        ),
        text(
          "URLの末尾が違うだけでは危険とは限りません。ここでは両方が登録済みですが、同じドメインだからメール全体が安全という意味ではありません。",
          "A different path is not automatically dangerous. Both paths are registered here; a matching domain still does not prove the whole email safe.",
        ),
      ),
      row(
        "request",
        text(
          "いつものアプリで設定を確認。MFAは有効のまま。",
          "Check settings in your usual app; keep MFA enabled.",
        ),
        text(
          "安全確認が終わるまでMFA（追加の認証）を無効にしてください。",
          "Disable MFA (the additional authentication check) until this safety review is complete.",
        ),
        "risk",
        text(
          "確認済みの案内とは異なり、追加の認証を外す要求です。",
          "Unlike the verified notice, it asks you to remove an authentication layer.",
        ),
        text(
          "この場面の公式案内はMFAを外す必要がありません。安全を理由に保護を外す依頼をそのまま実行せず、普段の設定画面や窓口から確認します。",
          "The verified notice does not require removing MFA. Do not follow an unsolicited request to weaken protection; check through your usual settings or contact.",
        ),
      ),
      row(
        "attachment",
        text("なし", "None"),
        text("保護確認ツール.exe（実行形式）", "account-check.exe (executable)"),
        "risk",
        attachmentRisk,
        attachmentDetail,
      ),
      row(
        "reply",
        text("help@hoshizora.example", "help@hoshizora.example"),
        text("help@hoshizora-assist.example", "help@hoshizora-assist.example"),
        "risk",
        text(
          "返信先が、確認済みの窓口とは別のドメインです。",
          "The reply goes to a different domain from the verified contact.",
        ),
        text(
          "送信元表示が同じでも返信先は違うことがあります。届いたメールに返信するだけにせず、以前から知る窓口を自分で開きます。",
          "A familiar displayed sender can have a different reply address. Use a contact you already know instead of simply replying.",
        ),
      ),
    ],
  },
  {
    id: "booking",
    title: text("予約のご案内", "A booking notice"),
    context: text(
      "そよかぜ予約アプリで案内を確認済みです。予約はいつものアプリで確認でき、メールの添付を開く手順はありません。",
      "The Soyokaze booking app has verified this notice. Check bookings through your usual app; the notice requires no email attachment.",
    ),
    rows: [
      row(
        "from",
        text("booking@soyokaze.example", "booking@soyokaze.example"),
        text("booking@soyokaze-reserve.example", "booking@soyokaze-reserve.example"),
        "risk",
        senderRisk,
        senderDetail,
      ),
      same("subject", text("予約内容のご案内", "Your booking details")),
      row(
        "date",
        text("10月15日 12:00", "15 Oct, 12:00"),
        text("10月15日 12:30", "15 Oct, 12:30"),
        "benign",
        dateBenign,
        dateDetail,
      ),
      same(
        "link",
        text("https://app.soyokaze.example/bookings", "https://app.soyokaze.example/bookings"),
      ),
      row(
        "request",
        text(
          "いつものアプリで予約内容を確認できます。",
          "You can check the booking in your usual app.",
        ),
        text(
          "普段使うアプリから予約履歴をご確認ください。",
          "Open the app you normally use to view the booking.",
        ),
        "benign",
        text(
          "言い回しが違っても、確認する操作は同じです。",
          "The wording differs, but the requested action is the same.",
        ),
        subjectDetail,
      ),
      row(
        "attachment",
        text("なし", "None"),
        text("予約確認.pdf.exe（実行形式）", "booking.pdf.exe (executable)"),
        "risk",
        attachmentRisk,
        attachmentDetail,
      ),
      row(
        "reply",
        text("support@soyokaze.example", "support@soyokaze.example"),
        text("support@soyokaze-reserve.example", "support@soyokaze-reserve.example"),
        "risk",
        text(
          "確認済みの返信窓口とは別のドメインです。",
          "The reply contact differs from the verified domain.",
        ),
        text(
          "この場面で確認済みの返信先とは異なります。届いたメールへ返信するだけにせず、普段から知る窓口を自分で開いて確かめます。",
          "This reply address differs from the verified contact. Open a contact you already know rather than simply replying to the incoming message.",
        ),
      ),
    ],
  },
];

// An advanced pair follows a familiar pair; all domains are reserved examples.
const homograph = "minаmo.example"; // U+0430 CYRILLIC SMALL LETTER A, not Latin U+0061.
authoredCases.push({
  id: "lookalike",
  advanced: true,
  title: text("似ているけれど、同じ？", "Looks alike — is it the same?"),
  context: text(
    "みなもアプリで minamo.example と返信不要の案内を確認済み。見た目が似ていても、同じ相手でしょうか。",
    "The Minamo app confirms minamo.example and no-reply instructions. Does a similar appearance mean the same sender?",
  ),
  rows: [
    row(
      "from",
      text("billing@minamo.example", "billing@minamo.example"),
      text(`billing@${homograph}`, `billing@${homograph}`),
      "risk",
      text(
        "a に似た別の文字が混ざり、確認済みとは別ドメインです。",
        "A different character that looks like a changes the verified domain.",
      ),
      text(
        "受信側の認証がpassでも、この別ドメインの送信者であるという結果です。正規の相手や無害な内容の保証ではありません。国際化ドメイン自体を危険とするものではありません。",
        "Passing authentication identifies this different domain, not the verified organization or harmless content. Internationalized domains are not inherently dangerous.",
      ),
    ),
    row(
      "subject",
      text("今月のご利用明細", "This month's statement"),
      text("ご利用明細のお知らせ", "Your statement is ready"),
      "benign",
      subjectBenign,
      subjectDetail,
    ),
    row(
      "date",
      text("10月16日 10:00", "16 Oct, 10:00"),
      text("10月16日 10:15", "16 Oct, 10:15"),
      "benign",
      dateBenign,
      dateDetail,
    ),
    row(
      "link",
      text("https://minamo.example/invoices", "https://minamo.example/invoices"),
      text(`https://${homograph}/invoices`, `https://${homograph}/invoices`),
      "risk",
      text(
        "行き先も、似た別文字のドメインです。",
        "The destination also uses the look-alike domain.",
      ),
      text(
        "リンク先の詳細でUnicodeとASCII表記を比較できます。この教材は両方を明示します。実際のメールソフトやブラウザーの表示方法は環境で異なります。いつものアプリから確認しましょう。",
        "Inspect the Unicode and ASCII forms here. This game deliberately shows both; real mail clients and browsers vary in how they display them. Check through your usual app.",
      ),
    ),
    row(
      "request",
      text(
        "いつものアプリで確認。認証コードの返信は不要。",
        "Check in your usual app. Do not reply with authentication codes.",
      ),
      text(
        "本人確認のため認証コードを返信してください。",
        "Reply with your authentication code to verify your identity.",
      ),
      "risk",
      text(
        "確認済みの案内にない認証コードの要求です。",
        "It requests an authentication code absent from the verified notice.",
      ),
      text(
        "認証結果がpassでもコードを他人へ渡しません。既知の経路で確認します。",
        "Even with passing authentication, do not give codes to another person. Check through a known route.",
      ),
    ),
    same("attachment", text("なし", "None")),
    same("reply", text("support@minamo.example", "support@minamo.example")),
  ],
});

// Compare five meaningful differences per pair: three risky changes and two normal variations.
export const CASES = authoredCases.map((item) => ({
  ...item,
  mailRows: item.rows,
  rows: item.rows.filter((entry) => entry.kind !== "same"),
}));

// Every visible incoming-message content area can be inspected. Neutral areas
// use the same controls as scored differences, without adding score targets.
const neutralLabels = {
  greeting: text("あいさつ", "Greeting"),
  opening: text("本文の案内", "Opening text"),
  signature: text("署名の表示", "Displayed signature"),
  "display-name": text("差出人の表示名", "Sender display name"),
  to: text("宛先", "Recipient"),
};
export function inspectionRow(item, id) {
  const authored = item.mailRows.find((entry) => entry.id === id);
  if (authored) return authored;
  const label = neutralLabels[id];
  if (!label) return undefined;
  return {
    id,
    label,
    kind: "same",
    reason: text(
      "この表示だけでは、この場面の危険な違いとは判断できません。",
      "This text alone is not a risky difference in this scene.",
    ),
    detail: text(
      "あいさつ・表示名・署名や宛先だけでは本物と保証できません。実アドレス・行き先・依頼内容と照合し、迷ったら既知の経路で確認します。",
      "A greeting, display name, signature or recipient does not prove legitimacy. Compare actual addresses, destinations and requests; verify through a known route if unsure.",
    ),
  };
}
