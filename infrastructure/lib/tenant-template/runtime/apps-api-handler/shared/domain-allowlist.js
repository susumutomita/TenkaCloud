/**
 * メールドメイン allowlist の正規化と検証。
 *
 * memory のルール:
 *   - 「招待はドメイン allowlist で必ずフィルタ」
 *   - 「空配列は全拒否」(InvitationService の二重安全弁)
 *
 * apps-service が POST /apps の input を validate するとき、broker-saml-service が
 * guestEmails を invitation に渡す直前にも同じ check を通す (二重安全弁)。
 */

class DomainAllowlistError extends Error {}

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeDomainList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[,\s]+/);
  return Array.from(new Set(raw.map(normalizeDomain).filter((d) => d.length > 0)));
}

const VALID_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function assertValidDomains(domains) {
  if (domains.length === 0) {
    throw new DomainAllowlistError("allowedEmailDomains は最低 1 つ必要です (空配列は全拒否)");
  }
  const invalid = domains.filter((d) => !VALID_DOMAIN_RE.test(d));
  if (invalid.length > 0) {
    throw new DomainAllowlistError(`invalid domain format: ${invalid.join(", ")}`);
  }
}

function emailDomain(email) {
  return normalizeDomain(String(email).split("@")[1] || "");
}

function assertEmailsInAllowlist(emails, allowedDomains) {
  if (emails.length === 0) return;
  if (allowedDomains.length === 0) {
    throw new DomainAllowlistError(
      "allowedEmailDomains が空のため guestEmails を受け付けられません",
    );
  }
  const allowed = new Set(allowedDomains);
  const violations = emails.filter((email) => !allowed.has(emailDomain(email)));
  if (violations.length > 0) {
    throw new DomainAllowlistError(
      `guestEmails が allowedEmailDomains に含まれません: ${violations.join(", ")}`,
    );
  }
}

module.exports = {
  DomainAllowlistError,
  normalizeDomainList,
  assertValidDomains,
  assertEmailsInAllowlist,
  emailDomain,
};
