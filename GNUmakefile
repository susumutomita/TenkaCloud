# GNU make loads this file before Makefile. Keep the existing Makefile as the
# product build source of truth and add the polyrepo agent-control entry points.
include Makefile

SYMPHONY_ARGS ?=

.PHONY: agent-gate symphony-validate symphony-print symphony-run

# The autonomous completion contract is the full local CI mirror plus validation
# of all Symphony workflow safety and isolation invariants.
agent-gate: ci-local symphony-validate

symphony-validate:
	bun run symphony:fleet validate $(SYMPHONY_ARGS)

symphony-print:
	bun run symphony:fleet print $(SYMPHONY_ARGS)

symphony-run:
	bun run symphony:fleet run $(SYMPHONY_ARGS)
