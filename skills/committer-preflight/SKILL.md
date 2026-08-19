---
name: committer-preflight
description: "Git workspace setup: status check, branch creation, dirty workspace resolution. Exit when workspace is ready."
---

# Committer Preflight

## Overview

PREFLIGHT mode sets up a clean git workspace for feature development. It handles repo initialization, branch creation, dirty workspace resolution, and .gitignore management. This mode handles workspace setup exclusively.

## When to Load

Load this skill when dispatched in PREFLIGHT mode by the Overseer (Phase 2 — git workspace setup).

## Protocol

1. **Prepare repository** — Check `.git/` existence.
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
       - If stash fails: log the error with details about what prevented the stash (files preventing stash, merge conflicts, etc.) and abort. Attempt pull after the working tree is stable.
     - **Pull flow**: Apply the same default-branch pull flow as the clean-repo remote-configured path (steps 1-5 above), including the detached HEAD check.
     - **Restore**: The stash is popped in step 4 after the working branch is established.

2. **Gitignore management** — Check if `.gitignore` exists. If not, create with project-appropriate patterns. If it exists, review and verify all standard gitignore patterns for the project's tech stack are included (e.g., `node_modules/`, `.env`, `*.log`, build output). Preserve all existing entries. Ensure `knowledge/` is listed in `.gitignore` so KDs are excluded from git tracking.

3. **Ignore file management** — Check if `.ignore` exists. If not, create it. Add `!knowledge/` to `.ignore` so that OpenCode (and other editors) can still scan KDs despite them being gitignored. Preserve all existing entries.

4. **Establish working branch** — Create a feature branch from the detected base branch. The Committer derives the feature branch name from the INTENT KD context using the Branch Naming Convention below. Branch establishment runs once per PREFLIGHT — CHECKPOINT and CLEANUP modes operate on the established branch.
   1. **Derive feature branch name** — Read the INTENT KD context to derive a feature branch name using the Branch Naming Convention table (task type → branch prefix). If INTENT KD is not available or context is insufficient, use `improve/<timestamp>` as fallback.
   2. **Detect base branch** — Run `git log --oneline -10` to find where the current HEAD branched off. The base branch is the branch point, not always `main`.
   3. **Create feature branch** — Run `git checkout -b <feature-branch> <base>`.
   4. **Restore stashed changes** — If step 1 stashed pending changes (dirty repo), run `git stash pop` after the working branch is established. If pop fails, log a warning but continue.

## Branch Naming Convention

Task-dependent branch prefix derived from the INTENT KD context:

| Task                | Branch prefix   |
| ------------------- | --------------- |
| Bugfix              | `fix/…`         |
| Version bump        | `chore/…`       |
| Feature             | `feature/…`     |
| Investigation       | `investigate/…` |
| General improvement | `improve/…`     |

## Exit

1. **Verify-output reporting discipline (issue #53)** — Ground-truth verify the workspace-state claims the PREFLIGHT KD reports (branch, clean/dirty, stash): `git branch --show-current`/`git status` from the repo, `read`/`glob` from disk for files — never from memory. This reporting discipline complements the verification steps above.
2. **Write PREFLIGHT KD** — Write a PREFLIGHT KD at the `RESULT KD` path specified in the dispatch context using the `template-preflight.md` template from the kd-system skill. The KD documents workspace setup results (branch, gitignore, etc.) and signals to the protocol-gate that PREFLIGHT is complete and can advance to EXPLORE.
3. Report branch name, clean/dirty state, and any stashed changes. Exit after workspace is ready.
