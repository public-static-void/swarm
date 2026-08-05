---
name: committer-preflight
description: "Git workspace setup: status check, branch creation, dirty workspace resolution. Exit when workspace is ready."
---

# Committer Preflight

## Overview

PREFLIGHT mode sets up a clean git workspace for feature development. It handles repo initialization, branch creation, dirty workspace resolution, and .gitignore management. This mode handles workspace setup exclusively.

## When to Load

Load this skill when dispatched in PREFLIGHT mode by the Overseer (Phase 2 — git workspace setup). The dispatch context contains the working branch name in the `BRANCH` field.

## Protocol

1. **Accept branch name (blocking)** — Read the `BRANCH` field from the dispatch. The branch name is required: a dispatch without `BRANCH` is a blocking error, never a silent default. If `BRANCH` is absent, load the escalation-protocol skill and escalate via ESCALATION format reporting the missing delegation field. Check `.git/` existence.
   - **When `.git/` is absent**: `git init`, then proceed to step 4 to establish the working branch. Skip pull — remote is absent at this stage.
   - **Clean repo**: Run `git remote -v` to check remote configuration.
     - **When remote is absent**: Log a warning that no remote is available. Skip fetch and pull. Proceed to step 4 from current local state.
     - **Remote configured**: Proceed with the default-branch pull flow:
       1. `git fetch origin` — update all remote tracking refs
       2. Detect default branch: try `main`, fall back to `master`, then `git branch --show-current`. Log a warning if fallback used.
       3. **Detached HEAD check**: Check HEAD status with `git branch --show-current`. If detached, log a warning, skip `git checkout <default-branch>`. Proceed with `git pull --ff-only`.
       4. `git checkout <default-branch>` — switch to the default branch (skip if detached)
       5. `git pull --ff-only` — fast-forward to latest remote state
       6. On pull failure: report the failure reason, proceed to step 4 from the current state.
   - **Dirty repo**:
     - **Stash**: Run `git stash push` to save pending changes.
       - If stash fails: log the error with details about what prevented the stash (files preventing stash, merge conflicts, etc.) and abort. Attempt pull only after the working tree is stable.
     - **Pull flow**: Apply the same default-branch pull flow as the clean-repo remote-configured path (steps 1-5 above), including the detached HEAD check.
     - **Restore**: The stash is popped in step 4 after the working branch is established.

2. **Gitignore management** — Check if `.gitignore` exists. If not, create with project-appropriate patterns. If it exists, review and verify all standard gitignore patterns for the project's tech stack are included (e.g., `node_modules/`, `.env`, `*.log`, build output). Preserve all existing entries. Ensure `knowledge/` is listed in `.gitignore` so KDs are excluded from git tracking.

3. **Ignore file management** — Check if `.ignore` exists. If not, create it. Add `!knowledge/` to `.ignore` so that OpenCode (and other editors) can still scan KDs despite them being gitignored. Preserve all existing entries.

4. **Establish working branch** — Every task runs on its own branch named from the dispatch `BRANCH`; the shared integration branches `develop`, `main`, `master`, and `staging` are NEVER reused for work. Branch establishment runs once per PREFLIGHT — CHECKPOINT and CLEANUP modes never create branches.
   1. **With dispatch `BRANCH`**:
      - If the branch exists locally: `git checkout <branch>` (skip if already on it).
      - If the branch exists only remotely: track it — `git checkout -b <branch> --track origin/<branch>`.
      - Otherwise: `git checkout -b <branch>` from the pulled default-branch state (step 1).
   2. **Without dispatch `BRANCH` (legacy dispatch — should not occur after the delegation-gate requires it)**: run `git branch --show-current`:
      - If the current branch is `develop`/`main`/`master`/`staging`: it is a shared integration branch and is never reused — create a new branch per the Branch Naming Convention below, derived from the dispatch SCOPE.
      - If the current branch is already a task branch matching the naming convention: use it.
      - If the current branch is unclassifiable: load the escalation-protocol skill and escalate via ESCALATION format instead of reusing it.
   3. **Verify final branch**: when dispatch `BRANCH` was provided, run `git branch --show-current` and confirm it equals the dispatch `BRANCH`. On mismatch, load the escalation-protocol skill and escalate.
   4. **Restore stashed changes** — If step 1 stashed pending changes (dirty repo), run `git stash pop` after the working branch is established. If pop fails, log a warning but continue.

## Branch Naming Convention

Task-dependent branch prefix derived from the dispatch SCOPE (used when no `BRANCH` is provided):

| Task | Branch prefix |
| ---- | ------------- |
| Bugfix | `fix/…` |
| Version bump | `chore/…` |
| Feature | `feature/…` |
| Investigation | `investigate/…` |
| General improvement | `improve/…` |

## Exit

1. **Write PREFLIGHT KD** — Write a PREFLIGHT KD at the `RESULT KD` path specified in the dispatch context using the `template-preflight.md` template from the kd-system skill. The KD documents workspace setup results (branch, gitignore, etc.) and signals to the protocol-gate that PREFLIGHT is complete and can advance to EXPLORE.
2. Report branch name, clean/dirty state, and any stashed changes. Exit after workspace is ready.
