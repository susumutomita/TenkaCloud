import { tr } from "./i18n.js?v=7243e23fd2";

// Same destination and automatic-measurement scope as the top LP. Keep analytics
// independent of game startup; the existing locale supplies the standard title.
window.dataLayer = window.dataLayer || [];
window.gtag =
  window.gtag ||
  ((...args) => {
    window.dataLayer.push(args);
  });
window.gtag("js", new Date());
window.gtag("config", "G-6WQ914PCKT", {
  page_title: tr("APIの番人。 | 目指せクラウドマスター"),
  page_location: location.href,
});
