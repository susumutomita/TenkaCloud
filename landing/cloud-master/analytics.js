import { tr } from "./i18n.js?v=3638284e92";

// Same destination and automatic-measurement scope as the top LP. Keep analytics
// independent of game startup; the existing locale supplies the standard title.
window.gtag("config", "G-6WQ914PCKT", { send_page_view: false });
// Event-scoped metadata avoids fixing the defaults of later automatic history events.
window.gtag("event", "page_view", {
  page_title: tr("APIの番人。 | 目指せクラウドマスター"),
  page_location: location.href,
});
