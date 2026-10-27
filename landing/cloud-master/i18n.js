import { EN_UI } from "./locales/en-ui.js?v=8beafb0e72";
export const LOCALE_KEY = "tenkacloud.api-watch.locale.v1";
export function chooseLocale({ saved, requested, languages = [], legacyRecord = false } = {}) {
  if (["ja", "en"].includes(requested)) return requested;
  if (["ja", "en"].includes(saved)) return saved;
  if (legacyRecord) return "ja";
  return languages[0]?.toLowerCase().startsWith("en") ? "en" : "ja";
}
function initialLocale() {
  let saved,
    legacyRecord = false,
    requested;
  try {
    saved = globalThis.localStorage?.getItem(LOCALE_KEY);
    legacyRecord =
      globalThis.localStorage?.getItem("tenkacloud.api-watch.best.v1") !== null &&
      globalThis.localStorage !== undefined;
  } catch {}
  try {
    requested = new URLSearchParams(globalThis.location?.search).get("lang");
  } catch {}
  return chooseLocale({
    saved,
    requested,
    legacyRecord,
    languages: globalThis.navigator?.languages ?? [],
  });
}
let locale = initialLocale();
export const getLocale = () => locale;
export function setLocale(next) {
  if (!["ja", "en"].includes(next)) throw new Error("Unsupported language");
  locale = next;
  try {
    globalThis.localStorage?.setItem(LOCALE_KEY, next);
  } catch {}
}
export function tr(key, args = {}, language = locale) {
  const template = language === "ja" ? key : EN_UI[key];
  if (template === undefined) throw new Error(`Missing English UI message: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (args[name] === undefined) throw new Error(`Missing message value: ${name}`);
    return String(args[name]);
  });
}
const counters = Object.fromEntries(
  ["ja", "en"].map((language) => [
    language,
    new Intl.NumberFormat(language, { useGrouping: false, maximumFractionDigits: 0 }),
  ]),
);
export const formatCount = (number, language = locale) => counters[language].format(number);
