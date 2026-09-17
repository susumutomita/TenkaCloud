import Script from "next/script";
import { BUSINESS_HOME_COPY } from "@/content/home-business-copy";
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
import styles from "./MarketingHome.module.css";
import { BattlePreview, ChallengePreview, HeroDashboard, SsoPreview } from "./MarketingPreviews";

// The home page follows the order in which an enterprise buyer evaluates a new
// platform: problem -> value -> economics -> stakeholders -> use cases -> product
// experience -> operating model -> security -> commercial model. Technical details
// remain available, but they prove the business proposition instead of leading it.
export function MarketingHome({ locale }: { locale: Locale }) {
  const business = BUSINESS_HOME_COPY[locale];
  const product = HOME_COPY[locale];
  const counts = catalogCounts();

  const catalogLead = product.catalog.lead
    .replace("{total}", String(counts.total))
    .replace("{battle}", String(counts.readyBattle))
    .replace("{challenge}", String(counts.readyChallenge));

  const [privacyLabel, termsLabel, legalLabel] = product.legalLine.split(" / ");

  return (
    <div className="landing" lang={htmlLang(locale)}>
      <section className="hero">
        <div className="ink-bg-layer" aria-hidden="true">
          <canvas className="ink-bg" />
        </div>
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <div className="hero-topline">
              <span className="pill">{business.hero.badge}</span>
              <LanguageSwitch
                ariaLabel={product.langSwitch.ariaLabel}
                otherHref={locale === "ja" ? "/en/" : "/"}
                otherLabel={product.langSwitch.toOther}
              />
            </div>
            <h1>
              {business.hero.titleLead}
              <em>{business.hero.titleEm}</em>
            </h1>
            <p className="sub">{business.hero.sub}</p>
            <div className={styles.heroActions}>
              <a
                className={styles.heroActionPrimary}
                data-cta="home-enterprise-contact"
                href={CONTACT_FORM}
                target="_blank"
                rel="noopener noreferrer"
              >
                {business.hero.primaryCta}
              </a>
              <a className={styles.heroActionSecondary} data-cta="home-demo" href="/product/">
                {business.hero.secondaryCta}
              </a>
              <a
                className={styles.heroActionText}
                data-cta="home-catalog"
                href={catalogPath(locale)}
              >
                {business.hero.tertiaryCta}
              </a>
            </div>
            <ul
              className={styles.proofList}
              aria-label={locale === "ja" ? "導入条件" : "Adoption facts"}
            >
              {business.hero.proof.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="hero-visual">
            <HeroDashboard locale={locale} />
          </div>
        </div>
      </section>

      <section id="problem">
        <div className="wrap">
          <div className={styles.sectionIntro}>
            <div className="eyebrow">{business.problems.eyebrow}</div>
            <h2>{business.problems.heading}</h2>
            <p className={styles.sectionLead}>{business.problems.lead}</p>
          </div>
          <div className={styles.problemGrid}>
            {business.problems.items.map((item) => (
              <article className={styles.problemCard} key={item.label}>
                <span className={styles.cardLabel}>{item.label}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="alt" id="value">
        <div className="wrap">
          <div className={styles.sectionIntroCentered}>
            <div className="eyebrow">{business.transformation.eyebrow}</div>
            <h2>{business.transformation.heading}</h2>
            <p className={styles.sectionLead}>{business.transformation.lead}</p>
          </div>
          <div className={styles.transformationGrid}>
            <article className={styles.transformationCard}>
              <span className={styles.transformationLabel}>
                {business.transformation.before.label}
              </span>
              <h3>{business.transformation.before.title}</h3>
              <ul className={styles.transformationList}>
                {business.transformation.before.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
            <div className={styles.transformationArrow} aria-hidden="true">
              →
            </div>
            <article className={`${styles.transformationCard} ${styles.transformationCardAfter}`}>
              <span className={styles.transformationLabel}>
                {business.transformation.after.label}
              </span>
              <h3>{business.transformation.after.title}</h3>
              <ul className={styles.transformationList}>
                {business.transformation.after.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          </div>
          <p className={styles.transformationOutcome}>{business.transformation.outcome}</p>
        </div>
      </section>

      <section id="economics">
        <div className="wrap">
          <div className={styles.sectionIntroCentered}>
            <div className="eyebrow">{business.economics.eyebrow}</div>
            <h2>{business.economics.heading}</h2>
            <p className={styles.sectionLead}>{business.economics.lead}</p>
          </div>
          <div className={styles.metricGrid}>
            {business.economics.items.map((item) => (
              <article className={styles.metricCard} key={item.code}>
                <span className={styles.metricCode}>{item.code}</span>
                <h3>{item.label}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
          <p className={styles.economicsNote}>{business.economics.note}</p>
        </div>
      </section>

      <section className="alt" id="stakeholders">
        <div className="wrap">
          <div className={styles.sectionIntroCentered}>
            <div className="eyebrow">{business.stakeholders.eyebrow}</div>
            <h2>{business.stakeholders.heading}</h2>
            <p className={styles.sectionLead}>{business.stakeholders.lead}</p>
          </div>
          <div className={styles.stakeholderGrid}>
            {business.stakeholders.items.map((item) => (
              <article className={styles.stakeholderCard} key={item.role}>
                <span className={styles.stakeholderRole}>{item.role}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="use-cases">
        <div className="wrap">
          <div className={styles.sectionIntroCentered}>
            <div className="eyebrow">{business.useCases.eyebrow}</div>
            <h2>{business.useCases.heading}</h2>
            <p className={styles.sectionLead}>{business.useCases.lead}</p>
          </div>
          <div className={styles.useCaseGrid}>
            {business.useCases.items.map((item) => (
              <article className={styles.useCaseCard} key={item.label}>
                <span className={styles.cardLabel}>{item.label}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="alt" id="modes">
        <div className="wrap">
          <div className="eyebrow">{product.modes.eyebrow}</div>
          <h2>{product.modes.heading}</h2>
          <p className="lead">{product.modes.lead}</p>
          <div className="twoup">
            <article className="tile">
              <h3 className="kicker">{product.modes.battle.kicker}</h3>
              <p>{product.modes.battle.body}</p>
              <div className="demo">
                <BattlePreview locale={locale} />
              </div>
            </article>
            <article className="tile">
              <h3 className="kicker">{product.modes.challenge.kicker}</h3>
              <p>{product.modes.challenge.body}</p>
              <div className="demo">
                <ChallengePreview locale={locale} />
              </div>
            </article>
          </div>
        </div>
      </section>

      <section id="operations">
        <div className="wrap">
          <div className={styles.sectionIntroCentered}>
            <div className="eyebrow">{business.operations.eyebrow}</div>
            <h2>{business.operations.heading}</h2>
            <p className={styles.sectionLead}>{business.operations.lead}</p>
          </div>
          <div className={styles.operationGrid}>
            {business.operations.steps.map((step, index) => (
              <article className={styles.operationStep} key={step.title}>
                <div className={styles.operationNumber}>{String(index + 1).padStart(2, "0")}</div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="alt" id="security">
        <div className="wrap">
          <div className="trust">
            <div className="copy">
              <div className="eyebrow">{product.security.eyebrow}</div>
              <h2>{product.security.heading}</h2>
              <ul>
                {product.security.bullets.map((bullet) => (
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

      <section id="catalog">
        <div className="wrap audience-intro">
          <div className="eyebrow">{product.catalog.eyebrow}</div>
          <h2>{product.catalog.heading}</h2>
          <p className="lead">{catalogLead}</p>
          <div className="extend-cta">
            <a className="cta-primary" data-cta="home-catalog-section" href={catalogPath(locale)}>
              {product.catalog.cta}
            </a>
            <a className="cta-primary" data-cta="home-docs" href="/developers/">
              {product.hero.ctaDevelopers}
            </a>
            <a
              className="cta-primary"
              data-cta="home-oss"
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
            >
              {product.hero.ctaOss}
            </a>
          </div>
        </div>
      </section>

      <section className="alt" id="offerings">
        <div className="wrap">
          <div className="pricing-head">
            <div className="eyebrow">{product.offerings.eyebrow}</div>
            <h2>{product.offerings.heading}</h2>
            <p>{product.offerings.lead}</p>
          </div>
          <div className="pricing-grid">
            {product.offerings.tiers.map((tier, index) => (
              <article
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
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="contact">
        <div className="wrap">
          <div className="ent-cta">
            <div className="eyebrow">{product.contact.eyebrow}</div>
            <h2>{product.contact.heading}</h2>
            <p>{product.contact.body}</p>
            <div className="btns">
              <a
                className="btn-primary"
                data-cta="home-contact-form"
                href={CONTACT_FORM}
                target="_blank"
                rel="noopener noreferrer"
              >
                {product.contact.formCta}
              </a>
              <a
                className="btn-ghost"
                data-cta="home-discussions"
                href={GITHUB_DISCUSSIONS}
                target="_blank"
                rel="noopener noreferrer"
              >
                {product.contact.discussionsCta}
              </a>
            </div>
            <p className="contact-fineprint">{product.contact.fineprint}</p>
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
