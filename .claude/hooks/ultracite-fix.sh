#!/usr/bin/env bash
# PostToolUse hook: runs `ultracite fix` on the file Claude just edited.
#
# Claude Code shows a PostToolUse hook's output to the agent only when the
# hook exits 2 and writes to stderr. `ultracite fix --hook` exits 1 and
# writes what it could not fix to stdout, so the agent would never see it.
# Pass the report on in the form Claude Code reads.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
# Before `pnpm install` there is nothing to run; CI still lints.
[ -x node_modules/.bin/ultracite ] || exit 0
if out=$(pnpm exec ultracite fix --hook 2>&1); then
    exit 0
fi
printf 'Lint problems left in the file you just edited (fix them, do not\nsilence them):\n%s\n' "$out" >&2
exit 2
