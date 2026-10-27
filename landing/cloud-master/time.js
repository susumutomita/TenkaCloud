const formatters = Object.fromEntries(
  ["ja", "en"].map((locale) => [
    locale,
    new Intl.NumberFormat(locale, {
      useGrouping: false,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  ]),
);
export function formatSurvival(milliseconds, locale = "ja") {
  const value = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  return `${formatters[locale].format(Math.floor(value / 100) / 10)}${locale === "en" ? "s" : "秒"}`;
}
