---
name: committer-cleanup
description: "Final commit + push: full commit workflow including push to remote."
---

# Committer Cleanup

## Overview

CLEANUP mode commits any remaining changes and pushes to the remote. This mode handles final commits and push to remote.

## When to Load

Load this skill when dispatched in CLEANUP mode by the Overseer (Phase 11 — commit and push). The dispatch context contains a summary of leftover work.

## Commit Protocol

1. **Create TODO checklist** — `todowrite` for each commit group. Prevents mixing unrelated changes.

2. **Survey repo** — `git log --oneline -30`. Filter out non-representative commits (merge commits, reverts, automated, initial commits). Analyze language, scope usage (`type(scope):` consistency), style (imperative present tense, capitalization, period). If fewer than 3 representative commits, fall back to: English, conventional commits with scope, imperative present tense. Subject line omits trailing period.

3. **Read impl KDs** — If `knowledge/impl-*.md` exists, read for batch boundary and commit message context.

4. **Analyze diff** — `git diff --stat` for file-level overview, then `git diff` for content. Classify each changed file by type (feat/fix/refactor/docs/test/chore).

5. **Group into batches** — Split by module/scope:
   - One module/scope per batch; one type per batch where possible
   - If a module has changes of same type, batch together
   - If changes span multiple modules, separate batches per module
   - A batch is ready when it forms a coherent, independently verifiable change set
   - Mixed types in one file: classify by dominant type (majority of lines changed). If roughly equal, flag to split across files if possible; otherwise classify by primary intent.
   - feat + refactor in same file: classify as feat with refactor note in body. Only split if refactor >50% of changed lines.

6. **Check gitignore** — Before staging, `git status --porcelain`. Verify `.gitignore` coverage. Confirm `knowledge/` is listed in `.gitignore` — if missing, report the gap and halt. Stage tracked files outside the `knowledge/` directory. If any knowledge files appear staged, unstage them immediately. Stage and commit all tracked files absent from `.gitignore`. Silently skip ignored files; report which files were skipped if relevant.

7. **Edge cases**:
   - **Empty commit**: If the filtered set is empty, report "no changes to commit" and exit cleanly.
   - **Ambiguity**: If change fits multiple types, classify by dominant change. If still ambiguous, check paths, diff, and impl KDs. Only commit if a legitimate type is determinable. If truly unable, report back to the dispatching agent for guidance.
   - **Uncertainty**: If unresolvable, report back to dispatching agent.

8. **Enforce commit conventions** — All commits MUST use:
   - Match the language of representative commits over the system locale
   - Same scope format (if ≥80% use `type(scope):`, you MUST include scope)
   - Imperative present tense
   - Subject line omits trailing period
   - Subject line ≤72 characters
   - **Internal references**: Describe code changes exclusively; omit internal references.

9. **Stage** — Select one coherent group, verify clean working tree, `git add <files>`.

10. **Commit** — Check off TODO item, verify staged diff non-empty, write semantic message, `git commit -m "<type>(<scope>): <message>"`. Use `git commit` with all hooks and verification enabled.

11. **Verify** — `git show --stat -1` to confirm.

12. **Repeat** — Return to step 5 for remaining groups.

13. **Error handling** — On failure, `git reset --mixed` to recover.

## Post-Commit Verification

After all commit batches are complete and before pushing:

1. **Fetch remote refs** — Run `git fetch origin` to update all remote tracking refs
2. **Check divergence** — Run `git rev-list --count origin/main..HEAD` to count local commits absent from `origin/main`
3. **Warn if ahead** — If the count is greater than 0, log a warning that the local branch has commits not on `origin/main`. This may indicate push or PR merge is pending.

## Push Protocol

After verification passes:

1. **Push** — Push to remote. Respect bash permissions: `git push*: ask` — request confirmation before pushing with `*` patterns. When remote is absent or push fails, report the issue back to the dispatching agent.

2. **Merge (optional)** — If merging is needed, `git merge*: ask` — request confirmation before merging.

3. **Post-push alignment check** — After successful push, run `git fetch origin` and verify `origin/main` is reachable from the current branch's base. If divergence is detected, log a warning and report the gap to the dispatching agent.

## Semantic Commit Convention

| Type     | Usage                  |
| -------- | ---------------------- |
| feat     | New feature            |
| fix      | Bug fix                |
| docs     | Documentation          |
| style    | Formatting             |
| refactor | Internal restructuring |
| test     | Add/modify tests       |
| chore    | Build/tooling          |
| ci       | CI/CD                  |

**Rules:** Scope required if ≥80% of representative commits use scope. Subject: imperative present tense, ≤72 chars, omits trailing period. Commit messages describe code changes exclusively.

## Exit

Report what was committed, merged, and pushed.
