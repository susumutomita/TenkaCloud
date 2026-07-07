import { HOME_COPY } from "@/content/site-copy";
import { catalogCounts } from "@/lib/catalog";
import { htmlLang, type Locale, otherLocale } from "@/lib/i18n";
import {
  CONTACT_FORM,
  catalogPath,
  GITHUB_DISCUSSIONS,
  GITHUB_REPO,
  homePath,
  legalPath,
  privacyPath,
  termsPath,
} from "@/lib/links";
import { BrandMark } from "./BrandMark";
import { LanguageSwitch } from "./LanguageSwitch";

// The marketing home (ADR-0003 §5: "/" marketing, static). Japanese renders at "/",
// English at "/en/". Both render from HOME_COPY[locale] so the two language versions
// are structurally identical. External links (OSS repo, contact form) carry a
// data-cta so navigation measurement can tell them apart without reading any content.
export function MarketingHome({ locale }: { locale: Locale }) {
  const copy = HOME_COPY[locale];
  const counts = catalogCounts();
  const other = otherLocale(locale);

  const catalogLead = copy.catalog.lead
    .replace("{total}", String(counts.total))
    .replace("{battle}", String(counts.readyBattle))
    .replace("{challenge}", String(counts.readyChallenge));

  return (
    <div lang={htmlLang(locale)}>
      <section className="hero marketing-hero">
        <div className="marketing-hero__topline">
          <BrandMark size={40} className="marketing-hero__mark" />
          <LanguageSwitch
            ariaLabel={copy.langSwitch.ariaLabel}
            otherHref={homePath(other)}
            otherLabel={copy.langSwitch.toOther}
          />
        </div>
        <span className="marketing-badge">{copy.hero.badge}</span>
        <h1>
          {copy.hero.titleLead}
          <em className="marketing-hero__em">{copy.hero.titleEm}</em>
        </h1>
        <p>{copy.hero.sub}</p>
        <div className="hero__actions">
          <a className="btn" data-cta="home-catalog" href={catalogPath(locale)}>
            {copy.hero.ctaCatalog}
          </a>
          <a className="btn btn--secondary" data-cta="home-developers" href="/developers/">
            {copy.hero.ctaDevelopers}
          </a>
          <a
            className="btn btn--ghost"
            data-cta="home-oss"
            href={GITHUB_REPO}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.hero.ctaOss}
          </a>
        </div>
        <p className="marketing-hero__trust">{copy.hero.trust}</p>
      </section>

      <section className="marketing-section marketing-section--alt">
        <div className="marketing-wrap">
          <p className="marketing-eyebrow">{copy.modes.eyebrow}</p>
          <h2>{copy.modes.heading}</h2>
          <p className="marketing-lead">{copy.modes.lead}</p>
          <div className="marketing-twoup">
            <article className="marketing-tile">
              <h3 className="marketing-kicker">{copy.modes.battle.kicker}</h3>
              <p>{copy.modes.battle.body}</p>
            </article>
            <article className="marketing-tile">
              <h3 className="marketing-kicker">{copy.modes.challenge.kicker}</h3>
              <p>{copy.modes.challenge.body}</p>
            </article>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-wrap">
          <p className="marketing-eyebrow">{copy.audiences.eyebrow}</p>
          <h2>{copy.audiences.heading}</h2>
          <p className="marketing-lead">{copy.audiences.lead}</p>
          <div className="marketing-grid-3">
            {copy.audiences.items.map((item) => (
              <article className="marketing-card" key={item.role}>
                <p className="marketing-role">{item.role}</p>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section marketing-section--alt">
        <div className="marketing-wrap">
          <p className="marketing-eyebrow">{copy.onboarding.eyebrow}</p>
          <h2>{copy.onboarding.heading}</h2>
          <p className="marketing-lead">{copy.onboarding.lead}</p>
          <ol className="marketing-steps">
            {copy.onboarding.steps.map((step, index) => (
              <li className="marketing-step" key={step.title}>
                <span className="marketing-step__n">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-wrap">
          <p className="marketing-eyebrow">{copy.security.eyebrow}</p>
          <h2>{copy.security.heading}</h2>
          <ul className="marketing-bullets">
            {copy.security.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="marketing-section marketing-section--alt">
        <div className="marketing-wrap">
          <p className="marketing-eyebrow">{copy.catalog.eyebrow}</p>
          <h2>{copy.catalog.heading}</h2>
          <p className="marketing-lead">{catalogLead}</p>
          <a className="btn" data-cta="home-catalog-section" href={catalogPath(locale)}>
            {copy.catalog.cta}
          </a>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-wrap">
          <p className="marketing-eyebrow">{copy.offerings.eyebrow}</p>
          <h2>{copy.offerings.heading}</h2>
          <p className="marketing-lead">{copy.offerings.lead}</p>
          <div className="marketing-grid-3">
            {copy.offerings.tiers.map((tier) => (
              <article className="marketing-pricing" key={tier.tier}>
                <p className="marketing-role">{tier.tier}</p>
                <p className="marketing-price">
                  {tier.price}
                  <span className="marketing-price__unit">{tier.unit}</span>
                </p>
                <p className="marketing-scope">{tier.scope}</p>
                <p>{tier.note}</p>
                <ul className="marketing-features">
                  {tier.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <p className="marketing-fineprint">{tier.fineprint}</p>
                <a
                  className="btn btn--secondary"
                  data-cta="home-quote"
                  href={CONTACT_FORM}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tier.cta}
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section marketing-section--alt">
        <div className="marketing-wrap marketing-contact">
          <p className="marketing-eyebrow">{copy.contact.eyebrow}</p>
          <h2>{copy.contact.heading}</h2>
          <p className="marketing-lead">{copy.contact.body}</p>
          <div className="hero__actions">
            <a
              className="btn"
              data-cta="home-contact-form"
              href={CONTACT_FORM}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy.contact.formCta}
            </a>
            <a
              className="btn btn--secondary"
              data-cta="home-discussions"
              href={GITHUB_DISCUSSIONS}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy.contact.discussionsCta}
            </a>
          </div>
          <p className="marketing-fineprint">{copy.contact.fineprint}</p>
          <p className="marketing-legal-line">
            <a href={privacyPath(locale)}>{copy.legalLine.split(" / ")[0]}</a>
            {" / "}
            <a href={termsPath(locale)}>{copy.legalLine.split(" / ")[1]}</a>
            {" / "}
            <a href={legalPath(locale)}>{copy.legalLine.split(" / ")[2]}</a>
          </p>
        </div>
      </section>
    </div>
  );
}
