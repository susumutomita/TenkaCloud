// Authored receiver observations, not DNS lookups or cryptographic verification.
const copy = {
  ja: {
    open: "元のメッセージを見る（模擬ヘッダー）",
    trust:
      "この教材では、確認済みの受信サーバー mx.practice.example が付与した検証結果を示します。メール内に同名のヘッダーが書かれているだけでは信頼できません。署名値は省略しています。",
    caution:
      "SPFは配送元、DKIMは署名ドメインを検証します。DMARCはFromとの整合を確認します。passは内容の安全や善意の保証ではありません。Reply-Toはこの整合判定の対象ではありません。",
    forwarded:
      "確認済みメールは転送でSPFがfailになった模擬例です。Fromと一致するDKIM署名はpassのためDMARCはpass。SPFのfailだけでは詐欺と断定できません。",
    unaligned:
      "届いたメールはSPF・DKIMとも別ドメインでpassですが、Fromと一致せずDMARCはfail。この結果だけで詐欺とは断定せず、本文の要求と既知の窓口も照合します。",
    lookalike:
      "この似た別ドメインは自分のドメインで認証にpassしています。確認済みのサービスから届いた証明にはなりません。",
    unicode: "Unicode表示",
    ascii: "ASCII / Punycode",
    note: "教材では両方を表示します。実際の表示はアプリや設定で異なります。国際化ドメイン自体は危険ではありません。",
  },
  en: {
    open: "Show original (simulated headers)",
    trust:
      "In this exercise, these results come from the verified receiving server mx.practice.example. An identically named header written inside a message is not inherently trusted. Signature bytes are omitted.",
    caution:
      "SPF checks the sending source; DKIM checks the signing domain. DMARC checks alignment with From. A pass does not guarantee safe content or good intent. Reply-To is not used for this alignment.",
    forwarded:
      "This verified reference simulates forwarding that causes SPF to fail. The passing DKIM signature matches From, so DMARC passes. An SPF failure alone does not establish fraud.",
    unaligned:
      "The incoming message passes SPF and DKIM for a different domain, but neither aligns with From, so DMARC fails. This alone is not proof of fraud; compare the request and an established contact too.",
    lookalike:
      "This look-alike domain passes authentication for its own domain. That does not establish that the message comes from the verified service.",
    unicode: "Unicode form",
    ascii: "ASCII / Punycode",
    note: "This exercise shows both forms. Actual display depends on the app and settings. Internationalized domains are not inherently dangerous.",
  },
};
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const value = (item, id, side, lang) =>
  item.mailRows.find((row) => row.id === id)[side === "reference" ? "before" : "after"][lang];
export function asciiDomain(domain) {
  return new URL(`https://${domain}/`).hostname;
}
export function headerFacts(item, side) {
  const raw = value(item, "from", side, "en");
  const from = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
  const fromDomain = asciiDomain(from.split("@")[1]);
  const unaligned = item.id === "account" && side === "received";
  const forwarded = item.id === "shared-file" && side === "reference";
  const signingDomain = unaligned ? "notice-delivery.example" : fromDomain;
  const envelopeDomain = forwarded ? "forwarder.example" : signingDomain;
  const spf = forwarded ? "fail" : "pass";
  const dkim = "pass";
  const dmarc = unaligned ? "fail" : "pass";
  return {
    from,
    fromDomain,
    signingDomain,
    envelopeDomain,
    spf,
    dkim,
    dmarc,
    forwarded,
    unaligned,
  };
}
export function originalHeaders(item, side, lang) {
  const f = headerFacts(item, side);
  return [
    "Authentication-Results: mx.practice.example;",
    ` spf=${f.spf} smtp.mailfrom=${f.envelopeDomain};`,
    ` dkim=${f.dkim} header.d=${f.signingDomain} header.s=practice;`,
    ` dmarc=${f.dmarc} header.from=${f.fromDomain}`,
    `From: ${f.from}`,
    "To: learner@practice.example",
    `Reply-To: ${value(item, "reply", side, lang)}`,
    `Return-Path: <bounce@${f.envelopeDomain}>`,
    // Only the signing domain/selector are shown; this is not a valid signature.
    `X-Practice-DKIM-Domain: d=${f.signingDomain}; s=practice`,
    `Subject: ${value(item, "subject", side, lang)}`,
  ].join("\n");
}
export function domainInspection(url, lang) {
  const box = node("div", undefined, "domain-inspection");
  const domain = /^https:\/\/([^/]+)/.exec(url)?.[1];
  if (!domain || !Array.from(domain).some((character) => character.codePointAt(0) > 127))
    return box;
  const t = copy[lang];
  box.append(
    node("p", `${t.unicode}: ${domain}`),
    node("p", `${t.ascii}: ${asciiDomain(domain)}`),
    node("p", t.note),
  );
  return box;
}
export function createOriginal(item, side, lang, ui, handlers, mailLang = lang) {
  const t = copy[lang],
    f = headerFacts(item, side);
  const group = node("section", undefined, "original-message");
  const toggle = node("button", t.open, "original-toggle");
  toggle.type = "button";
  toggle.id = `original-${side}`;
  toggle.setAttribute("aria-expanded", String(ui.original[side]));
  toggle.setAttribute("aria-controls", `original-panel-${side}`);
  toggle.addEventListener("click", () => handlers.toggle("original", side, toggle.id));
  const panel = node("div", undefined, "original-panel");
  panel.id = `original-panel-${side}`;
  panel.hidden = !ui.original[side];
  panel.append(
    node("p", t.trust),
    Object.assign(node("pre", originalHeaders(item, side, mailLang)), { lang: mailLang }),
    node("p", t.caution),
  );
  if (f.forwarded) panel.append(node("p", t.forwarded));
  if (f.unaligned) panel.append(node("p", t.unaligned));
  if (item.id === "lookalike" && side === "received") panel.append(node("p", t.lookalike));
  group.append(toggle, panel);
  return group;
}
