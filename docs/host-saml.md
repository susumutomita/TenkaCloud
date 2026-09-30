# SAML sign-in for a competition host

SAML signs an existing organizer into the host console with that user's current
Admin, Operator or Viewer role. It is disabled by default. Configure it after
creating the first local-password Admin and the other organizer users.

## Configure the identity provider

1. Sign in as an Admin and open **Settings**.
2. Copy the displayed `SP Entity ID` and **ACS URL** into the identity provider.
   Use HTTP-Redirect for authentication requests and HTTP-POST for responses.
3. Configure the provider to sign both the response and its assertion, using an
   RSA key of at least 2048 bits and SHA-256 or SHA-512. Use a persistent NameID.
4. Enter the provider's `Entity ID`, sign-in URL and public PEM signing certificate
   in the host settings, then choose **Save IdP settings**. The sign-in URL must
   use HTTPS; HTTP is accepted only for a loopback test provider.
5. Choose an existing organizer, enter that user's persistent NameID, and choose
   **Link NameID**. The provider issuer and subject must match exactly.
6. Enable the **saml** flag. The login page now offers **Sign in with SAML**.

Use the host's fixed advertised HTTPS origin behind a TLS proxy. Its SP identifier
and ACS URL must match the provider configuration. The proxy must retain the
original Host header, as described in [local hosting](local-hosting.md).
The metadata URL is the displayed SP identifier; it is served while SAML is enabled.

SAML attributes do not create users, match email addresses or assign roles.
An Admin assigns roles through the organizer user screen. Encrypted assertions,
IdP-initiated sign-in and SAML single logout are not supported. Signing out of
this host revokes its issued credentials; it does not sign the user out of the provider.

## Sessions and revocation

Sign-in begins in the host console and is bound to that browser tab. A request
expires after five minutes. The signed response must match its request,
provider, audience, destination and recipient. The browser then exchanges a
short-lived, single-use receipt for the normal host authentication tokens. A response or
receipt cannot be reused after restarting the host.

Organizer sessions have an eight-hour absolute lifetime and a fifteen-minute
idle limit. Every API call checks the current user, identity and role. Disabling
or deleting the user, changing their password or role, or unlinking their SAML
identity invalidates the affected sessions.

Turning SAML off or saving provider settings invalidates existing SAML sessions
and unfinished sign-ins. Turning it back on does not revive them. Local-password
sessions continue to work. At least one active local-password Admin must remain;
the original host key does not reopen account setup after bootstrap.

Accepted event operations continue after the actor signs out or loses access. They remain host-owned deployment and cleanup work.

## Durable state and diagnostics

Request correlation, replay protection and receipts are stored in the host's
private SQLite database even when audit logging is off. They are authentication
state. Responses, assertions, browser proofs and tickets are not written to
application logs. Public configuration exposes only whether SAML sign-in is
available.

Back up the entire private data directory after stopping the host. Retain its
database and host key together. Restoring only selected authentication tables can
break relationships between identities and sessions. There is no automatic account or SAML
configuration migration from a separate SaaS or Lite deployment.

## Verification

The normal hosting tests cover signed responses, invalid signatures and targets,
concurrent replay, browser proofs, role checks, revocation and SQLite restart:

```sh
bun run test:host
```

The browser rehearsal uses the built console and the production HTTP/SQLite
wiring. It configures a generated test identity provider through the UI, signs a
Viewer in through an actual cross-site form POST, and turns SAML off to verify
revocation:

```sh
bun run test:host:saml
```

This command uses an installed Chromium and a loopback test provider. It does
not contact a real IdP or AWS. Provider-specific configuration and a production
HTTPS proxy can be checked during an optional event rehearsal.
