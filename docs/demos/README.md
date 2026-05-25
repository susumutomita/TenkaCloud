# TenkaCloud demo scripts

> 日本語版: [README.ja.md](./README.ja.md)

This folder collects narrated walkthroughs of TenkaCloud, designed for first-time visitors, sales conversations, and technical evaluators.

Pick the script that matches your audience and time budget.

| Script                                                          | Audience                                | Length | Goal                                                          |
| --------------------------------------------------------------- | --------------------------------------- | ------ | ------------------------------------------------------------- |
| [`quickstart-5min.md`](./quickstart-5min.md)                    | First-time visitor                      | 5 min  | Clone the repo, deploy Lite mode, run one event end-to-end.   |
| [`sales-pitch-15min.md`](./sales-pitch-15min.md)                | Sales / community organizer / pre-sales | 15 min | Same flow with talking points and pricing tier references.    |
| [`architecture-tour-30min.md`](./architecture-tour-30min.md)    | Technical evaluator / CCoE              | 30 min | 4-plane walkthrough with ADR cross-references and security.   |

All scripts share the same demo problem (`hello-world` Challenge) so you can rehearse one path and reuse the recording in multiple contexts.

## When to use which

- **Demo at a meetup or JAWS-UG LT** → 5-minute quickstart. Live deploy is risky in 5 minutes, so the script keeps a "show pre-deployed" fallback at every step.
- **Sales call with a buyer** → 15-minute pitch. Each step has a "pain → fit" talking point and a pricing tier hint.
- **CCoE / platform-team review** → 30-minute architecture tour. Walks through the four planes, the EventBridge contracts, ADR references, and the multi-cloud roadmap.

## Conventions

- Steps are numbered. Each step has an **estimated time**, the **action**, the **what just happened**, and a **fallback** if it breaks.
- Commands assume Lite mode (`make deploy`). SaaS mode is referenced but not the default path for a demo.
- ADR references use the form `ADR-NNN`, e.g. `ADR-012` for the problem plugin architecture. See [`docs/architecture/`](../architecture/).
- All claims are scoped to what TenkaCloud actually ships today. Avoid statements like "full SOC2" or "production-grade multi-cloud" — see [`ROADMAP.md`](../../ROADMAP.md) for what is in flight.

## Pre-demo checklist

Run this once before the talk:

```bash
git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git
cd TenkaCloud
make install
make before-commit          # sanity: lint + test pass
make deploy                  # Lite mode, ~10 min
```

Keep the AWS Console open on the target account in a second tab. If the live deploy fails, fall back to the screenshots referenced in each script.

## Related references

- [`docs/architecture/OVERVIEW.md`](../architecture/OVERVIEW.md) — 10-minute architecture overview
- [`CONTRIBUTOR_MAP.md`](../../CONTRIBUTOR_MAP.md) — recipe index for contributors
- [`problems/README.md`](../../problems/README.md) — problem authoring overview
- [`ROADMAP.md`](../../ROADMAP.md) — what is shipped vs in flight
