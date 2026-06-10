# Project provenance and independence

This document records the development provenance of TenkaCloud and the
boundaries that keep it an independent open-source project. It is written in
factual, neutral language. It is a good-faith attestation by the author about
how the project was built — not a legal opinion, an audit certificate, or an
absolute guarantee.

## Independent implementation

- TenkaCloud was implemented independently in this repository. The Git history
  is incremental and public: it began from an empty project skeleton and grew
  through publicly documented reference architectures and repeated redesigns.
- The project is released under the [Apache License 2.0](../LICENSE).
- It builds on public AWS reference material, which is acknowledged in the
  codebase and documentation:
  - the AWS SaaS Builder Toolkit, [`@cdklabs/sbt-aws`](https://github.com/awslabs/sbt-aws);
  - the AWS [SaaS Factory Serverless SaaS reference architecture](https://github.com/aws-samples/aws-saas-factory-ref-solution-serverless-saas);
  - general AWS service documentation and public sample patterns.

## Relationship to prior professional experience

The author previously worked in a role where cloud-competition events were run.
The following boundary applies:

- An early product hypothesis explored compatibility with an existing
  cloud-competition problem format. After the author left that role and no
  longer had access to that code or its non-public formats, the compatibility
  approach was dropped.
- The current problem model and problem content were rebuilt from scratch.
- Scenarios such as `Microservice Migration` and `Security Battle Royale`
  recreate high-level learning themes and general scenario structures (for
  example, AWS GameDay-style incident response), not any specific proprietary
  content.

## Influence versus copying

This project distinguishes two categories that are easy to conflate:

- **Influence (used):** ideas, learning goals, general scenario patterns, and
  the author's own general professional experience and skills. These inform the
  design and are not owned by any single employer.
- **Copying (not intentionally included):** verbatim text, source code, design
  assets, scoring logic, or non-public specifications belonging to a third party
  or a former employer. No employer source code, confidential documents, private
  challenge content, customer data, or proprietary assets are intentionally
  included in this repository.

If anyone identifies material they believe crosses from the first category into
the second, please open an issue so it can be reviewed and corrected.

## No affiliation or endorsement

- TenkaCloud is not sponsored by, affiliated with, or endorsed by the author's
  employer (current or former).
- It is not affiliated with, endorsed by, or officially compatible with any
  specific cloud-competition event or company. Names of such events or companies,
  where they appear, are used only to describe general learning themes or for
  factual comparison.
- Third-party product names and trademarks (for example, AWS and AWS service
  names) remain the property of their respective owners and are used only for
  identification.

## Contributor expectation

Contributors must not add an employer's source code, confidential documents,
customer data, private competition content, or other proprietary assets.
Contribute only original work or material under a compatible license, and
attribute public references where practical. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution workflow.

## Scope of this document

- It does not rewrite or squash existing Git history.
- It does not provide a legal opinion or make an absolute legal conclusion.
- It does not describe any confidential employment policy or internal project.
