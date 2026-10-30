// Names verified against UnicodeData.txt, not inferred from the glyph's appearance.
const japaneseNames = { a: "ラテン文字の小文字 a", а: "キリル文字の小文字 а" };
const names = { a: "LATIN SMALL LETTER A", а: "CYRILLIC SMALL LETTER A" };
const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
function domain(url) {
  const match = /^https:\/\/([^/?#]+)\//u.exec(url);
  if (!match || /[@:]/u.test(match[1])) throw new TypeError("Expected an authored HTTPS domain");
  return match[1];
}
function character(value) {
  return {
    value,
    name: names[value] ?? "Unicode character",
    code: `U+${value.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  };
}
export function idnDifference(item) {
  const link = item.mailRows.find((row) => row.id === "link");
  const before = domain(link.before.en),
    after = domain(link.after.en);
  const left = Array.from(before),
    right = Array.from(after),
    differences = [];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    if (!left[index] || !right[index]) return null;
    differences.push({
      position: index + 1,
      before: character(left[index]),
      after: character(right[index]),
    });
  }
  return differences.length
    ? {
        before,
        after,
        asciiBefore: new URL(link.before.en).hostname,
        asciiAfter: new URL(link.after.en).hostname,
        differences,
      }
    : null;
}
function glyphPair(difference, ja) {
  const pair = node("div", undefined, "idn-glyph-pair");
  for (const [key, label] of [
    ["before", ja ? "確認済み" : "Verified"],
    ["after", ja ? "届いたメール" : "Incoming"],
  ]) {
    const part = node("div", undefined, "idn-character");
    part.append(
      node("span", label),
      node("span", difference[key].value, "idn-glyph"),
      node("code", difference[key].code),
      node(
        "span",
        ja
          ? `${japaneseNames[difference[key].value] ?? "Unicode文字"} / ${difference[key].name}`
          : difference[key].name,
      ),
    );
    pair.append(part);
  }
  return pair;
}
function markedDomain(value, positions) {
  const fragment = document.createDocumentFragment();
  for (const [index, letter] of Array.from(value).entries()) {
    fragment.append(
      positions.includes(index + 1) ? node("mark", letter) : document.createTextNode(letter),
    );
  }
  return fragment;
}
function domainList(comparison, ja) {
  const domains = node("dl", undefined, "idn-domains");
  for (const [label, value, highlight] of [
    [ja ? "確認済みの文字列" : "Verified text", comparison.before, true],
    [ja ? "届いた文字列" : "Incoming text", comparison.after, true],
    [ja ? "確認済みのASCII表記" : "Verified ASCII form", comparison.asciiBefore],
    [ja ? "届いたASCII / Punycode" : "Incoming ASCII / Punycode", comparison.asciiAfter],
  ]) {
    const content = node("dd");
    content.append(
      highlight
        ? markedDomain(
            value,
            comparison.differences.map((difference) => difference.position),
          )
        : document.createTextNode(value),
    );
    domains.append(node("dt", label), content);
  }
  return domains;
}
export function createIdnExplanation(item, lang, sourceId, openState) {
  const comparison = idnDifference(item);
  if (!comparison) return document.createDocumentFragment();
  const ja = lang === "ja",
    details = node("details", undefined, "idn-explanation");
  details.dataset.fontSource = sourceId;
  details.open = Boolean(openState[sourceId]);
  details.addEventListener("toggle", () => {
    if (details.isConnected) openState[sourceId] = details.open;
  });
  details.append(node("summary", ja ? "どの文字が違う？" : "Which character changed?"));
  details.append(
    node(
      "p",
      ja
        ? "同じ文字のフォント違いではなく、別の文字への置き換えです。字体によって、似て見える度合いは変わります。"
        : "A different character replaced the original; this is not just a different font for the same character. How alike they look depends on the font.",
    ),
  );
  for (const difference of comparison.differences) {
    details.append(
      node(
        "p",
        ja
          ? `ドメインの左から${difference.position}文字目`
          : `Character ${difference.position} from the start of the domain`,
      ),
    );
    details.append(glyphPair(difference, ja));
  }
  const domains = domainList(comparison, ja);
  details.append(domains, node("p", undefined, "idn-font-info"));
  details.append(
    node(
      "p",
      ja
        ? "国際化ドメイン自体が危険なのではありません。この場面では、確認済みとは別のドメインです。"
        : "Internationalized domains are not inherently dangerous. In this scene, the domain differs from the verified one.",
    ),
  );
  return details;
}
export function updateIdnFonts() {
  for (const panel of document.querySelectorAll(".idn-explanation")) {
    const source = document.getElementById(panel.dataset.fontSource);
    if (!source) continue;
    const style = getComputedStyle(source);
    for (const glyph of panel.querySelectorAll(".idn-glyph, .idn-domains dd")) {
      glyph.style.fontFamily = style.fontFamily;
      glyph.style.fontWeight = style.fontWeight;
      glyph.style.fontStyle = style.fontStyle;
    }
    panel.querySelector(".idn-font-info").textContent =
      document.documentElement.lang === "ja"
        ? `このメールの表示指定：${style.fontFamily}。上の文字も同じ指定で拡大しています。実際に使われる書体は端末の対応状況で変わり、この画面では特定できません。`
        : `This email requests: ${style.fontFamily}. The enlarged characters use that same setting. The actual font can vary with device support and cannot be identified by this page.`;
  }
}
