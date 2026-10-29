import { COPY } from "./copy.js?v=d6ed1fef3f";

import { createOriginal, domainInspection } from "./message-headers.js?v=d6ed1fef3f";

const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
const presentations = {
  invoice: {
    ja: ["みなも請求", "今月のご利用についてご案内します。", "ご利用明細を確認"],
    en: ["Minamo Billing", "Your monthly statement is ready.", "View your statement"],
  },
  "shared-file": {
    ja: ["こもれび共有", "次回の会議資料をお送りします。", "共有資料を確認"],
    en: ["Komorebi Files", "Here are the documents for our next meeting.", "View shared documents"],
  },
  account: {
    ja: ["ほしぞらサポート", "アカウントの設定についてお知らせします。", "アカウント設定を確認"],
    en: ["Hoshizora Support", "An update about your account settings.", "View account settings"],
  },
  lookalike: {
    ja: ["みなも請求", "今月のご利用についてご案内します。", "ご利用明細を確認"],
    en: ["Minamo Billing", "Your monthly statement is ready.", "View your statement"],
  },
  booking: {
    ja: ["そよかぜ予約", "ご予約についてのご案内です。", "予約内容を確認"],
    en: ["Soyokaze Bookings", "An update about your booking.", "View your booking"],
  },
};
export function emailValue(item, id, side, lang) {
  const row = item.mailRows.find((entry) => entry.id === id);
  return row?.[side === "reference" ? "before" : "after"][lang] ?? "";
}
function address(value) {
  return /<([^>]+)>/.exec(value)?.[1] ?? value;
}
function localReason(row, t, suffix) {
  const note = node(
    "div",
    undefined,
    row.kind === "risk" ? "reason risk-reason" : "reason normal-reason",
  );
  note.id = `reason-${row.id}-${suffix}`;
  const details = node("details");
  details.append(node("summary", t.detail), node("p", row.detail));
  note.append(node("p", row.reason), details);
  return note;
}
function spotControl(row, value, slot, run, t, handlers) {
  const control = node("button", value, "mail-spot");
  control.type = "button";
  control.id = `spot-${row.id}-${slot}`;
  control.setAttribute("aria-label", `${row.label[document.documentElement.lang]}: ${value}`);
  const found = run.found[run.index].includes(row.id),
    shown = run.revealed[run.index].includes(row.id);
  control.setAttribute("aria-pressed", String(found || shown));
  if (found || shown) {
    control.classList.add("correct");
    control.append(node("span", `✓ ${shown ? t.reviewed : t.spotted}`, "stamp"));
  }
  if (run.feedback?.id === row.id && run.feedback.fresh) control.classList.add("fresh");
  control.addEventListener("click", () => handlers.choose(row.id, control.id));
  return control;
}
function appendReason(group, content, row, slot, run, t, ui) {
  if (ui.lastTarget !== content.id && !run.revealed[run.index].includes(row.id)) return;
  const note = localReason(row, t, slot);
  content.setAttribute("aria-describedby", note.id);
  group.append(note);
}
export function createEmail(item, side, lang, run, ui, handlers) {
  const t = COPY[lang],
    reference = side === "reference",
    view = presentations[item.id][lang];
  const card = node(
    "article",
    undefined,
    `email-card${ui.active === side ? " active-mobile" : ""}`,
  );
  card.id = `email-${side}`;
  const label = node("p", reference ? t.reference : t.received, "message-source");
  label.id = `source-${side}`;
  card.setAttribute("aria-labelledby", label.id);
  if (reference) label.append(node("span", t.referencePause, "reference-clock-note"));
  card.append(label);
  function field(id, slot, className, heading = false) {
    const raw = emailValue(item, id, side, lang);
    const value = id === "from" ? address(raw) : raw;
    const row = !reference && item.rows.find((entry) => entry.id === id);
    const group = node("div", undefined, className);
    const content = row
      ? spotControl(row, value, slot, run, t, handlers)
      : node("span", value, "mail-text");
    if (heading) {
      const title = node("h3");
      title.append(content);
      group.append(title);
    } else group.append(content);
    if (row)
      appendReason(
        group,
        content,
        { ...row, reason: row.reason[lang], detail: row.detail[lang] },
        slot,
        run,
        t,
        ui,
      );
    return group;
  }
  const message = node("div", undefined, "email-message");
  message.append(field("subject", "subject", "mail-subject", true));
  const header = node("div", undefined, "message-header");
  header.append(node("span", view[0].slice(0, 1), "sender-avatar"));
  const identity = node("div", undefined, "sender-identity");
  identity.append(node("strong", view[0], "sender-name"));
  const toggle = node("button", t.toMe, "address-toggle");
  toggle.type = "button";
  toggle.id = `details-${side}`;
  toggle.setAttribute("aria-expanded", String(ui.address[side]));
  toggle.setAttribute("aria-controls", `headers-${side}`);
  toggle.setAttribute("aria-label", t.headerDetails);
  toggle.addEventListener("click", () => handlers.toggle("address", side, toggle.id));
  identity.append(toggle);
  header.append(identity, field("date", "date", "mail-date"));
  message.append(header);
  const headers = node("div", undefined, "address-details");
  headers.id = `headers-${side}`;
  headers.hidden = !ui.address[side];
  for (const [id, key] of [
    ["from", "senderLabel"],
    ["to", "toLabel"],
    ["reply", "replyLabel"],
    ["date", "dateLabel"],
  ]) {
    const line = node("div", undefined, "header-line");
    line.append(node("span", t[key], "header-label"));
    line.append(
      id === "to"
        ? node("span", "learner@practice.example")
        : field(id, `details-${side}`, "header-value"),
    );
    headers.append(line);
  }
  message.append(headers, createOriginal(item, side, lang, ui, handlers));
  const body = node("div", undefined, "mail-body");
  body.append(node("p", t.greeting), node("p", view[1]), field("request", "body", "body-request"));
  const link = node("div", undefined, "link-inspector");
  const inspect = node("button", view[2], "mail-link");
  inspect.type = "button";
  inspect.id = `link-${side}`;
  inspect.setAttribute("aria-label", `${view[2]} · ${t.linkInspect}`);
  inspect.setAttribute("aria-expanded", String(ui.link[side]));
  inspect.setAttribute("aria-controls", `target-${side}`);
  inspect.addEventListener("click", () => handlers.toggle("link", side, inspect.id));
  const preview = node("span", emailValue(item, "link", side, lang), "link-preview");
  preview.setAttribute("aria-hidden", "true");
  const target = node("div", undefined, "link-target");
  target.id = `target-${side}`;
  target.hidden = !ui.link[side];
  target.append(node("p", t.actualTarget, "target-label"), field("link", "target", "target-value"));
  target.append(domainInspection(emailValue(item, "link", side, lang), lang));
  if (!reference && item.rows.some((entry) => entry.id === "link"))
    target.append(node("p", t.linkTap, "target-hint"));
  link.append(inspect, preview, target);
  body.append(link, node("p", view[0], "mail-signature"));
  const attachment = emailValue(item, "attachment", side, lang);
  if (attachment && !["なし", "None"].includes(attachment)) {
    const files = node("div", undefined, "attachment-area");
    files.append(
      node("span", "▤", "file-icon"),
      field("attachment", "file", "attachment-file"),
      node("span", t.attachmentNote, "attachment-hint"),
    );
    body.append(files);
  }
  message.append(body);
  card.append(message);
  if (!reference) {
    const footer = node("div", t.outlet, "processing-outlet");
    card.append(footer);
  }
  return card;
}
