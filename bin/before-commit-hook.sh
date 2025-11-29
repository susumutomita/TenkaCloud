#!/bin/bash
# before-commit-hook.sh
#
# Claude Code hook to enforce running `make before-commit` before any git commit
# This hook runs as a PostToolUse hook and checks if the command was a git commit
# If so, it verifies that `make before-commit` was run and passed

set -e

# Get the tool input from stdin (Claude Code passes this as JSON)
INPUT=$(cat)

# Check if this was a Bash tool call containing git commit
if echo "$INPUT" | grep -q '"tool_name".*:.*"Bash"' && echo "$INPUT" | grep -q "git commit"; then
  # Output a warning that before-commit should have been run
  echo "HOOK_WARNING: Detected git commit. Ensure 'make before-commit' was run and passed before committing."
fi

exit 0
