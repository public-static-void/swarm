---
name: committer-cleanup
description: "Final commit + push: full commit workflow including push to remote."
---

# Committer Cleanup

## Overview

CLEANUP mode commits any remaining changes and pushes to the remote. This mode handles final commits and push to remote.

## When to Load

Load this skill when dispatched in CLEANUP mode by the Overseer (Phase 11 — commit and push).

## Commit Protocol

1. **Create TODO checklist** — `todowrite` for each commit group. Prevents mixing unrelated changes.

2. **Verify working branch** — Run `git branch --show-current`. If the branch is `develop`/`main`/`master`/`staging` (shared integration branch), load the escalation-protocol skill and escalate via ESCALATION format; otherwise proceed.

3. **Survey repo** — `git log --oneline -30`. Filter out non-representative commits (merge commits, reverts, automated, initial commits). Analyze language, scope usage (`type(scope):` consistency), style (imperative present tense, capitalization, period). If fewer than 3 representative commits, fall back to: English, conventional commits with scope, imperative present tense. Subject line omits trailing period.

4. **Classify changes (lightweight)** — `git status --porcelain` for the changed-file list and state, `git diff --stat` for the file-level change overview, and `git diff --name-only` for the changed-file names. Classify each changed file by type (feat/fix/refactor/docs/test/chore) from names and stats. Group from names and stats; read full diff content per batch at stage time.

5. **Group into batches** — Split by module/scope:
   - One module/scope per batch; one type per batch where possible
   - If a module has changes of same type, batch together
   - If changes span multiple modules, separate batches per module
   - A batch is ready when it forms a coherent, independently verifiable change set
   - Mixed types in one file: classify by dominant type (majority of lines changed). If roughly equal, flag to split across files if possible; otherwise classify by primary intent.
   - feat + refactor in same file: classify as feat with refactor note in body. Split when refactor exceeds 50% of changed lines.

6. **Check gitignore** — Before staging, `git status --porcelain`. Verify `.gitignore` coverage for the files this task changed. Stage all tracked files changed by the task. If any gitignored file appears staged, unstage it immediately. Silently skip ignored files; report which files were skipped if relevant.

7. **Edge cases**:
   - **Empty commit**: If the filtered set is empty, report "no changes to commit" and exit cleanly.
   - **Ambiguity**: If change fits multiple types, classify by dominant change. If still ambiguous, inspect the ambiguous file via `git diff -- <file>`. Commit when a legitimate type is determinable. If truly unable, report back to the dispatching agent for guidance.
   - **Uncertainty**: If unresolvable, report back to dispatching agent.

8. **Enforce commit conventions** — All commits MUST use:
   - Match the language of representative commits over the system locale
   - Same scope format (if ≥80% use `type(scope):`, you MUST include scope)
   - Imperative present tense
   - Subject line omits trailing period
   - Subject line ≤72 characters
   - **Commit message format**: `<type>(<scope>): <description>`
     - **type**: `feat`, `fix`, `chore`, `refactor`, `docs`, or `test`
     - **scope**: the component or module affected
     - **description**: what changed and why, from a user perspective — written as if telling a colleague who has not read the code, focusing on semantic meaning

9. **Stage** — Select one coherent group, verify clean working tree, review the batch's full content with `git diff -- <files>` limited to the batch's files, then `git add <files>`.

10. **Commit** — Check off TODO item, verify staged diff non-empty (`git diff --cached --stat`), write semantic message, `git commit -m "<type>(<scope>): <message>"`. Use `git commit` with all hooks and verification enabled.

11. **Verify** — `git show --stat -1` to confirm.

12. **Repeat** — Return to step 6 for remaining groups.

13. **Error handling** — On failure, `git reset --mixed` to recover.

## Post-Commit Verification

After all commit batches are complete and before pushing:

1. **Fetch remote refs** — Run `git fetch origin` to update all remote tracking refs
2. **Check divergence** — Run `git rev-list --count origin/<branch>..HEAD` to count local commits absent from the remote tracking branch. If the remote branch does not exist yet (first push), skip this check.
3. **Warn if ahead** — If the count is greater than 0, log a warning that the local branch has commits not on the remote. This may indicate push or PR merge is pending.

## Push Protocol

After verification passes:

1. **Re-verify working branch** — Run `git branch --show-current`. Verify the branch is a feature branch — a shared integration branch requires escalation: load the escalation-protocol skill and escalate via ESCALATION format.

2. **Push** — Push committed changes to the remote when (a) committed changes exist at lifecycle end, (b) a remote is configured, and (c) the current branch is a feature/fix/chore-style branch (not main/master). For the first push (no upstream tracking yet), run `git push -u origin <branch>`; for subsequent pushes, run `git push`. When the remote is absent or the push fails, report the issue back to the dispatching agent.

3. **Post-push alignment check** — After successful push, run `git fetch origin` and verify the remote branch is up to date by comparing `git rev-list --count HEAD..origin/<branch>`. If the count is greater than 0, log a warning that the remote branch is behind. If the remote branch does not exist yet (first push), skip the check. If fetch fails, report the issue back to the dispatching agent.

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

**Rules:** Scope required if ≥80% of representative commits use scope. Subject: imperative present tense, ≤72 chars, omits trailing period.

**Commit message format:** `<type>(<scope>): <description>`
- **type**: `feat`, `fix`, `chore`, `refactor`, `docs`, or `test`
- **scope**: the component or module affected
- **description**: what changed and why, from a user perspective — written as if telling a colleague who has not read the code, focusing on semantic meaning. The format defines the positive shape; internal tracking metadata is excluded because it is not part of the format.

## Exit

1. **Verify-output reporting discipline (issue #53)** — Before writing the CLEANUP KD, ground-truth verify every commit hash or artifact it reports: `git log`/`git show` for hashes (extends the step-11 `git show --stat -1` self-verification), `read`/`glob` from disk for files. Never write an unverified hash; a commit that could not be created is reported as "UNCOMMITTED" with the working-tree state. This reporting discipline complements — it does not replace — the per-commit self-verification steps.
2. **Write CLEANUP KD** — Write a CLEANUP KD at the `RESULT KD` path specified in the dispatch context using the `template-cleanup.md` template from the kd-system skill. The KD documents what was committed and pushed, and signals to the protocol-gate that the cleanup phase is complete.
3. Report what was committed and pushed.
