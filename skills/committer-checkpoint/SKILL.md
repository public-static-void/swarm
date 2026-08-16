---
name: committer-checkpoint
description: "Commit workflow: stage, semantic commit message from git log analysis, commit."
---

# Committer Checkpoint

## Overview

CHECKPOINT mode commits changes during active development. It analyzes diffs, groups changes into coherent commit batches, and creates semantic commits. This mode handles commits exclusively.

## When to Load

Load this skill when dispatched in CHECKPOINT mode by an Artisan with a change summary.

## Protocol

1. **Create TODO checklist** — `todowrite` for each commit group. Prevents mixing unrelated changes.

2. **Survey repo** — `git log --oneline -30`. Filter out non-representative commits (merge commits, reverts, automated, initial commits). Analyze language, scope usage (`type(scope):` consistency), style (imperative present tense, capitalization, period). If fewer than 3 representative commits, fall back to: English, conventional commits with scope, imperative present tense. Subject line omits trailing period.

3. **Classify changes (lightweight)** — `git status --porcelain` for the changed-file list and state, `git diff --stat` for the file-level change overview, and `git diff --name-only` for the changed-file names. Classify each changed file by type (feat/fix/refactor/docs/test/chore) from names and stats. Group from names and stats; read full diff content per batch at stage time.

4. **Group into batches** — Split by module/scope and functional concern:
   - One module/scope per batch; one type per batch where possible
   - Each batch MUST address exactly one coherent functional concern. If changes in the same module address different concerns (e.g., "add login validation" and "fix password hashing"), split into separate batches even if both are `feat` in `src/auth/`.
   - A batch is a coherent, independently verifiable change set. Before creating a batch, verify: "Can this change stand alone without the other changes?"
   - If changes span multiple modules, separate batches per module
   - Mixed types in one file: classify by dominant type (majority of lines changed). If roughly equal, flag to split across files if possible; otherwise classify by primary intent.
   - If a single file's changes cross multiple concerns, classify by dominant concern. If roughly equal, flag for potential file-level split.
   - feat + refactor in same file: classify as feat with refactor note in body. Split when refactor exceeds 50% of changed lines.

5. **Check gitignore** — Before staging, `git status --porcelain`. Verify `.gitignore` coverage for the files this task changed. Stage all tracked files changed by the task. If any gitignored file appears staged, unstage it immediately. Silently skip ignored files; report which files were skipped if relevant.

6. **Edge cases**:
   - **Empty commit**: If the filtered set is empty, report "no changes to commit" and exit cleanly.
   - **Ambiguity**: If change fits multiple types, classify by dominant change. If still ambiguous, inspect the ambiguous file via `git diff -- <file>`. Commit when a legitimate type is determinable. If truly unable, report back to the dispatching agent for guidance.
   - **Uncertainty**: If unresolvable, report back to dispatching agent.

7. **Enforce commit conventions** — All commits MUST use:
   - Match the language of representative commits
   - Same scope format (if ≥80% use `type(scope):`, you MUST include scope)
   - Imperative present tense
   - Subject line omits trailing period
   - Subject line ≤72 characters
   - **Internal references**: Describe code changes exclusively.

8. **Stage** — Select one coherent group, verify clean working tree, review the batch's full content with `git diff -- <files>` limited to the batch's files, then `git add <files>`.

9. **Commit** — Check off TODO item, verify staged diff non-empty (`git diff --cached --stat`), write semantic message, `git commit -m "<type>(<scope>): <message>"`. Use `git commit` with all hooks and verification enabled.

10. **Verify** — `git show --stat -1` to confirm.

11. **Repeat** — Return to step 5 for remaining groups.

12. **Error handling** — On failure, `git reset --mixed` to recover.

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

1. **Verify-output reporting discipline (issue #53)** — Before writing the CHECKPOINT KD, ground-truth verify every commit hash or artifact it reports: `git log`/`git show` for hashes (extends the step-10 `git show --stat -1` self-verification), `read`/`glob` from disk for files. Never write an unverified hash; a commit that could not be created is reported as "UNCOMMITTED" with the working-tree state. This reporting discipline complements — it does not replace — the per-commit self-verification steps.
2. **Write CHECKPOINT KD** — Write a CHECKPOINT KD at the `RESULT KD` path specified in the dispatch context using the `template-checkpoint.md` template from the kd-system skill. The KD documents what was committed and signals to the protocol-gate that the checkpoint is complete.
3. Report what was committed. Exit after all batches are committed.
