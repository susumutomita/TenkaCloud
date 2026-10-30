import { CASES } from "./cases.js?v=ed7388be74";

const text = (ja, en) => ({ ja, en });
export const LEVELS = [
  { level: 1, id: "booking", targets: ["attachment"] },
  { level: 2, id: "invoice", targets: ["from", "request"] },
  { level: 3, id: "shared-file", targets: ["link", "attachment"] },
  { level: 4, id: "account", targets: ["request", "attachment", "reply"] },
  { level: 5, id: "lookalike", targets: ["from", "link", "request"] },
];
export const VARIANT_COUNT = 3;
const families = {
  booking: ["そよかぜ", "Soyokaze", "soyokaze"],
  invoice: ["みなも", "Minamo", "minamo"],
  "shared-file": ["こもれび", "Komorebi", "komorebi"],
  account: ["ほしぞら", "Hoshizora", "hoshizora"],
  lookalike: ["みなも", "Minamo", "minamo"],
};
const alternatives = [null, ["なぎさ", "Nagisa", "nagisa"], ["はるみ", "Harumi", "harumi"]];
const context = {
  1: text(
    "いつもの予約アプリで確認した案内です。メールの添付を開く手順はありません。",
    "This notice was verified in your usual booking app. It does not ask you to open an email attachment.",
  ),
  2: text(
    "アプリで確認した案内は「明細PDFを添付。認証コードの返信は不要」です。",
    "Your app verified this notice: a statement PDF is attached; no reply with an authentication code is needed.",
  ),
};
const fileNames = [
  text("予約確認.zip", "booking-details.zip"),
  text("予約の資料.zip", "reservation-notes.zip"),
  text("ご案内の写真.zip", "booking-photos.zip"),
];
const codeRequests = [
  text(
    "認証コードをこのメールへ返信して、請求を取り消してください。",
    "Reply to this email with your authentication code to cancel the charge.",
  ),
  text(
    "請求の確認には、届いた認証コードを返信してください。",
    "To check the charge, reply with the authentication code you received.",
  ),
  text(
    "本人確認のため、認証コードをメールで送り返してください。",
    "Send your authentication code back by email to verify your identity.",
  ),
];
const toolRequests = [
  text(
    "安全確認が終わるまでMFA（追加の認証）を無効にしてください。",
    "Turn off MFA (additional authentication) until the safety check finishes.",
  ),
  text(
    "確認作業のため、MFA（追加の認証）をいったん解除してください。",
    "Temporarily disable MFA (additional authentication) for our check.",
  ),
  text(
    "点検を続けるには、MFA（追加の認証）をオフにしてください。",
    "Switch off MFA (additional authentication) to continue the inspection.",
  ),
];
const view = {
  booking: [
    text("そよかぜ予約", "Soyokaze Bookings"),
    text("ご予約についてのご案内です。", "An update about your booking."),
    text("予約内容を確認", "View your booking"),
  ],
  invoice: [
    text("みなも請求", "Minamo Billing"),
    text("今月のご利用についてご案内します。", "Your monthly statement is ready."),
    text("ご利用明細を確認", "View your statement"),
  ],
  lookalike: [
    text("みなも請求", "Minamo Billing"),
    text("今月のご利用についてご案内します。", "Your monthly statement is ready."),
    text("ご利用明細を確認", "View your statement"),
  ],
  "shared-file": [
    text("こもれび共有", "Komorebi Files"),
    text("次回の会議資料をお送りします。", "Here are the documents for our next meeting."),
    text("共有資料を確認", "View shared documents"),
  ],
  account: [
    text("ほしぞらサポート", "Hoshizora Support"),
    text("アカウントの設定についてお知らせします。", "An update about your account settings."),
    text("アカウント設定を確認", "View account settings"),
  ],
};
function rename(value, id, variant) {
  if (!variant) return value;
  const [ja, en, domain] = families[id],
    replacement = alternatives[variant];
  const result = {};
  for (const locale of ["ja", "en"]) {
    result[locale] = value[locale]
      .replaceAll("minаmo", replacement[2].replace("a", "а"))
      .replaceAll(domain, replacement[2])
      .replaceAll(ja, replacement[0])
      .replaceAll(en, replacement[1]);
  }
  return result;
}
function sameAsReference(row) {
  return {
    ...row,
    after: row.before,
    kind: "same",
    reason: text("確認済みの案内と同じ内容です。", "This matches the verified notice."),
    detail: text(
      "同じ表示だけでメール全体の安全は保証できません。ほかの要求や行き先も照合します。",
      "Matching text does not guarantee the whole message safe. Compare its requests and destinations too.",
    ),
  };
}
function attachmentLesson(row, level, variant) {
  if (level === 1)
    return {
      ...row,
      after: fileNames[variant],
      reason: text(
        "案内にない添付が増えています。開かず、いつもの予約アプリで確かめよう。",
        "An unexpected attachment was added. Leave it unopened and check your usual booking app.",
      ),
      detail: text(
        "手口：予定にないファイルを開くよう誘う内容です。中身はこの表示だけでは分かりません。どうする：開かない・実行しない。既知の別経路で本人に確認し、業務なら組織の窓口へ報告します。拡張子だけで悪性とは決めません。",
        "Method: the message invites you to open an unexpected file; its contents cannot be known from this display. Action: do not open or run it. Check through a known independent contact and report it to your workplace's security contact when relevant. An extension alone does not prove malice.",
      ),
    };
  const names =
    level === 3
      ? ["資料ビューアー.exe", "会議資料の表示アプリ.exe", "資料確認アプリ.exe"]
      : ["保護確認ツール.exe", "アカウント点検ツール.exe", "安全確認アプリ.exe"];
  const enNames =
    level === 3
      ? ["document-viewer.exe", "meeting-viewer.exe", "document-check.exe"]
      : ["protection-check.exe", "account-inspection.exe", "security-check.exe"];
  return {
    ...row,
    after: text(
      `${names[variant]}\n${level === 3 ? "資料を見るには、この専用アプリを起動してください。" : "確認を進めるには、このツールを起動してください。"}`,
      `${enNames[variant]}\n${level === 3 ? "Run this dedicated app to read the document." : "Run this tool to continue the check."}`,
    ),
    reason: text(
      "予定にないアプリを実行させる要求です。開かず、既知の窓口で確認を。",
      "It asks you to run an unrequested app. Leave it unopened and verify through a known contact.",
    ),
    detail: text(
      "手口：資料の閲覧や安全確認を口実に、ソフトを実行させようとしています。狙われた行動：依頼していないプログラムの起動。どうする：ダウンロード・実行せず、メール内の連絡先ではなく既知の別経路で確認し、業務なら組織の窓口へ報告します。exe があるだけで全て悪性と決める問題ではありません。",
      "Method: document access or a safety check is used as a reason to run software. Requested behavior: starting an unrequested program. Action: do not download or run it; verify through a known independent route rather than contacts in this email, and report it to your workplace's security contact when relevant. An exe extension alone does not make every program malicious.",
    ),
  };
}
function requestLesson(row, level, variant) {
  const result = { ...row, after: level === 4 ? toolRequests[variant] : codeRequests[variant] };
  result.detail =
    level === 4
      ? text(
          "手口：安全確認を理由に保護を弱める要求です。どうする：MFAを無効にせず、いつものアプリや既知の窓口で確かめます。業務なら組織の窓口へ報告します。",
          "Method: a safety check is used to ask you to weaken protection. Action: keep MFA enabled, check your usual app or known contact, and report it to your workplace's security contact when relevant.",
        )
      : text(
          "手口：請求や本人確認を理由に認証コードを返信させる要求です。コードはアカウントへのアクセスに使われることがあります。どうする：返信せず、いつものアプリや既知の窓口で確認し、業務なら組織の窓口へ報告します。",
          "Method: a billing or identity check is used to request your authentication code, which can be used to access an account. Action: do not reply; verify in your usual app or through a known contact and report it at work when relevant.",
        );
  return result;
}
function routeLesson(row) {
  const method =
    row.id === "link"
      ? text(
          "手口：同じボタン名でも別のサイトへ誘導できます。狙われる行動：相手を確かめずに情報を入力すること。",
          "Method: an identical button label can lead to a different site. Targeted behavior: entering information without checking who receives it.",
        )
      : text(
          "手口：見慣れた名前のまま、送信元や返信先だけが別の窓口になっていることがあります。狙われる行動：相手を確かめず信用すること。",
          "Method: a familiar name can conceal a different sender or reply destination. Targeted behavior: trusting it without checking the actual contact.",
        );
  return {
    ...row,
    detail: text(
      `${row.detail.ja} ${method.ja} どうする：返信や入力をせず、既知の別経路で確認。業務なら組織の窓口へ報告します。`,
      `${row.detail.en} ${method.en} Action: hold the reply or input, verify through a known independent route, and report it to your workplace's security contact when relevant.`,
    ),
  };
}
export function levelCase(level, variant = 0) {
  const definition = LEVELS.find((entry) => entry.level === level);
  if (!definition || !Number.isInteger(variant) || variant < 0 || variant >= VARIANT_COUNT)
    throw new RangeError("Invalid lesson or variant");
  const original = CASES.find((item) => item.id === definition.id);
  const mailRows = original.mailRows.map((row) => {
    let result =
      row.kind === "risk" && !definition.targets.includes(row.id)
        ? sameAsReference(row)
        : { ...row };
    if (result.kind === "risk" && result.id === "attachment")
      result = attachmentLesson(result, level, variant);
    if (result.kind === "risk" && result.id === "request")
      result = requestLesson(result, level, variant);
    if (result.kind === "risk" && ["from", "reply", "link"].includes(result.id))
      result = routeLesson(result);
    if (level === 2 && result.id === "attachment") {
      result = {
        ...result,
        before: text("ご利用明細.pdf", "statement.pdf"),
        after: text("ご利用明細.pdf", "statement.pdf"),
      };
    }
    return {
      ...result,
      before: rename(result.before, original.id, variant),
      after: rename(result.after, original.id, variant),
      reason: rename(result.reason, original.id, variant),
      detail: rename(result.detail, original.id, variant),
    };
  });
  const presentation = {};
  for (const locale of ["ja", "en"]) {
    presentation[locale] = view[original.id].map(
      (value) => rename(value, original.id, variant)[locale],
    );
    if (variant === 1)
      presentation[locale][1] = text(
        "ご確認いただきたいお知らせです。",
        "An update for you to review.",
      )[locale];
    if (variant === 2)
      presentation[locale][1] = text(
        "ご利用中のサービスからのご案内です。",
        "A notice about the service you use.",
      )[locale];
  }
  return {
    ...original,
    advanced: level === 5,
    level,
    variant,
    context: rename(context[level] ?? original.context, original.id, variant),
    presentation,
    mailRows,
    rows: mailRows.filter((row) => row.kind !== "same"),
  };
}
export function chooseVariant(random, previous) {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
    throw new RangeError("Invalid random sample");
  const available = [0, 1, 2].filter((variant) => variant !== previous);
  return available[Math.floor(sample * available.length)];
}
