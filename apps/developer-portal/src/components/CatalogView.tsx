import { CATALOG_COPY } from "@/content/site-copy";
import {
  CATEGORY_LABEL,
  catalogCounts,
  difficultyLabel,
  groupedCatalog,
  STATUS_LABEL,
} from "@/lib/catalog";
import { htmlLang, type Locale, otherLocale } from "@/lib/i18n";
import { CATALOG_REPO, catalogPath, homePath } from "@/lib/links";
import { LanguageSwitch } from "./LanguageSwitch";

// The public problem catalog (/catalog, /en/catalog). The problem DATA is generated
// from the problems/ submodule metadata (source of truth); this view is display
// only. `ready` problems are badged Available; `draft` problems are badged In
// development so nothing unverified is presented as playable.
export function CatalogView({ locale }: { locale: Locale }) {
  const copy = CATALOG_COPY[locale];
  const counts = catalogCounts();
  const groups = groupedCatalog();
  const other = otherLocale(locale);

  const lead = copy.lead
    .replace("{total}", String(counts.total))
    .replace("{ready}", String(counts.ready));

  return (
    // The outer .landing carries the legacy paper background full-bleed; the inner
    // .page is the centred content column (so dark-mode gutters never show through).
    <div className="landing landing--catalog" lang={htmlLang(locale)}>
      <div className="page">
        <div className="catalog-topline">
          <LanguageSwitch
            ariaLabel={copy.langSwitch.ariaLabel}
            otherHref={catalogPath(other)}
            otherLabel={copy.langSwitch.toOther}
          />
        </div>
        <h1>{copy.heading}</h1>
        <p className="marketing-lead">{lead}</p>
        <p className="catalog-legend">
          <span className="badge badge--stable">{STATUS_LABEL[locale].ready}</span>{" "}
          {copy.readyLegend}
          <br />
          <span className="badge badge--planned">{STATUS_LABEL[locale].draft}</span>{" "}
          {copy.draftLegend}
        </p>

        {groups.map((group) => (
          <section className="catalog-group" key={group.category}>
            <h2>
              {CATEGORY_LABEL[locale][group.category]}{" "}
              <span className="catalog-count">({group.problems.length})</span>
            </h2>
            <div className="catalog-grid">
              {group.problems.map((problem) => (
                <article className="catalog-card" key={problem.id}>
                  <div className="catalog-card__head">
                    <span
                      className={`badge ${problem.status === "ready" ? "badge--stable" : "badge--planned"}`}
                    >
                      {STATUS_LABEL[locale][problem.status]}
                    </span>
                    <span className="badge badge--preview">
                      {difficultyLabel(locale, problem.difficulty)}
                    </span>
                  </div>
                  <h3>{problem.name[locale]}</h3>
                  <code className="catalog-card__id">{problem.id}</code>
                  {problem.tags.length > 0 ? (
                    <ul className="catalog-tags" aria-label={copy.tagsLabel}>
                      {problem.tags.map((tag) => (
                        <li key={tag}>{tag}</li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))}

        <p className="catalog-source">{copy.sourceNote}</p>
        <div className="hero__actions">
          <a
            className="btn btn--secondary"
            href={CATALOG_REPO}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.authorCta}
          </a>
          <a className="btn btn--ghost" href={homePath(locale)}>
            {copy.homeCta}
          </a>
        </div>
      </div>
    </div>
  );
}
