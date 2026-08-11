import Script from "next/script";
import type { ReactNode } from "react";
import { HOME_COPY } from "@/content/site-copy";
import { catalogCounts } from "@/lib/catalog";
import { htmlLang, type Locale } from "@/lib/i18n";
import {
  CONTACT_FORM,
  catalogPath,
  GITHUB_DISCUSSIONS,
  GITHUB_REPO,
  legalPath,
  privacyPath,
  termsPath,
} from "@/lib/links";
import { LanguageSwitch } from "./LanguageSwitch";
import { BattlePreview, ChallengePreview, HeroDashboard, SsoPreview } from "./MarketingPreviews";

// The static marketing home renders Japanese at "/",
// English at "/en/". Both render from HOME_COPY[locale] so the two language versions
// are structurally identical. The visual design reproduces the legacy landing
// (landing/index.html) — ink palette, Inter/Noto type, the 墨流し ink-bg hero, and the
// section rhythm — while the copy stays the new bilingual content model. External
// links (OSS repo, contact form) carry a data-cta so navigation measurement can tell
// them apart without reading any content.

// Decorative step icons ported from the legacy landing onboarding section. Purely
// presentational (aria-hidden), one per onboarding step, matched by index.
const STEP_ICONS: readonly ReactNode[] = [
  <svg key="deploy" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
    <path
      d="M21 43H17a10 10 0 0 1 0-20 15 15 0 0 1 28-5 12 12 0 0 1 2 24h-5"
      fill="none"
      stroke="#a855f7"
      strokeWidth="3"
    />
    <path
      d="M32 48V29m0 0-8 8m8-8 8 8"
      fill="none"
      stroke="#22c55e"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>,
  <svg key="lock" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
    <circle cx="32" cy="23" r="10" fill="none" stroke="#22c55e" strokeWidth="4" />
    <path
      d="M15 53c3-11 10-17 17-17s14 6 17 17"
      fill="none"
      stroke="#07111f"
      strokeWidth="3"
      strokeLinecap="round"
    />
    <circle cx="32" cy="23" r="16" fill="none" stroke="#a855f7" strokeWidth="2" opacity=".45" />
  </svg>,
  <svg key="portal" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
    <rect
      x="12"
      y="14"
      width="40"
      height="31"
      rx="3"
      fill="none"
      stroke="#07111f"
      strokeWidth="3"
    />
    <path d="M20 50h24" stroke="#07111f" strokeWidth="3" strokeLinecap="round" />
    <circle cx="32" cy="30" r="8" fill="none" stroke="#2563eb" strokeWidth="3" />
  </svg>,
];

export function MarketingHome({ locale }: { locale: Locale }) {
  const copy = HOME_COPY[locale];
  const counts = catalogCounts();

  const catalogLead = copy.catalog.lead
    .replace("{total}", String(counts.total))
    .replace("{battle}", String(counts.readyBattle))
    .replace("{challenge}", String(counts.readyChallenge));

  const [privacyLabel, termsLabel, legalLabel] = copy.legalLine.split(" / ");

  return (
    <div className="landing" lang={htmlLang(locale)}>
      <section className="hero">
        {/* Decorative 墨流し ink-marbling backdrop, painted by public/ink-bg.js
            (queries the `.ink-bg` canvas). The aria-hidden wrapper keeps the
            purely-decorative canvas out of the accessibility tree. */}
        <div className="ink-bg-layer" aria-hidden="true">
          <canvas className="ink-bg" />
        </div>
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <div className="hero-topline">
              <span className="pill">{copy.hero.badge}</span>
              <LanguageSwitch
                ariaLabel={copy.langSwitch.ariaLabel}
                otherHref={locale === "ja" ? "/en/" : "/"}
                otherLabel={copy.langSwitch.toOther}
              />
            </div>
            <h1>
              {copy.hero.titleLead}
              <em>{copy.hero.titleEm}</em>
            </h1>
            <p className="sub">{copy.hero.sub}</p>
            <div className="cta-row">
              <a className="cta-primary" data-cta="home-catalog" href={catalogPath(locale)}>
                {copy.hero.ctaCatalog}
              </a>
              <a data-cta="home-demo" href="/product/">
                {copy.hero.ctaDemo}
              </a>
              <a data-cta="home-developers" href="/developers/">
                {copy.hero.ctaDevelopers}
              </a>
              <a data-cta="home-oss" href={GITHUB_REPO} target="_blank" rel="noopener noreferrer">
                {copy.hero.ctaOss}
              </a>
            </div>
            <p className="hero-trust">{copy.hero.trust}</p>
          </div>
          <div className="hero-visual">
            <HeroDashboard locale={locale} />
          </div>
        </div>
      </section>

      <section className="alt" id="modes">
        <div className="wrap">
          <div className="eyebrow">{copy.modes.eyebrow}</div>
          <h2>{copy.modes.heading}</h2>
          <p className="lead">{copy.modes.lead}</p>
          <div className="twoup">
            <article className="tile">
              <h3 className="kicker">{copy.modes.battle.kicker}</h3>
              <p>{copy.modes.battle.body}</p>
              <div className="demo">
                <BattlePreview locale={locale} />
              </div>
            </article>
            <article className="tile">
              <h3 className="kicker">{copy.modes.challenge.kicker}</h3>
              <p>{copy.modes.challenge.body}</p>
              <div className="demo">
                <ChallengePreview locale={locale} />
              </div>
            </article>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap audience-intro">
          <div className="eyebrow">{copy.audiences.eyebrow}</div>
          <h2>{copy.audiences.heading}</h2>
          <p className="lead">{copy.audiences.lead}</p>
        </div>
        <div className="aud">
          {copy.audiences.items.map((item) => (
            <div className="col" key={item.role}>
              <div className="role">{item.role}</div>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="alt" id="onboard">
        <div className="wrap">
          <div className="onboard-layout">
            <div>
              <div className="eyebrow">{copy.onboarding.eyebrow}</div>
              <h2>{copy.onboarding.heading}</h2>
              <p className="lead">{copy.onboarding.lead}</p>
            </div>
            <div className="steps">
              {copy.onboarding.steps.map((step, index) => (
                <div className="step" key={step.title}>
                  <div className="n">{String(index + 1).padStart(2, "0")}</div>
                  <h4>{step.title}</h4>
                  <p>{step.body}</p>
                  <div className="step-icon">{STEP_ICONS[index]}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <div className="trust">
            <div className="copy">
              <div className="eyebrow">{copy.security.eyebrow}</div>
              <h2>{copy.security.heading}</h2>
              <ul>
                {copy.security.bullets.map((bullet) => (
                  <li key={bullet}>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
            <SsoPreview locale={locale} />
          </div>
        </div>
      </section>

      <section className="alt">
        <div className="wrap audience-intro">
          <div className="eyebrow">{copy.catalog.eyebrow}</div>
          <h2>{copy.catalog.heading}</h2>
          <p className="lead">{catalogLead}</p>
          <div className="extend-cta">
            <a className="cta-primary" data-cta="home-catalog-section" href={catalogPath(locale)}>
              {copy.catalog.cta}
            </a>
          </div>
        </div>
      </section>

      <section id="offerings">
        <div className="wrap">
          <div className="pricing-head">
            <div className="eyebrow">{copy.offerings.eyebrow}</div>
            <h2>{copy.offerings.heading}</h2>
            <p>{copy.offerings.lead}</p>
          </div>
          <div className="pricing-grid">
            {copy.offerings.tiers.map((tier, index) => (
              <div
                className={index === 1 ? "pricing-card featured" : "pricing-card"}
                key={tier.tier}
              >
                <div className="pricing-tier">{tier.tier}</div>
                <div className="pricing-price">
                  {tier.price}
                  <span className="pricing-unit">{tier.unit}</span>
                </div>
                <div className="pricing-scope">{tier.scope}</div>
                <p className="pricing-sub">{tier.note}</p>
                <ul className="pricing-list">
                  {tier.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <p className="pricing-fineprint">{tier.fineprint}</p>
                <a
                  className={index === 1 ? "pricing-cta primary" : "pricing-cta secondary"}
                  data-cta="home-quote"
                  href={CONTACT_FORM}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tier.cta}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="contact">
        <div className="wrap">
          <div className="ent-cta">
            <div className="eyebrow">{copy.contact.eyebrow}</div>
            <h2>{copy.contact.heading}</h2>
            <p>{copy.contact.body}</p>
            <div className="btns">
              <a
                className="btn-primary"
                data-cta="home-contact-form"
                href={CONTACT_FORM}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.contact.formCta}
              </a>
              <a
                className="btn-ghost"
                data-cta="home-discussions"
                href={GITHUB_DISCUSSIONS}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.contact.discussionsCta}
              </a>
            </div>
            <p className="contact-fineprint">{copy.contact.fineprint}</p>
            <p className="contact-legal">
              <a href={privacyPath(locale)}>{privacyLabel}</a>
              {" / "}
              <a href={termsPath(locale)}>{termsLabel}</a>
              {" / "}
              <a href={legalPath(locale)}>{legalLabel}</a>
            </p>
          </div>
        </div>
      </section>

      <Script src="/ink-bg.js" strategy="afterInteractive" />
    </div>
  );
}
